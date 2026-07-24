import assert from "node:assert/strict";
import test from "node:test";

import type { RootOwnershipClaimResult } from "../../root-discovery/api/RootOwnershipClaimInterface.js";
import type { RootReconciliationRuntimeDependencies } from "../internal/RootReconciliationRuntime.js";
import { RootReconciliationRuntime } from "../internal/RootReconciliationRuntime.js";

test("Root reconciliation drops a failed session and opens a fresh one next cycle", async () => {
  const root = {
    issueId: "root-1",
    identifier: "SYM-1",
    state: "Todo" as const,
    title: "Root",
    description: "Root objective",
    updatedAt: "2026-07-23T00:00:00Z",
    projectId: "project-1",
    parentIssueId: null,
    isDelegatedToSymphony: true,
    priority: "normal" as const,
    order: 1,
    blockers: [],
    rootConductorLabels: [],
  };
  const tree = {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "todo", name: "Todo", category: "unstarted" as const, position: 1 }],
    issues: [{
      issue_id: "root-1",
      identifier: "SYM-1",
      project_id: "project-1",
      status_id: "todo",
      status_name: "Todo",
      status_category: "unstarted" as const,
      status_position: 1,
      order: 1,
      depth: 0,
      title: "Root",
      description: "Root objective",
      labels: [],
      is_archived: false,
      issue_kind: "root" as const,
      remote_version: "root-v1",
      updated_at: "2026-07-23T00:00:00Z",
    }],
    comments: [],
    relations: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-23T00:00:00Z",
  };
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  let opened = 0;
  const dependencies = {
    conductorId: "conductor-1",
    conductorShortHash: "abc123",
    baseBranch: "main",
    linear: {
      async resolveProject() { return { kind: "resolved" as const, projectId: "project-1", conductorPool: [] }; },
      async listRoots() { return [root]; },
      async readWorkflowIssueTree() { return tree; },
      async mutateWorkflow() { return { kind: "failed" as const, code: "unused", summary: "unused" }; },
    },
    git: {
      async ensureWorkspace() { return { branch: "symphony/runs/sym-1", worktreePath: "/tmp/symphony-root-1" }; },
      async inspect() { return { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } }; },
    },
    ownership: {
      async claim() {
        return {
          kind: "already_owned" as const,
          ownership: {} as never,
          workspace: { branch: "symphony/runs/sym-1", worktreePath: "/tmp/symphony-root-1" },
        } satisfies RootOwnershipClaimResult;
      },
    },
    scheduling: {
      evaluate() { return { orderedEligible: [root], blocked: [] }; },
      strictlyOutranksBoundary() { return false; },
    },
    invariants: { validate() { return { kind: "valid" as const }; } },
    reconciler: {
      async open() { opened += 1; return { kind: "opened" as const, sessionId: `session-${opened}` }; },
      async advance() { throw new Error("performer_agent_process_exited"); },
      async close() {},
    },
    performer: {} as never,
    materializer: {} as never,
    profileIdFor: async () => "profile-1",
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log(event: string, fields: Record<string, string>) { logs.push({ event, fields }); },
  } satisfies RootReconciliationRuntimeDependencies;

  const runtime = new RootReconciliationRuntime(dependencies);
  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(opened, 2);
  assert.deepEqual(logs.filter(({ event }) => event === "root_reconciliation_failed").map(({ fields }) => fields.reason), [
    "performer_agent_process_exited",
    "performer_agent_process_exited",
  ]);
});
