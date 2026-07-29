import type { RootStateCurrentIssueProvenancePolicyInterface } from "../api/RootStateCurrentIssueProvenancePolicyInterface.js";
import type { RootStateInterruptedPlanSuccessorCompilerInterface } from "../api/RootStateInterruptedPlanSuccessorCompilerInterface.js";
import type { RootStateMechanicalCompilerResult } from "../api/RootStateMechanicalCompilerResult.js";
import type { RootStateView, RootStateViewPolicyInterface } from "../api/RootStateViewPolicyInterface.js";

export class RootStateInterruptedPlanSuccessorCompilerImpl implements RootStateInterruptedPlanSuccessorCompilerInterface {
  constructor(
    private readonly views: RootStateViewPolicyInterface,
    private readonly provenance: RootStateCurrentIssueProvenancePolicyInterface,
  ) {}

  compile(
    input: Parameters<RootStateInterruptedPlanSuccessorCompilerInterface["compile"]>[0],
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
    const cycle = unique(view.issues.filter(({ issueId }) => issueId === input.cycleIssueId));
    const predecessor = unique(view.issues.filter(({ issueId }) => issueId === input.predecessorPlanIssueId));
    const successor = unique(view.issues.filter(({ issueId }) => issueId === input.successorPlanIssueId));
    const activeCycles = view.issues.filter(({ issueKind, parentIssueId, isArchived }) =>
      issueKind === "cycle" && parentIssueId === root.issueId && !isArchived);
    if (root.statusName !== "In Progress" || root.isArchived || root.parentIssueId !== undefined ||
        activeCycles.length !== 1 || activeCycles[0]?.issueId !== cycle?.issueId ||
        !cycle || cycle.issueKind !== "cycle" || cycle.parentIssueId !== root.issueId ||
        cycle.projectId !== root.projectId || cycle.statusName !== "Planning" || cycle.isArchived ||
        !predecessor || predecessor.issueKind !== "plan" || predecessor.parentIssueId !== cycle.issueId ||
        predecessor.projectId !== root.projectId || predecessor.statusName !== "Interrupted" ||
        !successor || successor.issueKind !== "plan" || successor.parentIssueId !== cycle.issueId ||
        successor.projectId !== root.projectId || successor.statusName !== "Todo" || successor.isArchived ||
        !successor.labels.includes("Interrupted Plan Successor") ||
        !successor.labels.includes("symphony:kind/plan") ||
        compareIssues(predecessor, successor) >= 0 ||
        view.relations.some(({ sourceIssueId, targetIssueId }) =>
          sourceIssueId === cycle.issueId || targetIssueId === cycle.issueId ||
          sourceIssueId === predecessor.issueId || targetIssueId === predecessor.issueId ||
          sourceIssueId === successor.issueId || targetIssueId === successor.issueId)) {
      return invalid("topology_invalid");
    }

    const allowedActiveIds = new Set(predecessor.isArchived
      ? [successor.issueId]
      : [predecessor.issueId, successor.issueId]);
    if (view.issues.some(({ parentIssueId, isArchived, issueId }) =>
      parentIssueId === cycle.issueId && !isArchived && !allowedActiveIds.has(issueId))) {
      return invalid("topology_invalid");
    }

    const directProof = this.provenance.prove({ view, issue: successor, requiredActivityKinds: [] });
    const predecessorActor = directProof
      ? undefined
      : this.provenance.currentStatusActor({ view, issue: predecessor });
    const authorized = directProof !== undefined || (predecessorActor !== undefined &&
      this.provenance.prove({
        view, issue: successor, requiredActivityKinds: [], expectedActorId: predecessorActor,
      }) !== undefined);
    if (!authorized) return invalid("topology_invalid");
    return predecessor.isArchived
      ? { kind: "satisfied" }
      : {
          kind: "effect",
          effect: { kind: "set_issue_archive_state", issueId: predecessor.issueId, isArchived: true },
        };
  }
}

function compareIssues(
  left: { createdAt: string; issueId: string },
  right: { createdAt: string; issueId: string },
): number {
  return left.createdAt.localeCompare(right.createdAt) || compareCodePoints(left.issueId, right.issueId);
}

function unique<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<RootStateMechanicalCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootStateMechanicalCompilerResult {
  return { kind: "invalid_facts", reason };
}
