import { boundaryError, type BoundaryErrorCode } from "../../contracts/common-outcomes.js";
import type {
  CorrelationId,
  RootIssueId,
  RuntimeGeneration,
  ThreadId,
} from "../../contracts/identity.js";
import type { RuntimeTarget } from "../../contracts/runtime.js";
import {
  MAX_ROOT_TOOL_RESPONSE_BYTES,
  RootToolCallError,
  RootToolFatalError,
  type RootToolBinding,
  type RootToolExecution,
} from "../../runtime/RootToolBoundary.js";
import type { CodexInboundMessage, CodexRequestId } from "./CodexProtocol.js";

const FAILURE_REASONS = Object.freeze({
  invalid_contract: "tool call did not match the declared contract",
  stale_generation: "tool call targeted an inactive runtime generation",
  capability_denied: "requested capability is not declared",
  timed_out: "tool call exceeded its bounded execution time",
  canceled: "tool call no longer belongs to the active turn",
  boundary_unavailable: "tool boundary is unavailable",
  acceptance_unknown: "tool effect acceptance is unknown",
  readback_mismatch: "fresh read-back did not match the requested effect",
} as const satisfies Record<BoundaryErrorCode, string>);

const HARD_TOOL_DENIALS = new Set<BoundaryErrorCode>([
  "invalid_contract", "stale_generation", "capability_denied", "timed_out", "boundary_unavailable",
]);

export function isHardToolDenial(reasonCode: BoundaryErrorCode): boolean {
  return HARD_TOOL_DENIALS.has(reasonCode);
}

interface ToolProcess {
  onNotification(listener: (message: CodexInboundMessage) => void): () => void;
  respondToTool(requestId: CodexRequestId, success: boolean, text: string): Promise<void>;
}

interface RootToolLogIdentity {
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly thread_id: ThreadId;
  readonly turn_id: string;
  readonly tool: string;
  readonly call_sequence: number;
}

export type RootToolBridgeLog =
  | (RootToolLogIdentity & { readonly event: "root_tool_call_accepted" })
  | (RootToolLogIdentity & {
      readonly event: "root_tool_call_denied";
      readonly reason_code: BoundaryErrorCode;
    })
  | (RootToolLogIdentity & {
      readonly event: "root_tool_call_failed";
      readonly reason_code: "boundary_unavailable" | "invalid_contract";
    });

export interface DynamicToolBridgeOptions {
  readonly thread_id: ThreadId;
  readonly turn_id: string;
  readonly target: RuntimeTarget;
  readonly correlation_id: CorrelationId;
  readonly max_calls: number;
  readonly bindings: readonly RootToolBinding[];
  readonly log: (entry: RootToolBridgeLog) => void;
  readonly on_fatal: (reasonCode: "boundary_unavailable" | "invalid_contract") => void;
  readonly on_budget_exhausted?: () => void;
  readonly on_denied?: (reasonCode: BoundaryErrorCode) => void;
}

export interface DynamicToolBridgeControl {
  (): void;
  seal(): void;
  didBudgetOverlapEffect(): boolean;
  didTerminalOverlapEffect(): boolean;
  hasEffectInFlight(): boolean;
  hasInFlight(): boolean;
  waitForIdle(): Promise<void>;
}

function response(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error("codex_tool_response_invalid");
  }
  if (text === undefined || Buffer.byteLength(text, "utf8") > MAX_ROOT_TOOL_RESPONSE_BYTES) {
    throw new Error("codex_tool_response_invalid");
  }
  return text;
}

function failureResponse(options: DynamicToolBridgeOptions, code: BoundaryErrorCode): string {
  return response(boundaryError({
    schema_version: 1,
    code,
    root_id: options.target.root_id,
    runtime_generation: options.target.runtime_generation,
    correlation_id: options.correlation_id,
    reason: FAILURE_REASONS[code],
  }));
}

