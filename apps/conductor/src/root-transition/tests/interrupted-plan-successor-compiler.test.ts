import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { InterruptedPlanSuccessorCompilerImpl } from "../internal/InterruptedPlanSuccessorCompilerImpl.js";

test("interrupted Plan successor convergence archives only the exact predecessor", () => {
  const currentView = view();
  const result = new InterruptedPlanSuccessorCompilerImpl().compile({ target: target(currentView), view: currentView });

  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "set_workflow_issue_archive_state");
  if (result.command.kind !== "set_workflow_issue_archive_state") return;
  assert.equal(result.command.target.targetIssueId, "plan-1");
  assert.equal(result.command.target.expectedRemoteVersion, "plan-1-v1");
  assert.equal(result.command.isArchived, true);
});

test("interrupted Plan successor compiler accepts production-shaped creator and predecessor Activity provenance", () => {
  const currentView = view();
  const predecessor = currentView.tree.issues.find(({ issue_id }) => issue_id === "plan-1")!;
  const successor = currentView.tree.issues.find(({ issue_id }) => issue_id === "plan-2")!;
  successor.creator_user_id = "symphony-actor";
  currentView.tree.source_manifest[0]!.actor_kind = "unknown";
  currentView.tree.source_manifest.push({
    source_kind: "linear_issue", source_id: predecessor.issue_id,
    source_version: predecessor.remote_version, actor_kind: "unknown",
  });
  currentView.tree.activities.push({
    activity_id: "activity-plan-interrupted", issue_id: predecessor.issue_id,
    activity_kinds: ["status_changed"], actor_kind: "symphony", actor_id: "symphony-actor",
    to_state_id: predecessor.status_id, remote_version: "activity-plan-interrupted-v1",
    created_at: "2026-07-29T02:59:00Z",
  });

  assert.equal(new InterruptedPlanSuccessorCompilerImpl().compile({
    target: target(currentView), view: currentView,
  }).kind, "effect");

  successor.creator_user_id = "human-1";
  assert.deepEqual(new InterruptedPlanSuccessorCompilerImpl().compile({
    target: target(currentView), view: currentView,
  }), { kind: "invalid_facts", reason: "topology_invalid" });

  successor.creator_user_id = "symphony-actor";
  currentView.tree.activities.push({
    activity_id: "activity-successor-human-edit", issue_id: successor.issue_id,
    activity_kinds: ["description_changed"], actor_kind: "human", actor_id: "human-1",
    updated_description: successor.description, remote_version: "activity-successor-human-edit-v1",
    created_at: "2026-07-29T03:01:00Z",
  });
  assert.deepEqual(new InterruptedPlanSuccessorCompilerImpl().compile({
    target: target(currentView), view: currentView,
  }), { kind: "invalid_facts", reason: "topology_invalid" });
});

test("interrupted Plan successor convergence rejects stale or foreign authorization", () => {
  const staleView = view();
  const staleTarget = target(staleView);
  staleTarget.predecessorPlanIssueId = "other-plan";
  assert.deepEqual(new InterruptedPlanSuccessorCompilerImpl().compile({ target: staleTarget, view: staleView }), {
    kind: "invalid_facts", reason: "target_stale",
  });

  const foreignView = view();
  foreignView.tree.source_manifest[0]!.actor_kind = "human";
  assert.deepEqual(new InterruptedPlanSuccessorCompilerImpl().compile({
    target: target(foreignView), view: foreignView,
  }), { kind: "invalid_facts", reason: "topology_invalid" });
});

test("interrupted Plan successor convergence permits archived Plan history", () => {
  const currentView = view();
  currentView.tree.issues.push({
    ...issue("plan-0", "plan", "cycle-1", "Interrupted", ["symphony:kind/plan"], "2026-07-28T00:00:00Z"),
    is_archived: true,
  });
  const result = new InterruptedPlanSuccessorCompilerImpl().compile({ target: target(currentView), view: currentView });
  assert.equal(result.kind, "effect");
  if (result.kind === "effect" && result.command.kind === "set_workflow_issue_archive_state") {
    assert.equal(result.command.target.targetIssueId, "plan-1");
  }
});

function target(currentView: RootReconciliationView): Extract<RootMechanicalTarget, { kind: "converge_interrupted_plan_successor" }> {
  return {
    kind: "converge_interrupted_plan_successor",
    cycleIssueId: "cycle-1",
    predecessorPlanIssueId: "plan-1",
    successorPlanIssueId: "plan-2",
    expectedWorktreeGate: currentView.worktreeGate as Extract<RootMechanicalTarget, { kind: "converge_interrupted_plan_successor" }>["expectedWorktreeGate"],
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
      issue("plan-2", "plan", "cycle-1", "Todo", ["Interrupted Plan Successor", "symphony:kind/plan"], "2026-07-29T03:00:00Z"),
    ],
    comments: [], relations: [], attachments: [], activities: [],
    source_manifest: [{
      source_kind: "linear_issue", source_id: "plan-2", source_version: "plan-2-v1", actor_kind: "symphony",
    }],
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
      kind: "valid", repositoryIdentity: "repository-1",
      branch: "symphony/runs/sym-1", headRevision: "head-1", isClean: true, changedPaths: [],
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
  const category = statusName === "Todo" ? "unstarted" : statusName === "Interrupted" ? "canceled" : "started";
  return {
    issue_id: issueId, identifier: issueId, project_id: "project-1",
    ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusName.toLowerCase().replace(" ", "-"), status_name: statusName,
    status_category: category, status_position: 1, order: 0, depth: parentIssueId ? 1 : 0,
    title: issueKind, description: `${issueKind} description`, labels, is_archived: false,
    issue_kind: issueKind, remote_version: `${issueId}-v1`, created_at: createdAt, updated_at: createdAt,
  };
}
