import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  CodexProcess,
  createCodexProcessLocalOnlyMode,
  type CodexProcessOptions,
  type CodexSpawner,
} from "../../codex-app-server/internal/CodexProcess.js";
import { snapshotCodexRootLocalOnlyTools } from "../../codex-app-server/internal/CodexLocalOnly.js";
import { CodexThread } from "../../codex-app-server/internal/CodexThread.js";
import {
  bindDynamicTools,
  isHardToolDenial,
  type DynamicToolBridgeControl,
  type RootToolBridgeLog,
} from "../../codex-app-server/internal/DynamicToolBridge.js";
import {
  bindRootCodeInspection,
  RootCodeInspection,
} from "../../codex-app-server/internal/RootCodeInspection.js";
import {
  parseCorrelationId,
  parseObservationDigest,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseThreadId,
  type CorrelationId,
  type ObservationDigest,
  type RootIssueId,
  type RuntimeGeneration,
  type ThreadId,
} from "../../contracts/identity.js";
import {
  parseRootBootstrap,
  parseRootFactDiff,
  type RootBootstrap,
  type RootFactDiff,
} from "../../contracts/observation.js";
import {
  parseRootTurnOutcome,
  type RootTurnOutcome,
  type RuntimeTarget,
} from "../../contracts/runtime.js";
import { asRecord, assertExactKeys, parseBoundedString } from "../../contracts/validation.js";
import { rootObservationDigest } from "../../observation/RootObservationFacts.js";
import type {
  RootToolBinding,
  RootToolExecution,
  RootToolSpec,
} from "../../runtime/RootToolBoundary.js";
import { bindRootTools, isRootTools, type RootTools } from "../../runtime/RootTools.js";
import type {
  RootReconcillFactoryInput,
  RootReconcillFactoryInterface,
  RootReconcillInput,
  RootReconcillInterface,
} from "../api/RootReconcillInterface.js";
import { RootContinuityStore } from "./RootContinuityStore.js";
import { rootReconcillOutputSchema, rootReconcillPrompt } from "./RootPrompt.js";

export { rootReconcillOutputSchema } from "./RootPrompt.js";

