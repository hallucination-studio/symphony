import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { humanActionSummaryStatus } from "../api/HumanActionSummary.js";

test("an edited human reply reactivates a resolved Human Action", () => {
  const tree = workflowTree([
    request("approval-request", "plan_approval", "resolved"),
    humanReply("approval-reply", "approval-request", "2026-07-24T00:03:00Z"),
    resolution("approval-resolution", "approval-reply", "approval-request", "2026-07-24T00:02:00Z"),
  ]);

  assert.equal(humanActionSummaryStatus(tree, "root-1"), "Needs Approval");

  tree.comments.find(({ comment_id }) => comment_id === "approval-resolution")!.created_at =
    "2026-07-24T00:04:00Z";
  assert.equal(humanActionSummaryStatus(tree, "root-1"), "In Progress");
});

test("summary precedence preserves every active Human Action barrier", () => {
  const tree = workflowTree([
    request("resolved-approval", "plan_approval", "resolved"),
    humanReply("resolved-approval-reply", "resolved-approval", "2026-07-24T00:01:00Z"),
    resolution(
      "resolved-approval-resolution",
      "resolved-approval-reply",
      "resolved-approval",
      "2026-07-24T00:02:00Z",
    ),
    request("information-request", "information", "unresolved"),
    request("permission-request", "permission", "unresolved"),
  ]);

  assert.equal(humanActionSummaryStatus(tree, "root-1"), "Needs Approval");

  tree.comments.find(({ comment_id }) => comment_id === "permission-request")!.thread_state = "resolved";
  tree.comments.push(
    humanReply("permission-reply", "permission-request", "2026-07-24T00:03:00Z"),
    resolution("permission-resolution", "permission-reply", "permission-request", "2026-07-24T00:04:00Z"),
  );
  assert.equal(humanActionSummaryStatus(tree, "root-1"), "Needs Info");
});

test("a reply from a human outside the Root creator or assignee stays pending", () => {
  const tree = workflowTree([
    request("approval-request", "plan_approval", "resolved"),
    humanReply("approval-reply", "approval-request", "2026-07-24T00:01:00Z"),
    resolution("approval-resolution", "approval-reply", "approval-request", "2026-07-24T00:02:00Z"),
  ]);
  const reply = tree.comments.find(({ comment_id }) => comment_id === "approval-reply")!;
  reply.author_id = "unrelated-user";
  reply.author_user_id = "unrelated-user";

  assert.equal(humanActionSummaryStatus(tree, "root-1"), "Needs Approval");
});

function workflowTree(
  comments: LinearWorkflowTreeSnapshot["comments"],
): LinearWorkflowTreeSnapshot {
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "progress", name: "In Progress", category: "started", position: 1 }],
    issues: [{
      issue_id: "root-1",
      identifier: "SYM-1",
      project_id: "project-1",
      status_id: "progress",
      status_name: "In Progress",
      status_category: "started",
      status_position: 1,
      order: 0,
      depth: 0,
      title: "Root",
      description: "Root",
      labels: [],
      is_archived: false,
      issue_kind: "root",
      remote_version: "root-v1",
      created_at: "2026-07-24T00:00:00Z",
      updated_at: "2026-07-24T00:00:00Z",
    }],
    comments,
    relations: [],
    attachments: [],
    activities: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-24T00:05:00Z",
  };
  Object.assign(tree.issues[0]!, { creator_user_id: "user-1", assignee_user_id: "assignee-1" });
  return tree;
}

function request(
  commentId: string,
  actionKind: "plan_approval" | "information" | "permission",
  threadState: "resolved" | "unresolved",
): LinearWorkflowTreeSnapshot["comments"][number] {
  const heading = {
    plan_approval: "需要你审批",
    information: "需要你补充信息",
    permission: "需要你授权",
  }[actionKind];
  return {
    comment_id: commentId,
    issue_id: "root-1",
    body: `## ${heading}\n\n请回复。`,
    author_kind: "symphony",
    author_id: "symphony",
    thread_root_comment_id: commentId,
    thread_state: threadState,
    reactions: [],
    created_at: "2026-07-24T00:00:00Z",
    remote_version: `${commentId}-v1`,
    updated_at: "2026-07-24T00:00:00Z",
  };
}

function humanReply(
  commentId: string,
  requestId: string,
  updatedAt: string,
): LinearWorkflowTreeSnapshot["comments"][number] {
  return {
    comment_id: commentId,
    issue_id: "root-1",
    parent_comment_id: requestId,
    body: "批准。",
    author_kind: "human",
    author_id: "user-1",
    author_user_id: "user-1",
    thread_root_comment_id: requestId,
    thread_state: "resolved",
    reactions: [{ reaction_id: `${commentId}-check`, emoji: "✅", actor_kind: "symphony", actor_id: "symphony" }],
    created_at: "2026-07-24T00:01:00Z",
    remote_version: `${commentId}-v2`,
    updated_at: updatedAt,
  };
}

function resolution(
  commentId: string,
  humanReplyId: string,
  requestId: string,
  createdAt: string,
): LinearWorkflowTreeSnapshot["comments"][number] {
  return {
    comment_id: commentId,
    issue_id: "root-1",
    parent_comment_id: humanReplyId,
    body: "## ✅ 已接受",
    author_kind: "symphony",
    author_id: "symphony",
    thread_root_comment_id: requestId,
    thread_state: "resolved",
    reactions: [],
    created_at: createdAt,
    remote_version: `${commentId}-v1`,
    updated_at: createdAt,
  };
}
