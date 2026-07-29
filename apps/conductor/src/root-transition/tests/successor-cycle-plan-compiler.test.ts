import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { buildRootFactSet } from "../../root-reconciliation/internal/RootFactSet.js";
import { SuccessorCyclePlanCompilerImpl } from "../internal/SuccessorCyclePlanCompilerImpl.js";
import { mechanicalWriteId } from "../internal/MechanicalWriteId.js";

test("compiles a successor Cycle, then its Plan, from archived invalid-generation facts", () => {
  const compiler = new SuccessorCyclePlanCompilerImpl();
  const beforeCycle = fixture();
  assert.deepEqual(compiler.compile(beforeCycle), {
    kind: "effect",
    command: {
      kind: "create_workflow_issue",
      writeId: mechanicalWriteId(["root-1", "successor-cycle", "cycle-1"]),
      expectedProjectId: "project-1",
      rootIssueId: "root-1",
      expectedRootRemoteVersion: "root-v1",
      parentExpectedRemoteVersion: "root-v1",
      parentExpectedStatusId: "root-progress",
      parentIssueId: "root-1",
      title: "Cycle 2",
      description: "Requirement",
      statusId: "planning",
      labelNames: ["symphony:kind/cycle"],
    },
  });

  const afterCycle = fixture({ withSuccessorCycle: true });
  assert.deepEqual(compiler.compile(afterCycle), {
    kind: "effect",
    command: {
      kind: "create_workflow_issue",
      writeId: mechanicalWriteId(["root-1", "successor-plan", "cycle-1", "cycle-2"]),
      expectedProjectId: "project-1",
      rootIssueId: "root-1",
      expectedRootRemoteVersion: "root-v1",
      parentExpectedRemoteVersion: "cycle-2-v1",
      parentExpectedStatusId: "planning",
      parentIssueId: "cycle-2",
      title: "Plan",
      description: [
        "# Plan Goal", "", "Requirement", "", "## Requested Scope", "", "Root", "",
        "## Acceptance And Verification", "", "- Requirement (provider-defined verification)",
      ].join("\n"),
      statusId: "todo",
      labelNames: ["symphony:kind/plan"],
    },
  });
});

test("rejects stale, wrong-generation and non-canonical successor facts", () => {
  const compiler = new SuccessorCyclePlanCompilerImpl();
  const stale = fixture();
  stale.target.predecessorCycleIssueId = "cycle-other";
  assert.deepEqual(compiler.compile(stale), { kind: "invalid_facts", reason: "target_stale" });

  const wrongBranch = fixture();
  assert.equal(wrongBranch.view.worktreeGate.kind, "valid");
  if (wrongBranch.view.worktreeGate.kind !== "valid") return;
  assert.equal(wrongBranch.facts.rootSnapshot.worktreeGate.kind, "valid");
  if (wrongBranch.facts.rootSnapshot.worktreeGate.kind !== "valid") return;
  wrongBranch.view.worktreeGate.branch = "symphony/runs/sym-1";
  wrongBranch.target.expectedWorktreeGate.branch = "symphony/runs/sym-1";
  wrongBranch.facts.rootSnapshot.worktreeGate.branch = "symphony/runs/sym-1";
  assert.deepEqual(compiler.compile(wrongBranch), { kind: "invalid_facts", reason: "topology_invalid" });

  const unarchived = fixture();
  unarchived.view.tree.issues[1]!.is_archived = false;
  assert.deepEqual(compiler.compile(unarchived), { kind: "invalid_facts", reason: "topology_invalid" });

  const skippedCycle = fixture({ withSuccessorCycle: true });
  skippedCycle.view.tree.issues.splice(2, 0, issue(
    "cycle-intervening", "SYM-4", "cycle", "root-1", "canceled", "Canceled", "cycle-intervening-v1", true,
    ["symphony:kind/cycle"], "2026-07-28T12:00:00Z",
  ));
  assert.deepEqual(compiler.compile(skippedCycle), { kind: "invalid_facts", reason: "topology_invalid" });

  const mismatchedCreatedAt = fixture({ withSuccessorCycle: true });
  mismatchedCreatedAt.view.tree.issues[1]!.created_at = "2026-07-29T01:00:00Z";
  assert.deepEqual(compiler.compile(mismatchedCreatedAt), { kind: "invalid_facts", reason: "topology_invalid" });
});

