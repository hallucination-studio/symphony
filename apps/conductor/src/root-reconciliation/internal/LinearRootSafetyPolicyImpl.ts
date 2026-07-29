import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { currentWorkflowIssueProof, currentWorkflowStatusActor } from "./CurrentIssueProvenance.js";
import type { RootSafetyPolicyInterface, RootSafetyValidationResult } from "../api/RootSafetyPolicyInterface.js";
import type { DiscoveredRoot } from "../api/RootModels.js";
import type { MechanicalViolation } from "../api/RootReconciliationContracts.js";

function blocked(reason: string): RootSafetyValidationResult {
  return { kind: "blocked", reason };
}

export class LinearRootSafetyPolicyImpl implements RootSafetyPolicyInterface {
  validate(input: { root: DiscoveredRoot; tree: LinearWorkflowTreeSnapshot }): RootSafetyValidationResult {
    const { root, tree } = input;
    if (!tree.coverage.is_complete) return blocked("linear_source_coverage_incomplete");
    if (tree.root_issue_id !== root.issueId) return blocked("root_tree_identity_mismatch");

    const rootIssue = tree.issues.find((issue) => issue.issue_id === root.issueId);
    if (!rootIssue) return blocked("root_issue_missing");
    if (rootIssue.project_id !== root.projectId) return blocked("root_project_mismatch");
    if (rootIssue.parent_issue_id !== undefined) return blocked("root_parent_present");

    const ids = new Set<string>();
    for (const issue of tree.issues) {
      if (ids.has(issue.issue_id)) return blocked("root_tree_duplicate_issue");
      ids.add(issue.issue_id);
      if (issue.project_id !== root.projectId) return blocked("root_tree_foreign_issue");
    }
    for (const relation of tree.relations) {
      if (!ids.has(relation.source_issue_id) || !ids.has(relation.target_issue_id)) {
        return blocked("root_relation_target_missing");
      }
    }

    return { kind: "safe", mechanicalViolations: mechanicalViolations(tree, rootIssue.issue_id) };
  }
}

function mechanicalViolations(
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
): MechanicalViolation[] {
  const activeCycles = tree.issues.filter((issue) =>
    issue.issue_kind === "cycle" && issue.parent_issue_id === rootIssueId && !issue.is_archived && !isTerminalCycle(issue),
  );
  const violations: MechanicalViolation[] = [];
  if (activeCycles.length > 1 && !isAuthorizedStageRecoveryPair(tree, activeCycles)) {
    violations.push({
      violationKind: "multiple_nonterminal_cycles",
      sourceIssueIds: activeCycles.map(({ issue_id }) => issue_id),
      summary: "More than one active Cycle is attached to the Root.",
    });
  }

  const rootIssue = tree.issues.find(({ issue_id }) => issue_id === rootIssueId);
  if (rootIssue?.status_category === "canceled" && activeCycles.length > 0) {
    violations.push({
      violationKind: "canceled_root_has_active_cycle",
      sourceIssueIds: [rootIssueId, ...activeCycles.map(({ issue_id }) => issue_id)],
      summary: "A canceled Root still has an active Cycle.",
    });
  }

  return violations;
}

function isAuthorizedStageRecoveryPair(
  tree: LinearWorkflowTreeSnapshot,
  activeCycles: LinearWorkflowTreeSnapshot["issues"],
): boolean {
  if (activeCycles.length !== 2) return false;
  const [predecessor, successor] = [...activeCycles]
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || compareCodePoints(left.issue_id, right.issue_id));
  if (!predecessor || !successor || successor.status_name !== "Planning" ||
      !successor.labels.includes("Interrupted Stage Recovery") ||
      !successor.labels.includes("symphony:kind/cycle")) return false;
  const children = tree.issues.filter(({ parent_issue_id }) => parent_issue_id === predecessor.issue_id);
  const source = interruptedWorkflowStage(predecessor.status_name, children);
  const directProof = currentWorkflowIssueProof({ tree, issue: successor, requiredActivityKinds: [] });
  const sourceActor = source && !directProof ? currentWorkflowStatusActor({ tree, issue: source }) : undefined;
  const authorized = directProof !== undefined || (sourceActor !== undefined && currentWorkflowIssueProof({
    tree,
    issue: successor,
    requiredActivityKinds: [],
    expectedActorId: sourceActor,
  }) !== undefined);
  if (!authorized) return false;
  const active = children.filter(({ is_archived }) => !is_archived);
  if (predecessor.status_name === "Executing") {
    return children.filter(({ issue_kind, status_name }) =>
      issue_kind === "work" && status_name === "Interrupted").length === 1 &&
      active.every(({ issue_kind, status_name }) => issue_kind !== "work" || status_name !== "In Progress");
  }
  if (predecessor.status_name === "Verifying") {
    return children.filter(({ issue_kind, status_name }) =>
      issue_kind === "verify" && status_name === "Interrupted").length === 1 &&
      children.filter(({ issue_kind }) => issue_kind === "verify").length === 1 &&
      children.filter(({ issue_kind }) => issue_kind === "work").every(({ status_name }) => status_name === "Done");
  }
  return false;
}

function interruptedWorkflowStage(
  cycleStatus: string,
  children: LinearWorkflowTreeSnapshot["issues"],
): LinearWorkflowTreeSnapshot["issues"][number] | undefined {
  const role = cycleStatus === "Executing" ? "work" : cycleStatus === "Verifying" ? "verify" : undefined;
  if (!role) return undefined;
  const interrupted = children.filter(({ issue_kind, status_name }) =>
    issue_kind === role && status_name === "Interrupted");
  return interrupted.length === 1 ? interrupted[0] : undefined;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isTerminalCycle(issue: LinearWorkflowTreeSnapshot["issues"][number]): boolean {
  return issue.status_category === "completed" || issue.status_category === "canceled" ||
    ["Succeeded", "Changes Required", "Canceled"].includes(issue.status_name);
}
