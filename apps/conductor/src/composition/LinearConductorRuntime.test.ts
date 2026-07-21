import assert from "node:assert/strict";
import test from "node:test";

import { LinearConductorRuntime } from "./ConductorRuntime.js";
import { LinearPriorityRootSchedulingPolicyImpl } from "../root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.js";
import { LinearCycleRootWorkflowPolicyImpl } from "../root-workflow/internal/LinearCycleRootWorkflowPolicyImpl.js";
import type { DiscoveredRoot } from "../root-workflow/api/Models.js";
import type { RootDagView } from "../root-workflow/api/RootWorkflowPolicyInterface.js";

test("Linear composition skips Waiting Human and dispatches the highest runnable Root", async () => {
  const roots = [root("waiting", "urgent", 1), root("run", "high", 2), root("later", "low", 3)];
  const started: string[] = [];
  const runtime = new LinearConductorRuntime(
    "conductor-1",
    gateway(roots, (rootId) => view(rootId, rootId === "waiting" ? "Needs Approval" : "In Progress")),
    new LinearPriorityRootSchedulingPolicyImpl(),
    new LinearCycleRootWorkflowPolicyImpl(),
    { async dispatch({ root }) { started.push(root.issueId); return "progress"; } },
    { async report() {} },
  );

  assert.equal(await runtime.cycle(), "progress");
  assert.deepEqual(started, ["run"]);
});

test("Linear composition releases a waiting lane without creating a queue entry", async () => {
  let dispatches = 0;
  const runtime = new LinearConductorRuntime(
    "conductor-1",
    gateway([root("waiting", "high", 1)], () => view("waiting", "Needs Info")),
    new LinearPriorityRootSchedulingPolicyImpl(),
    new LinearCycleRootWorkflowPolicyImpl(),
    { async dispatch() { dispatches += 1; return "progress"; } },
    { async report() {} },
  );

  assert.equal(await runtime.cycle(), "waiting-human");
  assert.equal(dispatches, 0);
});

function gateway(roots: DiscoveredRoot[], read: (rootId: string) => RootDagView) {
  return {
    async resolveProject() { return { kind: "resolved" as const, projectId: "project-1" }; },
    async listRoots() { return roots; },
    async readRootDag(rootId: string) { return read(rootId); },
  };
}

function root(issueId: string, priority: DiscoveredRoot["priority"], order: number): DiscoveredRoot {
  return {
    issueId, identifier: issueId.toUpperCase(), state: "In Progress", title: issueId, description: "",
    updatedAt: "2026-07-21T09:00:00Z", projectId: "project-1", parentIssueId: null,
    isDelegatedToSymphony: true, managedConductorId: "conductor-1", priority, order, blockers: [],
  };
}

function view(rootId: string, status: "In Progress" | "Needs Approval" | "Needs Info"): RootDagView {
  return {
    root: { issue: {
      issue_id: rootId, identifier: rootId.toUpperCase(), project_id: "project-1", status_id: `status-${status}`,
      status_name: status, status_category: status === "In Progress" ? "started" : "started", status_position: 1,
      order: 0, depth: 0, title: rootId, description: "", remote_version: "version-1", updated_at: "2026-07-21T09:00:00Z",
    }, records: [] },
    statusCatalog: [], cycles: [], relations: [],
    git: { head: "abc123", branch: `symphony/runs/${rootId}`, status: { items: [], returned: 0, cap: 512, has_more: false, partial: false } },
    observedAt: "2026-07-21T09:00:00Z",
  };
}
