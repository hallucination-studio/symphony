import type {
  RootStateAuthorizedTerminalSuccessorCompilerInterface,
} from "../api/RootStateAuthorizedTerminalSuccessorCompilerInterface.js";
import type {
  RootStateCurrentIssueProof,
  RootStateCurrentIssueProvenancePolicyInterface,
} from "../api/RootStateCurrentIssueProvenancePolicyInterface.js";
import type { RootStateMechanicalCompilerResult } from "../api/RootStateMechanicalCompilerResult.js";
import type {
  RootStateIssue,
  RootStateView,
  RootStateViewPolicyInterface,
} from "../api/RootStateViewPolicyInterface.js";
import { isCanonicalTerminalSuccessor } from "./CanonicalTerminalSuccessor.js";
import { parseCanonicalRootRequirement } from "./CanonicalRootRequirement.js";
import { compileRootStateAuthorizedSuccessorConvergence } from "./RootStateAuthorizedSuccessorConvergence.js";

const SUCCESSOR_LABELS = Object.freeze(["Terminal Review Successor", "symphony:kind/cycle"]);

export class RootStateAuthorizedTerminalSuccessorCompilerImpl
implements RootStateAuthorizedTerminalSuccessorCompilerInterface {
  constructor(
    private readonly views: RootStateViewPolicyInterface,
    private readonly provenance: RootStateCurrentIssueProvenancePolicyInterface,
  ) {}

  compile(
    input: Parameters<RootStateAuthorizedTerminalSuccessorCompilerInterface["compile"]>[0],
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
    if (root.statusName !== "In Progress" || root.isArchived || root.parentIssueId !== undefined ||
        !parseCanonicalRootRequirement(root.description)) return invalid("topology_invalid");
    const cycles = view.issues.filter(({ issueKind, parentIssueId }) =>
      issueKind === "cycle" && parentIssueId === root.issueId)
      .sort(compareIssues);
    const predecessorAt = cycles.findIndex(({ issueId }) => issueId === input.predecessorCycleIssueId);
    const predecessor = cycles[predecessorAt];
    const successor = cycles[predecessorAt + 1];
    if (predecessorAt < 0 || predecessorAt !== cycles.length - 2 ||
        !predecessor || predecessor.issueId !== input.predecessorCycleIssueId ||
        predecessor.projectId !== root.projectId || predecessor.statusName !== "Succeeded" ||
        !successor || successor.issueId !== input.successorCycleIssueId ||
        successor.projectId !== root.projectId || successor.statusName !== "Planning" || successor.isArchived ||
        successor.title !== `Cycle ${predecessorAt + 2}` ||
        !sameValues(successor.labels, SUCCESSOR_LABELS) ||
        !isCanonicalTerminalSuccessor(successor.description) ||
        cycles.slice(0, predecessorAt).some(({ isArchived }) => !isArchived)) {
      return invalid("topology_invalid");
    }
    const predecessorProof = this.provenance.prove({
      view,
      issue: predecessor,
      requiredActivityKinds: ["status_changed"],
    });
    const successorProof = predecessorProof && this.authorizedSuccessor(view, predecessor, successor);
    if (!predecessorProof || !successorProof) return invalid("topology_invalid");

    return compileRootStateAuthorizedSuccessorConvergence({
      view,
      provenance: this.provenance,
      root,
      predecessor,
      successor,
      successorProof,
      predecessorCycleCount: predecessorAt + 1,
      observedAt: input.observedAt,
      policy: input.policy,
    });
  }

  private authorizedSuccessor(
    view: RootStateView,
    predecessor: RootStateIssue,
    successor: RootStateIssue,
  ): RootStateCurrentIssueProof | undefined {
    const direct = this.provenance.prove({ view, issue: successor, requiredActivityKinds: [] });
    if (direct) return direct;
    const sourceActor = this.provenance.currentStatusActor({ view, issue: predecessor });
    return sourceActor === undefined ? undefined : this.provenance.prove({
      view,
      issue: successor,
      requiredActivityKinds: [],
      expectedActorId: sourceActor,
    });
  }

}

function compareIssues(left: RootStateIssue, right: RootStateIssue): number {
  return left.createdAt.localeCompare(right.createdAt) || compareCodePoints(left.issueId, right.issueId);
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
