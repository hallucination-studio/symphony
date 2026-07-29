import type {
  RootStateTerminalSuccessorCompilerInterface,
  RootStateTerminalSuccessorCompilerResult,
} from "../api/RootStateTerminalSuccessorCompilerInterface.js";
import type {
  RootStateCurrentIssueProvenancePolicyInterface,
} from "../api/RootStateCurrentIssueProvenancePolicyInterface.js";
import type {
  RootStateIssue,
  RootStateView,
  RootStateViewPolicyInterface,
} from "../api/RootStateViewPolicyInterface.js";
import { parseCanonicalRootRequirement } from "./CanonicalRootRequirement.js";
import { renderCanonicalTerminalSuccessor } from "./CanonicalTerminalSuccessor.js";
import { deriveRootStateSuccessorPolicy } from "./RootStateSuccessorAdmission.js";

const SUCCESSOR_LABELS = Object.freeze(["Terminal Review Successor", "symphony:kind/cycle"]);

export class RootStateTerminalSuccessorCompilerImpl implements RootStateTerminalSuccessorCompilerInterface {
  constructor(
    private readonly views: RootStateViewPolicyInterface,
    private readonly provenance: RootStateCurrentIssueProvenancePolicyInterface,
  ) {}

  compile(
    input: Parameters<RootStateTerminalSuccessorCompilerInterface["compile"]>[0],
  ): RootStateTerminalSuccessorCompilerResult {
    if (input.intent.semanticGate !== "terminal_review") return invalid("gate_mismatch");
    if (input.intent.intent.kind !== "start_successor_cycle") return invalid("purpose_incompatible");
    if (!hasExactInputCoverage(
      input.subject.pendingInputIds,
      input.intent.consumedInputIds,
      input.intent.commentDispositions.map(({ sourceInputId }) => sourceInputId),
    )) return invalid("input_disposition_invalid");
    if (input.worktreeFence !== "valid") return invalid("subject_stale");

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
    if (input.intent.rootIssueId !== root.issueId || input.subject.rootIssueId !== root.issueId ||
        input.intent.basedOnRootDigest !== view.contentDigest ||
        input.subject.exactRevision !== view.worktree.headRevision) return invalid("subject_stale");
    if (root.statusName !== "In Progress" || root.isArchived || root.parentIssueId !== undefined ||
        !parseCanonicalRootRequirement(root.description)) return invalid("topology_invalid");

    const cycles = view.issues.filter(({ issueKind, parentIssueId }) =>
      issueKind === "cycle" && parentIssueId === root.issueId)
      .sort(compareIssues);
    const predecessorAt = cycles.findIndex(({ issueId }) => issueId === input.subject.terminalCycleIssueId);
    const predecessor = predecessorAt >= 0 ? cycles[predecessorAt] : undefined;
    if (!predecessor || predecessorAt !== cycles.length - 1 && predecessorAt !== cycles.length - 2 ||
        predecessor.projectId !== root.projectId || predecessor.statusName !== "Succeeded" ||
        predecessor.isArchived || cycles.slice(0, predecessorAt).some(({ isArchived }) => !isArchived) ||
        input.subject.cycleOutcome !== "successful" ||
        input.subject.verifyClassification !== "passed" ||
        input.subject.findingClassification !== "none_open") return invalid("topology_invalid");
    const predecessorProof = this.provenance.prove({
      view,
      issue: predecessor,
      requiredActivityKinds: ["status_changed"],
    });
    if (!predecessorProof) return invalid("topology_invalid");

    const successorNumber = predecessorAt + 2;
    const description = renderCanonicalTerminalSuccessor(input.intent.intent);
    if (!description) return invalid("intent_content_invalid");
    const later = cycles.slice(predecessorAt + 1);
    if (later.length > 1) return invalid("topology_invalid");
    const successor = later[0];
    if (successor && (!isDesiredSuccessor(successor, root, successorNumber, description) ||
        !this.isAuthorized(view, predecessor, successor))) return invalid("topology_invalid");

    const successorPolicy = deriveRootStateSuccessorPolicy(
      predecessorAt + 1,
      input.policy.maxCyclesPerRoot,
      input.observedAt,
      input.policy.deadlineAt,
    );
    if (!successorPolicy || input.subject.successorCyclePolicy !== successorPolicy) {
      return invalid("subject_stale");
    }
    if (successorPolicy !== "allowed") return invalid("successor_prohibited");
    if (successor) return { kind: "satisfied" };

    const planning = view.statuses.filter(({ name }) => name === "Planning");
    if (planning.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      effect: {
        kind: "create_issue",
        parentIssueId: root.issueId,
        statusId: planning[0]!.statusId,
        title: `Cycle ${successorNumber}`,
        description,
        labelNames: SUCCESSOR_LABELS,
      },
    };
  }

  private isAuthorized(view: RootStateView, predecessor: RootStateIssue, successor: RootStateIssue): boolean {
    const direct = this.provenance.prove({ view, issue: successor, requiredActivityKinds: [] });
    if (direct) return true;
    const sourceActor = this.provenance.currentStatusActor({ view, issue: predecessor });
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
  description: string,
): boolean {
  return successor.parentIssueId === root.issueId && successor.projectId === root.projectId &&
    successor.statusName === "Planning" && !successor.isArchived &&
    successor.title === `Cycle ${successorNumber}` && successor.description === description &&
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
  reason: Extract<RootStateTerminalSuccessorCompilerResult, { kind: "invalid_intent" }>["reason"],
): RootStateTerminalSuccessorCompilerResult {
  return { kind: "invalid_intent", reason };
}
