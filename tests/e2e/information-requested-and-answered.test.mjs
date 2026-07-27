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
    async waitForClarificationAction(input) {
      calls.push({ kind: "wait_for_clarification", input });
      return { actionIssueId: "clarification-action", terminalStatusId: "answered-state" };
    },
    async createComment(input) {
      calls.push({ kind: "create_comment", input });
      return { commentId: "answer-comment", issueId: input.issueId };
    },
    async setHumanActionTerminalStatus(input) {
      calls.push({ kind: "answer_clarification", input });
    },
    async waitForPlanReviewAction(input) {
      calls.push({ kind: "wait_for_plan_review", input });
      return { actionIssueId: "replacement-plan-review", terminalStatusId: "approved-state" };
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
    { kind: "wait_for_clarification", input: { rootIssueId: "root-1", terminalStatus: "Answered" } },
    {
      kind: "create_comment",
      input: { issueId: "clarification-action", body: "Use a colon as the identifier separator." },
    },
    {
      kind: "answer_clarification",
      input: { issueId: "clarification-action", terminalStatus: "Answered", stateId: "answered-state" },
    },
    { kind: "wait_for_plan_review", input: { rootIssueId: "root-1", terminalStatus: "Approved" } },
  ]);
  assert.deepEqual(result, {
    context: {
      humanActorId: "human-1",
      rootIssueIdsByKey: { "information-root": "root-1" },
      inputReferences: [{ sourceId: "answer-comment", kind: "comment_create", binding: "separator_answer", commentId: "answer-comment" }],
      answeredActionIssueId: "clarification-action",
      replacementActionIssueId: "replacement-plan-review",
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
    async waitForClarificationAction() { return { actionIssueId: "clarification-action", terminalStatusId: "answered-state" }; },
    async createComment() { return { commentId: "answer-comment", issueId: "clarification-action" }; },
    async setHumanActionTerminalStatus() {},
    async waitForPlanReviewAction() { return { actionIssueId: "replacement-plan-review", terminalStatusId: "approved-state" }; },
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
      human: { ...human, waitForClarificationAction: undefined },
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
    async waitForClarificationAction(input) {
      waits.push(input);
      return { actionIssueId: "clarification-action", terminalStatusId: "answered-state" };
    },
    async createComment() { return { commentId: "answer-comment", issueId: "clarification-action" }; },
    async setHumanActionTerminalStatus() {},
    async waitForPlanReviewAction(input) {
      waits.push(input);
      return { actionIssueId: "replacement-plan-review", terminalStatusId: "approved-state" };
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
    { rootIssueId: "root-1", terminalStatus: "Answered", signal: abortController.signal },
    { rootIssueId: "root-1", terminalStatus: "Approved", signal: abortController.signal },
  ]);
});

function hasCode(code) {
  return (error) => error?.code === code;
}
