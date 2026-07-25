import assert from "node:assert/strict";
import test from "node:test";

import {
  convergenceRecordId,
  parseManagedRecord,
  rootConvergencePolicyId,
  serializeManagedRecord,
} from "../api/index.js";

test("Root convergence policy and assessment have deterministic strict managed records", () => {
  const policy = {
    kind: "root_convergence_policy" as const,
    version: 1 as const,
    policyId: rootConvergencePolicyId("root-1"),
    rootIssueId: "root-1",
    maxCyclesPerRoot: 3,
    maxSameOpenFindingCycles: 2,
    maxConsecutiveNoProgress: 2,
    maxTotalTokens: 10_000,
    maxCycleRepairAttempts: 0,
    deadlineAt: "2026-07-26T00:00:00.000Z",
  };
  const view = {
    cycleCount: 1,
    openFindingPersistence: [{ findingId: "finding-1", openCycleCount: 1 }],
    consecutiveNoProgress: 0,
    settledTokens: 42,
    openTokenReservations: [],
    activeCycleIssueId: "cycle-1",
    activeCycleRepairAttempts: 1,
    isDeadlineExceeded: false,
    rootIsCanceled: false,
  };
  const record = {
    kind: "convergence" as const,
    version: 1 as const,
    convergenceRecordId: convergenceRecordId({
      rootIssueId: policy.rootIssueId,
      policyId: policy.policyId,
      view,
      trigger: "max_cycle_repair_attempts",
    }),
    rootIssueId: policy.rootIssueId,
    policyId: policy.policyId,
    policy: {
      maxCyclesPerRoot: policy.maxCyclesPerRoot,
      maxSameOpenFindingCycles: policy.maxSameOpenFindingCycles,
      maxConsecutiveNoProgress: policy.maxConsecutiveNoProgress,
      maxTotalTokens: policy.maxTotalTokens,
      maxCycleRepairAttempts: policy.maxCycleRepairAttempts,
      deadlineAt: policy.deadlineAt,
    },
    view,
    trigger: "max_cycle_repair_attempts" as const,
  };

  assert.deepEqual(parseManagedRecord(serializeManagedRecord(policy)), { ok: true, value: policy });
  assert.deepEqual(parseManagedRecord(serializeManagedRecord(record)), { ok: true, value: record });
  assert.equal(record.convergenceRecordId, convergenceRecordId({
    rootIssueId: policy.rootIssueId,
    policyId: policy.policyId,
    view,
    trigger: "max_cycle_repair_attempts",
  }));
});

test("a changed convergence view receives a new assessment identity", () => {
  const common = {
    rootIssueId: "root-1",
    policyId: rootConvergencePolicyId("root-1"),
    trigger: "max_cycle_repair_attempts" as const,
  };
  const first = convergenceRecordId({
    ...common,
    view: {
      cycleCount: 1,
      openFindingPersistence: [],
      consecutiveNoProgress: 0,
      settledTokens: 42,
      openTokenReservations: [],
      activeCycleIssueId: "cycle-1",
      activeCycleRepairAttempts: 0,
      isDeadlineExceeded: false,
      rootIsCanceled: false,
    },
  });
  const second = convergenceRecordId({
    ...common,
    view: {
      cycleCount: 1,
      openFindingPersistence: [],
      consecutiveNoProgress: 0,
      settledTokens: 42,
      openTokenReservations: [],
      activeCycleIssueId: "cycle-1",
      activeCycleRepairAttempts: 1,
      isDeadlineExceeded: false,
      rootIsCanceled: false,
    },
  });

  assert.notEqual(first, second);
});
