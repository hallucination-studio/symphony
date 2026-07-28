import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runParallelMultiConductorCase } from "../../tools/e2e/parallel-multi-conductor.mjs";

test("parallel Case consumes admitted routed Roots and approves only their product Plan Review Actions", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "parallel_multi_conductor");
  const calls = [];
  const human = {
    actorId: "human-1",
    async waitForPlanApprovalRequest(input) {
      calls.push({ kind: "wait_for_plan_review", input });
      return {
        requestCommentId: input.rootIssueId === "parallel-a-root-id" ? "parallel-a-action" : "parallel-b-action",
        planIssueId: `${input.rootIssueId}-plan`,
      };
    },
    async replyToHumanAction(input) {
      calls.push({ kind: "approve_plan_review", input });
    },
  };
  const rootCreationsByRootKey = {
    "parallel-a-root": rootCreation("route-a", "conductor-a-id", "profile-a", "/repositories/a"),
    "parallel-b-root": rootCreation("route-b", "conductor-b-id", "profile-b", "/repositories/b"),
  };

  const result = await runParallelMultiConductorCase({ definition, human, rootCreationsByRootKey });

  assert.deepEqual(calls, [
    { kind: "wait_for_plan_review", input: { rootIssueId: "parallel-a-root-id" } },
    { kind: "wait_for_plan_review", input: { rootIssueId: "parallel-b-root-id" } },
    { kind: "approve_plan_review", input: { rootIssueId: "parallel-a-root-id", requestCommentId: "parallel-a-action", body: "Approved." } },
    { kind: "approve_plan_review", input: { rootIssueId: "parallel-b-root-id", requestCommentId: "parallel-b-action", body: "Approved." } },
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
    async waitForPlanApprovalRequest() { return { requestCommentId: "action-1", planIssueId: "plan-1" }; },
    async replyToHumanAction() {},
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
    runParallelMultiConductorCase({ definition, human: { ...human, replyToHumanAction: undefined }, rootCreationsByRootKey }),
    hasCode("foreground_e2e_parallel_case_input_invalid"),
  );
});

test("parallel Case forwards cancellation to every independent Linear Human operation", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "parallel_multi_conductor");
  const abortController = new AbortController();
  const waits = [];
  const human = {
    actorId: "human-1",
    async waitForPlanApprovalRequest(input) {
      waits.push(input);
      return { requestCommentId: `${input.rootIssueId}-action`, planIssueId: `${input.rootIssueId}-plan` };
    },
    async replyToHumanAction() {},
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
    { rootIssueId: "parallel-a-root-id", signal: abortController.signal },
    { rootIssueId: "parallel-b-root-id", signal: abortController.signal },
  ]);
});

function rootCreation(routingLabelId, conductorId, performerProfileId, worktreeDirectory) {
  const first = routingLabelId === "route-a";
  return {
    teamId: "team-1", projectId: "project-1", rootLabelId: "root-label", routingLabelId,
    rootStatusId: "todo-state", conductorId, performerProfileId, worktreeDirectory,
    rootIssueId: first ? "parallel-a-root-id" : "parallel-b-root-id",
    identifier: first ? "ENG-1" : "ENG-2",
  };
}

function parallelRoot(rootKey, conductorRef, repositoryRef, rootIssueId, approvalRequestCommentId, {
  routingLabelId,
  conductorId,
  performerProfileId,
  worktreeDirectory,
}) {
  return {
    rootKey,
    conductorRef,
    repositoryRef,
    rootIssueId,
    approvalRequestCommentId,
    routingLabelId,
    conductorId,
    performerProfileId,
    repositoryRoot: `${worktreeDirectory}/${rootIssueId}`,
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}
