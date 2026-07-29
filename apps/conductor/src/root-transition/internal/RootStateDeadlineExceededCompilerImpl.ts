import type { RootStateDeadlineExceededCompilerInterface } from "../api/RootStateDeadlineExceededCompilerInterface.js";
import type { RootStateMechanicalCompilerResult } from "../api/RootStateMechanicalCompilerResult.js";
import type { RootStateView, RootStateViewPolicyInterface } from "../api/RootStateViewPolicyInterface.js";

const CYCLE_CONCLUSION = [
  "# Recovery Conclusion", "", "The Root execution deadline was exceeded before this Cycle completed.", "",
  "## Outcome", "", "recovery_abandoned",
].join("\n");
const CYCLE_LABELS = Object.freeze(["Recovery Abandoned", "symphony:kind/cycle"]);

export class RootStateDeadlineExceededCompilerImpl implements RootStateDeadlineExceededCompilerInterface {
  constructor(private readonly views: RootStateViewPolicyInterface) {}

  compile(input: Parameters<RootStateDeadlineExceededCompilerInterface["compile"]>[0]): RootStateMechanicalCompilerResult {
    const observedAt = Date.parse(input.observedAt);
    const deadlineAt = Date.parse(input.deadlineAt);
    if (!Number.isFinite(observedAt) || !Number.isFinite(deadlineAt) || observedAt < deadlineAt) {
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
    if (root.isArchived || root.parentIssueId !== undefined ||
        root.statusCategory === "completed" || root.statusCategory === "canceled") {
      return invalid("topology_invalid");
    }

    const canceled = view.statuses.filter(({ name }) => name === "Canceled");
    if (canceled.length !== 1) return invalid("status_catalog_invalid");
    const activeCycles = view.issues.filter(({ issueKind, parentIssueId, isArchived, statusCategory }) =>
      issueKind === "cycle" && parentIssueId === root.issueId && !isArchived &&
      statusCategory !== "completed" && statusCategory !== "canceled");

    if (input.target.kind === "cycle") {
      if (input.target.sessionFence !== "closed") return invalid("mechanical_precondition_invalid");
      const cycle = activeCycles.length === 1 ? activeCycles[0] : undefined;
      if (!cycle || cycle.issueId !== input.target.cycleIssueId || cycle.projectId !== root.projectId) {
        return invalid("topology_invalid");
      }
      return {
        kind: "effect",
        effect: {
          kind: "update_issue",
          issueId: cycle.issueId,
          statusId: canceled[0]!.statusId,
          title: cycle.title,
          description: CYCLE_CONCLUSION,
          labelNames: CYCLE_LABELS,
          order: cycle.order,
        },
      };
    }

    if (activeCycles.length > 0) return invalid("topology_invalid");
    return {
      kind: "effect",
      effect: {
        kind: "update_issue",
        issueId: root.issueId,
        statusId: canceled[0]!.statusId,
        title: root.title,
        description: root.description,
        labelNames: sortedUnique([...root.labels, "Deadline Exceeded", "symphony:kind/root"]),
        order: root.order,
      },
    };
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0)!);
  const rightPoints = [...right].map((value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function invalid(
  reason: Extract<RootStateMechanicalCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootStateMechanicalCompilerResult {
  return { kind: "invalid_facts", reason };
}
