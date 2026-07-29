import type { CorrelationId, RootIssueId, RuntimeGeneration } from "../../contracts/identity.js";
import { asRecord, assertExactKeys, parseBoundedString, parseEnum } from "../../contracts/validation.js";

export const CODEX_REQUEST_METHODS = [
  "initialize", "thread/start", "turn/start", "turn/interrupt",
] as const;
export type CodexRequestMethod = typeof CODEX_REQUEST_METHODS[number];

export interface CodexRequestContext {
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly method: CodexRequestMethod;
}

export type CodexInboundMessage =
  | { readonly kind: "response"; readonly id: string; readonly result: unknown }
  | { readonly kind: "error"; readonly id: string; readonly code: number; readonly message: string }
  | { readonly kind: "turn_started"; readonly thread_id: string; readonly turn_id: string }
  | { readonly kind: "turn_completed"; readonly thread_id: string; readonly turn_id: string; readonly status: "completed"; readonly output: unknown }
  | { readonly kind: "turn_completed"; readonly thread_id: string; readonly turn_id: string; readonly status: "interrupted" | "failed" | "inProgress" }
  | { readonly kind: "tool_call"; readonly request_id: string; readonly thread_id: string; readonly turn_id: string; readonly call_id: string; readonly tool: string; readonly arguments: unknown };

function requestId(value: unknown): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length > 128) {
    throw new Error("invalid_codex_request_id");
  }
  return String(value);
}

function turnEvent(params: unknown, kind: "turn_started" | "turn_completed"): CodexInboundMessage {
  const record = asRecord(params, "invalid_codex_turn_event");
  assertExactKeys(record, ["threadId", "turn"]);
  const turn = asRecord(record.turn, "invalid_codex_turn_event");
  const threadId = parseBoundedString(record.threadId, "invalid_codex_thread_id", 128);
  const turnId = parseBoundedString(turn.id, "invalid_codex_turn_id", 128);
  if (kind === "turn_started") return Object.freeze({ kind, thread_id: threadId, turn_id: turnId });
  const status = parseEnum(turn.status, ["completed", "interrupted", "failed", "inProgress"] as const);
  if (status !== "completed") return Object.freeze({
    kind,
    thread_id: threadId,
    turn_id: turnId,
    status,
  });
  if (!Array.isArray(turn.items)) throw new Error("missing_codex_structured_output");
  const messages = turn.items.filter((item): item is Record<string, unknown> => {
    return typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "agentMessage";
  });
  if (messages.length === 0) throw new Error("missing_codex_structured_output");
  const text = parseBoundedString(messages.at(-1)?.text, "invalid_codex_structured_output", 256 * 1024);
  let output: unknown;
  try { output = JSON.parse(text); } catch { throw new Error("invalid_codex_structured_output"); }
  return Object.freeze({ kind, thread_id: threadId, turn_id: turnId, status, output });
}

export function parseCodexInbound(value: unknown): CodexInboundMessage {
  const record = asRecord(value, "invalid_codex_message");
  if ("method" in record) {
    const method = parseBoundedString(record.method, "invalid_codex_method", 128);
    if (method === "turn/started") {
      assertExactKeys(record, ["method", "params"]);
      return turnEvent(record.params, "turn_started");
    }
    if (method === "turn/completed") {
      assertExactKeys(record, ["method", "params"]);
      return turnEvent(record.params, "turn_completed");
    }
    if (method === "item/tool/call") {
      assertExactKeys(record, ["id", "method", "params"]);
      const params = asRecord(record.params, "invalid_codex_tool_call");
      assertExactKeys(params, "namespace" in params
        ? ["arguments", "callId", "threadId", "tool", "turnId", "namespace"]
        : ["arguments", "callId", "threadId", "tool", "turnId"]);
      if ("namespace" in params && params.namespace !== null && typeof params.namespace !== "string") {
        throw new Error("invalid_codex_tool_namespace");
      }
      return Object.freeze({
        kind: "tool_call",
        request_id: requestId(record.id),
        thread_id: parseBoundedString(params.threadId, "invalid_codex_thread_id", 128),
        turn_id: parseBoundedString(params.turnId, "invalid_codex_turn_id", 128),
        call_id: parseBoundedString(params.callId, "invalid_codex_call_id", 128),
        tool: parseBoundedString(params.tool, "invalid_codex_tool", 64),
        arguments: params.arguments,
      });
    }
    throw new Error("unknown_codex_method");
  }

  if (!("id" in record)) throw new Error("invalid_codex_message");
  const id = requestId(record.id);
  if ("result" in record) {
    assertExactKeys(record, ["id", "result"]);
    return Object.freeze({ kind: "response", id, result: record.result });
  }
  if ("error" in record) {
    assertExactKeys(record, ["id", "error"]);
    const error = asRecord(record.error, "invalid_codex_error");
    assertExactKeys(error, "data" in error ? ["code", "message", "data"] : ["code", "message"]);
    if (!Number.isSafeInteger(error.code)) throw new Error("invalid_codex_error");
    return Object.freeze({
      kind: "error",
      id,
      code: error.code as number,
      message: parseBoundedString(error.message, "invalid_codex_error", 256),
    });
  }
  throw new Error("invalid_codex_message");
}

export class CodexCorrelationRegistry {
  readonly #pending = new Map<string, CodexRequestContext>();
  #sequence = 0;

  register(context: CodexRequestContext): string {
    const id = `symphony:${context.runtime_generation}:${++this.#sequence}`;
    this.#pending.set(id, Object.freeze({ ...context }));
    return id;
  }

  accept(id: string): CodexRequestContext {
    const context = this.#pending.get(id);
    if (!context) throw new Error("unknown_or_stale_codex_response");
    this.#pending.delete(id);
    return context;
  }

  cancelGeneration(generation: RuntimeGeneration): void {
    for (const [id, context] of this.#pending) {
      if (context.runtime_generation === generation) this.#pending.delete(id);
    }
  }
}
