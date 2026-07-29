import { createHash } from "node:crypto";

import {
  humanActionRequest,
  humanActionRequestIsActive,
} from "../../human-actions/api/HumanActionSummary.js";
import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootCommentDisposition,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { rootInputId } from "../../root-reconciliation/internal/RootInputIdentity.js";
import type { RootReconcilerReplyWriterInterface } from "../api/RootReconcilerReplyWriterInterface.js";

const MAX_REPLY_BYTES = 32_768;
const MAX_REPLY_FIELD_LENGTH = 16_384;

type WorkflowComment = RootReconciliationView["tree"]["comments"][number];
type MaterializationResult = { kind: "materialized" } | { kind: "failed"; code: string };

export class LinearRootReconcilerReplyWriterImpl implements RootReconcilerReplyWriterInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async write(input: {
    operationId: string;
    disposition: RootCommentDisposition;
    view: RootReconciliationView;
    completion?: "complete" | "adoption_only";
  }): Promise<MaterializationResult> {
    if (!input.operationId.trim()) return failed("reply_operation_id_invalid");
    let tree = input.view.tree;
    let source = sourceComment(tree, input.disposition);
    if (!source) return failed("reply_source_comment_missing");
    if (!authorizedRootHuman(tree, source)) return failed("reply_source_comment_actor_invalid");
    const request = humanActionRequest(tree, input.view.root.issueId, source);
    const adoptionOnly = input.completion === "adoption_only";
    if (adoptionOnly && (input.disposition.kind !== "applied" || request?.actionKind !== "finding_waiver" ||
        source.parent_comment_id !== request.request.comment_id ||
        !humanActionRequestIsActive(tree, request.request))) {
      return failed("reply_finding_waiver_adoption_invalid");
    }
    if (!adoptionOnly && request) {
      return failed("reply_source_human_action_invalid");
    }
    if (input.disposition.kind === "needs_response" && !hasUniqueActiveInformationRequest(tree, input.view.root.issueId)) {
      return failed("reply_information_request_missing");
    }

    let target = targetIssue(tree, source.issue_id);
    let root = rootIssue(tree, input.view.root.issueId);
    if (!target || !root) return failed("reply_target_missing");

    const replyId = deterministicReplyId(input.operationId, input.disposition);
    const body = render(input.disposition);
    if (!body) return failed("reply_content_invalid");
    if (Buffer.byteLength(body, "utf8") > MAX_REPLY_BYTES) return failed("reply_comment_too_large");

    let replyMatches = matchingReplies(tree.comments, source, body);
    if (replyMatches.length > 1) return failed("reply_read_back_ambiguous");
    let replyComment = replyMatches[0];
    const sourceValidation = validateSource(source, input.disposition);
    if (sourceValidation && !isRecoveredDisposition(source, input.disposition, replyComment)) {
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
      source = sourceComment(tree, input.disposition);
      target = source ? targetIssue(tree, source.issue_id) : undefined;
      root = rootIssue(tree, input.view.root.issueId);
      if (!source || !target || !root) return failed("reply_read_back_missing");
      replyMatches = matchingReplies(tree.comments, source, body);
      if (replyMatches.length > 1) return failed("reply_read_back_ambiguous");
      replyComment = replyMatches[0];
      if (!replyComment) return failed("reply_read_back_missing");
    }

    if (adoptionOnly) return { kind: "materialized" };

    const desiredReceipt = input.disposition.kind === "not_applied" ? "cross" : "check";
    const observedReceipt = receipt(source);
    if (observedReceipt === undefined) return failed("reply_receipt_ambiguous");
    if (observedReceipt !== "none" && observedReceipt !== desiredReceipt) {
      const removeOutcome = await this.linear.mutateWorkflow({
        kind: "remove_comment_receipt_reaction",
        writeId: `${replyId}:receipt-remove`,
        expectedProjectId: target.project_id,
        rootIssueId: input.view.root.issueId,
        expectedRootRemoteVersion: root.remote_version,
        replyWriteId: replyId,
        sourceCommentId: source.comment_id,
        expectedSourceCommentRemoteVersion: source.remote_version,
        threadRootCommentId: source.thread_root_comment_id,
        expectedReceipt: observedReceipt,
      });
      if (!applied(removeOutcome)) return failed(`reply_reaction_remove_${removeOutcome.kind}`);
      tree = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
      source = sourceComment(tree, input.disposition);
      target = source ? targetIssue(tree, source.issue_id) : undefined;
      root = rootIssue(tree, input.view.root.issueId);
      replyMatches = source ? matchingReplies(tree.comments, source, body) : [];
      if (replyMatches.length > 1) return failed("reply_read_back_ambiguous");
      replyComment = replyMatches[0];
      if (!source || !target || !root || !replyComment || receipt(source) !== "none") {
        return failed("reply_reaction_remove_read_back_missing");
      }
    }

    const currentReceipt = receipt(source);
    if (currentReceipt === undefined) return failed("reply_receipt_ambiguous");
    if (currentReceipt === "none") {
      const createOutcome = await this.linear.mutateWorkflow({
        kind: "create_comment_receipt_reaction",
        writeId: `${replyId}:receipt-create`,
        expectedProjectId: target.project_id,
        rootIssueId: input.view.root.issueId,
        expectedRootRemoteVersion: root.remote_version,
        replyWriteId: replyId,
        sourceCommentId: source.comment_id,
        expectedSourceCommentRemoteVersion: source.remote_version,
        threadRootCommentId: source.thread_root_comment_id,
        receipt: desiredReceipt,
      });
      if (!applied(createOutcome)) return failed(`reply_reaction_create_${createOutcome.kind}`);
      tree = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
      source = sourceComment(tree, input.disposition);
      target = source ? targetIssue(tree, source.issue_id) : undefined;
      root = rootIssue(tree, input.view.root.issueId);
      replyMatches = source ? matchingReplies(tree.comments, source, body) : [];
      if (replyMatches.length > 1) return failed("reply_read_back_ambiguous");
      replyComment = replyMatches[0];
      if (!source || !target || !root || !replyComment || receipt(source) !== desiredReceipt) {
        return failed("reply_reaction_create_read_back_missing");
      }
    }

    if (source.thread_state !== "resolved") {
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
        threadState: "resolved",
      });
      if (!applied(stateOutcome)) return failed(`reply_thread_state_${stateOutcome.kind}`);
      tree = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
      source = sourceComment(tree, input.disposition);
      replyMatches = source ? matchingReplies(tree.comments, source, body) : [];
      if (replyMatches.length > 1) return failed("reply_read_back_ambiguous");
      replyComment = replyMatches[0];
      if (!source || !replyComment || source.thread_state !== "resolved" || receipt(source) !== desiredReceipt) {
        return failed("reply_thread_state_read_back_missing");
      }
    }
    return { kind: "materialized" };
  }
}

