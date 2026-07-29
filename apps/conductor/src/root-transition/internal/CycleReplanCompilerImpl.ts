import { isDeepStrictEqual } from "node:util";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalConvergenceCompilerResult } from "../api/RootMechanicalConvergenceCompilerInterface.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import {
  currentWorkflowIssueProof,
  currentWorkflowStatusActor,
} from "../../root-reconciliation/internal/CurrentIssueProvenance.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

type Target = Extract<RootMechanicalTarget, { kind: "converge_cycle_replan" }>;

export class CycleReplanCompilerImpl {
  compile(input: { target: Target; view: RootReconciliationView }): RootMechanicalConvergenceCompilerResult {
    const { target, view } = input;
    if (!isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate)) return invalid("target_stale");
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
    const successor = view.tree.issues.find(({ issue_id }) => issue_id === target.successorPlanIssueId);
    const children = view.tree.issues.filter(({ parent_issue_id }) => parent_issue_id === cycle?.issue_id);
    const sourceRole = successor ? replanSourceRole(successor.description) : undefined;
    const sourceStages = sourceRole
      ? children.filter(({ issue_kind, status_name }) => issue_kind === sourceRole && status_name === "Interrupted")
      : [];
    const directProof = successor && currentWorkflowIssueProof({
      tree: view.tree, issue: successor, requiredActivityKinds: [],
    });
    const sourceActor = directProof || sourceStages.length !== 1
      ? undefined
      : currentWorkflowStatusActor({ tree: view.tree, issue: sourceStages[0]! });
    const authorized = directProof !== undefined || (successor !== undefined && sourceActor !== undefined &&
      currentWorkflowIssueProof({
        tree: view.tree,
        issue: successor,
        requiredActivityKinds: [],
        expectedActorId: sourceActor,
      }) !== undefined);
    if (!root || root.issue_kind !== "root" || root.status_name !== "In Progress" || root.is_archived ||
        root.parent_issue_id !== undefined || root.project_id !== view.root.projectId ||
        view.tree.root_issue_id !== root.issue_id || !cycle || cycle.issue_kind !== "cycle" || cycle.is_archived ||
        cycle.parent_issue_id !== root.issue_id || !successor || successor.issue_kind !== "plan" || successor.is_archived ||
        successor.parent_issue_id !== cycle.issue_id || successor.status_name !== "Todo" ||
        !successor.labels.includes("Cycle Replan") || !successor.labels.includes("symphony:kind/plan") ||
        !authorized || !sourceRole || children.filter(({ labels }) => labels.includes("Cycle Replan")).length !== 1 ||
        view.tree.relations.some(({ source_issue_id, target_issue_id }) =>
          source_issue_id === successor.issue_id || target_issue_id === successor.issue_id) ||
        !validPredecessorTopology(sourceRole, cycle.status_name, children, successor.issue_id, view.tree.relations)) {
      return invalid("topology_invalid");
    }
    const archiveTarget = children
      .filter(({ issue_id, is_archived }) => issue_id !== successor.issue_id && !is_archived)
      .sort((left, right) => right.depth - left.depth || compareCodePoints(left.issue_id, right.issue_id))[0];
    if (archiveTarget) {
      return {
        kind: "effect",
        command: {
          kind: "set_workflow_issue_archive_state",
          writeId: mechanicalWriteId([
            root.issue_id, cycle.issue_id, successor.issue_id, "cycle-replan-archive", archiveTarget.issue_id,
          ]),
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
    if (cycle.status_name === "Planning") return { kind: "satisfied" };
    const planning = view.tree.status_catalog.filter(({ name }) => name === "Planning");
    if (planning.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      command: {
        kind: "update_workflow_issue",
        writeId: mechanicalWriteId([root.issue_id, cycle.issue_id, successor.issue_id, "cycle-replan-planning"]),
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
        statusId: planning[0]!.status_id,
        title: cycle.title,
        description: cycle.description,
        labelNames: cycle.labels,
        parentAssignment: { mode: "retain" },
        order: cycle.order,
      },
    };
  }
}

function validPredecessorTopology(
  sourceRole: "plan" | "work" | "verify",
  cycleStatus: string,
  children: LinearWorkflowTreeSnapshot["issues"],
  successorIssueId: string,
  relations: LinearWorkflowTreeSnapshot["relations"],
): boolean {
  const old = children.filter(({ issue_id }) => issue_id !== successorIssueId);
  const plans = old.filter(({ issue_kind }) => issue_kind === "plan");
  const works = old.filter(({ issue_kind }) => issue_kind === "work");
  const verifies = old.filter(({ issue_kind }) => issue_kind === "verify");
  if (sourceRole === "plan") {
    return cycleStatus === "Planning" && old.length === 1 && plans[0]?.status_name === "Interrupted" &&
      relations.every(({ source_issue_id, target_issue_id }) =>
        !children.some(({ issue_id }) => issue_id === source_issue_id || issue_id === target_issue_id));
  }
  if (plans.length !== 1 || plans[0]?.status_name !== "Done" || works.length === 0 || verifies.length !== 1) return false;
  if (sourceRole === "work") {
    return cycleStatus === "Executing" && works.filter(({ status_name }) => status_name === "Interrupted").length === 1 &&
      works.every(({ status_name }) => ["Todo", "Done", "Interrupted"].includes(status_name)) &&
      verifies[0]?.status_name === "Todo";
  }
  return cycleStatus === "Verifying" && verifies[0]?.status_name === "Interrupted" &&
    works.every(({ status_name }) => status_name === "Done");
}

function replanSourceRole(description: string): "plan" | "work" | "verify" | undefined {
  const lines = description.split("\n");
  if (lines[0] !== "# Replan Objective" || !lines.includes("## Recovery Source") ||
      !lines.includes("## Preserved Constraints") || !lines.some((line) => line.startsWith("- ") && line.length > 2)) {
    return undefined;
  }
  for (const role of ["plan", "work", "verify"] as const) {
    if (lines.includes(`The current Cycle contains an interrupted ${role} attempt.`)) return role;
  }
  return undefined;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
