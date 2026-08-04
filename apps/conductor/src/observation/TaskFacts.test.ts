import assert from "node:assert/strict";
import test from "node:test";

import { canonicalTaskRevision, parseTaskIssueSnapshotChange, parseTaskSnapshot } from "../contracts/task-management.js";
import {
  deriveLastValidStageBasisStatus,
  taskIssueChanges,
  taskSnapshotChanges,
  taskSnapshotDigest,
} from "./TaskFacts.js";

const states = {
  team_id: "team:1", revision: `symphony:v1:${"1".repeat(64)}`,
  todo_state_id: "state:todo", draft_state_id: "state:draft",
  in_progress_state_id: "state:in-progress", awaiting_acceptance_state_id: "state:awaiting-acceptance",
  in_review_state_id: "state:in-review", done_state_id: "state:done",
  succeeded_state_id: "state:succeeded", rejected_state_id: "state:rejected",
  failed_state_id: "state:failed", canceled_state_id: "state:canceled",
} as const;

function canonicalIssue(overrides: Record<string, unknown> = {}) {
  const fields = {
    issue_id: "LIN-2", provider_created_at: "2026-08-03T00:00:00.000Z",
    provider_updated_at: "2026-08-03T00:00:00.000Z", creation_actor_id: "actor:1",
    kind: "cycle", status_id: states.todo_state_id, status: "Todo", title: "Before",
    description_markdown: "# Before", parent_issue_id: "LIN-1", label_ids: ["label:b", "label:a"],
    delegate_id: "actor:1", priority: 1, archived: false, trashed: false, ...overrides,
  };
  return { ...fields, revision: canonicalTaskRevision(fields) };
}

function snapshot(issues: readonly unknown[], relations: readonly unknown[] = []) {
  return parseTaskSnapshot({
    root_id: "LIN-1", workflow_state_map: states, issues, relations,
    resource_creation_evidence: [], issue_history: [], issue_record_observations: [],
  });
}

const issue = parseTaskIssueSnapshotChange(canonicalIssue());

test("Task Issue diff emits every approved field with deterministic label sets", () => {
  const after = parseTaskIssueSnapshotChange(canonicalIssue({
    status_id: states.done_state_id, status: "Done",
    title: "After",
    description_markdown: "Completed",
    parent_issue_id: null,
    label_ids: ["label:c", "label:a"],
    delegate_id: null,
    priority: 2,
  }));

  assert.deepEqual(taskIssueChanges(issue, after), [
    { kind: "field_changed", issue_id: "LIN-2", field: "title", before: "Before", after: "After" },
    { kind: "field_changed", issue_id: "LIN-2", field: "description", before: "# Before", after: "Completed" },
    { kind: "field_changed", issue_id: "LIN-2", field: "status", before: "Todo", after: "Done" },
    { kind: "field_changed", issue_id: "LIN-2", field: "parent", before: "LIN-1", after: null },
    { kind: "field_changed", issue_id: "LIN-2", field: "labels", before: ["label:a", "label:b"], after: ["label:a", "label:c"] },
    { kind: "field_changed", issue_id: "LIN-2", field: "delegate", before: "actor:1", after: null },
    { kind: "field_changed", issue_id: "LIN-2", field: "priority", before: 1, after: 2 },
  ]);
});

test("Task snapshot diff orders create, archive, and relation facts by identity", () => {
  const root = canonicalIssue({ issue_id: "LIN-1", kind: "root", parent_issue_id: null });
  const before = snapshot([root, canonicalIssue({ issue_id: "LIN-9" })]);
  const after = snapshot([root, canonicalIssue({ issue_id: "LIN-3" })]);

  assert.deepEqual(taskSnapshotChanges(before, after).map(({ kind }) => kind), [
    "issue_created",
    "issue_archived",
  ]);
});

test("revision-only facts change the canonical digest without inventing an unapproved field", () => {
  const before = snapshot([canonicalIssue({ issue_id: "LIN-1", kind: "root", parent_issue_id: null })]);
  const after = snapshot([canonicalIssue({
    issue_id: "LIN-1", kind: "root", parent_issue_id: null,
    provider_updated_at: "2026-08-03T00:00:01.000Z",
  })]);

  assert.notEqual(taskSnapshotDigest(before), taskSnapshotDigest(after));
  assert.deepEqual(taskSnapshotChanges(before, after), []);
});

test("external terminal Stage basis is accepted only when grouped history proves one legal predecessor", () => {
  const stage = canonicalIssue({
    issue_id: "LIN-STAGE",
    status_id: states.done_state_id,
    status: "Done",
  });
  const stageIssue = parseTaskIssueSnapshotChange(stage);
  const root = canonicalIssue({ issue_id: "LIN-1", kind: "root", parent_issue_id: null });
  const history = {
    history_id: "history:terminal",
    issue_id: "LIN-STAGE",
    provider_created_at: "2026-08-03T00:00:01.000Z",
    provider_updated_at: "2026-08-03T00:00:01.000Z",
    actor_id: "actor:external",
    change_origin: "external",
    changed_fields: ["status"],
    from_status: "In Progress",
    to_status: "Done",
    from_parent_issue_id: "LIN-1",
    to_parent_issue_id: "LIN-1",
    added_label_ids: [],
    removed_label_ids: [],
    archived: null,
    trashed: null,
    relation_changes: [],
  } as const;
  const current = snapshot([root, stage], []);
  const withHistory = parseTaskSnapshot({ ...current, issue_history: [history] });

  assert.equal(
    deriveLastValidStageBasisStatus(withHistory, stageIssue.issue_id),
    "In Progress",
  );
  assert.equal(
    deriveLastValidStageBasisStatus(current, stageIssue.issue_id),
    null,
  );

  const ambiguous = parseTaskSnapshot({
    ...current,
    issue_history: [
      history,
      { ...history, history_id: "history:todo-terminal", from_status: "Todo" },
    ],
  });
  assert.equal(deriveLastValidStageBasisStatus(ambiguous, stageIssue.issue_id), null);
});
