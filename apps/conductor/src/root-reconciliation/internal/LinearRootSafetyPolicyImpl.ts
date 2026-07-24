import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
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
    issue.issue_kind === "cycle" && issue.parent_issue_id === rootIssueId && !issue.is_archived,
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

  return violations;
}
