import {
  parseCorrelationId,
  parseThreadId,
  type CorrelationId,
  type ThreadId,
} from "../../contracts/identity.js";
import { asRecord, parseBoundedString } from "../../contracts/validation.js";
import type { CodexInboundMessage } from "./CodexProtocol.js";
import { CodexProcess } from "./CodexProcess.js";

export interface DynamicToolSpec {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface CodexTurnResult {
  readonly turnId: string;
  readonly status: "completed" | "interrupted" | "failed";
  readonly output?: unknown;
}

export class CodexThread {
  #activeTurn: string | null = null;
  #turnCompletion: ((result: CodexTurnResult) => void) | null = null;
  #turnTimer: NodeJS.Timeout | null = null;
  #startingTurn = false;
  readonly #earlyCompletions = new Map<string, CodexTurnResult>();
  readonly #unsubscribe: () => void;

  private constructor(
    private readonly process: CodexProcess,
    readonly threadId: ThreadId,
  ) {
    this.#unsubscribe = process.onNotification((message) => this.#handle(message));
  }

  static async create(
    process: CodexProcess,
    input: { readonly cwd: string; readonly tools: readonly DynamicToolSpec[]; readonly correlationId: CorrelationId },
  ): Promise<CodexThread> {
    const response = asRecord(await process.request("thread/start", {
      cwd: input.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      dynamicTools: input.tools,
    }, input.correlationId), "invalid_codex_thread_response");
    const thread = asRecord(response.thread, "invalid_codex_thread_response");
    return new CodexThread(process, parseThreadId(thread.id));
  }

  async turn(
    input: string,
    correlationId: CorrelationId,
    timeoutMs = 120_000,
    outputSchema?: Record<string, unknown>,
  ): Promise<CodexTurnResult> {
    if (this.#activeTurn) throw new Error("codex_turn_already_active");
    parseBoundedString(input, "invalid_codex_turn_input", 256 * 1024);
    this.#startingTurn = true;
    let response: Record<string, unknown>;
    try {
      response = asRecord(await this.process.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: input }],
        ...(outputSchema === undefined ? {} : { outputSchema }),
      }, correlationId), "invalid_codex_turn_response");
    } catch (error) {
      this.#startingTurn = false;
      this.#earlyCompletions.clear();
      throw error;
    }
    const turn = asRecord(response.turn, "invalid_codex_turn_response");
    const turnId = parseBoundedString(turn.id, "invalid_codex_turn_response", 128);
    this.#activeTurn = turnId;
    this.#startingTurn = false;
    const early = this.#earlyCompletions.get(turnId);
    this.#earlyCompletions.clear();
    if (early) {
      this.#earlyCompletions.delete(turnId);
      this.#activeTurn = null;
      return early;
    }
    return new Promise<CodexTurnResult>((resolve, reject) => {
      this.#turnCompletion = resolve;
      this.#turnTimer = setTimeout(() => {
        this.#activeTurn = null;
        this.#turnCompletion = null;
        this.#turnTimer = null;
        reject(new Error("codex_turn_timed_out"));
      }, timeoutMs);
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
    this.#unsubscribe();
    this.#activeTurn = null;
    this.#turnCompletion = null;
    if (this.#turnTimer) clearTimeout(this.#turnTimer);
    this.#turnTimer = null;
    this.#startingTurn = false;
    this.#earlyCompletions.clear();
  }

  #handle(message: CodexInboundMessage): void {
    if (message.kind !== "turn_completed" || message.thread_id !== this.threadId) return;
    if (message.status === "inProgress") throw new Error("invalid_completed_turn_status");
    const result: CodexTurnResult = message.status === "completed"
      ? { turnId: message.turn_id, status: message.status, output: message.output }
      : { turnId: message.turn_id, status: message.status };
    if (this.#startingTurn) {
      this.#earlyCompletions.set(message.turn_id, result);
      return;
    }
    if (!this.#activeTurn || message.turn_id !== this.#activeTurn || !this.#turnCompletion) return;
    const resolve = this.#turnCompletion;
    this.#activeTurn = null;
    this.#turnCompletion = null;
    if (this.#turnTimer) clearTimeout(this.#turnTimer);
    this.#turnTimer = null;
    resolve(result);
  }
}
