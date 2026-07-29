import type {
  RootStateInterruptedPlanSuccessorCreationCompilerInterface,
  RootStateInterruptedPlanSuccessorCreationCompilerResult,
} from "../api/RootStateInterruptedPlanSuccessorCreationCompilerInterface.js";
import type {
  RootStateCurrentIssueProvenancePolicyInterface,
} from "../api/RootStateCurrentIssueProvenancePolicyInterface.js";
import type {
  RootStateIssue,
  RootStateView,
  RootStateViewPolicyInterface,
} from "../api/RootStateViewPolicyInterface.js";
import {
  isCanonicalInterruptedSuccessor,
  renderCanonicalInterruptedSuccessor,
} from "./CanonicalInterruptedSuccessor.js";
import { parseCanonicalRootRequirement } from "./CanonicalRootRequirement.js";

const SUCCESSOR_LABELS = Object.freeze(["Interrupted Plan Successor", "symphony:kind/plan"]);

export class RootStateInterruptedPlanSuccessorCreationCompilerImpl
implements RootStateInterruptedPlanSuccessorCreationCompilerInterface {
  constructor(
    private readonly views: RootStateViewPolicyInterface,
    private readonly provenance: RootStateCurrentIssueProvenancePolicyInterface,
  ) {}

  compile(
    input: Parameters<RootStateInterruptedPlanSuccessorCreationCompilerInterface["compile"]>[0],
  ): RootStateInterruptedPlanSuccessorCreationCompilerResult {
    if (input.intent.semanticGate !== "recovery_strategy") return invalid("gate_mismatch");
    if (input.intent.intent.kind !== "continue_with_successor_attempt") {
      return invalid("purpose_incompatible");
    }
    if (!hasExactInputCoverage(
      input.subject.pendingInputIds,
      input.intent.consumedInputIds,
      input.intent.commentDispositions.map(({ sourceInputId }) => sourceInputId),
    )) return invalid("input_disposition_invalid");
    if (input.worktreeFence !== "valid" || input.sessionFence !== "closed") return invalid("subject_stale");

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
    if (input.subject.rootIssueId !== root.issueId || input.intent.rootIssueId !== root.issueId ||
        input.intent.basedOnRootDigest !== view.contentDigest ||
        input.subject.exactRevision !== view.worktree.headRevision) return invalid("subject_stale");
    if (root.statusName !== "In Progress" || root.isArchived || root.parentIssueId !== undefined ||
        !parseCanonicalRootRequirement(root.description)) return invalid("topology_invalid");

    const activeCycles = view.issues.filter(({ issueKind, parentIssueId, isArchived }) =>
      issueKind === "cycle" && parentIssueId === root.issueId && !isArchived);
    const cycle = activeCycles.length === 1 ? activeCycles[0] : undefined;
    if (!cycle || cycle.issueId !== input.subject.cycleIssueId || cycle.projectId !== root.projectId ||
        cycle.statusName !== "Planning") return invalid("topology_invalid");

    const interruptedPlans = view.issues.filter(({ issueKind, parentIssueId, statusName, isArchived }) =>
      issueKind === "plan" && parentIssueId === cycle.issueId && statusName === "Interrupted" && !isArchived);
    const predecessor = interruptedPlans.length === 1 ? interruptedPlans[0] : undefined;
    if (!predecessor || predecessor.issueId !== input.subject.predecessorPlanIssueId ||
        predecessor.projectId !== root.projectId || !this.provenance.prove({
          view, issue: predecessor, requiredActivityKinds: ["status_changed"],
        })) return invalid("topology_invalid");

    const description = renderCanonicalInterruptedSuccessor("plan", input.intent.intent);
    if (!description) return invalid("intent_content_invalid");
    const activeSuccessors = view.issues.filter(({ issueId, issueKind, parentIssueId, isArchived }) =>
      issueId !== predecessor.issueId && issueKind === "plan" &&
      parentIssueId === cycle.issueId && !isArchived);
    if (activeSuccessors.length > 1) return invalid("topology_invalid");
    const successor = activeSuccessors[0];
    if (successor && (compareIssues(predecessor, successor) >= 0 ||
        !isDesiredSuccessor(successor, root, cycle, description) ||
        !this.isAuthorized(view, predecessor, successor) ||
        view.relations.some(({ sourceIssueId, targetIssueId }) =>
          sourceIssueId === successor.issueId || targetIssueId === successor.issueId))) {
      return invalid("topology_invalid");
    }
    const allowedActiveIds = new Set([predecessor.issueId, ...(successor ? [successor.issueId] : [])]);
    if (view.issues.some(({ parentIssueId, isArchived, issueId }) =>
      parentIssueId === cycle.issueId && !isArchived && !allowedActiveIds.has(issueId))) {
      return invalid("topology_invalid");
    }

    const observedAt = Date.parse(input.observedAt);
    const deadlineAt = Date.parse(input.deadlineAt);
    if (!Number.isFinite(observedAt) || !Number.isFinite(deadlineAt)) return invalid("subject_stale");
    if (observedAt >= deadlineAt) return invalid("successor_prohibited");
    if (successor) return { kind: "satisfied" };

    const todo = view.statuses.filter(({ name }) => name === "Todo");
    if (todo.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      effect: {
        kind: "create_issue",
        parentIssueId: cycle.issueId,
        statusId: todo[0]!.statusId,
        title: "Plan",
        description,
        labelNames: SUCCESSOR_LABELS,
      },
    };
  }

  private isAuthorized(view: RootStateView, predecessor: RootStateIssue, successor: RootStateIssue): boolean {
    if (this.provenance.prove({ view, issue: successor, requiredActivityKinds: [] })) return true;
    const sourceActor = this.provenance.currentStatusActor({ view, issue: predecessor });
    return sourceActor !== undefined && this.provenance.prove({
      view, issue: successor, requiredActivityKinds: [], expectedActorId: sourceActor,
    }) !== undefined;
  }
}

function isDesiredSuccessor(
  successor: RootStateIssue,
  root: RootStateIssue,
  cycle: RootStateIssue,
  description: string,
): boolean {
  return successor.parentIssueId === cycle.issueId && successor.projectId === root.projectId &&
    successor.statusName === "Todo" && !successor.isArchived && successor.title === "Plan" &&
    successor.description === description && isCanonicalInterruptedSuccessor(successor.description, "plan") &&
    sameValues(successor.labels, SUCCESSOR_LABELS);
}

function hasExactInputCoverage(
  pending: readonly string[],
  consumed: readonly string[],
  dispositions: readonly string[],
): boolean {
  return uniqueValues(pending) && uniqueValues(consumed) && uniqueValues(dispositions) &&
    sameValues([...pending].sort(compareCodePoints), [...consumed].sort(compareCodePoints)) &&
    sameValues([...pending].sort(compareCodePoints), [...dispositions].sort(compareCodePoints));
}

function uniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareIssues(left: RootStateIssue, right: RootStateIssue): number {
  return left.createdAt.localeCompare(right.createdAt) || compareCodePoints(left.issueId, right.issueId);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<RootStateInterruptedPlanSuccessorCreationCompilerResult, { kind: "invalid_intent" }>["reason"],
): RootStateInterruptedPlanSuccessorCreationCompilerResult {
  return { kind: "invalid_intent", reason };
}
