import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runRejectedPlanAndReplannedCase } from "../../tools/e2e/rejected-plan-and-replanned.mjs";

test("rejected Plan Case writes its frozen reason on the product Action, rejects it, and waits for a fresh Action", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "plan_rejected_and_replanned");
  const calls = [];
  const human = {
    actorId: "human-1",
    async createRootIssue(input) {
      calls.push({ kind: "create_root", input });
      return { rootIssueId: "root-1", identifier: "ENG-1" };
    },
    async waitForPlanReviewAction(input) {
      calls.push({ kind: "wait_for_plan_review", input });
      return calls.filter(({ kind }) => kind === "wait_for_plan_review").length === 1
        ? { actionIssueId: "initial-action", terminalStatusId: "rejected-state" }
        : { actionIssueId: "replacement-action", terminalStatusId: "rejected-state" };
    },
    async createComment(input) {
      calls.push({ kind: "create_comment", input });
      return { commentId: "rejection-comment", issueId: input.issueId };
    },
    async setHumanActionTerminalStatus(input) {
      calls.push({ kind: "reject_plan_review", input });
    },
  };

  const result = await runRejectedPlanAndReplannedCase({
    definition,
    human,
    rootCreation: {
      teamId: "team-1",
      projectId: "project-1",
      routingLabelId: "route-label",
      rootStatusId: "todo-state",
    },
  });

  assert.deepEqual(calls, [
    {
      kind: "create_root",
      input: {
        caseId: "plan_rejected_and_replanned",
        rootKey: "rejected-plan-root",
        teamId: "team-1",
        projectId: "project-1",
        routingLabelId: "route-label",
        rootStatusId: "todo-state",
      },
    },
    { kind: "wait_for_plan_review", input: { rootIssueId: "root-1", terminalStatus: "Rejected" } },
    {
      kind: "create_comment",
      input: {
        issueId: "initial-action",
        body: "The plan should preserve the existing utility contract before adding the new behavior.",
      },
    },
    {
      kind: "reject_plan_review",
      input: { issueId: "initial-action", terminalStatus: "Rejected", stateId: "rejected-state" },
    },
    { kind: "wait_for_plan_review", input: { rootIssueId: "root-1", terminalStatus: "Rejected" } },
  ]);
  assert.deepEqual(result, {
    context: {
      humanActorId: "human-1",
      rootIssueIdsByKey: { "rejected-plan-root": "root-1" },
      inputReferences: [{ sourceId: "rejection-comment", kind: "comment_create", binding: "rejection_reason", commentId: "rejection-comment" }],
      rejectedActionIssueId: "initial-action",
      replacementActionIssueId: "replacement-action",
    },
  });
});

test("rejected Plan Case rejects a noncanonical definition or a Human boundary outside its frozen contract", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "plan_rejected_and_replanned");
  const human = {
    actorId: "human-1",
    async createRootIssue() { return { rootIssueId: "root-1", identifier: "ENG-1" }; },
    async waitForPlanReviewAction() { return { actionIssueId: "action-1", terminalStatusId: "rejected-state" }; },
    async createComment() { return { commentId: "comment-1", issueId: "action-1" }; },
    async setHumanActionTerminalStatus() {},
  };

  await assert.rejects(
    runRejectedPlanAndReplannedCase({
      definition: { ...definition, caseId: "approved_happy_path" },
      human,
      rootCreation: { teamId: "team-1", projectId: "project-1", routingLabelId: "route-label", rootStatusId: "todo-state" },
    }),
    hasCode("foreground_e2e_rejected_case_definition_invalid"),
  );
  await assert.rejects(
    runRejectedPlanAndReplannedCase({
      definition,
      human: { ...human, createComment: undefined },
      rootCreation: { teamId: "team-1", projectId: "project-1", routingLabelId: "route-label", rootStatusId: "todo-state" },
    }),
    hasCode("foreground_e2e_rejected_case_input_invalid"),
  );
});

function hasCode(code) {
  return (error) => error?.code === code;
}
