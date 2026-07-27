import { createHash } from "node:crypto";

import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootDirective,
  RootReconciliationView,
  UserCommentReply,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootReconcilerReplyWriterInterface } from "../api/RootReconcilerReplyWriterInterface.js";

const MAX_REPLY_BYTES = 32_768;
const MAX_REPLY_FIELD_LENGTH = 16_384;

export class LinearRootReconcilerReplyWriterImpl implements RootReconcilerReplyWriterInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async write(input: {
    directive: RootDirective;
    reply: UserCommentReply;
    view: RootReconciliationView;
  }): Promise<{ kind: "materialized" } | { kind: "failed"; code: string }> {
    let tree = input.view.tree;
    let source = sourceComment(tree, input.reply);
    if (!source) return failed("reply_source_comment_missing");
    if (input.reply.source.kind === "comment_thread_state" && input.reply.reaction !== "none") {
      return failed("reply_thread_state_receipt_invalid");
    }
    const acceptedReplies = input.directive.commentReplies.filter((reply) =>
      reply.replyId === input.reply.replyId);
    if (acceptedReplies.length !== 1 || !sameReply(acceptedReplies[0]!, input.reply)) {
      return failed("reply_disposition_not_accepted");
    }

    let target = targetIssue(tree, source.issue_id);
    let root = rootIssue(tree, input.view.root.issueId);
    if (!target || !root) return failed("reply_target_missing");

    const replyId = input.reply.replyId;
    if (replyId !== deterministicReplyId({
      rootDirectiveId: input.directive.rootDirectiveId,
      source: input.reply.source,
    })) return failed("reply_id_invalid");

    const body = render(input.reply);
    if (!body) return failed("reply_content_invalid");
    if (Buffer.byteLength(body, "utf8") > MAX_REPLY_BYTES) return failed("reply_comment_too_large");

    let replyComment = findReply(tree.comments, source, body);
    const sourceValidation = validateSource(source, input.reply);
    if (sourceValidation && !isRecoveredThreadAction(source, input.reply, replyComment)) {
      return failed(sourceValidation);
    }
    if (!replyComment) {
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_comment_reply",
        writeId: replyId,
        expectedProjectId: target.project_id,
        rootIssueId: input.view.root.issueId,
        expectedRootRemoteVersion: root.remote_version,
        sourceCommentId: source.comment_id,
        expectedSourceCommentRemoteVersion: source.remote_version,
        expectedThreadRootCommentId: source.thread_root_comment_id,
        expectedThreadState: source.thread_state,
        body,
      });
      if (!applied(outcome)) return failed(`reply_create_${outcome.kind}`);
      tree = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
      source = sourceComment(tree, input.reply);
      target = source ? targetIssue(tree, source.issue_id) : undefined;
      root = rootIssue(tree, input.view.root.issueId);
      if (!source || !target || !root) return failed("reply_read_back_missing");
      replyComment = findReply(tree.comments, source, body);
      if (!replyComment) return failed("reply_read_back_missing");
    }

    const expectedReceipt = input.reply.source.kind === "comment_body" ? receipt(source) : undefined;
    if (expectedReceipt === undefined && input.reply.source.kind === "comment_body") {
      return failed("reply_receipt_ambiguous");
    }
    if (expectedReceipt !== undefined && expectedReceipt !== input.reply.reaction) {
      const reactionOutcome = await this.linear.mutateWorkflow({
        kind: "set_comment_receipt_reaction",
        writeId: `${replyId}:receipt`,
        expectedProjectId: target.project_id,
        rootIssueId: input.view.root.issueId,
        expectedRootRemoteVersion: root.remote_version,
        replyWriteId: replyId,
        sourceCommentId: source.comment_id,
        expectedSourceCommentRemoteVersion: source.remote_version,
        threadRootCommentId: source.thread_root_comment_id,
        expectedReceipt,
        receipt: input.reply.reaction,
      });
      if (!applied(reactionOutcome)) return failed(`reply_reaction_${reactionOutcome.kind}`);

      tree = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
      source = sourceComment(tree, input.reply);
      target = source ? targetIssue(tree, source.issue_id) : undefined;
      root = rootIssue(tree, input.view.root.issueId);
      replyComment = source ? findReply(tree.comments, source, body) : undefined;
      if (!source || !target || !root || !replyComment || receipt(source) !== input.reply.reaction) {
        return failed("reply_reaction_read_back_missing");
      }
    }

    const desiredState = input.reply.threadAction === "resolve" ? "resolved" : "unresolved";
    if (input.reply.threadAction === "keep_open") {
      if (source.thread_state !== desiredState) return failed("reply_thread_state_not_open");
      return { kind: "materialized" };
    }
    if (source.thread_state !== desiredState) {
      const stateOutcome = await this.linear.mutateWorkflow({
        kind: "set_comment_thread_state",
        writeId: `${replyId}:thread-state`,
        expectedProjectId: target.project_id,
        rootIssueId: input.view.root.issueId,
        expectedRootRemoteVersion: root.remote_version,
        replyWriteId: replyId,
        sourceCommentId: source.comment_id,
        expectedSourceCommentRemoteVersion: source.remote_version,
        threadRootCommentId: source.thread_root_comment_id,
        expectedThreadState: source.thread_state,
        threadState: desiredState,
      });
      if (!applied(stateOutcome)) return failed(`reply_thread_state_${stateOutcome.kind}`);

      tree = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
      source = sourceComment(tree, input.reply);
      replyComment = source ? findReply(tree.comments, source, body) : undefined;
      if (
        !source ||
        !replyComment ||
        source.thread_state !== desiredState ||
        (input.reply.source.kind === "comment_body" && receipt(source) !== input.reply.reaction)
      ) {
        return failed("reply_thread_state_read_back_missing");
      }
    }
    return { kind: "materialized" };
  }
}

