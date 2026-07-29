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

export class SuccessorCyclePlanCompilerImpl implements RootMechanicalConvergenceCompilerInterface {
  compile(input: RootMechanicalConvergenceCompilerInput): RootMechanicalConvergenceCompilerResult {
    const { target, facts, view } = input;
    if (target.kind !== "converge_successor_cycle_plan" ||
      facts.rootSnapshot.root.issue.issueId !== view.root.issueId ||
      facts.rootDigest !== view.treeDigest ||
      !isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate) ||
      !isDeepStrictEqual(facts.rootSnapshot.worktreeGate, view.worktreeGate)) {
      return invalid("target_stale");
    }

    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    if (!root || root.issue_kind !== "root" || root.is_archived || root.status_name !== "In Progress" ||
      root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id ||
      view.worktreeGate.kind !== "valid" || !("workspace" in view) || !("git" in view)) return invalid("topology_invalid");

    const cycles = view.tree.issues
      .filter(({ issue_kind, parent_issue_id }) => issue_kind === "cycle" && parent_issue_id === root.issue_id)
      .sort(compareIssueIdentity);
    if (!cycles.some(({ issue_id }) => issue_id === target.predecessorCycleIssueId)) return invalid("target_stale");
    const invalidated = cycles.filter((cycle) => cycle.is_archived && cycle.status_name === "Canceled" &&
      cycle.labels.includes("Execution Invalidated"));
    const predecessor = invalidated.at(-1);
    const generationOrdinal = invalidated.length + 1;
    if (!predecessor || predecessor.issue_id !== target.predecessorCycleIssueId ||
      view.worktreeGate.branch !== generationBranch(view.root.identifier, generationOrdinal) ||
      view.workspace.branch !== view.worktreeGate.branch || view.git.branch !== view.worktreeGate.branch ||
      view.git.head !== view.worktreeGate.headRevision) return invalid("topology_invalid");

    const factCycles = new Map(facts.rootSnapshot.cycles.map(({ cycleIssue }) => [cycleIssue.issueId, cycleIssue]));
    if (cycles.some((cycle) => factCycles.get(cycle.issue_id)?.createdAt !== cycle.created_at)) {
      return invalid("topology_invalid");
    }

    const active = view.tree.issues.filter(({ issue_id, is_archived }) => issue_id !== root.issue_id && !is_archived);
    const activeCycles = active.filter(({ issue_kind }) => issue_kind === "cycle");
    if (activeCycles.length === 0) {
      if (cycles.at(-1)?.issue_id !== predecessor.issue_id) return invalid("topology_invalid");
      if (active.length > 0 || view.tree.issues.some((issue) =>
        issue.issue_id !== root.issue_id && issue.issue_id !== predecessor.issue_id && !issue.is_archived)) {
        return invalid("topology_invalid");
      }
      const planning = uniqueStatus(view.tree, "Planning");
      if (!planning) return invalid("status_catalog_invalid");
      return {
        kind: "effect",
        command: {
          kind: "create_workflow_issue",
          writeId: mechanicalWriteId([root.issue_id, "successor-cycle", predecessor.issue_id]),
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          parentExpectedRemoteVersion: root.remote_version,
          parentExpectedStatusId: root.status_id,
          parentIssueId: root.issue_id,
          title: `Cycle ${cycles.length + 1}`,
          description: facts.rootSnapshot.root.objective,
          statusId: planning.status_id,
          labelNames: [workflowKindLabel("cycle")],
        },
      };
    }

    if (activeCycles.length !== 1) return invalid("topology_invalid");
    const cycle = activeCycles[0]!;
    const activeCycleIndex = cycles.findIndex(({ issue_id }) => issue_id === cycle.issue_id);
    const children = active.filter(({ parent_issue_id }) => parent_issue_id === cycle.issue_id);
    if (activeCycleIndex < 1 || activeCycleIndex !== cycles.length - 1 ||
      cycles[activeCycleIndex - 1]?.issue_id !== predecessor.issue_id || cycle.status_name !== "Planning" ||
      cycle.project_id !== root.project_id || active.length !== 1 + children.length ||
      children.some(({ issue_kind }) => issue_kind !== "plan") ||
      view.tree.relations.some(({ source_issue_id, target_issue_id }) =>
        source_issue_id === cycle.issue_id || target_issue_id === cycle.issue_id)) return invalid("topology_invalid");

    const plans = children.filter(({ issue_kind }) => issue_kind === "plan");
    if (plans.length === 0) {
      const todo = uniqueStatus(view.tree, "Todo");
      if (!todo) return invalid("status_catalog_invalid");
      return {
        kind: "effect",
        command: {
          kind: "create_workflow_issue",
          writeId: mechanicalWriteId([root.issue_id, "successor-plan", predecessor.issue_id, cycle.issue_id]),
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          parentExpectedRemoteVersion: cycle.remote_version,
          parentExpectedStatusId: cycle.status_id,
          parentIssueId: cycle.issue_id,
          title: "Plan",
          description: renderPlan(input),
          statusId: todo.status_id,
          labelNames: [workflowKindLabel("plan")],
        },
      };
    }
    if (plans.length !== 1 || plans[0]!.status_name !== "Todo") return invalid("topology_invalid");
    return { kind: "satisfied" };
  }
}

function generationBranch(rootIdentifier: string, generationOrdinal: number): string {
  return `symphony/runs/${rootIdentifier.toLowerCase()}-g${generationOrdinal}`;
}

function compareIssueIdentity(left: TreeIssue, right: TreeIssue): number {
  return left.created_at.localeCompare(right.created_at) || left.issue_id.localeCompare(right.issue_id);
}

function uniqueStatus(tree: LinearWorkflowTreeSnapshot, name: string) {
  const matches = tree.status_catalog.filter((status) => status.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function renderPlan(input: RootMechanicalConvergenceCompilerInput): string {
  const root = input.facts.rootSnapshot.root;
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
