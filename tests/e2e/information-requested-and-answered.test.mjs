import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runInformationRequestedAndAnsweredCase } from "../../tools/e2e/information-requested-and-answered.mjs";

test("information Case writes its frozen answer on the product Clarification Action and waits for fresh Plan Review", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "information_requested_and_answered");
  const calls = [];
  const human = {
    actorId: "human-1",
    async createRootIssue(input) {
      calls.push({ kind: "create_root", input });
      return { rootIssueId: "root-1", identifier: "ENG-1" };
    },
    async assertRootUndelegatedAndInactive(input) {
      calls.push({ kind: "assert_undelegated", input });
    },
    async delegateRootIssue(input) {
      calls.push({ kind: "delegate_root", input });
    },
    async waitForInformationRequest(input) {
      calls.push({ kind: "wait_for_clarification", input });
      return { requestCommentId: "information-request", rootIssueId: "root-1" };
    },
    async replyToHumanAction(input) {
      calls.push({ kind: "answer_information", input });
      return { commentId: "answer-comment", issueId: input.rootIssueId, requestCommentId: input.requestCommentId };
    },
    async waitForPlanApprovalRequest(input) {
      calls.push({ kind: "wait_for_plan_review", input });
      return { requestCommentId: "replacement-plan-review", planIssueId: "replacement-plan" };
    },
  };

  const result = await runInformationRequestedAndAnsweredCase({
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
        caseId: "information_requested_and_answered",
        rootKey: "information-root",
        teamId: "team-1",
        projectId: "project-1",
        routingLabelId: "route-label",
        rootStatusId: "todo-state",
      },
    },
    { kind: "assert_undelegated", input: { rootIssueId: "root-1" } },
    { kind: "delegate_root", input: { rootIssueId: "root-1" } },
    { kind: "wait_for_clarification", input: { rootIssueId: "root-1" } },
    {
      kind: "answer_information",
      input: { rootIssueId: "root-1", requestCommentId: "information-request", body: "Use a colon as the identifier separator." },
    },
    { kind: "wait_for_plan_review", input: { rootIssueId: "root-1" } },
  ]);
  assert.deepEqual(result, {
    context: {
      humanActorId: "human-1",
      rootIssueIdsByKey: { "information-root": "root-1" },
      inputReferences: [{ sourceId: "answer-comment", kind: "comment_create", binding: "separator_answer", commentId: "answer-comment" }],
      informationRequestCommentId: "information-request",
      replacementRequestCommentId: "replacement-plan-review",
    },
  });
});

test("information Case rejects a noncanonical definition or a Human boundary outside its frozen contract", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "information_requested_and_answered");
  const human = {
    actorId: "human-1",
    async createRootIssue() { return { rootIssueId: "root-1", identifier: "ENG-1" }; },
    async assertRootUndelegatedAndInactive() {},
    async delegateRootIssue() {},
    async waitForInformationRequest() { return { requestCommentId: "information-request", rootIssueId: "root-1" }; },
    async replyToHumanAction() { return { commentId: "answer-comment", issueId: "root-1", requestCommentId: "information-request" }; },
    async waitForPlanApprovalRequest() { return { requestCommentId: "replacement-plan-review", planIssueId: "replacement-plan" }; },
  };

  await assert.rejects(
    runInformationRequestedAndAnsweredCase({
      definition: { ...definition, caseId: "approved_happy_path" },
      human,
      rootCreation: { teamId: "team-1", projectId: "project-1", routingLabelId: "route-label", rootStatusId: "todo-state" },
    }),
    hasCode("foreground_e2e_information_case_definition_invalid"),
  );
  await assert.rejects(
    runInformationRequestedAndAnsweredCase({
      definition,
      human: { ...human, waitForInformationRequest: undefined },
      rootCreation: { teamId: "team-1", projectId: "project-1", routingLabelId: "route-label", rootStatusId: "todo-state" },
    }),
    hasCode("foreground_e2e_information_case_input_invalid"),
  );
});

test("information Case forwards cancellation only to its Clarification and Plan Review waits", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "information_requested_and_answered");
  const abortController = new AbortController();
  const waits = [];
  const human = {
    actorId: "human-1",
    async createRootIssue() { return { rootIssueId: "root-1", identifier: "ENG-1" }; },
    async assertRootUndelegatedAndInactive(input) { waits.push(input); },
    async delegateRootIssue(input) { waits.push(input); },
    async waitForInformationRequest(input) {
      waits.push(input);
      return { requestCommentId: "information-request", rootIssueId: "root-1" };
    },
    async replyToHumanAction() { return { commentId: "answer-comment", issueId: "root-1", requestCommentId: "information-request" }; },
    async waitForPlanApprovalRequest(input) {
      waits.push(input);
      return { requestCommentId: "replacement-plan-review", planIssueId: "replacement-plan" };
    },
  };

  await runInformationRequestedAndAnsweredCase({
    definition,
    human,
    signal: abortController.signal,
    rootCreation: { teamId: "team-1", projectId: "project-1", routingLabelId: "route-label", rootStatusId: "todo-state" },
  });

  assert.deepEqual(waits, [
    { rootIssueId: "root-1", signal: abortController.signal },
    { rootIssueId: "root-1", signal: abortController.signal },
    { rootIssueId: "root-1", signal: abortController.signal },
    { rootIssueId: "root-1", signal: abortController.signal },
  ]);
});

function hasCode(code) {
  return (error) => error?.code === code;
}