function homeKey(rootHome: string): string {
  const normalized = path.normalize(rootHome).replace(/[\\/]+$/u, "");
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

async function canonicalRootHome(value: unknown): Promise<string> {
  const rootHome = parseBoundedString(value, "invalid_root_home", 4_096);
  if (!path.isAbsolute(rootHome)) throw new Error("invalid_root_home");
  try {
    const [actual, stat] = await Promise.all([realpath(rootHome), lstat(rootHome)]);
    if (!stat.isDirectory()) throw new Error("invalid_root_home");
    return path.normalize(actual);
  } catch {
    throw new Error("invalid_root_home");
  }
}

async function canonicalRootWorkspace(value: unknown): Promise<string> {
  const workspaceRoot = parseBoundedString(value, "invalid_root_workspace", 4_096);
  if (!path.isAbsolute(workspaceRoot)) throw new Error("invalid_root_workspace");
  try {
    const actual = path.normalize(await realpath(workspaceRoot));
    if (!(await lstat(actual)).isDirectory()) throw new Error("invalid_root_workspace");
    return actual;
  } catch {
    throw new Error("invalid_root_workspace");
  }
}

async function resolveRootWorkspace(
  resolveWorkspaceRoot: (rootId: RootIssueId) => Promise<string>,
  rootId: RootIssueId,
  timeoutMs: number,
): Promise<string> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      resolveWorkspaceRoot(rootId).then(canonicalRootWorkspace),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("invalid_root_workspace")), timeoutMs);
      }),
    ]);
  } catch {
    throw new Error("invalid_root_workspace");
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export interface RootReconcillToolSet {
  readonly target: RuntimeTarget;
  readonly specs: readonly RootToolSpec[];
  hasPendingAcceptance(): boolean;
  bindings(correlationId: CorrelationId): readonly RootToolBinding[];
}

export interface RootReconcillToolSetFactory {
  create(target: RuntimeTarget): RootReconcillToolSet;
}

function parseToolSetTarget(value: unknown): RuntimeTarget {
  const record = asRecord(value);
  assertExactKeys(record, ["root_id", "runtime_generation"]);
  return Object.freeze({
    root_id: parseRootIssueId(record.root_id),
    runtime_generation: parseRuntimeGeneration(record.runtime_generation),
  });
}

export interface RootTurnRequest {
  readonly input: string;
  readonly correlation_id: CorrelationId;
  readonly output_schema: Record<string, unknown>;
  readonly max_tool_calls: number;
  readonly timeout_ms: number;
}

export type RootTurnTransportResult =
  | { readonly turn_id: string; readonly status: "completed"; readonly output: unknown }
  | { readonly turn_id: string; readonly status: "interrupted" | "failed" | "budget_exhausted" };

type RootControlOutcome = RootTurnOutcome & {
  readonly outcome: "timed_out" | "canceled";
  readonly sanitized_reason: string;
};

export interface RootTurnTransport {
  readonly threadId: ThreadId;
  turn(request: RootTurnRequest): Promise<RootTurnTransportResult>;
  close(): Promise<void>;
}

export interface RootTurnTransportFactoryInput extends RootReconcillFactoryInput {
  readonly tools: RootReconcillToolSet;
}

export interface RootTurnTransportFactory {
  create(input: RootTurnTransportFactoryInput): Promise<RootTurnTransport>;
}

interface RootReconcillLogIdentity {
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly thread_id: ThreadId;
  readonly input_kind: "bootstrap" | "diff";
}

export type RootReconcillLog =
  | (RootReconcillLogIdentity & { readonly event: "root_reconcill_turn_started" })
  | (RootReconcillLogIdentity & {
    readonly event: "root_reconcill_turn_completed";
    readonly outcome: RootTurnOutcome["outcome"];
  })
  | (RootReconcillLogIdentity & {
    readonly event: "root_reconcill_turn_failed";
    readonly reason_code: "boundary_unavailable" | "continuity_unavailable" | "invalid_contract";
  });

export interface RootReconcillOptions {
  readonly max_tool_calls: number;
  readonly turn_timeout_ms: number;
  readonly log: (entry: RootReconcillLog) => void;
}

function parseModelTurnOutcome(value: unknown, target: RuntimeTarget): RootTurnOutcome {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "runtime_generation",
    "correlation_id",
    "outcome",
    "sanitized_reason",
  ]);
  if (record.outcome === "quiescent") {
    if (record.sanitized_reason !== null) throw new Error("invalid_model_outcome");
    return parseRootTurnOutcome({
      schema_version: record.schema_version,
      root_id: record.root_id,
      runtime_generation: record.runtime_generation,
      correlation_id: record.correlation_id,
      outcome: record.outcome,
    }, target);
  }
  if (record.outcome !== "stopped" || record.sanitized_reason === null) {
    throw new Error("invalid_model_outcome");
  }
  return parseRootTurnOutcome(record, target);
}

function controlOutcome(
  target: RuntimeTarget,
  correlationId: CorrelationId,
  outcome: "timed_out" | "canceled",
  reason: string,
): RootControlOutcome {
  return Object.freeze({
    schema_version: 1,
    ...target,
    correlation_id: correlationId,
    outcome,
    sanitized_reason: reason,
  });
}

function acceptedDigest(input: RootBootstrap | RootFactDiff): ObservationDigest {
  return "task" in input
    ? rootObservationDigest(input.task, input.git)
    : parseObservationDigest(input.to_observation_digest);
}

class BoundRootReconcill implements RootReconcillInterface {
  readonly rootId: RootIssueId;
  readonly runtimeGeneration: RuntimeGeneration;
  readonly #target: RuntimeTarget;
  readonly #transport: RootTurnTransport;
  readonly #tools: RootReconcillToolSet;
  readonly #continuity: RootContinuityStore;
  readonly #options: RootReconcillOptions;
  readonly #onClosed: () => void;
  #acceptedDigest: ObservationDigest | null = null;
  #closed = false;
  #terminal = false;
  #running = false;
  #activeRun: Promise<RootTurnOutcome> | null = null;
  #closing: Promise<void> | null = null;

