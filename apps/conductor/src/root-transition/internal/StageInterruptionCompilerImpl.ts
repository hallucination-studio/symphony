import { isDeepStrictEqual } from "node:util";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootMechanicalConvergenceCompilerResult } from "../api/RootMechanicalConvergenceCompilerInterface.js";
import type {
  StageInterruptionCompilerInput,
  StageInterruptionCompilerInterface,
} from "../api/StageInterruptionCompilerInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

export class StageInterruptionCompilerImpl implements StageInterruptionCompilerInterface {
  compile(input: StageInterruptionCompilerInput): RootMechanicalConvergenceCompilerResult {
    const { target, view } = input;
    if (!isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate)) return invalid("target_stale");
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
    const stage = view.tree.issues.find(({ issue_id }) => issue_id === target.stageIssueId);
    if (!root || root.issue_kind !== "root" || root.is_archived || root.parent_issue_id !== undefined ||
      root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id ||
      !cycle || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
      !stage || stage.issue_kind !== target.role || stage.parent_issue_id !== cycle.issue_id || stage.is_archived ||
      stage.project_id !== root.project_id || cycle.project_id !== root.project_id) {
      return invalid("topology_invalid");
    }
    if (stage.status_name === "Interrupted") return { kind: "satisfied" };
    if (stage.status_name !== "In Progress") return invalid("topology_invalid");
    const interrupted = uniqueStatus(view.tree, "Interrupted");
    if (!interrupted) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      command: {
        kind: "update_workflow_issue",
        writeId: mechanicalWriteId([root.issue_id, stage.issue_id, target.role, "interrupt"]),
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: stage.issue_id,
          expectedRemoteVersion: stage.remote_version,
          expectedStatusId: stage.status_id,
          expectedParentIssueId: cycle.issue_id,
          expectedIsArchived: false,
        },
        statusId: interrupted.status_id,
        title: stage.title,
        description: stage.description,
        labelNames: stage.labels,
        parentAssignment: { mode: "retain" },
        order: stage.order,
      },
    };
  }
}

function uniqueStatus(tree: LinearWorkflowTreeSnapshot, name: string) {
  const matches = tree.status_catalog.filter((status) => status.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function invalid(
  reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
