import type { RootStateInvalidExecutionGenerationCompilerInterface } from "../api/RootStateInvalidExecutionGenerationCompilerInterface.js";
import type { RootStateMechanicalCompilerResult } from "../api/RootStateMechanicalCompilerResult.js";
import type {
  RootStateIssue,
  RootStateView,
  RootStateViewPolicyInterface,
} from "../api/RootStateViewPolicyInterface.js";

export class RootStateInvalidExecutionGenerationCompilerImpl implements RootStateInvalidExecutionGenerationCompilerInterface {
  constructor(private readonly views: RootStateViewPolicyInterface) {}

  compile(
    input: Parameters<RootStateInvalidExecutionGenerationCompilerInterface["compile"]>[0],
  ): RootStateMechanicalCompilerResult {
    if (input.executionGenerationFence !== "invalid") return invalid("mechanical_precondition_invalid");

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
    const cycle = unique(view.issues.filter(({ issueId }) => issueId === input.cycleIssueId));
    if (root.isArchived || root.parentIssueId !== undefined || !cycle || cycle.issueKind !== "cycle" ||
        cycle.parentIssueId !== root.issueId || cycle.projectId !== root.projectId ||
        cycle.statusName !== "Canceled" || !cycle.labels.includes("Execution Invalidated")) {
      return invalid("topology_invalid");
    }

    const descendants = view.issues.filter((issue) => isDescendantOf(issue, cycle.issueId, view.issues));
    if (descendants.some(({ projectId }) => projectId !== root.projectId)) return invalid("topology_invalid");
    const live = descendants.filter(({ isArchived }) => !isArchived)
      .sort((left, right) => right.depth - left.depth || compareCodePoints(left.issueId, right.issueId));
    if (cycle.isArchived) return live.length === 0 ? { kind: "satisfied" } : invalid("topology_invalid");
    const target = live[0] ?? cycle;
    return {
      kind: "effect",
      effect: { kind: "set_issue_archive_state", issueId: target.issueId, isArchived: true },
    };
  }
}

function isDescendantOf(issue: RootStateIssue, ancestorIssueId: string, issues: readonly RootStateIssue[]): boolean {
  const visited = new Set<string>();
  let current: RootStateIssue | undefined = issue;
  while (current?.parentIssueId && !visited.has(current.issueId)) {
    if (current.parentIssueId === ancestorIssueId) return true;
    visited.add(current.issueId);
    current = issues.find(({ issueId }) => issueId === current!.parentIssueId);
  }
  return false;
}

function unique<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<RootStateMechanicalCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootStateMechanicalCompilerResult {
  return { kind: "invalid_facts", reason };
}
