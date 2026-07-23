import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { buildRootObservationInputs } from "../internal/RootObservationInputs.js";

test("observation inputs preserve every Cycle and only expose unhandled human comments", () => {
  const tree = fixture();
  const inputs = buildRootObservationInputs({
    tree,
    handledCommentVersions: new Set(["comment-replied:2026-07-23T00:00:02Z"]),
  });

  assert.deepEqual(inputs.cycles.map((cycle) => ({
    id: cycle.cycleIssue.issue_id,
    archived: cycle.isArchived,
    issues: cycle.issues.map((issue) => issue.issue_id),
    comments: cycle.comments.map((comment) => comment.comment_id),
  })), [
    { id: "cycle-1", archived: true, issues: ["plan-1"], comments: ["comment-archived"] },
    { id: "cycle-2", archived: false, issues: ["work-2"], comments: ["comment-replied", "comment-work"] },
  ]);
  assert.deepEqual(inputs.pendingUserComments, [{
    commentId: "comment-work",
    commentVersion: "2026-07-23T00:00:03Z",
    issueId: "work-2",
    issueKind: "work",
    cycleIssueId: "cycle-2",
    authorUserId: "user-2",
    body: "Please rerun this check.",
    createdAt: "2026-07-23T00:00:02Z",
    updatedAt: "2026-07-23T00:00:03Z",
  }, {
    commentId: "comment-archived",
    commentVersion: "2026-07-23T00:00:04Z",
    issueId: "cycle-1",
    issueKind: "cycle",
    cycleIssueId: "cycle-1",
    authorUserId: "user-1",
    body: "The archived attempt is still relevant.",
    createdAt: "2026-07-23T00:00:03Z",
    updatedAt: "2026-07-23T00:00:04Z",
  }]);
});

test("observation input construction fails closed when a human comment has no user identity", () => {
  const tree = fixture();
  delete tree.comments[0]!.author_user_id;
  assert.throws(
    () => buildRootObservationInputs({ tree }),
    /root_user_comment_actor_missing/u,
  );
});

test("observation inputs expose Root and Cycle Human Actions from direct parents and labels", () => {
  const tree = fixture();
  const rootAction = Object.assign(issueForTest({
    issue_id: "root-action",
    issue_kind: "human",
    title: "Convergence decision",
    parent_issue_id: "root-1",
    depth: 1,
  }), { labels: ["Human Action", "Convergence Override"] });
  const cycleAction = Object.assign(issueForTest({
    issue_id: "cycle-action",
    issue_kind: "human",
    title: "Approve the plan",
    parent_issue_id: "cycle-2",
    depth: 2,
  }), { labels: ["Human Action", "Plan Review"] });
  tree.issues.push(rootAction, cycleAction);
  tree.relations.push({
    relation_id: "relation-action-work",
    relation_kind: "blocks",
    source_issue_id: "cycle-action",
    target_issue_id: "work-2",
  });

  const inputs = buildRootObservationInputs({ tree }) as typeof buildRootObservationInputs extends (...args: never[]) => infer _
    ? ReturnType<typeof buildRootObservationInputs> & {
      rootHumanActions?: unknown;
    }
    : never;

  assert.deepEqual(inputs.rootHumanActions, [{
    actionId: "root-action",
    actionIssueId: "root-action",
    actionKind: "convergence_override",
    parentScope: "root",
    status: "In Progress",
    isArchived: false,
    relatedIssueIds: [],
  }]);
  assert.deepEqual((inputs.cycles.find(({ cycleIssue }) => cycleIssue.issue_id === "cycle-2") as unknown as {
    humanActionRecords?: unknown;
  }).humanActionRecords, [{
    actionId: "cycle-action",
    actionIssueId: "cycle-action",
    actionKind: "plan_review",
    parentScope: "cycle",
    cycleIssueId: "cycle-2",
    status: "In Progress",
    isArchived: false,
    relatedIssueIds: ["work-2"],
  }]);
});