  constructor(
    input: RootReconcillFactoryInput,
    transport: RootTurnTransport,
    tools: RootReconcillToolSet,
    continuity: RootContinuityStore,
    options: RootReconcillOptions,
    onClosed: () => void,
  ) {
    this.rootId = input.root_id;
    this.runtimeGeneration = input.runtime_generation;
    this.#target = Object.freeze({ root_id: this.rootId, runtime_generation: this.runtimeGeneration });
    this.#transport = transport;
    this.#tools = tools;
    this.#continuity = continuity;
    this.#options = options;
    this.#onClosed = onClosed;
  }

  run(input: RootReconcillInput): Promise<RootTurnOutcome> {
    if (this.#closed) return Promise.reject(new Error("root_reconcill_closed"));
    if (this.#terminal) return Promise.reject(new Error("root_reconcill_terminal"));
    if (this.#running) return Promise.reject(new Error("root_reconcill_busy"));
    this.#running = true;
    const activeRun = this.#run(input).finally(() => {
      this.#running = false;
      if (this.#activeRun === activeRun) this.#activeRun = null;
    });
    this.#activeRun = activeRun;
    return activeRun;
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#terminal = true;
    const activeRun = this.#activeRun;
    const transportClose = this.#transport.close().then(
      () => false,
      () => true,
    );
    this.#closing = (async () => {
      await activeRun?.catch(() => undefined);
      if (await transportClose) throw new Error("root_reconcill_close_failed");
    })();
    void this.#closing.then(() => {
      try { this.#onClosed(); } catch { /* a release observer cannot reopen a closed runtime */ }
    }, () => undefined);
    return this.#closing;
  }

  async #run(rawInput: RootReconcillInput): Promise<RootTurnOutcome> {
    const inputKind = typeof rawInput === "object" && rawInput !== null && "task" in rawInput
      ? "bootstrap" as const
      : "diff" as const;
    let input: RootBootstrap | RootFactDiff;
    try {
      input = inputKind === "bootstrap"
        ? parseRootBootstrap(rawInput, this.#target)
        : parseRootFactDiff(rawInput, this.#target);
    } catch {
      this.#terminal = true;
      throw new Error("root_reconcill_invalid_input");
    }
    const nextDigest = acceptedDigest(input);
    if (inputKind === "bootstrap") {
      if (this.#acceptedDigest !== null) throw new Error("root_already_bootstrapped");
      await this.#writeContinuity(
        nextDigest,
        input.correlation_id,
        input.correlation_id,
        inputKind,
      );
    } else {
      if (this.#acceptedDigest === null) throw new Error("root_bootstrap_required");
      if (!("from_observation_digest" in input)) throw new Error("root_reconcill_invalid_input");
      if (input.from_observation_digest !== this.#acceptedDigest) throw new Error("observation_discontinuity");
      await this.#writeContinuity(
        this.#acceptedDigest,
        input.correlation_id,
        input.correlation_id,
        inputKind,
      );
    }

    const identity = this.#logIdentity(input, inputKind);
    this.#log(Object.freeze({ event: "root_reconcill_turn_started", ...identity }));
    let result: RootTurnTransportResult;
    try {
      result = await this.#transport.turn(Object.freeze({
        input: rootReconcillPrompt(input, inputKind),
        correlation_id: input.correlation_id,
        output_schema: rootReconcillOutputSchema(this.#target, input.correlation_id),
        max_tool_calls: this.#options.max_tool_calls,
        timeout_ms: this.#options.turn_timeout_ms,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "codex_turn_timed_out") {
        const outcome = controlOutcome(
          this.#target,
          input.correlation_id,
          "timed_out",
          "Root reasoning turn exceeded its time budget",
        );
        await this.#finishControlOutcome(outcome, identity);
        return outcome;
      }
      if (this.#closed || (error instanceof Error && error.message === "codex_thread_closed")) {
        const outcome = controlOutcome(
          this.#target,
          input.correlation_id,
          "canceled",
          "Root reasoning turn was canceled",
        );
        await this.#finishControlOutcome(outcome, identity);
        return outcome;
      }
      this.#terminal = true;
      this.#log(Object.freeze({
        event: "root_reconcill_turn_failed",
        ...identity,
        reason_code: "boundary_unavailable",
      }));
      throw new Error("root_reconcill_boundary_failed");
    }

    if (result.status === "interrupted") {
      const outcome = controlOutcome(
        this.#target,
        input.correlation_id,
        "canceled",
        "Root reasoning turn was canceled",
      );
      await this.#finishControlOutcome(outcome, identity);
      return outcome;
    }

    let outcome: RootTurnOutcome;
    if (result.status === "budget_exhausted") {
      outcome = Object.freeze({
        schema_version: 1,
        ...this.#target,
        correlation_id: input.correlation_id,
        outcome: "stopped",
        sanitized_reason: "Root tool-call budget was exhausted",
      });
    } else if (result.status === "failed") {
      this.#terminal = true;
      this.#log(Object.freeze({
        event: "root_reconcill_turn_failed",
        ...identity,
        reason_code: "boundary_unavailable",
      }));
      throw new Error("root_reconcill_boundary_failed");
    } else if ("output" in result) {
      try {
        outcome = parseModelTurnOutcome(result.output, this.#target);
        if (outcome.outcome !== "quiescent" && outcome.outcome !== "stopped") throw new Error("invalid_model_outcome");
        if (outcome.correlation_id !== input.correlation_id) throw new Error("turn_correlation_mismatch");
      } catch {
        this.#terminal = true;
        this.#log(Object.freeze({
          event: "root_reconcill_turn_failed",
          ...identity,
          reason_code: "invalid_contract",
        }));
        throw new Error("root_reconcill_boundary_failed");
      }
    } else {
      throw new Error("root_reconcill_boundary_failed");
    }
    if (outcome.outcome === "quiescent" && this.#tools.hasPendingAcceptance()) {
      outcome = Object.freeze({
        schema_version: 1,
        ...this.#target,
        correlation_id: input.correlation_id,
        outcome: "stopped",
        sanitized_reason: "Root tool effect acceptance remains unresolved",
      });
    }

    await this.#writeContinuity(nextDigest, null, input.correlation_id, inputKind);
    this.#acceptedDigest = nextDigest;
    if (outcome.outcome === "stopped") this.#terminal = true;
    this.#log(Object.freeze({
      event: "root_reconcill_turn_completed",
      ...identity,
      outcome: outcome.outcome,
    }));
    return outcome;
  }

  async #finishControlOutcome(
    outcome: RootControlOutcome,
    identity: RootReconcillLogIdentity,
  ): Promise<void> {
    this.#terminal = true;
    this.#log(Object.freeze({
      event: "root_reconcill_turn_completed",
      ...identity,
      outcome: outcome.outcome,
    }));
  }

  async #writeContinuity(
    digest: ObservationDigest,
    inFlightCorrelation: CorrelationId | null,
    logCorrelation: CorrelationId,
    inputKind: "bootstrap" | "diff",
  ): Promise<void> {
    try {
      await this.#continuity.write({
        schema_version: 1,
        root_id: this.rootId,
        runtime_generation: this.runtimeGeneration,
        thread_id: this.#transport.threadId,
        accepted_observation_digest: digest,
        in_flight_correlation: inFlightCorrelation,
      });
    } catch {
      this.#terminal = true;
      this.#log(Object.freeze({
        event: "root_reconcill_turn_failed",
        root_id: this.rootId,
        runtime_generation: this.runtimeGeneration,
        correlation_id: logCorrelation,
        thread_id: this.#transport.threadId,
        input_kind: inputKind,
        reason_code: "continuity_unavailable",
      }));
      throw new Error("root_continuity_unavailable");
    }
  }

  #log(entry: RootReconcillLog): void {
    try { this.#options.log(entry); } catch { /* log observers cannot alter runtime continuity */ }
  }

  #logIdentity(
    input: RootBootstrap | RootFactDiff,
    inputKind: "bootstrap" | "diff",
  ): RootReconcillLogIdentity {
    return Object.freeze({
      root_id: this.rootId,
      runtime_generation: this.runtimeGeneration,
      correlation_id: input.correlation_id,
      thread_id: this.#transport.threadId,
      input_kind: inputKind,
    });
  }
}

