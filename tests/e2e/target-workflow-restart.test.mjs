import assert from "node:assert/strict";
import test from "node:test";

import { runTargetRestartRecoveryScenario } from "../../tools/e2e/target-workflow-restart.mjs";

test("target restart recovery resumes the same durable Human action after a fresh Conductor", async () => {
  const events = [];
  const facts = { root: { rootIssueId: "root-1", projectId: "project-1" }, stageExecutions: [] };
  const pending = {
    status: "waiting", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "plan-1",
    requestKind: "needs_approval", actionId: "action-1", contextDigest: "a".repeat(64),
  };
  let pendingReads = 0;
  const result = await runTargetRestartRecoveryScenario({
    runner: {
      async createRoot(input) {
        events.push(["createRoot", input]);
        return { rootIssueId: "root-1", projectId: "project-1" };
      },
      async observePendingHuman(input) {
        events.push(["observePendingHuman", input]);
        pendingReads += 1;
        return pendingReads === 1 ? pending : { ...pending };
      },
      async appendHumanResponse(input) {
        events.push(["appendHumanResponse", input]);
      },
      async observeRoot(input) {
        events.push(["observeRoot", input]);
        return { facts };
      },
    },
    boundary: {
      async restart(input) {
        events.push(["restart", input]);
        return {
          instanceId: "instance-2", restarted: true, rebuiltFromLinearAndGit: true,
          freshContextUsed: true, staleResultRejected: true, recoveredExecutionId: "execution-2",
        };
      },
    },
    rootInput: { title: "Root" },
    observationInput: { git: { head: "b".repeat(40), branch: "main" } },
    humanResponseBody: "Approved after restart.",
  });

  assert.deepEqual(result, {
    facts,
    recovery: {
      restarted: true, rebuiltFromLinearAndGit: true, freshContextUsed: true,
      staleResultRejected: true, recoveredExecutionId: "execution-2", instanceId: "instance-2",
    },
  });
  assert.deepEqual(events.map(([kind]) => kind), [
    "createRoot", "observePendingHuman", "restart", "observePendingHuman",
    "appendHumanResponse", "observeRoot",
  ]);
  assert.deepEqual(events[2][1], {
    rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "plan-1",
    actionId: "action-1", contextDigest: "a".repeat(64),
  });
});

test("target restart recovery rejects a restart that does not prove fresh durable reconstruction", async () => {
  await assert.rejects(
    runTargetRestartRecoveryScenario({
      runner: {
        async createRoot() { return { rootIssueId: "root-1", projectId: "project-1" }; },
        async observePendingHuman() {
          return {
            status: "waiting", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "plan-1",
            requestKind: "needs_approval", actionId: "action-1", contextDigest: "a".repeat(64),
          };
        },
        async appendHumanResponse() {},
        async observeRoot() { return { facts: { root: { rootIssueId: "root-1", projectId: "project-1" } } }; },
      },
      boundary: { async restart() { return { restarted: true }; } },
      rootInput: { title: "Root" },
      observationInput: { git: { head: "b".repeat(40), branch: "main" } },
      humanResponseBody: "Approved.",
    }),
    /target_restart_recovery_evidence_invalid/u,
  );
});
