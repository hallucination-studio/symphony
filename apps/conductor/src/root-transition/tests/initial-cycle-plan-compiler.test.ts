import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootBootstrap,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { InitialCyclePlanCompilerImpl } from "../internal/InitialCyclePlanCompilerImpl.js";
import { mechanicalWriteId } from "../internal/MechanicalWriteId.js";

test("compiles one initial Cycle effect, then one Plan effect, then satisfaction", () => {
  const compiler = new InitialCyclePlanCompilerImpl();

  const empty = fixture();
  assert.deepEqual(compiler.compile(empty), {
    kind: "effect",
    command: {
      kind: "create_workflow_issue",
      writeId: mechanicalWriteId(["root-1", "initial-cycle"]),
      expectedProjectId: "project-1",
      rootIssueId: "root-1",
      expectedRootRemoteVersion: "root-v1",
      parentExpectedRemoteVersion: "root-v1",
      parentExpectedStatusId: "root-progress",
      parentIssueId: "root-1",
      title: "Cycle 1",
      description: "Requirement",
      statusId: "cycle-planning",
      labelNames: ["symphony:kind/cycle"],
    },
  });

  const partial = fixture({ withCycle: true });
  assert.deepEqual(compiler.compile(partial), {
    kind: "effect",
    command: {
      kind: "create_workflow_issue",
      writeId: mechanicalWriteId(["root-1", "initial-plan"]),
      expectedProjectId: "project-1",
      rootIssueId: "root-1",
      expectedRootRemoteVersion: "root-v1",
      parentExpectedRemoteVersion: "cycle-v1",
      parentExpectedStatusId: "cycle-planning",
      parentIssueId: "cycle-1",
      title: "Plan",
      description: [
        "# Plan Goal",
        "",
        "Requirement",
        "",
        "## Requested Scope",
        "",
        "Root",
        "",
        "## Acceptance And Verification",
        "",
        "- Requirement (test)",
      ].join("\n"),
      statusId: "todo",
      labelNames: ["symphony:kind/plan"],
    },
  });

  assert.deepEqual(compiler.compile(fixture({ withCycle: true, withPlan: true })), { kind: "satisfied" });
});

test("fails closed on stale target, missing statuses and non-initial topology", () => {
  const compiler = new InitialCyclePlanCompilerImpl();

  const stale = fixture();
  stale.target.expectedWorktreeGate.headRevision = "stale-head";
  assert.deepEqual(compiler.compile(stale), { kind: "invalid_facts", reason: "target_stale" });

  const missingStatus = fixture();
  missingStatus.view.tree.status_catalog = missingStatus.view.tree.status_catalog.filter(({ name }) => name !== "Planning");
  assert.deepEqual(compiler.compile(missingStatus), { kind: "invalid_facts", reason: "status_catalog_invalid" });

  const wrongCycle = fixture({ withCycle: true });
  wrongCycle.view.tree.issues[1]!.status_name = "Executing";
  assert.deepEqual(compiler.compile(wrongCycle), { kind: "invalid_facts", reason: "topology_invalid" });

  const duplicatePlan = fixture({ withCycle: true, withPlan: true });
  duplicatePlan.view.tree.issues.push({
    ...duplicatePlan.view.tree.issues[2]!,
    issue_id: "plan-2",
    identifier: "SYM-4",
    remote_version: "plan-v2",
  });
  assert.deepEqual(compiler.compile(duplicatePlan), { kind: "invalid_facts", reason: "topology_invalid" });
});

