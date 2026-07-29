import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { CycleReplanCompilerImpl } from "../internal/CycleReplanCompilerImpl.js";

test("Cycle replan compiler binds a production-shaped successor creator to the interrupted Stage actor", () => {
  const currentView = view();
  const predecessor = currentView.tree.issues.find(({ issue_id }) => issue_id === "plan-1")!;
  const successor = currentView.tree.issues.find(({ issue_id }) => issue_id === "plan-replan")!;

  assert.equal(new CycleReplanCompilerImpl().compile({ target: target(currentView), view: currentView }).kind, "effect");

  successor.creator_user_id = "human-1";
  assert.deepEqual(new CycleReplanCompilerImpl().compile({ target: target(currentView), view: currentView }), {
    kind: "invalid_facts", reason: "topology_invalid",
  });

  successor.creator_user_id = "symphony-actor";
  currentView.tree.activities.push({
    activity_id: "activity-successor-human-edit", issue_id: successor.issue_id,
    activity_kinds: ["description_changed"], actor_kind: "human", actor_id: "human-1",
    updated_description: successor.description, remote_version: "activity-successor-human-edit-v1",
    created_at: "2026-07-29T03:01:00Z",
  });
  assert.deepEqual(new CycleReplanCompilerImpl().compile({ target: target(currentView), view: currentView }), {
    kind: "invalid_facts", reason: "topology_invalid",
  });

  assert.equal(predecessor.status_name, "Interrupted");
});

function target(currentView: RootReconciliationView): Extract<RootMechanicalTarget, { kind: "converge_cycle_replan" }> {
  return {
    kind: "converge_cycle_replan",
    cycleIssueId: "cycle-1",
    successorPlanIssueId: "plan-replan",
    expectedWorktreeGate: currentView.worktreeGate as Extract<
      RootMechanicalTarget,
      { kind: "converge_cycle_replan" }
    >["expectedWorktreeGate"],
  };
}

function view(): RootReconciliationView {
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [],
    issues: [
      issue("root-1", "root", undefined, "In Progress", [], "2026-07-29T00:00:00Z"),
      issue("cycle-1", "cycle", "root-1", "Planning", ["symphony:kind/cycle"], "2026-07-29T01:00:00Z"),
      issue("plan-1", "plan", "cycle-1", "Interrupted", ["symphony:kind/plan"], "2026-07-29T02:00:00Z"),
      {
        ...issue("plan-replan", "plan", "cycle-1", "Todo", ["Cycle Replan", "symphony:kind/plan"], "2026-07-29T03:00:00Z"),
        creator_user_id: "symphony-actor",
        description: [
          "# Replan Objective", "", "Create a replacement Plan.", "", "## Recovery Source", "",
          "The current Cycle contains an interrupted plan attempt.", "", "## Preserved Constraints", "",
          "- Keep the Root acceptance criteria unchanged.",
        ].join("\n"),
      },
    ],
    comments: [], relations: [], attachments: [],
    activities: [{
      activity_id: "activity-plan-interrupted", issue_id: "plan-1",
      activity_kinds: ["status_changed"], actor_kind: "symphony", actor_id: "symphony-actor",
      to_state_id: "interrupted", remote_version: "activity-plan-interrupted-v1",
      created_at: "2026-07-29T02:59:00Z",
    }],
    source_manifest: [
      { source_kind: "linear_issue", source_id: "plan-1", source_version: "plan-1-v1", actor_kind: "unknown" },
      { source_kind: "linear_issue", source_id: "plan-replan", source_version: "plan-replan-v1", actor_kind: "unknown" },
    ],
    coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T04:00:00Z",
  };
  return {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress", updatedAt: tree.observed_at,
      projectId: "project-1", priority: "normal", blockers: [], rootConductorLabels: [],
      isDelegatedToSymphony: true, isArchived: false,
    },
    tree,
    worktreeGate: {
      kind: "valid", repositoryIdentity: "repository-1", branch: "symphony/runs/sym-1",
      headRevision: "head-1", isClean: true, changedPaths: [],
    },
    workspace: { branch: "symphony/runs/sym-1", worktreePath: "/tmp/sym-1", rootIssueId: "root-1" },
    git: {
      head: "head-1", branch: "symphony/runs/sym-1",
      status: { items: [], returned: 0, cap: 16, has_more: false, partial: false },
    },
    observedAt: tree.observed_at, treeDigest: "tree-v1", complete: true,
  };
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle" | "plan",
  parentIssueId: string | undefined,
  statusName: "In Progress" | "Planning" | "Interrupted" | "Todo",
  labels: string[],
  createdAt: string,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId, project_id: "project-1",
    ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusName.toLowerCase().replace(" ", "-"), status_name: statusName,
    status_category: statusName === "Todo" ? "unstarted" : statusName === "Interrupted" ? "canceled" : "started",
    status_position: 1, order: 0, depth: parentIssueId ? 1 : 0,
    title: issueKind, description: `${issueKind} description`, labels, is_archived: false,
    issue_kind: issueKind, remote_version: `${issueId}-v1`, created_at: createdAt, updated_at: createdAt,
  };
}
