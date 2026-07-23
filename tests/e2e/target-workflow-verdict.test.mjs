import assert from "node:assert/strict";
import test from "node:test";

import {
  TARGET_WORKFLOW_SCENARIOS,
  evaluateTargetWorkflowEvidence,
} from "../../tools/e2e/target-workflow-verdict.mjs";

test("target verdict accepts complete correlated workflow evidence", () => {
  const result = evaluateTargetWorkflowEvidence(passingEvidence(), {
    secrets: ["provider-secret"],
  });

  assert.deepEqual(result, {
    verdict: "passed",
    missingScenarios: [],
    failures: [],
    scenarios: TARGET_WORKFLOW_SCENARIOS.map((scenario) => ({
      scenario,
      verdict: "passed",
    })),
  });
});

test("target verdict rejects evidence without the authorized Linear setup checkpoint", () => {
  const evidence = passingEvidence();
  delete evidence.setup;
  const result = evaluateTargetWorkflowEvidence(evidence);

  assert.equal(result.verdict, "failed");
  assert.ok(result.failures.includes("setup_evidence_invalid"));
});

test("target verdict rejects unknown fields inside setup evidence", () => {
  const evidence = passingEvidence();
  evidence.setup.untrustedMetadata = "must-not-cross";
  const result = evaluateTargetWorkflowEvidence(evidence);

  assert.equal(result.verdict, "failed");
  assert.ok(result.failures.includes("setup_evidence_invalid"));
});

test("target verdict rejects missing scenarios and mismatched Stage correlation", () => {
  const evidence = passingEvidence();
  evidence.scenarios = evidence.scenarios.filter(({ scenario }) => scenario !== "scheduling");
  evidence.stageExecutions = evidence.stageExecutions.map((execution) =>
    execution.stage === "verify"
      ? { ...execution, contextDigest: "f".repeat(64) }
      : execution);

  const result = evaluateTargetWorkflowEvidence(evidence);

  assert.equal(result.verdict, "failed");
  assert.deepEqual(result.missingScenarios, ["scheduling"]);
  assert.ok(result.failures.includes("stage_context_correlation_invalid"));
});

test("target verdict rejects stale results and false progress", () => {
  const evidence = passingEvidence();
  evidence.recovery = {
    ...evidence.recovery,
    staleResultRejected: false,
  };
  evidence.progress = {
    ...evidence.progress,
    completedWorkNodes: 2,
    sourceExecutionIds: ["work-1"],
  };

  const result = evaluateTargetWorkflowEvidence(evidence);

  assert.equal(result.verdict, "failed");
  assert.ok(result.failures.includes("stale_result_accepted"));
  assert.ok(result.failures.includes("progress_evidence_invalid"));
});

test("target verdict rejects breaker bypass and delivery of the wrong revision", () => {
  const evidence = passingEvidence();
  evidence.repairEscalation.breaker = {
    ...evidence.repairEscalation.breaker,
    checked: false,
  };
  evidence.delivery = {
    ...evidence.delivery,
    head: "e".repeat(40),
  };

  const result = evaluateTargetWorkflowEvidence(evidence);

  assert.equal(result.verdict, "failed");
  assert.ok(result.failures.includes("convergence_breaker_bypassed"));
  assert.ok(result.failures.includes("delivery_revision_mismatch"));
});

test("target verdict rejects credentials and secret values in evidence", () => {
  const evidence = passingEvidence();
  evidence.provider = { apiKey: "provider-secret" };

  const result = evaluateTargetWorkflowEvidence(evidence, {
    secrets: ["provider-secret"],
  });

  assert.equal(result.verdict, "failed");
  assert.ok(result.failures.includes("secret_leaked"));
});

test("target verdict rejects unknown top-level evidence fields", () => {
  const evidence = passingEvidence();
  evidence.untrustedMetadata = { note: "ignored" };

  const result = evaluateTargetWorkflowEvidence(evidence);

  assert.equal(result.verdict, "failed");
  assert.ok(result.failures.includes("evidence_shape_invalid"));
});

test("target verdict rejects malformed Linear observation evidence", () => {
  const evidence = passingEvidence();
  evidence.linearObservation = {
    setup: { logicalOperations: 0, physicalRequests: "unknown" },
    scenarios: Object.fromEntries(TARGET_WORKFLOW_SCENARIOS.map((scenario) => [scenario, {}])),
    total: {},
  };
  const result = evaluateTargetWorkflowEvidence(evidence);
  assert.ok(result.failures.includes("linear_observation_evidence_invalid"));
});

function passingEvidence() {
  const root = {
    projectId: "project-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    planIssueId: "plan-1",
    planContractDigest: "a".repeat(64),
    finalVerifyId: "verify-1",
    stageContextDigests: {
      plan: "b".repeat(64),
      work: { "work-1": "d".repeat(64) },
      verify: "e".repeat(64),
    },
  };
  const stageExecutions = [
    stage("plan-1", "plan", "plan-1", "b".repeat(64), "c".repeat(40)),
    stage("work-1", "work", "work-1", "d".repeat(64), "c".repeat(40)),
    stage("verify-1", "verify", "verify-1", "e".repeat(64), "c".repeat(40)),
  ];
  return {
    status: "failed",
    setup: {
      status: "ready",
      workflow: "already_applied",
      projectLabel: "already_applied",
      identityDigest: "a".repeat(16),
    },
    root,
    scenarios: TARGET_WORKFLOW_SCENARIOS.map((scenario) => ({ scenario, status: "passed" })),
    stageExecutions,
    plan: {
      approved: true,
      dagSealed: true,
      workNodeIds: ["work-1"],
      verifyNodeIds: ["verify-1"],
    },
    progress: {
      completedWorkNodes: 1,
      sourceExecutionIds: ["work-1"],
    },
    recovery: {
      staleResultRejected: true,
      recoveredExecutionId: "work-1",
      rebuiltFromLinearAndGit: true,
      freshContextUsed: true,
    },
    repairEscalation: {
      findingId: "finding-1",
      sourceVerifyId: "verify-1",
      disposition: "escalated",
      breaker: {
        checked: true,
        decision: "escalate",
        cycleCount: 2,
        maxCycles: 2,
        openFindingCount: 1,
      },
    },
    delivery: {
      kind: "local_branch",
      branch: "symphony/runs/run-1",
      head: "c".repeat(40),
      verifiedAgainst: "verify-1",
      readBack: true,
    },
    scheduling: {
      selectedRootIds: ["root-1", "root-2"],
      waitingRootIds: ["root-3"],
      maxConcurrentRoots: 1,
      blockerRespected: true,
    },
    cleanup: { completed: true },
  };
}

function stage(executionId, stageName, nodeIssueId, contextDigest, gitHead) {
  return {
    executionId,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId,
    stage: stageName,
    contextDigest,
    resultDigest: "f".repeat(64),
    gitHead,
    result: "completed",
    freshContextId: `context-${executionId}`,
  };
}