function issueForTest(
  input: Partial<LinearWorkflowTreeSnapshot["issues"][number]> &
    Pick<LinearWorkflowTreeSnapshot["issues"][number], "issue_id" | "issue_kind" | "title">,
) {
  return {
    identifier: input.issue_id,
    project_id: "project-1",
    status_id: "status-1",
    status_name: "In Progress",
    status_category: "started" as const,
    status_position: 1,
    order: 1,
    depth: 0,
    description: input.title,
    labels: [],
    is_archived: false,
    remote_version: `${input.issue_id}:v1`,
    updated_at: "2026-07-23T00:00:00Z",
    ...input,
  };
}

function fixture(): LinearWorkflowTreeSnapshot {
  const issue = (input: Partial<LinearWorkflowTreeSnapshot["issues"][number]> & Pick<LinearWorkflowTreeSnapshot["issues"][number], "issue_id" | "issue_kind" | "title">) => ({
    identifier: input.issue_id,
    project_id: "project-1",
    status_id: "status-1",
    status_name: "In Progress",
    status_category: "started" as const,
    status_position: 1,
    order: 1,
    depth: 0,
    description: input.title,
    labels: [],
    is_archived: false,
    remote_version: `${input.issue_id}:v1`,
    updated_at: "2026-07-23T00:00:00Z",
    ...input,
  });
  const comment = (input: Partial<LinearWorkflowTreeSnapshot["comments"][number]> & Pick<LinearWorkflowTreeSnapshot["comments"][number], "comment_id" | "issue_id" | "body">) => ({
    author_kind: "human" as const,
    author_id: "user-1",
    author_user_id: "user-1",
    created_at: "2026-07-23T00:00:00Z",
    remote_version: "2026-07-23T00:00:01Z",
    updated_at: "2026-07-23T00:00:01Z",
    ...input,
  });
  return {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "status-1", name: "In Progress", category: "started", position: 1 }],
    issues: [
      issue({ issue_id: "root-1", issue_kind: "root", title: "Root", depth: 0 }),
      issue({ issue_id: "cycle-1", issue_kind: "cycle", title: "Archived cycle", parent_issue_id: "root-1", depth: 1, is_archived: true }),
      issue({ issue_id: "plan-1", issue_kind: "plan", title: "Plan", parent_issue_id: "cycle-1", depth: 2, is_archived: true }),
      issue({ issue_id: "cycle-2", issue_kind: "cycle", title: "Active cycle", parent_issue_id: "root-1", depth: 1 }),
      issue({ issue_id: "work-2", issue_kind: "work", title: "Work", parent_issue_id: "cycle-2", depth: 2 }),
    ],
    comments: [
      comment({ comment_id: "comment-replied", issue_id: "work-2", body: "Already handled", author_user_id: "user-2", author_id: "user-2", remote_version: "2026-07-23T00:00:02Z", updated_at: "2026-07-23T00:00:02Z" }),
      comment({ comment_id: "comment-work", issue_id: "work-2", body: "Please rerun this check.", author_user_id: "user-2", author_id: "user-2", remote_version: "2026-07-23T00:00:03Z", updated_at: "2026-07-23T00:00:03Z", created_at: "2026-07-23T00:00:02Z" }),
      comment({ comment_id: "comment-archived", issue_id: "cycle-1", body: "The archived attempt is still relevant.", author_user_id: "user-1", author_id: "user-1", remote_version: "2026-07-23T00:00:04Z", updated_at: "2026-07-23T00:00:04Z", created_at: "2026-07-23T00:00:03Z" }),
      comment({ comment_id: "comment-managed", issue_id: "root-1", body: "Managed", author_kind: "human", managed_marker: "root-1:managed-record:reply", remote_version: "2026-07-23T00:00:05Z", updated_at: "2026-07-23T00:00:05Z" }),
      comment({ comment_id: "comment-symphony", issue_id: "root-1", body: "System", author_kind: "symphony", author_id: "symphony-bot", author_user_id: "symphony-bot", remote_version: "2026-07-23T00:00:06Z", updated_at: "2026-07-23T00:00:06Z" }),
    ],
    relations: [{ relation_id: "relation-1", relation_kind: "blocks", source_issue_id: "work-2", target_issue_id: "cycle-2" }],
    observed_at: "2026-07-23T00:00:10Z",
  };
}
