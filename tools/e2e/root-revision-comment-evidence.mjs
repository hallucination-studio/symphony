import { createHash } from "node:crypto";

import { ROOT_REVISION_COMMENT, ROOT_REVISION_DESCRIPTION } from "./human-scripts.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function assessRootRevisionCommentEvidence(row) {
  try {
    const input = rowInput(row);
    const tree = rootTree(input.snapshot, input.rootIssueId);
    const issues = issueFacts(tree);
    const comments = commentFacts(tree);
    const root = issues.get(input.rootIssueId);
    if (!root) return outcome("inconclusive", "root_revision_comment_root_missing");
    if (root.description !== ROOT_REVISION_DESCRIPTION) return outcome("violated", "root_revision_comment_description_mismatch");

    const descriptionUpdatedAt = humanDescriptionUpdate(tree, input.rootIssueId, input.humanActorId);
    if (descriptionUpdatedAt === undefined) return outcome("inconclusive", "root_revision_comment_description_update_missing");
    if (descriptionUpdatedAt === null) return outcome("violated", "root_revision_comment_description_update_ambiguous");

    const directives = readDirectives(tree, input.rootIssueId, input.symphonyActorId);
    if (directives.invalid) return outcome("inconclusive", "root_revision_comment_directive_invalid");
    if (directives.ownershipMismatch) return outcome("violated", "root_revision_comment_directive_ownership_mismatch");
    const rootRevisionDirective = one(directives.values.filter((directive) =>
      Date.parse(directive.acceptedAt) >= Date.parse(descriptionUpdatedAt) &&
      directive.consumedInputIds.some((inputId) => inputId.startsWith(`linear_issue:${input.rootIssueId}:`)),
    ));
    if (rootRevisionDirective === undefined) return outcome("inconclusive", "root_revision_comment_root_directive_missing");
    if (rootRevisionDirective === null) return outcome("violated", "root_revision_comment_root_directive_ambiguous");

    const source = one([...comments.values()].filter((comment) =>
      comment.issueId === input.rootIssueId && comment.parentCommentId === null &&
      comment.authorId === input.humanActorId && comment.authorKind === "user",
    ));
    if (source === undefined) return outcome("inconclusive", "root_revision_comment_source_missing");
    if (source === null) return outcome("violated", "root_revision_comment_source_ambiguous");
    if (source.body !== ROOT_REVISION_COMMENT || !hasOrdinaryCodeBlock(source.body)) {
      return outcome("violated", "root_revision_comment_source_mismatch");
    }
    if (source.threadRootCommentId !== source.commentId || source.threadState !== "unresolved") {
      return outcome("violated", "root_revision_comment_final_thread_state_invalid");
    }

    const replies = readReplies(tree, comments, input.rootIssueId, input.symphonyActorId);
    if (replies.invalid) return outcome("inconclusive", "root_revision_comment_reply_invalid");
    if (replies.ownershipMismatch) return outcome("violated", "root_revision_comment_reply_ownership_mismatch");
    const bodyInputId = `comment_body:${source.commentId}:${digest(source.body)}`;
    const body = matchingReply({
      replies: replies.values,
      directives: directives.values,
      source,
      sourceInputId: bodyInputId,
      sourceKind: "comment_body",
    });
    if (body.kind !== "ok") return outcome(body.kind, body.reasonCode);
    if (!matchingReceipt(source, body.reply.reaction, input.symphonyActorId)) {
      return outcome("violated", "root_revision_comment_receipt_mismatch");
    }

    const resolved = matchingThreadStateReply({
      replies: replies.values,
      directives: directives.values,
      source,
      expectedThreadState: "resolved",
      missingReasonCode: "root_revision_comment_resolved_reply_missing",
    });
    if (resolved.kind !== "ok") return outcome(resolved.kind, resolved.reasonCode);
    const reopened = matchingThreadStateReply({
      replies: replies.values,
      directives: directives.values,
      source,
      expectedThreadState: "unresolved",
      missingReasonCode: "root_revision_comment_reopened_reply_missing",
    });
    if (reopened.kind !== "ok") return outcome(reopened.kind, reopened.reasonCode);
    if (resolved.reply.source.commentRemoteVersion === reopened.reply.source.commentRemoteVersion ||
        Date.parse(resolved.reply.repliedAt) > Date.parse(reopened.reply.repliedAt)) {
      return outcome("violated", "root_revision_comment_thread_revision_order_invalid");
    }
    if (desiredThreadState(reopened.reply.threadAction) !== source.threadState) {
      return outcome("violated", "root_revision_comment_thread_action_mismatch");
    }

    const replyBarrier = Math.max(
      Date.parse(body.reply.repliedAt),
      Date.parse(resolved.reply.repliedAt),
      Date.parse(reopened.reply.repliedAt),
    );
    const executions = stageExecutions(tree, input.rootIssueId);
    if (executions.invalid) return outcome("inconclusive", "root_revision_comment_progress_invalid");
    if (executions.values.length === 0) return outcome("inconclusive", "root_revision_comment_progress_missing");
    const executionsAfterComment = executions.values.filter(({ startedAt }) => Date.parse(startedAt) >= Date.parse(source.createdAt));
    if (executionsAfterComment.some(({ startedAt }) => Date.parse(startedAt) <= replyBarrier)) {
      return outcome("violated", "root_revision_comment_progress_before_replies");
    }
    if (!executionsAfterComment.some(({ startedAt }) => Date.parse(startedAt) > replyBarrier)) {
      return outcome("inconclusive", "root_revision_comment_progress_missing");
    }

    return outcome("satisfied", "root_revision_comment_confirmed");
  } catch {
    return outcome("inconclusive", "root_revision_comment_evidence_invalid");
  }
}

