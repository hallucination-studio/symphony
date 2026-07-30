import assert from "node:assert/strict";
import test from "node:test";

import { parseThreadId } from "../../contracts/identity.js";
import type { CodexInboundMessage } from "./CodexProtocol.js";
import { bindDynamicTools } from "./DynamicToolBridge.js";

test("dynamic tool bridge fences thread and tool identity and returns bounded sanitized results", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const responses: Array<[string, boolean, string]> = [];
  const process = {
    onNotification: (next: (message: CodexInboundMessage) => void) => { listener = next; return () => { listener = null; }; },
    respondToTool: (id: string, success: boolean, text: string) => { responses.push([id, success, text]); return Promise.resolve(); },
  };
  const threadId = parseThreadId("thread-1");
  const close = bindDynamicTools(process, threadId, [{
    spec: { type: "function", name: "linear_stage", description: "Update bound stage", inputSchema: { type: "object" } },
    execute: (value) => Promise.resolve({ accepted: value }),
  }]);
  const call = (id: string, thread: string, tool: string): CodexInboundMessage => ({
    kind: "tool_call", request_id: id, thread_id: thread, turn_id: "turn-1", call_id: `call-${id}`, tool, arguments: { status: "Done" },
  });

  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("foreign", "thread-2", "linear_stage"));
  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("unknown", threadId, "other"));
  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("accepted", threadId, "linear_stage"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(responses, [
    ["unknown", false, "tool_not_authorized"],
    ["accepted", true, JSON.stringify({ accepted: { status: "Done" } })],
  ]);
  close();
  assert.equal(listener, null);
});

test("dynamic tool bridge returns one stable failure and never exposes provider errors", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const responses: Array<[string, boolean, string]> = [];
  bindDynamicTools({
    onNotification: (next) => { listener = next; return () => undefined; },
    respondToTool: (id, success, text) => { responses.push([id, success, text]); return Promise.resolve(); },
  }, parseThreadId("thread-1"), [{
    spec: { type: "function", name: "linear_stage", description: "Update", inputSchema: { type: "object" } },
    execute: () => Promise.reject(new Error("provider token secret")),
  }]);
  (listener as ((message: CodexInboundMessage) => void) | null)?.({
    kind: "tool_call", request_id: "request-1", thread_id: "thread-1", turn_id: "turn-1",
    call_id: "call-1", tool: "linear_stage", arguments: {},
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(responses, [["request-1", false, "tool_execution_failed"]]);
});