function deterministicReplyId(input: {
  rootDirectiveId: string;
  source: UserCommentReply["source"];
}): string {
  const source = input.source.kind === "comment_body"
    ? [input.source.kind, input.source.commentId, input.source.commentBodyDigest]
    : [
      input.source.kind,
      input.source.commentId,
      input.source.commentRemoteVersion,
      input.source.threadRootCommentId,
      input.source.threadState,
    ];
  return createHash("sha256")
    .update([input.rootDirectiveId, ...source].join("\0"))
    .digest("hex");
}

function render(reply: UserCommentReply): string | undefined {
  const fields = [
    reply.acknowledgement,
    reply.interpretedRequest,
    reply.decidedAction,
    reply.nextStep,
  ];
  if (fields.some((field) => field.length === 0 || field.length > MAX_REPLY_FIELD_LENGTH || /[\0\r]/u.test(field))) {
    return undefined;
  }
  const title = reply.disposition === "accepted" ? "## ✅ 已接受" :
    reply.disposition === "not_applied" ? "## ❌ 未应用" : "## 需要你继续处理";
  return [
    title,
    "",
    "**确认**",
    reply.acknowledgement,
    "",
    "**我理解的请求**",
    reply.interpretedRequest,
    "",
    "**处理结果**",
    reply.decidedAction,
    "",
    "**下一步**",
    reply.nextStep,
  ].join("\n");
}

function sameReply(left: UserCommentReply, right: UserCommentReply): boolean {
  return left.replyId === right.replyId &&
    sameSource(left.source, right.source) &&
    left.sourceInputId === right.sourceInputId &&
    left.acknowledgement === right.acknowledgement &&
    left.interpretedRequest === right.interpretedRequest &&
    left.decidedAction === right.decidedAction &&
    left.nextStep === right.nextStep &&
    left.disposition === right.disposition &&
    left.reaction === right.reaction &&
    left.threadAction === right.threadAction;
}

function findReply(
  comments: RootReconciliationView["tree"]["comments"],
  source: RootReconciliationView["tree"]["comments"][number],
  body: string,
) {
  const matches = comments.filter((comment) =>
    comment.issue_id === source.issue_id &&
    comment.parent_comment_id === source.comment_id &&
    comment.thread_root_comment_id === source.thread_root_comment_id &&
    comment.author_kind === "symphony" &&
    comment.body === body);
  if (matches.length > 1) throw new Error("native_reply_ambiguous");
  return matches[0];
}

function sourceComment(
  tree: RootReconciliationView["tree"],
  reply: UserCommentReply,
): RootReconciliationView["tree"]["comments"][number] | undefined {
  return tree.comments.find(({ comment_id }) => comment_id === reply.source.commentId);
}

function validateSource(
  source: RootReconciliationView["tree"]["comments"][number],
  reply: UserCommentReply,
): string | undefined {
  if (reply.source.kind === "comment_body") {
    if (bodyDigest(source.body) !== reply.source.commentBodyDigest) return "reply_source_comment_stale";
    if (source.author_kind !== "human" || !source.author_user_id || source.author_id !== source.author_user_id) {
      return "reply_source_comment_actor_invalid";
    }
    return undefined;
  }
  if (
    source.remote_version !== reply.source.commentRemoteVersion ||
    source.thread_root_comment_id !== reply.source.threadRootCommentId ||
    source.thread_state !== reply.source.threadState
  ) return "reply_source_thread_state_stale";
  return undefined;
}

function rootIssue(tree: RootReconciliationView["tree"], rootIssueId: string) {
  return tree.issues.find(({ issue_id }) => issue_id === rootIssueId);
}

function targetIssue(tree: RootReconciliationView["tree"], issueId: string) {
  return tree.issues.find(({ issue_id }) => issue_id === issueId);
}

function receipt(comment: RootReconciliationView["tree"]["comments"][number]): "check" | "cross" | "none" | undefined {
  const receipts = new Set(comment.reactions
    .filter(({ actor_kind, emoji }) => actor_kind === "symphony" && (emoji === "✅" || emoji === "❌"))
    .map(({ emoji }) => emoji === "✅" ? "check" : "cross"));
  if (receipts.size > 1) return undefined;
  return receipts.values().next().value ?? "none";
}

function applied(outcome: Awaited<ReturnType<LinearGatewayInterface["mutateWorkflow"]>>): boolean {
  return outcome.kind === "applied" || outcome.kind === "already_applied";
}

function sameSource(left: UserCommentReply["source"], right: UserCommentReply["source"]): boolean {
  if (left.kind !== right.kind || left.commentId !== right.commentId) return false;
  if (left.kind === "comment_body" && right.kind === "comment_body") {
    return left.commentBodyDigest === right.commentBodyDigest;
  }
  if (left.kind === "comment_thread_state" && right.kind === "comment_thread_state") {
    return left.commentRemoteVersion === right.commentRemoteVersion &&
      left.threadRootCommentId === right.threadRootCommentId && left.threadState === right.threadState;
  }
  return false;
}

function bodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function isRecoveredThreadAction(
  source: RootReconciliationView["tree"]["comments"][number],
  reply: UserCommentReply,
  existingReply: RootReconciliationView["tree"]["comments"][number] | undefined,
): boolean {
  return reply.source.kind === "comment_thread_state" && existingReply !== undefined &&
    source.thread_root_comment_id === reply.source.threadRootCommentId &&
    source.thread_state === (reply.threadAction === "resolve" ? "resolved" : "unresolved");
}

function failed(code: string): { kind: "failed"; code: string } {
  return { kind: "failed", code };
}
