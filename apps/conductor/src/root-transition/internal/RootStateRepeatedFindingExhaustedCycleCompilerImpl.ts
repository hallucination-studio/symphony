import type { RootStateMechanicalCompilerResult } from "../api/RootStateMechanicalCompilerResult.js";
import type { RootStateOpenFindingPersistencePolicyInterface } from "../api/RootStateOpenFindingPersistencePolicyInterface.js";
import type { RootStateRepeatedFindingExhaustedCycleCompilerInterface } from "../api/RootStateRepeatedFindingExhaustedCycleCompilerInterface.js";
import type { RootStateView, RootStateViewPolicyInterface } from "../api/RootStateViewPolicyInterface.js";

const CONCLUSION = [
  "# Recovery Conclusion", "", "The same open Finding persisted through the configured Cycle limit.", "",
  "## Outcome", "", "recovery_exhausted",
].join("\n");
const LABELS = Object.freeze(["Recovery Exhausted", "symphony:kind/cycle"]);

export class RootStateRepeatedFindingExhaustedCycleCompilerImpl implements RootStateRepeatedFindingExhaustedCycleCompilerInterface {
  constructor(
    private readonly views: RootStateViewPolicyInterface,
    private readonly persistence: RootStateOpenFindingPersistencePolicyInterface,
  ) {}

  compile(input: Parameters<RootStateRepeatedFindingExhaustedCycleCompilerInterface["compile"]>[0]): RootStateMechanicalCompilerResult {
    if (input.sessionFence !== "closed" || !Number.isSafeInteger(input.maxSameOpenFindingCycles) ||
        input.maxSameOpenFindingCycles < 1) return invalid("mechanical_precondition_invalid");

    let view: RootStateView;
    try {
      view = this.views.derive(input.state);
    } catch (error) {
      if (error instanceof Error && error.message === "recovered_root_state_view_invalid") return invalid("topology_invalid");
      throw error;
    }
    const { root } = view;
    const activeCycles = view.issues.filter(({ issueKind, parentIssueId, isArchived, statusCategory }) =>
      issueKind === "cycle" && parentIssueId === root.issueId && !isArchived &&
      statusCategory !== "completed" && statusCategory !== "canceled");
    const cycle = activeCycles.length === 1 ? activeCycles[0] : undefined;
    if (root.isArchived || root.parentIssueId !== undefined || !cycle || cycle.issueId !== input.cycleIssueId ||
        cycle.projectId !== root.projectId) return invalid("topology_invalid");

    let lineages;
    try {
      lineages = this.persistence.derive({ view, activeCycleIssueId: cycle.issueId });
    } catch (error) {
      if (error instanceof Error && error.message === "root_state_finding_lineage_invalid") return invalid("topology_invalid");
      throw error;
    }
    const atLimit = lineages.filter(({ openCycleCount }) => openCycleCount >= input.maxSameOpenFindingCycles);
    const atLimitIds = atLimit.map(({ findingId }) => findingId).sort(compareCodePoints);
    if (atLimitIds.length === 0) return invalid("mechanical_precondition_invalid");
    if (!sameIds(input.findingIssueIds, atLimitIds)) return invalid("topology_invalid");

    const lineageIds = new Set(atLimit.flatMap(({ findingIds }) => findingIds));
    const lineageRelations = view.relations.filter(({ relationKind, sourceIssueId, targetIssueId }) =>
      relationKind === "triggered_by" && lineageIds.has(sourceIssueId) && lineageIds.has(targetIssueId));
    if (lineageRelations.length !== atLimit.reduce((count, lineage) => count + lineage.findingIds.length - 1, 0)) {
      return invalid("topology_invalid");
    }

    const canceled = view.statuses.filter(({ name }) => name === "Canceled");
    if (canceled.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      effect: {
        kind: "update_issue", issueId: cycle.issueId, statusId: canceled[0]!.statusId,
        title: cycle.title, description: CONCLUSION, labelNames: LABELS, order: cycle.order,
      },
    };
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return new Set(left).size === left.length && left.length === right.length &&
    [...left].sort(compareCodePoints).every((value, index) => value === right[index]);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<RootStateMechanicalCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootStateMechanicalCompilerResult {
  return { kind: "invalid_facts", reason };
}
