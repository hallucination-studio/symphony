import assert from "node:assert/strict";
import test from "node:test";

import { LinearRequestBrokerImpl } from "../dist/internal/linear-gateway/internal/LinearRequestBrokerImpl.js";

test("installation broker dispatches background reads regardless of observed remainder", async () => {
  const broker = new LinearRequestBrokerImpl({ maxConcurrent: 2, maxHighPriorityBurst: 4 });
  broker.observe({
    requestWindow: { limit: 1000, remaining: 1, reset: 60 },
    complexityWindow: { limit: 250000, remaining: 1, reset: 60 },
  });
  assert.equal(await broker.run("background", async () => "observed-only"), "observed-only");
  assert.equal(await broker.run("mutation", async () => "allowed"), "allowed");
  assert.equal(await broker.run("read-back", async () => "allowed"), "allowed");
});

test("installation broker coalesces reads only within one mutation generation", async () => {
  const broker = new LinearRequestBrokerImpl({ maxConcurrent: 3, maxHighPriorityBurst: 4 });
  let runs = 0;
  const releases = [];
  const read = () => broker.run("workflow", () => new Promise((resolve) => {
    runs += 1;
    releases.push(resolve);
  }), { coalesceKey: "root:1" });

  const first = read();
  const shared = read();
  await Promise.resolve();
  assert.equal(runs, 1);
  const mutation = broker.run("mutation", async () => "mutated");
  await mutation;
  const afterMutation = read();
  await Promise.resolve();
  assert.equal(runs, 2);
  releases[1]("fresh");
  assert.equal(await afterMutation, "fresh");
  releases[0]("original");
  assert.deepEqual(await Promise.all([first, shared]), ["original", "original"]);
});

test("installation broker deadlines and retry jitter are bounded", async () => {
  let now = 100;
  const broker = new LinearRequestBrokerImpl({
    maxConcurrent: 1, maxHighPriorityBurst: 2, now: () => now, random: () => 1,
  });
  let release;
  const active = broker.run("control", () => new Promise((resolve) => { release = resolve; }));
  const queued = broker.run("workflow", async () => "late", { deadlineAtMs: 110 });
  now = 111;
  release("done");
  await active;
  await assert.rejects(queued, /linear_request_deadline_exceeded/u);
  assert.equal(broker.retryDelayMs({ attempt: 3, retryAfterMs: 900, maxDelayMs: 1000 }), 1000);
});

test("installation broker applies a bounded deadline when callers omit one", async () => {
  const broker = new LinearRequestBrokerImpl({
    maxConcurrent: 1,
    maxHighPriorityBurst: 1,
    requestTimeoutMs: 100,
  });

  const timedOut = broker.run("workflow", () => new Promise(() => {}));
  await assert.rejects(
    timedOut,
    /linear_request_deadline_exceeded/u,
  );
  assert.equal(
    await broker.run("workflow", async () => "after-timeout"),
    "after-timeout",
  );
});
