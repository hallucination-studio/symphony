import assert from "node:assert/strict";
import test from "node:test";

import { LinearRootInvariantPolicyImpl } from "../internal/LinearRootInvariantPolicyImpl.js";
import type { DiscoveredRoot } from "../api/RootModels.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";

const policy = new LinearRootInvariantPolicyImpl();

test("root invariant policy accepts one complete active root tree", () => {
  const root = discoveredRoot();
  assert.deepEqual(policy.validate({ root, tree: tree(root) }), { kind: "valid" });
});

test("root invariant policy blocks duplicate active cycles", () => {
  const root = discoveredRoot();
  const snapshot = tree(root);
  const cycle = {
    issue_id: "cycle-1",
    identifier: "CYC-1",
    project_id: root.projectId,
    parent_issue_id: root.issueId,
    status_id: "started",
    status_name: "In Progress",
    status_category: "started" as const,
    status_position: 1,
    order: 1,
    depth: 1,
    title: "Cycle",
    description: "Cycle",
    labels: [],
    is_archived: false,
    issue_kind: "cycle" as const,
    remote_version: "v1",
    updated_at: root.updatedAt,
  };
  snapshot.issues.push(cycle, { ...cycle, issue_id: "cycle-2", identifier: "CYC-2", title: "Second cycle" });
  assert.deepEqual(policy.validate({ root, tree: snapshot }), { kind: "invalid", reason: "multiple_active_cycles" });
});

function discoveredRoot(): DiscoveredRoot {
  return {
    issueId: "root-1",
    identifier: "ROOT-1",
    state: "In Progress",
    title: "Root",
    description: "Objective",
    updatedAt: "2026-07-23T00:00:00.000Z",
    projectId: "project-1",
    parentIssueId: null,
    isDelegatedToSymphony: true,
    priority: "normal",
    order: 1,
    blockers: [],
    rootConductorLabels: [{ conductorShortHash: "abc123" }],
  };
}

function tree(root: DiscoveredRoot): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: root.issueId,
    status_catalog: [{ status_id: "started", name: "In Progress", category: "started", position: 1 }],
    issues: [{
      issue_id: root.issueId,
      identifier: root.identifier,
      project_id: root.projectId,
      status_id: "started",
      status_name: "In Progress",
      status_category: "started",
      status_position: 1,
      order: 1,
      depth: 0,
      title: root.title,
      description: root.description,
      labels: [],
      is_archived: false,
      issue_kind: "root",
      remote_version: "v1",
      updated_at: root.updatedAt,
    }],
    comments: [],
    relations: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: root.updatedAt,
  };
}
