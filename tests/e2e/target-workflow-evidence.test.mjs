import assert from "node:assert/strict";
import test from "node:test";

import { assembleTargetWorkflowEvidence, evaluateTargetWorkflowResults } from "../../tools/e2e/target-workflow-evidence.mjs";
import { TARGET_WORKFLOW_SCENARIOS } from "../../tools/e2e/target-workflow-verdict.mjs";

test("target evidence assembly recomputes one correlated verdict from scenario facts", () => {
  const results = scenarioResults();
  const { verdict } = evaluateTargetWorkflowResults({
    results,
    cleanupCompleted: true,
    setup: preparedSetup(),
  });
  assert.equal(verdict.verdict, "passed");
  assert.deepEqual(verdict.missingScenarios, []);
  assert.deepEqual(verdict.failures, []);
});

test("target evidence assembly keeps independent scenario Roots separate", () => {
  const results = scenarioResults();
  results[1] = { ...results[1], facts: { ...results[1].facts, root: { ...results[1].facts.root, rootIssueId: "root-2" } } };
  const evidence = assembleTargetWorkflowEvidence({
    results,
    cleanupCompleted: true,
    setup: preparedSetup(),
  });
  assert.equal(evidence.scenarioEvidence.success.root.rootIssueId, "root-1");
  assert.equal(evidence.scenarioEvidence.repair_escalation.root.rootIssueId, "root-2");
});

function scenarioResults() {
  const root = {
    projectId: "project-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", planIssueId: "plan-1",
    planContractDigest: "a".repeat(64), finalVerifyId: "verify-execution-1",
    stageContextDigests: { plan: "b".repeat(64), work: { "work-1": "c".repeat(64) }, verify: "d".repeat(64) },
  };
  const stageExecutions = [
    stage("plan-execution-1", "plan", "plan-1", "b".repeat(64)),
    stage("work-execution-1", "work", "work-1", "c".repeat(64)),
    stage("verify-execution-1", "verify", "verify-1", "d".repeat(64)),
  ];
  const facts = {
    root, plan: { approved: true, dagSealed: true, workNodeIds: ["work-1"], verifyNodeIds: ["verify-1"] },
    stageExecutions, progress: { completedWorkNodes: 1, sourceExecutionIds: ["work-execution-1"] },
  };
  return [
    { scenario: "success", status: "passed", facts },
    { scenario: "repair_escalation", status: "passed", facts: { ...facts, repairEscalation: {
      findingId: "finding-1", sourceVerifyId: "verify-1", disposition: "escalated",
      breaker: { checked: true, decision: "escalate", cycleCount: 2, maxCycles: 2, openFindingCount: 1 },
    } } },
    { scenario: "restart_recovery", status: "passed", facts, recovery: {
      staleResultRejected: true, recoveredExecutionId: "work-execution-1", rebuiltFromLinearAndGit: true, freshContextUsed: true,
    } },
    { scenario: "delivery", status: "passed", facts, delivery: {
      kind: "local_branch", branch: "symphony/runs/root-1", head: "e".repeat(40), verifiedAgainst: "verify-1", readBack: true,
    } },
    { scenario: "scheduling", status: "passed", scheduling: {
      selectedRootIds: ["root-1"], waitingRootIds: ["root-2"], maxConcurrentRoots: 1, blockerRespected: true,
    } },
  ];
}

function preparedSetup() {
  return {
    setup: {
      kind: "ready",
      workflow: "already_applied",
      projectLabel: "already_applied",
      identityDigest: "a".repeat(16),
    },
  };
}

function stage(executionId, stage, nodeIssueId, contextDigest) {
  return {
    executionId, rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId, stage,
    contextDigest, resultDigest: "f".repeat(64), gitHead: "e".repeat(40), result: "completed", freshContextId: executionId,
  };
}
