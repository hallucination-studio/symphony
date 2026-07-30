import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseThreadId,
} from "../../contracts/identity.js";
import type { CodexInboundMessage } from "./CodexProtocol.js";
import {
  bindDynamicTools,
  type RootToolBridgeLog,
} from "./DynamicToolBridge.js";
import { RootToolCallError } from "../../runtime/RootToolBoundary.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function call(
  id: string,
  thread: string,
  tool: string,
  argumentsValue: unknown = {},
): Extract<CodexInboundMessage, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    request_id: id,
    thread_id: thread,
    turn_id: "turn-1",
    call_id: `call-${id}`,
    tool,
    arguments: argumentsValue,
  };
}

test("dynamic tool bridge returns typed output only to the bound Root thread and accepts each call once", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const responses: Array<[string, boolean, string]> = [];
  const executions: unknown[] = [];
  const logs: RootToolBridgeLog[] = [];
  const fatals: string[] = [];
  const process = {
    onNotification: (next: (message: CodexInboundMessage) => void) => {
      listener = next;
      return () => { listener = null; };
    },
    respondToTool: (id: string, success: boolean, text: string) => {
      responses.push([id, success, text]);
      return Promise.resolve();
    },
  };
  const threadId = parseThreadId("thread-1");
  const close = bindDynamicTools(process, {
    thread_id: threadId,
    turn_id: "turn-1",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(2) },
    correlation_id: parseCorrelationId("corr:turn:1"),
    max_calls: 6,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read one issue", inputSchema: { type: "object" } },
      execute: (value, execution) => {
        execution.assertActive();
        executions.push(value);
        return Promise.resolve({ output: { issue: null } });
      },
    }],
    log: (entry) => logs.push(entry),
    on_fatal: (reason) => fatals.push(reason),
  });

  const accepted = call("accepted", threadId, "get_issue", { issue_id: "LIN-2" });
  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("foreign", "thread-2", "get_issue"));
  (listener as ((message: CodexInboundMessage) => void) | null)?.({
    ...call("unknown", threadId, "provider-token-secret"),
    call_id: "provider-token-secret",
  });
  (listener as ((message: CodexInboundMessage) => void) | null)?.(accepted);
  (listener as ((message: CodexInboundMessage) => void) | null)?.(accepted);
  (listener as ((message: CodexInboundMessage) => void) | null)?.({ ...accepted, request_id: "duplicate" });
  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("concurrent", threadId, "get_issue"));
  await tick();

  assert.deepEqual(executions, [{ issue_id: "LIN-2" }]);
  assert.deepEqual(responses.map(([id, success, text]) => [
    id,
    success,
    success ? JSON.parse(text) : (JSON.parse(text) as { code: string }).code,
  ]), [
    ["unknown", false, "capability_denied"],
    ["duplicate", false, "invalid_contract"],
    ["concurrent", false, "invalid_contract"],
    ["accepted", true, { output: { issue: null } }],
  ]);
  assert.deepEqual(logs.map(({ event }) => event), [
    "root_tool_call_denied",
    "root_tool_call_denied",
    "root_tool_call_denied",
    "root_tool_call_accepted",
  ]);
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes("issue_id"), false);
  assert.equal(serializedLogs.includes("provider-token-secret"), false);
  assert.deepEqual(fatals, []);
  close();
  assert.equal(listener, null);
});

test("dynamic tool bridge revocation fences queued calls and late results from effects or responses", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const responses: Array<[string, boolean, string]> = [];
  let executions = 0;
  let resolveExecution: ((value: unknown) => void) | null = null;
  const binding = {
    spec: { type: "function" as const, name: "get_issue", description: "Read", inputSchema: { type: "object" } },
    execute: (_value: unknown, execution: { assertActive(): void }) => {
      execution.assertActive();
      executions += 1;
      return new Promise<unknown>((resolve) => { resolveExecution = resolve; });
    },
  };
  const options = {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-1",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:1"),
    max_calls: 2,
    bindings: [binding],
    log: () => undefined,
    on_fatal: () => undefined,
  };
  const process = {
    onNotification: (next: (message: CodexInboundMessage) => void) => {
      listener = next;
      return () => { listener = null; };
    },
    respondToTool: (id: string, success: boolean, text: string) => {
      responses.push([id, success, text]);
      return Promise.resolve();
    },
  };

  const closeQueued = bindDynamicTools(process, options);
  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("queued", "thread-1", "get_issue"));
  closeQueued();
  await tick();
  assert.equal(executions, 0);
  assert.deepEqual(responses, []);

  const closePending = bindDynamicTools(process, options);
  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("pending", "thread-1", "get_issue"));
  await tick();
  assert.equal(executions, 1);
  closePending();
  (resolveExecution as ((value: unknown) => void) | null)?.({ output: { issue: null } });
  await tick();
  assert.deepEqual(responses, []);
});