function deterministicReplyId(operationId: string, disposition: RootCommentDisposition): string {
  return createHash("sha256")
    .update([operationId, disposition.sourceInputId, disposition.kind].join("\0"))
    .digest("hex");
}

function render(disposition: RootCommentDisposition): string | undefined {
  const content = disposition.kind === "applied" ? disposition.summary
    : disposition.kind === "not_applied" ? disposition.reason
    : disposition.kind === "answer_only" ? disposition.answer
    : disposition.reply;
  if (!content.trim() || content.length > MAX_REPLY_FIELD_LENGTH || /[\0\r]/u.test(content)) return undefined;
  const heading = disposition.kind === "not_applied" ? "## 未应用"
    : disposition.kind === "answer_only" ? "## 回复"
    : disposition.kind === "needs_response" ? "## 需要补充信息"
    : "## 已应用";
  return `${heading}\n\n${content.trim()}`;
}

function sourceComment(tree: RootReconciliationView["tree"], disposition: RootCommentDisposition): WorkflowComment | undefined {
  return tree.comments.find(({ comment_id }) => comment_id === disposition.source.commentId);
}

function validateSource(source: WorkflowComment, disposition: RootCommentDisposition): string | undefined {
  if (source.author_kind !== "human" || !source.author_user_id || source.author_id !== source.author_user_id) {
    return "reply_source_comment_actor_invalid";
  }
  if (disposition.source.kind === "comment_body") {
    if (bodyDigest(source.body) !== disposition.source.commentBodyDigest ||
        disposition.sourceInputId !== rootInputId(`comment_body:${source.comment_id}`, disposition.source.commentBodyDigest)) {
      return "reply_source_comment_stale";
    }
    return undefined;
  }
  if (source.thread_root_comment_id !== disposition.source.threadRootCommentId ||
      source.thread_state !== disposition.source.threadState ||
      disposition.sourceInputId !== rootInputId(
        `comment_thread_state:${source.comment_id}:${source.thread_root_comment_id}:${source.thread_state}`,
        source.remote_version,
      )) {
    return "reply_source_thread_state_stale";
  }
  return undefined;
}

function authorizedRootHuman(tree: RootReconciliationView["tree"], source: WorkflowComment): boolean {
  if (source.author_kind !== "human" || !source.author_user_id || source.author_id !== source.author_user_id) {
    return false;
  }
  const root = rootIssue(tree, tree.root_issue_id);
  return Boolean(root && (root.creator_user_id === source.author_user_id || root.assignee_user_id === source.author_user_id));
}

function isRecoveredDisposition(
  source: WorkflowComment,
  disposition: RootCommentDisposition,
  reply: WorkflowComment | undefined,
): boolean {
  return disposition.source.kind === "comment_thread_state" && reply !== undefined && source.thread_state === "resolved";
}

function hasUniqueActiveInformationRequest(tree: RootReconciliationView["tree"], rootIssueId: string): boolean {
  const requests = tree.comments.filter((comment) => {
    const identified = humanActionRequest(tree, rootIssueId, comment);
    return identified?.actionKind === "information" &&
      identified.request.comment_id === comment.comment_id &&
      humanActionRequestIsActive(tree, identified.request);
  });
  return requests.length === 1;
}

function matchingReplies(comments: WorkflowComment[], source: WorkflowComment, body: string): WorkflowComment[] {
  return comments.filter((comment) =>
    comment.issue_id === source.issue_id &&
    comment.parent_comment_id === source.comment_id &&
    comment.thread_root_comment_id === source.thread_root_comment_id &&
    comment.author_kind === "symphony" &&
    comment.body === body);
}

function rootIssue(tree: RootReconciliationView["tree"], rootIssueId: string) {
  return tree.issues.find(({ issue_id }) => issue_id === rootIssueId);
}

function targetIssue(tree: RootReconciliationView["tree"], issueId: string) {
  return tree.issues.find(({ issue_id }) => issue_id === issueId);
}

function receipt(comment: WorkflowComment): "check" | "cross" | "none" | undefined {
  const receipts = comment.reactions.filter(({ actor_kind, emoji }) =>
    actor_kind === "symphony" && (emoji === "✅" || emoji === "❌"));
  if (receipts.length > 1) return undefined;
  return receipts[0]?.emoji === "✅" ? "check" : receipts[0]?.emoji === "❌" ? "cross" : "none";
}

function applied(outcome: Awaited<ReturnType<LinearGatewayInterface["mutateWorkflow"]>>): boolean {
  return outcome.kind === "applied" || outcome.kind === "already_applied";
}

function bodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function failed(code: string): MaterializationResult {
  return { kind: "failed", code };
}
