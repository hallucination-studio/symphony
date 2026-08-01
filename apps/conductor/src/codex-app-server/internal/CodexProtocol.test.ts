import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../../contracts/identity.js";
import { CodexCorrelationRegistry, parseCodexInbound } from "./CodexProtocol.js";

test("Codex protocol validates official response, turn, and dynamic tool shapes", () => {
  assert.deepEqual(parseCodexInbound({ id: "1", result: { thread: { id: "thread-1" } } }), {
    kind: "response", id: "1", result: { thread: { id: "thread-1" } },
  });
  assert.deepEqual(parseCodexInbound({
    emittedAtMs: 1_234,
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ id: "item-1", type: "agentMessage", text: '{"kind":"decision"}' }],
        error: null,
      },
    },
  }), {
    kind: "turn_completed", thread_id: "thread-1", turn_id: "turn-1", status: "completed",
    output: { kind: "decision" },
  });
  assert.equal(parseCodexInbound({
    id: 7,
    method: "item/tool/call",
    params: { threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool: "work", arguments: {}, namespace: null },
  }).kind, "tool_call");
  assert.equal(parseCodexInbound({
    id: 8,
    method: "item/tool/call",
    params: { threadId: "thread-1", turnId: "turn-1", callId: "call-2", tool: "plan", arguments: {} },
  }).kind, "tool_call");
  assert.throws(() => parseCodexInbound({
    emittedAtMs: "1234",
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress", items: [], error: null },
    },
  }), /invalid_codex_notification_timestamp/u);
  assert.throws(() => parseCodexInbound({ method: "legacy/event", params: {} }), /unknown_codex_method/u);
  assert.throws(() => parseCodexInbound({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [], error: null },
    },
  }), /missing_codex_structured_output/u);
});

test("correlation registry accepts out-of-order exact responses once", () => {
  const registry = new CodexCorrelationRegistry();
  const common = {
    root_id: parseRootIssueId("LIN-1"),
    runtime_generation: parseRuntimeGeneration(1),
    correlation_id: parseCorrelationId("corr:1"),
  };
  const first = registry.register({ ...common, method: "thread/start" });
  const second = registry.register({ ...common, correlation_id: parseCorrelationId("corr:2"), method: "turn/start" });
  assert.equal(registry.accept(second).method, "turn/start");
  assert.equal(registry.accept(first).method, "thread/start");
  assert.throws(() => registry.accept(first), /unknown_or_stale_codex_response/u);

  const stale = registry.register({ ...common, method: "turn/interrupt" });
  registry.cancelGeneration(common.runtime_generation);
  assert.throws(() => registry.accept(stale), /unknown_or_stale_codex_response/u);
});
