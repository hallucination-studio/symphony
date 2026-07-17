const S1_STEPS = Object.freeze([
  ["s1-preflight-lock", "preflight", preflightReady],
  ["s1-client-connected", "startClient", connected],
  ["s1-binding-running", "createBinding", bindingReady],
  ["s1-primary-profile", "createPrimaryProfile", primaryProfileReady],
  ["s1-root-a-created", "createRootA", rootCreated],
  ["s1-root-a-claimed", "waitForClaim", claimReady],
  ["s1-plan-ready", "waitForPlan", planReady],
  ["s1-plan-stable-window", "observePlanBarrier", planBarrierHeld],
  ["s1-plan-approved", "approvePlan", approvalReady],
  ["s1-workflow-ordered", "processWorkflow", workflowReady],
  ["s1-root-gate", "waitForRootGate", rootGateReady],
  ["s1-delivery", "waitForDelivery", deliveryReady],
  ["s1-overview-evidence", "readOverviewEvidence", overviewReady],
  ["s1-secondary-profile", "createSecondaryProfile", secondaryProfileReady],
  ["s1-root-b-profile", "createRootB", rootBReady],
  ["s1-secret-boundary", "auditSecretBoundary", secretBoundaryReady],
]);

export async function runS1Scenario({ runner, driver }) {
  for (const [id, method, expect] of S1_STEPS) {
    if (typeof driver[method] !== "function") {
      throw new Error(`s1_driver_${method}_missing`);
    }
    await runner.run({
      id,
      deadlineMs: 120_000,
      invoke: () => driver[method](),
      expect,
      expectedObservation: id,
    });
  }
  return Object.freeze({ scenario: "S1", status: "completed" });
}

export function s1StepIds() {
  return S1_STEPS.map(([id]) => id);
}

function preflightReady(value) {
  return value?.lockAcquired === true && value.mutationCount === 0;
}

function connected(value) {
  return value?.status === "connected" && value.processesRunning === true;
}

function bindingReady(value) {
  return value?.status === "running" && value.projectLabelCount === 1;
}

function primaryProfileReady(value) {
  return value?.readiness === "ready" && value.isActive === true &&
    value.fastMode === false && value.secretMatches === 0;
}

function rootCreated(value) {
  return typeof value?.rootId === "string" && value.delegated === true &&
    value.readBack === true;
}

function claimReady(value) {
  return value?.state === "In Progress" && value.phase === "planning" &&
    value.singletonCount === 1 && value.profileReadiness === "ready";
}

function planReady(value) {
  return value?.phase === "awaiting-human" && value.treeMatches === true &&
    value.planApprovalCount === 1 && value.workStarted === false;
}

function planBarrierHeld(value) {
  return value?.stable === true && value.workStarted === false &&
    value.commitCount === 0;
}

function approvalReady(value) {
  return value?.approvalState === "Done" && value.phase === "working" &&
    value.snapshotCurrent === true && value.nextLeafOrdered === true;
}

function workflowReady(value) {
  return value?.ordered === true && value.maxConcurrentTurns === 1 &&
    value.unansweredHumanAdvanced === false;
}

function rootGateReady(value) {
  return value?.status === "passed" && value.deliveryStartedBeforePass === false &&
    value.reworkCount <= 1 && value.gateIssueCount === 0;
}

function deliveryReady(value) {
  return ["pull_request", "branch"].includes(value?.kind) &&
    value.rootState === "In Review" && value.phase === "in-review" &&
    value.automaticallyCompleted === false && value.duplicateDelivery === false;
}

function overviewReady(value) {
  return value?.completedRootsSource === "linear" &&
    value.secretMatches === 0 && value.pathMatches === 0;
}

function secondaryProfileReady(value) {
  return value?.readiness === "ready" && value.isActive === true &&
    value.sameConductorPid === true && value.distinctCodexHome === true &&
    value.secretMatches === 0;
}

function rootBReady(value) {
  return value?.rootATerminal === true && value.rootAProfileUnchanged === true &&
    value.rootBUsesSecondary === true && value.settingsApplied === true &&
    value.fastMode === false;
}

function secretBoundaryReady(value) {
  return value?.secretMatches === 0 && value.codexOwnedFilesTouched === false;
}
