import { createHash } from "node:crypto";

import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  CommentDisposition,
  RootDirective,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootReconcilerReplyWriterInterface } from "../api/RootReconcilerReplyWriterInterface.js";

const MAX_REPLY_BYTES = 32_768;
const MAX_REPLY_FIELD_LENGTH = 16_384;

export class LinearRootReconcilerReplyWriterImpl implements RootReconcilerReplyWriterInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async write(input: {
    directive: RootDirective;
    disposition: CommentDisposition;
    view: RootReconciliationView;
  }): Promise<{ kind: "materialized"; replyId: string } | { kind: "failed"; code: string }> {
    const source = input.view.tree.comments.find(({ comment_id }) => comment_id === input.disposition.sourceCommentId);
    if (!source) return failed("reply_source_comment_missing");
    if (source.remote_version !== input.disposition.sourceCommentVersion) return failed("reply_source_comment_stale");
    if (source.author_kind !== "human" || !source.author_user_id || source.author_id !== source.author_user_id) {
      return failed("reply_source_comment_actor_invalid");
    }
    if (source.managed_marker) return failed("reply_source_comment_managed");
    const acceptedDispositions = input.directive.commentDispositions.filter((disposition) =>
      disposition.sourceCommentId === input.disposition.sourceCommentId &&
      disposition.sourceCommentVersion === input.disposition.sourceCommentVersion);
    if (acceptedDispositions.length !== 1 || !sameDisposition(acceptedDispositions[0]!, input.disposition)) {
      return failed("reply_disposition_not_accepted");
    }

    const target = input.view.tree.issues.find(({ issue_id }) => issue_id === source.issue_id);
    const root = input.view.tree.issues.find(({ issue_id }) => issue_id === input.view.root.issueId);
    if (!target || !root) return failed("reply_target_missing");

    const replyId = deterministicReplyId({
      rootDirectiveId: input.directive.rootDirectiveId,
      sourceCommentId: source.comment_id,
      sourceCommentVersion: source.remote_version,
    });
    const existing = input.view.tree.comments.find(({ issue_id, managed_marker }) =>
      issue_id === target.issue_id && managed_marker === replyId);
    if (existing) return { kind: "materialized", replyId };

    const body = render(input.disposition, replyId);
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
        ...(target.managed_marker ? { expectedManagedMarker: target.managed_marker } : {}),
      },
      body,
    });
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      return failed(`reply_write_${outcome.kind}`);
    }

    const readBack = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
    const confirmed = readBack.comments.find(({ issue_id, managed_marker }) =>
      issue_id === target.issue_id && managed_marker === replyId);
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

function render(disposition: CommentDisposition, replyId: string): string | undefined {
  const fields = [
    disposition.reply.acknowledgement,
    disposition.reply.interpretedRequest,
    disposition.reply.decidedAction,
    disposition.reply.nextStep,
  ];
  if (fields.some((field) => field.length === 0 || field.length > MAX_REPLY_FIELD_LENGTH || /[\0\r]/u.test(field))) {
    return undefined;
  }
  return [
    `<!-- symphony root-reconciler-reply ${replyId} -->`,
    "## Symphony reply",
    "",
    "Acknowledgement",
    disposition.reply.acknowledgement,
    "",
    "Interpreted request",
    disposition.reply.interpretedRequest,
    "",
    "Decision",
    disposition.reply.decidedAction,
    "",
    "Next step",
    disposition.reply.nextStep,
    "",
  ].join("\n");
}

function sameDisposition(left: CommentDisposition, right: CommentDisposition): boolean {
  return left.sourceCommentId === right.sourceCommentId &&
    left.sourceCommentVersion === right.sourceCommentVersion &&
    left.interpretation === right.interpretation &&
    left.impact === right.impact &&
    left.decisionRef === right.decisionRef &&
    left.reply.acknowledgement === right.reply.acknowledgement &&
    left.reply.interpretedRequest === right.reply.interpretedRequest &&
    left.reply.decidedAction === right.reply.decidedAction &&
    left.reply.nextStep === right.reply.nextStep;
}

function failed(code: string): { kind: "failed"; code: string } {
  return { kind: "failed", code };
}