export function bindDynamicTools(
  process: ToolProcess,
  options: DynamicToolBridgeOptions,
): DynamicToolBridgeControl {
  if (!Number.isSafeInteger(options.max_calls) || options.max_calls < 1 || options.max_calls > 100) {
    throw new Error("invalid_root_tool_call_budget");
  }
  const byName = new Map(options.bindings.map((binding) => [binding.spec.name, binding]));
  if (byName.size !== options.bindings.length) throw new Error("duplicate_dynamic_tool");
  const seenCalls = new Map<string, CodexRequestId>();
  const seenRequests = new Set<CodexRequestId>();
  const seenStaleRequests = new Set<CodexRequestId>();
  let active = true;
  let accepting = true;
  let inFlight = false;
  let effectInFlight = false;
  let pendingCount = 0;
  let resolveIdle: (() => void) | null = null;
  let idle = Promise.resolve();
  let budgetExhausted = false;
  let budgetOverlappedEffect = false;
  let terminalOverlappedEffect = false;
  let callSequence = 0;
  let currentCallCount = 0;
  let staleCallCount = 0;
  let unsubscribe: () => void = () => undefined;

  const seal = (): void => {
    accepting = false;
  };
  const beginPending = (): void => {
    if (pendingCount === 0) {
      idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
    }
    pendingCount += 1;
  };
  const endPending = (): void => {
    pendingCount -= 1;
    if (pendingCount !== 0) return;
    resolveIdle?.();
    resolveIdle = null;
  };
  const close = (): void => {
    if (!active) return;
    active = false;
    seal();
    unsubscribe();
    seenCalls.clear();
    seenRequests.clear();
    seenStaleRequests.clear();
  };
  const execution: RootToolExecution = Object.freeze({
    assertActive: () => {
      if (!active) throw new RootToolCallError("canceled");
    },
  });
  const identity = (tool: string, sequence: number): RootToolLogIdentity => Object.freeze({
    root_id: options.target.root_id,
    runtime_generation: options.target.runtime_generation,
    correlation_id: options.correlation_id,
    thread_id: options.thread_id,
    turn_id: options.turn_id,
    tool,
    call_sequence: sequence,
  });
  const log = (entry: RootToolBridgeLog): void => {
    try { options.log(entry); } catch { /* log observers cannot alter tool execution */ }
  };
  const fatal = (
    tool: string,
    sequence: number,
    reasonCode: "boundary_unavailable" | "invalid_contract",
  ): void => {
    if (!active) return;
    log(Object.freeze({
      event: "root_tool_call_failed",
      ...identity(tool, sequence),
      reason_code: reasonCode,
    }));
    close();
    options.on_fatal(reasonCode);
  };
  const deny = async (
    message: Extract<CodexInboundMessage, { kind: "tool_call" }>,
    tool: string,
    sequence: number,
    reasonCode: BoundaryErrorCode,
    notifyOwner = true,
  ): Promise<boolean> => {
    if (!active) return false;
    if (isHardToolDenial(reasonCode)) seal();
    log(Object.freeze({
      event: "root_tool_call_denied",
      ...identity(tool, sequence),
      reason_code: reasonCode,
    }));
    if (
      notifyOwner
      && message.turn_id === options.turn_id
      && reasonCode !== "canceled"
    ) options.on_denied?.(reasonCode);
    try {
      await process.respondToTool(message.request_id, false, failureResponse(options, reasonCode));
    } catch {
      fatal(tool, sequence, "boundary_unavailable");
      return false;
    }
    if (!active) return false;
    return true;
  };
  const scheduleDeny = (
    message: Extract<CodexInboundMessage, { kind: "tool_call" }>,
    tool: string,
    sequence: number,
    reasonCode: BoundaryErrorCode,
  ): void => {
    if (isHardToolDenial(reasonCode)) seal();
    queueMicrotask(() => { void deny(message, tool, sequence, reasonCode); });
  };
  const dispatch = async (
    message: Extract<CodexInboundMessage, { kind: "tool_call" }>,
    binding: RootToolBinding,
    sequence: number,
  ): Promise<void> => {
    try {
      if (!accepting) {
        effectInFlight = false;
        return;
      }
      execution.assertActive();
      const value = await Promise.resolve().then(() => binding.execute(message.arguments, execution));
      execution.assertActive();
      const text = response(value);
      await process.respondToTool(message.request_id, true, text);
      effectInFlight = false;
      log(Object.freeze({
        event: "root_tool_call_accepted",
        ...identity(binding.spec.name, sequence),
      }));
    } catch (error) {
      if (!active) {
        log(Object.freeze({
          event: "root_tool_call_denied",
          ...identity(binding.spec.name, sequence),
          reason_code: "canceled",
        }));
      } else if (error instanceof RootToolCallError) {
        await deny(message, binding.spec.name, sequence, error.code);
      } else {
        fatal(
          binding.spec.name,
          sequence,
          error instanceof RootToolFatalError
            ? error.code
            : error instanceof Error && error.message === "codex_tool_response_invalid"
              ? "invalid_contract"
              : "boundary_unavailable",
        );
      }
    } finally {
      effectInFlight = false;
      inFlight = false;
      endPending();
    }
  };

  unsubscribe = process.onNotification((message) => {
    if (!active) return;
    if (message.kind === "turn_completed") {
      if (message.thread_id === options.thread_id && message.turn_id === options.turn_id) {
        terminalOverlappedEffect ||= effectInFlight;
        seal();
      }
      return;
    }
    if (!accepting || message.kind !== "tool_call" || message.thread_id !== options.thread_id) return;
    if (budgetExhausted) return;
    const binding = byName.get(message.tool);
    const tool = binding?.spec.name ?? "unknown";
    const sequence = ++callSequence;
    if (message.turn_id !== options.turn_id) {
      if (seenStaleRequests.has(message.request_id)) return;
      if (staleCallCount >= options.max_calls) {
        fatal(tool, sequence, "invalid_contract");
        return;
      }
      staleCallCount += 1;
      seenStaleRequests.add(message.request_id);
      scheduleDeny(message, tool, sequence, "canceled");
      return;
    }
    const previousRequest = seenCalls.get(message.call_id);
    if (previousRequest !== undefined) {
      if (previousRequest !== message.request_id) {
        if (seenRequests.has(message.request_id)) return;
        seenRequests.add(message.request_id);
        scheduleDeny(message, tool, sequence, "invalid_contract");
      }
      return;
    }
    if (seenRequests.has(message.request_id)) return;
    seenCalls.set(message.call_id, message.request_id);
    seenRequests.add(message.request_id);
    currentCallCount += 1;
    if (currentCallCount > options.max_calls) {
      budgetOverlappedEffect ||= effectInFlight;
      budgetExhausted = true;
      seal();
      beginPending();
      void deny(message, tool, sequence, "invalid_contract", false).finally(endPending);
      options.on_budget_exhausted?.();
      return;
    }
    if (binding === undefined) {
      scheduleDeny(message, tool, sequence, "capability_denied");
      return;
    }
    if (inFlight) {
      scheduleDeny(message, tool, sequence, "invalid_contract");
      return;
    }
    inFlight = true;
    effectInFlight = true;
    beginPending();
    queueMicrotask(() => { void dispatch(message, binding, sequence); });
  });

  return Object.assign(close, {
    seal,
    didBudgetOverlapEffect: () => budgetOverlappedEffect,
    didTerminalOverlapEffect: () => terminalOverlappedEffect,
    hasEffectInFlight: () => effectInFlight,
    hasInFlight: () => pendingCount > 0,
    waitForIdle: () => idle,
  });
}
