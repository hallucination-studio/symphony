import { isDeepStrictEqual } from "node:util";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { InvalidExecutionGenerationCompilerInterface } from "../api/InvalidExecutionGenerationCompilerInterface.js";
import type { RootMechanicalConvergenceCompilerResult } from "../api/RootMechanicalConvergenceCompilerInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

export class InvalidExecutionGenerationCompilerImpl implements InvalidExecutionGenerationCompilerInterface {
  compile(input: Parameters<InvalidExecutionGenerationCompilerInterface["compile"]>[0]): RootMechanicalConvergenceCompilerResult {
    const { target, view } = input;
    if (!isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate)) return invalid("target_stale");
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
    if (!root || root.issue_kind !== "root" || root.is_archived || root.parent_issue_id !== undefined ||
        root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id ||
        !cycle || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
        cycle.status_name !== "Canceled" || !cycle.labels.includes("Execution Invalidated")) {
      return invalid("topology_invalid");
    }
    const archiveTarget = view.tree.issues
      .filter((issue) => issue.issue_id !== cycle.issue_id && !issue.is_archived &&
        isDescendantOf(issue.issue_id, cycle.issue_id, view.tree))
      .sort((left, right) => right.depth - left.depth || compareCodePoints(left.issue_id, right.issue_id))[0] ?? cycle;
    return {
      kind: "effect",
      command: {
        kind: "set_workflow_issue_archive_state",
        writeId: mechanicalWriteId([root.issue_id, cycle.issue_id, "archive-invalid-generation", archiveTarget.issue_id]),
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: archiveTarget.issue_id,
          expectedRemoteVersion: archiveTarget.remote_version,
          expectedIsArchived: false,
        },
        isArchived: true,
      },
    };
  }
}

function isDescendantOf(issueId: string, ancestorIssueId: string, tree: LinearWorkflowTreeSnapshot): boolean {
  const visited = new Set<string>();
  let current = tree.issues.find(({ issue_id }) => issue_id === issueId);
  while (current?.parent_issue_id && !visited.has(current.issue_id)) {
    if (current.parent_issue_id === ancestorIssueId) return true;
    visited.add(current.issue_id);
    current = tree.issues.find(({ issue_id }) => issue_id === current!.parent_issue_id);
  }
  return false;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"]): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
