import type { RootStateMechanicalCompilerResult } from "../api/RootStateMechanicalCompilerResult.js";
import type { RootStateRepairExhaustedCycleCompilerInterface } from "../api/RootStateRepairExhaustedCycleCompilerInterface.js";
import type { RootStateView, RootStateViewPolicyInterface } from "../api/RootStateViewPolicyInterface.js";

const CONCLUSION = [
  "# Recovery Conclusion", "", "The maximum Cycle repair attempt limit was exceeded.", "",
  "## Outcome", "", "recovery_exhausted",
].join("\n");
const LABELS = Object.freeze(["Recovery Exhausted", "symphony:kind/cycle"]);

export class RootStateRepairExhaustedCycleCompilerImpl implements RootStateRepairExhaustedCycleCompilerInterface {
  constructor(private readonly views: RootStateViewPolicyInterface) {}

  compile(input: Parameters<RootStateRepairExhaustedCycleCompilerInterface["compile"]>[0]): RootStateMechanicalCompilerResult {
    if (input.sessionFence !== "closed" ||
        !Number.isSafeInteger(input.maxCycleRepairAttempts) || input.maxCycleRepairAttempts < 0) {
      return invalid("mechanical_precondition_invalid");
    }
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
    if (root.isArchived || root.parentIssueId !== undefined ||
        !cycle || cycle.issueKind !== "cycle" || cycle.parentIssueId !== root.issueId || cycle.isArchived ||
        cycle.projectId !== root.projectId) return invalid("topology_invalid");

    if (cycle.statusName === "Canceled" && cycle.description === CONCLUSION &&
        sameValues(cycle.labels, LABELS)) return { kind: "satisfied" };

    const activeCycles = view.issues.filter(({ issueKind, parentIssueId, isArchived, statusCategory }) =>
      issueKind === "cycle" && parentIssueId === root.issueId && !isArchived &&
      statusCategory !== "completed" && statusCategory !== "canceled");
    if (activeCycles.length !== 1 || activeCycles[0]?.issueId !== cycle.issueId) return invalid("topology_invalid");

    const repairAttempts = view.issues.filter(({ parentIssueId, issueKind, statusName, labels }) =>
      parentIssueId === cycle.issueId && (issueKind === "work" || issueKind === "verify") &&
      (statusName === "Failed" || statusName === "Interrupted" ||
        issueKind === "verify" && statusName === "Done" && labels.some((label) =>
          label === "Changes Required" || label === "Inconclusive" || label === "Contract Violation"))).length;
    if (repairAttempts <= input.maxCycleRepairAttempts) return invalid("mechanical_precondition_invalid");

    const canceled = view.statuses.filter(({ name }) => name === "Canceled");
    if (canceled.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      effect: {
        kind: "update_issue",
        issueId: cycle.issueId,
        statusId: canceled[0]!.statusId,
        title: cycle.title,
        description: CONCLUSION,
        labelNames: LABELS,
        order: cycle.order,
      },
    };
  }
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(
  reason: Extract<RootStateMechanicalCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootStateMechanicalCompilerResult {
  return { kind: "invalid_facts", reason };
}
