import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runSameConductorPreemptionCase } from "../../tools/e2e/same-conductor-preemption.mjs";

test("preemption Case consumes admitted Roots, touches only the bound ready Root, then approves product Plan Review Actions", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "same_conductor_preemption");
  const calls = [];
  const human = {
    actorId: "human-1",
    async waitForSameConductorPreemptionAdmission(input) {
      calls.push({ kind: "wait_for_admission", input });
      return {
        inflightRootIssueId: "inflight-root-id",
        inflightStageIssueId: "inflight-execution",
        readyRootIssueIds: ["remaining-root-id", "touched-root-id"],
      };
    },
    async updateRootDescription(input) {
      calls.push({ kind: "touch_root", input });
      return { sourceId: "touch-input", kind: "description", remoteVersion: "2026-07-26T00:00:02.000Z" };
    },
    async waitForSameConductorPreemptionCandidate(input) {
      calls.push({ kind: "wait_for_candidate", input });
      return { rootIssueId: "remaining-root-id", stageIssueId: "touched-execution", touchActivityId: "touch-activity" };
    },
    async waitForPlanApprovalRequest(input) {
      calls.push({ kind: "wait_for_plan_review", input });
      return { requestCommentId: `${input.rootIssueId}-request`, planIssueId: `${input.rootIssueId}-plan` };
    },
    async replyToHumanAction(input) {
      calls.push({ kind: "approve_plan_review", input });
    },
  };
  const rootCreation = { teamId: "team-1", projectId: "project-1", rootLabelId: "root-label", routingLabelId: "route-label", rootStatusId: "todo-state", conductorId: "conductor-a-id" };

  const result = await runSameConductorPreemptionCase({
    definition,
    human,
    rootCreationsByRootKey: rootCreations(definition, rootCreation),
  });

  const touch = definition.declaredUserInteractions.find(({ kind }) => kind === "touch_bound_root_description");
  assert.deepEqual(calls, [
    {
      kind: "wait_for_admission",
      input: { rootIssueIds: ["inflight-root-id", "touched-root-id", "remaining-root-id"] },
    },
    {
      kind: "touch_root",
      input: { rootIssueId: "remaining-root-id", description: touch.descriptionsByRootKey["remaining-root"] },
    },
    {
      kind: "wait_for_candidate",
      input: {
        inflightStageIssueId: "inflight-execution",
        touchedRootIssueId: "remaining-root-id",
        remainingRootIssueId: "touched-root-id",
      },
    },
    { kind: "wait_for_plan_review", input: { rootIssueId: "inflight-root-id" } },
    { kind: "wait_for_plan_review", input: { rootIssueId: "touched-root-id" } },
    { kind: "wait_for_plan_review", input: { rootIssueId: "remaining-root-id" } },
    { kind: "wait_for_plan_review", input: { rootIssueId: "low-priority-root-id" } },
    ...["inflight-root-id", "touched-root-id", "remaining-root-id", "low-priority-root-id"].map((rootIssueId) => ({
      kind: "approve_plan_review",
      input: { rootIssueId, requestCommentId: `${rootIssueId}-request`, body: "Approved." },
    })),
  ]);
  assert.deepEqual(result, {
    context: {
      humanActorId: "human-1",
      rootIssueIdsByKey: {
        "inflight-root": "inflight-root-id",
        "touched-root": "touched-root-id",
        "remaining-root": "remaining-root-id",
        "low-priority-root": "low-priority-root-id",
      },
      preemption: {
        inflightRootId: "inflight-root-id",
        touchedRootId: "remaining-root-id",
        remainingRootId: "touched-root-id",
        inflightStageIssueId: "inflight-execution",
        touchedStageIssueId: "touched-execution",
        touchedRootKey: "remaining-root",
        touchActivityId: "touch-activity",
        conductorId: "conductor-a-id",
        lowPriorityRootId: "low-priority-root-id",
      },
    },
  });
});

test("preemption Case rejects noncanonical definitions, incomplete same-Conductor bindings, and a candidate chosen outside the touched Root", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "same_conductor_preemption");
  const human = {
    actorId: "human-1",
    async waitForSameConductorPreemptionAdmission() {
      return { inflightRootIssueId: "inflight-root-id", inflightStageIssueId: "inflight-execution", readyRootIssueIds: ["remaining-root-id", "touched-root-id"] };
    },
    async updateRootDescription() { return { sourceId: "touch-input", kind: "description" }; },
    async waitForSameConductorPreemptionCandidate() {
      return { rootIssueId: "touched-root-id", stageIssueId: "remaining-execution", touchActivityId: "touch-activity" };
    },
    async waitForPlanApprovalRequest() { return { requestCommentId: "request-1", planIssueId: "plan-1" }; },
    async replyToHumanAction() {},
  };
  const rootCreationsByRootKey = rootCreations(definition, {
    teamId: "team-1", projectId: "project-1", rootLabelId: "root-label", routingLabelId: "route-label", rootStatusId: "todo-state", conductorId: "conductor-a-id",
  });

  await assert.rejects(
    runSameConductorPreemptionCase({ definition: { ...definition, caseId: "approved_happy_path" }, human, rootCreationsByRootKey }),
    hasCode("foreground_e2e_preemption_case_definition_invalid"),
  );
  await assert.rejects(
    runSameConductorPreemptionCase({ definition, human, rootCreationsByRootKey: { ...rootCreationsByRootKey, "remaining-root": { ...rootCreationsByRootKey["remaining-root"], conductorId: "conductor-b-id" } } }),
    hasCode("foreground_e2e_preemption_case_input_invalid"),
  );
  await assert.rejects(
    runSameConductorPreemptionCase({ definition, human, rootCreationsByRootKey }),
    hasCode("foreground_e2e_preemption_candidate_invalid"),
  );
});

test("preemption Case forwards cancellation to every native Linear Human operation", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "same_conductor_preemption");
  const abortController = new AbortController();
  const waits = [];
  const human = {
    actorId: "human-1",
    async waitForSameConductorPreemptionAdmission(input) {
      waits.push(input);
      return { inflightRootIssueId: "inflight-root-id", inflightStageIssueId: "inflight-execution", readyRootIssueIds: ["remaining-root-id", "touched-root-id"] };
    },
    async updateRootDescription() { return { sourceId: "touch-input", kind: "description" }; },
    async waitForSameConductorPreemptionCandidate(input) {
      waits.push(input);
      return { rootIssueId: "remaining-root-id", stageIssueId: "touched-execution", touchActivityId: "touch-activity" };
    },
    async waitForPlanApprovalRequest(input) {
      waits.push(input);
      return { requestCommentId: `${input.rootIssueId}-request`, planIssueId: `${input.rootIssueId}-plan` };
    },
    async replyToHumanAction() {},
  };

  await runSameConductorPreemptionCase({
    definition,
    human,
    signal: abortController.signal,
    rootCreationsByRootKey: rootCreations(definition, {
      teamId: "team-1", projectId: "project-1", rootLabelId: "root-label", routingLabelId: "route-label", rootStatusId: "todo-state", conductorId: "conductor-a-id",
    }),
  });

  assert.equal(waits.length, 6);
  assert.ok(waits.every(({ signal }) => signal === abortController.signal));
});

function rootCreations(definition, rootCreation) {
  return Object.fromEntries(definition.rootTopology.map(({ rootKey }, index) => [rootKey, {
    ...rootCreation,
    rootIssueId: `${rootKey}-id`,
    identifier: `ENG-${index + 1}`,
  }]));
}

function hasCode(code) {
  return (error) => error?.code === code;
}
