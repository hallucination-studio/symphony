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
  (listener as ((message: CodexInboundMessage) => void) | null)?.(accepted);
  (listener as ((message: CodexInboundMessage) => void) | null)?.(accepted);
  await tick();

  assert.deepEqual(executions, [{ issue_id: "LIN-2" }]);
  assert.deepEqual(responses.map(([id, success, text]) => [
    id,
    success,
    success ? JSON.parse(text) : (JSON.parse(text) as { code: string }).code,
  ]), [
    ["accepted", true, { output: { issue: null } }],
  ]);
  assert.deepEqual(logs.map(({ event }) => event), ["root_tool_call_accepted"]);
  assert.deepEqual([...new Set(logs.map(({ turn_id }) => turn_id))], ["turn-1"]);
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes("issue_id"), false);
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

test("dynamic tool bridge seals synchronously when terminal output precedes a late call", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  let executions = 0;
  const close = bindDynamicTools({
    onNotification: (next) => { listener = next; return () => { listener = null; }; },
    respondToTool: () => Promise.resolve(),
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-1",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:1"),
    max_calls: 1,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => {
        executions += 1;
        return Promise.resolve({ output: { issue: null } });
      },
    }],
    log: () => undefined,
    on_fatal: () => undefined,
  });

  (listener as ((message: CodexInboundMessage) => void) | null)?.({
    kind: "turn_completed",
    thread_id: "thread-1",
    turn_id: "turn-1",
    status: "completed",
    output: {},
  });
  (listener as ((message: CodexInboundMessage) => void) | null)?.(
    call("late-same-chunk", "thread-1", "get_issue"),
  );
  await tick();

  assert.equal(executions, 0);
  close();
});

test("dynamic tool bridge cancels a queued effect when terminal output follows in the same chunk", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  let executions = 0;
  const close = bindDynamicTools({
    onNotification: (next) => { listener = next; return () => { listener = null; }; },
    respondToTool: () => Promise.resolve(),
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-1",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:1"),
    max_calls: 1,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => {
        executions += 1;
        return Promise.resolve({ output: { issue: null } });
      },
    }],
    log: () => undefined,
    on_fatal: () => undefined,
  });

  (listener as ((message: CodexInboundMessage) => void) | null)?.(
    call("queued-before-terminal", "thread-1", "get_issue"),
  );
  (listener as ((message: CodexInboundMessage) => void) | null)?.({
    kind: "turn_completed",
    thread_id: "thread-1",
    turn_id: "turn-1",
    status: "completed",
    output: {},
  });
  await tick();

  assert.equal(executions, 0);
  close();
});

test("dynamic tool bridge treats terminal output during tool response delivery as overlapping", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  let resolveResponse: (() => void) | null = null;
  const bridge = bindDynamicTools({
    onNotification: (next) => { listener = next; return () => { listener = null; }; },
    respondToTool: (id) => id === "response-pending"
      ? new Promise<void>((resolve) => { resolveResponse = resolve; })
      : Promise.resolve(),
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

  (listener as ((message: CodexInboundMessage) => void) | null)?.(
    call("response-pending", "thread-1", "get_issue"),
  );
  await tick();
  (listener as ((message: CodexInboundMessage) => void) | null)?.(
    call("over-budget-during-response", "thread-1", "get_issue"),
  );
  (listener as ((message: CodexInboundMessage) => void) | null)?.({
    kind: "turn_completed",
    thread_id: "thread-1",
    turn_id: "turn-1",
    status: "completed",
    output: {},
  });
  const responseWasInFlight = bridge.hasEffectInFlight();
  const budgetOverlapped = bridge.didBudgetOverlapEffect();
  const terminalOverlapped = bridge.didTerminalOverlapEffect();
  (resolveResponse as (() => void) | null)?.();
  await bridge.waitForIdle();
  bridge();

  assert.equal(responseWasInFlight, true);
  assert.equal(budgetOverlapped, true);
  assert.equal(terminalOverlapped, true);
});

test("dynamic tool bridge keeps a soft denial in flight through response delivery", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  let resolveResponse: (() => void) | null = null;
  const bridge = bindDynamicTools({
    onNotification: (next) => { listener = next; return () => { listener = null; }; },
    respondToTool: (id) => id === "soft-denial-pending"
      ? new Promise<void>((resolve) => { resolveResponse = resolve; })
      : Promise.resolve(),
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-1",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:1"),
    max_calls: 1,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => Promise.reject(new RootToolCallError("acceptance_unknown")),
    }],
    log: () => undefined,
    on_fatal: () => undefined,
  });

  (listener as ((message: CodexInboundMessage) => void) | null)?.(
    call("soft-denial-pending", "thread-1", "get_issue"),
  );
  await tick();
  (listener as ((message: CodexInboundMessage) => void) | null)?.(
    call("over-budget-during-soft-denial", "thread-1", "get_issue"),
  );
  (listener as ((message: CodexInboundMessage) => void) | null)?.({
    kind: "turn_completed",
    thread_id: "thread-1",
    turn_id: "turn-1",
    status: "completed",
    output: {},
  });
  const responseWasInFlight = bridge.hasEffectInFlight();
  const budgetOverlapped = bridge.didBudgetOverlapEffect();
  const terminalOverlapped = bridge.didTerminalOverlapEffect();
  (resolveResponse as (() => void) | null)?.();
  await bridge.waitForIdle();
  bridge();

  assert.equal(responseWasInFlight, true);
  assert.equal(budgetOverlapped, true);
  assert.equal(terminalOverlapped, true);
});

