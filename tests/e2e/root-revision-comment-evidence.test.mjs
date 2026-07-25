import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeRootRevisionCommentCampaignEvidence,
  assessRootRevisionCommentEvidence,
} from "../../tools/e2e/root-revision-comment-evidence.mjs";
import { executeHumanScript, ROOT_REVISION_COMMENT, ROOT_REVISION_DESCRIPTION } from "../../tools/e2e/human-scripts.mjs";
import { rootRevisionCommentRow } from "./root-revision-comment-fixture.mjs";

test("revise_root performs only ordinary Human Actor operations in the required order", async () => {
  const calls = [];
  await executeHumanScript({
    humanScript: { id: "revise_root" },
    caseRoots: { root_issue_ids: ["root-revision"] },
    human: {
      async updateRoot(input) { calls.push({ kind: "update_root", input }); },
      async createComment(input) {
        calls.push({ kind: "create_comment", input });
        return { comment_id: "comment-revision" };
      },
      async editComment(input) { calls.push({ kind: "edit_comment", input }); },
      async resolveCommentThread(input) { calls.push({ kind: "resolve_thread", input }); },
      async reopenCommentThread(input) { calls.push({ kind: "reopen_thread", input }); },
    },
    async waitForRootReconcilerReply(input) { calls.push({ kind: "wait_for_reconciler_reply", input }); },
  });

  assert.deepEqual(calls, [
    { kind: "update_root", input: { root_issue_id: "root-revision", description: ROOT_REVISION_DESCRIPTION } },
    { kind: "create_comment", input: { issue_id: "root-revision", body: "Please use the revised Root requirement when deciding the next step." } },
    { kind: "edit_comment", input: { comment_id: "comment-revision", body: ROOT_REVISION_COMMENT } },
    { kind: "resolve_thread", input: { thread_root_comment_id: "comment-revision" } },
    { kind: "wait_for_reconciler_reply", input: { root_issue_id: "root-revision", comment_id: "comment-revision", thread_state: "resolved" } },
    { kind: "reopen_thread", input: { thread_root_comment_id: "comment-revision" } },
    { kind: "wait_for_reconciler_reply", input: { root_issue_id: "root-revision", comment_id: "comment-revision", thread_state: "unresolved" } },
  ]);
});

test("Root revision evidence proves each consumed user input was replied to before workflow progress resumed", () => {
  assert.deepEqual(assessRootRevisionCommentEvidence(rootRevisionCommentRow()), {
    kind: "satisfied",
    reason_code: "root_revision_comment_confirmed",
  });
});

test("Root revision evidence remains incomplete until the edited ordinary comment has a matching Reconciler reply", () => {
  const row = rootRevisionCommentRow();
  const tree = row.snapshot.root_trees[0];
  const index = tree.managed_blocks.findIndex(({ record }) =>
    record.kind === "root_reconciler_reply" && record.source.kind === "comment_body",
  );
  tree.managed_blocks.splice(index, 1);

  assert.deepEqual(assessRootRevisionCommentEvidence(row), {
    kind: "inconclusive",
    reason_code: "root_revision_comment_body_reply_missing",
  });
});

test("Root revision evidence rejects a reply disposition that lacks its matching native receipt", () => {
  const row = rootRevisionCommentRow();
  const source = row.snapshot.root_trees[0].comments.find(({ comment_id: commentId }) => commentId === "comment-revision");
  source.reactions = [];

  assert.deepEqual(assessRootRevisionCommentEvidence(row), {
    kind: "violated",
    reason_code: "root_revision_comment_receipt_mismatch",
  });
});

test("Root revision evidence rejects a Reconciler reply block not owned by Symphony", () => {
  const row = rootRevisionCommentRow();
  const reply = row.snapshot.root_trees[0].managed_blocks.find(({ record }) =>
    record.kind === "root_reconciler_reply" && record.source.kind === "comment_body",
  );
  reply.actor = { actor_id: "human-actor", actor_kind: "user" };

  assert.deepEqual(assessRootRevisionCommentEvidence(row), {
    kind: "violated",
    reason_code: "root_revision_comment_reply_ownership_mismatch",
  });
});

test("Root revision evidence rejects a Root directive block not owned by Symphony", () => {
  const row = rootRevisionCommentRow();
  const directive = row.snapshot.root_trees[0].managed_blocks.find(({ record }) =>
    record.kind === "root_directive" && record.root_directive_id === "directive-root-revision",
  );
  directive.actor = { actor_id: "human-actor", actor_kind: "user" };

  assert.deepEqual(assessRootRevisionCommentEvidence(row), {
    kind: "violated",
    reason_code: "root_revision_comment_directive_ownership_mismatch",
  });
});

test("Root revision evidence rejects workflow progress that starts before all comment replies are durable", () => {
  const row = rootRevisionCommentRow();
  row.snapshot.root_trees[0].managed_blocks.find(({ record }) => record.kind === "stage_execution").record.started_at = "2026-07-25T00:00:05.000Z";

  assert.deepEqual(assessRootRevisionCommentEvidence(row), {
    kind: "violated",
    reason_code: "root_revision_comment_progress_before_replies",
  });
});

test("Root revision evidence requires durable replies for both native resolved and reopened thread inputs", () => {
  const row = rootRevisionCommentRow();
  const tree = row.snapshot.root_trees[0];
  const index = tree.managed_blocks.findIndex(({ record }) =>
    record.kind === "root_reconciler_reply" &&
    record.source.kind === "comment_thread_state" &&
    record.source.thread_state === "unresolved",
  );
  tree.managed_blocks.splice(index, 1);

  assert.deepEqual(assessRootRevisionCommentEvidence(row), {
    kind: "inconclusive",
    reason_code: "root_revision_comment_reopened_reply_missing",
  });
});

test("Root revision evidence rejects the retired thread-state input identity ordering", () => {
  const row = rootRevisionCommentRow();
  const reply = row.snapshot.root_trees[0].managed_blocks.find(({ record }) =>
    record.kind === "root_reconciler_reply" &&
    record.source.kind === "comment_thread_state" &&
    record.source.thread_state === "resolved",
  );
  reply.record.source_input_id = "comment_thread_state:comment-revision:comment-revision:resolved:2026-07-25T00:00:04.000Z";

  assert.deepEqual(assessRootRevisionCommentEvidence(row), {
    kind: "violated",
    reason_code: "root_revision_comment_thread_reply_mismatch",
  });
});

test("Root revision evidence rejects a Stage that starts after the user comment but before its replies", () => {
  const row = rootRevisionCommentRow();
  const tree = row.snapshot.root_trees[0];
  const stage = tree.managed_blocks.find(({ record }) => record.kind === "stage_execution");
  tree.managed_blocks.push({
    ...stage,
    record: {
      ...stage.record,
      stage_execution_id: "stage-revision-before-replies",
      started_at: "2026-07-25T00:00:04.500Z",
    },
  });

  assert.deepEqual(assessRootRevisionCommentEvidence(row), {
    kind: "violated",
    reason_code: "root_revision_comment_progress_before_replies",
  });
});

test("Root revision campaign evidence ignores Cases owned by another predicate", () => {
  const row = rootRevisionCommentRow();
  row.e2eCase.evidence_predicate_id = "happy_path";

  assert.deepEqual(analyzeRootRevisionCommentCampaignEvidence({ rows: [row] }), {
    case_outcomes: [],
  });
});
