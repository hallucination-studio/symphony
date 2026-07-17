import assert from "node:assert/strict";
import test from "node:test";

import { runS1Scenario, s1StepIds } from "../../tools/e2e/scenario-s1.mjs";
import { StepRunner } from "../../tools/e2e/step-runner.mjs";

test("S1 executes all fixed barriers in order and preserves Profile ownership", async () => {
  const calls = [];
  const evidence = [];
  const driver = passingDriver(calls);

  const result = await runS1Scenario({
    driver,
    runner: new StepRunner({ evidence }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(evidence.map(({ id }) => id), s1StepIds());
  assert.deepEqual(calls, [
    "preflight", "startClient", "createBinding", "createPrimaryProfile",
    "createRootA", "waitForClaim", "waitForPlan", "observePlanBarrier",
    "approvePlan", "processWorkflow", "waitForRootGate", "waitForDelivery",
    "readOverviewEvidence", "createSecondaryProfile", "createRootB",
    "auditSecretBoundary",
  ]);
});

test("S1 stops before approval when the stable Plan window observes Work", async () => {
  const calls = [];
  const driver = passingDriver(calls);
  driver.observePlanBarrier = async () => {
    calls.push("observePlanBarrier");
    return { stable: false, workStarted: true, commitCount: 0 };
  };

  await assert.rejects(
    runS1Scenario({ driver, runner: new StepRunner({ evidence: [] }) }),
    /step_expectation_failed/,
  );
  assert.equal(calls.includes("approvePlan"), false);
});

test("S1 stops before delivery when Root Gate evidence is not passed", async () => {
  const calls = [];
  const driver = passingDriver(calls);
  driver.waitForRootGate = async () => {
    calls.push("waitForRootGate");
    return {
      status: "failed",
      deliveryStartedBeforePass: false,
      reworkCount: 1,
      gateIssueCount: 0,
    };
  };

  await assert.rejects(
    runS1Scenario({ driver, runner: new StepRunner({ evidence: [] }) }),
    /step_expectation_failed/,
  );
  assert.equal(calls.includes("waitForDelivery"), false);
});

function passingDriver(calls) {
  const values = {
    preflight: { lockAcquired: true, mutationCount: 0 },
    startClient: { status: "connected", processesRunning: true },
    createBinding: { status: "running", projectLabelCount: 1 },
    createPrimaryProfile: {
      readiness: "ready", isActive: true, fastMode: false, secretMatches: 0,
    },
    createRootA: { rootId: "root-a", delegated: true, readBack: true },
    waitForClaim: {
      state: "In Progress", phase: "planning", singletonCount: 1,
      profileReadiness: "ready",
    },
    waitForPlan: {
      phase: "awaiting-human", treeMatches: true, planApprovalCount: 1,
      workStarted: false,
    },
    observePlanBarrier: { stable: true, workStarted: false, commitCount: 0 },
    approvePlan: {
      approvalState: "Done", phase: "working", snapshotCurrent: true,
      nextLeafOrdered: true,
    },
    processWorkflow: {
      ordered: true, maxConcurrentTurns: 1, unansweredHumanAdvanced: false,
    },
    waitForRootGate: {
      status: "passed", deliveryStartedBeforePass: false, reworkCount: 1,
      gateIssueCount: 0,
    },
    waitForDelivery: {
      kind: "pull_request", rootState: "In Review", phase: "in-review",
      automaticallyCompleted: false, duplicateDelivery: false,
    },
    readOverviewEvidence: {
      completedRootsSource: "linear", secretMatches: 0, pathMatches: 0,
    },
    createSecondaryProfile: {
      readiness: "ready", isActive: true, sameConductorPid: true,
      distinctCodexHome: true, secretMatches: 0,
    },
    createRootB: {
      rootATerminal: true, rootAProfileUnchanged: true,
      rootBUsesSecondary: true, settingsApplied: true, fastMode: false,
    },
    auditSecretBoundary: { secretMatches: 0, codexOwnedFilesTouched: false },
  };
  return Object.fromEntries(Object.entries(values).map(([method, value]) => [
    method,
    async () => {
      calls.push(method);
      return value;
    },
  ]));
}