test("dynamic tool bridge seals before a same-chunk call following a hard capability denial", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  let executions = 0;
  const responses: Array<[string, boolean]> = [];
  const close = bindDynamicTools({
    onNotification: (next) => { listener = next; return () => { listener = null; }; },
    respondToTool: (id, success) => { responses.push([id, success]); return Promise.resolve(); },
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-1",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:1"),
    max_calls: 2,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => {
        executions += 1;
        return Promise.resolve({ output: { issue: null } });
      },
    }],
    log: () => undefined,
    on_fatal: () => undefined,
  });

  (listener as ((message: CodexInboundMessage) => void) | null)?.(
    call("unknown-before-valid", "thread-1", "unknown_tool"),
  );
  (listener as ((message: CodexInboundMessage) => void) | null)?.(
    call("valid-after-unknown", "thread-1", "get_issue"),
  );
  await tick();

  assert.equal(executions, 0);
  assert.deepEqual(responses, [["unknown-before-valid", false]]);
  close();
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

test("a stale turn cannot poison exact-turn call deduplication", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const responses: Array<[string, boolean, string]> = [];
  let executions = 0;
  bindDynamicTools({
    onNotification: (next) => { listener = next; return () => undefined; },
    respondToTool: (id, success, text) => {
      responses.push([id, success, text]);
      return Promise.resolve();
    },
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-current",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:1"),
    max_calls: 2,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => {
        executions += 1;
        return Promise.resolve({ output: { issue: null } });
      },
    }],
    log: () => undefined,
    on_fatal: () => undefined,
  });

  const stale = {
    ...call("stale-request", "thread-1", "get_issue"),
    turn_id: "turn-old",
    call_id: "turn-scoped-call",
  };
  (listener as ((message: CodexInboundMessage) => void) | null)?.(stale);
  (listener as ((message: CodexInboundMessage) => void) | null)?.(stale);
  await tick();
  (listener as ((message: CodexInboundMessage) => void) | null)?.({
    ...call("current-request", "thread-1", "get_issue"),
    turn_id: "turn-current",
    call_id: "turn-scoped-call",
  });
  await tick();

  assert.equal(executions, 1);
  assert.deepEqual(responses.map(([id, success, text]) => [
    id,
    success,
    success ? "accepted" : (JSON.parse(text) as { code?: unknown }).code,
  ]), [
    ["stale-request", false, "canceled"],
    ["current-request", true, "accepted"],
  ]);
});

