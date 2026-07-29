import type {
  RootStateInitialRequirementCompilerInterface,
  RootStateInitialRequirementCompilerResult,
  RootStateInitialRequirementIntent,
} from "../api/RootStateInitialRequirementCompilerInterface.js";
import type { RootStateView, RootStateViewPolicyInterface } from "../api/RootStateViewPolicyInterface.js";
import {
  isValidRootStateRequirement,
  renderCanonicalRootRequirement,
} from "./CanonicalRootRequirement.js";

export class RootStateInitialRequirementCompilerImpl implements RootStateInitialRequirementCompilerInterface {
  constructor(private readonly views: RootStateViewPolicyInterface) {}

  compile(
    input: Parameters<RootStateInitialRequirementCompilerInterface["compile"]>[0],
  ): RootStateInitialRequirementCompilerResult {
    if (input.intent.semanticGate !== "requirement_and_comment") return invalid("gate_mismatch");

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
    if (input.intent.rootIssueId !== root.issueId || input.intent.basedOnRootDigest !== view.contentDigest) {
      return invalid("subject_stale");
    }
    if (root.isArchived || root.parentIssueId !== undefined || root.statusName !== "Todo" ||
        view.issues.some(({ issueId }) => issueId !== root.issueId) || view.relations.length !== 0) {
      return invalid("topology_invalid");
    }
    if (input.intent.consumedInputIds.length !== 0 || input.intent.commentDispositions.length !== 0) {
      return invalid("input_disposition_invalid");
    }
    if (input.intent.intent.activeCycleImpact !== "initial") return invalid("impact_invalid");
    if (!validRequirement(input.intent)) return invalid("requirement_invalid");

    const inProgress = view.statuses.filter(({ name }) => name === "In Progress");
    if (inProgress.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      effect: {
        kind: "update_issue", issueId: root.issueId, statusId: inProgress[0]!.statusId,
        title: root.title, description: renderCanonicalRootRequirement(input.intent.intent.requirement),
        labelNames: root.labels, order: root.order,
      },
    };
  }
}

function validRequirement(input: RootStateInitialRequirementIntent): boolean {
  return isValidRootStateRequirement(input.intent.requirement);
}

function invalid(
  reason: Extract<RootStateInitialRequirementCompilerResult, { kind: "invalid_intent" }>["reason"],
): RootStateInitialRequirementCompilerResult {
  return { kind: "invalid_intent", reason };
}
