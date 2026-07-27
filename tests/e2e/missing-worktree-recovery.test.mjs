import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runMissingWorktreeRecoveryCase } from "../../tools/e2e/missing-worktree-recovery.mjs";

test("missing-worktree Case approves old Plans, faults both fenced owners together, and approves only the fresh invalid Plan", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "missing_worktree_recovery");
  const calls = [];
  const roots = {
    "recoverable-worktree-root": { rootIssueId: "root-recoverable", identifier: "ENG-10" },
    "invalid-generation-root": { rootIssueId: "root-invalid", identifier: "ENG-20" },
  };
  let approvalCount = 0;
  const human = {
    actorId: "human-1",
    async createRootIssue(input) { calls.push(["create", input]); return roots[input.rootKey]; },
    async assertRootUndelegatedAndInactive({ rootIssueId }) { calls.push(["undelegated", rootIssueId]); },
    async delegateRootIssue({ rootIssueId }) { calls.push(["delegate", rootIssueId]); },
    async waitForPlanApprovalRequest({ rootIssueId }) {
      calls.push(["old-approval", rootIssueId]);
      return {
        cycleIssueId: `${rootIssueId}-cycle-old`,
        planIssueId: `${rootIssueId}-plan-old`,
        requestCommentId: `${rootIssueId}-request-old`,
        planRemoteVersion: "2026-07-28T00:00:00.000Z",
      };
    },
    async replyToHumanAction({ rootIssueId, requestCommentId }) {
      approvalCount += 1;
      calls.push(["reply", requestCommentId]);
      return { commentId: `${rootIssueId}-reply-${approvalCount}`, requestCommentId };
    },
    async waitForMissingWorktreeRecoveryAdmission({ rootIssueIds }) {
      calls.push(["admission", ...rootIssueIds]);
      assert.equal(approvalCount, 2);
      return {
        verifyIssueIdsByRootId: { "root-recoverable": "verify-old-a", "root-invalid": "verify-old-b" },
        nativeIssueIdsByRootId: {
          "root-recoverable": ["root-recoverable", "root-recoverable-cycle-old", "root-recoverable-plan-old", "work-old-a", "verify-old-a"],
          "root-invalid": ["root-invalid", "root-invalid-cycle-old", "root-invalid-plan-old", "work-old-b", "verify-old-b"],
        },
      };
    },
    async waitForSuccessorPlanApprovalGate(input) {
      calls.push(["fresh-approval", input.rootIssueId]);
      return {
        cycleIssueId: "cycle-fresh",
        planIssueId: "plan-fresh",
        requestCommentId: "request-fresh",
        planRemoteVersion: "2026-07-28T00:00:02.000Z",
      };
    },
  };
  const runtime = {
    async removeRootWorktreesAndRestart({ faults }) {
      calls.push(["fault", ...faults.map(({ rootIssueId }) => rootIssueId)]);
      return {
        faults: faults.map((fault) => ({
          ...fault,
          branch: `symphony/runs/${fault.rootIdentifier.toLowerCase()}`,
          headRevision: fault.rootIssueId === "root-recoverable" ? "a".repeat(40) : "b".repeat(40),
          invalidated: fault.invalidateExecutionBranch,
          removedAt: "2026-07-28T00:00:01.000Z",
        })),
      };
    },
  };
  const rootCreationsByRootKey = {
    "recoverable-worktree-root": rootCreation("route-a", "conductor-a", "/repositories/a"),
    "invalid-generation-root": rootCreation("route-b", "conductor-b", "/repositories/b"),
  };

  const result = await runMissingWorktreeRecoveryCase({ definition, human, runtime, rootCreationsByRootKey });

  assert.deepEqual(calls.slice(0, 2), [
    ["create", rootCreateInput("recoverable-worktree-root", rootCreationsByRootKey["recoverable-worktree-root"])],
    ["create", rootCreateInput("invalid-generation-root", rootCreationsByRootKey["invalid-generation-root"])],
  ]);
  assert.deepEqual(calls.map(([kind]) => kind), [
    "create", "create", "undelegated", "undelegated", "delegate", "delegate",
    "old-approval", "old-approval", "reply", "reply", "admission", "fault", "fresh-approval", "reply",
  ]);
  assert.deepEqual(result.context.missingWorktree, {
    recoverableRootId: "root-recoverable",
    invalidRootId: "root-invalid",
    oldCycleId: "root-invalid-cycle-old",
    oldNativeIssueIds: ["root-invalid-cycle-old", "root-invalid-plan-old", "work-old-b", "verify-old-b"],
    freshCycleIssueId: "cycle-fresh",
    freshPlanIssueId: "plan-fresh",
    oldApprovalCommentId: "root-invalid-reply-2",
    freshApprovalCommentId: "root-invalid-reply-3",
    missingDetectedAt: "2026-07-28T00:00:01.000Z",
    firstPostRecoveryDispatchAt: "2026-07-28T00:00:02.000Z",
    originalBranch: "symphony/runs/eng-10",
    beforeRevision: "a".repeat(40),
    invalidBranch: "symphony/runs/eng-20",
    invalidRevision: "b".repeat(40),
    oldVerifyIssueIdsByRootId: { "root-recoverable": "verify-old-a", "root-invalid": "verify-old-b" },
  });
});

function rootCreation(routingLabelId, conductorId, worktreeDirectory) {
  return {
    teamId: "team-1",
    projectId: "project-1",
    rootLabelId: "root-label",
    routingLabelId,
    rootStatusId: "todo-state",
    conductorId,
    performerProfileId: `profile-${conductorId}`,
    worktreeDirectory,
  };
}

function rootCreateInput(rootKey, { teamId, projectId, rootLabelId, routingLabelId, rootStatusId }) {
  return { caseId: "missing_worktree_recovery", rootKey, teamId, projectId, rootLabelId, routingLabelId, rootStatusId };
}
