import assert from "node:assert/strict";
import test from "node:test";

import { runTargetRepairBoundary } from "../../tools/e2e/target-workflow-repair-boundary.mjs";

test("target repair boundary closes production resources after escalation", async () => {
  const events = [];
  const facts = { root: { rootIssueId: "root-1", projectId: "project-1" } };
  const result = await runTargetRepairBoundary({
    startBoundary: async (input) => {
      events.push(["start", input]);
      return { runner: { marker: "runner" }, async close() { events.push(["close"]); } };
    },
    runRepair: async (input) => {
      events.push(["repair", input]);
      return { facts };
    },
    boundaryInput: { bindingId: "binding-1" },
    repairInput: { rootInput: { title: "Repair" } },
  });

  assert.deepEqual(result, { facts });
  assert.deepEqual(events.map(([kind]) => kind), ["start", "repair", "close"]);
  assert.equal(Object.hasOwn(result, "runner"), false);
});

test("target repair boundary supplies the five-minute deadline when none is provided", async () => {
  let boundaryDeadline;
  let scenarioTimeout;
  await runTargetRepairBoundary({
    now: () => 1_000,
    startBoundary: async (input) => {
      boundaryDeadline = input.deadlineAtMs;
      return { runner: {}, async close() {} };
    },
    runRepair: async ({ timeoutMs }) => {
      scenarioTimeout = timeoutMs;
      return { scenario: "repair" };
    },
  });

  assert.equal(boundaryDeadline, 301_000);
  assert.equal(scenarioTimeout, 300_000);
});

test("target repair boundary preserves scenario failure while closing resources", async () => {
  const events = [];
  await assert.rejects(
    runTargetRepairBoundary({
      startBoundary: async () => ({
        runner: { marker: "runner" },
        async close() { events.push("close"); },
      }),
      runRepair: async () => { throw new Error("target_repair_timeout"); },
      boundaryInput: {},
      repairInput: {},
    }),
    /target_repair_timeout/u,
  );
  assert.deepEqual(events, ["close"]);
});

test("target repair boundary keeps scenario failure when cleanup also fails", async () => {
  await assert.rejects(
    runTargetRepairBoundary({
      startBoundary: async () => ({
        runner: {},
        async close() { throw new Error("cleanup_failed"); },
      }),
      runRepair: async () => { throw new Error("target_repair_timeout"); },
    }),
    /target_repair_timeout/u,
  );
});
