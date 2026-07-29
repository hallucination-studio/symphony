import assert from "node:assert/strict";
import test from "node:test";

import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { StageInterruptionCompilerImpl } from "../internal/StageInterruptionCompilerImpl.js";
import { mechanicalWriteId } from "../internal/MechanicalWriteId.js";

test("compiles one fresh-preconditioned Plan interruption effect", () => {
  const view = interruptionView("In Progress");
  const target: RootMechanicalTarget = {
    kind: "interrupt_stage",
    role: "plan",
    cycleIssueId: "cycle-1",
    stageIssueId: "plan-1",
    expectedWorktreeGate: view.worktreeGate,
  };

  assert.deepEqual(new StageInterruptionCompilerImpl().compile({ target, view }), {
    kind: "effect",
    command: {
      kind: "update_workflow_issue",
      writeId: mechanicalWriteId(["root-1", "plan-1", "plan", "interrupt"]),
      expectedProjectId: "project-1",
      rootIssueId: "root-1",
      expectedRootRemoteVersion: "root-v1",
      target: {
        targetIssueId: "plan-1",
        expectedRemoteVersion: "plan-v1",
        expectedStatusId: "progress",
        expectedParentIssueId: "cycle-1",
        expectedIsArchived: false,
      },
      statusId: "interrupted",
      title: "Plan",
      description: "Plan",
      labelNames: ["symphony:kind/plan"],
      parentAssignment: { mode: "retain" },
      order: 2,
    },
  });

  assert.deepEqual(
    new StageInterruptionCompilerImpl().compile({ target, view: interruptionView("Interrupted") }),
    { kind: "satisfied" },
  );
});

test("mechanical write identities stay bounded for long native IDs", () => {
  const id = mechanicalWriteId(["r".repeat(128), "p".repeat(128), "plan", "interrupt"]);
  assert.match(id, /^mechanical:[a-f0-9]{64}$/u);
  assert.ok(id.length <= 128);
});

test("rejects stale gates, missing status and foreign interruption targets", () => {
  const compiler = new StageInterruptionCompilerImpl();
  const view = interruptionView("In Progress");
  const target: RootMechanicalTarget = {
    kind: "interrupt_stage",
    role: "plan",
    cycleIssueId: "cycle-1",
    stageIssueId: "plan-1",
    expectedWorktreeGate: { ...view.worktreeGate, headRevision: "stale" },
  };
  assert.deepEqual(compiler.compile({ target, view }), { kind: "invalid_facts", reason: "target_stale" });

  const missingStatus = interruptionView("In Progress");
  missingStatus.tree.status_catalog = missingStatus.tree.status_catalog.filter(({ name }) => name !== "Interrupted");
  assert.deepEqual(
    compiler.compile({ target: { ...target, expectedWorktreeGate: missingStatus.worktreeGate }, view: missingStatus }),
    { kind: "invalid_facts", reason: "status_catalog_invalid" },
  );

  const foreign = interruptionView("In Progress");
  foreign.tree.issues[2]!.parent_issue_id = "root-1";
  assert.deepEqual(
    compiler.compile({ target: { ...target, expectedWorktreeGate: foreign.worktreeGate }, view: foreign }),
    { kind: "invalid_facts", reason: "topology_invalid" },
  );
});

function interruptionView(planStatus: "In Progress" | "Interrupted"): Extract<RootReconciliationView, { workspace: object }> {
  const worktreeGate = { kind: "valid" as const, repositoryIdentity: "repo-1", branch: "root-1", headRevision: "head-1", isClean: true, changedPaths: [] };
  const statusId = planStatus === "In Progress" ? "progress" : "interrupted";
  return {
    root: { issueId: "root-1", identifier: "SYM-1", state: "In Progress", updatedAt: "2026-07-29T00:00:00Z", projectId: "project-1", priority: "normal", blockers: [], rootConductorLabels: [{ conductorShortHash: "abc123" }], isDelegatedToSymphony: true, isArchived: false },
    tree: {
      root_issue_id: "root-1",
      status_catalog: [
        { status_id: "progress", name: "In Progress", category: "started", position: 1 },
        { status_id: "planning", name: "Planning", category: "started", position: 2 },
        { status_id: "interrupted", name: "Interrupted", category: "canceled", position: 3 },
      ],
      issues: [
        issue("root-1", "root", undefined, "progress", "In Progress", 0, "root-v1"),
        issue("cycle-1", "cycle", "root-1", "planning", "Planning", 1, "cycle-v1"),
        issue("plan-1", "plan", "cycle-1", statusId, planStatus, 2, "plan-v1"),
      ],
      comments: [], relations: [], attachments: [], activities: [], source_manifest: [],
      coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T00:00:00Z",
    },
    worktreeGate,
    workspace: { branch: "root-1", worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
    git: { head: "head-1", branch: "root-1", status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt: "2026-07-29T00:00:00Z", treeDigest: "digest-1", complete: true,
  };
}

function issue(
  issueId: string,
  kind: "root" | "cycle" | "plan",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: string,
  depth: number,
  remoteVersion: string,
) {
  return {
    issue_id: issueId, identifier: `SYM-${depth + 1}`, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId, status_name: statusName, status_category: statusName === "Interrupted" ? "canceled" as const : "started" as const,
    status_position: depth + 1, order: depth, depth, title: kind === "plan" ? "Plan" : kind, description: kind === "plan" ? "Plan" : kind,
    labels: kind === "root" ? [] : [`symphony:kind/${kind}`], is_archived: false, issue_kind: kind,
    remote_version: remoteVersion, created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z",
  };
}
