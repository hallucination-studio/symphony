import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootInvariantPolicyInterface,
  RootInvariantValidationResult,
} from "../api/RootInvariantPolicyInterface.js";
import type { DiscoveredRoot } from "../api/RootModels.js";

export class LinearRootInvariantPolicyImpl implements RootInvariantPolicyInterface {
  validate(input: {
    root: DiscoveredRoot;
    tree: LinearWorkflowTreeSnapshot;
  }): RootInvariantValidationResult {
    const rootIssue = input.tree.issues.find((issue) => issue.issue_id === input.root.issueId);
    if (!rootIssue) return invalid("root_issue_missing");
    if (input.tree.root_issue_id !== input.root.issueId) return invalid("root_tree_identity_mismatch");
    if (rootIssue.project_id !== input.root.projectId) return invalid("root_project_mismatch");
    if (rootIssue.parent_issue_id !== undefined) return invalid("root_parent_present");
    if (rootIssue.is_archived) return invalid("root_archived");

    const activeCycles = input.tree.issues.filter((issue) =>
      issue.parent_issue_id === input.root.issueId && !issue.is_archived && issue.issue_kind === "cycle",
    );
    if (activeCycles.length > 1) return invalid("multiple_active_cycles");
    if (rootIssue.status_category === "canceled" && activeCycles.length > 0) {
      return invalid("canceled_root_has_active_cycle");
    }
    return { kind: "valid" };
  }
}

function invalid(reason: string): RootInvariantValidationResult {
  return { kind: "invalid", reason };
}
