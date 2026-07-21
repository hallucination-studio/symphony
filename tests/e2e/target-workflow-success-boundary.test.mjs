import assert from "node:assert/strict";
import test from "node:test";

import { runTargetSuccessBoundary } from "../../tools/e2e/target-workflow-success-boundary.mjs";

test("target success boundary closes production resources after success", async () => {
  const events = [];
  const facts = { root: { rootIssueId: "root-1", projectId: "project-1" } };
  const result = await runTargetSuccessBoundary({
    startBoundary: async (input) => {
      events.push(["start", input]);
      return { runner: { marker: "runner" }, async close() { events.push(["close"]); } };
    },
    runSuccess: async (input) => {
      events.push(["success", input]);
      return { facts };
    },
    boundaryInput: { bindingId: "binding-1" },
    successInput: { rootInput: { title: "Root" } },
  });

  assert.deepEqual(result, { facts });
  assert.deepEqual(events.map(([kind]) => kind), ["start", "success", "close"]);
  assert.equal(Object.hasOwn(result, "runner"), false);
});

test("target success boundary preserves scenario failure while closing resources", async () => {
  const events = [];
  await assert.rejects(
    runTargetSuccessBoundary({
      startBoundary: async () => ({
        runner: { marker: "runner" },
        async close() { events.push("close"); },
      }),
      runSuccess: async () => { throw new Error("target_success_timeout"); },
      boundaryInput: {},
      successInput: {},
    }),
    /target_success_timeout/u,
  );
  assert.deepEqual(events, ["close"]);
});

test("target success boundary keeps scenario failure when cleanup also fails", async () => {
  await assert.rejects(
    runTargetSuccessBoundary({
      startBoundary: async () => ({
        runner: {},
        async close() { throw new Error("cleanup_failed"); },
      }),
      runSuccess: async () => { throw new Error("target_success_timeout"); },
    }),
    /target_success_timeout/u,
  );
});
