const S2_STEPS = Object.freeze([
  ["s2-project-label-boundary", "probeProjectLabelBoundary", projectLabelReady],
  ["s2-tree-full-read", "probeTreeFullRead", treeRefreshReady],
  ["s2-root-replan", "probeRootReplan", rootReplanReady],
  ["s2-work-local-rerun", "probeWorkLocalRerun", workRerunReady],
  ["s2-canceled-subtree", "probeCanceledSubtree", canceledSubtreeReady],
  ["s2-invalid-metadata", "probeInvalidMetadata", invalidMetadataReady],
  ["s2-terminal-root-stale-result", "probeTerminalRoot", terminalRootReady],
  ["s2-precondition-conflict", "probePreconditionConflict", conflictReady],
]);

const S3_STEPS = Object.freeze([
  ["s3-performer-resume", "recoverPerformer", performerRecoveryReady],
  ["s3-work-convergence", "recoverWorkConvergence", workConvergenceReady],
  ["s3-conductor-replacement", "recoverConductor", conductorRecoveryReady],
  ["s3-branch-fallback", "recoverBranchFallback", branchFallbackReady],
]);

export async function runS2Scenario({ runner, driver }) {
  const roots = new Set();
  validateDriver(driver, S2_STEPS, "s2");
  for (const [id, method, expect] of S2_STEPS) {
    await runner.run({
      id,
      deadlineMs: 120_000,
      invoke: async () => {
        const observation = await driver[method]();
        if (!probeEvidenceReady(observation) || roots.has(observation.rootId)) {
          throw new Error("s2_probe_evidence_invalid");
        }
        roots.add(observation.rootId);
        return observation;
      },
      expect,
      expectedObservation: id,
    });
  }
  return Object.freeze({ scenario: "S2", status: "completed" });
}

export async function runS3Scenario({ runner, driver }) {
  validateDriver(driver, S3_STEPS, "s3");
  for (const [id, method, expect] of S3_STEPS) {
    await runner.run({
      id,
      deadlineMs: 120_000,
      invoke: () => driver[method](),
      expect: (observation) => recoveryEvidenceReady(observation) &&
        expect(observation),
      expectedObservation: id,
    });
  }
  return Object.freeze({ scenario: "S3", status: "completed" });
}

export function s2StepIds() {
  return S2_STEPS.map(([id]) => id);
}

export function s3StepIds() {
  return S3_STEPS.map(([id]) => id);
}

function validateDriver(driver, steps, scenario) {
  if (!driver || steps.some(([, method]) => typeof driver[method] !== "function")) {
    throw new Error(`${scenario}_driver_incomplete`);
  }
}

function probeEvidenceReady(value) {
  return typeof value?.rootId === "string" && value.rootId.length > 0 &&
    typeof value.beforeVersion === "string" &&
    typeof value.afterVersion === "string" &&
    value.beforeVersion !== value.afterVersion &&
    typeof value.turnId === "string" && value.turnId.length > 0 &&
    typeof value.expectedState === "string" && value.expectedState.length > 0 &&
    typeof value.probeComment === "string" &&
    /^\[E2E Probe\] [a-z0-9-]{1,64}$/u.test(value.probeComment);
}

function recoveryEvidenceReady(value) {
  return value?.testOwnedBoundary === true && value.failureSurfacedImmediately === true;
}

function projectLabelReady(value) {
  return value.nextTurnUsedNewProject === true && value.staleResultAdvanced === false &&
    value.originalProjectResumed === true;
}

function treeRefreshReady(value) {
  return value.fullRead === true && value.latestParentOrderUsed === true;
}

function rootReplanReady(value) {
  return value.replanned === true && value.incompleteWorkReconciled === true &&
    value.reapprovalRequired === true;
}

function workRerunReady(value) {
  return value.changedWorkReran === true && value.planReran === false;
}

function canceledSubtreeReady(value) {
  return value.canceledExcludedFromGate === true;
}

function invalidMetadataReady(value) {
  return value.blocked === true && value.silentlyCompleted === false;
}

function terminalRootReady(value) {
  return value.staleResultAdvanced === false && value.rootRemainedTerminal === true;
}

function conflictReady(value) {
  return value.fullReadRepeated === true && value.userStateOverwritten === false;
}

function performerRecoveryReady(value) {
  return value.samePerformerId === true && value.performerIdExposure === "hashed" &&
    value.workState === "In Progress";
}

function workConvergenceReady(value) {
  const expectedFaults = [
    "after-work-commit",
    "after-input-hash",
    "after-linear-state",
  ];
  return Array.isArray(value.faults) && value.faults.length === 3 &&
    value.faults.every((fault, index) =>
      fault?.boundary === expectedFaults[index] && fault.converged === true &&
      fault.duplicateCommits === 0 && fault.duplicateMarkers === 0,
    );
}

function conductorRecoveryReady(value) {
  return value.processTreeReplaced === true && value.conductorDatabaseUsed === false &&
    value.rebuiltFromLinearGitProfile === true;
}

function branchFallbackReady(value) {
  return value.ghDisabled === true && value.gitRemoteAvailable === true &&
    value.deliveryKind === "branch" && value.branchReused === true;
}
