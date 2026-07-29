import { isDeepStrictEqual } from "node:util";

import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalConvergenceCompilerResult } from "../api/RootMechanicalConvergenceCompilerInterface.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import {
  currentWorkflowIssueProof,
  currentWorkflowStatusActor,
} from "../../root-reconciliation/internal/CurrentIssueProvenance.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

type Target = Extract<RootMechanicalTarget, { kind: "converge_interrupted_plan_successor" }>;

export class InterruptedPlanSuccessorCompilerImpl {
  compile(input: { target: Target; view: RootReconciliationView }): RootMechanicalConvergenceCompilerResult {
    const { target, view } = input;
    if (!isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate)) return invalid("target_stale");
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
    const predecessor = view.tree.issues.find(({ issue_id }) => issue_id === target.predecessorPlanIssueId);
    const successor = view.tree.issues.find(({ issue_id }) => issue_id === target.successorPlanIssueId);
    const plans = view.tree.issues
      .filter(({ issue_kind, parent_issue_id, is_archived }) =>
        issue_kind === "plan" && parent_issue_id === cycle?.issue_id && !is_archived)
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || compareCodePoints(left.issue_id, right.issue_id));
    if (plans[0]?.issue_id !== target.predecessorPlanIssueId || plans[1]?.issue_id !== target.successorPlanIssueId ||
        plans.length !== 2) return invalid("target_stale");
    const directProof = successor && currentWorkflowIssueProof({
      tree: view.tree, issue: successor, requiredActivityKinds: [],
    });
    const predecessorActor = predecessor && !directProof
      ? currentWorkflowStatusActor({ tree: view.tree, issue: predecessor })
      : undefined;
    const authorized = directProof !== undefined || (successor !== undefined && predecessorActor !== undefined &&
      currentWorkflowIssueProof({
        tree: view.tree,
        issue: successor,
        requiredActivityKinds: [],
        expectedActorId: predecessorActor,
      }) !== undefined);
    if (!root || root.issue_kind !== "root" || root.status_name !== "In Progress" || root.is_archived ||
        root.parent_issue_id !== undefined || root.project_id !== view.root.projectId ||
        view.tree.root_issue_id !== root.issue_id || !cycle || cycle.issue_kind !== "cycle" ||
        cycle.parent_issue_id !== root.issue_id || cycle.status_name !== "Planning" || cycle.is_archived ||
        !predecessor || predecessor.issue_kind !== "plan" || predecessor.parent_issue_id !== cycle.issue_id ||
        predecessor.status_name !== "Interrupted" || !successor || successor.issue_kind !== "plan" ||
        successor.parent_issue_id !== cycle.issue_id || successor.status_name !== "Todo" || successor.is_archived ||
        !successor.labels.includes("Interrupted Plan Successor") ||
        !successor.labels.includes("symphony:kind/plan") || !authorized ||
        view.tree.issues.some((issue) => !issue.is_archived && issue.parent_issue_id === cycle.issue_id &&
          issue.issue_id !== predecessor.issue_id && issue.issue_id !== successor.issue_id)) {
      return invalid("topology_invalid");
    }
    if (predecessor.is_archived) return { kind: "satisfied" };
    return {
      kind: "effect",
      command: {
        kind: "set_workflow_issue_archive_state",
        writeId: mechanicalWriteId([
          root.issue_id, cycle.issue_id, predecessor.issue_id, successor.issue_id,
          "archive-interrupted-plan-predecessor",
        ]),
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: predecessor.issue_id,
          expectedRemoteVersion: predecessor.remote_version,
          expectedIsArchived: false,
        },
        isArchived: true,
      },
    };
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
