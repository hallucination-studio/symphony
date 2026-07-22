import assert from "node:assert/strict";
import test from "node:test";

import { LinearRequestBrokerImpl } from "../dist/internal/linear-gateway/internal/LinearRequestBrokerImpl.js";
import { LinearRunBudgetImpl } from "../dist/internal/linear-gateway/internal/LinearRunBudgetImpl.js";

test("installation broker reserves both rate windows from background reads", async () => {
  const broker = new LinearRequestBrokerImpl({ maxConcurrent: 2, maxHighPriorityBurst: 4 });
  await assert.rejects(
    broker.run("background", async () => "unknown"),
    /linear_request_capacity_reserved/u,
  );
  broker.observe({
    requestWindow: { limit: 1000, remaining: 750, reset: 60 },
    complexityWindow: { limit: 250000, remaining: 200000, reset: 60 },
  });

  await assert.rejects(
    broker.run("background", async () => "forbidden"),
    /linear_request_capacity_reserved/u,
  );
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
  await assert.rejects(queued, /linear_request_budget_exhausted/u);
  assert.equal(broker.retryDelayMs({ attempt: 3, retryAfterMs: 900, maxDelayMs: 1000 }), 1000);
});

test("installation broker charges physical permits to a run budget", async () => {
  const budget = new LinearRunBudgetImpl({ maxRequests: 2 });
  budget.observe({
    requestWindow: { limit: 10, remaining: 10, reset: 60 },
    complexityWindow: { limit: 100, remaining: 100, reset: 60 },
  });
  const broker = new LinearRequestBrokerImpl({
    maxConcurrent: 1,
    maxHighPriorityBurst: 2,
    budget,
  });

  assert.equal(await broker.run("mutation", async () => "first"), "first");
  broker.observe({
    requestWindow: { limit: 10, remaining: 9, reset: 60 },
    complexityWindow: { limit: 100, remaining: 99, reset: 60 },
  });
  assert.equal(budget.snapshot().logicalOperations, 1);
  assert.equal(budget.snapshot().physicalRequests, 2);
  await assert.rejects(
    broker.run("mutation", async () => "blocked"),
    /linear_run_budget_exhausted/u,
  );
});
