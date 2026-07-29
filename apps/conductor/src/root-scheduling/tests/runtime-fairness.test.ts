import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { LinearRootConvergencePolicyImpl } from "../../root-reconciliation/internal/LinearRootConvergencePolicyImpl.js";
import { LinearRootSafetyPolicyImpl } from "../../root-reconciliation/internal/LinearRootSafetyPolicyImpl.js";
import {
  RootReconciliationRuntime,
  type RootReconciliationRuntimeDependencies,
} from "../../root-reconciliation/internal/RootReconciliationRuntime.js";
import { LinearPriorityRootSchedulingPolicyImpl } from "../internal/LinearPriorityRootSchedulingPolicyImpl.js";

test("one progressing Root cannot starve the next eligible Root in the same bounded cycle", async () => {
  const roots = [root("root-a", "2026-07-29T02:00:00Z"), root("root-b", "2026-07-29T01:00:00Z")];
  const trees = new Map(roots.map((candidate) => [candidate.issueId, tree(candidate.issueId)]));
  const treeReads: string[] = [];
  const summaryLeases: string[] = [];
  const runtime = new RootReconciliationRuntime({
    conductorId: "conductor", conductorShortHash: "abc123", repositoryIdentity: "repo", baseBranch: "main",
    linear: {
      async resolveProject() { return { kind: "resolved" as const, projectId: "project", conductorPool: [{ conductorShortHash: "abc123" }] }; },
      async readProjectRootIndexPage() { return { kind: "page" as const, page: { roots, hasNextPage: false } }; },
      async readWorkflowIssueTree(rootIssueId) { treeReads.push(rootIssueId); return structuredClone(trees.get(rootIssueId)!); },
      async mutateWorkflow() { throw new Error("mutation_unexpected"); },
    },
    scheduling: new LinearPriorityRootSchedulingPolicyImpl(),
    safety: new LinearRootSafetyPolicyImpl(),
    convergence: new LinearRootConvergencePolicyImpl({
      maxCyclesPerRoot: 3, maxSameOpenFindingCycles: 2, maxCycleRepairAttempts: 2,
    }, 86_400_000),
    git: {
      async inspectRootWorktreeGate({ rootIssueId }) {
        return {
          result: { kind: "valid" as const, repositoryIdentity: "repo", branch: `symphony/runs/${rootIssueId}`, headRevision: "head", isClean: true, changedPaths: [] },
          workspace: { branch: `symphony/runs/${rootIssueId}`, worktreePath: `/tmp/${rootIssueId}` },
          snapshot: { head: "head", branch: `symphony/runs/${rootIssueId}`, status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
        };
      },
      async readCommitUrl() { return "https://github.com/acme/repo/commit/head"; },
      async materializeRootWorkspace() { throw new Error("workspace_unexpected"); },
    },
    humanActions: {
      async materialize() { throw new Error("human_action_unexpected"); },
      async convergeRootSummary({ view }) {
        summaryLeases.push(view.root.issueId);
        return { kind: "materialized" as const, desiredStatus: "Needs Approval" as const };
      },
    },
    reconciler: {} as never, performer: {} as never, delivery: {} as never,
    remoteAcceptance: {} as never, replyWriter: {} as never,
    profileIdFor: async () => "profile",
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log() {},
  } satisfies RootReconciliationRuntimeDependencies);

  assert.equal(await runtime.cycle(), "progress");
  assert.deepEqual(treeReads, ["root-a", "root-b"]);
  assert.deepEqual(summaryLeases, ["root-a", "root-b"]);
});

test("Root cycle lease budget rotates across more eligible Roots than one cycle can admit", async () => {
  const fixture = fairnessRuntime(["a", "b", "c", "d", "e", "f"]);

  assert.equal(await fixture.runtime.cycle(), "progress");
  assert.deepEqual(fixture.summaryLeases, ["root-a", "root-b", "root-c", "root-d"]);

  fixture.summaryLeases.length = 0;
  assert.equal(await fixture.runtime.cycle(), "progress");
  assert.deepEqual(fixture.summaryLeases, ["root-e", "root-f", "root-a", "root-b"]);
});

test("Root scheduling cursor is discarded on runtime restart", async () => {
  const beforeRestart = fairnessRuntime(["a", "b", "c", "d", "e", "f"]);
  assert.equal(await beforeRestart.runtime.cycle(), "progress");
  assert.deepEqual(beforeRestart.summaryLeases, ["root-a", "root-b", "root-c", "root-d"]);

  const afterRestart = fairnessRuntime(["a", "b", "c", "d", "e", "f"]);
  assert.equal(await afterRestart.runtime.cycle(), "progress");
  assert.deepEqual(afterRestart.summaryLeases, ["root-a", "root-b", "root-c", "root-d"]);
});

function fairnessRuntime(names: string[]) {
  const roots = names.map((name, index) => root(`root-${name}`, new Date(Date.UTC(2026, 6, 29, 12, 0, -index)).toISOString()));
  const trees = new Map(roots.map((candidate) => [candidate.issueId, tree(candidate.issueId)]));
  const summaryLeases: string[] = [];
  const runtime = new RootReconciliationRuntime({
    conductorId: "conductor", conductorShortHash: "abc123", repositoryIdentity: "repo", baseBranch: "main",
    linear: {
      async resolveProject() { return { kind: "resolved" as const, projectId: "project", conductorPool: [{ conductorShortHash: "abc123" }] }; },
      async readProjectRootIndexPage() { return { kind: "page" as const, page: { roots, hasNextPage: false } }; },
      async readWorkflowIssueTree(rootIssueId) { return structuredClone(trees.get(rootIssueId)!); },
      async mutateWorkflow() { throw new Error("mutation_unexpected"); },
    },
    scheduling: new LinearPriorityRootSchedulingPolicyImpl(),
    safety: new LinearRootSafetyPolicyImpl(),
    convergence: new LinearRootConvergencePolicyImpl({ maxCyclesPerRoot: 3, maxSameOpenFindingCycles: 2, maxCycleRepairAttempts: 2 }, 86_400_000),
    git: {
      async inspectRootWorktreeGate({ rootIssueId }) {
        return {
          result: { kind: "valid" as const, repositoryIdentity: "repo", branch: `symphony/runs/${rootIssueId}`, headRevision: "head", isClean: true, changedPaths: [] },
          workspace: { branch: `symphony/runs/${rootIssueId}`, worktreePath: `/tmp/${rootIssueId}` },
          snapshot: { head: "head", branch: `symphony/runs/${rootIssueId}`, status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
        };
      },
      async readCommitUrl() { return "https://github.com/acme/repo/commit/head"; },
      async materializeRootWorkspace() { throw new Error("workspace_unexpected"); },
    },
    humanActions: {
      async materialize() { throw new Error("human_action_unexpected"); },
      async convergeRootSummary({ view }) {
        summaryLeases.push(view.root.issueId);
        return { kind: "materialized" as const, desiredStatus: "Needs Approval" as const };
      },
    },
    reconciler: {} as never, performer: {} as never, delivery: {} as never,
    remoteAcceptance: {} as never, replyWriter: {} as never,
    profileIdFor: async () => "profile",
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log() {},
  } satisfies RootReconciliationRuntimeDependencies);
  return { runtime, summaryLeases };
}

function root(issueId: string, updatedAt: string) {
  return {
    issueId, identifier: issueId.toUpperCase(), state: "In Progress" as const, title: issueId,
    description: issueId, updatedAt, projectId: "project", parentIssueId: null, priority: "normal" as const,
    order: 0, blockers: [], rootConductorLabels: [{ conductorShortHash: "abc123" }],
    isDelegatedToSymphony: true, isArchived: false,
  };
}

function tree(rootIssueId: string): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: rootIssueId,
    status_catalog: [{ status_id: "progress", name: "In Progress", category: "started", position: 1 }],
    issues: [{
      issue_id: rootIssueId, identifier: rootIssueId.toUpperCase(), project_id: "project",
      status_id: "progress", status_name: "In Progress", status_category: "started", status_position: 1,
      order: 0, depth: 0, title: rootIssueId, description: rootIssueId,
      labels: ["symphony:kind/root", "symphony:conductor/abc123"], is_archived: false, issue_kind: "root",
      remote_version: `${rootIssueId}-v1`, created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z",
    }],
    comments: [], relations: [], attachments: [], activities: [],
    source_manifest: [{ source_kind: "linear_issue", source_id: rootIssueId, source_version: `${rootIssueId}-v1`, actor_kind: "symphony" }],
    coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T03:00:00Z",
  };
}
