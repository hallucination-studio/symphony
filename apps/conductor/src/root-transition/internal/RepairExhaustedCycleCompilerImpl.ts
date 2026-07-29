import { isDeepStrictEqual } from "node:util";

import type { RootMechanicalConvergenceCompilerInput, RootMechanicalConvergenceCompilerResult } from "../api/RootMechanicalConvergenceCompilerInterface.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

type Target = Extract<RootMechanicalTarget, { kind: "conclude_repair_exhausted_cycle" }>;

export class RepairExhaustedCycleCompilerImpl {
  compile(input: { target: Target } & Pick<RootMechanicalConvergenceCompilerInput, "facts" | "view">): RootMechanicalConvergenceCompilerResult {
    const { target, facts, view } = input;
    if (!isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate)) return invalid("target_stale");
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
    if (!root || root.issue_kind !== "root" || root.is_archived || root.parent_issue_id !== undefined ||
        root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id ||
        !cycle || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
        cycle.project_id !== root.project_id) return invalid("topology_invalid");
    if (cycle.status_name === "Canceled" && cycle.labels.includes("Recovery Exhausted") &&
        cycle.description.includes("The maximum Cycle repair attempt limit was exceeded.")) return { kind: "satisfied" };
    const convergence = facts.rootSnapshot.root.convergence;
    const activeCycles = view.tree.issues.filter(({ issue_kind, is_archived, status_category }) =>
      issue_kind === "cycle" && !is_archived && status_category !== "completed" && status_category !== "canceled");
    const derivedRepairAttempts = view.tree.issues.filter((issue) => {
      if (issue.parent_issue_id !== cycle.issue_id) return false;
      if (issue.issue_kind !== "work" && issue.issue_kind !== "verify") return false;
      if (issue.status_name === "Failed" || issue.status_name === "Interrupted") return true;
      return issue.issue_kind === "verify" && issue.status_name === "Done" && issue.labels.some((label) =>
        label === "Changes Required" || label === "Inconclusive" || label === "Contract Violation");
    }).length;
    if (convergence.view.activeCycleIssueId !== cycle.issue_id ||
        activeCycles.length !== 1 || activeCycles[0]?.issue_id !== cycle.issue_id ||
        convergence.view.activeCycleRepairAttempts !== derivedRepairAttempts ||
        convergence.view.activeCycleRepairAttempts <= convergence.policy.maxCycleRepairAttempts ||
        !facts.rootSnapshot.cycles.some(({ cycleIssue, isArchived }) =>
          cycleIssue.issueId === cycle.issue_id && !cycleIssue.isArchived && !isArchived)) {
      return invalid("topology_invalid");
    }
    const canceled = view.tree.status_catalog.filter(({ name }) => name === "Canceled");
    if (canceled.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      command: {
        kind: "update_workflow_issue",
        writeId: mechanicalWriteId([root.issue_id, cycle.issue_id, cycle.remote_version, "repair-limit-exhausted"]),
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
        statusId: canceled[0]!.status_id,
        title: cycle.title,
        description: [
          "# Recovery Conclusion", "", "The maximum Cycle repair attempt limit was exceeded.", "",
          "## Outcome", "", "recovery_exhausted",
        ].join("\n"),
        labelNames: ["Recovery Exhausted", "symphony:kind/cycle"],
        parentAssignment: { mode: "retain" },
        order: cycle.order,
      },
    };
  }
}

function invalid(reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"]): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