export function analyzeRootRevisionCommentCampaignEvidence({ rows } = {}) {
  if (!Array.isArray(rows)) return Object.freeze({ case_outcomes: Object.freeze([]) });
  return Object.freeze({
    case_outcomes: Object.freeze(rows
      .filter((row) => row?.e2eCase?.evidence_predicate_id === "root_revision_comment")
      .map((row) => Object.freeze({ case_id: row.e2eCase.case_id, outcome: assessRootRevisionCommentEvidence(row) }))),
  });
}

function rowInput(value) {
  const row = object(value);
  const e2eCase = object(row.e2eCase);
  const roots = object(row.caseRoots);
  const context = object(row.caseContext);
  const snapshot = object(row.snapshot);
  if (
    !identifier(e2eCase.case_id) || e2eCase.evidence_predicate_id !== "root_revision_comment" ||
    !Array.isArray(roots.root_issue_ids) || roots.root_issue_ids.length !== 1 || !identifier(roots.root_issue_ids[0]) ||
    !identifier(context.human_actor_id) || !identifier(context.symphony_actor_id) || context.human_actor_id === context.symphony_actor_id ||
    snapshot.kind !== "complete" || !Array.isArray(snapshot.root_trees)
  ) {
    throw new Error("invalid row");
  }
  return {
    rootIssueId: roots.root_issue_ids[0],
    humanActorId: context.human_actor_id,
    symphonyActorId: context.symphony_actor_id,
    snapshot,
  };
}

function rootTree(snapshot, rootIssueId) {
  const tree = one(snapshot.root_trees.filter((candidate) => candidate?.root_issue_id === rootIssueId));
  if (!tree || !Array.isArray(tree.issues) || !Array.isArray(tree.comments) || !Array.isArray(tree.activity) || !Array.isArray(tree.managed_blocks)) {
    throw new Error("invalid tree");
  }
  return tree;
}

function issueFacts(tree) {
  const values = new Map();
  for (const issue of tree.issues) {
    if (!object(issue) || !identifier(issue.issue_id) || typeof issue.description !== "string" || issue.description.length > 16_384 || values.has(issue.issue_id)) {
      throw new Error("invalid issue");
    }
    values.set(issue.issue_id, { issueId: issue.issue_id, description: issue.description });
  }
  return values;
}

function commentFacts(tree) {
  const values = new Map();
  for (const comment of tree.comments) {
    if (!object(comment) || !identifier(comment.comment_id) || !identifier(comment.issue_id) ||
        !text(comment.body) || !identifier(comment.thread_root_comment_id) ||
        !["resolved", "unresolved"].includes(comment.thread_state) ||
        !object(comment.author) || !identifier(comment.author.actor_id) ||
        !["user", "bot", "unknown"].includes(comment.author.actor_kind) ||
        !Array.isArray(comment.reactions) || !timestamp(comment.created_at) || !timestamp(comment.updated_at) ||
        values.has(comment.comment_id)) {
      throw new Error("invalid comment");
    }
    if (comment.parent_comment_id !== null && !identifier(comment.parent_comment_id)) throw new Error("invalid comment");
    values.set(comment.comment_id, {
      commentId: comment.comment_id,
      issueId: comment.issue_id,
      parentCommentId: comment.parent_comment_id,
      remoteVersion: comment.remote_version,
      threadRootCommentId: comment.thread_root_comment_id,
      threadState: comment.thread_state,
      body: comment.body,
      createdAt: comment.created_at,
      authorId: comment.author.actor_id,
      authorKind: comment.author.actor_kind,
      reactions: comment.reactions,
    });
  }
  return values;
}

