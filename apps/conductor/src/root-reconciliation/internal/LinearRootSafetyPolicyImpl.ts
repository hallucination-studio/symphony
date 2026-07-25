import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootSafetyPolicyInterface, RootSafetyValidationResult } from "../api/RootSafetyPolicyInterface.js";
import type { DiscoveredRoot } from "../api/RootModels.js";
import type { MechanicalViolation } from "../api/RootReconciliationContracts.js";
import { cycleOutcomeId } from "../api/CycleOutcome.js";
import { parseManagedRecord } from "./ManagedRecordCodec.js";

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
  if (activeCycles.length > 1) {
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

  const issuesById = new Map(tree.issues.map((issue) => [issue.issue_id, issue]));
  for (const relation of tree.relations) {
    const source = issuesById.get(relation.source_issue_id);
    const target = issuesById.get(relation.target_issue_id);
    if (source?.is_archived || target?.is_archived) {
      violations.push({
        violationKind: "archived_dependency",
        sourceIssueIds: [relation.source_issue_id, relation.target_issue_id],
        summary: "An active relation references an archived Issue.",
      });
    }
  }

  for (const cycle of tree.issues.filter((issue) =>
    issue.issue_kind === "cycle" && issue.parent_issue_id === rootIssueId && isTerminalCycle(issue),
  )) {
    const outcomes = tree.comments.flatMap((comment) => {
      if (comment.issue_id !== cycle.issue_id || comment.author_kind !== "symphony") return [];
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok && parsed.value.kind === "cycle_outcome" ? [parsed.value] : [];
    });
    const outcome = outcomes[0];
    if (
      outcomes.length !== 1 ||
      !outcome ||
      outcome.rootIssueId !== rootIssueId ||
      outcome.cycleIssueId !== cycle.issue_id ||
      outcome.cycleOutcomeId !== cycleOutcomeId({
        rootIssueId: outcome.rootIssueId,
        cycleIssueId: outcome.cycleIssueId,
        rootDirectiveId: outcome.sourceRootDirectiveId,
      }) ||
      !outcomeMatchesStatus(outcome.conclusion, cycle.status_name)
    ) {
      violations.push({
        violationKind: "cycle_terminal_outcome_mismatch",
        sourceIssueIds: [cycle.issue_id],
        summary: "A terminal Cycle does not have one matching CycleOutcome.",
      });
    }
  }

  return violations;
}

function isTerminalCycle(issue: LinearWorkflowTreeSnapshot["issues"][number]): boolean {
  return issue.status_category === "completed" || issue.status_category === "canceled" ||
    ["Succeeded", "Changes Required", "Canceled"].includes(issue.status_name);
}

function outcomeMatchesStatus(
  conclusion: "succeeded" | "repair_required" | "exhausted" | "superseded" | "canceled",
  statusName: string,
): boolean {
  if (conclusion === "succeeded") return statusName === "Succeeded";
  if (conclusion === "canceled") return statusName === "Canceled";
  return statusName === "Changes Required";
}
