import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { buildRootFactSet, diffRootFactSets } from "../internal/RootFactSet.js";

const root = {
  issueId: "root-1", identifier: "SYM-1", state: "In Progress" as const, title: "Root",
  description: "Build it", updatedAt: "2026-07-23T00:00:00Z", projectId: "project-1",
  parentIssueId: null, isDelegatedToSymphony: true, priority: "normal" as const, order: 0,
  blockers: [], rootConductorLabels: [],
};

test("fact sets send a bootstrap snapshot and only changed current values afterward", () => {
  const first = buildRootFactSet({ root, tree: tree("Root", "root-v1", "comment-v1"), git: git("head-1"), mechanicalViolations: [] });
  const second = buildRootFactSet({ root, tree: tree("Changed", "root-v2", "comment-v1"), git: git("head-1"), mechanicalViolations: [] });
  const delta = diffRootFactSets(first, second);

  assert.equal(first.bootstrap.rootSnapshot.issues.length, 1);
  assert.equal(first.bootstrap.rootDigest, delta.baseRootDigest);
  assert.equal(delta.targetRootDigest, second.bootstrap.rootDigest);
  assert.deepEqual(delta.changes.map((change) => change.kind), ["issue_current_value"]);
  assert.equal("rootSnapshot" in delta, false);
  assert.equal(delta.changes[0]?.kind, "issue_current_value");
  if (delta.changes[0]?.kind === "issue_current_value") assert.equal(delta.changes[0].issue.title, "Changed");
});

test("removed source facts become tombstones", () => {
  const first = buildRootFactSet({ root, tree: tree("Root", "root-v1", "comment-v1", true), git: git("head-1"), mechanicalViolations: [] });
  const second = buildRootFactSet({ root, tree: tree("Root", "root-v1", undefined, false), git: git("head-1"), mechanicalViolations: [] });
  const delta = diffRootFactSets(first, second);
  assert.ok(delta.changes.some((change) => change.kind === "comment_removed"));
});

function git(head: string) {
  return { head, branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } };
}

function tree(title: string, rootVersion: string, commentVersion?: string, includeComment = true): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "progress", name: "In Progress", category: "started", position: 1 }],
    issues: [{
      issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "progress",
      status_name: "In Progress", status_category: "started", status_position: 1, order: 0, depth: 0,
      title, description: "Build it", labels: [], is_archived: false, issue_kind: "root",
      remote_version: rootVersion, updated_at: "2026-07-23T00:00:00Z",
    }],
    comments: includeComment && commentVersion ? [{
      comment_id: "comment-1", issue_id: "root-1", body: "User input", author_kind: "human", author_id: "user-1",
      author_user_id: "user-1", created_at: "2026-07-23T00:00:01Z", remote_version: commentVersion,
      updated_at: "2026-07-23T00:00:01Z",
    }] : [],
    relations: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-23T00:00:02Z",
  };
}
