import type {
  RootStateCyclePhaseCompilerInterface,
  RootStateCyclePhaseCompilerResult,
} from "../api/RootStateCyclePhaseCompilerInterface.js";
import type { RootStateView, RootStateViewPolicyInterface } from "../api/RootStateViewPolicyInterface.js";

export class RootStateCyclePhaseCompilerImpl implements RootStateCyclePhaseCompilerInterface {
  constructor(private readonly views: RootStateViewPolicyInterface) {}

  compile(input: Parameters<RootStateCyclePhaseCompilerInterface["compile"]>[0]): RootStateCyclePhaseCompilerResult {
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

    if (cycle.statusName === input.desiredStatus) return { kind: "satisfied" };
    const descendants = view.issues.filter(({ parentIssueId, isArchived }) => parentIssueId === cycle.issueId && !isArchived);
    const plans = descendants.filter(({ issueKind }) => issueKind === "plan");
    const works = descendants.filter(({ issueKind }) => issueKind === "work");
    const verifies = descendants.filter(({ issueKind }) => issueKind === "verify");
    if (plans.length !== 1 || plans[0]?.statusName !== "Done" || works.length === 0 || verifies.length !== 1) {
      return invalid("topology_invalid");
    }

    const validCurrent = input.desiredStatus === "Executing"
      ? cycle.statusName === "Sealed" && works.every(({ statusName }) => statusName === "Todo") && verifies[0]?.statusName === "Todo"
      : cycle.statusName === "Executing" && works.every(({ statusName }) => statusName === "Done") && verifies[0]?.statusName === "Todo";
    if (!validCurrent) return invalid("topology_invalid");

    const statuses = view.statuses.filter(({ name }) => name === input.desiredStatus);
    if (statuses.length !== 1) return invalid("status_catalog_invalid");
    return { kind: "effect", effect: { kind: "set_issue_status", issueId: cycle.issueId, statusId: statuses[0]!.statusId } };
  }
}

function invalid(reason: Extract<RootStateCyclePhaseCompilerResult, { kind: "invalid_facts" }>["reason"]): RootStateCyclePhaseCompilerResult {
  return { kind: "invalid_facts", reason };
}