function humanDescriptionUpdate(tree, rootIssueId, humanActorId) {
  const updates = [];
  for (const entry of tree.activity) {
    if (!object(entry) || entry.issue_id !== rootIssueId || !Array.isArray(entry.history)) continue;
    for (const history of entry.history) {
      if (object(history) && history.actor_id === humanActorId && history.updated_description === true && timestamp(history.created_at)) {
        updates.push(history.created_at);
      }
    }
  }
  return one(updates.sort());
}

function readDirectives(tree, rootIssueId, symphonyActorId) {
  const values = [];
  for (const block of tree.managed_blocks) {
    if (block?.record?.kind !== "root_directive") continue;
    if (!ownedBySymphony(block.actor, symphonyActorId)) return { invalid: false, ownershipMismatch: true, values: [] };
    const decoded = decodeDirective(block.record, block.issue_id, rootIssueId);
    if (decoded === null) return { invalid: true, ownershipMismatch: false, values: [] };
    values.push(decoded);
  }
  return { invalid: false, ownershipMismatch: false, values };
}

function decodeDirective(record, sourceIssueId, rootIssueId) {
  if (!object(record) || sourceIssueId !== rootIssueId) return null;
  if (!exactKeys(record, [
    "kind", "version", "root_directive_id", "root_issue_id", "reconciler_session_id", "reconciler_turn_id",
    "based_on_target_root_digest", "consumed_input_ids", "directive", "accepted_at",
  ]) || record.version !== 1 || record.root_issue_id !== rootIssueId || !identifier(record.root_directive_id) ||
      !identifier(record.reconciler_session_id) || !identifier(record.reconciler_turn_id) ||
      !identifier(record.based_on_target_root_digest) || !identifierArray(record.consumed_input_ids) || !timestamp(record.accepted_at)) {
    return null;
  }
  const directive = object(record.directive);
  if (!directive || !exactKeys(directive, [
    "protocol_version", "request_id", "root_directive_id", "reconciler_session_id", "reconciler_turn_id", "model_turn",
    "based_on_target_root_digest", "rationale", "evidence_refs", "consumed_input_ids", "comment_replies",
    "human_action_resolutions", "action",
  ]) || directive.protocol_version !== "1" || directive.root_directive_id !== record.root_directive_id ||
      directive.reconciler_session_id !== record.reconciler_session_id || directive.reconciler_turn_id !== record.reconciler_turn_id ||
      directive.based_on_target_root_digest !== record.based_on_target_root_digest || !identifier(directive.request_id) ||
      !text(directive.rationale) || !Array.isArray(directive.evidence_refs) || !identifierArray(directive.consumed_input_ids) ||
      !sameValues(record.consumed_input_ids, directive.consumed_input_ids) || !Array.isArray(directive.comment_replies) ||
      !Array.isArray(directive.human_action_resolutions) || !object(directive.action) || !text(directive.action.kind)) {
    return null;
  }
  const replies = directive.comment_replies.map(decodeDirectiveReply);
  if (replies.some((reply) => reply === null)) return null;
  return {
    rootDirectiveId: record.root_directive_id,
    acceptedAt: record.accepted_at,
    consumedInputIds: directive.consumed_input_ids,
    replies,
  };
}

function decodeDirectiveReply(value) {
  const reply = object(value);
  if (!reply || !exactKeys(reply, [
    "reply_id", "source_input_id", "source", "acknowledgement", "interpreted_request", "decided_action", "next_step",
    "disposition", "reaction", "thread_action",
  ]) || !identifier(reply.reply_id) || !identifier(reply.source_input_id) || !text(reply.acknowledgement) ||
      !text(reply.interpreted_request) || !text(reply.decided_action) || !text(reply.next_step) ||
      !disposition(reply.disposition) || !reaction(reply.reaction) || !threadAction(reply.thread_action)) {
    return null;
  }
  const source = decodeReplySource(reply.source);
  return source === null ? null : {
    replyId: reply.reply_id,
    sourceInputId: reply.source_input_id,
    source,
    disposition: reply.disposition,
    reaction: reply.reaction,
    threadAction: reply.thread_action,
  };
}

