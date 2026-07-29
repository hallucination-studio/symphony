import type {
  RootStateInterruptedExecutionSuccessorCompilerInterface,
  RootStateInterruptedExecutionSuccessorCompilerResult,
} from "../api/RootStateInterruptedExecutionSuccessorCompilerInterface.js";
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
import { deriveRootStateSuccessorPolicy } from "./RootStateSuccessorAdmission.js";

const SUCCESSOR_LABELS = Object.freeze(["Interrupted Stage Recovery", "symphony:kind/cycle"]);

export class RootStateInterruptedExecutionSuccessorCompilerImpl
implements RootStateInterruptedExecutionSuccessorCompilerInterface {
  constructor(
    private readonly views: RootStateViewPolicyInterface,
    private readonly provenance: RootStateCurrentIssueProvenancePolicyInterface,
  ) {}

  compile(
    input: Parameters<RootStateInterruptedExecutionSuccessorCompilerInterface["compile"]>[0],
  ): RootStateInterruptedExecutionSuccessorCompilerResult {
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

    const cycles = view.issues.filter(({ issueKind, parentIssueId }) =>
      issueKind === "cycle" && parentIssueId === root.issueId)
      .sort(compareIssues);
    const predecessorAt = cycles.findIndex(({ issueId }) => issueId === input.subject.cycleIssueId);
    const cycle = cycles[predecessorAt];
    const expectedPhase = input.subject.role === "work" ? "Executing" : "Verifying";
    if (predecessorAt < 0 || predecessorAt !== cycles.length - 1 && predecessorAt !== cycles.length - 2 ||
        !cycle || cycle.projectId !== root.projectId || cycle.statusName !== expectedPhase || cycle.isArchived ||
        cycles.slice(0, predecessorAt).some(({ isArchived }) => !isArchived)) {
      return invalid("topology_invalid");
    }

    const matchingStages = view.issues.filter(({ issueKind, parentIssueId, statusName, isArchived }) =>
      issueKind === input.subject.role && parentIssueId === cycle.issueId &&
      statusName === "Interrupted" && !isArchived);
    const stage = matchingStages.length === 1 ? matchingStages[0] : undefined;
    if (!stage || stage.issueId !== input.subject.stageIssueId || stage.projectId !== root.projectId ||
        !this.provenance.prove({ view, issue: stage, requiredActivityKinds: ["status_changed"] })) {
      return invalid("topology_invalid");
    }

    const description = renderCanonicalInterruptedSuccessor(input.subject.role, input.intent.intent);
    if (!description) return invalid("intent_content_invalid");
    const later = cycles.slice(predecessorAt + 1);
    if (later.length > 1) return invalid("topology_invalid");
    const successor = later[0];
    if (successor && (!isDesiredSuccessor(
      successor,
      root,
      predecessorAt + 2,
      input.subject.role,
      description,
    ) || !this.authorizedSuccessor(view, stage, successor) ||
      view.relations.some(({ sourceIssueId, targetIssueId }) =>
        sourceIssueId === successor.issueId || targetIssueId === successor.issueId))) {
      return invalid("topology_invalid");
    }

    const admission = deriveRootStateSuccessorPolicy(
      predecessorAt + 1,
      input.policy.maxCyclesPerRoot,
      input.observedAt,
      input.policy.deadlineAt,
    );
    if (!admission) return invalid("subject_stale");
    if (admission !== "allowed") return invalid("successor_prohibited");
    if (successor) return { kind: "satisfied" };

    const planning = view.statuses.filter(({ name }) => name === "Planning");
    if (planning.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      effect: {
        kind: "create_issue",
        parentIssueId: root.issueId,
        statusId: planning[0]!.statusId,
        title: `Cycle ${predecessorAt + 2}`,
        description,
        labelNames: SUCCESSOR_LABELS,
      },
    };
  }

  private authorizedSuccessor(view: RootStateView, stage: RootStateIssue, successor: RootStateIssue): boolean {
    const direct = this.provenance.prove({ view, issue: successor, requiredActivityKinds: [] });
    if (direct) return true;
    const sourceActor = this.provenance.currentStatusActor({ view, issue: stage });
    return sourceActor !== undefined && this.provenance.prove({
      view,
      issue: successor,
      requiredActivityKinds: [],
      expectedActorId: sourceActor,
    }) !== undefined;
  }
}

function isDesiredSuccessor(
  successor: RootStateIssue,
  root: RootStateIssue,
  successorNumber: number,
  role: "work" | "verify",
  description: string,
): boolean {
  return successor.parentIssueId === root.issueId && successor.projectId === root.projectId &&
    successor.statusName === "Planning" && !successor.isArchived &&
    successor.title === `Cycle ${successorNumber}` && successor.description === description &&
    isCanonicalInterruptedSuccessor(successor.description, role) &&
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
  reason: Extract<RootStateInterruptedExecutionSuccessorCompilerResult, { kind: "invalid_intent" }>["reason"],
): RootStateInterruptedExecutionSuccessorCompilerResult {
  return { kind: "invalid_intent", reason };
}
