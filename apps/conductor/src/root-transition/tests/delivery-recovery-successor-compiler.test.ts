import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { buildRootFactSet } from "../../root-reconciliation/internal/RootFactSet.js";
import { AuthorizedSuccessorCompilerImpl } from "../internal/AuthorizedSuccessorCompilerImpl.js";

test("delivery recovery resumes the Root before archiving successful history", () => {
  const input = fixture({ rootStatus: "In Review" });

  const result = new AuthorizedSuccessorCompilerImpl().compile(input);

  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "update_workflow_issue");
  if (result.command.kind !== "update_workflow_issue") return;
  assert.equal(result.command.target.targetIssueId, "root-1");
  assert.equal(result.command.statusId, "root-progress");
});

test("delivery recovery archives the deepest predecessor descendant first and the Cycle last", () => {
  const withDescendants = fixture({ rootStatus: "In Progress" });
  const leafResult = new AuthorizedSuccessorCompilerImpl().compile(withDescendants);
  assert.equal(leafResult.kind, "effect");
  if (leafResult.kind !== "effect") return;
  assert.equal(leafResult.command.kind, "set_workflow_issue_archive_state");
  if (leafResult.command.kind !== "set_workflow_issue_archive_state") return;
  assert.equal(leafResult.command.target.targetIssueId, "verify-1");

  const afterDescendants = fixture({ rootStatus: "In Progress", predecessorDescendantsArchived: true });
  const cycleResult = new AuthorizedSuccessorCompilerImpl().compile(afterDescendants);
  assert.equal(cycleResult.kind, "effect");
  if (cycleResult.kind !== "effect") return;
  assert.equal(cycleResult.command.kind, "set_workflow_issue_archive_state");
  if (cycleResult.command.kind !== "set_workflow_issue_archive_state") return;
  assert.equal(cycleResult.command.target.targetIssueId, "cycle-1");
});

test("delivery recovery creates exactly one Todo Plan after predecessor archive and then is satisfied", () => {
  const beforePlan = fixture({
    rootStatus: "In Progress",
    predecessorDescendantsArchived: true,
    predecessorArchived: true,
  });
  const createResult = new AuthorizedSuccessorCompilerImpl().compile(beforePlan);
  assert.equal(createResult.kind, "effect");
  if (createResult.kind !== "effect") return;
  assert.equal(createResult.command.kind, "create_workflow_issue");
  if (createResult.command.kind !== "create_workflow_issue") return;
  assert.equal(createResult.command.parentIssueId, "cycle-2");
  assert.equal(createResult.command.statusId, "todo");
  assert.equal(createResult.command.description, "Recover delivery without weakening the Root requirement.");

  const afterPlan = fixture({
    rootStatus: "In Progress",
    predecessorDescendantsArchived: true,
    predecessorArchived: true,
    withPlan: true,
  });
  assert.deepEqual(new AuthorizedSuccessorCompilerImpl().compile(afterPlan), { kind: "satisfied" });
});

test("delivery recovery rejects a successor without exact Symphony authorship", () => {
  const input = fixture({ rootStatus: "In Progress", successorActor: "human" });

  assert.deepEqual(new AuthorizedSuccessorCompilerImpl().compile(input), {
    kind: "invalid_facts",
    reason: "topology_invalid",
  });
});

test("delivery recovery rejects a target that skips the canonical predecessor", () => {
  const input = fixture({ rootStatus: "In Progress", withOlderSucceededCycle: true });
  input.target.predecessorCycleIssueId = "cycle-0";

  assert.deepEqual(new AuthorizedSuccessorCompilerImpl().compile(input), {
    kind: "invalid_facts",
    reason: "target_stale",
  });
});

test("delivery recovery compiles from the Root review actor chain", () => {
  const input = productionDeliveryFixture();

  assert.equal(new AuthorizedSuccessorCompilerImpl().compile(input).kind, "effect");

  input.view.tree.issues.find(({ issue_id }) => issue_id === "cycle-2")!.creator_user_id = "human-1";
  assert.deepEqual(new AuthorizedSuccessorCompilerImpl().compile(input), {
    kind: "invalid_facts",
    reason: "topology_invalid",
  });
});

function productionDeliveryFixture() {
  const input = fixture({ rootStatus: "In Review" });
  const root = input.view.tree.issues.find(({ issue_id }) => issue_id === "root-1")!;
  const successor = input.view.tree.issues.find(({ issue_id }) => issue_id === "cycle-2")!;
  successor.creator_user_id = "symphony-actor";
  input.view.tree.source_manifest.find(({ source_id }) => source_id === successor.issue_id)!.actor_kind = "unknown";
  input.view.tree.activities.push({
    activity_id: "activity-root-review", issue_id: root.issue_id,
    activity_kinds: ["status_changed"], actor_kind: "symphony", actor_id: "symphony-actor",
    to_state_id: root.status_id, remote_version: "activity-root-review-v1",
    created_at: "2026-07-29T00:00:01Z",
  });
  return input;
}