function readReplies(tree, comments, rootIssueId, symphonyActorId) {
  const values = [];
  for (const block of tree.managed_blocks) {
    if (block?.record?.kind !== "root_reconciler_reply") continue;
    const host = comments.get(block.source_id);
    if (!ownedBySymphony(block.actor, symphonyActorId) || !host || host.authorId !== symphonyActorId) {
      return { invalid: false, ownershipMismatch: true, values: [] };
    }
    const decoded = decodeReply(block.record, block.issue_id, rootIssueId, host);
    if (decoded === null) return { invalid: true, ownershipMismatch: false, values: [] };
    values.push(decoded);
  }
  return { invalid: false, ownershipMismatch: false, values };
}

function decodeReply(record, sourceIssueId, rootIssueId, host) {
  if (!object(record) || !host || sourceIssueId !== rootIssueId || host.issueId !== rootIssueId || host.authorKind !== "user" ||
      !exactKeys(record, [
        "kind", "version", "reply_id", "reply_write_id", "root_directive_id", "source_input_id", "source", "target_issue_id",
        "disposition", "reaction", "thread_action", "materialized_outcome_refs", "rendered_schema_version", "replied_at",
      ]) || record.version !== 1 || !identifier(record.reply_id) || record.reply_write_id !== record.reply_id ||
      !identifier(record.root_directive_id) || !identifier(record.source_input_id) || record.target_issue_id !== rootIssueId ||
      !disposition(record.disposition) || !reaction(record.reaction) || !threadAction(record.thread_action) ||
      !Array.isArray(record.materialized_outcome_refs) || record.rendered_schema_version !== "1" || !timestamp(record.replied_at)) {
    return null;
  }
  const source = decodeReplySource(record.source);
  if (source === null) return null;
  return {
    replyId: record.reply_id,
    rootDirectiveId: record.root_directive_id,
    sourceInputId: record.source_input_id,
    source,
    disposition: record.disposition,
    reaction: record.reaction,
    threadAction: record.thread_action,
    repliedAt: record.replied_at,
    host,
  };
}

function decodeReplySource(value) {
  const source = object(value);
  if (!source || !text(source.kind)) return null;
  if (source.kind === "comment_body") {
    if (!exactKeys(source, ["kind", "comment_id", "comment_body_digest"]) || !identifier(source.comment_id) || !sha256(source.comment_body_digest)) return null;
    return { kind: source.kind, commentId: source.comment_id, commentBodyDigest: source.comment_body_digest };
  }
  if (source.kind === "comment_thread_state") {
    if (!exactKeys(source, ["kind", "comment_id", "comment_remote_version", "thread_root_comment_id", "thread_state"]) ||
        !identifier(source.comment_id) || !text(source.comment_remote_version) || !identifier(source.thread_root_comment_id) ||
        !["resolved", "unresolved"].includes(source.thread_state)) return null;
    return {
      kind: source.kind,
      commentId: source.comment_id,
      commentRemoteVersion: source.comment_remote_version,
      threadRootCommentId: source.thread_root_comment_id,
      threadState: source.thread_state,
    };
  }
  return null;
}

function matchingReply({ replies, directives, source, sourceInputId, sourceKind }) {
  const matches = replies.filter((reply) => reply.sourceInputId === sourceInputId && reply.source.kind === sourceKind);
  const selected = one(matches);
  if (selected === undefined) return { kind: "inconclusive", reasonCode: "root_revision_comment_body_reply_missing" };
  if (selected === null) return { kind: "violated", reasonCode: "root_revision_comment_body_reply_ambiguous" };
  if (selected.source.commentId !== source.commentId || selected.host.parentCommentId !== source.commentId ||
      selected.host.threadRootCommentId !== source.threadRootCommentId || !validReplyDisposition(selected)) {
    return { kind: "violated", reasonCode: "root_revision_comment_body_reply_mismatch" };
  }
  if (sourceKind === "comment_body" && selected.source.commentBodyDigest !== digest(source.body)) {
    return { kind: "violated", reasonCode: "root_revision_comment_body_reply_mismatch" };
  }
  if (!replyBelongsToDirective(selected, directives)) return { kind: "violated", reasonCode: "root_revision_comment_body_directive_mismatch" };
  return { kind: "ok", reply: selected };
}

function matchingThreadStateReply({ replies, directives, source, expectedThreadState, missingReasonCode }) {
  const matches = replies.filter((reply) => reply.source.kind === "comment_thread_state" &&
    reply.source.commentId === source.commentId && reply.source.threadRootCommentId === source.threadRootCommentId &&
    reply.source.threadState === expectedThreadState,
  );
  const selected = one(matches);
  if (selected === undefined) return { kind: "inconclusive", reasonCode: missingReasonCode };
  if (selected === null) return { kind: "violated", reasonCode: "root_revision_comment_thread_reply_ambiguous" };
  const expectedInputId = `comment_thread_state:${source.commentId}:${selected.source.commentRemoteVersion}:${source.threadRootCommentId}:${expectedThreadState}`;
  if (selected.sourceInputId !== expectedInputId || selected.host.parentCommentId !== source.commentId ||
      selected.host.threadRootCommentId !== source.threadRootCommentId || selected.reaction !== "none" || !validThreadStateDisposition(selected) ||
      !replyBelongsToDirective(selected, directives)) {
    return { kind: "violated", reasonCode: "root_revision_comment_thread_reply_mismatch" };
  }
  return { kind: "ok", reply: selected };
}

