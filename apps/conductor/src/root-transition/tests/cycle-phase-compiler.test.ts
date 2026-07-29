import assert from "node:assert/strict";
import test from "node:test";

import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { CyclePhaseCompilerImpl } from "../internal/CyclePhaseCompilerImpl.js";
import { mechanicalWriteId } from "../internal/MechanicalWriteId.js";

test("compiles Sealed to Executing as one fresh-preconditioned Cycle effect", () => {
  const view = phaseView("Sealed", ["Todo"]);
  const target = { kind: "advance_cycle_phase" as const, cycleIssueId: "cycle-1", desiredStatus: "Executing" as const, expectedWorktreeGate: view.worktreeGate };
  const result = new CyclePhaseCompilerImpl().compile({ target, view });
  assert.equal(result.kind, "effect");
  if (result.kind !== "effect" || result.command.kind !== "update_workflow_issue") throw new Error("effect_expected");
  assert.equal(result.command.writeId, mechanicalWriteId(["root-1", "cycle-1", "cycle-phase", "Executing"]));
  assert.equal(result.command.target.expectedRemoteVersion, "cycle-1-v1");
  assert.equal(result.command.target.expectedStatusId, "sealed");
  assert.equal(result.command.statusId, "executing");
});

test("compiles Executing to Verifying only after every Work is Done", () => {
  const ready = phaseView("Executing", ["Done", "Done"]);
  const target = { kind: "advance_cycle_phase" as const, cycleIssueId: "cycle-1", desiredStatus: "Verifying" as const, expectedWorktreeGate: ready.worktreeGate };
  assert.equal(new CyclePhaseCompilerImpl().compile({ target, view: ready }).kind, "effect");

  const blocked = phaseView("Executing", ["Done", "Todo"]);
  assert.deepEqual(new CyclePhaseCompilerImpl().compile({ target: { ...target, expectedWorktreeGate: blocked.worktreeGate }, view: blocked }), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});

function phaseView(
  cycleStatus: "Sealed" | "Executing",
  workStatuses: Array<"Todo" | "Done">,
): RootReconciliationView & {
  worktreeGate: Extract<RootReconciliationView["worktreeGate"], { kind: "valid" }>;
} {
  const worktreeGate = { kind: "valid" as const, repositoryIdentity: "repo-1", branch: "root-1", headRevision: "head-1", isClean: true, changedPaths: [] };
  const issues = [
    issue("root-1", "root", undefined, "progress", "In Progress", 0),
    issue("cycle-1", "cycle", "root-1", cycleStatus.toLowerCase(), cycleStatus, 1),
    issue("plan-1", "plan", "cycle-1", "done", "Done", 2),
    ...workStatuses.map((status, index) => issue(`work-${index + 1}`, "work", "cycle-1", status.toLowerCase(), status, index + 3)),
    issue("verify-1", "verify", "cycle-1", "todo", "Todo", workStatuses.length + 3),
  ];
  return {
    root: { issueId: "root-1", identifier: "SYM-1", state: "In Progress", updatedAt: "2026-07-29T00:00:00Z", projectId: "project-1", priority: "normal", blockers: [], rootConductorLabels: [], isDelegatedToSymphony: true, isArchived: false },
    tree: {
      root_issue_id: "root-1",
      status_catalog: [
        { status_id: "progress", name: "In Progress", category: "started", position: 1 },
        { status_id: "sealed", name: "Sealed", category: "started", position: 2 },
        { status_id: "executing", name: "Executing", category: "started", position: 3 },
        { status_id: "verifying", name: "Verifying", category: "started", position: 4 },
        { status_id: "todo", name: "Todo", category: "unstarted", position: 5 },
        { status_id: "done", name: "Done", category: "completed", position: 6 },
      ],
      issues, comments: [], relations: [], attachments: [], activities: [], source_manifest: [],
      coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T00:00:00Z",
    },
    worktreeGate,
    workspace: { branch: "root-1", worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
    git: { head: "head-1", branch: "root-1", status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt: "2026-07-29T00:00:00Z", treeDigest: "digest-1", complete: true,
  };
}

function issue(issueId: string, kind: "root" | "cycle" | "plan" | "work" | "verify", parentIssueId: string | undefined, statusId: string, statusName: string, order: number) {
  return {
    issue_id: issueId, identifier: `SYM-${order + 1}`, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId, status_name: statusName, status_category: statusName === "Done" ? "completed" as const : statusName === "Todo" ? "unstarted" as const : "started" as const,
    status_position: order, order, depth: parentIssueId ? kind === "cycle" ? 1 : 2 : 0, title: kind, description: `${kind} description`,
    labels: kind === "root" ? [] : [`symphony:kind/${kind}`], is_archived: false, issue_kind: kind,
    remote_version: `${issueId}-v1`, created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z",
  };
}
