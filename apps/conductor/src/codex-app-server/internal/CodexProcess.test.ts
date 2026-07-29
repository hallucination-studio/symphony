import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { parseCorrelationId } from "../../contracts/identity.js";
import { CodexProcess, testCodexOptions, type CodexSpawner, type SpawnedCodexProcess } from "./CodexProcess.js";
import { CodexThread } from "./CodexThread.js";
import { JsonlFrameDecoder } from "./JsonlPeer.js";

interface FakeServer extends SpawnedCodexProcess {
  readonly input: PassThrough;
  readonly output: PassThrough;
  send(message: Record<string, unknown>): void;
}

function fakeSpawner(handle: (message: Record<string, unknown>, server: FakeServer) => void) {
  let server: FakeServer | undefined;
  const requests: Record<string, unknown>[] = [];
  const spawner: CodexSpawner = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    const decoder = new JsonlFrameDecoder();
    server = {
      stdin: input,
      stdout: output,
      stderr,
      events,
      input,
      output,
      kill: () => { queueMicrotask(() => events.emit("exit", 0, null)); return true; },
      send: (message) => output.write(`${JSON.stringify(message)}\n`),
    };
    input.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        requests.push(message);
        handle(message, server as FakeServer);
      }
    });
    return server;
  };
  return { spawner, requests, server: () => server as FakeServer };
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
  const params = initialize?.params as { capabilities?: { experimentalApi?: boolean } };
  assert.equal(params.capabilities?.experimentalApi, true);
  assert.equal(fake.requests[1]?.method, "initialized");
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
  await process.shutdown();
});

test("installed Codex CLI supports bounded initialize and shutdown", { timeout: 15_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-codex-probe-"));
  const codexHome = path.join(temporary, "home");
  await mkdir(codexHome);
  const process = await CodexProcess.start(testCodexOptions(codexHome));
  await process.shutdown();
});
