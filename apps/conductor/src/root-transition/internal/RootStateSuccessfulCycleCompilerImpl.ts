import type { RootStateMechanicalCompilerResult } from "../api/RootStateMechanicalCompilerResult.js";
import type { RootStateSuccessfulCycleCompilerInterface } from "../api/RootStateSuccessfulCycleCompilerInterface.js";
import type { RootStateView, RootStateViewPolicyInterface } from "../api/RootStateViewPolicyInterface.js";

export class RootStateSuccessfulCycleCompilerImpl implements RootStateSuccessfulCycleCompilerInterface {
  constructor(private readonly views: RootStateViewPolicyInterface) {}

  compile(input: Parameters<RootStateSuccessfulCycleCompilerInterface["compile"]>[0]): RootStateMechanicalCompilerResult {
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
    const descendants = view.issues.filter(({ parentIssueId, isArchived }) =>
      parentIssueId === input.cycleIssueId && !isArchived);
    const verifies = descendants.filter(({ issueKind }) => issueKind === "verify");
    const verify = verifies.length === 1 && verifies[0]?.issueId === input.verifyIssueId ? verifies[0] : undefined;
    if (root.isArchived || root.parentIssueId !== undefined ||
        !cycle || cycle.issueKind !== "cycle" || cycle.parentIssueId !== root.issueId || cycle.isArchived ||
        cycle.projectId !== root.projectId ||
        !verify || verify.projectId !== root.projectId || verify.statusName !== "Done" || !verify.labels.includes("Passed")) {
      return invalid("topology_invalid");
    }
    if (descendants.some(({ issueKind, statusName }) =>
      issueKind === "work" && statusName !== "Done" ||
      issueKind === "finding" && statusName !== "Done" && statusName !== "Canceled")) {
      return invalid("topology_invalid");
    }
    if (cycle.statusName === "Succeeded") return { kind: "satisfied" };
    if (cycle.statusName !== "Verifying") return invalid("topology_invalid");

    const succeeded = view.statuses.filter(({ name }) => name === "Succeeded");
    if (succeeded.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      effect: { kind: "set_issue_status", issueId: cycle.issueId, statusId: succeeded[0]!.statusId },
    };
  }
}

function invalid(
  reason: Extract<RootStateMechanicalCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootStateMechanicalCompilerResult {
  return { kind: "invalid_facts", reason };
}
