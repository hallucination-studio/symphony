import { createHash } from "node:crypto";

import { parseTaskDigest, type TaskDigest } from "../contracts/identity.js";
import type {
  ConcreteTaskChange,
} from "../contracts/observation.js";
import type {
  TaskIssueSnapshot,
  TaskIssueHistoryEntry,
  TaskRelationSnapshot,
  TaskSnapshot,
} from "../contracts/task-management.js";

type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | {
  readonly [key: string]: CanonicalValue;
};

function canonicalValue(value: unknown): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") throw new Error("invalid_task_digest_value");
  return Object.freeze(Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)])));
}

export function canonicalTaskSnapshot(snapshot: TaskSnapshot) {
  return canonicalValue({
    root_id: snapshot.root_id,
    workflow_state_map: snapshot.workflow_state_map,
    issues: [...snapshot.issues]
      .sort((left, right) => left.issue_id.localeCompare(right.issue_id))
      .map((issue) => ({
        ...issue,
        label_ids: [...issue.label_ids].sort(),
      })),
    relations: [...snapshot.relations]
      .sort((left, right) => left.relation_id.localeCompare(right.relation_id))
      .map((relation) => ({ ...relation })),
    resource_creation_evidence: [...snapshot.resource_creation_evidence]
      .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
    issue_history: [...snapshot.issue_history]
      .sort((left, right) => left.history_id.localeCompare(right.history_id))
      .map((entry) => ({
        ...entry,
        changed_fields: [...entry.changed_fields].sort(),
        added_label_ids: [...entry.added_label_ids].sort(),
        removed_label_ids: [...entry.removed_label_ids].sort(),
        relation_changes: [...entry.relation_changes]
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      })),
    issue_record_observations: [...snapshot.issue_record_observations]
      .sort((left, right) => left.record_id.localeCompare(right.record_id)),
  });
}

export function taskSnapshotDigest(snapshot: TaskSnapshot): TaskDigest {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalTaskSnapshot(snapshot)))
    .digest("hex");
  return parseTaskDigest(`sha256:${digest}`);
}

export type LastValidStageBasisStatus = "Todo" | "In Progress";

/**
 * Grouped provider history cannot establish mutation order. For an externally
 * terminal Stage, accept only one status transition that identifies its legal
 * nonterminal predecessor; every other shape is ambiguous and fails closed.
 */
export function deriveLastValidStageBasisStatus(
  snapshot: Pick<TaskSnapshot, "issues" | "issue_history">,
  issueId: TaskIssueSnapshot["issue_id"],
): LastValidStageBasisStatus | null {
  const issue = snapshot.issues.find(({ issue_id }) => issue_id === issueId);
  if (issue === undefined) return null;
  if (issue.status === "Todo" || issue.status === "In Progress") return issue.status;
  if (issue.status !== "Done" && issue.status !== "Failed" && issue.status !== "Canceled") return null;

  const candidates = new Set<LastValidStageBasisStatus>();
  for (const entry of snapshot.issue_history as readonly TaskIssueHistoryEntry[]) {
    if (
      entry.issue_id !== issueId
      || !entry.changed_fields.includes("status")
      || entry.to_status !== issue.status
      || (entry.from_status !== "Todo" && entry.from_status !== "In Progress")
    ) continue;
    candidates.add(entry.from_status);
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
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
  if (before.description_markdown !== after.description_markdown) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "description", before: before.description_markdown, after: after.description_markdown });
  }
  if (before.status !== after.status) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "status", before: before.status, after: after.status });
  }
  if (before.parent_issue_id !== after.parent_issue_id) {
    changes.push({ kind: "field_changed", issue_id: after.issue_id, field: "parent", before: before.parent_issue_id, after: after.parent_issue_id });
  }
  if (!taskStringSetsEqual(before.label_ids, after.label_ids)) {
    changes.push({
      kind: "field_changed",
      issue_id: after.issue_id,
      field: "labels",
      before: [...before.label_ids].sort(),
      after: [...after.label_ids].sort(),
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
