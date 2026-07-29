import { isDeepStrictEqual } from "node:util";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootMechanicalConvergenceCompilerResult } from "../api/RootMechanicalConvergenceCompilerInterface.js";
import type { CyclePhaseCompilerInterface } from "../api/CyclePhaseCompilerInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

export class CyclePhaseCompilerImpl implements CyclePhaseCompilerInterface {
  compile(input: Parameters<CyclePhaseCompilerInterface["compile"]>[0]): RootMechanicalConvergenceCompilerResult {
    const { target, view } = input;
    if (!isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate)) return invalid("target_stale");
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
    if (!root || root.issue_kind !== "root" || root.is_archived || root.parent_issue_id !== undefined ||
        root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id ||
        !cycle || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
        cycle.project_id !== root.project_id) return invalid("topology_invalid");

    if (cycle.status_name === target.desiredStatus) return { kind: "satisfied" };
    const descendants = view.tree.issues.filter(({ parent_issue_id, is_archived }) => parent_issue_id === cycle.issue_id && !is_archived);
    const plans = descendants.filter(({ issue_kind }) => issue_kind === "plan");
    const works = descendants.filter(({ issue_kind }) => issue_kind === "work");
    const verifies = descendants.filter(({ issue_kind }) => issue_kind === "verify");
    if (plans.length !== 1 || plans[0]?.status_name !== "Done" || works.length === 0 || verifies.length !== 1) {
      return invalid("topology_invalid");
    }
    const validCurrent = target.desiredStatus === "Executing"
      ? cycle.status_name === "Sealed" && works.every(({ status_name }) => status_name === "Todo") && verifies[0]?.status_name === "Todo"
      : cycle.status_name === "Executing" && works.every(({ status_name }) => status_name === "Done") && verifies[0]?.status_name === "Todo";
    if (!validCurrent) return invalid("topology_invalid");
    const desired = uniqueStatus(view.tree, target.desiredStatus);
    if (!desired) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      command: {
        kind: "update_workflow_issue",
        writeId: mechanicalWriteId([root.issue_id, cycle.issue_id, "cycle-phase", target.desiredStatus]),
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: cycle.issue_id,
          expectedRemoteVersion: cycle.remote_version,
          expectedStatusId: cycle.status_id,
          expectedParentIssueId: root.issue_id,
          expectedIsArchived: false,
        },
        statusId: desired.status_id,
        title: cycle.title,
        description: cycle.description,
        labelNames: cycle.labels,
        parentAssignment: { mode: "retain" },
        order: cycle.order,
      },
    };
  }
}

function uniqueStatus(tree: LinearWorkflowTreeSnapshot, name: string) {
  const matches = tree.status_catalog.filter((status) => status.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function invalid(reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"]): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
