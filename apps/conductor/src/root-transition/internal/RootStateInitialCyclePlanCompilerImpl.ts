import type { RootStateInitialCyclePlanCompilerInterface } from "../api/RootStateInitialCyclePlanCompilerInterface.js";
import type { RootStateMechanicalCompilerResult } from "../api/RootStateMechanicalCompilerResult.js";
import type { RootStateRequirement } from "../api/RootStateRequirement.js";
import type { RootStateIssue, RootStateView, RootStateViewPolicyInterface } from "../api/RootStateViewPolicyInterface.js";
import { parseCanonicalRootRequirement } from "./CanonicalRootRequirement.js";

export class RootStateInitialCyclePlanCompilerImpl implements RootStateInitialCyclePlanCompilerInterface {
  constructor(private readonly views: RootStateViewPolicyInterface) {}

  compile(
    input: Parameters<RootStateInitialCyclePlanCompilerInterface["compile"]>[0],
  ): RootStateMechanicalCompilerResult {
    if (input.worktreeFence !== "valid") return invalid("mechanical_precondition_invalid");

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
    const requirement = parseCanonicalRootRequirement(root.description);
    if (root.statusName !== "In Progress" || root.isArchived || root.parentIssueId !== undefined ||
        !requirement) return invalid("topology_invalid");
    const planning = unique(view.statuses.filter(({ name }) => name === "Planning"));
    const todo = unique(view.statuses.filter(({ name }) => name === "Todo"));
    if (!planning || !todo) return invalid("status_catalog_invalid");

    const descendants = view.issues.filter(({ issueId }) => issueId !== root.issueId);
    if (descendants.length === 0) {
      return {
        kind: "effect",
        effect: {
          kind: "create_issue", parentIssueId: root.issueId, statusId: planning.statusId,
          title: "Cycle 1", description: requirement.objective,
          labelNames: ["symphony:kind/cycle"],
        },
      };
    }

    const cycles = descendants.filter(({ issueKind }) => issueKind === "cycle");
    const cycle = unique(cycles);
    if (!cycle || !isInitialCycle(cycle, root, requirement) || view.relations.length !== 0) {
      return invalid("topology_invalid");
    }
    const children = descendants.filter(({ parentIssueId }) => parentIssueId === cycle.issueId);
    if (descendants.length !== 1 + children.length || children.some(({ issueKind }) => issueKind !== "plan")) {
      return invalid("topology_invalid");
    }
    const plans = children.filter(({ issueKind }) => issueKind === "plan");
    const desiredPlanDescription = renderInitialPlan(requirement);
    if (plans.length === 0) {
      return {
        kind: "effect",
        effect: {
          kind: "create_issue", parentIssueId: cycle.issueId, statusId: todo.statusId,
          title: "Plan", description: desiredPlanDescription,
          labelNames: ["symphony:kind/plan"],
        },
      };
    }
    return plans.length === 1 && isInitialPlan(plans[0]!, cycle, desiredPlanDescription)
      ? { kind: "satisfied" }
      : invalid("topology_invalid");
  }
}

function isInitialCycle(cycle: RootStateIssue, root: RootStateIssue, requirement: RootStateRequirement): boolean {
  return cycle.parentIssueId === root.issueId && cycle.projectId === root.projectId &&
    cycle.statusName === "Planning" && !cycle.isArchived && cycle.title === "Cycle 1" &&
    cycle.description === requirement.objective && sameLabels(cycle.labels, ["symphony:kind/cycle"]);
}

function isInitialPlan(plan: RootStateIssue, cycle: RootStateIssue, description: string): boolean {
  return plan.parentIssueId === cycle.issueId && plan.projectId === cycle.projectId &&
    plan.statusName === "Todo" && !plan.isArchived && plan.title === "Plan" &&
    plan.description === description && sameLabels(plan.labels, ["symphony:kind/plan"]);
}

function renderInitialPlan(requirement: RootStateRequirement): string {
  const sections = [
    "# Plan Goal", "", requirement.objective, "", "## Requested Scope", "", requirement.requestedScope,
  ];
  if (requirement.constraints.length > 0) {
    sections.push("", "## Constraints", "", ...requirement.constraints.map((value) => `- ${value}`));
  }
  sections.push("", "## Acceptance And Verification", "",
    ...requirement.acceptanceCriteria.map((value) => `- ${value} (provider-defined verification)`));
  return sections.join("\n");
}

function sameLabels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unique<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function invalid(
  reason: Extract<RootStateMechanicalCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootStateMechanicalCompilerResult {
  return { kind: "invalid_facts", reason };
}
