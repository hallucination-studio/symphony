import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runRejectedPlanAndReplannedCase } from "../../tools/e2e/rejected-plan-and-replanned.mjs";

test("rejected Plan Case consumes its admitted Root, writes its frozen reason, and waits for a fresh Action", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "plan_rejected_and_replanned");
  const calls = [];
  const human = {
    actorId: "human-1",
    async waitForPlanApprovalRequest(input) {
      calls.push({ kind: "wait_for_plan_review", input });
      return calls.filter(({ kind }) => kind === "wait_for_plan_review").length === 1
        ? { requestCommentId: "initial-request", planIssueId: "initial-plan" }
        : { requestCommentId: "replacement-request", planIssueId: "replacement-plan" };
    },
    async replyToHumanAction(input) {
      calls.push({ kind: "create_reply", input });
      return { commentId: "rejection-comment", issueId: input.rootIssueId, requestCommentId: input.requestCommentId };
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
      rootIssueId: "root-1",
      identifier: "ENG-1",
    },
  });

  assert.deepEqual(calls, [
    { kind: "wait_for_plan_review", input: { rootIssueId: "root-1" } },
    {
      kind: "create_reply",
      input: {
        rootIssueId: "root-1",
        requestCommentId: "initial-request",
        body: "The plan should preserve the existing utility contract before adding the new behavior.",
      },
    },
    { kind: "wait_for_plan_review", input: { rootIssueId: "root-1" } },
  ]);
  assert.deepEqual(result, {
    context: {
      humanActorId: "human-1",
      rootIssueIdsByKey: { "rejected-plan-root": "root-1" },
      inputReferences: [{ sourceId: "rejection-comment", kind: "comment_create", binding: "rejection_reason", commentId: "rejection-comment" }],
      rejectedPlanIssueId: "initial-plan",
      rejectionRequestCommentId: "initial-request",
      replacementPlanIssueId: "replacement-plan",
      replacementRequestCommentId: "replacement-request",
    },
  });
});

test("rejected Plan Case rejects a noncanonical definition or a Human boundary outside its frozen contract", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "plan_rejected_and_replanned");
  const human = {
    actorId: "human-1",
    async waitForPlanApprovalRequest() { return { requestCommentId: "request-1", planIssueId: "plan-1" }; },
    async replyToHumanAction() { return { commentId: "comment-1", issueId: "root-1", requestCommentId: "request-1" }; },
  };

  await assert.rejects(
    runRejectedPlanAndReplannedCase({
      definition: { ...definition, caseId: "approved_happy_path" },
      human,
      rootCreation: admittedRootCreation(),
    }),
    hasCode("foreground_e2e_rejected_case_definition_invalid"),
  );
  await assert.rejects(
    runRejectedPlanAndReplannedCase({
      definition,
      human: { ...human, replyToHumanAction: undefined },
      rootCreation: admittedRootCreation(),
    }),
    hasCode("foreground_e2e_rejected_case_input_invalid"),
  );
});

function admittedRootCreation() {
  return {
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
    rootIssueId: "root-1",
    identifier: "ENG-1",
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}
