import type { ConcreteTaskChange, TaskIssueSnapshot } from "../../contracts/observation.js";

export function sameTaskStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

export function linearIssueDiff(before: TaskIssueSnapshot, after: TaskIssueSnapshot): ConcreteTaskChange[] {
  const changes: ConcreteTaskChange[] = [];
  if (before.title !== after.title) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "title", before: before.title, after: after.title });
  }
  if (before.description !== after.description) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "description", before: before.description, after: after.description });
  }
  if (before.status !== after.status) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "status", before: before.status, after: after.status });
  }
  if (before.parent_id !== after.parent_id) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "parent", before: before.parent_id, after: after.parent_id });
  }
  if (!sameTaskStrings(before.labels, after.labels)) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "labels", before: before.labels, after: after.labels });
  }
  if (before.delegate_id !== after.delegate_id) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "delegate", before: before.delegate_id, after: after.delegate_id });
  }
  if (before.priority !== after.priority) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "priority", before: before.priority, after: after.priority });
  }
  return changes;
}
