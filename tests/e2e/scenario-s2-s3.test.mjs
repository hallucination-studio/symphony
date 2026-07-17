import assert from "node:assert/strict";
import test from "node:test";

import {
  runS2Scenario,
  runS3Scenario,
  s2StepIds,
  s3StepIds,
} from "../../tools/e2e/scenario-s2-s3.mjs";
import { StepRunner } from "../../tools/e2e/step-runner.mjs";

test("S2 runs eight authority probes with distinct Roots and fixed evidence", async () => {
  const evidence = [];
  const calls = [];
  const result = await runS2Scenario({
    driver: s2Driver(calls),
    runner: new StepRunner({ evidence }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(evidence.map(({ id }) => id), s2StepIds());
  assert.equal(new Set(evidence.map(({ observation }) => observation.rootId)).size, 8);
});

test("S2 stops immediately and does not start the next probe", async () => {
  const calls = [];
  const driver = s2Driver(calls);
  driver.probeRootReplan = async () => {
    calls.push("probeRootReplan");
    return probe(3, { replanned: false });
  };

  await assert.rejects(
    runS2Scenario({ driver, runner: new StepRunner({ evidence: [] }) }),
    /step_expectation_failed/,
  );
  assert.equal(calls.includes("probeWorkLocalRerun"), false);
});

test("S2 rejects a Root reused by two probes", async () => {
  const driver = s2Driver([]);
  driver.probeTreeFullRead = async () => probe(1, {
    fullRead: true,
    latestParentOrderUsed: true,
  });

  await assert.rejects(
    runS2Scenario({ driver, runner: new StepRunner({ evidence: [] }) }),
    /s2_probe_evidence_invalid/,
  );
});

test("S3 runs only test-owned recovery boundaries in fixed order", async () => {
  const evidence = [];
  const result = await runS3Scenario({
    driver: s3Driver(),
    runner: new StepRunner({ evidence }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(evidence.map(({ id }) => id), s3StepIds());
});

test("S3 rejects faults outside a test-owned process boundary", async () => {
  const driver = s3Driver();
  driver.recoverPerformer = async () => ({
    testOwnedBoundary: false,
    failureSurfacedImmediately: true,
    samePerformerId: true,
    workState: "In Progress",
  });

  await assert.rejects(
    runS3Scenario({ driver, runner: new StepRunner({ evidence: [] }) }),
    /step_expectation_failed/,
  );
});

test("S3 rejects partial Work convergence evidence", async () => {
  const driver = s3Driver();
  driver.recoverWorkConvergence = async () => ({
    testOwnedBoundary: true,
    failureSurfacedImmediately: true,
    faults: [{
      boundary: "after-work-commit",
      converged: true,
      duplicateCommits: 0,
      duplicateMarkers: 0,
    }],
  });

  await assert.rejects(
    runS3Scenario({ driver, runner: new StepRunner({ evidence: [] }) }),
    /step_expectation_failed/,
  );
});

function s2Driver(calls) {
  const values = {
    probeProjectLabelBoundary: probe(1, {
      nextTurnUsedNewProject: true,
      staleResultAdvanced: false,
      originalProjectResumed: true,
    }),
    probeTreeFullRead: probe(2, {
      fullRead: true,
      latestParentOrderUsed: true,
    }),
    probeRootReplan: probe(3, {
      replanned: true,
      incompleteWorkReconciled: true,
      reapprovalRequired: true,
    }),
    probeWorkLocalRerun: probe(4, {
      changedWorkReran: true,
      planReran: false,
    }),
    probeCanceledSubtree: probe(5, { canceledExcludedFromGate: true }),
    probeInvalidMetadata: probe(6, { blocked: true, silentlyCompleted: false }),
    probeTerminalRoot: probe(7, {
      staleResultAdvanced: false,
      rootRemainedTerminal: true,
    }),
    probePreconditionConflict: probe(8, {
      fullReadRepeated: true,
      userStateOverwritten: false,
    }),
  };
  return Object.fromEntries(Object.entries(values).map(([method, value]) => [
    method,
    async () => {
      calls.push(method);
      return value;
    },
  ]));
}

function probe(index, values) {
  return {
    rootId: `probe-root-${index}`,
    beforeVersion: `before-${index}`,
    afterVersion: `after-${index}`,
    turnId: `turn-${index}`,
    expectedState: `expected-${index}`,
    probeComment: `[E2E Probe] probe-${index}`,
    ...values,
  };
}

function s3Driver() {
  const common = {
    testOwnedBoundary: true,
    failureSurfacedImmediately: true,
  };
  return {
    async recoverPerformer() {
      return {
        ...common,
        samePerformerId: true,
        performerIdExposure: "hashed",
        workState: "In Progress",
      };
    },
    async recoverWorkConvergence() {
      return {
        ...common,
        faults: [
          "after-work-commit",
          "after-input-hash",
          "after-linear-state",
        ].map((boundary) => ({
          boundary,
          converged: true,
          duplicateCommits: 0,
          duplicateMarkers: 0,
        })),
      };
    },
    async recoverConductor() {
      return {
        ...common,
        processTreeReplaced: true,
        conductorDatabaseUsed: false,
        rebuiltFromLinearGitProfile: true,
      };
    },
    async recoverBranchFallback() {
      return {
        ...common,
        ghDisabled: true,
        gitRemoteAvailable: true,
        deliveryKind: "branch",
        branchReused: true,
      };
    },
  };
}