function fixture(input: { withCycle?: boolean; withPlan?: boolean } = {}): {
  target: {
    kind: "converge_initial_cycle_plan";
    expectedWorktreeGate: Extract<RootReconciliationView["worktreeGate"], { kind: "valid" }>;
  };
  facts: RootBootstrap;
  view: RootReconciliationView;
} {
  const worktreeGate = {
    kind: "valid" as const,
    repositoryIdentity: "repo-1",
    branch: "root-1",
    headRevision: "head-1",
    isClean: true,
    changedPaths: [],
  };
  const root = issue("root-1", "SYM-1", "root", undefined, "root-progress", "In Progress", "root-v1", "Root", "Requirement", 0);
  const cycle = issue("cycle-1", "SYM-2", "cycle", "root-1", "cycle-planning", "Planning", "cycle-v1", "Cycle 1", "Requirement", 1);
  const plan = issue("plan-1", "SYM-3", "plan", "cycle-1", "todo", "Todo", "plan-v1", "Plan", "Plan", 2);
  const issues = [root, ...(input.withCycle ? [cycle] : []), ...(input.withPlan ? [plan] : [])];
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "root-progress", name: "In Progress", category: "started", position: 1 },
      { status_id: "cycle-planning", name: "Planning", category: "started", position: 2 },
      { status_id: "todo", name: "Todo", category: "unstarted", position: 3 },
    ],
    issues,
    comments: [],
    relations: [],
    attachments: [],
    activities: [],
    source_manifest: issues.map(({ issue_id, remote_version }) => ({
      source_kind: "linear_issue" as const,
      source_id: issue_id,
      source_version: remote_version,
      actor_kind: "unknown" as const,
    })),
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-29T00:00:00Z",
  };
  const view: RootReconciliationView = {
    root: {
      issueId: "root-1",
      identifier: "SYM-1",
      state: "In Progress",
      updatedAt: "2026-07-29T00:00:00Z",
      projectId: "project-1",
      priority: "normal",
      blockers: [],
      rootConductorLabels: [{ conductorShortHash: "abc123" }],
      isDelegatedToSymphony: true,
      isArchived: false,
    },
    tree,
    worktreeGate,
    workspace: { branch: "root-1", worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
    git: { head: "head-1", branch: "root-1", status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt: tree.observed_at,
    treeDigest: "digest-1",
    complete: true,
  };
  const factIssues = issues.map((item) => ({
    issueId: item.issue_id,
    issueKind: item.issue_kind!,
    ...(item.parent_issue_id ? { parentIssueId: item.parent_issue_id } : {}),
    title: item.title,
    description: item.description,
    status: item.status_name as "In Progress" | "Planning" | "Todo",
    order: item.order,
    isArchived: false,
    labels: item.labels,
    remoteVersion: item.remote_version,
    createdAt: item.created_at,
  }));
  const facts: RootBootstrap = {
    rootSnapshot: {
      root: {
        issue: factIssues[0]!,
        objective: "Requirement",
        scope: "Root",
        acceptanceCriteria: [{ criterionKey: "criterion-1", statement: "Requirement", verificationMethod: "test" }],
        constraints: [],
        rootStatus: "In Progress",
        convergence: {
          policy: { maxCyclesPerRoot: 3, maxSameOpenFindingCycles: 2, maxCycleRepairAttempts: 2, deadlineAt: "2026-07-30T00:00:00Z" },
          view: { cycleCount: input.withCycle ? 1 : 0, openFindingPersistence: [], activeCycleRepairAttempts: 0, isDeadlineExceeded: false, rootIsCanceled: false, ...(input.withCycle ? { activeCycleIssueId: "cycle-1" } : {}) },
        },
      },
      cycles: input.withCycle ? [{ cycleIssue: factIssues[1]!, cycleStatus: "Planning", isArchived: false, issues: input.withPlan ? [factIssues[2]!] : [], relations: [] }] : [],
      issues: factIssues,
      relations: [], attachments: [], activities: [], userComments: [], userCommentThreadStates: [],
      worktreeGate, mechanicalViolations: [],
    },
    sourceManifest: factIssues.map(({ issueId, remoteVersion }) => ({ sourceKind: "issue", sourceId: issueId, sourceVersionOrDigest: remoteVersion, actorKind: "unknown" })),
    coverage: { isComplete: true, omissions: [] },
    rootDigest: "digest-1",
    pendingInputIds: [],
  };
  return {
    target: { kind: "converge_initial_cycle_plan", expectedWorktreeGate: structuredClone(worktreeGate) },
    facts,
    view,
  };
}

function issue(
  issueId: string,
  identifier: string,
  kind: "root" | "cycle" | "plan",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: "In Progress" | "Planning" | "Todo" | "Executing",
  remoteVersion: string,
  title: string,
  description: string,
  depth: number,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId, status_name: statusName, status_category: statusName === "Todo" ? "unstarted" : "started",
    status_position: depth + 1, order: depth, depth, title, description,
    labels: kind === "root" ? [] : [`symphony:kind/${kind}`], is_archived: false, issue_kind: kind,
    remote_version: remoteVersion, created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z",
  };
}
