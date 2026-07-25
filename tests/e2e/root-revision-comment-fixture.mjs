import { createHash } from "node:crypto";

import { ROOT_REVISION_COMMENT, ROOT_REVISION_DESCRIPTION } from "../../tools/e2e/human-scripts.mjs";

const observedAt = "2026-07-25T00:10:00.000Z";
const rootIssueId = "root-revision";
const commentId = "comment-revision";

export function rootRevisionCommentRow() {
  const bodyDigest = digest(ROOT_REVISION_COMMENT);
  const rootInputId = "linear_issue:root-revision:2026-07-25T00:00:01.000Z";
  const bodyInputId = `comment_body:${commentId}:${bodyDigest}`;
  const resolvedInputId = `comment_thread_state:${commentId}:2026-07-25T00:00:04.000Z:${commentId}:resolved`;
  const reopenedInputId = `comment_thread_state:${commentId}:2026-07-25T00:00:07.000Z:${commentId}:unresolved`;
  const resolvedReplies = [
    reply({
      replyId: "reply-comment-body",
      rootDirectiveId: "directive-comment-resolved",
      sourceInputId: bodyInputId,
      source: { kind: "comment_body", comment_id: commentId, comment_body_digest: bodyDigest },
      disposition: "accepted",
      reaction: "check",
      threadAction: "resolve",
      repliedAt: "2026-07-25T00:00:05.100Z",
    }),
    reply({
      replyId: "reply-comment-resolved",
      rootDirectiveId: "directive-comment-resolved",
      sourceInputId: resolvedInputId,
      source: {
        kind: "comment_thread_state",
        comment_id: commentId,
        comment_remote_version: "2026-07-25T00:00:04.000Z",
        thread_root_comment_id: commentId,
        thread_state: "resolved",
      },
      disposition: "accepted",
      reaction: "none",
      threadAction: "resolve",
      repliedAt: "2026-07-25T00:00:05.200Z",
    }),
  ];
  const reopenedReplies = [
    reply({
      replyId: "reply-comment-reopened",
      rootDirectiveId: "directive-comment-reopened",
      sourceInputId: reopenedInputId,
      source: {
        kind: "comment_thread_state",
        comment_id: commentId,
        comment_remote_version: "2026-07-25T00:00:07.000Z",
        thread_root_comment_id: commentId,
        thread_state: "unresolved",
      },
      disposition: "follow_up_required",
      reaction: "none",
      threadAction: "keep_open",
      repliedAt: "2026-07-25T00:00:08.100Z",
    }),
  ];
  const directives = [
    directive({
      directiveId: "directive-root-revision",
      acceptedAt: "2026-07-25T00:00:02.000Z",
      consumedInputIds: [rootInputId],
      replies: [],
      action: acknowledge(),
    }),
    directive({
      directiveId: "directive-comment-resolved",
      acceptedAt: "2026-07-25T00:00:05.000Z",
      consumedInputIds: [bodyInputId, resolvedInputId],
      replies: resolvedReplies,
      action: acknowledge(),
    }),
    directive({
      directiveId: "directive-comment-reopened",
      acceptedAt: "2026-07-25T00:00:08.000Z",
      consumedInputIds: [reopenedInputId],
      replies: reopenedReplies,
      action: executePlan(),
    }),
  ];
  const comments = [
    {
      comment_id: commentId,
      issue_id: rootIssueId,
      parent_comment_id: null,
      remote_version: "2026-07-25T00:00:07.000Z",
      thread_root_comment_id: commentId,
      thread_state: "unresolved",
      body: ROOT_REVISION_COMMENT,
      author: { actor_id: "human-actor", actor_kind: "user" },
      reactions: [{ reaction_id: "reaction-check", emoji: "✅", actor: { actor_id: "symphony-actor", actor_kind: "user" } }],
      created_at: "2026-07-25T00:00:03.000Z",
      updated_at: "2026-07-25T00:00:07.000Z",
      archived_at: null,
      resolved_at: null,
    },
    ...directives.map((candidate, index) => managedComment({
      commentId: `comment-directive-${index + 1}`,
      issueId: rootIssueId,
      createdAt: candidate.accepted_at,
      record: candidate,
    })),
  ];
  for (const candidateReply of [...resolvedReplies, ...reopenedReplies]) {
      comments.push(managedComment({
        commentId: `comment-${candidateReply.reply_id}`,
        issueId: rootIssueId,
        parentCommentId: commentId,
        createdAt: candidateReply.replied_at,
        record: candidateReply,
      }));
  }
  const stage = stageExecution();
  comments.push(managedComment({
    commentId: "comment-stage-after-replies",
    issueId: "plan-revision",
    createdAt: stage.started_at,
    record: stage,
  }));

  return {
    e2eCase: { case_id: "root-revision-comment", evidence_predicate_id: "root_revision_comment" },
    caseRoots: { root_issue_ids: [rootIssueId] },
    caseContext: { human_actor_id: "human-actor", symphony_actor_id: "symphony-actor" },
    snapshot: {
      kind: "complete",
      observed_at: observedAt,
      root_trees: [{
        root_issue_id: rootIssueId,
        issues: [
          issue({ issueId: rootIssueId, description: ROOT_REVISION_DESCRIPTION, parentIssueId: null }),
          issue({ issueId: "cycle-revision", description: "", parentIssueId: rootIssueId }),
          issue({ issueId: "plan-revision", description: "", parentIssueId: "cycle-revision" }),
        ],
        comments,
        relations: [],
        activity: [{
          issue_id: rootIssueId,
          history: [{
            activity_id: "activity-root-description-revised",
            actor_id: "human-actor",
            created_at: "2026-07-25T00:00:01.000Z",
            updated_at: "2026-07-25T00:00:01.000Z",
            from_priority: null,
            to_priority: null,
            from_state_id: null,
            to_state_id: null,
            from_title: null,
            to_title: null,
            updated_description: true,
            is_archived: false,
          }],
          state_history: [],
        }],
        managed_blocks: comments
          .filter((comment) => comment.record)
          .map((comment) => ({
            source_kind: "comment",
            source_id: comment.comment_id,
            source_version: comment.remote_version,
            actor: { actor_id: "symphony-actor", actor_kind: "user" },
            issue_id: comment.issue_id,
            record: comment.record,
          })),
      }],
      repositories: [{
        repository_identity: "repository-a",
        branch: "main",
        head_commit: "a".repeat(40),
        base_branch: "main",
        base_commit: "a".repeat(40),
        changed_paths: [],
        diff_check: "passed",
        worktree: { is_clean: true, items: [] },
        delivery: { remote_name: null, branch: "main", remote_head: null, is_delivered: false },
      }],
    },
  };
}