test("dynamic tool bridge rejects stale turns, carries large typed resources, and treats response loss as fatal", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const responses: Array<[string, boolean, string]> = [];
  const fatals: string[] = [];
  let executions = 0;
  let rejectResponses = false;
  bindDynamicTools({
    onNotification: (next) => { listener = next; return () => { listener = null; }; },
    respondToTool: (id, success, text) => {
      if (rejectResponses) return Promise.reject(new Error("transport-secret"));
      responses.push([id, success, text]);
      return Promise.resolve();
    },
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-current",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:1"),
    max_calls: 3,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => {
        executions += 1;
        return Promise.resolve({ description: "x".repeat(100_000) });
      },
    }],
    log: () => undefined,
    on_fatal: (reason) => fatals.push(reason),
  });

  const stale = {
    ...call("stale", "thread-1", "get_issue"),
    turn_id: "turn-old",
  };
  (listener as ((message: CodexInboundMessage) => void) | null)?.(stale);
  (listener as ((message: CodexInboundMessage) => void) | null)?.(stale);
  await tick();
  assert.equal(executions, 0);
  assert.equal(responses.length, 1);
  assert.equal((JSON.parse(responses[0]?.[2] ?? "null") as { code?: unknown }).code, "canceled");

  (listener as ((message: CodexInboundMessage) => void) | null)?.({
    ...call("large", "thread-1", "get_issue"),
    turn_id: "turn-current",
  });
  await tick();
  assert.equal(JSON.parse(responses[1]?.[2] ?? "null").description.length, 100_000);

  rejectResponses = true;
  (listener as ((message: CodexInboundMessage) => void) | null)?.({
    ...call("lost", "thread-1", "get_issue"),
    turn_id: "turn-current",
  });
  await tick();
  assert.equal(executions, 2);
  assert.deepEqual(fatals, ["boundary_unavailable"]);
  assert.equal(listener, null);
});

test("dynamic tool bridge responds once to exact replay of an over-budget denial", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const responses: Array<[string, boolean, string]> = [];
  bindDynamicTools({
    onNotification: (next) => { listener = next; return () => undefined; },
    respondToTool: (id, success, text) => {
      responses.push([id, success, text]);
      return Promise.resolve();
    },
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-1",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:1"),
    max_calls: 1,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => Promise.resolve({ output: { issue: null } }),
    }],
    log: () => undefined,
    on_fatal: () => undefined,
  });

  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("accepted", "thread-1", "get_issue"));
  await tick();
  const denied = call("over-budget", "thread-1", "get_issue");
  (listener as ((message: CodexInboundMessage) => void) | null)?.(denied);
  (listener as ((message: CodexInboundMessage) => void) | null)?.(denied);
  await tick();

  assert.deepEqual(responses.map(([id, success]) => [id, success]), [
    ["accepted", true],
    ["over-budget", false],
  ]);
  assert.equal((JSON.parse(responses[1]?.[2] ?? "null") as { code?: unknown }).code, "invalid_contract");
});

test("dynamic tool bridge exposes only stable reason codes and never logs arguments or provider errors", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const responses: Array<[string, boolean, string]> = [];
  const logs: RootToolBridgeLog[] = [];
  const fatals: string[] = [];
  bindDynamicTools({
    onNotification: (next) => { listener = next; return () => undefined; },
    respondToTool: (id, success, text) => { responses.push([id, success, text]); return Promise.resolve(); },
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-1",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:1"),
    max_calls: 2,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: (value) => {
        if (value === "denied") throw new RootToolCallError("stale_generation");
        throw new Error("provider token secret");
      },
    }],
    log: (entry) => logs.push(entry),
    on_fatal: (reason) => fatals.push(reason),
  });
  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("denied", "thread-1", "get_issue", "denied"));
  await tick();
  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("failed", "thread-1", "get_issue", {
    authorization: "Bearer provider-token",
  }));
  await tick();

  assert.equal((JSON.parse(responses[0]?.[2] ?? "null") as { code?: unknown }).code, "stale_generation");
  assert.deepEqual(responses.map(([id, success]) => [id, success]), [["denied", false]]);
  assert.deepEqual(logs.map(({ event }) => event), [
    "root_tool_call_denied",
    "root_tool_call_failed",
  ]);
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes("provider-token"), false);
  assert.equal(serializedLogs.includes("provider token secret"), false);
  assert.equal(serializedLogs.includes("authorization"), false);
  assert.deepEqual(fatals, ["boundary_unavailable"]);
});

test("dynamic tool bridge treats non-JSON tool results as fatal invalid contracts", async () => {
  for (const result of [BigInt(1), (() => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    return cyclic;
  })()]) {
    let listener: ((message: CodexInboundMessage) => void) | null = null;
    const responses: Array<[string, boolean, string]> = [];
    const fatals: string[] = [];
    bindDynamicTools({
      onNotification: (next) => { listener = next; return () => { listener = null; }; },
      respondToTool: (id, success, text) => {
        responses.push([id, success, text]);
        return Promise.resolve();
      },
    }, {
      thread_id: parseThreadId("thread-1"),
      turn_id: "turn-1",
      target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
      correlation_id: parseCorrelationId("corr:turn:1"),
      max_calls: 1,
      bindings: [{
        spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
        execute: () => Promise.resolve(result),
      }],
      log: () => undefined,
      on_fatal: (reason) => fatals.push(reason),
    });

    (listener as ((message: CodexInboundMessage) => void) | null)?.(call("invalid", "thread-1", "get_issue"));
    await tick();

    assert.deepEqual(responses, []);
    assert.deepEqual(fatals, ["invalid_contract"]);
    assert.equal(listener, null);
  }
});
