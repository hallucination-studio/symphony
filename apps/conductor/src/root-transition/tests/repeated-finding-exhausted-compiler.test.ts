import assert from "node:assert/strict";
import test from "node:test";

import type { RootBootstrap, RootFactIssue, RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { RepeatedFindingExhaustedCycleCompilerImpl } from "../internal/RepeatedFindingExhaustedCycleCompilerImpl.js";

type Target = Extract<RootMechanicalTarget, { kind: "conclude_repeated_finding_exhausted_cycle" }>;

test("a repeated open Finding limit compiles one Cycle effect and preserves Finding facts", () => {
  const input = fixture();
  const findingsBefore = structuredClone(input.view.tree.issues.filter(({ issue_kind }) => issue_kind === "finding"));

  const result = new RepeatedFindingExhaustedCycleCompilerImpl().compile(input);

  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "update_workflow_issue");
  if (result.command.kind !== "update_workflow_issue") return;
  assert.equal(result.command.target.targetIssueId, "cycle-2");
  assert.equal(result.command.statusId, "canceled");
  assert.deepEqual(result.command.labelNames, ["Recovery Exhausted", "symphony:kind/cycle"]);
  assert.match(result.command.description, /same open Finding persisted through the configured Cycle limit/u);
  assert.deepEqual(input.view.tree.issues.filter(({ issue_kind }) => issue_kind === "finding"), findingsBefore);
});

