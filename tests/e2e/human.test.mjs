import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
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
  assert.deepEqual(comment, { commentId: "comment-1", issueId: "root-1" });

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

test("Human Actor cannot expose or perform non-user workflow mutations", async () => {
  const fixture = createLinearFixture();
  const human = await createForegroundE2EHumanActor({
    apiKey: "human-api-key",
    expectedActorId: "human-1",
    createClient: () => fixture.client,
  });

  assert.deepEqual(Object.keys(human).sort(), [
    "addReaction",
    "createComment",
    "createRootIssue",
    "editComment",
    "reopenCommentThread",
    "resolveCommentThread",
    "setHumanActionTerminalStatus",
    "updateRootDescription",
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
    createIssuePayload: undefined,
    client: undefined,
  };
  fixture.client = {
    viewer: Promise.resolve({ id: "human-1" }),
    async createIssue(input) {
      calls.createIssue.push(input);
      if (fixture.createIssuePayload) return fixture.createIssuePayload;
      issues.set("root-1", issue({
        id: "root-1",
        identifier: "ENG-1",
        teamId: input.teamId,
        projectId: input.projectId,
        stateId: input.stateId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        labels: [{ id: input.labelIds[0], name: "symphony:conductor/abc123def456" }],
      }));
      return { success: true, issueId: "root-1" };
    },
    async updateIssue(issueId, input) {
      calls.updateIssue.push({ issueId, input });
      const target = issues.get(issueId);
      if (!target) return { success: false };
      Object.assign(target, input);
      return { success: true, issueId };
    },
    async issue(issueId) {
      const target = issues.get(issueId);
      if (!target) throw new Error("missing issue");
      return target;
    },
    async comment({ id }) {
      const target = comments.get(id);
      if (!target) throw new Error("missing comment");
      return target;
    },
    async createComment(input) {
      calls.createComment.push(input);
      const created = comment({ id: "comment-1", issueId: input.issueId, body: input.body, userId: "human-1" });
      comments.set(created.id, created);
      return { success: true, commentId: created.id, comment: Promise.resolve(created) };
    },
    async updateComment(commentId, input) {
      calls.updateComment.push({ commentId, input });
      const target = comments.get(commentId);
      if (!target) return { success: false };
      target.body = input.body;
      return { success: true, commentId, comment: Promise.resolve(target) };
    },
    async commentResolve(commentId) {
      calls.resolve.push(commentId);
      const target = comments.get(commentId);
      target.resolvedAt = new Date("2026-07-26T00:00:00.000Z");
      return { success: true, commentId, comment: Promise.resolve(target) };
    },
    async commentUnresolve(commentId) {
      calls.reopen.push(commentId);
      const target = comments.get(commentId);
      target.resolvedAt = undefined;
      return { success: true, commentId, comment: Promise.resolve(target) };
    },
    async createReaction(input) {
      calls.reactions.push(input);
      const target = comments.get(input.commentId);
      target.reactions.push({ id: "reaction-1", emoji: input.emoji, userId: "human-1" });
      return { success: true, reactionId: "reaction-1" };
    },
  };
  return fixture;
}

function issue({ id, identifier, teamId, projectId, stateId, title, description, priority, labels }) {
  return {
    id,
    identifier,
    teamId,
    projectId,
    stateId,
    title,
    description,
    priority,
    parentId: undefined,
    async labels() {
      return { nodes: labels, pageInfo: { hasNextPage: false } };
    },
  };
}

function comment({ id, issueId, body, userId }) {
  return { id, issueId, body, userId, parentId: undefined, resolvedAt: undefined, reactions: [] };
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
