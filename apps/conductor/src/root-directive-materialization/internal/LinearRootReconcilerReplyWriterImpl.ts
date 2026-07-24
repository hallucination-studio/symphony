import { createHash } from "node:crypto";

import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootDirective,
  RootReconciliationView,
  UserCommentReply,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootReconcilerReplyRecord } from "../../root-reconciliation/api/ManagedRecords.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-reconciliation/internal/ManagedRecordCodec.js";
import type { RootReconcilerReplyWriterInterface } from "../api/RootReconcilerReplyWriterInterface.js";

const MAX_REPLY_BYTES = 32_768;
const MAX_REPLY_FIELD_LENGTH = 16_384;

export class LinearRootReconcilerReplyWriterImpl implements RootReconcilerReplyWriterInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async write(input: {
    directive: RootDirective;
    reply: UserCommentReply;
    view: RootReconciliationView;
  }): Promise<{ kind: "materialized"; replyId: string } | { kind: "failed"; code: string }> {
    const source = input.view.tree.comments.find(({ comment_id }) => comment_id === input.reply.sourceCommentId);
    if (!source) return failed("reply_source_comment_missing");
    if (source.remote_version !== input.reply.sourceCommentVersion) return failed("reply_source_comment_stale");
    if (source.author_kind !== "human" || !source.author_user_id || source.author_id !== source.author_user_id) {
      return failed("reply_source_comment_actor_invalid");
    }
    const acceptedReplies = input.directive.commentReplies.filter((reply) =>
      reply.replyId === input.reply.replyId);
    if (acceptedReplies.length !== 1 || !sameReply(acceptedReplies[0]!, input.reply)) {
      return failed("reply_disposition_not_accepted");
    }

    const target = input.view.tree.issues.find(({ issue_id }) => issue_id === source.issue_id);
    const root = input.view.tree.issues.find(({ issue_id }) => issue_id === input.view.root.issueId);
    if (!target || !root) return failed("reply_target_missing");

    const replyId = input.reply.replyId;
    if (replyId !== deterministicReplyId({
      rootDirectiveId: input.directive.rootDirectiveId,
      sourceCommentId: source.comment_id,
      sourceCommentVersion: source.remote_version,
    })) return failed("reply_id_invalid");
    const existing = findReply(input.view.tree.comments, target.issue_id, replyId);
    if (existing) return { kind: "materialized", replyId };

    const body = render(input.reply, replyId, input.directive, target.issue_id, input.view.observedAt);
    if (!body) return failed("reply_content_invalid");
    if (Buffer.byteLength(body, "utf8") > MAX_REPLY_BYTES) return failed("reply_comment_too_large");

    const outcome = await this.linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId: replyId,
      expectedProjectId: target.project_id,
      rootIssueId: input.view.root.issueId,
      expectedRootRemoteVersion: root.remote_version,
      target: {
        targetIssueId: target.issue_id,
        expectedRemoteVersion: target.remote_version,
        expectedStatusId: target.status_id,
        ...(target.parent_issue_id ? { expectedParentIssueId: target.parent_issue_id } : {}),
      },
      body,
    });
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      return failed(`reply_write_${outcome.kind}`);
    }

    const readBack = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
    const confirmed = findReply(readBack.comments, target.issue_id, replyId);
    return confirmed ? { kind: "materialized", replyId } : failed("reply_read_back_missing");
  }
}

function deterministicReplyId(input: {
  rootDirectiveId: string;
  sourceCommentId: string;
  sourceCommentVersion: string;
}): string {
  return createHash("sha256")
    .update([input.rootDirectiveId, input.sourceCommentId, input.sourceCommentVersion].join("\0"))
    .digest("hex");
}

function render(reply: UserCommentReply, replyId: string, directive: RootDirective, targetIssueId: string, repliedAt: string): string | undefined {
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
  const record: RootReconcilerReplyRecord = {
    kind: "root_reconciler_reply",
    version: 1,
    replyId,
    replyWriteId: replyId,
    rootDirectiveId: directive.rootDirectiveId,
    sourceInputId: reply.sourceInputId,
    sourceCommentId: reply.sourceCommentId,
    sourceCommentVersion: reply.sourceCommentVersion,
    targetIssueId,
    disposition: reply.disposition,
    reaction: reply.reaction,
    threadAction: reply.threadAction,
    materializedOutcomeRefs: [],
    renderedSchemaVersion: "1",
    repliedAt,
  };
  return serializeManagedRecord(record, [
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
  ].join("\n"));
}

function sameReply(left: UserCommentReply, right: UserCommentReply): boolean {
  return left.replyId === right.replyId &&
    left.sourceCommentId === right.sourceCommentId &&
    left.sourceCommentVersion === right.sourceCommentVersion &&
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
  issueId: string,
  replyId: string,
) {
  const matches = comments.filter((comment) => {
    if (comment.issue_id !== issueId || comment.author_kind !== "symphony") return false;
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === "root_reconciler_reply" && parsed.value.replyId === replyId;
  });
  if (matches.length > 1) throw new Error("root_reconciler_reply_ambiguous");
  return matches[0];
}

function failed(code: string): { kind: "failed"; code: string } {
  return { kind: "failed", code };
}
