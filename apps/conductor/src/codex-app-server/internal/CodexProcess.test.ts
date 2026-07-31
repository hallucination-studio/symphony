import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { parseCorrelationId } from "../../contracts/identity.js";
import { MAX_ROOT_TOOL_RESPONSE_BYTES } from "../../runtime/RootToolBoundary.js";
import { CodexProcess, testCodexOptions, type CodexSpawner, type SpawnedCodexProcess } from "./CodexProcess.js";
import { CodexThread } from "./CodexThread.js";
import { JsonlFrameDecoder } from "./JsonlPeer.js";

interface FakeServer extends SpawnedCodexProcess {
  readonly input: PassThrough;
  readonly output: PassThrough;
  send(message: Record<string, unknown>): void;
  sendMany(messages: readonly Record<string, unknown>[]): void;
}

function fakeSpawner(
  handle: (message: Record<string, unknown>, server: FakeServer) => void,
  autoExitOnKill = true,
  runningOverride?: () => boolean,
) {
  let server: FakeServer | undefined;
  let kills = 0;
  let running = true;
  const signals: NodeJS.Signals[] = [];
  const requests: Record<string, unknown>[] = [];
  const spawner: CodexSpawner = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    events.once("exit", () => { running = false; });
    const decoder = new JsonlFrameDecoder(MAX_ROOT_TOOL_RESPONSE_BYTES * 2 + 1024);
    server = {
      stdin: input,
      stdout: output,
      stderr,
      events,
      input,
      output,
      isRunning: () => runningOverride?.() ?? running,
      kill: (signal) => {
        kills += 1;
        signals.push(signal);
        if (autoExitOnKill) queueMicrotask(() => events.emit("exit", 0, null));
        return true;
      },
      send: (message) => output.write(`${JSON.stringify(message)}\n`),
      sendMany: (messages) => output.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n"),
    };
    input.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        requests.push(message);
        handle(message, server as FakeServer);
      }
    });
    return server as FakeServer;
  };
  return {
    spawner,
    requests,
    server: () => server as FakeServer,
    kills: () => kills,
    signals: () => signals,
  };
}

function initializeResponse(message: Record<string, unknown>, server: FakeServer): boolean {
  if (message.method !== "initialize") return false;
  server.send({
    id: message.id,
    result: { codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos", userAgent: "codex-test" },
  });
  return true;
}

test("Codex process initializes one experimental dynamic-tool protocol", async () => {
  const fake = fakeSpawner((message, server) => { initializeResponse(message, server); });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const initialize = fake.requests[0];
  assert.equal(initialize?.method, "initialize");
  const params = initialize?.params as {
    capabilities?: { experimentalApi?: boolean; optOutNotificationMethods?: readonly string[] };
  };
  assert.equal(params.capabilities?.experimentalApi, true);
  assert.equal(params.capabilities?.optOutNotificationMethods?.includes("turn/started"), false);
  assert.equal(fake.requests[1]?.method, "initialized");
  await process.shutdown();
});

test("invalid initialization closes the spawned private process", async () => {
  const fake = fakeSpawner((message, server) => {
    if (message.method === "initialize") server.send({ id: message.id, result: { codexHome: "/tmp/codex" } });
  });

  await assert.rejects(
    CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner),
    /invalid_codex_initialize_response/u,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.kills(), 1);
});

test("initialization failure reports when the spawned process cannot be terminated", async () => {
  const fake = fakeSpawner((message, server) => {
    if (message.method === "initialize") server.send({ id: message.id, result: { codexHome: "/tmp/codex" } });
  }, false);

  await assert.rejects(
    CodexProcess.start({
      ...testCodexOptions("/tmp/codex"),
      shutdownTimeoutMs: 2,
    }, fake.spawner),
    /codex_process_termination_failed/u,
  );
  assert.deepEqual(fake.signals(), ["SIGTERM", "SIGKILL"]);
});

test("concurrent shutdown callers wait for the same process termination", async () => {
  const fake = fakeSpawner((message, server) => { initializeResponse(message, server); }, false);
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);

  const first = process.shutdown();
  let secondSettled = false;
  const second = process.shutdown().finally(() => { secondSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);

  fake.server().events.emit("exit", 0, null);
  await Promise.all([first, second]);
  assert.equal(secondSettled, true);
  assert.equal(fake.kills(), 1);
});

