import assert from "node:assert/strict";
import test from "node:test";

import { parseRootIssueId, parseRuntimeGeneration } from "./identity.js";
import { parseRootFactDiff } from "./observation.js";
import { canonicalTaskRevision } from "./task-management.js";

const target = {
  root_id: parseRootIssueId("LIN-1"),
  runtime_generation: parseRuntimeGeneration(3),
};

const issueFields = {
  issue_id: "LIN-2",
  provider_created_at: "2026-08-03T00:00:00.000Z",
  provider_updated_at: "2026-08-03T00:00:00.000Z",
  creation_actor_id: "actor:1",
  kind: "work",
  status_id: "state:todo",
  status: "Todo",
  title: "Implement the contract",
  description_markdown: "# Implement the contract",
  parent_issue_id: "LIN-1",
  label_ids: ["label:work"],
  delegate_id: "actor:1",
  priority: 2,
  archived: false,
  trashed: false,
} as const;
const issue = { ...issueFields, revision: canonicalTaskRevision(issueFields) };

const relationFields = {
  relation_id: "relation:1",
  provider_created_at: "2026-08-03T00:00:00.000Z",
  provider_updated_at: "2026-08-03T00:00:00.000Z",
  creation_actor_id: "actor:1",
  creation_evidence_id: "evidence:relation:1",
  type: "blocks",
  source_issue_id: "LIN-2",
  target_issue_id: "LIN-3",
} as const;
const relation = { ...relationFields, revision: canonicalTaskRevision(relationFields) };

const diff = {
  schema_version: 1,
  root_id: "LIN-1",
  runtime_generation: 3,
  correlation_id: "corr:3",
  from_observation_digest: "digest:2",
  to_observation_digest: "digest:3",
  task_changes: [
    { kind: "issue_created", issue },
    { kind: "issue_archived", issue },
    { kind: "field_changed", issue_id: "LIN-2", field: "status", before: "Todo", after: "In Progress" },
    { kind: "field_changed", issue_id: "LIN-2", field: "title", before: "Old", after: "New" },
    { kind: "field_changed", issue_id: "LIN-2", field: "description", before: null, after: "Details" },
    { kind: "field_changed", issue_id: "LIN-2", field: "parent", before: "LIN-1", after: null },
    { kind: "field_changed", issue_id: "LIN-2", field: "labels", before: ["a"], after: ["b"] },
    { kind: "field_changed", issue_id: "LIN-2", field: "delegate", before: null, after: "actor:1" },
    { kind: "field_changed", issue_id: "LIN-2", field: "priority", before: 1, after: 2 },
    { kind: "relation_added", relation },
    { kind: "relation_removed", relation },
  ],
  git_changes: [
    { kind: "head_changed", before: "a".repeat(40), after: "b".repeat(40) },
    { kind: "workspace_changed", before: "dirty", after: "clean" },
    { kind: "pull_request_changed", before: null, after: "b".repeat(40) },
  ],
};

test("RootFactDiff accepts only concrete task and Git fact changes", () => {
  const parsed = parseRootFactDiff(diff, target);

  assert.equal(parsed.task_changes.length, 11);
  assert.equal(parsed.git_changes.length, 3);
  assert.ok(Object.isFrozen(parsed.task_changes));
  assert.throws(
    () => parseRootFactDiff({ ...diff, task_changes: [{ kind: "active_cycle_changed", before: null, after: "LIN-2" }] }, target),
    /invalid_contract_variant/u,
  );
  assert.throws(
    () => parseRootFactDiff({ ...diff, metadata: {} }, target),
    /invalid_contract_keys/u,
  );
});

test("RootFactDiff rejects stale, unchanged, and unapproved field changes", () => {
  assert.throws(
    () => parseRootFactDiff({ ...diff, runtime_generation: 2 }, target),
    /stale_generation/u,
  );
  assert.throws(
    () => parseRootFactDiff({ ...diff, to_observation_digest: "digest:2" }, target),
    /unchanged_observation_diff/u,
  );
  assert.throws(
    () => parseRootFactDiff({
      ...diff,
      task_changes: [{ kind: "field_changed", issue_id: "LIN-2", field: "workflow", before: "a", after: "b" }],
    }, target),
    /invalid_contract_variant/u,
  );
  assert.throws(
    () => parseRootFactDiff({
      ...diff,
      task_changes: [{ kind: "field_changed", issue_id: "LIN-2", field: "status", before: "Todo", after: "Todo" }],
    }, target),
    /unchanged_task_field/u,
  );
});
