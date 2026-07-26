import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runParallelMultiConductorCase } from "../../tools/e2e/parallel-multi-conductor.mjs";

test("parallel Case concurrently creates its frozen routed Roots and approves only their product Plan Review Actions", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "parallel_multi_conductor");
  const calls = [];
  const pendingRootCreates = [];
  const human = {
    actorId: "human-1",
    createRootIssue(input) {
      calls.push({ kind: "create_root", input });
      return new Promise((resolve) => { pendingRootCreates.push(resolve); });
    },
    async waitForPlanReviewAction(input) {
      calls.push({ kind: "wait_for_plan_review", input });
      return {
        actionIssueId: input.rootIssueId === "parallel-a-root-id" ? "parallel-a-action" : "parallel-b-action",
        terminalStatusId: "approved-state",
      };
    },
    async setHumanActionTerminalStatus(input) {
      calls.push({ kind: "approve_plan_review", input });
    },
  };
  const rootCreationsByRootKey = {
    "parallel-a-root": rootCreation("route-a", "conductor-a-id", "profile-a", "/repositories/a"),
    "parallel-b-root": rootCreation("route-b", "conductor-b-id", "profile-b", "/repositories/b"),
  };

  const running = runParallelMultiConductorCase({ definition, human, rootCreationsByRootKey });
  await Promise.resolve();
  assert.deepEqual(calls, [
    { kind: "create_root", input: rootCreateInput("parallel-a-root", rootCreationsByRootKey["parallel-a-root"]) },
    { kind: "create_root", input: rootCreateInput("parallel-b-root", rootCreationsByRootKey["parallel-b-root"]) },
  ]);

  pendingRootCreates[0]({ rootIssueId: "parallel-a-root-id", identifier: "ENG-1" });
  pendingRootCreates[1]({ rootIssueId: "parallel-b-root-id", identifier: "ENG-2" });
  const result = await running;

  assert.deepEqual(calls, [
    { kind: "create_root", input: rootCreateInput("parallel-a-root", rootCreationsByRootKey["parallel-a-root"]) },
    { kind: "create_root", input: rootCreateInput("parallel-b-root", rootCreationsByRootKey["parallel-b-root"]) },
    { kind: "wait_for_plan_review", input: { rootIssueId: "parallel-a-root-id", terminalStatus: "Approved" } },
    { kind: "wait_for_plan_review", input: { rootIssueId: "parallel-b-root-id", terminalStatus: "Approved" } },
    { kind: "approve_plan_review", input: { issueId: "parallel-a-action", terminalStatus: "Approved", stateId: "approved-state" } },
    { kind: "approve_plan_review", input: { issueId: "parallel-b-action", terminalStatus: "Approved", stateId: "approved-state" } },
  ]);
  assert.deepEqual(result, {
    context: {
      humanActorId: "human-1",
      rootIssueIdsByKey: {
        "parallel-a-root": "parallel-a-root-id",
        "parallel-b-root": "parallel-b-root-id",
      },
      parallel: {
        roots: [
          parallelRoot("parallel-a-root", "conductor-a", "parallel-a-repository", "parallel-a-root-id", "parallel-a-action", rootCreationsByRootKey["parallel-a-root"]),
          parallelRoot("parallel-b-root", "conductor-b", "parallel-b-repository", "parallel-b-root-id", "parallel-b-action", rootCreationsByRootKey["parallel-b-root"]),
        ],
      },
    },
  });
});

test("parallel Case rejects noncanonical definitions, incomplete topology bindings, and Human boundaries outside its contract", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "parallel_multi_conductor");
  const human = {
    actorId: "human-1",
    async createRootIssue() { return { rootIssueId: "root-1", identifier: "ENG-1" }; },
    async waitForPlanReviewAction() { return { actionIssueId: "action-1", terminalStatusId: "approved-state" }; },
    async setHumanActionTerminalStatus() {},
  };
  const rootCreationsByRootKey = {
    "parallel-a-root": rootCreation("route-a", "conductor-a-id", "profile-a", "/repositories/a"),
    "parallel-b-root": rootCreation("route-b", "conductor-b-id", "profile-b", "/repositories/b"),
  };

  await assert.rejects(
    runParallelMultiConductorCase({ definition: { ...definition, caseId: "approved_happy_path" }, human, rootCreationsByRootKey }),
    hasCode("foreground_e2e_parallel_case_definition_invalid"),
  );
  await assert.rejects(
    runParallelMultiConductorCase({ definition, human, rootCreationsByRootKey: { ...rootCreationsByRootKey, "parallel-b-root": { ...rootCreationsByRootKey["parallel-b-root"], conductorId: "conductor-a-id" } } }),
    hasCode("foreground_e2e_parallel_case_input_invalid"),
  );
  await assert.rejects(
    runParallelMultiConductorCase({ definition, human: { ...human, setHumanActionTerminalStatus: undefined }, rootCreationsByRootKey }),
    hasCode("foreground_e2e_parallel_case_input_invalid"),
  );
});

test("parallel Case forwards cancellation only to the independent Plan Review waits", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "parallel_multi_conductor");
  const abortController = new AbortController();
  const waits = [];
  const human = {
    actorId: "human-1",
    async createRootIssue({ rootKey }) {
      return rootKey === "parallel-a-root"
        ? { rootIssueId: "parallel-a-root-id", identifier: "ENG-1" }
        : { rootIssueId: "parallel-b-root-id", identifier: "ENG-2" };
    },
    async waitForPlanReviewAction(input) {
      waits.push(input);
      return { actionIssueId: `${input.rootIssueId}-action`, terminalStatusId: "approved-state" };
    },
    async setHumanActionTerminalStatus() {},
  };

  await runParallelMultiConductorCase({
    definition,
    human,
    signal: abortController.signal,
    rootCreationsByRootKey: {
      "parallel-a-root": rootCreation("route-a", "conductor-a-id", "profile-a", "/repositories/a"),
      "parallel-b-root": rootCreation("route-b", "conductor-b-id", "profile-b", "/repositories/b"),
    },
  });

  assert.deepEqual(waits, [
    { rootIssueId: "parallel-a-root-id", terminalStatus: "Approved", signal: abortController.signal },
    { rootIssueId: "parallel-b-root-id", terminalStatus: "Approved", signal: abortController.signal },
  ]);
});

function rootCreation(routingLabelId, conductorId, performerProfileId, repositoryRoot) {
  return { teamId: "team-1", projectId: "project-1", routingLabelId, rootStatusId: "todo-state", conductorId, performerProfileId, repositoryRoot };
}

function rootCreateInput(rootKey, { teamId, projectId, routingLabelId, rootStatusId }) {
  return { caseId: "parallel_multi_conductor", rootKey, teamId, projectId, routingLabelId, rootStatusId };
}

function parallelRoot(rootKey, conductorRef, repositoryRef, rootIssueId, planReviewActionIssueId, {
  routingLabelId,
  conductorId,
  performerProfileId,
  repositoryRoot,
}) {
  return { rootKey, conductorRef, repositoryRef, rootIssueId, planReviewActionIssueId, routingLabelId, conductorId, performerProfileId, repositoryRoot };
}

function hasCode(code) {
  return (error) => error?.code === code;
}