test("dynamic tool bridge bounds unique stale-turn requests independently", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const responses: Array<[string, boolean]> = [];
  const fatals: string[] = [];
  const close = bindDynamicTools({
    onNotification: (next) => { listener = next; return () => { listener = null; }; },
    respondToTool: (id, success) => { responses.push([id, success]); return Promise.resolve(); },
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-current",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:stale-flood"),
    max_calls: 2,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => Promise.resolve({ output: { issue: null } }),
    }],
    log: () => undefined,
    on_fatal: (reason) => fatals.push(reason),
  });

  for (let index = 0; index < 2; index += 1) {
    (listener as ((message: CodexInboundMessage) => void) | null)?.({
      ...call(`stale-${index}`, "thread-1", "get_issue"),
      turn_id: "turn-old",
    });
  }
  await tick();
  for (let index = 2; index < 32; index += 1) {
    (listener as ((message: CodexInboundMessage) => void) | null)?.({
      ...call(`stale-${index}`, "thread-1", "get_issue"),
      turn_id: "turn-old",
    });
  }
  await tick();

  assert.deepEqual(responses, [["stale-0", false], ["stale-1", false]]);
  assert.deepEqual(fatals, ["invalid_contract"]);
  assert.equal(listener, null);
  close();
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

test("dynamic tool bridge coalesces unique calls after the first over-budget denial", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const responses: Array<[string, boolean, string]> = [];
  const logs: RootToolBridgeLog[] = [];
  let executions = 0;
  let budgetSignals = 0;
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
    correlation_id: parseCorrelationId("corr:turn:budget-flood"),
    max_calls: 1,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => { executions += 1; return Promise.resolve({ output: { issue: null } }); },
    }],
    log: (entry) => logs.push(entry),
    on_fatal: () => undefined,
    on_budget_exhausted: () => { budgetSignals += 1; },
  });

  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("accepted", "thread-1", "get_issue"));
  await tick();
  for (let index = 0; index < 32; index += 1) {
    (listener as ((message: CodexInboundMessage) => void) | null)?.(
      call(`over-budget-${index}`, "thread-1", "get_issue"),
    );
  }
  await tick();

  assert.equal(executions, 1);
  assert.deepEqual(responses.map(([id, success]) => [id, success]), [
    ["accepted", true],
    ["over-budget-0", false],
  ]);
  assert.equal(budgetSignals, 1);
  assert.equal(logs.filter(({ event }) => event === "root_tool_call_denied").length, 1);
});

test("dynamic tool bridge reports exact-turn budget and contract violations to its owner", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const budgetSignals: string[] = [];
  const denialSignals: string[] = [];
  bindDynamicTools({
    onNotification: (next) => { listener = next; return () => undefined; },
    respondToTool: () => Promise.resolve(),
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-1",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:1"),
    max_calls: 1,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: (value) => value === "invalid"
        ? Promise.reject(new RootToolCallError("invalid_contract"))
        : Promise.resolve({ output: { issue: null } }),
    }],
    log: () => undefined,
    on_fatal: () => undefined,
    on_budget_exhausted: () => budgetSignals.push("budget"),
    on_denied: (reason) => denialSignals.push(reason),
  });

  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("accepted", "thread-1", "get_issue"));
  await tick();
  (listener as ((message: CodexInboundMessage) => void) | null)?.(call("over-budget", "thread-1", "get_issue"));
  await tick();
  assert.deepEqual(budgetSignals, ["budget"]);
  assert.deepEqual(denialSignals, []);

  let contractListener: ((message: CodexInboundMessage) => void) | null = null;
  const contractDenialSignals: string[] = [];
  bindDynamicTools({
    onNotification: (next) => { contractListener = next; return () => undefined; },
    respondToTool: () => Promise.resolve(),
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-current",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:2"),
    max_calls: 2,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => Promise.reject(new RootToolCallError("invalid_contract")),
    }],
    log: () => undefined,
    on_fatal: () => undefined,
    on_budget_exhausted: () => undefined,
    on_denied: (reason) => contractDenialSignals.push(reason),
  });
  (contractListener as ((message: CodexInboundMessage) => void) | null)?.({
    ...call("stale", "thread-1", "get_issue"),
    turn_id: "turn-old",
  });
  await tick();
  (contractListener as ((message: CodexInboundMessage) => void) | null)?.({
    ...call("invalid", "thread-1", "get_issue", "invalid"),
    turn_id: "turn-current",
  });
  await tick();
  assert.deepEqual(contractDenialSignals, ["invalid_contract"]);
});

