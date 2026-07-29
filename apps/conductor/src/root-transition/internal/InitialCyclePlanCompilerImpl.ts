import { isDeepStrictEqual } from "node:util";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import type {
  RootMechanicalConvergenceCompilerInput,
  RootMechanicalConvergenceCompilerInterface,
  RootMechanicalConvergenceCompilerResult,
} from "../api/RootMechanicalConvergenceCompilerInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

type TreeIssue = LinearWorkflowTreeSnapshot["issues"][number];

export class InitialCyclePlanCompilerImpl implements RootMechanicalConvergenceCompilerInterface {
  compile(input: RootMechanicalConvergenceCompilerInput): RootMechanicalConvergenceCompilerResult {
    const { target, facts, view } = input;
    if (target.kind !== "converge_initial_cycle_plan" ||
      facts.rootSnapshot.root.issue.issueId !== view.root.issueId ||
      facts.rootDigest !== view.treeDigest ||
      !isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate) ||
      !isDeepStrictEqual(facts.rootSnapshot.worktreeGate, view.worktreeGate)) {
      return invalid("target_stale");
    }

    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    if (!root || root.issue_kind !== "root" || root.is_archived || root.status_name !== "In Progress" ||
      root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id) {
      return invalid("topology_invalid");
    }

    const planning = uniqueStatus(view.tree, "Planning");
    const todo = uniqueStatus(view.tree, "Todo");
    if (!planning || !todo) return invalid("status_catalog_invalid");

    const descendants = view.tree.issues.filter(({ issue_id }) => issue_id !== root.issue_id);
    if (descendants.length === 0) {
      return {
        kind: "effect",
        command: {
          kind: "create_workflow_issue",
          writeId: mechanicalWriteId([root.issue_id, "initial-cycle"]),
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          parentExpectedRemoteVersion: root.remote_version,
          parentExpectedStatusId: root.status_id,
          parentIssueId: root.issue_id,
          title: "Cycle 1",
          description: facts.rootSnapshot.root.objective,
          statusId: planning.status_id,
          labelNames: [workflowKindLabel("cycle")],
        },
      };
    }

    const cycles = descendants.filter(({ issue_kind }) => issue_kind === "cycle");
    if (cycles.length !== 1 || !isInitialCycle(cycles[0]!, root)) return invalid("topology_invalid");
    const cycle = cycles[0]!;
    const children = descendants.filter(({ parent_issue_id }) => parent_issue_id === cycle.issue_id);
    const plans = children.filter(({ issue_kind }) => issue_kind === "plan");
    if (descendants.length !== 1 + children.length || children.some(({ issue_kind }) => issue_kind !== "plan") ||
      view.tree.relations.length > 0) {
      return invalid("topology_invalid");
    }
    if (plans.length === 0) {
      return {
        kind: "effect",
        command: {
          kind: "create_workflow_issue",
          writeId: mechanicalWriteId([root.issue_id, "initial-plan"]),
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          parentExpectedRemoteVersion: cycle.remote_version,
          parentExpectedStatusId: cycle.status_id,
          parentIssueId: cycle.issue_id,
          title: "Plan",
          description: renderInitialPlan(facts),
          statusId: todo.status_id,
          labelNames: [workflowKindLabel("plan")],
        },
      };
    }
    if (plans.length !== 1 || !isInitialPlan(plans[0]!, cycle)) return invalid("topology_invalid");
    return { kind: "satisfied" };
  }
}

function uniqueStatus(tree: LinearWorkflowTreeSnapshot, name: string) {
  const matches = tree.status_catalog.filter((status) => status.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function isInitialCycle(cycle: TreeIssue, root: TreeIssue): boolean {
  return cycle.parent_issue_id === root.issue_id && cycle.project_id === root.project_id &&
    cycle.status_name === "Planning" && !cycle.is_archived;
}

function isInitialPlan(plan: TreeIssue, cycle: TreeIssue): boolean {
  return plan.parent_issue_id === cycle.issue_id && plan.project_id === cycle.project_id &&
    plan.status_name === "Todo" && !plan.is_archived;
}

function renderInitialPlan(facts: RootMechanicalConvergenceCompilerInput["facts"]): string {
  const root = facts.rootSnapshot.root;
  const sections = ["# Plan Goal", "", root.objective, "", "## Requested Scope", "", root.scope];
  if (root.constraints.length > 0) {
    sections.push("", "## Constraints", "", ...root.constraints.map((constraint) => `- ${constraint}`));
  }
  sections.push("", "## Acceptance And Verification", "",
    ...root.acceptanceCriteria.map(({ statement, verificationMethod }) => `- ${statement} (${verificationMethod})`));
  return sections.join("\n");
}

function invalid(
  reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
