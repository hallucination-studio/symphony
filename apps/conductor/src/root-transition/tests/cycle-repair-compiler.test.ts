import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { CycleRepairCompilerImpl } from "../internal/CycleRepairCompilerImpl.js";

test("Cycle repair compiler binds production-shaped repair Work to each interrupted Stage actor", () => {
  for (const role of ["work", "verify"] as const) {
    const currentView = view(role, false);
    const result = new CycleRepairCompilerImpl().compile({ target: target(currentView, role), view: currentView });
    assert.equal(result.kind, "effect");

    currentView.tree.issues.find(({ issue_id }) => issue_id === "work-repair")!.creator_user_id = "human-1";
    assert.deepEqual(new CycleRepairCompilerImpl().compile({ target: target(currentView, role), view: currentView }), {
      kind: "invalid_facts", reason: "topology_invalid",
    });
  }
});

test("Cycle repair compiler binds a production-shaped fresh Verify to the interrupted Verify actor", () => {
  const currentView = view("verify", true);
  const successor = currentView.tree.issues.find(({ issue_id }) => issue_id === "verify-repair")!;
  assert.equal(new CycleRepairCompilerImpl().compile({
    target: target(currentView, "verify"), view: currentView,
  }).kind, "effect");

  successor.creator_user_id = "human-1";
  assert.deepEqual(new CycleRepairCompilerImpl().compile({
    target: target(currentView, "verify"), view: currentView,
  }), { kind: "invalid_facts", reason: "topology_invalid" });
});

function target(
  currentView: RootReconciliationView,
  role: "work" | "verify",
): Extract<RootMechanicalTarget, { kind: "converge_cycle_repair" }> {
  return {
    kind: "converge_cycle_repair",
    cycleIssueId: "cycle-1",
    interruptedStageIssueId: `${role}-1`,
    repairWorkIssueId: "work-repair",
    expectedWorktreeGate: currentView.worktreeGate as Extract<
      RootMechanicalTarget,
      { kind: "converge_cycle_repair" }
    >["expectedWorktreeGate"],
  };
}

function view(role: "work" | "verify", withVerifySuccessor: boolean): RootReconciliationView {
  const cycleStatus = role === "work" ? "Executing" : "Verifying";
  const predecessor = issue(`${role}-1`, role, "cycle-1", "Interrupted", [`symphony:kind/${role}`], 2);
  const repair = {
    ...issue("work-repair", "work", "cycle-1", "Todo", ["Cycle Repair", "symphony:kind/work"], 4),
    creator_user_id: "symphony-actor",
    description: [
      "# Repair Objective", "", "Repair the approved execution.", "", "## Recovery Source", "",
      `The current Cycle contains an interrupted ${role} attempt.`, "", "## Acceptance Focus", "",
      "- The approved Plan contract is satisfied.",
    ].join("\n"),
  };
  const children = [
    issue("plan-1", "plan", "cycle-1", "Done", ["symphony:kind/plan"], 1),
    role === "work" ? predecessor : issue("work-1", "work", "cycle-1", "Done", ["symphony:kind/work"], 2),
    role === "work" ? issue("verify-1", "verify", "cycle-1", "Todo", ["symphony:kind/verify"], 3) : predecessor,
    repair,
  ];
  if (withVerifySuccessor) {
    children.push({
      ...issue("verify-repair", "verify", "cycle-1", "Todo", ["Cycle Repair Verify", "symphony:kind/verify"], 3),
      creator_user_id: "symphony-actor",
      title: predecessor.title,
      description: predecessor.description,
    });
  }
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "todo", name: "Todo", category: "unstarted", position: 1 }],
    issues: [
      issue("root-1", "root", undefined, "In Progress", [], 0),
      issue("cycle-1", "cycle", "root-1", cycleStatus, ["symphony:kind/cycle"], 0),
      ...children,
    ],
    comments: [], relations: [], attachments: [],
    activities: [{
      activity_id: `activity-${role}-interrupted`, issue_id: predecessor.issue_id,
      activity_kinds: ["status_changed"], actor_kind: "symphony", actor_id: "symphony-actor",
      to_state_id: predecessor.status_id, remote_version: `activity-${role}-interrupted-v1`,
      created_at: "2026-07-29T03:59:00Z",
    }],
    source_manifest: [
      { source_kind: "linear_issue", source_id: predecessor.issue_id, source_version: predecessor.remote_version, actor_kind: "unknown" },
      { source_kind: "linear_issue", source_id: repair.issue_id, source_version: repair.remote_version, actor_kind: "unknown" },
      ...(withVerifySuccessor ? [{
        source_kind: "linear_issue" as const, source_id: "verify-repair",
        source_version: "verify-repair-v1", actor_kind: "unknown" as const,
      }] : []),
    ],
    coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T05:00:00Z",
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
  issueKind: "root" | "cycle" | "plan" | "work" | "verify",
  parentIssueId: string | undefined,
  statusName: "In Progress" | "Executing" | "Verifying" | "Interrupted" | "Todo" | "Done",
  labels: string[],
  order: number,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId, project_id: "project-1",
    ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusName.toLowerCase(), status_name: statusName,
    status_category: statusName === "Todo" ? "unstarted" : statusName === "Done" ? "completed" :
      statusName === "Interrupted" ? "canceled" : "started",
    status_position: 1, order, depth: parentIssueId ? 1 : 0,
    title: issueKind, description: `${issueKind} description`, labels, is_archived: false,
    issue_kind: issueKind, remote_version: `${issueId}-v1`,
    created_at: `2026-07-29T0${order}:00:00Z`, updated_at: `2026-07-29T0${order}:00:00Z`,
  };
}
