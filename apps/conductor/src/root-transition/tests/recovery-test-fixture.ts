import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";

export function recoveryView(input: { authorized?: boolean; includePlan?: boolean } = {}): RootReconciliationView {
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "todo", name: "Todo", category: "unstarted", position: 1 },
      { status_id: "canceled", name: "Canceled", category: "canceled", position: 2 },
    ],
    issues: [
      issue("root-1", "root", undefined, []),
      issue("cycle-1", "cycle", "root-1", input.authorized ? ["Execution Invalidated", "symphony:kind/cycle"] : ["symphony:kind/cycle"]),
      ...(input.includePlan ? [issue("plan-1", "plan", "cycle-1", ["symphony:kind/plan"])] : []),
    ],
    comments: [], relations: [], attachments: [], activities: [], source_manifest: [],
    coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T00:00:00Z",
  };
  if (input.authorized) {
    Object.assign(tree.issues[1]!, { status_id: "canceled", status_name: "Canceled", status_category: "canceled" });
  }
  return {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress", updatedAt: tree.observed_at,
      projectId: "project-1", priority: "normal", blockers: [], rootConductorLabels: [],
      isDelegatedToSymphony: true, isArchived: false,
    },
    tree,
    worktreeGate: {
      kind: "execution_generation_invalid", repositoryIdentity: "repository-1",
      expectedBranch: "symphony/runs/sym-1", reason: "branch_missing",
    },
    observedAt: tree.observed_at,
    treeDigest: "tree-v1",
    complete: true,
  };
}

function issue(
  issueId: string,
  kind: "root" | "cycle" | "plan",
  parentIssueId: string | undefined,
  labels: string[],
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId === "root-1" ? "SYM-1" : issueId === "cycle-1" ? "SYM-2" : "SYM-3",
    project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: "todo", status_name: "Todo", status_category: "unstarted", status_position: 1,
    order: 0, depth: kind === "root" ? 0 : kind === "cycle" ? 1 : 2,
    title: kind, description: kind, labels, is_archived: false, issue_kind: kind,
    remote_version: `${issueId}-v1`, created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z",
  };
}
