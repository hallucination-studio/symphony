import { isDeepStrictEqual } from "node:util";

import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalConvergenceCompilerResult } from "../api/RootMechanicalConvergenceCompilerInterface.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

type Target = Extract<RootMechanicalTarget, { kind: "conclude_successful_cycle" }>;

export class SuccessfulCycleCompilerImpl {
  compile(input: { target: Target; view: RootReconciliationView }): RootMechanicalConvergenceCompilerResult {
    const { target, view } = input;
    if (!isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate)) return invalid("target_stale");
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
    const verify = view.tree.issues.find(({ issue_id }) => issue_id === target.verifyIssueId);
    if (!root || root.issue_kind !== "root" || root.is_archived ||
        !cycle || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
        !verify || verify.issue_kind !== "verify" || verify.parent_issue_id !== cycle.issue_id || verify.is_archived ||
        verify.status_name !== "Done" || !verify.labels.includes("Passed")) return invalid("topology_invalid");
    if (cycle.status_name === "Succeeded") return { kind: "satisfied" };
    if (cycle.status_name !== "Verifying") return invalid("topology_invalid");
    const descendants = view.tree.issues.filter(({ parent_issue_id, is_archived }) =>
      parent_issue_id === cycle.issue_id && !is_archived);
    if (descendants.some(({ issue_kind, status_name }) =>
      issue_kind === "work" && status_name !== "Done" ||
      issue_kind === "finding" && status_name !== "Done" && status_name !== "Canceled")) {
      return invalid("topology_invalid");
    }
    const succeeded = view.tree.status_catalog.filter(({ name }) => name === "Succeeded");
    if (succeeded.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      command: {
        kind: "update_workflow_issue",
        writeId: mechanicalWriteId([root.issue_id, cycle.issue_id, "cycle-conclusion", "Succeeded"]),
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
        statusId: succeeded[0]!.status_id,
        title: cycle.title,
        description: cycle.description,
        labelNames: cycle.labels,
        parentAssignment: { mode: "retain" },
        order: cycle.order,
      },
    };
  }
}

function invalid(reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"]): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
