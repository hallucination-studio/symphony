import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { parseManagedRecord } from "../../root-reconciliation/api/index.js";
import type { HumanActionKind } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type {
  HumanActionResolutionValidationResult,
  HumanActionResolutionValidatorInterface,
} from "../api/HumanActionResolutionValidatorInterface.js";

const kindLabels: Record<string, HumanActionKind> = {
  "Plan Review": "plan_review",
  Clarification: "clarification",
  Permission: "permission",
  "Finding Waiver": "finding_waiver",
  "Convergence Override": "convergence_override",
};

const approvalStatuses = new Set(["Approved", "Rejected", "Canceled"]);

export class LinearHumanActionResolutionValidatorImpl implements HumanActionResolutionValidatorInterface {
  validate(input: {
    tree: LinearWorkflowTreeSnapshot;
    actionIssueId: string;
  }): HumanActionResolutionValidationResult {
    const action = input.tree.issues.find(({ issue_id }) => issue_id === input.actionIssueId);
    if (!action) return invalid("human_action_not_found");
    if (action.issue_kind !== "human") return invalid("human_action_kind_invalid");

    const actionKind = actionKindFromLabels(action.labels);
    if (!actionKind) return invalid("human_action_kind_invalid");

    const duplicate = input.tree.comments.some((comment) => {
      if (comment.issue_id !== action.issue_id || comment.author_kind !== "symphony") return false;
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok && parsed.value.kind === "human_action_resolution" && parsed.value.actionIssueId === action.issue_id;
    });
    if (duplicate) return invalid("human_action_resolution_duplicate");

    const terminalOutcome = outcomeFor(actionKind, action.status_name);
    if (terminalOutcome === "invalid") return invalid("human_action_terminal_status_invalid");
    if (terminalOutcome === "pending") return { kind: "pending", reason: "not_terminal" };
    if (terminalOutcome === "canceled" || terminalOutcome === "approved") {
      return valid(action.issue_id, terminalOutcome, []);
    }

    const responseComments = input.tree.comments
      .filter((comment) => comment.issue_id === action.issue_id)
      .filter((comment) => comment.updated_at <= action.updated_at);
    const managedComments = responseComments.filter(isManagedComment);
    const humanComments = responseComments.filter((comment) => comment.author_kind === "human");

    for (const comment of humanComments) {
      if (!comment.author_user_id || comment.author_id !== comment.author_user_id) {
        return invalid("human_action_resolution_actor_invalid");
      }
      if (comment.body.trim().length === 0) return invalid("human_action_resolution_comment_empty");
    }

    if (humanComments.length === 0) {
      if (managedComments.length > 0) return invalid("human_action_resolution_comment_managed");
      if (responseComments.some(({ author_kind }) => author_kind !== "human")) {
        return invalid("human_action_resolution_actor_invalid");
      }
      return {
        kind: "pending",
        reason: terminalOutcome === "rejected" ? "missing_reason" : "missing_answer",
      };
    }

    return valid(
      action.issue_id,
      terminalOutcome,
      humanComments
        .slice()
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.comment_id.localeCompare(right.comment_id))
        .map(({ comment_id }) => comment_id),
    );
  }
}

function actionKindFromLabels(labels: string[]): HumanActionKind | undefined {
  if (labels.filter((label) => label === "Human Action").length !== 1) return undefined;
  const kinds = labels.filter((label) => kindLabels[label] !== undefined).map((label) => kindLabels[label]!);
  return kinds.length === 1 ? kinds[0] : undefined;
}

function outcomeFor(
  actionKind: HumanActionKind,
  status: string,
): "approved" | "rejected" | "answered" | "canceled" | "pending" | "invalid" {
  if (status === "Todo" || status === "In Progress") return "pending";
  if (status === "Canceled") return "canceled";
  if (actionKind === "clarification") return status === "Answered" ? "answered" : "invalid";
  if (!approvalStatuses.has(status)) return "invalid";
  return status.toLowerCase() as "approved" | "rejected" | "canceled";
}

function isManagedComment(comment: LinearWorkflowTreeSnapshot["comments"][number]): boolean {
  return comment.author_kind === "symphony" && parseManagedRecord(comment.body).ok;
}

function valid(
  actionId: string,
  outcome: "approved" | "rejected" | "answered" | "canceled",
  sourceCommentIds: string[],
): HumanActionResolutionValidationResult {
  return { kind: "valid", actionId, outcome, sourceCommentIds };
}

function invalid(reason: string): HumanActionResolutionValidationResult {
  return { kind: "invalid", reason };
}