function fixture(input: { withSuccessorCycle?: boolean } = {}) {
  const root = issue("root-1", "SYM-1", "root", undefined, "root-progress", "In Progress", "root-v1", false, [], "2026-07-28T00:00:00Z");
  const predecessor = issue("cycle-1", "SYM-2", "cycle", "root-1", "canceled", "Canceled", "cycle-1-v2", true,
    ["symphony:kind/cycle", "Execution Invalidated"], "2026-07-28T01:00:00Z");
  const successor = issue("cycle-2", "SYM-3", "cycle", "root-1", "planning", "Planning", "cycle-2-v1", false,
    ["symphony:kind/cycle"], "2026-07-29T00:00:00Z");
  const issues = [root, predecessor, ...(input.withSuccessorCycle ? [successor] : [])];
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "root-progress", name: "In Progress", category: "started", position: 1 },
      { status_id: "planning", name: "Planning", category: "started", position: 2 },
      { status_id: "todo", name: "Todo", category: "unstarted", position: 3 },
      { status_id: "canceled", name: "Canceled", category: "canceled", position: 4 },
    ],
    issues, comments: [], relations: [], attachments: [], activities: [],
    source_manifest: issues.map(({ issue_id, remote_version }) => ({
      source_kind: "linear_issue" as const, source_id: issue_id, source_version: remote_version, actor_kind: "unknown" as const,
    })),
    coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T00:00:00Z",
  };
  const worktreeGate = {
    kind: "valid" as const, repositoryIdentity: "repo-1", branch: "symphony/runs/sym-1-g2",
    headRevision: "base-2", isClean: true, changedPaths: [],
  };
  const discoveredRoot = {
    issueId: "root-1", identifier: "SYM-1", state: "In Progress" as const, updatedAt: tree.observed_at,
    projectId: "project-1", priority: "normal" as const, blockers: [], rootConductorLabels: [],
    isDelegatedToSymphony: true, isArchived: false,
  };
  const factSet = buildRootFactSet({
    root: discoveredRoot, tree, worktreeGate, mechanicalViolations: [],
    convergence: {
      policy: { maxCyclesPerRoot: 3, maxSameOpenFindingCycles: 2, maxCycleRepairAttempts: 2, deadlineAt: "2026-07-30T00:00:00Z" },
      view: { cycleCount: issues.filter(({ issue_kind }) => issue_kind === "cycle").length, openFindingPersistence: [], activeCycleRepairAttempts: 0, isDeadlineExceeded: false, rootIsCanceled: false, ...(input.withSuccessorCycle ? { activeCycleIssueId: "cycle-2" } : {}) },
    },
  });
  const view: RootReconciliationView = {
    root: discoveredRoot, tree, worktreeGate,
    workspace: { branch: worktreeGate.branch, worktreePath: "/tmp/root-1-g2", rootIssueId: "root-1" },
    git: { head: "base-2", branch: worktreeGate.branch, status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt: tree.observed_at, treeDigest: factSet.bootstrap.rootDigest, complete: true,
  };
  return {
    target: {
      kind: "converge_successor_cycle_plan" as const,
      predecessorCycleIssueId: "cycle-1",
      expectedWorktreeGate: structuredClone(worktreeGate),
    },
    facts: factSet.bootstrap,
    view,
  };
}

function issue(
  issueId: string, identifier: string, kind: "root" | "cycle", parentIssueId: string | undefined,
  statusId: string, statusName: "In Progress" | "Planning" | "Canceled", remoteVersion: string,
  archived: boolean, labels: string[], createdAt: string,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId, status_name: statusName, status_category: statusName === "Canceled" ? "canceled" : "started",
    status_position: 1, order: 0, depth: kind === "root" ? 0 : 1, title: kind === "root" ? "Root" : "Cycle",
    description: "Requirement", labels, is_archived: archived, issue_kind: kind, remote_version: remoteVersion,
    created_at: createdAt, updated_at: createdAt,
  };
}
