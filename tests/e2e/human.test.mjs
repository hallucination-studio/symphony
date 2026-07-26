import assert from "node:assert/strict";
import test from "node:test";

import { bindSameConductorPreemptionRoles, FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { createForegroundE2EHumanActor } from "../../tools/e2e/human.mjs";

test("Human Actor performs only catalog-compatible user mutations with Linear read-back", async () => {
  const fixture = createLinearFixture();
  const revisionRoot = caseRoot("root_revision_and_comment", "revision-root");
  const revisionUpdate = caseInteraction("root_revision_and_comment", "update_root_description");
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });

  const root = await human.createRootIssue({
    caseId: "root_revision_and_comment",
    rootKey: "revision-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });
  assert.deepEqual(root, { rootIssueId: "root-1", identifier: "ENG-1" });
  assert.deepEqual(fixture.calls.createIssue, [{
    teamId: "team-1",
    projectId: "project-1",
    stateId: "todo-state",
    labelIds: ["route-label"],
    title: revisionRoot.title,
    description: revisionRoot.description,
    priority: 2,
  }]);

  await human.updateRootDescription({
    rootIssueId: root.rootIssueId,
    description: revisionUpdate.description,
  });
  assert.deepEqual(fixture.calls.updateIssue.at(0), {
    issueId: "root-1",
    input: { description: revisionUpdate.description },
  });

  const comment = await human.createComment({
    issueId: root.rootIssueId,
    body: "Please keep the public API focused.",
  });
  assert.equal(comment.commentId, "comment-1");
  assert.equal(comment.issueId, "root-1");
  assert.equal(comment.inputReference.kind, "comment_body");

  await human.editComment({
    issueId: root.rootIssueId,
    commentId: comment.commentId,
    body: "Please keep the public API focused and tested.",
  });
  await human.resolveCommentThread({ issueId: root.rootIssueId, threadRootCommentId: comment.commentId });
  await human.reopenCommentThread({ issueId: root.rootIssueId, threadRootCommentId: comment.commentId });
  const reaction = await human.addReaction({ issueId: root.rootIssueId, commentId: comment.commentId, emoji: "+1" });
  assert.deepEqual(reaction, { reactionId: "reaction-1", commentId: "comment-1", emoji: "+1" });

  await human.setHumanActionTerminalStatus({
    issueId: "human-action-1",
    terminalStatus: "Approved",
    stateId: "approved-state",
  });
  assert.deepEqual(fixture.calls.updateIssue.at(1), {
    issueId: "human-action-1",
    input: { stateId: "approved-state" },
  });
  assert.equal(fixture.comments.get("comment-1").resolvedAt, undefined);
  assert.deepEqual(fixture.comments.get("comment-1").reactions, [{ id: "reaction-1", emoji: "+1", userId: "human-1" }]);
});

test("Human Actor waits for exactly one product-created Plan Review Action beneath its declared Root", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const root = await human.createRootIssue({
    caseId: "approved_happy_path",
    rootKey: "approved-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });
  fixture.addPlanReviewAction(root.rootIssueId);

  const action = await human.waitForPlanReviewAction({ rootIssueId: root.rootIssueId, terminalStatus: "Approved" });

  assert.deepEqual(action, { actionIssueId: "plan-review-action-1", terminalStatusId: "approved-state" });
});

test("Human Actor ignores terminal Plan Review history and waits for the fresh requested Action", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const root = await human.createRootIssue({
    caseId: "plan_rejected_and_replanned",
    rootKey: "rejected-plan-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });
  fixture.addPlanReviewAction(root.rootIssueId, { actionId: "rejected-plan-review", stateId: "rejected-state" });
  fixture.addPlanReviewAction(root.rootIssueId, { actionId: "replacement-plan-review" });

  const action = await human.waitForPlanReviewAction({ rootIssueId: root.rootIssueId, terminalStatus: "Rejected" });

  assert.deepEqual(action, { actionIssueId: "replacement-plan-review", terminalStatusId: "rejected-state" });
});

test("Human Actor admits recovery only after it can read one affected in-flight Stage from the two declared Roots", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const affected = await human.createRootIssue({
    caseId: "conductor_restart_recovery",
    rootKey: "affected-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });
  const continuous = await human.createRootIssue({
    caseId: "conductor_restart_recovery",
    rootKey: "continuous-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });
  fixture.addRestartRecoveryExecution(affected.rootIssueId, "old-execution");

  const admission = await human.waitForRestartRecoveryAdmission({
    affectedRootIssueId: affected.rootIssueId,
    continuousRootIssueId: continuous.rootIssueId,
  });

  assert.deepEqual(admission, { affectedRootIssueId: affected.rootIssueId, oldStageExecutionId: "old-execution" });
});

test("Human Actor waits for exactly one product-created Clarification Action beneath its declared Root", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const root = await human.createRootIssue({
    caseId: "information_requested_and_answered",
    rootKey: "information-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });
  fixture.addClarificationAction(root.rootIssueId);

  const action = await human.waitForClarificationAction({ rootIssueId: root.rootIssueId, terminalStatus: "Answered" });

  assert.deepEqual(action, { actionIssueId: "clarification-action-1", terminalStatusId: "answered-state" });
});

test("Human Actor ignores terminal Clarification history and waits for the fresh requested Action", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const root = await human.createRootIssue({
    caseId: "information_requested_and_answered",
    rootKey: "information-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });
  fixture.addClarificationAction(root.rootIssueId, { actionId: "answered-clarification", stateId: "answered-state" });
  fixture.addClarificationAction(root.rootIssueId, { actionId: "fresh-clarification" });

  const action = await human.waitForClarificationAction({ rootIssueId: root.rootIssueId, terminalStatus: "Answered" });

  assert.deepEqual(action, { actionIssueId: "fresh-clarification", terminalStatusId: "answered-state" });
});

test("Human Actor fresh-reads the revision Plan gate and waits only for matching durable input receipts", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const root = await human.createRootIssue({
    caseId: "root_revision_and_comment",
    rootKey: "revision-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });
  fixture.addRevisionPlanGate(root.rootIssueId, {
    cycleId: "initial-cycle",
    planId: "initial-plan",
    planContractCommentId: "initial-contract-comment",
    planContractDigest: "initial-contract",
    actionId: "initial-review",
  });

  const initial = await human.waitForPlanContractAndPlanReviewAction({ rootIssueId: root.rootIssueId });
  assert.deepEqual(initial, {
    cycleIssueId: "initial-cycle",
    planIssueId: "initial-plan",
    planContractDigest: "initial-contract",
    planContractSourceCommentId: "initial-contract-comment",
    planReviewActionIssueId: "initial-review",
  });

  const description = await human.updateRootDescription({
    rootIssueId: root.rootIssueId,
    description: caseInteraction("root_revision_and_comment", "update_root_description").description,
  });
  fixture.addRootDescriptionDirectiveReceipt(root.rootIssueId, description);
  await human.waitForRootDescriptionReceipt({ rootIssueId: root.rootIssueId, inputReference: description });

  const created = await human.createComment({
    issueId: root.rootIssueId,
    body: "The original helper name no longer matches the requirement.",
  });
  fixture.addCommentReceipt(created.commentId, created.inputReference, { reaction: "check" });
  await human.waitForCommentReceipt({ issueId: root.rootIssueId, inputReference: created.inputReference });

  const edited = await human.editComment({
    issueId: root.rootIssueId,
    commentId: created.commentId,
    body: "The original helper name no longer matches the revised requirement.",
  });
  fixture.addCommentReceipt(edited.commentId, edited.inputReference, { reaction: "cross" });
  await human.waitForCommentReceipt({ issueId: root.rootIssueId, inputReference: edited.inputReference });

  const resolved = await human.resolveCommentThread({ issueId: root.rootIssueId, threadRootCommentId: created.commentId });
  fixture.addCommentReceipt(created.commentId, resolved, { threadAction: "resolve" });
  await human.waitForCommentThreadReceipt({ issueId: root.rootIssueId, inputReference: resolved });

  const reopened = await human.reopenCommentThread({ issueId: root.rootIssueId, threadRootCommentId: created.commentId });
  fixture.addCommentReceipt(created.commentId, reopened, { threadAction: "reopen" });
  await human.waitForCommentThreadReceipt({ issueId: root.rootIssueId, inputReference: reopened });

  fixture.addRevisionPlanGate(root.rootIssueId, {
    cycleId: "successor-cycle",
    planId: "successor-plan",
    planContractCommentId: "successor-contract-comment",
    planContractDigest: "successor-contract",
    actionId: "successor-review",
  });
  const successor = await human.waitForSuccessorPlanContractAndPlanReviewAction({
    rootIssueId: root.rootIssueId,
    priorCycleIssueId: initial.cycleIssueId,
    priorPlanReviewActionIssueId: initial.planReviewActionIssueId,
  });
  assert.deepEqual(successor, {
    cycleIssueId: "successor-cycle",
    planIssueId: "successor-plan",
    planContractDigest: "successor-contract",
    planContractSourceCommentId: "successor-contract-comment",
    planReviewActionIssueId: "successor-review",
  });
});

test("Human Actor derives distinct bounded receipt identities for full-length comment IDs", async () => {
  const fixture = createLinearFixture();
  fixture.commentId = "c".repeat(128);
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const root = await human.createRootIssue({
    caseId: "approved_happy_path",
    rootKey: "approved-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });

  const created = await human.createComment({ issueId: root.rootIssueId, body: "Keep the helper focused." });
  const edited = await human.editComment({ issueId: root.rootIssueId, commentId: created.commentId, body: "Keep the helper focused and tested." });

  assert.match(created.inputReference.sourceId, /^input:[a-f0-9]{64}$/u);
  assert.match(edited.inputReference.sourceId, /^input:[a-f0-9]{64}$/u);
  assert.notEqual(created.inputReference.sourceId, edited.inputReference.sourceId);
});

test("Human Actor rejects a Plan Review Action created by the Human actor", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const root = await human.createRootIssue({
    caseId: "approved_happy_path",
    rootKey: "approved-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });
  fixture.addPlanReviewAction(root.rootIssueId, { actionCreatorId: "human-1" });

  await assert.rejects(
    human.waitForPlanReviewAction({ rootIssueId: root.rootIssueId, terminalStatus: "Approved" }),
    hasCode("foreground_e2e_human_plan_review_creator_invalid"),
  );
});

test("Human Actor rejects a Clarification Action created by the Human actor", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const root = await human.createRootIssue({
    caseId: "information_requested_and_answered",
    rootKey: "information-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });
  fixture.addClarificationAction(root.rootIssueId, { actionCreatorId: "human-1" });

  await assert.rejects(
    human.waitForClarificationAction({ rootIssueId: root.rootIssueId, terminalStatus: "Answered" }),
    hasCode("foreground_e2e_human_clarification_creator_invalid"),
  );
});

test("Human Actor cannot expose or perform non-user workflow mutations", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });

  assert.deepEqual(Object.keys(human).sort(), [
    "actorId",
    "addReaction",
    "createComment",
    "createRootIssue",
    "editComment",
    "reopenCommentThread",
    "resolveCommentThread",
    "setHumanActionTerminalStatus",
    "updateRootDescription",
    "waitForClarificationAction",
    "waitForCommentReceipt",
    "waitForCommentThreadReceipt",
    "waitForPlanContractAndPlanReviewAction",
    "waitForPlanReviewAction",
    "waitForRestartRecoveryAdmission",
    "waitForRootDescriptionReceipt",
    "waitForSameConductorPreemptionAdmission",
    "waitForSameConductorPreemptionCandidate",
    "waitForSuccessorPlanContractAndPlanReviewAction",
  ]);
  assert.equal("createHumanAction" in human, false);
  assert.equal("writeManagedRecord" in human, false);
  assert.equal("mutatePlan" in human, false);
  assert.equal("client" in human, false);

  await assert.rejects(
    human.setHumanActionTerminalStatus({
      issueId: "plan-1",
      terminalStatus: "Approved",
      stateId: "approved-state",
    }),
    hasCode("foreground_e2e_human_action_target_invalid"),
  );
  await assert.rejects(
    human.updateRootDescription({ rootIssueId: "plan-1", description: "must not mutate a Plan" }),
    hasCode("foreground_e2e_human_root_target_invalid"),
  );
  await assert.rejects(
    human.editComment({ issueId: "human-action-1", commentId: "unmanaged-comment", body: "must not edit system comment" }),
    hasCode("foreground_e2e_human_comment_target_invalid"),
  );
  assert.deepEqual(fixture.calls.updateIssue, []);
});

test("Human Actor rejects a failed Linear write or mismatched actor identity", async () => {
  const fixture = createLinearFixture();
  await assert.rejects(
    createForegroundE2EHumanActor({
      apiKey: "human-api-key",
      expectedActorId: "another-actor",
      createClient: () => fixture.client,
    }),
    hasCode("foreground_e2e_human_actor_identity_invalid"),
  );

  fixture.createIssuePayload = { success: false };
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  await assert.rejects(
    human.createRootIssue({
      caseId: "approved_happy_path",
      rootKey: "approved-root",
      teamId: "team-1",
      projectId: "project-1",
      routingLabelId: "route-label",
      rootStatusId: "todo-state",
    }),
    hasCode("foreground_e2e_human_root_create_failed"),
  );
});

test("Human Actor accepts Root description changes only when the Case catalog predeclares the exact delta", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const root = await human.createRootIssue({
    caseId: "approved_happy_path",
    rootKey: "approved-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });

  await assert.rejects(
    human.updateRootDescription({ rootIssueId: root.rootIssueId, description: "A runtime-generated rewrite." }),
    hasCode("foreground_e2e_human_root_update_not_declared"),
  );
  assert.deepEqual(fixture.calls.updateIssue, []);
});

test("Human Actor accepts only the predeclared description for a bound preemption Root", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const root = await human.createRootIssue({
    caseId: "same_conductor_preemption",
    rootKey: "remaining-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  });
  const binding = bindSameConductorPreemptionRoles({
    inflightRootKeys: ["inflight-root"],
    readyRootKeys: ["remaining-root", "touched-root"],
  });
  assert.equal(binding.touchedRootKey, "remaining-root");

  await human.updateRootDescription({ rootIssueId: root.rootIssueId, description: binding.touchDescription });
  assert.deepEqual(fixture.calls.updateIssue, [{
    issueId: root.rootIssueId,
    input: { description: binding.touchDescription },
  }]);
});

test("Human Actor observes same-Conductor preemption from native facts despite system-owned activity", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "same_conductor_preemption");
  const rootsByKey = Object.fromEntries(await Promise.all(definition.rootTopology.map(async ({ rootKey }) => [rootKey, await human.createRootIssue({
    caseId: definition.caseId,
    rootKey,
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  })])));
  for (const { rootIssueId } of Object.values(rootsByKey)) {
    fixture.addManagedRecord(rootIssueId, {
      kind: "root_ownership",
      version: 1,
      root_issue_id: rootIssueId,
      conductor_id: "conductor-1",
    });
  }
  fixture.addManagedRecord(rootsByKey["inflight-root"].rootIssueId, {
    kind: "stage_execution",
    version: 1,
    root_issue_id: rootsByKey["inflight-root"].rootIssueId,
    stage_execution_id: "inflight-execution",
    started_at: "2026-07-26T00:00:00.000Z",
  });
  fixture.issues.get(rootsByKey["inflight-root"].rootIssueId).historyEntries.push({
    id: "system-activity",
    issueId: rootsByKey["inflight-root"].rootIssueId,
    actorId: null,
    createdAt: new Date("2026-07-26T00:00:00.000Z"),
    updatedAt: new Date("2026-07-26T00:00:00.000Z"),
  });

  const admission = await human.waitForSameConductorPreemptionAdmission({
    rootIssueIds: definition.rootTopology.map(({ rootKey }) => rootsByKey[rootKey].rootIssueId),
  });
  assert.equal(admission.inflightRootIssueId, rootsByKey["inflight-root"].rootIssueId);
  const roles = bindSameConductorPreemptionRoles({
    inflightRootKeys: ["inflight-root"],
    readyRootKeys: ["touched-root", "remaining-root"],
  });
  const touchedRootIssueId = rootsByKey[roles.touchedRootKey].rootIssueId;
  const remainingRootIssueId = rootsByKey[roles.remainingRootKey].rootIssueId;
  await human.updateRootDescription({ rootIssueId: touchedRootIssueId, description: roles.touchDescription });
  fixture.addManagedRecord(rootsByKey["inflight-root"].rootIssueId, {
    kind: "stage_result",
    version: 1,
    root_issue_id: rootsByKey["inflight-root"].rootIssueId,
    result_id: admission.inflightStageExecutionId,
    completed_at: "2026-07-26T00:00:02.000Z",
  });
  fixture.addManagedRecord(touchedRootIssueId, {
    kind: "stage_execution",
    version: 1,
    root_issue_id: touchedRootIssueId,
    stage_execution_id: "touched-execution",
    started_at: "2026-07-26T00:00:03.000Z",
  });

  const candidate = await human.waitForSameConductorPreemptionCandidate({
    inflightStageExecutionId: admission.inflightStageExecutionId,
    touchedRootIssueId,
    remainingRootIssueId,
  });
  assert.deepEqual(candidate, {
    rootIssueId: touchedRootIssueId,
    stageExecutionId: "touched-execution",
    touchActivityId: "history-1",
  });
});

test("Human Actor creates each frozen Case Root at most once", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });
  const input = {
    caseId: "approved_happy_path",
    rootKey: "approved-root",
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
  };

  await human.createRootIssue(input);
  await assert.rejects(human.createRootIssue(input), hasCode("foreground_e2e_human_root_create_not_declared"));
  assert.equal(fixture.calls.createIssue.length, 1);
});

function createLinearFixture() {
  const calls = { createIssue: [], updateIssue: [], createComment: [], updateComment: [], resolve: [], reopen: [], reactions: [] };
  const productCycles = [];
  let sequence = 0;
  let rootSequence = 0;
  let managedRecordSequence = 0;
  const comments = new Map([
    ["unmanaged-comment", comment({ id: "unmanaged-comment", issueId: "human-action-1", body: "Managed reply", userId: "symphony-1" })],
  ]);
  const issues = new Map([
    ["human-action-1", issue({
      id: "human-action-1",
      teamId: "team-1",
      projectId: "project-1",
      stateId: "todo-state",
      title: "Approve plan",
      description: "Approve the plan.",
      priority: 2,
      labels: [{ id: "human-label", name: "Human Action" }, { id: "plan-review-label", name: "Plan Review" }],
    })],
    ["plan-1", issue({
      id: "plan-1",
      teamId: "team-1",
      projectId: "project-1",
      stateId: "planning-state",
      title: "Plan",
      description: "System owned plan.",
      priority: 2,
      labels: [{ id: "plan-label", name: "Plan" }],
    })],
  ]);
  const fixture = {
    calls,
    comments,
    issues,
    commentId: "comment-1",
    createIssuePayload: undefined,
    client: undefined,
    addManagedRecord(issueId, value) {
      managedRecordSequence += 1;
      const created = comment({
        id: `managed-record-${managedRecordSequence}`,
        issueId,
        body: record(value),
        userId: "symphony-1",
      });
      comments.set(created.id, created);
      bindCommentChildren(created);
    },
    addRevisionPlanGate(rootIssueId, {
      cycleId,
      planId,
      planContractCommentId,
      planContractDigest,
      actionId,
    }) {
      const root = issues.get(rootIssueId);
      const cycle = issue({
        id: cycleId,
        teamId: "team-1",
        projectId: "project-1",
        stateId: "planning-state",
        title: "Cycle",
        description: "Product-created Cycle.",
        priority: 2,
        creatorId: "symphony-1",
        labels: [{ id: "cycle-label", name: "Cycle" }],
      });
      const plan = issue({
        id: planId,
        teamId: "team-1",
        projectId: "project-1",
        stateId: "planning-state",
        title: "Plan",
        description: "Product-created Plan.",
        priority: 2,
        creatorId: "symphony-1",
        labels: [{ id: "plan-label", name: "Plan" }],
      });
      const action = issue({
        id: actionId,
        teamId: "team-1",
        projectId: "project-1",
        stateId: "todo-state",
        title: "Approve the Plan Contract",
        description: "## Plan Contract\n\nReview the Plan Contract.\n\n## Available outcomes\nApproved: accept this exact Plan Contract.\nRejected: add a fresh comment explaining why.",
        priority: 2,
        creatorId: "symphony-1",
        labels: [{ id: "human-label", name: "Human Action" }, { id: "plan-review-label", name: "Plan Review" }],
      });
      cycle.parentId = rootIssueId;
      plan.parentId = cycleId;
      action.parentId = cycleId;
      cycle.children = async () => ({ nodes: [plan, action], pageInfo: { hasNextPage: false } });
      productCycles.push(cycle);
      root.children = async () => ({ nodes: productCycles, pageInfo: { hasNextPage: false } });
      issues.set(cycleId, cycle);
      issues.set(planId, plan);
      issues.set(actionId, action);
      bindIssueComments(plan);
      const contract = comment({
        id: planContractCommentId,
        issueId: planId,
        body: record({ kind: "plan_contract", root_issue_id: rootIssueId, cycle_issue_id: cycleId, plan_contract_digest: planContractDigest }),
        userId: "symphony-1",
      });
      comments.set(contract.id, contract);
      bindCommentChildren(contract);
    },
    addRootDescriptionDirectiveReceipt(rootIssueId, inputReference) {
      const directive = comment({
        id: `directive-${comments.size + 1}`,
        issueId: rootIssueId,
        body: record({ kind: "root_directive", root_issue_id: rootIssueId, consumed_input_ids: [inputReference.sourceId] }),
        userId: "symphony-1",
      });
      comments.set(directive.id, directive);
      bindCommentChildren(directive);
    },
    addRestartRecoveryExecution(rootIssueId, stageExecutionId) {
      const execution = comment({
        id: `execution-${comments.size + 1}`,
        issueId: rootIssueId,
        body: record({
          kind: "stage_execution",
          root_issue_id: rootIssueId,
          stage_execution_id: stageExecutionId,
        }),
        userId: "symphony-1",
      });
      comments.set(execution.id, execution);
      bindCommentChildren(execution);
    },
    addCommentReceipt(commentId, inputReference, { reaction = "none", threadAction = "keep_open" } = {}) {
      const source = comments.get(commentId);
      source.reactions = source.reactions.filter((candidate) =>
        candidate.userId !== "symphony-1" || (candidate.emoji !== "✅" && candidate.emoji !== "❌"));
      if (reaction === "check") source.reactions.push({ id: `receipt-${comments.size + 1}`, emoji: "✅", userId: "symphony-1" });
      if (reaction === "cross") source.reactions.push({ id: `receipt-${comments.size + 1}`, emoji: "❌", userId: "symphony-1" });
      const reply = comment({
        id: `reply-${comments.size + 1}`,
        issueId: source.issueId,
        parentId: source.id,
        body: record({
          kind: "root_reconciler_reply",
          source_input_id: inputReference.sourceId,
          target_issue_id: source.issueId,
          source: inputReference.kind === "comment_body"
            ? { kind: "comment_body", comment_id: inputReference.commentId, comment_body_digest: inputReference.commentBodyDigest }
            : {
              kind: "comment_thread_state",
              comment_id: inputReference.commentId,
              comment_remote_version: inputReference.remoteVersion,
              thread_root_comment_id: inputReference.threadRootCommentId,
              thread_state: inputReference.expectedThreadState,
            },
          reaction,
          thread_action: threadAction,
        }),
        userId: "symphony-1",
      });
      comments.set(reply.id, reply);
      bindCommentChildren(reply);
    },
    addPlanReviewAction(rootIssueId, {
      actionCreatorId = "symphony-1",
      actionId = `plan-review-action-${productCycles.length + 1}`,
      stateId = "todo-state",
    } = {}) {
      const root = issues.get(rootIssueId);
      const cycleId = `cycle-${productCycles.length + 1}`;
      const cycle = issue({
        id: cycleId,
        teamId: "team-1",
        projectId: "project-1",
        stateId: "planning-state",
        title: "Cycle",
        description: "Product-created Cycle.",
        priority: 2,
        creatorId: "symphony-1",
        labels: [{ id: "cycle-label", name: "Cycle" }],
      });
      const action = issue({
        id: actionId,
        teamId: "team-1",
        projectId: "project-1",
        stateId,
        title: "Approve the Plan Contract",
        description: "## Plan Contract\n\nReview the Plan Contract.\n\n## Available outcomes\nApproved: accept this exact Plan Contract.\nRejected: add a fresh comment explaining why.",
        priority: 2,
        creatorId: actionCreatorId,
        labels: [{ id: "human-label", name: "Human Action" }, { id: "plan-review-label", name: "Plan Review" }],
      });
      cycle.parentId = rootIssueId;
      action.parentId = cycle.id;
      productCycles.push(cycle);
      root.children = async () => ({ nodes: productCycles, pageInfo: { hasNextPage: false } });
      cycle.children = async () => ({ nodes: [action], pageInfo: { hasNextPage: false } });
      issues.set(cycle.id, cycle);
      issues.set(action.id, action);
    },
    addClarificationAction(rootIssueId, {
      actionCreatorId = "symphony-1",
      actionId = `clarification-action-${productCycles.length + 1}`,
      stateId = "todo-state",
    } = {}) {
      const root = issues.get(rootIssueId);
      const cycleId = `cycle-${productCycles.length + 1}`;
      const cycle = issue({
        id: cycleId,
        teamId: "team-1",
        projectId: "project-1",
        stateId: "planning-state",
        title: "Cycle",
        description: "Product-created Cycle.",
        priority: 2,
        creatorId: "symphony-1",
        labels: [{ id: "cycle-label", name: "Cycle" }],
      });
      const action = issue({
        id: actionId,
        teamId: "team-1",
        projectId: "project-1",
        stateId,
        title: "Provide the separator",
        description: "## Symphony Human Action\n\n## Requested action\nProvide the separator.\n\n## What is being reviewed or requested\nWhich separator should be used?\n\n## Available outcomes\n- Answered: provide the requested information in a fresh comment, then set this Action to Answered.\n\n## Comment requirement\nA fresh comment is required before resolving this Action.\n\n## What happens next\nAfter any terminal status, the durable Action result is sent to the Root Reconciler.",
        priority: 2,
        creatorId: actionCreatorId,
        labels: [{ id: "human-label", name: "Human Action" }, { id: "clarification-label", name: "Clarification" }],
      });
      cycle.parentId = rootIssueId;
      action.parentId = cycle.id;
      productCycles.push(cycle);
      root.children = async () => ({ nodes: productCycles, pageInfo: { hasNextPage: false } });
      cycle.children = async () => ({ nodes: [action], pageInfo: { hasNextPage: false } });
      issues.set(cycle.id, cycle);
      issues.set(action.id, action);
    },
  };
  fixture.client = {
    viewer: Promise.resolve({ id: "human-1" }),
    async createIssue(input) {
      calls.createIssue.push(input);
      if (fixture.createIssuePayload) return fixture.createIssuePayload;
      rootSequence += 1;
      const rootId = `root-${rootSequence}`;
      issues.set(rootId, issue({
        id: rootId,
        identifier: `ENG-${rootSequence}`,
        teamId: input.teamId,
        projectId: input.projectId,
        stateId: input.stateId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        labels: [{ id: input.labelIds[0], name: "symphony:conductor/abc123def456" }],
      }));
      bindIssueComments(issues.get(rootId));
      return { success: true, issueId: rootId };
    },
    async updateIssue(issueId, input) {
      calls.updateIssue.push({ issueId, input });
      const target = issues.get(issueId);
      if (!target) return { success: false };
      Object.assign(target, input);
      target.updatedAt = nextTimestamp();
      if (input.description !== undefined) {
        target.historyEntries.push({
          id: `history-${target.historyEntries.length + 1}`,
          issueId,
          actorId: "human-1",
          createdAt: target.updatedAt,
          updatedAt: target.updatedAt,
          updatedDescription: true,
        });
      }
      return { success: true, issueId };
    },
    async issue(issueId) {
      const target = issues.get(issueId);
      if (!target) throw new Error("missing issue");
      return target;
    },
    async team(teamId) {
      if (teamId !== "team-1") throw new Error("missing team");
      return {
        id: "team-1",
        async states() {
          return {
            nodes: [
              { id: "todo-state", name: "Todo", archivedAt: null },
              { id: "approved-state", name: "Approved", archivedAt: null },
              { id: "rejected-state", name: "Rejected", archivedAt: null },
              { id: "answered-state", name: "Answered", archivedAt: null },
            ],
            pageInfo: { hasNextPage: false },
          };
        },
      };
    },
    async comment({ id }) {
      const target = comments.get(id);
      if (!target) throw new Error("missing comment");
      return target;
    },
    async createComment(input) {
      calls.createComment.push(input);
      const created = comment({ id: fixture.commentId, issueId: input.issueId, body: input.body, userId: "human-1" });
      comments.set(created.id, created);
      bindCommentChildren(created);
      return { success: true, commentId: created.id, comment: Promise.resolve(created) };
    },
    async updateComment(commentId, input) {
      calls.updateComment.push({ commentId, input });
      const target = comments.get(commentId);
      if (!target) return { success: false };
      target.body = input.body;
      target.editedAt = nextTimestamp();
      target.updatedAt = nextTimestamp();
      return { success: true, commentId, comment: Promise.resolve(target) };
    },
    async commentResolve(commentId) {
      calls.resolve.push(commentId);
      const target = comments.get(commentId);
      target.resolvedAt = nextTimestamp();
      target.updatedAt = nextTimestamp();
      return { success: true, commentId, comment: Promise.resolve(target) };
    },
    async commentUnresolve(commentId) {
      calls.reopen.push(commentId);
      const target = comments.get(commentId);
      target.resolvedAt = undefined;
      target.updatedAt = nextTimestamp();
      return { success: true, commentId, comment: Promise.resolve(target) };
    },
    async createReaction(input) {
      calls.reactions.push(input);
      const target = comments.get(input.commentId);
      target.reactions.push({ id: "reaction-1", emoji: input.emoji, userId: "human-1" });
      return { success: true, reactionId: "reaction-1" };
    },
  };
  function nextTimestamp() {
    sequence += 1;
    return new Date(`2026-07-26T00:00:${String(sequence).padStart(2, "0")}.000Z`);
  }
  function bindIssueComments(target) {
    target.comments = async () => ({
      nodes: [...comments.values()].filter((candidate) => candidate.issueId === target.id && !candidate.parentId),
      pageInfo: { hasNextPage: false },
    });
  }
  function bindCommentChildren(target) {
    target.children = async () => ({
      nodes: [...comments.values()].filter((candidate) => candidate.parentId === target.id),
      pageInfo: { hasNextPage: false },
    });
  }
  return fixture;
}

function issue({ id, identifier, teamId, projectId, stateId, title, description, priority, creatorId, labels }) {
  return {
    id,
    identifier,
    teamId,
    projectId,
    stateId,
    title,
    description,
    priority,
    creatorId,
    parentId: undefined,
    updatedAt: new Date("2026-07-26T00:00:00.000Z"),
    historyEntries: [],
    async labels() {
      return { nodes: labels, pageInfo: { hasNextPage: false } };
    },
    async children() {
      return { nodes: [], pageInfo: { hasNextPage: false } };
    },
    async history() {
      return { nodes: this.historyEntries, pageInfo: { hasNextPage: false } };
    },
  };
}

function comment({ id, issueId, body, userId, parentId = undefined }) {
  return {
    id,
    issueId,
    body,
    userId,
    parentId,
    createdAt: new Date("2026-07-26T00:00:00.000Z"),
    updatedAt: new Date("2026-07-26T00:00:00.000Z"),
    resolvedAt: undefined,
    reactions: [],
  };
}

function record(value) {
  return `\`\`\`symphony\n${JSON.stringify({ version: 1, ...value })}\n\`\`\``;
}

function hasCode(code) {
  return (error) => error?.code === code;
}

function caseRoot(caseId, rootKey) {
  const definition = FOREGROUND_E2E_CASES.find((candidate) => candidate.caseId === caseId);
  const root = definition.rootCreationInputs.find((candidate) => candidate.rootKey === rootKey);
  return root;
}

function caseInteraction(caseId, kind) {
  const definition = FOREGROUND_E2E_CASES.find((candidate) => candidate.caseId === caseId);
  return definition.declaredUserInteractions.find((candidate) => candidate.kind === kind);
}