test("terminal review successor compiles from the successful Cycle actor chain", () => {
  const input = productionTerminalReviewFixture();

  assert.equal(new AuthorizedSuccessorCompilerImpl().compile(input).kind, "effect");

  const successor = input.view.tree.issues.find(({ issue_id }) => issue_id === "cycle-2")!;
  successor.creator_user_id = "human-1";
  assert.deepEqual(new AuthorizedSuccessorCompilerImpl().compile(input), {
    kind: "invalid_facts",
    reason: "topology_invalid",
  });
  successor.creator_user_id = "symphony-actor";
  input.view.tree.activities.push({
    activity_id: "activity-successor-human-edit", issue_id: successor.issue_id,
    activity_kinds: ["description_changed"], actor_kind: "human", actor_id: "human-1",
    updated_description: "Human changed successor", remote_version: "activity-successor-human-edit-v1",
    created_at: "2026-07-29T00:00:02Z",
  });
  assert.deepEqual(new AuthorizedSuccessorCompilerImpl().compile(input), {
    kind: "invalid_facts",
    reason: "topology_invalid",
  });
});

function productionTerminalReviewFixture() {
  const input = fixture({ rootStatus: "In Progress" });
  Object.assign(input.target, { authorizationKind: "terminal_review" as const });
  const predecessor = input.view.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  const successor = input.view.tree.issues.find(({ issue_id }) => issue_id === "cycle-2")!;
  successor.labels = ["Terminal Review Successor", "symphony:kind/cycle"];
  successor.creator_user_id = "symphony-actor";
  input.view.tree.source_manifest.find(({ source_id }) => source_id === successor.issue_id)!.actor_kind = "unknown";
  input.view.tree.activities.push({
    activity_id: "activity-cycle-succeeded", issue_id: predecessor.issue_id,
    activity_kinds: ["status_changed"], actor_kind: "symphony", actor_id: "symphony-actor",
    to_state_id: predecessor.status_id, remote_version: "activity-cycle-succeeded-v1",
    created_at: "2026-07-29T00:00:01Z",
  });
  return input;
}

test("interrupted Stage recovery compiles from the interrupted Stage actor chain", () => {
  const input = stageRecoveryFixture();

  const result = new AuthorizedSuccessorCompilerImpl().compile(input);

  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "set_workflow_issue_archive_state");
  if (result.command.kind !== "set_workflow_issue_archive_state") return;
  assert.equal(result.command.target.targetIssueId, "verify-1");
});

test("interrupted Stage recovery rejects a successor created by another actor", () => {
  const input = stageRecoveryFixture();
  input.view.tree.issues.find(({ issue_id }) => issue_id === "cycle-2")!.creator_user_id = "human-1";

  assert.deepEqual(new AuthorizedSuccessorCompilerImpl().compile(input), {
    kind: "invalid_facts",
    reason: "topology_invalid",
  });
});

test("interrupted Stage recovery rejects a later human successor edit", () => {
  const input = stageRecoveryFixture();
  input.view.tree.activities.push({
    activity_id: "activity-successor-human-edit", issue_id: "cycle-2",
    activity_kinds: ["description_changed"], actor_kind: "human", actor_id: "human-1",
    updated_description: "Human changed successor", remote_version: "activity-successor-human-edit-v1",
    created_at: "2026-07-29T00:00:02Z",
  });

  assert.deepEqual(new AuthorizedSuccessorCompilerImpl().compile(input), {
    kind: "invalid_facts",
    reason: "topology_invalid",
  });
});

function stageRecoveryFixture() {
  const input = fixture({ rootStatus: "In Progress" });
  Object.assign(input.target, { authorizationKind: "stage_recovery" as const });
  const predecessor = input.view.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  Object.assign(predecessor, { status_id: "executing", status_name: "Executing", status_category: "started" });
  const source = input.view.tree.issues.find(({ issue_id }) => issue_id === "work-1")!;
  Object.assign(source, { status_id: "interrupted", status_name: "Interrupted", status_category: "canceled" });
  const successor = input.view.tree.issues.find(({ issue_id }) => issue_id === "cycle-2")!;
  successor.labels = ["Interrupted Stage Recovery", "symphony:kind/cycle"];
  successor.creator_user_id = "symphony-actor";
  input.view.tree.source_manifest.find(({ source_id }) => source_id === successor.issue_id)!.actor_kind = "unknown";
  input.view.tree.activities.push({
    activity_id: "activity-work-interrupted", issue_id: source.issue_id,
    activity_kinds: ["status_changed"], actor_kind: "symphony", actor_id: "symphony-actor",
    to_state_id: source.status_id, remote_version: "activity-work-interrupted-v1",
    created_at: "2026-07-29T00:00:01Z",
  });
  return input;
}

