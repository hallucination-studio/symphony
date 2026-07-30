import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTaskIssueSnapshot,
  parseTaskSnapshot,
} from "../contracts/observation.js";
import {
  taskIssueChanges,
  taskSnapshotChanges,
  taskSnapshotDigest,
} from "./TaskFacts.js";

const issue = parseTaskIssueSnapshot({
  issue_id: "LIN-2",
  revision: "revision:1",
  status: "Todo",
  title: "Before",
  description: null,
  parent_id: "LIN-1",
  labels: ["label:b", "label:a"],
  delegate_id: "actor:1",
  priority: 1,
});

test("Task Issue diff emits every approved field with deterministic label sets", () => {
  const after = parseTaskIssueSnapshot({
    ...issue,
    revision: "revision:2",
    status: "Done",
    title: "After",
    description: "Completed",
    parent_id: null,
    labels: ["label:c", "label:a"],
    delegate_id: null,
    priority: 2,
  });

  assert.deepEqual(taskIssueChanges(issue, after), [
    { kind: "field_changed", issue_id: "LIN-2", field: "title", before: "Before", after: "After" },
    { kind: "field_changed", issue_id: "LIN-2", field: "description", before: null, after: "Completed" },
    { kind: "field_changed", issue_id: "LIN-2", field: "status", before: "Todo", after: "Done" },
    { kind: "field_changed", issue_id: "LIN-2", field: "parent", before: "LIN-1", after: null },
    { kind: "field_changed", issue_id: "LIN-2", field: "labels", before: ["label:a", "label:b"], after: ["label:a", "label:c"] },
    { kind: "field_changed", issue_id: "LIN-2", field: "delegate", before: "actor:1", after: null },
    { kind: "field_changed", issue_id: "LIN-2", field: "priority", before: 1, after: 2 },
  ]);
});

test("Task snapshot diff orders create, archive, and relation facts by identity", () => {
  const before = parseTaskSnapshot({
    root_id: "LIN-1",
    issues: [
      { ...issue, issue_id: "LIN-1", parent_id: null },
      { ...issue, issue_id: "LIN-9" },
    ],
    relations: [{
      relation_id: "relation:z",
      revision: "revision:relation:z",
      type: "blocks",
      source_issue_id: "LIN-1",
      target_issue_id: "LIN-9",
    }],
  });
  const after = parseTaskSnapshot({
    root_id: "LIN-1",
    issues: [
      { ...issue, issue_id: "LIN-1", parent_id: null },
      { ...issue, issue_id: "LIN-3" },
    ],
    relations: [{
      relation_id: "relation:a",
      revision: "revision:relation:a",
      type: "blocks",
      source_issue_id: "LIN-1",
      target_issue_id: "LIN-3",
    }],
  });

  assert.deepEqual(taskSnapshotChanges(before, after).map(({ kind }) => kind), [
    "issue_created",
    "issue_archived",
    "relation_added",
    "relation_removed",
  ]);
});

test("revision-only facts change the canonical digest without inventing an unapproved field", () => {
  const before = parseTaskSnapshot({
    root_id: "LIN-1",
    issues: [{ ...issue, issue_id: "LIN-1", parent_id: null }],
    relations: [],
  });
  const after = parseTaskSnapshot({
    root_id: "LIN-1",
    issues: [{ ...issue, issue_id: "LIN-1", parent_id: null, revision: "revision:2" }],
    relations: [],
  });

  assert.notEqual(taskSnapshotDigest(before), taskSnapshotDigest(after));
  assert.deepEqual(taskSnapshotChanges(before, after), []);
});
