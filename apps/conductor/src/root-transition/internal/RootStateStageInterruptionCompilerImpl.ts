import type { RootStateMechanicalCompilerResult } from "../api/RootStateMechanicalCompilerResult.js";
import type { RootStateStageInterruptionCompilerInterface } from "../api/RootStateStageInterruptionCompilerInterface.js";
import type { RootStateView, RootStateViewPolicyInterface } from "../api/RootStateViewPolicyInterface.js";

const CYCLE_PHASE = Object.freeze({ plan: "Planning", work: "Executing", verify: "Verifying" } as const);

export class RootStateStageInterruptionCompilerImpl implements RootStateStageInterruptionCompilerInterface {
  constructor(private readonly views: RootStateViewPolicyInterface) {}

  compile(input: Parameters<RootStateStageInterruptionCompilerInterface["compile"]>[0]): RootStateMechanicalCompilerResult {
    if (input.sessionFence !== "closed") return invalid("mechanical_precondition_invalid");

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
    const cycle = view.issues.find(({ issueId }) => issueId === input.cycleIssueId);
    const stage = view.issues.find(({ issueId }) => issueId === input.stageIssueId);
    if (root.isArchived || root.parentIssueId !== undefined ||
        !cycle || cycle.issueKind !== "cycle" || cycle.parentIssueId !== root.issueId || cycle.isArchived ||
        cycle.projectId !== root.projectId || cycle.statusName !== CYCLE_PHASE[input.role] ||
        !stage || stage.issueKind !== input.role || stage.parentIssueId !== cycle.issueId || stage.isArchived ||
        stage.projectId !== root.projectId) {
      return invalid("topology_invalid");
    }
    if (stage.statusName === "Interrupted") return { kind: "satisfied" };
    if (stage.statusName !== "In Progress") return invalid("topology_invalid");

    const interrupted = view.statuses.filter(({ name }) => name === "Interrupted");
    if (interrupted.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      effect: { kind: "set_issue_status", issueId: stage.issueId, statusId: interrupted[0]!.statusId },
    };
  }
}

function invalid(
  reason: Extract<RootStateMechanicalCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootStateMechanicalCompilerResult {
  return { kind: "invalid_facts", reason };
}
