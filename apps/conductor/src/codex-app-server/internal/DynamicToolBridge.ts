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
import type { CodexInboundMessage } from "./CodexProtocol.js";

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

interface ToolProcess {
  onNotification(listener: (message: CodexInboundMessage) => void): () => void;
  respondToTool(requestId: string, success: boolean, text: string): Promise<void>;
}

interface RootToolLogIdentity {
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly thread_id: ThreadId;
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
): () => void {
  if (!Number.isSafeInteger(options.max_calls) || options.max_calls < 1 || options.max_calls > 100) {
    throw new Error("invalid_root_tool_call_budget");
  }
  const byName = new Map(options.bindings.map((binding) => [binding.spec.name, binding]));
  if (byName.size !== options.bindings.length) throw new Error("duplicate_dynamic_tool");
  const seenCalls = new Map<string, string>();
  const seenRequests = new Set<string>();
  let active = true;
  let inFlight = false;
  let callSequence = 0;
  let currentCallCount = 0;
  let unsubscribe: () => void = () => undefined;

  const close = (): void => {
    if (!active) return;
    active = false;
    inFlight = false;
    unsubscribe();
    seenCalls.clear();
    seenRequests.clear();
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
    tool,
    call_sequence: sequence,
  });
  const fatal = (
    tool: string,
    sequence: number,
    reasonCode: "boundary_unavailable" | "invalid_contract",
  ): void => {
    if (!active) return;
    options.log(Object.freeze({
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
  ): Promise<void> => {
    if (!active) return;
    try {
      await process.respondToTool(message.request_id, false, failureResponse(options, reasonCode));
    } catch {
      fatal(tool, sequence, "boundary_unavailable");
      return;
    }
    if (!active) return;
    options.log(Object.freeze({
      event: "root_tool_call_denied",
      ...identity(tool, sequence),
      reason_code: reasonCode,
    }));
  };
  const dispatch = async (
    message: Extract<CodexInboundMessage, { kind: "tool_call" }>,
    binding: RootToolBinding,
    sequence: number,
  ): Promise<void> => {
    try {
      const value = await Promise.resolve().then(() => binding.execute(message.arguments, execution));
      execution.assertActive();
      const text = response(value);
      await process.respondToTool(message.request_id, true, text);
      options.log(Object.freeze({
        event: "root_tool_call_accepted",
        ...identity(binding.spec.name, sequence),
      }));
    } catch (error) {
      if (!active) {
        options.log(Object.freeze({
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
      if (active) inFlight = false;
    }
  };

  unsubscribe = process.onNotification((message) => {
    if (!active || message.kind !== "tool_call" || message.thread_id !== options.thread_id) return;
    const binding = byName.get(message.tool);
    const tool = binding?.spec.name ?? "unknown";
    const sequence = ++callSequence;
    const previousRequest = seenCalls.get(message.call_id);
    if (previousRequest !== undefined) {
      if (previousRequest !== message.request_id) {
        if (seenRequests.has(message.request_id)) return;
        seenRequests.add(message.request_id);
        queueMicrotask(() => { void deny(message, tool, sequence, "invalid_contract"); });
      }
      return;
    }
    if (seenRequests.has(message.request_id)) return;
    seenCalls.set(message.call_id, message.request_id);
    seenRequests.add(message.request_id);
    if (message.turn_id !== options.turn_id) {
      queueMicrotask(() => { void deny(message, tool, sequence, "canceled"); });
      return;
    }
    currentCallCount += 1;
    if (currentCallCount > options.max_calls) {
      queueMicrotask(() => { void deny(message, tool, sequence, "invalid_contract"); });
      return;
    }
    if (binding === undefined) {
      queueMicrotask(() => { void deny(message, tool, sequence, "capability_denied"); });
      return;
    }
    if (inFlight) {
      queueMicrotask(() => { void deny(message, tool, sequence, "invalid_contract"); });
      return;
    }
    inFlight = true;
    queueMicrotask(() => { void dispatch(message, binding, sequence); });
  });

  return close;
}
