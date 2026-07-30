import { createHash } from "node:crypto";

import { parseTaskDigest, type TaskDigest } from "../contracts/identity.js";
import type {
  ConcreteTaskChange,
  TaskIssueSnapshot,
  TaskRelationSnapshot,
  TaskSnapshot,
} from "../contracts/observation.js";

export function canonicalTaskSnapshot(snapshot: TaskSnapshot) {
  return {
    root_id: snapshot.root_id,
    issues: [...snapshot.issues]
      .sort((left, right) => left.issue_id.localeCompare(right.issue_id))
      .map((issue) => ({
        issue_id: issue.issue_id,
        revision: issue.revision,
        status: issue.status,
        title: issue.title,
        description: issue.description,
        parent_id: issue.parent_id,
        labels: [...issue.labels].sort(),
        delegate_id: issue.delegate_id,
        priority: issue.priority,
      })),
    relations: [...snapshot.relations]
      .sort((left, right) => left.relation_id.localeCompare(right.relation_id))
      .map((relation) => ({
        relation_id: relation.relation_id,
        revision: relation.revision,
        type: relation.type,
        source_issue_id: relation.source_issue_id,
        target_issue_id: relation.target_issue_id,
      })),
  };
}

export function taskSnapshotDigest(snapshot: TaskSnapshot): TaskDigest {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalTaskSnapshot(snapshot)))
    .digest("hex");
  return parseTaskDigest(`sha256:${digest}`);
}

export function taskStringSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

export function taskIssueChanges(before: TaskIssueSnapshot, after: TaskIssueSnapshot): ConcreteTaskChange[] {
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
  if (!taskStringSetsEqual(before.labels, after.labels)) {
    changes.push({
      kind: "field_changed",
      issue_id: after.issue_id,
      field: "labels",
      before: [...before.labels].sort(),
      after: [...after.labels].sort(),
    });
  }
  if (before.delegate_id !== after.delegate_id) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "delegate", before: before.delegate_id, after: after.delegate_id });
  }
  if (before.priority !== after.priority) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "priority", before: before.priority, after: after.priority });
  }
  return changes;
}

function sameRelation(left: TaskRelationSnapshot, right: TaskRelationSnapshot): boolean {
  return left.type === right.type
    && left.source_issue_id === right.source_issue_id
    && left.target_issue_id === right.target_issue_id;
}

export function taskSnapshotChanges(before: TaskSnapshot, after: TaskSnapshot): readonly ConcreteTaskChange[] {
  const changes: ConcreteTaskChange[] = [];
  const beforeIssues = new Map(before.issues.map((issue) => [issue.issue_id, issue]));
  const afterIssues = new Map(after.issues.map((issue) => [issue.issue_id, issue]));
  const issueIds = new Set([...beforeIssues.keys(), ...afterIssues.keys()]);
  for (const issueId of [...issueIds].sort()) {
    const previous = beforeIssues.get(issueId);
    const current = afterIssues.get(issueId);
    if (previous === undefined && current !== undefined) changes.push({ kind: "issue_created", issue: current });
    else if (previous !== undefined && current === undefined) changes.push({ kind: "issue_archived", issue: previous });
    else if (previous !== undefined && current !== undefined) changes.push(...taskIssueChanges(previous, current));
  }

  const beforeRelations = new Map(before.relations.map((relation) => [relation.relation_id, relation]));
  const afterRelations = new Map(after.relations.map((relation) => [relation.relation_id, relation]));
  const relationIds = new Set([...beforeRelations.keys(), ...afterRelations.keys()]);
  for (const relationId of [...relationIds].sort()) {
    const previous = beforeRelations.get(relationId);
    const current = afterRelations.get(relationId);
    if (previous === undefined && current !== undefined) changes.push({ kind: "relation_added", relation: current });
    else if (previous !== undefined && current === undefined) changes.push({ kind: "relation_removed", relation: previous });
    else if (previous !== undefined && current !== undefined && !sameRelation(previous, current)) {
      changes.push(
        { kind: "relation_removed", relation: previous },
        { kind: "relation_added", relation: current },
      );
    }
  }
  return Object.freeze(changes);
}