function directive({ directiveId, acceptedAt, consumedInputIds, replies, action }) {
  return {
    kind: "root_directive",
    version: 1,
    root_directive_id: directiveId,
    root_issue_id: rootIssueId,
    reconciler_session_id: "reconciler-session-1",
    reconciler_turn_id: `turn-${directiveId}`,
    based_on_target_root_digest: `digest-${directiveId}`,
    consumed_input_ids: consumedInputIds,
    directive: {
      protocol_version: "1",
      request_id: `request-${directiveId}`,
      root_directive_id: directiveId,
      reconciler_session_id: "reconciler-session-1",
      reconciler_turn_id: `turn-${directiveId}`,
      model_turn: {
        turn_record_id: `turn-record-${directiveId}`,
        role: "root_reconciler",
        root_issue_id: rootIssueId,
        reconciler_session_id: "reconciler-session-1",
        reconciler_turn_id: `turn-${directiveId}`,
        invocation_state: "confirmed",
        model: "gpt-5-codex",
        outcome: "directive_accepted",
        usage: { status: "measured", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
        terminal_at: acceptedAt,
      },
      based_on_target_root_digest: `digest-${directiveId}`,
      rationale: "The durable user input was reconciled.",
      evidence_refs: [],
      consumed_input_ids: consumedInputIds,
      comment_replies: replies.map(directiveReply),
      human_action_resolutions: [],
      action,
    },
    accepted_at: acceptedAt,
  };
}

function reply({ replyId, rootDirectiveId, sourceInputId, source, disposition, reaction, threadAction, repliedAt }) {
  return {
    kind: "root_reconciler_reply",
    version: 1,
    reply_id: replyId,
    reply_write_id: replyId,
    root_directive_id: rootDirectiveId,
    source_input_id: sourceInputId,
    source,
    target_issue_id: rootIssueId,
    disposition,
    reaction,
    thread_action: threadAction,
    materialized_outcome_refs: [],
    rendered_schema_version: "1",
    replied_at: repliedAt,
  };
}

function directiveReply(record) {
  return {
    reply_id: record.reply_id,
    source_input_id: record.source_input_id,
    source: record.source,
    acknowledgement: "The user input was received.",
    interpreted_request: "Use the revised Root requirement.",
    decided_action: "The Root Reconciler selected the next action.",
    next_step: "Observe the durable workflow result.",
    disposition: record.disposition,
    reaction: record.reaction,
    thread_action: record.thread_action,
  };
}

function acknowledge() {
  return { kind: "acknowledge", reason: "The Root Reconciler accepted the durable input." };
}

function executePlan() {
  return {
    kind: "execute_plan",
    cycle_issue_id: "cycle-revision",
    plan_issue_id: "plan-revision",
    plan_goal: "Plan the revised Root requirement.",
  };
}

function stageExecution() {
  return {
    kind: "stage_execution",
    version: 1,
    stage_execution_id: "stage-revision-after-replies",
    root_issue_id: rootIssueId,
    cycle_issue_id: "cycle-revision",
    node_issue_id: "plan-revision",
    stage: "plan",
    context_digest: "context-revision",
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    instruction_set_id: "instructions-revision",
    execution_policy_id: "policy-revision",
    limits: {
      max_context_bytes: 1,
      max_result_bytes: 1,
      max_wall_time_ms: 1,
      max_tool_calls: 1,
      max_command_duration_ms: 1,
      reserved_total_tokens: 1,
      max_output_tokens: 1,
    },
    repository_revision: "revision-revision",
    started_at: "2026-07-25T00:00:09.000Z",
    deadline_at: "2026-07-25T00:01:09.000Z",
  };
}

function issue({ issueId, description, parentIssueId }) {
  return {
    issue_id: issueId,
    issue_identifier: issueId.toUpperCase(),
    parent_issue_id: parentIssueId,
    remote_version: "2026-07-25T00:00:09.000Z",
    title: issueId,
    description,
    priority: 0,
    status: { status_id: "status-in-progress", name: "In Progress", category: "started" },
    labels: [],
    reactions: [],
    creator: { actor_id: "human-actor", actor_kind: "user" },
    created_at: "2026-07-25T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:09.000Z",
    archived_at: null,
    is_archived: false,
  };
}

function managedComment({ commentId, issueId, parentCommentId = null, createdAt, record }) {
  return {
    comment_id: commentId,
    issue_id: issueId,
    parent_comment_id: parentCommentId,
    remote_version: createdAt,
    thread_root_comment_id: parentCommentId ?? commentId,
    thread_state: "unresolved",
    body: `Managed ${record.kind}.`,
    author: { actor_id: "symphony-actor", actor_kind: "user" },
    reactions: [],
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null,
    resolved_at: null,
    record,
  };
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
