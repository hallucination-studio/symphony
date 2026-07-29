import assert from "node:assert/strict";
import test from "node:test";

import type {
  RootBootstrap,
  RootFactIssue,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { DeadlineExceededCompilerImpl } from "../internal/DeadlineExceededCompilerImpl.js";

test("Root deadline compiles one Recovery Abandoned Cycle effect before Root cancellation", () => {
  const input = fixture(true);
  const target: Extract<RootMechanicalTarget, { kind: "conclude_deadline_exceeded_cycle" }> = {
    kind: "conclude_deadline_exceeded_cycle", cycleIssueId: "cycle-1",
  };

  const result = new DeadlineExceededCompilerImpl().compile({ ...input, target });

  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "update_workflow_issue");
  if (result.command.kind !== "update_workflow_issue") return;
  assert.equal(result.command.target.targetIssueId, "cycle-1");
  assert.equal(result.command.statusId, "canceled");
  assert.deepEqual(result.command.labelNames, ["Recovery Abandoned", "symphony:kind/cycle"]);
  assert.match(result.command.description, /Root execution deadline was exceeded/u);
  assert.match(result.command.description, /recovery_abandoned/u);
});

test("Root deadline compiles one Root terminal effect only after no active Cycle remains", () => {
  const input = fixture(false);
  const target: Extract<RootMechanicalTarget, { kind: "conclude_deadline_exceeded_root" }> = {
    kind: "conclude_deadline_exceeded_root",
  };

  const result = new DeadlineExceededCompilerImpl().compile({ ...input, target });

  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "update_workflow_issue");
  if (result.command.kind !== "update_workflow_issue") return;
  assert.equal(result.command.target.targetIssueId, "root-1");
  assert.equal(result.command.statusId, "canceled");
  assert.equal(result.command.description, "Keep this requirement unchanged.");
  assert.deepEqual(result.command.labelNames, ["symphony:kind/root", "Deadline Exceeded"]);
});

test("Root deadline compiler rejects stale time and direct Root cancellation with an active Cycle", () => {
  const compiler = new DeadlineExceededCompilerImpl();
  const stale = fixture(false);
  stale.view.tree.observed_at = "2026-07-29T00:00:00Z";
  assert.deepEqual(compiler.compile({
    ...stale, target: { kind: "conclude_deadline_exceeded_root" },
  }), { kind: "invalid_facts", reason: "target_stale" });

  const active = fixture(true);
  assert.deepEqual(compiler.compile({
    ...active, target: { kind: "conclude_deadline_exceeded_root" },
  }), { kind: "invalid_facts", reason: "topology_invalid" });
});

test("Root deadline cancellation accepts a nonterminal Human Action summary status", () => {
  const input = fixture(false);
  const root = input.view.tree.issues.find(({ issue_id }) => issue_id === "root-1")!;
  Object.assign(root, { status_name: "Needs Approval", status_id: "needs-approval", status_category: "started" });
  input.view.tree.status_catalog.push({
    status_id: "needs-approval", name: "Needs Approval", category: "started", position: 1.5,
  });

  const result = new DeadlineExceededCompilerImpl().compile({
    ...input, target: { kind: "conclude_deadline_exceeded_root" },
  });
  assert.equal(result.kind, "effect");
});

test("Root deadline compiler rejects a convergence count inconsistent with the fresh Tree", () => {
  const input = fixture(true);
  input.facts.rootSnapshot.root.convergence.view.cycleCount = 0;

  assert.deepEqual(new DeadlineExceededCompilerImpl().compile({
    ...input, target: { kind: "conclude_deadline_exceeded_cycle", cycleIssueId: "cycle-1" },
  }), { kind: "invalid_facts", reason: "topology_invalid" });
});

