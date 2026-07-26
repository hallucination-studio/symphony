import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runApprovedHappyPathCase } from "../../tools/e2e/approved-happy-path.mjs";

test("approved happy path creates its declared Root and approves only the product Plan Review Action", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  const calls = [];
  const human = {
    actorId: "human-1",
    async createRootIssue(input) {
      calls.push({ kind: "create_root", input });
      return { rootIssueId: "root-1", identifier: "ENG-1" };
    },
    async waitForPlanReviewAction(input) {
      calls.push({ kind: "wait_for_plan_review", input });
      return { actionIssueId: "action-1", terminalStatusId: "approved-state" };
    },
    async setHumanActionTerminalStatus(input) {
      calls.push({ kind: "approve_plan_review", input });
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
    },
  });

  assert.deepEqual(calls, [
    {
      kind: "create_root",
      input: {
        caseId: "approved_happy_path",
        rootKey: "approved-root",
        teamId: "team-1",
        projectId: "project-1",
        routingLabelId: "route-label",
        rootStatusId: "todo-state",
      },
    },
    {
      kind: "wait_for_plan_review",
      input: { rootIssueId: "root-1", terminalStatus: "Approved" },
    },
    {
      kind: "approve_plan_review",
      input: {
        issueId: "action-1",
        terminalStatus: "Approved",
        stateId: "approved-state",
      },
    },
  ]);
  assert.deepEqual(result, {
    context: {
      humanActorId: "human-1",
      rootIssueIdsByKey: { "approved-root": "root-1" },
    },
  });
});

test("approved happy path rejects a Case definition or Human boundary outside the frozen contract", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  const human = {
    actorId: "human-1",
    async createRootIssue() { return { rootIssueId: "root-1", identifier: "ENG-1" }; },
    async waitForPlanReviewAction() { return { actionIssueId: "action-1", terminalStatusId: "approved-state" }; },
    async setHumanActionTerminalStatus() {},
  };

  await assert.rejects(
    runApprovedHappyPathCase({
      definition: { ...definition, caseId: "plan_rejected_and_replanned" },
      human,
      rootCreation: { teamId: "team-1", projectId: "project-1", routingLabelId: "route-label", rootStatusId: "todo-state" },
    }),
    hasCode("foreground_e2e_approved_case_definition_invalid"),
  );
  await assert.rejects(
    runApprovedHappyPathCase({
      definition,
      human: { ...human, actorId: undefined },
      rootCreation: { teamId: "team-1", projectId: "project-1", routingLabelId: "route-label", rootStatusId: "todo-state" },
    }),
    hasCode("foreground_e2e_approved_case_input_invalid"),
  );
});

test("approved happy path forwards Case cancellation only to the Plan Review wait", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  const abortController = new AbortController();
  let waitInput;
  const human = {
    actorId: "human-1",
    async createRootIssue() { return { rootIssueId: "root-1", identifier: "ENG-1" }; },
    async waitForPlanReviewAction(input) {
      waitInput = input;
      return { actionIssueId: "action-1", terminalStatusId: "approved-state" };
    },
    async setHumanActionTerminalStatus() {},
  };

  await runApprovedHappyPathCase({
    definition,
    human,
    signal: abortController.signal,
    rootCreation: { teamId: "team-1", projectId: "project-1", routingLabelId: "route-label", rootStatusId: "todo-state" },
  });

  assert.deepEqual(waitInput, { rootIssueId: "root-1", terminalStatus: "Approved", signal: abortController.signal });
});

function hasCode(code) {
  return (error) => error?.code === code;
}
