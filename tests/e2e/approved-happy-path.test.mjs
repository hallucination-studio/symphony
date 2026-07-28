import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runApprovedHappyPathCase } from "../../tools/e2e/approved-happy-path.mjs";

test("approved happy path consumes its admitted Root and approves only the product Plan Review Action", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  const calls = [];
  const human = {
    actorId: "human-1",
    async waitForPlanApprovalRequest(input) {
      calls.push({ kind: "wait_for_plan_review", input });
      return { requestCommentId: "request-1", planIssueId: "plan-1", cycleIssueId: "cycle-1" };
    },
    async replyToHumanAction(input) {
      calls.push({ kind: "approve_plan_review", input });
      return { commentId: "reply-1", requestCommentId: input.requestCommentId };
    },
  };

  const result = await runApprovedHappyPathCase({
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
    {
      kind: "wait_for_plan_review",
      input: { rootIssueId: "root-1" },
    },
    {
      kind: "approve_plan_review",
      input: {
        rootIssueId: "root-1",
        requestCommentId: "request-1",
        body: "Approved.",
      },
    },
  ]);
  assert.deepEqual(result, {
    context: {
      humanActorId: "human-1",
      rootIssueIdsByKey: { "approved-root": "root-1" },
      approvalRequestCommentId: "request-1",
      approvalReplyCommentId: "reply-1",
    },
  });
});

test("approved happy path rejects a Case definition or Human boundary outside the frozen contract", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  const human = {
    actorId: "human-1",
    async waitForPlanApprovalRequest() { return { requestCommentId: "request-1", planIssueId: "plan-1", cycleIssueId: "cycle-1" }; },
    async replyToHumanAction(input) { return { commentId: "reply-1", requestCommentId: input.requestCommentId }; },
  };

  await assert.rejects(
    runApprovedHappyPathCase({
      definition: { ...definition, caseId: "plan_rejected_and_replanned" },
      human,
      rootCreation: admittedRootCreation(),
    }),
    hasCode("foreground_e2e_approved_case_definition_invalid"),
  );
  await assert.rejects(
    runApprovedHappyPathCase({
      definition,
      human: { ...human, actorId: undefined },
      rootCreation: admittedRootCreation(),
    }),
    hasCode("foreground_e2e_approved_case_input_invalid"),
  );
});

test("approved happy path forwards Case cancellation to every Linear Human operation", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  const abortController = new AbortController();
  const inputs = [];
  const human = {
    actorId: "human-1",
    async waitForPlanApprovalRequest(input) {
      inputs.push(input);
      return { requestCommentId: "request-1", planIssueId: "plan-1", cycleIssueId: "cycle-1" };
    },
    async replyToHumanAction(input) { return { commentId: "reply-1", requestCommentId: input.requestCommentId }; },
  };

  await runApprovedHappyPathCase({
    definition,
    human,
    signal: abortController.signal,
    rootCreation: admittedRootCreation(),
  });

  assert.deepEqual(inputs, [
    { rootIssueId: "root-1", signal: abortController.signal },
  ]);
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