test("repeated Finding exhaustion rejects a false persistence snapshot", () => {
  const input = fixture();
  input.facts.rootSnapshot.root.convergence.view.openFindingPersistence = [{
    findingId: "finding-2", openCycleCount: 3,
  }];

  assert.deepEqual(new RepeatedFindingExhaustedCycleCompilerImpl().compile(input), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});

test("repeated Finding exhaustion rejects a reversed native lineage", () => {
  const input = fixture();
  const relation = input.view.tree.relations[0]!;
  [relation.source_issue_id, relation.target_issue_id] = [relation.target_issue_id, relation.source_issue_id];

  assert.deepEqual(new RepeatedFindingExhaustedCycleCompilerImpl().compile(input), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});

test("repeated Finding exhaustion rejects a stale active Cycle version", () => {
  const input = fixture();
  input.facts.rootSnapshot.cycles[1]!.cycleIssue.remoteVersion = "cycle-2-v0";

  assert.deepEqual(new RepeatedFindingExhaustedCycleCompilerImpl().compile(input), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});

test("repeated Finding exhaustion relies on complete native topology when Linear exposes unknown actors", () => {
  const input = fixture();
  for (const source of input.view.tree.source_manifest) source.actor_kind = "unknown";

  assert.equal(new RepeatedFindingExhaustedCycleCompilerImpl().compile(input).kind, "effect");
});

function fixture(): { target: Target; facts: RootBootstrap; view: RootReconciliationView } {
  const rootFact = fact("root-1", "root", undefined, "In Progress", false, "2026-07-27T00:00:00Z");
  const oldCycleFact = fact("cycle-1", "cycle", "root-1", "Canceled", true, "2026-07-28T00:00:00Z");
  const cycleFact = fact("cycle-2", "cycle", "root-1", "Verifying", false, "2026-07-29T00:00:00Z");
  const oldFindingFact = fact("finding-1", "finding", "cycle-1", "Todo", true, "2026-07-28T01:00:00Z");
  const findingFact = fact("finding-2", "finding", "cycle-2", "Todo", false, "2026-07-29T01:00:00Z");
  const convergence = {
    policy: {
      maxCyclesPerRoot: 3, maxSameOpenFindingCycles: 2, maxCycleRepairAttempts: 2, deadlineAt: "2026-07-30T00:00:00Z",
    },
    view: {
      cycleCount: 2, openFindingPersistence: [{ findingId: "finding-2", openCycleCount: 2 }],
      activeCycleIssueId: "cycle-2", activeCycleRepairAttempts: 1,
      isDeadlineExceeded: false, rootIsCanceled: false,
    },
  };
  const facts: RootBootstrap = {
    rootSnapshot: {
      root: {
        issue: rootFact, objective: "Objective", scope: "Scope", acceptanceCriteria: [], constraints: [],
        rootStatus: "In Progress", convergence,
      },
      cycles: [
        { cycleIssue: oldCycleFact, cycleStatus: "Canceled", isArchived: true, issues: [oldFindingFact], relations: [] },
        { cycleIssue: cycleFact, cycleStatus: "Verifying", isArchived: false, issues: [findingFact], relations: [] },
      ],
      issues: [rootFact, oldCycleFact, oldFindingFact, cycleFact, findingFact],
      relations: [{
        relationId: "finding-lineage-1", relationKind: "triggered_by",
        sourceIssueId: "finding-2", targetIssueId: "finding-1",
      }],
      attachments: [], activities: [], userComments: [], userCommentThreadStates: [],
      worktreeGate: {
        kind: "recoverable_missing", repositoryIdentity: "repo-1", generationOrdinal: 1,
        branch: "root-1", headRevision: "head-1",
      },
      mechanicalViolations: [],
    },
    sourceManifest: [], coverage: { isComplete: true, omissions: [] }, rootDigest: "digest-1", pendingInputIds: [],
  };
  const rawIssues = [
    issue(rootFact, "started", "progress", 0),
    issue(oldCycleFact, "canceled", "canceled", 1),
    issue(oldFindingFact, "unstarted", "todo", 2),
    issue(cycleFact, "started", "verifying", 1),
    issue(findingFact, "unstarted", "todo", 2),
  ];
  const view: RootReconciliationView = {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress",
      updatedAt: "2026-07-29T02:00:00Z", projectId: "project-1",
      priority: "normal", blockers: [], rootConductorLabels: [], isDelegatedToSymphony: true, isArchived: false,
    },
    tree: {
      root_issue_id: "root-1",
      status_catalog: [
        { status_id: "progress", name: "In Progress", category: "started", position: 1 },
        { status_id: "verifying", name: "Verifying", category: "started", position: 2 },
        { status_id: "todo", name: "Todo", category: "unstarted", position: 3 },
        { status_id: "canceled", name: "Canceled", category: "canceled", position: 4 },
      ],
      issues: rawIssues, comments: [], relations: [{
        relation_id: "finding-lineage-1", relation_kind: "triggered_by",
        source_issue_id: "finding-2", target_issue_id: "finding-1",
      }],
      attachments: [], activities: [], source_manifest: [
        ...rawIssues.map((entry) => ({
          source_kind: "linear_issue" as const, source_id: entry.issue_id,
          source_version: entry.remote_version, actor_kind: "symphony" as const,
        })),
        {
          source_kind: "linear_relation", source_id: "finding-lineage-1",
          source_version: "finding-lineage-v1", actor_kind: "symphony",
        },
      ],
      coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T02:00:00Z",
    },
    worktreeGate: {
      kind: "recoverable_missing", repositoryIdentity: "repo-1", generationOrdinal: 1,
      branch: "root-1", headRevision: "head-1",
    },
    observedAt: "2026-07-29T02:00:00Z", treeDigest: "tree-v1", complete: true,
  };
  return {
    target: {
      kind: "conclude_repeated_finding_exhausted_cycle", cycleIssueId: "cycle-2", findingIssueIds: ["finding-2"],
    },
    facts,
    view,
  };
}

function fact(
  issueId: string,
  issueKind: RootFactIssue["issueKind"],
  parentIssueId: string | undefined,
  status: RootFactIssue["status"],
  isArchived: boolean,
  createdAt: string,
): RootFactIssue {
  return {
    issueId, issueKind, ...(parentIssueId ? { parentIssueId } : {}), title: issueId,
    description: `${issueId} evidence`, status, order: 0, isArchived,
    labels: [`symphony:kind/${issueKind}`], remoteVersion: `${issueId}-v1`, createdAt,
  };
}

function issue(
  value: RootFactIssue,
  statusCategory: "unstarted" | "started" | "canceled",
  statusId: string,
  depth: number,
): RootReconciliationView["tree"]["issues"][number] {
  return {
    issue_id: value.issueId, identifier: value.issueId, project_id: "project-1",
    ...(value.parentIssueId ? { parent_issue_id: value.parentIssueId } : {}),
    status_id: statusId, status_name: value.status, status_category: statusCategory,
    status_position: 1, order: value.order, depth, title: value.title, description: value.description,
    labels: value.labels, is_archived: value.isArchived, issue_kind: value.issueKind,
    remote_version: value.remoteVersion, created_at: value.createdAt, updated_at: "2026-07-29T02:00:00Z",
  };
}
