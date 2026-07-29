import type {
  RootStateCurrentIssueProof,
  RootStateCurrentIssueProvenancePolicyInterface,
} from "../api/RootStateCurrentIssueProvenancePolicyInterface.js";
import type { RootStateMechanicalCompilerResult } from "../api/RootStateMechanicalCompilerResult.js";
import type {
  RootStateIssue,
  RootStateView,
} from "../api/RootStateViewPolicyInterface.js";
import { deriveRootStateSuccessorPolicy } from "./RootStateSuccessorAdmission.js";

const PLAN_LABELS = Object.freeze(["symphony:kind/plan"]);

export function compileRootStateAuthorizedSuccessorConvergence(input: {
  view: RootStateView;
  provenance: RootStateCurrentIssueProvenancePolicyInterface;
  root: RootStateIssue;
  predecessor: RootStateIssue;
  successor: RootStateIssue;
  successorProof: RootStateCurrentIssueProof;
  predecessorCycleCount: number;
  observedAt: string;
  policy: {
    maxCyclesPerRoot: number;
    deadlineAt: string;
  };
}): RootStateMechanicalCompilerResult {
  const admission = deriveRootStateSuccessorPolicy(
    input.predecessorCycleCount,
    input.policy.maxCyclesPerRoot,
    input.observedAt,
    input.policy.deadlineAt,
  );
  if (admission !== "allowed") return invalid("mechanical_precondition_invalid");

  const successorDescendants = input.view.issues.filter((issue) =>
    issue.issueId !== input.successor.issueId &&
    isDescendantOf(issue, input.successor.issueId, input.view.issues));
  const plans = successorDescendants.filter(({ parentIssueId, issueKind }) =>
    parentIssueId === input.successor.issueId && issueKind === "plan");
  if (successorDescendants.length !== plans.length || plans.length > 1 ||
      input.view.relations.some(({ sourceIssueId, targetIssueId }) =>
        sourceIssueId === input.successor.issueId || targetIssueId === input.successor.issueId ||
        plans.some(({ issueId }) => issueId === sourceIssueId || issueId === targetIssueId)) ||
      !input.predecessor.isArchived && successorDescendants.length > 0) {
    return invalid("topology_invalid");
  }

  const predecessorDescendants = input.view.issues.filter((issue) =>
    issue.issueId !== input.predecessor.issueId &&
    isDescendantOf(issue, input.predecessor.issueId, input.view.issues));
  const liveDescendants = predecessorDescendants.filter(({ isArchived }) => !isArchived)
    .sort((left, right) => right.depth - left.depth || compareCodePoints(left.issueId, right.issueId));
  if (input.predecessor.isArchived && liveDescendants.length > 0) return invalid("topology_invalid");
  const archiveTarget = liveDescendants[0];
  if (archiveTarget) {
    return {
      kind: "effect",
      effect: { kind: "set_issue_archive_state", issueId: archiveTarget.issueId, isArchived: true },
    };
  }
  if (!input.predecessor.isArchived) {
    return {
      kind: "effect",
      effect: { kind: "set_issue_archive_state", issueId: input.predecessor.issueId, isArchived: true },
    };
  }

  const plan = plans[0];
  if (plan) {
    if (plan.projectId !== input.root.projectId || plan.statusName !== "Todo" || plan.isArchived ||
        plan.title !== "Plan" || plan.description !== input.successor.description ||
        !sameValues(plan.labels, PLAN_LABELS) ||
        !authorizedPlan(input, plan)) return invalid("topology_invalid");
    return { kind: "satisfied" };
  }

  const todo = input.view.statuses.filter(({ name }) => name === "Todo");
  if (todo.length !== 1) return invalid("status_catalog_invalid");
  return {
    kind: "effect",
    effect: {
      kind: "create_issue",
      parentIssueId: input.successor.issueId,
      statusId: todo[0]!.statusId,
      title: "Plan",
      description: input.successor.description,
      labelNames: PLAN_LABELS,
    },
  };
}

function authorizedPlan(
  input: Parameters<typeof compileRootStateAuthorizedSuccessorConvergence>[0],
  plan: RootStateIssue,
): boolean {
  const direct = input.provenance.prove({ view: input.view, issue: plan, requiredActivityKinds: [] });
  if (direct) return true;
  const sourceActor = input.successorProof.kind === "activity"
    ? input.successorProof.actorId
    : input.provenance.currentStatusActor({ view: input.view, issue: input.successor });
  return sourceActor !== undefined && input.provenance.prove({
    view: input.view,
    issue: plan,
    requiredActivityKinds: [],
    expectedActorId: sourceActor,
  }) !== undefined;
}

function isDescendantOf(issue: RootStateIssue, ancestorIssueId: string, issues: readonly RootStateIssue[]): boolean {
  const byId = new Map(issues.map((candidate) => [candidate.issueId, candidate]));
  const visited = new Set<string>();
  let parentIssueId = issue.parentIssueId;
  while (parentIssueId !== undefined && !visited.has(parentIssueId)) {
    if (parentIssueId === ancestorIssueId) return true;
    visited.add(parentIssueId);
    parentIssueId = byId.get(parentIssueId)?.parentIssueId;
  }
  return false;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(
  reason: Extract<RootStateMechanicalCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootStateMechanicalCompilerResult {
  return { kind: "invalid_facts", reason };
}
