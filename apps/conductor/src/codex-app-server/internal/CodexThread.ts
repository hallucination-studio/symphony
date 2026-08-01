import {
  parseCorrelationId,
  parseThreadId,
  type CorrelationId,
  type ThreadId,
} from "../../contracts/identity.js";
import { asRecord, parseBoundedString } from "../../contracts/validation.js";
import type { RootToolSpec } from "../../runtime/RootToolBoundary.js";
import type { CodexInboundMessage } from "./CodexProtocol.js";
import {
  localOnlyEnvironment,
  localOnlyThreadConfig,
  type CodexLocalOnlyRuntime,
} from "./CodexLocalOnly.js";
import { CodexProcess } from "./CodexProcess.js";

export interface CodexTurnResult {
  readonly turnId: string;
  readonly status: "completed" | "interrupted" | "failed";
  readonly output?: unknown;
}

export type CodexThreadAccess =
  | { readonly kind: "read_only" }
  | {
      readonly kind: "workspace_write";
      readonly writableRoot: string;
      readonly networkAccess: boolean;
    };

export type CodexThreadToolMode = "codex" | "dynamic_only" | "local_only";

const DYNAMIC_ONLY_CONFIG = Object.freeze({
  web_search: "disabled",
  features: Object.freeze({
    apps: false,
    goals: false,
    hooks: false,
    memories: false,
    multi_agent: false,
    remote_plugin: false,
    shell_snapshot: false,
    shell_tool: false,
    unified_exec: false,
  }),
});

export class CodexThread {
  #activeTurn: string | null = null;
  #turnCompletion: ((result: CodexTurnResult) => void) | null = null;
  #turnFailure: ((error: Error) => void) | null = null;
  #turnTimer: NodeJS.Timeout | null = null;
  #turnDeadline = 0;
  #startingTurn = false;
  #startFailure: ((error: Error) => void) | null = null;
  #startTimedOut = false;
  #closed = false;
  #observedTurn: string | null = null;
  #turnStarted: ((turnId: string) => void) | null = null;
  #earlyFailure: Error | null = null;
  readonly #earlyCompletions = new Map<string, CodexTurnResult>();
  readonly #unsubscribe: () => void;
  readonly #unsubscribeFailure: () => void;

  private constructor(
    private readonly process: CodexProcess,
    readonly threadId: ThreadId,
    private readonly cwd: string,
    private readonly access: CodexThreadAccess,
    private readonly localOnly: CodexLocalOnlyRuntime | undefined,
  ) {
    this.#unsubscribe = process.onNotification((message) => this.#handle(message));
    this.#unsubscribeFailure = process.onFailure((code) => this.#failTurn(code));
  }

  static async create(
    process: CodexProcess,
    input: {
      readonly cwd: string;
      readonly tools: readonly RootToolSpec[];
      readonly correlationId: CorrelationId;
      readonly access: CodexThreadAccess;
      readonly toolMode?: CodexThreadToolMode;
      readonly nativeTools?: boolean;
    },
  ): Promise<CodexThread> {
    const dynamicOnly = input.toolMode === "dynamic_only";
    const localOnly = input.toolMode === "local_only" ? process.localOnly : undefined;
    if (
      (input.toolMode === "local_only") !== (process.localOnly !== undefined)
      || (localOnly !== undefined && (
        input.cwd !== localOnly.workspaceRoot
        || (localOnly.role === "root"
          ? input.access.kind !== "read_only"
            || input.tools !== localOnly.dynamicTools
            || input.nativeTools !== false
          : input.tools.length !== 0
            || (input.access.kind === "workspace_write" && (
              input.access.writableRoot !== localOnly.workspaceRoot
              || input.access.networkAccess
            )))
      ))
    ) throw new Error("codex_local_only_capability_mismatch");
    const params = localOnly === undefined
      ? {
          cwd: input.cwd,
          approvalPolicy: "never",
          sandbox: input.access.kind === "read_only" ? "read-only" : "workspace-write",
          dynamicTools: input.tools,
          ...(dynamicOnly ? {
            ephemeral: true,
            environments: [],
            config: DYNAMIC_ONLY_CONFIG,
          } : {}),
        }
      : {
          cwd: localOnly.workspaceRoot,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          permissions: localOnly.readPermissionProfile,
          dynamicTools: localOnly.dynamicTools,
          ephemeral: true,
          environments: localOnlyEnvironment(localOnly),
          runtimeWorkspaceRoots: [localOnly.workspaceRoot],
          selectedCapabilityRoots: [],
          baseInstructions: localOnly.baseInstructions,
          developerInstructions: localOnly.developerInstructions,
          config: localOnlyThreadConfig(localOnly, input.nativeTools !== false),
        };
    const response = asRecord(await process.request("thread/start", params, input.correlationId), "invalid_codex_thread_response");
    if (localOnly !== undefined) {
      const profile = asRecord(response.activePermissionProfile, "codex_local_only_capability_mismatch");
      const expectedWorkspaceRoots = localOnly.role === "root" ? [] : [localOnly.workspaceRoot];
      if (
        response.cwd !== localOnly.workspaceRoot
        || response.approvalPolicy !== "never"
        || response.approvalsReviewer !== "user"
        || profile.id !== localOnly.readPermissionProfile
        || profile.extends !== null
        || !Array.isArray(response.instructionSources)
        || response.instructionSources.length !== 0
        || !Array.isArray(response.runtimeWorkspaceRoots)
        || response.runtimeWorkspaceRoots.length !== expectedWorkspaceRoots.length
        || !response.runtimeWorkspaceRoots.every((root, index) => root === expectedWorkspaceRoots[index])
      ) throw new Error("codex_local_only_capability_mismatch");
    }
    const thread = asRecord(response.thread, "invalid_codex_thread_response");
    return new CodexThread(process, parseThreadId(thread.id), input.cwd, input.access, localOnly);
  }