test("forced shutdown remains pending until process exit", async () => {
  const fake = fakeSpawner((message, server) => { initializeResponse(message, server); }, false);
  const process = await CodexProcess.start({
    ...testCodexOptions("/tmp/codex"),
    shutdownTimeoutMs: 5,
  }, fake.spawner);

  let settled = false;
  const stopping = process.shutdown().finally(() => { settled = true; });
  while (fake.signals().length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(fake.signals(), ["SIGTERM", "SIGKILL"]);
  assert.equal(settled, false);

  fake.server().events.emit("exit", 0, null);
  await stopping;
  assert.equal(settled, true);
});

test("shutdown fails closed when the process survives forced termination", async () => {
  const fake = fakeSpawner((message, server) => { initializeResponse(message, server); }, false);
  const process = await CodexProcess.start({
    ...testCodexOptions("/tmp/codex"),
    shutdownTimeoutMs: 2,
  }, fake.spawner);

  await assert.rejects(process.shutdown(), /codex_process_termination_failed/u);
  assert.deepEqual(fake.signals(), ["SIGTERM", "SIGKILL"]);
});

test("failure-driven shutdown stays joinable until process exit", async () => {
  const fake = fakeSpawner((message, server) => { initializeResponse(message, server); }, false);
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);

  fake.server().output.end();
  while (fake.signals().length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  let settled = false;
  const stopping = process.shutdown().finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(fake.signals(), ["SIGKILL"]);

  fake.server().events.emit("exit", 0, null);
  await stopping;
  assert.equal(settled, true);
});

test("local-only shutdown waits for the detached process group after leader exit", async () => {
  let groupRunning = true;
  const fake = fakeSpawner(
    (message, server) => { initializeResponse(message, server); },
    false,
    () => groupRunning,
  );
  const process = await CodexProcess.start({
    ...testCodexOptions("/tmp/codex"),
    shutdownTimeoutMs: 5,
  }, fake.spawner);

  let settled = false;
  const stopping = process.shutdown().finally(() => { settled = true; });
  fake.server().events.emit("exit", 0, null);
  const signalDeadline = performance.now() + 50;
  while (fake.signals().length < 2 && performance.now() < signalDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(fake.signals(), ["SIGTERM", "SIGKILL"]);
  assert.equal(settled, false);

  groupRunning = false;
  await stopping;
  assert.equal(settled, true);
});

test("unexpected leader exit terminates the remaining detached process group", async () => {
  let groupRunning = true;
  const fake = fakeSpawner(
    (message, server) => { initializeResponse(message, server); },
    false,
    () => groupRunning,
  );
  const process = await CodexProcess.start({
    ...testCodexOptions("/tmp/codex"),
    shutdownTimeoutMs: 5,
  }, fake.spawner);

  fake.server().events.emit("exit", 1, null);
  const signalDeadline = performance.now() + 50;
  while (fake.signals().length === 0 && performance.now() < signalDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(fake.signals(), ["SIGKILL"]);

  let settled = false;
  const stopping = process.shutdown().finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  groupRunning = false;
  await stopping;
  assert.equal(settled, true);
});

test("native local-only shutdown removes descendants after the process-group leader exits", {
  skip: process.platform === "win32",
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-process-group-"));
  const codexHome = path.join(temporary, "codex-home");
  const workspaceRoot = path.join(temporary, "workspace");
  const pidFile = path.join(temporary, "pids");
  const executable = path.join(temporary, "codex-stub.cjs");
  let groupLeaderPid: number | undefined;
  let descendantPid: number | undefined;
  try {
    await Promise.all([mkdir(codexHome), mkdir(workspaceRoot)]);
    const descendantSource = [
      "process.on('SIGTERM', () => undefined);",
      "process.stdout.write('ready\\n');",
      "setInterval(() => undefined, 1_000);",
    ].join("");
    const stubSource = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
  env: { PATH: process.env.PATH },
  stdio: ["ignore", "pipe", "ignore"],
});
writeFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n" + descendant.pid + "\\n", "utf8");
let input = "";
let ready = false;
const pending = [];
function respond(line) {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: message.id, result: { codexHome: "invalid" } }) + "\\n");
}
function drain() {
  while (ready && pending.length > 0) respond(pending.shift());
}
descendant.stdout.once("data", () => { ready = true; drain(); });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.length > 0) pending.push(line);
  }
  drain();
});
setInterval(() => undefined, 1_000);
`;
    await writeFile(executable, stubSource, { mode: 0o700 });

    await assert.rejects(CodexProcess.start({
      ...testCodexOptions(codexHome),
      executable,
      shutdownTimeoutMs: 25,
      capabilityMode: {
        kind: "local_only",
        workspaceRoot,
        deploymentPolicy: {
          managedMcpDenyAll: true,
          managedRemoteControlDisabled: true,
          remoteEnvironmentsAbsent: true,
          configurationImmutable: true,
        },
      },
    }), /invalid_codex_initialize_response/u);

    [groupLeaderPid, descendantPid] = (await readFile(pidFile, "utf8"))
      .trim()
      .split("\n")
      .map((value) => Number.parseInt(value, 10));
    assert.ok(Number.isSafeInteger(groupLeaderPid));
    assert.ok(descendantPid !== undefined && Number.isSafeInteger(descendantPid));

    const deadline = performance.now() + 2_000;
    let descendantRunning = true;
    while (descendantRunning && performance.now() < deadline) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        descendantRunning = false;
      }
    }
    assert.equal(descendantRunning, false);
  } finally {
    if (groupLeaderPid !== undefined) {
      try { process.kill(-groupLeaderPid, "SIGKILL"); } catch { /* already terminated */ }
    }
    await rm(temporary, { recursive: true, force: true });
  }
});

test("turn-start activation observes a coalesced first tool call before the caller resumes", async () => {
  const toolCalls: string[] = [];
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-race" } } });
    } else if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-race" } } },
        { method: "turn/started", params: { threadId: "thread-race", turn: { id: "turn-race", status: "inProgress", items: [], error: null } } },
        {
          id: "tool-request-race",
          method: "item/tool/call",
          params: {
            threadId: "thread-race",
            turnId: "turn-race",
            callId: "call-race",
            tool: "get_issue",
            arguments: {},
          },
        },
      ]);
    } else if (message.id === "tool-request-race") {
      server.send({
        method: "turn/completed",
        params: {
          threadId: "thread-race",
          turn: {
            id: "turn-race", status: "completed", error: null,
            items: [{ id: "answer", type: "agentMessage", text: '{"outcome":"quiescent"}' }],
          },
        },
      });
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:race"),
    access: { kind: "read_only" },
  });
  let unsubscribe: () => void = () => undefined;
  const result = await thread.turn(
    "race",
    parseCorrelationId("turn:race"),
    2_000,
    undefined,
    (turnId) => {
      assert.equal(turnId, "turn-race");
      unsubscribe = process.onNotification((notification) => {
        if (notification.kind !== "tool_call") return;
        toolCalls.push(notification.call_id);
        void process.respondToTool(notification.request_id, true, "accepted");
      });
    },
  );

  assert.deepEqual(toolCalls, ["call-race"]);
  assert.equal(result.status, "completed");
  unsubscribe();
  thread.close();
  await process.shutdown();
});

test("turn completion accepts an echoed dynamic-tool response above the default inbound frame limit", async () => {
  const echoedResponse = "x".repeat(1024 * 1024 + 1);
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-large-echo" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-large-echo" } } });
      server.send({
        method: "turn/completed",
        params: {
          threadId: "thread-large-echo",
          turn: {
            id: "turn-large-echo", status: "completed", error: null,
            items: [
              {
                id: "tool-large-echo", type: "dynamicToolCall", tool: "get_issue", arguments: {},
                status: "completed", contentItems: [{ type: "inputText", text: echoedResponse }], success: true,
              },
              { id: "answer", type: "agentMessage", text: '{"outcome":"quiescent"}' },
            ],
          },
        },
      });
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:large-echo"),
    access: { kind: "read_only" },
  });

  assert.deepEqual(
    await thread.turn("large echo", parseCorrelationId("turn:large-echo"), 2_000),
    { turnId: "turn-large-echo", status: "completed", output: { outcome: "quiescent" } },
  );
  thread.close();
  await process.shutdown();
});

test("a turn awaiting its start response still excludes a concurrent turn", async () => {
  let pendingStart: Record<string, unknown> | undefined;
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-serial" } } });
    } else if (message.method === "turn/start") {
      pendingStart = message;
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:serial"),
    access: { kind: "read_only" },
  });
  const first = thread.turn("first", parseCorrelationId("turn:serial:1"), 2_000);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    thread.turn("second", parseCorrelationId("turn:serial:2"), 2_000),
    /codex_turn_already_active/u,
  );
  assert.equal(fake.requests.filter(({ method }) => method === "turn/start").length, 1);
  fake.server().send({ id: pendingStart?.id, result: { turn: { id: "turn-serial-1" } } });
  fake.server().send({
    method: "turn/completed",
    params: {
      threadId: "thread-serial",
      turn: {
        id: "turn-serial-1", status: "completed", error: null,
        items: [{ id: "answer", type: "agentMessage", text: "{}" }],
      },
    },
  });
  await first;
  thread.close();
  await process.shutdown();
});

test("process loss after turn start rejects the active turn without waiting for its timer", async () => {
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-loss" } } });
    } else if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-loss" } } },
        { method: "turn/started", params: { threadId: "thread-loss", turn: { id: "turn-loss", status: "inProgress", items: [], error: null } } },
      ]);
      setImmediate(() => server.events.emit("exit", 2, null));
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:loss:active"),
    access: { kind: "read_only" },
  });

  await assert.rejects(
    thread.turn("loss", parseCorrelationId("turn:loss:active"), 5_000),
    /codex_process_exited/u,
  );
  thread.close();
});

test("a timed-out turn retains its identity long enough to interrupt", async () => {
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-timeout" } } });
    } else if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-timeout" } } },
        { method: "turn/started", params: { threadId: "thread-timeout", turn: { id: "turn-timeout", status: "inProgress", items: [], error: null } } },
      ]);
    } else if (message.method === "turn/interrupt") {
      server.send({ id: message.id, result: {} });
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:timeout:active"),
    access: { kind: "read_only" },
  });
  await assert.rejects(
    thread.turn("timeout", parseCorrelationId("turn:timeout:active"), 10),
    /codex_turn_timed_out/u,
  );
  await thread.interrupt(parseCorrelationId("interrupt:timeout"));
  const interrupt = fake.requests.find(({ method }) => method === "turn/interrupt");
  assert.deepEqual(interrupt?.params, { threadId: "thread-timeout", turnId: "turn-timeout" });
  thread.close();
  await process.shutdown();
});

test("the turn deadline includes start acknowledgement and fences late activation", async () => {
  let pendingStart: Record<string, unknown> | undefined;
  const activations: string[] = [];
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-start-timeout" } } });
    } else if (message.method === "turn/start") {
      pendingStart = message;
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:start-timeout"),
    access: { kind: "read_only" },
  });

  await assert.rejects(
    thread.turn(
      "timeout before acknowledgement",
      parseCorrelationId("turn:start-timeout"),
      10,
      undefined,
      (turnId) => activations.push(turnId),
    ),
    /codex_turn_timed_out/u,
  );
  fake.server().sendMany([
    { id: pendingStart?.id as string, result: { turn: { id: "turn-start-timeout" } } },
    {
      method: "turn/started",
      params: {
        threadId: "thread-start-timeout",
        turn: { id: "turn-start-timeout", status: "inProgress", items: [], error: null },
      },
    },
  ]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(activations, []);
  thread.close();
  await process.shutdown();
});

test("an early completion received after the absolute deadline cannot complete the turn", async () => {
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-expired-early" } } });
    } else if (message.method === "turn/start") {
      const blockedUntil = performance.now() + 20;
      while (performance.now() < blockedUntil) {
        // Keep the event loop inside the request handler so only the absolute deadline can fence this response.
      }
      server.sendMany([
        {
          method: "turn/completed",
          params: {
            threadId: "thread-expired-early",
            turn: {
              id: "turn-expired-early", status: "completed", error: null,
              items: [{ id: "answer", type: "agentMessage", text: "{}" }],
            },
          },
        },
        { id: message.id as string, result: { turn: { id: "turn-expired-early" } } },
      ]);
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:expired-early"),
    access: { kind: "read_only" },
  });

  await assert.rejects(
    thread.turn("expired early completion", parseCorrelationId("turn:expired-early"), 5),
    /codex_turn_timed_out/u,
  );
  thread.close();
  await process.shutdown();
});

test("a normal completion received after the absolute deadline cannot complete the turn", async () => {
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-expired-normal" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-expired-normal" } } });
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:expired-normal"),
    access: { kind: "read_only" },
  });
  const timeoutMs = 50;
  const deadline = performance.now() + timeoutMs;
  const turn = thread.turn("expired normal completion", parseCorrelationId("turn:expired-normal"), timeoutMs);
  const timedOut = assert.rejects(turn, /codex_turn_timed_out/u);
  await new Promise((resolve) => setImmediate(resolve));
  while (performance.now() <= deadline + 20) {
    // Keep the timeout callback queued while completion crosses the absolute deadline.
  }
  fake.server().send({
    method: "turn/completed",
    params: {
      threadId: "thread-expired-normal",
      turn: {
        id: "turn-expired-normal", status: "completed", error: null,
        items: [{ id: "answer", type: "agentMessage", text: "{}" }],
      },
    },
  });

  await timedOut;
  thread.close();
  await process.shutdown();
});

test("equal request and turn deadlines report the turn timeout and retire an unacknowledged process", async () => {
  let pendingStart: Record<string, unknown> | undefined;
  const activations: string[] = [];
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-equal-timeout" } } });
    } else if (message.method === "turn/start") {
      pendingStart = message;
    }
  });
  const options = { ...testCodexOptions("/tmp/codex"), requestTimeoutMs: 10 };
  const process = await CodexProcess.start(options, fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:equal-timeout"),
    access: { kind: "read_only" },
  });

  await assert.rejects(
    thread.turn(
      "equal timeout",
      parseCorrelationId("turn:equal-timeout"),
      options.requestTimeoutMs,
      undefined,
      (turnId) => activations.push(turnId),
    ),
    /codex_turn_timed_out/u,
  );
  fake.server().sendMany([
    { id: pendingStart?.id as string, result: { turn: { id: "turn-equal-timeout" } } },
    {
      method: "turn/started",
      params: {
        threadId: "thread-equal-timeout",
        turn: { id: "turn-equal-timeout", status: "inProgress", items: [], error: null },
      },
    },
  ]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fake.kills(), 1);
  assert.deepEqual(activations, []);
  await assert.rejects(
    process.request("thread/start", {}, parseCorrelationId("thread:after-equal-timeout")),
    /codex_process_closed/u,
  );
  thread.close();
});

test("closing a turn before start acknowledgement settles it and fences late activation", async () => {
  let pendingStart: Record<string, unknown> | undefined;
  const activations: string[] = [];
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-start-cancel" } } });
    } else if (message.method === "turn/start") {
      pendingStart = message;
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:start-cancel"),
    access: { kind: "read_only" },
  });
  const turn = thread.turn(
    "cancel before acknowledgement",
    parseCorrelationId("turn:start-cancel"),
    2_000,
    undefined,
    (turnId) => activations.push(turnId),
  );
  await new Promise((resolve) => setImmediate(resolve));

  thread.close();
  await assert.rejects(turn, /codex_thread_closed/u);
  fake.server().sendMany([
    { id: pendingStart?.id as string, result: { turn: { id: "turn-start-cancel" } } },
    {
      method: "turn/started",
      params: {
        threadId: "thread-start-cancel",
        turn: { id: "turn-start-cancel", status: "inProgress", items: [], error: null },
      },
    },
  ]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(activations, []);
  await process.shutdown();
});

test("dynamic-only threads disable built-in tools and transcript persistence", async () => {
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:root"),
    access: { kind: "read_only" },
    toolMode: "dynamic_only",
  });
  const request = fake.requests.find(({ method }) => method === "thread/start");
  assert.deepEqual(request?.params, {
    cwd: "/tmp",
    approvalPolicy: "never",
    sandbox: "read-only",
    dynamicTools: [],
    ephemeral: true,
    environments: [],
    config: {
      web_search: "disabled",
      features: {
        apps: false,
        goals: false,
        hooks: false,
        memories: false,
        multi_agent: false,
        remote_plugin: false,
        shell_snapshot: false,
        shell_tool: false,
        unified_exec: false,
      },
    },
  });
  thread.close();
  await process.shutdown();
});

test("Codex thread cancellation is correlated and late old completion is fenced", async () => {
  let turn = 0;
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-1" } } });
    } else if (message.method === "turn/start") {
      turn += 1;
      server.send({ id: message.id, result: { turn: { id: `turn-${turn}` } } });
    } else if (message.method === "turn/interrupt") {
      server.send({ id: message.id, result: {} });
      server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [], error: null } } });
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:1"),
    access: { kind: "read_only" },
  });
  const first = thread.turn("first", parseCorrelationId("turn:1"), 2_000);
  await new Promise((resolve) => setImmediate(resolve));
  await thread.interrupt(parseCorrelationId("interrupt:1"));
  assert.equal((await first).status, "interrupted");

  const second = thread.turn("second", parseCorrelationId("turn:2"), 2_000);
  await new Promise((resolve) => setImmediate(resolve));
  fake.server().send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [{ id: "old", type: "agentMessage", text: "{}" }], error: null } } });
  fake.server().send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed", items: [{ id: "new", type: "agentMessage", text: '{"accepted":true}' }], error: null } } });
  assert.deepEqual(await second, { turnId: "turn-2", status: "completed", output: { accepted: true } });
  thread.close();
  await process.shutdown();
});

test("Codex turn sends the one native output schema and returns its structured final message", async () => {
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-schema" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-schema" } } });
      server.send({
        method: "turn/completed",
        params: {
          threadId: "thread-schema",
          turn: {
            id: "turn-schema", status: "completed", error: null,
            items: [{ id: "answer", type: "agentMessage", text: '{"answer":"yes"}' }],
          },
        },
      });
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp", tools: [], correlationId: parseCorrelationId("thread:schema"),
    access: { kind: "read_only" },
  });
  const outputSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  assert.deepEqual(
    await thread.turn("structured", parseCorrelationId("turn:schema"), 2_000, outputSchema),
    { turnId: "turn-schema", status: "completed", output: { answer: "yes" } },
  );
  const request = fake.requests.find(({ method }) => method === "turn/start");
  assert.deepEqual((request?.params as { outputSchema?: unknown }).outputSchema, outputSchema);
  thread.close();
  await process.shutdown();
});

test("Work thread and every turn bind workspace write authority to one explicit worktree", async () => {
  const fake = fakeSpawner((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-work" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-work" } } });
      server.send({
        method: "turn/completed",
        params: {
          threadId: "thread-work",
          turn: {
            id: "turn-work", status: "completed", error: null,
            items: [{ id: "answer", type: "agentMessage", text: '{"outcome":"completed"}' }],
          },
        },
      });
    }
  });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: "/tmp/root-worktree",
    tools: [],
    correlationId: parseCorrelationId("thread:work"),
    access: { kind: "workspace_write", writableRoot: "/tmp/root-worktree", networkAccess: true },
  });
  await thread.turn("work", parseCorrelationId("turn:work"), 2_000);

  const threadStart = fake.requests.find(({ method }) => method === "thread/start");
  assert.deepEqual(threadStart?.params, {
    cwd: "/tmp/root-worktree",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    dynamicTools: [],
  });
  const turnStart = fake.requests.find(({ method }) => method === "turn/start");
  assert.deepEqual(turnStart?.params, {
    threadId: "thread-work",
    input: [{ type: "text", text: "work" }],
    cwd: "/tmp/root-worktree",
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/tmp/root-worktree"],
      networkAccess: true,
    },
  });
  thread.close();
  await process.shutdown();
});

test("request timeout closes the generation and rejects late output", async () => {
  const fake = fakeSpawner((message, server) => { initializeResponse(message, server); });
  const options = { ...testCodexOptions("/tmp/codex"), requestTimeoutMs: 10 };
  const process = await CodexProcess.start(options, fake.spawner);
  await assert.rejects(
    process.request("thread/start", {}, parseCorrelationId("thread:timeout")),
    /codex_request_timed_out/u,
  );
  const timedOut = fake.requests.find(({ method }) => method === "thread/start");
  fake.server().send({ id: timedOut?.id, result: { thread: { id: "late-thread" } } });
  await assert.rejects(
    process.request("thread/start", {}, parseCorrelationId("thread:new")),
    /codex_process_closed/u,
  );
});

test("process loss rejects pending work with a sanitized code", async () => {
  const fake = fakeSpawner((message, server) => { initializeResponse(message, server); });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const pending = process.request("thread/start", {}, parseCorrelationId("thread:loss"));
  fake.server().events.emit("exit", 2, null);
  await assert.rejects(pending, (error: Error) => {
    assert.equal(error.message, "codex_process_exited");
    assert.equal(error.message.includes("thread:loss"), false);
    return true;
  });
});

test("tool response uses the official request id and bounded content shape", async () => {
  const fake = fakeSpawner((message, server) => { initializeResponse(message, server); });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  await process.respondToTool("tool-request-1", true, "accepted");
  const response = fake.requests.at(-1);
  assert.deepEqual(response, {
    id: "tool-request-1",
    result: { success: true, contentItems: [{ type: "inputText", text: "accepted" }] },
  });
  const large = "x".repeat(100_000);
  await process.respondToTool("tool-request-2", true, large);
  const largeResponse = fake.requests.at(-1) as {
    result?: { contentItems?: Array<{ text?: unknown }> };
  };
  assert.equal(largeResponse.result?.contentItems?.[0]?.text, large);
  await process.shutdown();
});

test("tool response accepts the exact byte limit and rejects one byte above it", { timeout: 15_000 }, async () => {
  const fake = fakeSpawner((message, server) => { initializeResponse(message, server); });
  const process = await CodexProcess.start(testCodexOptions("/tmp/codex"), fake.spawner);
  const exactByteLimit = "\u00e9".repeat(MAX_ROOT_TOOL_RESPONSE_BYTES / 2);
  assert.equal(Buffer.byteLength(exactByteLimit, "utf8"), MAX_ROOT_TOOL_RESPONSE_BYTES);
  await process.respondToTool("tool-request-max", true, exactByteLimit);
  const exactResponse = fake.requests.at(-1) as {
    result?: { contentItems?: Array<{ text?: unknown }> };
  };
  const exactText = exactResponse.result?.contentItems?.[0]?.text;
  assert.equal(typeof exactText, "string");
  assert.equal(Buffer.byteLength(exactText as string, "utf8"), MAX_ROOT_TOOL_RESPONSE_BYTES);

  const requestCountAtLimit = fake.requests.length;
  const aboveByteLimit = `${exactByteLimit}x`;
  assert.equal(Buffer.byteLength(aboveByteLimit, "utf8"), MAX_ROOT_TOOL_RESPONSE_BYTES + 1);
  await assert.rejects(
    process.respondToTool("tool-request-over-max", true, aboveByteLimit),
    /invalid_codex_tool_response/u,
  );
  assert.equal(fake.requests.length, requestCountAtLimit);
  await process.shutdown();
});

test("installed Codex CLI supports bounded dynamic-only thread start and shutdown", { timeout: 15_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-codex-probe-"));
  const codexHome = path.join(temporary, "home");
  await mkdir(codexHome);
  try {
    const process = await CodexProcess.start(testCodexOptions(codexHome));
    try {
      const thread = await CodexThread.create(process, {
        cwd: temporary,
        tools: [],
        correlationId: parseCorrelationId("thread:installed-dynamic-only"),
        access: { kind: "read_only" },
        toolMode: "dynamic_only",
      });
      thread.close();
    } finally {
      await process.shutdown();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