function fixture(withActiveCycle: boolean): { facts: RootBootstrap; view: RootReconciliationView } {
  const rootFact: RootFactIssue = {
    issueId: "root-1", issueKind: "root", title: "Root", description: "Keep this requirement unchanged.",
    status: "In Progress", order: 0, isArchived: false, labels: ["symphony:kind/root"],
    remoteVersion: "root-v1", createdAt: "2026-07-28T00:00:00Z",
  };
  const cycleFact: RootFactIssue = {
    issueId: "cycle-1", issueKind: "cycle", parentIssueId: "root-1", title: "Cycle 1",
    description: "Current Cycle", status: "Planning", order: 0, isArchived: false,
    labels: ["symphony:kind/cycle"], remoteVersion: "cycle-v1", createdAt: "2026-07-28T01:00:00Z",
  };
  const convergence = {
    policy: {
      maxCyclesPerRoot: 3, maxSameOpenFindingCycles: 2, maxCycleRepairAttempts: 2, deadlineAt: "2026-07-29T12:00:00Z",
    },
    view: {
      cycleCount: withActiveCycle ? 1 : 0, openFindingPersistence: [], ...(withActiveCycle ? { activeCycleIssueId: "cycle-1" } : {}),
      activeCycleRepairAttempts: 0, isDeadlineExceeded: true, rootIsCanceled: false,
    },
  };
  const facts: RootBootstrap = {
    rootSnapshot: {
      root: {
        issue: rootFact, objective: "Objective", scope: "Scope", acceptanceCriteria: [], constraints: [],
        rootStatus: "In Progress", convergence,
      },
      cycles: withActiveCycle ? [{
        cycleIssue: cycleFact, cycleStatus: "Planning", isArchived: false, issues: [], relations: [],
      }] : [],
      issues: withActiveCycle ? [rootFact, cycleFact] : [rootFact],
      relations: [], attachments: [], activities: [], userComments: [], userCommentThreadStates: [],
      worktreeGate: {
        kind: "recoverable_missing", repositoryIdentity: "repo-1", generationOrdinal: 1,
        branch: "run-1", headRevision: "head-1",
      },
      mechanicalViolations: [],
    },
    sourceManifest: [], coverage: { isComplete: true, omissions: [] }, rootDigest: "digest-1", pendingInputIds: [],
  };
  const rootIssue = issue("root-1", "root", undefined, "In Progress", "started", "progress", rootFact.description, rootFact.labels);
  const cycleIssue = issue("cycle-1", "cycle", "root-1", "Planning", "started", "planning", cycleFact.description, cycleFact.labels);
  const view: RootReconciliationView = {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress",
      updatedAt: "2026-07-29T13:00:00Z", projectId: "project-1",
      priority: "normal", blockers: [], rootConductorLabels: [], isDelegatedToSymphony: true, isArchived: false,
    },
    tree: {
      root_issue_id: "root-1",
      status_catalog: [
        { status_id: "progress", name: "In Progress", category: "started", position: 1 },
        { status_id: "planning", name: "Planning", category: "started", position: 2 },
        { status_id: "canceled", name: "Canceled", category: "canceled", position: 3 },
      ],
      issues: withActiveCycle ? [rootIssue, cycleIssue] : [rootIssue], comments: [], relations: [],
      attachments: [], activities: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
      observed_at: "2026-07-29T13:00:00Z",
    },
    worktreeGate: {
      kind: "recoverable_missing", repositoryIdentity: "repo-1", generationOrdinal: 1,
      branch: "run-1", headRevision: "head-1",
    },
    observedAt: "2026-07-29T13:00:00Z", treeDigest: "tree-v1", complete: true,
  };
  return { facts, view };
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle",
  parentIssueId: string | undefined,
  statusName: "In Progress" | "Planning",
  statusCategory: "started",
  statusId: string,
  description: string,
  labels: string[],
): RootReconciliationView["tree"]["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId, project_id: "project-1",
    ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId, status_name: statusName, status_category: statusCategory, status_position: 1,
    order: 0, depth: parentIssueId ? 1 : 0, title: issueId, description, labels, is_archived: false,
    issue_kind: issueKind, remote_version: issueKind === "root" ? "root-v1" : "cycle-v1",
    created_at: "2026-07-28T00:00:00Z",
    updated_at: "2026-07-29T00:00:00Z",
  };
}