function fixture(input: {
  rootStatus: "In Review" | "In Progress";
  predecessorDescendantsArchived?: boolean;
  predecessorArchived?: boolean;
  withPlan?: boolean;
  successorActor?: "symphony" | "human";
  withOlderSucceededCycle?: boolean;
}) {
  const root = issue("root-1", "root", undefined, input.rootStatus === "In Review" ? "review" : "root-progress", input.rootStatus, 0,
    "2026-07-28T00:00:00Z");
  const older = issue("cycle-0", "cycle", "root-1", "succeeded", "Succeeded", 1, "2026-07-28T01:00:00Z");
  const predecessor = issue("cycle-1", "cycle", "root-1", "succeeded", "Succeeded", 1, "2026-07-28T02:00:00Z");
  predecessor.is_archived = input.predecessorArchived ?? false;
  const plan = issue("plan-1", "plan", "cycle-1", "done", "Done", 2, "2026-07-28T03:00:00Z");
  const work = issue("work-1", "work", "cycle-1", "done", "Done", 2, "2026-07-28T04:00:00Z");
  const verify = issue("verify-1", "verify", "work-1", "done", "Done", 3, "2026-07-28T05:00:00Z");
  for (const descendant of [plan, work, verify]) {
    descendant.is_archived = input.predecessorDescendantsArchived ?? false;
  }
  const successor = issue("cycle-2", "cycle", "root-1", "planning", "Planning", 1, "2026-07-29T00:00:00Z");
  successor.labels = ["Delivery Recovery", "symphony:kind/cycle"];
  successor.description = "Recover delivery without weakening the Root requirement.";
  const successorPlan = issue("plan-2", "plan", "cycle-2", "todo", "Todo", 2, "2026-07-29T01:00:00Z");
  const issues = [
    root,
    ...(input.withOlderSucceededCycle ? [older] : []),
    predecessor,
    plan,
    work,
    verify,
    successor,
    ...(input.withPlan ? [successorPlan] : []),
  ];
  if (input.withOlderSucceededCycle) older.is_archived = true;
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "root-progress", name: "In Progress", category: "started", position: 1 },
      { status_id: "review", name: "In Review", category: "started", position: 2 },
      { status_id: "planning", name: "Planning", category: "started", position: 3 },
      { status_id: "todo", name: "Todo", category: "unstarted", position: 4 },
      { status_id: "done", name: "Done", category: "completed", position: 5 },
      { status_id: "succeeded", name: "Succeeded", category: "completed", position: 6 },
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
      actor_kind: issue_id === "cycle-2" ? input.successorActor ?? "symphony" : "unknown",
    })),
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-29T02:00:00Z",
  };
  const worktreeGate = {
    kind: "valid" as const,
    repositoryIdentity: "repo-1",
    branch: "symphony/runs/sym-1-g1",
    headRevision: "head-1",
    isClean: true,
    changedPaths: [],
  };
  const discoveredRoot = {
    issueId: "root-1",
    identifier: "SYM-1",
    state: input.rootStatus,
    updatedAt: tree.observed_at,
    projectId: "project-1",
    priority: "normal" as const,
    blockers: [],
    rootConductorLabels: [],
    isDelegatedToSymphony: true,
    isArchived: false,
  };
  const factSet = buildRootFactSet({
    root: discoveredRoot,
    tree,
    worktreeGate,
    mechanicalViolations: [],
    convergence: {
      policy: {
        maxCyclesPerRoot: 4,
        maxSameOpenFindingCycles: 2,
        maxCycleRepairAttempts: 2,
        deadlineAt: "2026-07-30T00:00:00Z",
      },
      view: {
        cycleCount: input.withOlderSucceededCycle ? 3 : 2,
        openFindingPersistence: [],
        activeCycleRepairAttempts: 0,
        isDeadlineExceeded: false,
        rootIsCanceled: false,
        activeCycleIssueId: "cycle-2",
      },
    },
  });
  const view: RootReconciliationView = {
    root: discoveredRoot,
    tree,
    worktreeGate,
    workspace: { branch: worktreeGate.branch, worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
    git: {
      head: "head-1",
      branch: worktreeGate.branch,
      status: { items: [], returned: 0, cap: 16, has_more: false, partial: false },
    },
    observedAt: tree.observed_at,
    treeDigest: factSet.bootstrap.rootDigest,
    complete: true,
  };
  return {
    target: {
      kind: "converge_authorized_successor" as const,
      authorizationKind: "delivery_recovery" as const,
      predecessorCycleIssueId: "cycle-1",
      successorCycleIssueId: "cycle-2",
      expectedWorktreeGate: structuredClone(worktreeGate),
    },
    facts: factSet.bootstrap,
    view,
  };
}

function issue(
  issueId: string,
  kind: "root" | "cycle" | "plan" | "work" | "verify",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: "In Review" | "In Progress" | "Planning" | "Todo" | "Done" | "Succeeded",
  depth: number,
  createdAt: string,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId,
    identifier: `SYM-${issueId}`,
    project_id: "project-1",
    ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId,
    status_name: statusName,
    status_category: ["Done", "Succeeded"].includes(statusName) ? "completed" : "started",
    status_position: 1,
    order: 0,
    depth,
    title: kind === "root" ? "Root" : kind === "cycle" ? "Cycle" : kind,
    description: "Description",
    labels: [`symphony:kind/${kind}`],
    is_archived: false,
    issue_kind: kind,
    remote_version: `${issueId}-v1`,
    created_at: createdAt,
    updated_at: createdAt,
  };
}
