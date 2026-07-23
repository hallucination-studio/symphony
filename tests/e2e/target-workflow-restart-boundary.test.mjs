import assert from "node:assert/strict";
import test from "node:test";

import { runTargetRestartBoundary } from "../../tools/e2e/target-workflow-restart-boundary.mjs";

test("target restart boundary passes the lifecycle capability and closes resources", async () => {
  const events = [];
  const facts = { root: { rootIssueId: "root-1", projectId: "project-1" } };
  const result = await runTargetRestartBoundary({
    startBoundary: async (input) => {
      events.push(["start", input]);
      return {
        runner: { marker: "runner" },
        async restart(input_) { events.push(["restart", input_]); return { instanceId: "instance-2" }; },
        async close() { events.push(["close"]); },
      };
    },
    runRestart: async (input) => {
      events.push(["scenario", input]);
      return { facts };
    },
    boundaryInput: { bindingId: "binding-1" },
    restartInput: { rootInput: { title: "Root" } },
  });

  assert.deepEqual(result, { facts });
  assert.deepEqual(events.map(([kind]) => kind), ["start", "scenario", "close"]);
  assert.equal(typeof events[1][1].boundary.restart, "function");
  assert.equal(events[1][1].runner.marker, "runner");
});

test("target restart boundary supplies the five-minute deadline when none is provided", async () => {
  let boundaryDeadline;
  let scenarioTimeout;
  await runTargetRestartBoundary({
    now: () => 1_000,
    startBoundary: async (input) => {
      boundaryDeadline = input.deadlineAtMs;
      return { runner: {}, async restart() {}, async close() {} };
    },
    runRestart: async ({ timeoutMs }) => {
      scenarioTimeout = timeoutMs;
      return { scenario: "restart" };
    },
  });

  assert.equal(boundaryDeadline, 301_000);
  assert.equal(scenarioTimeout, 300_000);
});

test("target restart boundary preserves scenario failure while closing resources", async () => {
  const events = [];
  await assert.rejects(
    runTargetRestartBoundary({
      startBoundary: async () => ({
        runner: {},
        async restart() {},
        async close() { events.push("close"); },
      }),
      runRestart: async () => { throw new Error("target_restart_recovery_timeout"); },
    }),
    /target_restart_recovery_timeout/u,
  );
  assert.deepEqual(events, ["close"]);
});
