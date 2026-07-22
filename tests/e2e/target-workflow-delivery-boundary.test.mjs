import assert from "node:assert/strict";
import test from "node:test";

import { runTargetDeliveryBoundary } from "../../tools/e2e/target-workflow-delivery-boundary.mjs";

test("target delivery boundary keeps the production boundary alive through delivery read-back", async () => {
  const events = [];
  const result = await runTargetDeliveryBoundary({
    startBoundary: async () => ({
      runner: { marker: "runner" },
      async close() { events.push("close"); },
    }),
    runSuccess: async ({ runner }) => { events.push(["success", runner.marker]); return { facts: { root: { rootIssueId: "root-1" } } }; },
    runDelivery: async ({ runner }) => { events.push(["delivery", runner.marker]); return { delivery: { kind: "local_branch" } }; },
  });
  assert.deepEqual(result, {
    success: { facts: { root: { rootIssueId: "root-1" } } },
    delivery: { delivery: { kind: "local_branch" } },
  });
  assert.deepEqual(events, [["success", "runner"], ["delivery", "runner"], "close"]);
});

test("target delivery boundary preserves success or delivery failure and closes resources", async () => {
  const events = [];
  await assert.rejects(
    runTargetDeliveryBoundary({
      startBoundary: async () => ({ runner: {}, async close() { events.push("close"); } }),
      runSuccess: async () => { throw new Error("target_success_timeout"); },
      runDelivery: async () => { throw new Error("must_not_run"); },
    }),
    /target_success_timeout/u,
  );
  assert.deepEqual(events, ["close"]);
});

test("target delivery boundary shares one decreasing deadline across success and delivery", async () => {
  const timeouts = [];
  const times = [1_100, 1_400];
  const result = await runTargetDeliveryBoundary({
    deadlineAtMs: 2_000,
    now: () => times.shift(),
    startBoundary: async () => ({ runner: {}, async close() {} }),
    runSuccess: async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      return { facts: { root: { rootIssueId: "root-1" } } };
    },
    runDelivery: async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      return { delivery: { kind: "local_branch" } };
    },
  });

  assert.equal(result.delivery.delivery.kind, "local_branch");
  assert.deepEqual(timeouts, [900, 600]);
});
