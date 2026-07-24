import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootDirective, RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { LinearRootReconcilerReplyWriterImpl } from "../internal/LinearRootReconcilerReplyWriterImpl.js";

test("reply writer appends a structured reply to the source Issue and reads it back", async () => {
  const linear = new FakeLinear();
  const writer = new LinearRootReconcilerReplyWriterImpl(linear);
  const result = await writer.write({ directive: directive(), reply: reply(), view: view(linear.tree) });

  assert.equal(result.kind, "materialized");
  assert.equal(linear.mutations.length, 1);
  const command = linear.mutations[0]!;
  assert.equal(command.kind, "append_workflow_comment");
  assert.equal(command.target.targetIssueId, "work-1");
  assert.equal(command.target.expectedRemoteVersion, "work-v1");
  assert.equal(command.target.expectedStatusId, "work-status");
  assert.match(command.body, /## Symphony reply/u);
  assert.match(command.body, /Acknowledgement\nWe received your request\./u);
  assert.match(command.body, /Interpreted request\nPlease rerun Verify\./u);
  assert.match(command.body, /Decision\nThe Root Reconciler will rerun the check\./u);
  assert.match(command.body, /Next step\nWait for the next Verify result\./u);

  const second = await writer.write({ directive: directive(), reply: reply(), view: view(linear.tree) });
  assert.deepEqual(second, result);
  assert.equal(linear.mutations.length, 1);
});

test("reply writer rejects stale, managed, and non-human source comments", async () => {
  for (const patch of [
    { sourceCommentVersion: "comment-old", expected: "reply_source_comment_stale" },
    { authorKind: "symphony" as const, expected: "reply_source_comment_actor_invalid" },
    { managedMarker: "root-1:timeline:comment-1", expected: "reply_source_comment_managed" },
  ]) {
    const linear = new FakeLinear();
    const writer = new LinearRootReconcilerReplyWriterImpl(linear);
    const result = await writer.write({
      directive: directive(),
      reply: reply(patch.sourceCommentVersion),
      view: view({
        ...linear.tree,
        comments: [{
          ...linear.tree.comments[0]!,
          author_kind: patch.authorKind ?? "human",
          ...(patch.managedMarker ? { managed_marker: patch.managedMarker } : {}),
        }],
      }),
    });
    assert.deepEqual(result, { kind: "failed", code: patch.expected });
    assert.equal(linear.mutations.length, 0);
  }
});

test("reply writer stops when Linear does not confirm the comment", async () => {
  const linear = new FakeLinear();
  linear.dropReadBack = true;
  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    directive: directive(),
    reply: reply(),
    view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "failed", code: "reply_read_back_missing" });
});

test("reply writer rejects reply content that differs from the accepted directive", async () => {
  const linear = new FakeLinear();
  const changed = reply();
  changed.nextStep = "Do something else.";

  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    directive: directive(),
    reply: changed,
    view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "failed", code: "reply_disposition_not_accepted" });
  assert.equal(linear.mutations.length, 0);
});

function directive(): RootDirective {
  return {
    protocolVersion: 1,
    requestId: "request-1",
    rootDirectiveId: "directive-1",
    reconcilerSessionId: "session-1",
    reconcilerTurnId: "turn-1",
    basedOnTargetRootDigest: "tree-v1",
    rationale: "The user requested a fresh check.",
    evidenceRefs: [{ referenceId: "comment-1", sourceKind: "linear_comment" }],
    consumedInputIds: ["comment-1:comment-v1"],
    commentReplies: [reply()],
    humanActionResolutions: [],
    action: { kind: "wait", reasonCode: "runtime_condition", blockingFactRefs: [{ referenceId: "comment-1", sourceKind: "linear_comment" }] },
  };
}

function reply(sourceCommentVersion = "comment-v1") {
  return {
    sourceInputId: `comment-1:${sourceCommentVersion}`,
    sourceCommentId: "comment-1",
    sourceCommentVersion,
    acknowledgement: "We received your request.",
    interpretedRequest: "Please rerun Verify.",
    decidedAction: "The Root Reconciler will rerun the check.",
    nextStep: "Wait for the next Verify result.",
  };
}

function view(tree: LinearWorkflowTreeSnapshot): RootReconciliationView {
  return {
    root: {
      issueId: "root-1",
      identifier: "SYM-1",
      state: "In Progress",
      title: "Root",
      description: "Build it",
      updatedAt: "2026-07-23T00:00:00Z",
      projectId: "project-1",
      parentIssueId: null,
      isDelegatedToSymphony: true,
      priority: "normal",
      order: 0,
      blockers: [],
      rootConductorLabels: [{ conductorShortHash: "abc123" }],
    },
    tree,
    git: { head: "abc123", branch: "symphony/runs/sym-1", status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt: tree.observed_at,
    treeDigest: "tree-v1",
    complete: true,
  };
}

class FakeLinear {
  tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "work-status", name: "In Progress", category: "started", position: 1 }],
    issues: [
      {
        issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "root-status", status_name: "In Progress",
        status_category: "started", status_position: 1, order: 0, depth: 0, title: "Root", description: "Build it", labels: [],
        is_archived: false, issue_kind: "root", remote_version: "root-v1", updated_at: "2026-07-23T00:00:00Z",
      },
      {
        issue_id: "work-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1", status_id: "work-status", status_name: "In Progress",
        status_category: "started", status_position: 1, order: 1, depth: 1, title: "Work", description: "Run it", labels: [],
        is_archived: false, issue_kind: "work", remote_version: "work-v1", updated_at: "2026-07-23T00:00:00Z",
      },
    ],
    comments: [{
      comment_id: "comment-1", issue_id: "work-1", body: "Please rerun this check.", author_kind: "human", author_id: "user-1",
      author_user_id: "user-1", created_at: "2026-07-23T00:00:01Z", remote_version: "comment-v1", updated_at: "2026-07-23T00:00:01Z",
    }],
    relations: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-23T00:00:02Z",
  };
  mutations: LinearWorkflowMutationCommand[] = [];
  dropReadBack = false;

  async readWorkflowIssueTree() {
    return structuredClone(this.tree);
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind !== "append_workflow_comment") throw new Error("unexpected_mutation");
    if (!this.dropReadBack) {
      this.tree.comments.push({
        comment_id: command.writeId,
        issue_id: command.target.targetIssueId,
        body: command.body,
        author_kind: "symphony",
        author_id: "symphony-bot",
        author_user_id: "symphony-bot",
        created_at: "2026-07-23T00:00:03Z",
        managed_marker: command.writeId,
        remote_version: "reply-v1",
        updated_at: "2026-07-23T00:00:03Z",
      });
    }
    return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: command.target.targetIssueId, remoteVersion: "reply-v1" } };
  }
}