export class RootReconcillFactory implements RootReconcillFactoryInterface {
  readonly #activeHomes = new Map<string, object>();
  readonly #transports = new WeakSet<object>();
  readonly #toolSets = new WeakSet<object>();
  readonly #options: RootReconcillOptions;

  constructor(
    private readonly transports: RootTurnTransportFactory,
    private readonly tools: RootReconcillToolSetFactory,
    options: RootReconcillOptions,
  ) {
    if (!Number.isSafeInteger(options.max_tool_calls) || options.max_tool_calls < 1 || options.max_tool_calls > 100) {
      throw new Error("invalid_root_tool_call_budget");
    }
    if (!Number.isSafeInteger(options.turn_timeout_ms) || options.turn_timeout_ms < 1 || options.turn_timeout_ms > 600_000) {
      throw new Error("invalid_root_turn_timeout");
    }
    this.#options = Object.freeze({ ...options });
  }

  async create(rawInput: RootReconcillFactoryInput): Promise<RootReconcillInterface> {
    const rootHome = await canonicalRootHome(rawInput.root_home);
    const input = Object.freeze({
      root_id: parseRootIssueId(rawInput.root_id),
      runtime_generation: parseRuntimeGeneration(rawInput.runtime_generation),
      root_home: rootHome,
    });
    const key = homeKey(rootHome);
    if (this.#activeHomes.has(key)) throw new Error("root_reconcill_resource_alias");
    const reservation = {};
    this.#activeHomes.set(key, reservation);
    try {
      const continuity = new RootContinuityStore(input.root_home);
      let previous: Awaited<ReturnType<RootContinuityStore["loadOptional"]>>;
      try {
        await continuity.assertReady();
        previous = await continuity.loadOptional();
      } catch {
        throw new Error("root_continuity_invalid");
      }
      if (previous === null) {
        if (input.runtime_generation !== 1) throw new Error("invalid_initial_generation");
      } else {
        if (previous.root_id !== input.root_id) throw new Error("root_home_owner_mismatch");
        if (input.runtime_generation !== previous.runtime_generation + 1) {
          throw new Error("invalid_restart_generation");
        }
      }

      const target = Object.freeze({
        root_id: input.root_id,
        runtime_generation: input.runtime_generation,
      });
      let toolSet: RootReconcillToolSet;
      try { toolSet = this.tools.create(target); } catch { throw new Error("root_tools_creation_failed"); }
      if (typeof toolSet !== "object" || toolSet === null || this.#toolSets.has(toolSet)) {
        throw new Error("root_reconcill_resource_alias");
      }
      let toolTarget: RuntimeTarget;
      try { toolTarget = parseToolSetTarget(toolSet.target); } catch {
        throw new Error("root_tools_identity_invalid");
      }
      if (
        toolTarget.root_id !== target.root_id
        || toolTarget.runtime_generation !== target.runtime_generation
      ) throw new Error("root_tools_identity_mismatch");
      this.#toolSets.add(toolSet);
      const transport = await this.transports.create(Object.freeze({ ...input, tools: toolSet })).catch(() => {
        throw new Error("root_transport_creation_failed");
      });
      if (typeof transport !== "object" || transport === null || this.#transports.has(transport)) {
        throw new Error("root_reconcill_resource_alias");
      }
      try { parseThreadId(transport.threadId); } catch {
        await transport.close().catch(() => undefined);
        throw new Error("root_transport_identity_invalid");
      }
      this.#transports.add(transport);
      return new BoundRootReconcill(input, transport, toolSet, continuity, this.#options, () => {
        if (this.#activeHomes.get(key) === reservation) this.#activeHomes.delete(key);
      });
    } catch (error) {
      if (this.#activeHomes.get(key) === reservation) this.#activeHomes.delete(key);
      throw error;
    }
  }
}

interface CodexTransportFactoryOptions {
  readonly spawner?: CodexSpawner;
  readonly log: (entry: RootToolBridgeLog) => void;
  readonly resolveWorkspaceRoot: (rootId: RootIssueId) => Promise<string>;
}

type TransportAbort =
  | { readonly kind: "budget"; readonly turn_id: string }
  | { readonly kind: "failure"; readonly turn_id: string };

async function waitForToolEffect(
  bridge: DynamicToolBridgeControl,
  deadline: number,
  deadlineReached: Promise<void>,
): Promise<void> {
  const idleWon = await Promise.race([
    bridge.waitForIdle().then(() => true),
    deadlineReached.then(() => false),
  ]);
  if (!idleWon || performance.now() >= deadline) throw new Error("codex_turn_timed_out");
}

class CodexRootTurnTransport implements RootTurnTransport {
  #closed = false;
  #activeBridge: DynamicToolBridgeControl | null = null;

  constructor(
    private readonly process: CodexProcess,
    private readonly thread: CodexThread,
    private readonly target: RuntimeTarget,
    private readonly tools: RootTools,
    private readonly codeInspection: RootCodeInspection,
    private readonly toolSpecs: readonly RootToolSpec[],
    private readonly log: (entry: RootToolBridgeLog) => void,
  ) {}

  get threadId(): ThreadId { return this.thread.threadId; }

  async turn(request: RootTurnRequest): Promise<RootTurnTransportResult> {
    if (this.#closed) throw new Error("codex_thread_closed");
    const bindings = this.#bindings(request.correlation_id);
    const deadline = performance.now() + request.timeout_ms;
    let deadlineTimer: NodeJS.Timeout | null = null;
    const deadlineReached = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(resolve, request.timeout_ms);
    });
    const bridgeRef: { current: DynamicToolBridgeControl | null } = { current: null };
    let abortTurn: ((abort: TransportAbort) => void) | null = null;
    let signaledAbort: TransportAbort | undefined;
    const abort = new Promise<TransportAbort>((resolve) => { abortTurn = resolve; });
    const signal = (value: TransportAbort): void => {
      if (signaledAbort !== undefined) {
        if (signaledAbort.kind === "budget" && value.kind === "failure") signaledAbort = value;
        return;
      }
      signaledAbort = value;
      abortTurn?.(value);
    };
    const finishAbort = (value: TransportAbort): RootTurnTransportResult => {
      this.#interrupt();
      if (value.kind === "budget") {
        return Object.freeze({ turn_id: value.turn_id, status: "budget_exhausted" });
      }
      throw new Error("root_tool_boundary_failed");
    };
    try {
      const turn = this.thread.turn(
        request.input,
        request.correlation_id,
        request.timeout_ms,
        request.output_schema,
        (turnId) => {
          const activeBridge = bindDynamicTools(this.process, {
            thread_id: this.threadId,
            turn_id: turnId,
            target: this.target,
            correlation_id: request.correlation_id,
            max_calls: request.max_tool_calls,
            bindings,
            log: this.log,
            on_fatal: () => signal({ kind: "failure", turn_id: turnId }),
            on_budget_exhausted: () => signal({ kind: "budget", turn_id: turnId }),
            on_denied: (reasonCode) => {
              if (isHardToolDenial(reasonCode)) {
                bridgeRef.current?.seal();
                signal({ kind: "failure", turn_id: turnId });
              }
            },
          });
          bridgeRef.current = activeBridge;
          this.#activeBridge = activeBridge;
        },
      );
      const settledTurn = turn.then(
        (value) => ({ kind: "turn" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const winner = await Promise.race([
        settledTurn,
        abort.then((value) => ({ kind: "abort" as const, value })),
        deadlineReached.then(() => ({ kind: "deadline" as const })),
      ]);
      const bridge = bridgeRef.current;
      if (winner.kind === "deadline" || performance.now() >= deadline) {
        if (bridge !== null) this.#releaseBridge(bridge);
        this.#interrupt();
        throw new Error("codex_turn_timed_out");
      }
      const budgetOverlappedEffect = bridge?.didBudgetOverlapEffect() === true;
      const completedWithInFlightEffect = winner.kind === "turn" && bridge?.didTerminalOverlapEffect() === true;
      if (bridge?.hasInFlight() === true) {
        try {
          await waitForToolEffect(bridge, deadline, deadlineReached);
        } catch (error) {
          this.#releaseBridge(bridge);
          this.#interrupt();
          throw error;
        }
      }
      if (performance.now() >= deadline) {
        if (bridge !== null) this.#releaseBridge(bridge);
        this.#interrupt();
        throw new Error("codex_turn_timed_out");
      }
      if (this.#closed) throw new Error("codex_thread_closed");
      if (bridge !== null) this.#releaseBridge(bridge);

      const finalAbort = signaledAbort ?? (winner.kind === "abort" ? winner.value : undefined);
      if (finalAbort?.kind === "failure") return finishAbort(finalAbort);
      if (budgetOverlappedEffect || completedWithInFlightEffect) {
        this.#interrupt();
        throw new Error("root_tool_boundary_failed");
      }
      if (finalAbort !== undefined) return finishAbort(finalAbort);
      if (winner.kind === "abort") return finishAbort(winner.value);
      if (winner.kind === "error") {
        this.#interrupt();
        throw winner.error;
      }
      return Object.freeze({
        turn_id: winner.value.turnId,
        status: winner.value.status,
        ...(winner.value.status === "completed" ? { output: winner.value.output } : {}),
      }) as RootTurnTransportResult;
    } finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#activeBridge?.();
    this.#activeBridge = null;
    this.thread.close();
    await this.process.shutdown();
  }

  #interrupt(): void {
    void this.thread.interrupt(parseCorrelationId(`interrupt:${randomUUID()}`)).catch(() => undefined);
  }

  #releaseBridge(bridge: DynamicToolBridgeControl): void {
    bridge();
    if (this.#activeBridge === bridge) this.#activeBridge = null;
  }

  #bindings(correlationId: CorrelationId): readonly RootToolBinding[] {
    const bindings = [
      ...bindRootTools(this.tools, correlationId),
      ...bindRootCodeInspection(this.codeInspection, correlationId),
    ];
    if (bindings.length !== this.toolSpecs.length) throw new Error("root_local_only_tool_denied");
    const expectedByName = new Map(this.toolSpecs.map((spec) => [spec.name, spec]));
    const boundNames = new Set<string>();
    return Object.freeze(bindings.map((binding): RootToolBinding => {
      const expected = expectedByName.get(binding.spec.name);
      if (
        expected === undefined
        || boundNames.has(binding.spec.name)
        || !isDeepStrictEqual(binding.spec, expected)
      ) throw new Error("root_local_only_tool_denied");
      boundNames.add(binding.spec.name);
      const execute = binding.execute;
      return Object.freeze({
        spec: expected,
        execute: (argumentsValue: unknown, execution: RootToolExecution) =>
          execute.call(binding, argumentsValue, execution),
      });
    }));
  }
}

export class CodexRootTurnTransportFactory implements RootTurnTransportFactory {
  constructor(
    private readonly codex: Omit<
      CodexProcessOptions,
      "capabilityMode" | "codexHome" | "rootId" | "runtimeGeneration"
    >,
    private readonly options: CodexTransportFactoryOptions,
  ) {}

  async create(input: RootTurnTransportFactoryInput): Promise<RootTurnTransport> {
    if (!isRootTools(input.tools)) throw new Error("root_local_only_tool_denied");
    const tools = input.tools;
    if (
      tools.target.root_id !== input.root_id
      || tools.target.runtime_generation !== input.runtime_generation
    ) throw new Error("root_local_only_tool_denied");
    const target = Object.freeze({
      root_id: input.root_id,
      runtime_generation: input.runtime_generation,
    });
    const workspaceRoot = await resolveRootWorkspace(
      this.options.resolveWorkspaceRoot,
      input.root_id,
      this.codex.startupTimeoutMs,
    );
    const codeInspection = await RootCodeInspection.create({ target, workspaceRoot });
    const toolSpecs = snapshotCodexRootLocalOnlyTools([
      ...tools.specs,
      ...codeInspection.specs,
    ]);
    const process = await CodexProcess.start({
      ...this.codex,
      codexHome: input.root_home,
      rootId: input.root_id,
      runtimeGeneration: input.runtime_generation,
      capabilityMode: createCodexProcessLocalOnlyMode({
        kind: "root_local_only",
        workspaceRoot,
        dynamicTools: toolSpecs,
      }),
    }, this.options.spawner);
    try {
      const runtime = process.localOnly;
      if (runtime?.role !== "root") throw new Error("codex_local_only_capability_mismatch");
      const thread = await CodexThread.create(process, {
        cwd: workspaceRoot,
        tools: runtime.dynamicTools,
        correlationId: parseCorrelationId(`thread:${randomUUID()}`),
        access: { kind: "read_only" },
        toolMode: "local_only",
        nativeTools: false,
      });
      return new CodexRootTurnTransport(
        process,
        thread,
        target,
        tools,
        codeInspection,
        runtime.dynamicTools,
        this.options.log,
      );
    } catch (error) {
      await process.shutdown();
      throw error;
    }
  }
}