  async turn(
    input: string,
    correlationId: CorrelationId,
    timeoutMs = 120_000,
    outputSchema?: Record<string, unknown>,
    onStarted?: (turnId: string) => void,
  ): Promise<CodexTurnResult> {
    if (this.#closed || this.#startTimedOut) throw new Error("codex_thread_closed");
    if (this.#activeTurn || this.#startingTurn) throw new Error("codex_turn_already_active");
    parseBoundedString(input, "invalid_codex_turn_input", 256 * 1024);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid_codex_turn_timeout");
    const deadline = performance.now() + timeoutMs;
    this.#turnDeadline = deadline;
    this.#startingTurn = true;
    this.#observedTurn = null;
    this.#turnStarted = onStarted ?? null;
    this.#earlyFailure = null;
    let response: Record<string, unknown>;
    let startTimer: NodeJS.Timeout | null = null;
    const startTimeout = new Promise<never>((_resolve, reject) => {
      this.#startFailure = reject;
      startTimer = setTimeout(() => reject(new Error("codex_turn_timed_out")), timeoutMs);
    });
    try {
      const access = this.localOnly === undefined
        ? {
            sandboxPolicy: this.access.kind === "read_only"
              ? { type: "readOnly" }
              : {
                  type: "workspaceWrite",
                  writableRoots: [this.access.writableRoot],
                  networkAccess: this.access.networkAccess,
                },
          }
        : {
            approvalsReviewer: "user",
            permissions: this.access.kind === "read_only"
              ? this.localOnly.readPermissionProfile
              : this.localOnly.writePermissionProfile,
            environments: localOnlyEnvironment(this.localOnly),
            runtimeWorkspaceRoots: [this.localOnly.workspaceRoot],
          };
      const start = this.process.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: input }],
        cwd: this.cwd,
        approvalPolicy: "never",
        ...access,
        ...(outputSchema === undefined ? {} : { outputSchema }),
      }, correlationId);
      response = asRecord(await Promise.race([start, startTimeout]), "invalid_codex_turn_response");
    } catch (error) {
      const timedOut = error instanceof Error && error.message === "codex_turn_timed_out";
      const preserveActiveTurn = timedOut && this.#activeTurn !== null;
      if (timedOut && !preserveActiveTurn) this.#startTimedOut = true;
      this.#resetStartingTurn();
      if (!preserveActiveTurn) this.#activeTurn = null;
      if (timedOut && !preserveActiveTurn) void this.process.shutdown().catch(() => undefined);
      throw error;
    } finally {
      this.#startFailure = null;
      if (startTimer !== null) clearTimeout(startTimer);
    }
    const turn = asRecord(response.turn, "invalid_codex_turn_response");
    const turnId = parseBoundedString(turn.id, "invalid_codex_turn_response", 128);
    if (this.#observedTurn !== null && this.#observedTurn !== turnId) {
      this.#resetStartingTurn();
      throw new Error("codex_turn_identity_mismatch");
    }
    this.#activeTurn = turnId;
    if (this.#observedTurn === null) this.#activateTurn(turnId);
    const earlyFailure = this.#earlyFailure;
    this.#startingTurn = false;
    this.#turnStarted = null;
    this.#observedTurn = null;
    this.#earlyFailure = null;
    if (this.#closed) {
      this.#activeTurn = null;
      throw new Error("codex_thread_closed");
    }
    if (earlyFailure !== null) throw earlyFailure;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new Error("codex_turn_timed_out");
    const early = this.#earlyCompletions.get(turnId);
    this.#earlyCompletions.clear();
    if (early) {
      this.#earlyCompletions.delete(turnId);
      this.#activeTurn = null;
      this.#turnDeadline = 0;
      return early;
    }
    return new Promise<CodexTurnResult>((resolve, reject) => {
      this.#turnCompletion = resolve;
      this.#turnFailure = reject;
      this.#turnTimer = setTimeout(() => {
        this.#turnCompletion = null;
        this.#turnFailure = null;
        this.#turnTimer = null;
        reject(new Error("codex_turn_timed_out"));
      }, Math.ceil(remainingMs));
    });
  }

  async interrupt(correlationId = parseCorrelationId("interrupt:1")): Promise<void> {
    if (!this.#activeTurn) return;
    await this.process.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.#activeTurn,
    }, correlationId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#unsubscribeFailure();
    const rejectStart = this.#startFailure;
    const reject = this.#turnFailure;
    this.#activeTurn = null;
    this.#turnCompletion = null;
    this.#turnFailure = null;
    if (this.#turnTimer) clearTimeout(this.#turnTimer);
    this.#turnTimer = null;
    this.#turnDeadline = 0;
    this.#startingTurn = false;
    this.#startFailure = null;
    this.#startTimedOut = false;
    this.#observedTurn = null;
    this.#turnStarted = null;
    this.#earlyFailure = null;
    this.#earlyCompletions.clear();
    rejectStart?.(new Error("codex_thread_closed"));
    reject?.(new Error("codex_thread_closed"));
  }

  #handle(message: CodexInboundMessage): void {
    if (message.kind === "turn_started" && message.thread_id === this.threadId) {
      if (this.#startingTurn) this.#activateTurn(message.turn_id);
      return;
    }
    if (message.kind !== "turn_completed" || message.thread_id !== this.threadId) return;
    if (message.status === "inProgress") throw new Error("invalid_completed_turn_status");
    const result: CodexTurnResult = message.status === "completed"
      ? { turnId: message.turn_id, status: message.status, output: message.output }
      : { turnId: message.turn_id, status: message.status };
    if (this.#startingTurn) {
      this.#earlyCompletions.set(message.turn_id, result);
      return;
    }
    if (!this.#activeTurn || message.turn_id !== this.#activeTurn) return;
    const resolve = this.#turnCompletion;
    const reject = this.#turnFailure;
    const expired = performance.now() >= this.#turnDeadline;
    this.#activeTurn = null;
    this.#turnCompletion = null;
    this.#turnFailure = null;
    if (this.#turnTimer) clearTimeout(this.#turnTimer);
    this.#turnTimer = null;
    this.#turnDeadline = 0;
    if (expired) reject?.(new Error("codex_turn_timed_out"));
    else resolve?.(result);
  }

  #activateTurn(turnId: string): void {
    if (this.#observedTurn !== null) {
      if (this.#observedTurn !== turnId) this.#earlyFailure = new Error("codex_turn_identity_mismatch");
      return;
    }
    this.#observedTurn = turnId;
    this.#activeTurn = turnId;
    try { this.#turnStarted?.(turnId); } catch { this.#earlyFailure = new Error("codex_turn_activation_failed"); }
  }

  #failTurn(code: string): void {
    const failure = new Error(code);
    if (this.#startingTurn) {
      this.#earlyFailure = failure;
      return;
    }
    const reject = this.#turnFailure;
    this.#activeTurn = null;
    this.#turnCompletion = null;
    this.#turnFailure = null;
    if (this.#turnTimer) clearTimeout(this.#turnTimer);
    this.#turnTimer = null;
    this.#turnDeadline = 0;
    reject?.(failure);
  }

  #resetStartingTurn(): void {
    this.#startingTurn = false;
    this.#startFailure = null;
    this.#observedTurn = null;
    this.#turnStarted = null;
    this.#earlyFailure = null;
    this.#earlyCompletions.clear();
  }
}
