import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFactInput } from "../api/CanonicalFact.js";
import { CanonicalObservationPolicyImpl } from "../internal/CanonicalObservationPolicyImpl.js";

const provenance = { actorKind: "symphony" as const, observedAt: "2026-07-29T00:00:00.000Z" };

function inputs(): CanonicalFactInput[] {
  return [
    { value: { kind: "linear_status", statusId: "status-1", name: "Todo", category: "unstarted", position: 1 }, provenance },
    {
      value: {
        kind: "linear_issue",
        issueId: "issue-1",
        identifier: "SYM-1",
        projectId: "project-1",
        statusId: "status-1",
        statusName: "Todo",
        statusCategory: "unstarted",
        statusPosition: 1,
        order: 0,
        depth: 0,
        title: "Root",
        description: "Outcome",
        labels: ["Symphony: Root", "Conductor: alpha"],
        isArchived: false,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
      },
      provenance,
    },
    {
      value: {
        kind: "linear_comment",
        commentId: "comment-1",
        issueId: "issue-1",
        body: "hello",
        authorKind: "human",
        authorId: "user-1",
        threadRootCommentId: "comment-1",
        threadState: "unresolved",
        reactions: [
          { reactionId: "reaction-2", emoji: "x", actorKind: "human", actorId: "user-2" },
          { reactionId: "reaction-1", emoji: "check", actorKind: "symphony", actorId: "app-1" },
        ],
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
      },
      provenance: { ...provenance, actorKind: "human" },
    },
    { value: { kind: "linear_relation", relationId: "relation-1", relationKind: "blocks", sourceIssueId: "issue-1", targetIssueId: "issue-2" }, provenance },
    { value: { kind: "linear_attachment", attachmentId: "attachment-1", issueId: "issue-1", title: "PR", url: "https://example.test/pr/1", sourceType: "github", createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-29T00:00:00.000Z" }, provenance },
    { value: { kind: "linear_activity", activityId: "activity-1", issueId: "issue-1", activityKinds: ["labels_changed", "status_changed"], actorKind: "symphony", addedLabelIds: ["label-2", "label-1"], createdAt: "2026-07-29T00:00:00.000Z" }, provenance },
    { value: { kind: "git_worktree", rootIssueId: "issue-1", repositoryId: "repo-1", branch: "symphony/issue-1", headRevision: "abc123", baseRevision: "base123", isClean: true, changedPaths: [] }, provenance },
  ];
}

test("canonical observation covers every Root Tree and Git fact kind in identity order", () => {
  const policy = new CanonicalObservationPolicyImpl();
  const observation = policy.canonicalize(inputs().reverse());

  assert.deepEqual(observation.facts.map(({ identity }) => identity.sourceKind), [
    "git_worktree",
    "linear_activity",
    "linear_attachment",
    "linear_comment",
    "linear_issue",
    "linear_relation",
    "linear_status",
  ]);
  assert.ok(Object.isFrozen(observation));
  assert.ok(observation.facts.every(Object.isFrozen));
});

test("canonical observation is permutation-stable and normalizes unordered arrays", () => {
  const policy = new CanonicalObservationPolicyImpl();
  const forward = policy.canonicalize(inputs());
  const reverse = policy.canonicalize(inputs().reverse());

  assert.deepEqual(forward, reverse);
  const comment = forward.facts.find(({ value }) => value.kind === "linear_comment")?.value;
  assert.equal(comment?.kind, "linear_comment");
  if (comment?.kind === "linear_comment") {
    assert.deepEqual(comment.reactions.map(({ reactionId }) => reactionId), ["reaction-1", "reaction-2"]);
    assert.equal("parentCommentId" in comment, false);
  }
  const activity = forward.facts.find(({ value }) => value.kind === "linear_activity")?.value;
  assert.equal(activity?.kind, "linear_activity");
  if (activity?.kind === "linear_activity") {
    assert.deepEqual(activity.activityKinds, ["labels_changed", "status_changed"]);
    assert.deepEqual(activity.addedLabelIds, ["label-1", "label-2"]);
  }
});

test("canonical observation fails closed on duplicate identities and unknown variants", () => {
  const policy = new CanonicalObservationPolicyImpl();
  const issue = inputs().find(({ value }) => value.kind === "linear_issue");
  assert.ok(issue);
  assert.throws(() => policy.canonicalize([issue, issue]), /canonical_fact_identity_duplicate:linear_issue:issue-1/u);
  assert.throws(
    () => policy.canonicalize([{ value: { kind: "linear_unknown", sourceId: "x" }, provenance } as never]),
    /canonical_fact_kind_unsupported:linear_unknown/u,
  );
});
