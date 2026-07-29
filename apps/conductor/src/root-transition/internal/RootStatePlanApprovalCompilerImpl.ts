import { createHash } from "node:crypto";

import { humanActionTargetIdentifiersFromBody } from "../../human-actions/api/HumanActionScope.js";
import type {
  RootStatePlanApprovalCompilerInterface,
  RootStatePlanApprovalCompilerResult,
  RootStatePlanApprovalIntent,
} from "../api/RootStatePlanApprovalCompilerInterface.js";
import type {
  RootStateComment,
  RootStateView,
  RootStateViewPolicyInterface,
} from "../api/RootStateViewPolicyInterface.js";

export class RootStatePlanApprovalCompilerImpl implements RootStatePlanApprovalCompilerInterface {
  constructor(private readonly views: RootStateViewPolicyInterface) {}

  compile(
    input: Parameters<RootStatePlanApprovalCompilerInterface["compile"]>[0],
  ): RootStatePlanApprovalCompilerResult {
    if (input.intent.semanticGate !== "plan_human_decision") return invalid("gate_mismatch");
    if (input.intent.intent.kind !== "approve_plan") return invalid("decision_incompatible");
    if (!validInputDisposition(input.intent)) return invalid("input_disposition_invalid");

    let view: RootStateView;
    try {
      view = this.views.derive(input.state);
    } catch (error) {
      if (error instanceof Error && error.message === "recovered_root_state_view_invalid") {
        return invalid("topology_invalid");
      }
      throw error;
    }

    const { root } = view;
    const plan = unique(view.issues.filter(({ issueId }) => issueId === input.intent.subject.planIssueId));
    const cycle = plan?.parentIssueId
      ? unique(view.issues.filter(({ issueId }) => issueId === plan.parentIssueId))
      : undefined;
    if (input.intent.rootIssueId !== root.issueId || root.isArchived || root.parentIssueId !== undefined ||
        !cycle || cycle.issueKind !== "cycle" || cycle.parentIssueId !== root.issueId || cycle.isArchived ||
        cycle.projectId !== root.projectId || cycle.statusName !== "Planning" ||
        !plan || plan.issueKind !== "plan" || plan.parentIssueId !== cycle.issueId || plan.isArchived ||
        plan.projectId !== root.projectId || !plan.labels.includes("symphony:kind/plan") ||
        (plan.statusName !== "In Review" && plan.statusName !== "Approved")) {
      return invalid("topology_invalid");
    }
    if (digest(plan.description) !== input.intent.subject.planContentDigest) return invalid("subject_stale");

    const request = unique(view.comments.filter(({ commentId }) =>
      commentId === input.intent.subject.approvalThreadRootCommentId));
    const reply = unique(view.comments.filter(({ commentId }) =>
      commentId === input.intent.subject.decisionReplyCommentId));
    if (!validApproval(view, request, reply, plan.identifier, input.intent)) {
      return invalid("authorization_invalid");
    }
    if (plan.statusName === "Approved") return { kind: "satisfied" };
    if (input.intent.basedOnRootDigest !== view.contentDigest) return invalid("subject_stale");

    const approved = view.statuses.filter(({ name }) => name === "Approved");
    if (approved.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      effect: {
        kind: "update_issue", issueId: plan.issueId, statusId: approved[0]!.statusId,
        title: plan.title, description: plan.description, labelNames: plan.labels, order: plan.order,
      },
    };
  }
}

function validApproval(
  view: RootStateView,
  request: RootStateComment | undefined,
  reply: RootStateComment | undefined,
  planIdentifier: string,
  intent: RootStatePlanApprovalIntent,
): boolean {
  const { root } = view;
  const subject = intent.subject;
  return subject.actorAuthorization === "authorized" && !!request && !!reply &&
    request.issueId === root.issueId && request.authorKind === "symphony" &&
    request.parentCommentId === undefined && request.threadRootCommentId === request.commentId &&
    request.body.split("\n", 1)[0] === "## 需要你审批" &&
    sameIds(humanActionTargetIdentifiersFromBody(request.body) ?? [], [planIdentifier]) &&
    reply.issueId === root.issueId && reply.parentCommentId === request.commentId &&
    reply.threadRootCommentId === request.commentId && reply.authorKind === "human" &&
    reply.authorId === subject.actorId && reply.authorUserId === subject.actorId &&
    (root.creatorUserId === subject.actorId || root.assigneeUserId === subject.actorId) &&
    digest(reply.body) === subject.decisionReplyBodyDigest &&
    currentComment(view, request, "symphony") && currentComment(view, reply, "human");
}

function validInputDisposition(intent: RootStatePlanApprovalIntent): boolean {
  const inputIds = intent.pendingInputRefs.map(({ inputId }) => inputId).sort(compareCodePoints);
  const consumed = [...intent.consumedInputIds].sort(compareCodePoints);
  const dispositionIds = intent.commentDispositions.map(({ sourceInputId }) => sourceInputId).sort(compareCodePoints);
  if (inputIds.length === 0 || new Set(inputIds).size !== inputIds.length ||
      new Set(consumed).size !== consumed.length || inputIds.length !== consumed.length ||
      inputIds.some((id, index) => id !== consumed[index]) ||
      new Set(dispositionIds).size !== dispositionIds.length || !sameIds(dispositionIds, inputIds)) return false;
  return intent.commentDispositions.every((disposition) => {
    const ref = intent.pendingInputRefs.find(({ inputId }) => inputId === disposition.sourceInputId);
    return disposition.kind === "applied" && ref?.sourceKind === "comment_body" &&
      ref.nativeSourceIdentity === disposition.source.commentId &&
      ref.sourceVersionOrDigest === disposition.source.commentBodyDigest &&
      disposition.source.commentId === intent.subject.decisionReplyCommentId &&
      disposition.source.commentBodyDigest === intent.subject.decisionReplyBodyDigest;
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort(compareCodePoints)
    .every((value, index) => value === [...right].sort(compareCodePoints)[index]);
}

function currentComment(
  view: RootStateView,
  comment: RootStateComment,
  actorKind: "human" | "symphony",
): boolean {
  const sources = view.provenance.filter(({ sourceKind, sourceId }) =>
    sourceKind === "linear_comment" && sourceId === comment.commentId);
  return sources.length === 1 && sources[0]?.actorKind === actorKind;
}

function unique<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<RootStatePlanApprovalCompilerResult, { kind: "invalid_intent" }>["reason"],
): RootStatePlanApprovalCompilerResult {
  return { kind: "invalid_intent", reason };
}