test("throwing log observers cannot alter accepted, denied, or budget responses", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const responses: Array<[string, boolean, string]> = [];
  const denials: string[] = [];
  const fatals: string[] = [];
  let budgetExhaustions = 0;
  const closeBudget = bindDynamicTools({
    onNotification: (next) => {
      listener = next;
      return () => { listener = null; };
    },
    respondToTool: (id, success, text) => {
      responses.push([id, success, text]);
      return Promise.resolve();
    },
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-1",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:throwing-log"),
    max_calls: 1,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => Promise.resolve({ output: { issue: null } }),
    }],
    log: () => { throw new Error("log-observer-secret"); },
    on_fatal: (reason) => fatals.push(reason),
    on_budget_exhausted: () => { budgetExhaustions += 1; },
    on_denied: (reason) => denials.push(reason),
  });

  (listener as ((message: CodexInboundMessage) => void) | null)?.(
    call("accepted-with-throwing-log", "thread-1", "get_issue"),
  );
  await tick();
  (listener as ((message: CodexInboundMessage) => void) | null)?.(
    call("budget-with-throwing-log", "thread-1", "get_issue"),
  );
  await tick();
  closeBudget();

  const closeDenied = bindDynamicTools({
    onNotification: (next) => {
      listener = next;
      return () => { listener = null; };
    },
    respondToTool: (id, success, text) => {
      responses.push([id, success, text]);
      return Promise.resolve();
    },
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-2",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:throwing-log:denied"),
    max_calls: 1,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => Promise.reject(new RootToolCallError("stale_generation")),
    }],
    log: () => { throw new Error("log-observer-secret"); },
    on_fatal: (reason) => fatals.push(reason),
    on_budget_exhausted: () => { budgetExhaustions += 1; },
    on_denied: (reason) => denials.push(reason),
  });
  (listener as ((message: CodexInboundMessage) => void) | null)?.({
    ...call("denied-with-throwing-log", "thread-1", "get_issue"),
    turn_id: "turn-2",
  });
  await tick();

  assert.deepEqual(responses.map(([id, success, text]) => [
    id,
    success,
    success ? "accepted" : (JSON.parse(text) as { code?: unknown }).code,
  ]), [
    ["accepted-with-throwing-log", true, "accepted"],
    ["budget-with-throwing-log", false, "invalid_contract"],
    ["denied-with-throwing-log", false, "stale_generation"],
  ]);
  assert.deepEqual(denials, ["stale_generation"]);
  assert.equal(budgetExhaustions, 1);
  assert.deepEqual(fatals, []);
  closeDenied();
  assert.equal(listener, null);
});

test("a throwing log observer cannot prevent fatal closure and notification", async () => {
  let listener: ((message: CodexInboundMessage) => void) | null = null;
  const fatals: string[] = [];
  let executions = 0;
  const close = bindDynamicTools({
    onNotification: (next) => {
      listener = next;
      return () => { listener = null; };
    },
    respondToTool: () => Promise.resolve(),
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-1",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:fatal-log"),
    max_calls: 2,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => {
        executions += 1;
        throw new Error("provider-secret");
      },
    }],
    log: () => { throw new Error("log-observer-secret"); },
    on_fatal: (reason) => fatals.push(reason),
  });

  (listener as ((message: CodexInboundMessage) => void) | null)?.(
    call("fatal-with-throwing-log", "thread-1", "get_issue"),
  );
  await tick();

  assert.equal(executions, 1);
  assert.deepEqual(fatals, ["boundary_unavailable"]);
  assert.equal(listener, null);
  close();
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

  bindDynamicTools({
    onNotification: (next) => { listener = next; return () => undefined; },
    respondToTool: (id, success, text) => { responses.push([id, success, text]); return Promise.resolve(); },
  }, {
    thread_id: parseThreadId("thread-1"),
    turn_id: "turn-2",
    target: { root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1) },
    correlation_id: parseCorrelationId("corr:turn:2"),
    max_calls: 1,
    bindings: [{
      spec: { type: "function", name: "get_issue", description: "Read", inputSchema: { type: "object" } },
      execute: () => { throw new Error("provider token secret"); },
    }],
    log: (entry) => logs.push(entry),
    on_fatal: (reason) => fatals.push(reason),
  });
  (listener as ((message: CodexInboundMessage) => void) | null)?.({
    ...call("failed", "thread-1", "get_issue", { authorization: "Bearer provider-token" }),
    turn_id: "turn-2",
  });
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
