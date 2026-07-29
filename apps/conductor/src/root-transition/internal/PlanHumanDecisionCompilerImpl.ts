import { createHash } from "node:crypto";

import { humanActionRequest } from "../../human-actions/api/HumanActionSummary.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  PlanHumanDecisionCompilerInterface,
  PlanHumanDecisionCompilerResult,
} from "../api/PlanHumanDecisionCompilerInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

export class PlanHumanDecisionCompilerImpl implements PlanHumanDecisionCompilerInterface {
  compile(input: Parameters<PlanHumanDecisionCompilerInterface["compile"]>[0]): PlanHumanDecisionCompilerResult {
    const { command, intent, view } = input;
    if (intent.semanticGate !== command.semanticGate) return invalid("gate_mismatch");
    if (intent.intent.kind !== "approve_plan") return invalid("decision_incompatible");
    if (!validInputDisposition(command, intent)) return invalid("input_disposition_invalid");

    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const plan = view.tree.issues.find(({ issue_id }) => issue_id === command.subject.planIssueId);
    const cycle = plan?.parent_issue_id
      ? view.tree.issues.find(({ issue_id }) => issue_id === plan.parent_issue_id)
      : undefined;
    if (!root || root.issue_kind !== "root" || root.parent_issue_id !== undefined || root.is_archived ||
        root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id ||
        !cycle || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
        cycle.project_id !== root.project_id || cycle.status_name !== "Planning" ||
        !plan || plan.issue_kind !== "plan" || plan.parent_issue_id !== cycle.issue_id || plan.is_archived ||
        plan.project_id !== root.project_id || !plan.labels.includes("symphony:kind/plan") ||
        !["In Review", "Approved"].includes(plan.status_name)) {
      return invalid("topology_invalid");
    }
    if (digest(plan.description) !== command.subject.planContentDigest) return invalid("subject_stale");

    const request = view.tree.comments.find(({ comment_id }) =>
      comment_id === command.subject.approvalThreadRootCommentId);
    const reply = view.tree.comments.find(({ comment_id }) =>
      comment_id === command.subject.decisionReplyCommentId);
    const identified = request ? humanActionRequest(view.tree, root.issue_id, request) : undefined;
    if (!request || identified?.actionKind !== "plan_approval" || identified.request !== request ||
        !request.body.includes(plan.identifier) || !reply || reply.issue_id !== root.issue_id ||
        reply.parent_comment_id !== request.comment_id || reply.thread_root_comment_id !== request.comment_id ||
        reply.author_kind !== "human" || reply.author_id !== command.subject.actorId ||
        reply.author_user_id !== command.subject.actorId ||
        (root.creator_user_id !== command.subject.actorId && root.assignee_user_id !== command.subject.actorId) ||
        digest(reply.body) !== command.subject.decisionReplyBodyDigest) {
      return invalid("authorization_invalid");
    }
    if (plan.status_name === "Approved") return { kind: "satisfied" };

    const approved = uniqueStatus(view.tree, "Approved");
    if (!approved) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      command: {
        kind: "update_workflow_issue",
        writeId: mechanicalWriteId([
          root.issue_id, plan.issue_id, "approve-plan", command.subject.decisionReplyCommentId,
        ]),
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: plan.issue_id,
          expectedRemoteVersion: plan.remote_version,
          expectedStatusId: plan.status_id,
          expectedParentIssueId: cycle.issue_id,
          expectedIsArchived: false,
        },
        statusId: approved.status_id,
        title: plan.title,
        description: plan.description,
        labelNames: plan.labels,
        parentAssignment: { mode: "retain" },
        order: plan.order,
      },
    };
  }
}

function validInputDisposition(
  command: Parameters<PlanHumanDecisionCompilerInterface["compile"]>[0]["command"],
  intent: Parameters<PlanHumanDecisionCompilerInterface["compile"]>[0]["intent"],
): boolean {
  const inputIds = command.pendingInputRefs.map(({ inputId }) => inputId).sort(compareCodePoints);
  if (inputIds.length === 0 || inputIds.length !== intent.consumedInputIds.length ||
      inputIds.some((id, index) => id !== [...intent.consumedInputIds].sort(compareCodePoints)[index])) return false;
  const dispositions = intent.commentDispositions;
  if (dispositions.length !== command.pendingInputRefs.length || dispositions.some(({ kind }) => kind !== "applied")) return false;
  return dispositions.every((disposition) => {
    const ref = command.pendingInputRefs.find(({ inputId }) => inputId === disposition.sourceInputId);
    return ref?.sourceKind === "comment_body" && disposition.source.kind === "comment_body" &&
      ref.nativeSourceIdentity === disposition.source.commentId &&
      disposition.source.commentId === command.subject.decisionReplyCommentId &&
      disposition.source.commentBodyDigest === command.subject.decisionReplyBodyDigest;
  });
}

function uniqueStatus(tree: LinearWorkflowTreeSnapshot, name: string) {
  const statuses = tree.status_catalog.filter((status) => status.name === name);
  return statuses.length === 1 ? statuses[0] : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<PlanHumanDecisionCompilerResult, { kind: "invalid_intent" }>["reason"],
): PlanHumanDecisionCompilerResult {
  return { kind: "invalid_intent", reason };
}