function replyBelongsToDirective(reply, directives) {
  const directive = one(directives.filter(({ rootDirectiveId }) => rootDirectiveId === reply.rootDirectiveId));
  if (!directive || !directive.consumedInputIds.includes(reply.sourceInputId)) return false;
  const candidate = one(directive.replies.filter(({ replyId }) => replyId === reply.replyId));
  return Boolean(candidate && candidate.sourceInputId === reply.sourceInputId && sameReplySource(candidate.source, reply.source) &&
    candidate.disposition === reply.disposition && candidate.reaction === reply.reaction && candidate.threadAction === reply.threadAction);
}

function stageExecutions(tree, rootIssueId) {
  const values = [];
  for (const block of tree.managed_blocks) {
    const record = block?.record;
    if (record?.kind !== "stage_execution" || record.root_issue_id !== rootIssueId) continue;
    if (!identifier(record.stage_execution_id) || !identifier(record.cycle_issue_id) || !identifier(record.node_issue_id) ||
        !["plan", "work", "verify"].includes(record.stage) || !timestamp(record.started_at)) {
      return { invalid: true, values: [] };
    }
    values.push({ stageExecutionId: record.stage_execution_id, startedAt: record.started_at });
  }
  return { invalid: false, values };
}

function matchingReceipt(source, expected, symphonyActorId) {
  const expectedEmoji = expected === "check" ? "✅" : expected === "cross" ? "❌" : null;
  const symphonyReceipts = source.reactions.filter((reaction) =>
    object(reaction) && reaction.actor?.actor_kind === "user" && reaction.actor?.actor_id === symphonyActorId &&
    ["✅", "❌"].includes(reaction.emoji),
  ).map(({ emoji }) => emoji);
  return expectedEmoji === null ? symphonyReceipts.length === 0 : symphonyReceipts.length === 1 && symphonyReceipts[0] === expectedEmoji;
}

function validReplyDisposition(reply) {
  if (reply.disposition === "accepted") return reply.reaction === "check" && reply.threadAction === "resolve";
  if (reply.disposition === "not_applied") return reply.reaction === "cross" && reply.threadAction === "resolve";
  return reply.disposition === "follow_up_required" && reply.reaction === "none" && ["keep_open", "reopen"].includes(reply.threadAction);
}

function validThreadStateDisposition(reply) {
  if (reply.disposition === "accepted" || reply.disposition === "not_applied") return reply.threadAction === "resolve";
  return reply.disposition === "follow_up_required" && ["keep_open", "reopen"].includes(reply.threadAction);
}

function desiredThreadState(action) {
  return action === "resolve" ? "resolved" : "unresolved";
}

function sameReplySource(left, right) {
  if (left.kind !== right.kind || left.commentId !== right.commentId) return false;
  if (left.kind === "comment_body") return left.commentBodyDigest === right.commentBodyDigest;
  return left.commentRemoteVersion === right.commentRemoteVersion &&
    left.threadRootCommentId === right.threadRootCommentId && left.threadState === right.threadState;
}

function ownedBySymphony(actor, symphonyActorId) {
  return object(actor)?.actor_id === symphonyActorId;
}

function hasOrdinaryCodeBlock(body) {
  return /(?:^|\n)```(?!symphony(?:\s|$))[^\n]*\n[\s\S]*?\n```(?:\n|$)/iu.test(body) &&
    !/(?:^|\n)```symphony(?:\s|$)/iu.test(body);
}

function disposition(value) {
  return ["accepted", "not_applied", "follow_up_required"].includes(value);
}

function reaction(value) {
  return ["check", "cross", "none"].includes(value);
}

function threadAction(value) {
  return ["resolve", "keep_open", "reopen"].includes(value);
}

function one(values) {
  return values.length === 1 ? values[0] : values.length === 0 ? undefined : null;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function identifierArray(value) {
  return Array.isArray(value) && value.length <= 512 && value.every(identifier) && new Set(value).size === value.length;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function timestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !value.includes("\0");
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function outcome(kind, reasonCode) {
  return Object.freeze({ kind, reason_code: reasonCode });
}
