import { createHash } from "node:crypto";

import { parseTaskIssueRecord, type TaskIssueRecord } from "./cycle-records.js";
import {
  parseRootIssueId,
  parseTaskIssueId,
  parseTaskLabelId,
  parseTaskRelationId,
  parseTaskRevision,
  parseTaskStateId,
  type RootIssueId,
  type TaskIssueId,
  type TaskLabelId,
  type TaskRelationId,
  type TaskRevision,
  type TaskStateId,
} from "./identity.js";
import {
  asRecord,
  assertExactKeys,
  parseArray,
  parseBoundedString,
  parseEnum,
  parseMarkdownText,
  parseStringArray,
  type MarkdownText,
  type UnknownRecord,
} from "./validation.js";

const CANONICAL_REVISION_PATTERN = /^symphony:v1:[0-9a-f]{64}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const TASK_KINDS = ["root", "cycle", "plan", "work", "verify"] as const;
export const TASK_WORKFLOW_STATUSES = [
  "Todo",
  "Draft",
  "In Progress",
  "Awaiting Acceptance",
  "In Review",
  "Done",
  "Succeeded",
  "Rejected",
  "Failed",
  "Canceled",
] as const;
const HISTORY_FIELDS = [
  "status", "title", "description", "parent", "labels", "delegate", "priority",
  "archived", "trashed", "relation",
] as const;
const CHANGE_ORIGINS = ["symphony", "external", "unknown"] as const;
const CREATION_EVIDENCE_SOURCES = ["current_resource", "provider_audit"] as const;
const RECORD_KINDS = [
  "root_family_invalidation",
  "cycle_approval",
  "stage_completion",
  "stage_invalidation",
  "cycle_completion",
  "cycle_invalidation",
  "delivery_completion",
  "delivery_invalidation",
] as const;
const INVALID_RECORD_OBSERVATIONS = ["missing", "malformed", "updated", "archived"] as const;

type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | {
  readonly [key: string]: CanonicalValue;
};

function canonicalValue(value: unknown): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") throw new Error("invalid_canonical_value");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid_canonical_value");
  return Object.freeze(Object.fromEntries(Object.entries(value as UnknownRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)])));
}

export function canonicalTaskRevision(value: unknown): TaskRevision {
  const digest = createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
  return parseTaskRevision(`symphony:v1:${digest}`);
}

function parseCanonicalRevision(value: unknown): TaskRevision {
  const revision = parseTaskRevision(value);
  if (!CANONICAL_REVISION_PATTERN.test(revision)) throw new Error("invalid_canonical_task_revision");
  return revision;
}

function assertCanonicalRevision(
  revision: TaskRevision,
  fields: UnknownRecord,
  code: string,
): void {
  if (revision !== canonicalTaskRevision(fields)) throw new Error(code);
}

function parseDigest(value: unknown, code: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new Error(code);
  return value;
}

function parseTimestamp(value: unknown, code: string): string {
  const timestamp = parseBoundedString(value, code, 64);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== timestamp) throw new Error(code);
  return timestamp;
}

function parseNullable<T>(value: unknown, parser: (input: unknown) => T): T | null {
  return value === null ? null : parser(value);
}

function parseBoolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new Error(code);
  return value;
}

function parseActorId(value: unknown): string {
  return parseBoundedString(value, "invalid_task_actor_id", 128);
}

function parsePriority(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 4) {
    throw new Error("invalid_task_priority");
  }
  return value as number;
}

export interface TaskWorkflowStateMap {
  readonly team_id: string;
  readonly revision: TaskRevision;
  readonly todo_state_id: TaskStateId;
  readonly draft_state_id: TaskStateId;
  readonly in_progress_state_id: TaskStateId;
  readonly awaiting_acceptance_state_id: TaskStateId;
  readonly in_review_state_id: TaskStateId;
  readonly done_state_id: TaskStateId;
  readonly succeeded_state_id: TaskStateId;
  readonly rejected_state_id: TaskStateId;
  readonly failed_state_id: TaskStateId;
  readonly canceled_state_id: TaskStateId;
}

const WORKFLOW_STATE_KEYS = [
  "team_id", "revision", "todo_state_id", "draft_state_id", "in_progress_state_id",
  "awaiting_acceptance_state_id", "in_review_state_id", "done_state_id", "succeeded_state_id",
  "rejected_state_id", "failed_state_id", "canceled_state_id",
] as const;

export function parseTaskWorkflowStateMap(value: unknown): TaskWorkflowStateMap {
  const record = asRecord(value);
  assertExactKeys(record, WORKFLOW_STATE_KEYS);
  const stateIds = {
    todo_state_id: parseTaskStateId(record.todo_state_id),
    draft_state_id: parseTaskStateId(record.draft_state_id),
    in_progress_state_id: parseTaskStateId(record.in_progress_state_id),
    awaiting_acceptance_state_id: parseTaskStateId(record.awaiting_acceptance_state_id),
    in_review_state_id: parseTaskStateId(record.in_review_state_id),
    done_state_id: parseTaskStateId(record.done_state_id),
    succeeded_state_id: parseTaskStateId(record.succeeded_state_id),
    rejected_state_id: parseTaskStateId(record.rejected_state_id),
    failed_state_id: parseTaskStateId(record.failed_state_id),
    canceled_state_id: parseTaskStateId(record.canceled_state_id),
  };
  if (new Set(Object.values(stateIds)).size !== TASK_WORKFLOW_STATUSES.length) {
    throw new Error("duplicate_workflow_state_id");
  }
  return Object.freeze({
    team_id: parseBoundedString(record.team_id, "invalid_task_team_id", 128),
    revision: parseCanonicalRevision(record.revision),
    ...stateIds,
  });
}

export type TaskWorkflowStatus = typeof TASK_WORKFLOW_STATUSES[number];
export type TaskKind = typeof TASK_KINDS[number];

export interface TaskIssueSnapshot {
  readonly issue_id: TaskIssueId;
  readonly revision: TaskRevision;
  readonly provider_created_at: string;
  readonly provider_updated_at: string;
  readonly creation_actor_id: string;
  readonly kind: TaskKind;
  readonly status_id: TaskStateId;
  readonly status: TaskWorkflowStatus;
  readonly title: string;
  readonly description_markdown: MarkdownText;
  readonly parent_issue_id: TaskIssueId | null;
  readonly label_ids: readonly TaskLabelId[];
  readonly delegate_id: string | null;
  readonly priority: number | null;
  readonly archived: boolean;
  readonly trashed: boolean;
}

const ISSUE_KEYS = [
  "issue_id", "revision", "provider_created_at", "provider_updated_at", "creation_actor_id",
  "kind", "status_id", "status", "title", "description_markdown", "parent_issue_id",
  "label_ids", "delegate_id", "priority", "archived", "trashed",
] as const;

const STATUS_STATE_FIELD: Record<TaskWorkflowStatus, keyof TaskWorkflowStateMap> = {
  Todo: "todo_state_id",
  Draft: "draft_state_id",
  "In Progress": "in_progress_state_id",
  "Awaiting Acceptance": "awaiting_acceptance_state_id",
  "In Review": "in_review_state_id",
  Done: "done_state_id",
  Succeeded: "succeeded_state_id",
  Rejected: "rejected_state_id",
  Failed: "failed_state_id",
  Canceled: "canceled_state_id",
};

export function parseTaskIssueSnapshotChange(value: unknown): TaskIssueSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, ISSUE_KEYS);
  const revision = parseCanonicalRevision(record.revision);
  const fields = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "revision"));
  assertCanonicalRevision(revision, fields, "task_issue_revision_mismatch");
  const status = parseEnum(record.status, TASK_WORKFLOW_STATUSES);
  const statusId = parseTaskStateId(record.status_id);
  return Object.freeze({
    issue_id: parseTaskIssueId(record.issue_id),
    revision,
    provider_created_at: parseTimestamp(record.provider_created_at, "invalid_task_created_at"),
    provider_updated_at: parseTimestamp(record.provider_updated_at, "invalid_task_updated_at"),
    creation_actor_id: parseActorId(record.creation_actor_id),
    kind: parseEnum(record.kind, TASK_KINDS),
    status_id: statusId,
    status,
    title: parseBoundedString(record.title, "invalid_task_title", 1_024),
    description_markdown: parseMarkdownText(record.description_markdown, "invalid_task_document"),
    parent_issue_id: parseNullable(record.parent_issue_id, parseTaskIssueId),
    label_ids: parseStringArray(record.label_ids, parseTaskLabelId, 32) as readonly TaskLabelId[],
    delegate_id: parseNullable(record.delegate_id, parseActorId),
    priority: parsePriority(record.priority),
    archived: parseBoolean(record.archived, "invalid_task_archived"),
    trashed: parseBoolean(record.trashed, "invalid_task_trashed"),
  });
}

export function parseTaskIssueSnapshot(
  value: unknown,
  states: TaskWorkflowStateMap,
): TaskIssueSnapshot {
  const issue = parseTaskIssueSnapshotChange(value);
  if (states[STATUS_STATE_FIELD[issue.status]] !== issue.status_id) {
    throw new Error("task_issue_status_mismatch");
  }
  return issue;
}

export interface TaskRelationSnapshot {
  readonly relation_id: TaskRelationId;
  readonly revision: TaskRevision;
  readonly provider_created_at: string;
  readonly provider_updated_at: string;
  readonly creation_actor_id: string;
  readonly creation_evidence_id: string;
  readonly type: string;
  readonly source_issue_id: TaskIssueId;
  readonly target_issue_id: TaskIssueId;
}

const RELATION_KEYS = [
  "relation_id", "revision", "provider_created_at", "provider_updated_at", "creation_actor_id",
  "creation_evidence_id", "type", "source_issue_id", "target_issue_id",
] as const;

export function parseTaskRelationSnapshot(value: unknown): TaskRelationSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, RELATION_KEYS);
  const revision = parseCanonicalRevision(record.revision);
  const fields = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "revision"));
  assertCanonicalRevision(revision, fields, "task_relation_revision_mismatch");
  const sourceIssueId = parseTaskIssueId(record.source_issue_id);
  const targetIssueId = parseTaskIssueId(record.target_issue_id);
  if (sourceIssueId === targetIssueId) throw new Error("task_relation_self_edge");
  return Object.freeze({
    relation_id: parseTaskRelationId(record.relation_id),
    revision,
    provider_created_at: parseTimestamp(record.provider_created_at, "invalid_relation_created_at"),
    provider_updated_at: parseTimestamp(record.provider_updated_at, "invalid_relation_updated_at"),
    creation_actor_id: parseActorId(record.creation_actor_id),
    creation_evidence_id: parseBoundedString(record.creation_evidence_id, "invalid_creation_evidence_id", 128),
    type: parseBoundedString(record.type, "invalid_task_relation_type", 64),
    source_issue_id: sourceIssueId,
    target_issue_id: targetIssueId,
  });
}

export interface TaskResourceCreationEvidence {
  readonly evidence_id: string;
  readonly resource_kind: "issue" | "relation";
  readonly resource_id: string;
  readonly creation_actor_id: string;
  readonly provider_created_at: string;
  readonly evidence_source: typeof CREATION_EVIDENCE_SOURCES[number];
  readonly canonical_evidence_digest: TaskRevision;
}

export function parseTaskResourceCreationEvidence(value: unknown): TaskResourceCreationEvidence {
  const record = asRecord(value);
  assertExactKeys(record, [
    "evidence_id", "resource_kind", "resource_id", "creation_actor_id", "provider_created_at",
    "evidence_source", "canonical_evidence_digest",
  ]);
  const digest = parseCanonicalRevision(record.canonical_evidence_digest);
  const fields = Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== "canonical_evidence_digest"));
  assertCanonicalRevision(digest, fields, "task_creation_evidence_digest_mismatch");
  return Object.freeze({
    evidence_id: parseBoundedString(record.evidence_id, "invalid_creation_evidence_id", 128),
    resource_kind: parseEnum(record.resource_kind, ["issue", "relation"] as const),
    resource_id: parseBoundedString(record.resource_id, "invalid_creation_resource_id", 128),
    creation_actor_id: parseActorId(record.creation_actor_id),
    provider_created_at: parseTimestamp(record.provider_created_at, "invalid_creation_evidence_time"),
    evidence_source: parseEnum(record.evidence_source, CREATION_EVIDENCE_SOURCES),
    canonical_evidence_digest: digest,
  });
}

export interface TaskIssueHistoryRelationChange {
  readonly type: string;
  readonly related_issue_identifier: string;
}

export interface TaskIssueHistoryEntry {
  readonly history_id: string;
  readonly issue_id: TaskIssueId;
  readonly provider_created_at: string;
  readonly provider_updated_at: string;
  readonly actor_id: string | null;
  readonly change_origin: typeof CHANGE_ORIGINS[number];
  readonly changed_fields: readonly typeof HISTORY_FIELDS[number][];
  readonly from_status: TaskWorkflowStatus | null;
  readonly to_status: TaskWorkflowStatus | null;
  readonly from_parent_issue_id: TaskIssueId | null;
  readonly to_parent_issue_id: TaskIssueId | null;
  readonly added_label_ids: readonly TaskLabelId[];
  readonly removed_label_ids: readonly TaskLabelId[];
  readonly archived: boolean | null;
  readonly trashed: boolean | null;
  readonly relation_changes: readonly TaskIssueHistoryRelationChange[];
}

function parseNullableBoolean(value: unknown): boolean | null {
  return value === null ? null : parseBoolean(value, "invalid_history_boolean");
}

function parseHistoryRelationChange(value: unknown): TaskIssueHistoryRelationChange {
  const record = asRecord(value);
  assertExactKeys(record, ["type", "related_issue_identifier"]);
  return Object.freeze({
    type: parseBoundedString(record.type, "invalid_history_relation_type", 64),
    related_issue_identifier: parseBoundedString(
      record.related_issue_identifier,
      "invalid_history_related_issue",
      128,
    ),
  });
}

export function parseTaskIssueHistoryEntry(value: unknown): TaskIssueHistoryEntry {
  const record = asRecord(value);
  assertExactKeys(record, [
    "history_id", "issue_id", "provider_created_at", "provider_updated_at", "actor_id",
    "change_origin", "changed_fields", "from_status", "to_status", "from_parent_issue_id",
    "to_parent_issue_id", "added_label_ids", "removed_label_ids", "archived", "trashed",
    "relation_changes",
  ]);
  const changedFields = parseStringArray(
    record.changed_fields,
    (entry) => parseEnum(entry, HISTORY_FIELDS),
    HISTORY_FIELDS.length,
  ) as readonly typeof HISTORY_FIELDS[number][];
  if (changedFields.length === 0) throw new Error("empty_task_history_entry");
  const relationChanges = parseArray(record.relation_changes, parseHistoryRelationChange, 64);
  if (changedFields.includes("relation") !== (relationChanges.length > 0)) {
    throw new Error("task_history_relation_evidence_mismatch");
  }
  return Object.freeze({
    history_id: parseBoundedString(record.history_id, "invalid_task_history_id", 128),
    issue_id: parseTaskIssueId(record.issue_id),
    provider_created_at: parseTimestamp(record.provider_created_at, "invalid_history_created_at"),
    provider_updated_at: parseTimestamp(record.provider_updated_at, "invalid_history_updated_at"),
    actor_id: parseNullable(record.actor_id, parseActorId),
    change_origin: parseEnum(record.change_origin, CHANGE_ORIGINS),
    changed_fields: changedFields,
    from_status: parseNullable(record.from_status, (entry) => parseEnum(entry, TASK_WORKFLOW_STATUSES)),
    to_status: parseNullable(record.to_status, (entry) => parseEnum(entry, TASK_WORKFLOW_STATUSES)),
    from_parent_issue_id: parseNullable(record.from_parent_issue_id, parseTaskIssueId),
    to_parent_issue_id: parseNullable(record.to_parent_issue_id, parseTaskIssueId),
    added_label_ids: parseStringArray(record.added_label_ids, parseTaskLabelId, 32) as readonly TaskLabelId[],
    removed_label_ids: parseStringArray(record.removed_label_ids, parseTaskLabelId, 32) as readonly TaskLabelId[],
    archived: parseNullableBoolean(record.archived),
    trashed: parseNullableBoolean(record.trashed),
    relation_changes: relationChanges,
  });
}

export interface InvalidTaskIssueRecord {
  readonly record_id: string;
  readonly issue_id: TaskIssueId;
  readonly expected_record_kind: typeof RECORD_KINDS[number];
  readonly observation_kind: typeof INVALID_RECORD_OBSERVATIONS[number];
  readonly provider_created_at: string | null;
  readonly provider_updated_at: string | null;
  readonly archived_at: string | null;
  readonly observed_body_digest: string | null;
  readonly parse_error_code: string;
}

export function parseInvalidTaskIssueRecord(value: unknown): InvalidTaskIssueRecord {
  const record = asRecord(value);
  assertExactKeys(record, [
    "record_id", "issue_id", "expected_record_kind", "observation_kind", "provider_created_at",
    "provider_updated_at", "archived_at", "observed_body_digest", "parse_error_code",
  ]);
  const observationKind = parseEnum(record.observation_kind, INVALID_RECORD_OBSERVATIONS);
  const providerCreatedAt = parseNullable(
    record.provider_created_at,
    (entry) => parseTimestamp(entry, "invalid_record_created_at"),
  );
  const providerUpdatedAt = parseNullable(
    record.provider_updated_at,
    (entry) => parseTimestamp(entry, "invalid_record_updated_at"),
  );
  const archivedAt = parseNullable(
    record.archived_at,
    (entry) => parseTimestamp(entry, "invalid_record_archived_at"),
  );
  const observedBodyDigest = parseNullable(
    record.observed_body_digest,
    (entry) => parseDigest(entry, "invalid_record_body_digest"),
  );
  if (
    observationKind === "missing"
    && [providerCreatedAt, providerUpdatedAt, archivedAt, observedBodyDigest].some((entry) => entry !== null)
  ) throw new Error("invalid_missing_record_observation");
  if (observationKind === "archived" && archivedAt === null) {
    throw new Error("invalid_archived_record_observation");
  }
  return Object.freeze({
    record_id: parseBoundedString(record.record_id, "invalid_task_record_id", 128),
    issue_id: parseTaskIssueId(record.issue_id),
    expected_record_kind: parseEnum(record.expected_record_kind, RECORD_KINDS),
    observation_kind: observationKind,
    provider_created_at: providerCreatedAt,
    provider_updated_at: providerUpdatedAt,
    archived_at: archivedAt,
    observed_body_digest: observedBodyDigest,
    parse_error_code: parseBoundedString(record.parse_error_code, "invalid_record_error_code", 128),
  });
}

export interface InvalidTaskSnapshot {
  readonly root_id: RootIssueId;
  readonly observed_at: string;
  readonly failure_kind:
    | "provider_proven_known_issue_permanently_missing"
    | "incomplete_known_identity_evidence";
  readonly known_issue_id: TaskIssueId;
  readonly expected_owner_issue_id: TaskIssueId | null;
  readonly surviving_family_digest: string;
  readonly sanitized_reason_code:
    | "unsupported_external_destruction"
    | "incomplete_known_identity_evidence";
}

export function parseInvalidTaskSnapshot(value: unknown): InvalidTaskSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, [
    "root_id", "observed_at", "failure_kind", "known_issue_id", "expected_owner_issue_id",
    "surviving_family_digest", "sanitized_reason_code",
  ]);
  const failureKind = parseEnum(record.failure_kind, [
    "provider_proven_known_issue_permanently_missing",
    "incomplete_known_identity_evidence",
  ] as const);
  const expectedReason = failureKind === "provider_proven_known_issue_permanently_missing"
    ? "unsupported_external_destruction"
    : "incomplete_known_identity_evidence";
  if (record.sanitized_reason_code !== expectedReason) throw new Error("invalid_task_snapshot_reason");
  return Object.freeze({
    root_id: parseRootIssueId(record.root_id),
    observed_at: parseTimestamp(record.observed_at, "invalid_task_observed_at"),
    failure_kind: failureKind,
    known_issue_id: parseTaskIssueId(record.known_issue_id),
    expected_owner_issue_id: parseNullable(record.expected_owner_issue_id, parseTaskIssueId),
    surviving_family_digest: parseDigest(record.surviving_family_digest, "invalid_surviving_family_digest"),
    sanitized_reason_code: expectedReason,
  });
}

export type TaskIssueRecordObservation = TaskIssueRecord | InvalidTaskIssueRecord;

export interface TaskSnapshot {
  readonly root_id: RootIssueId;
  readonly workflow_state_map: TaskWorkflowStateMap;
  readonly issues: readonly TaskIssueSnapshot[];
  readonly relations: readonly TaskRelationSnapshot[];
  readonly resource_creation_evidence: readonly TaskResourceCreationEvidence[];
  readonly issue_history: readonly TaskIssueHistoryEntry[];
  readonly issue_record_observations: readonly TaskIssueRecordObservation[];
}

export type TaskSnapshotObservation = TaskSnapshot | InvalidTaskSnapshot;

export function parseTaskIssueRecordObservation(value: unknown): TaskIssueRecordObservation {
  const record = asRecord(value);
  return "observation_kind" in record
    ? parseInvalidTaskIssueRecord(value)
    : parseTaskIssueRecord(value);
}

export function parseTaskSnapshot(value: unknown): TaskSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, [
    "root_id", "workflow_state_map", "issues", "relations", "resource_creation_evidence",
    "issue_history", "issue_record_observations",
  ]);
  const rootId = parseRootIssueId(record.root_id);
  const states = parseTaskWorkflowStateMap(record.workflow_state_map);
  const issues = parseArray(record.issues, (entry) => parseTaskIssueSnapshot(entry, states));
  const issueIds = new Set(issues.map(({ issue_id }) => issue_id));
  if (issueIds.size !== issues.length) throw new Error("duplicate_issue_identity");
  const rootIssue = issues.find(({ issue_id }) => String(issue_id) === String(rootId));
  if (rootIssue === undefined) throw new Error("missing_root_identity");
  if (rootIssue.kind !== "root" || rootIssue.parent_issue_id !== null) throw new Error("invalid_root_identity");
  for (const issue of issues) {
    if (issue.parent_issue_id !== null && !issueIds.has(issue.parent_issue_id)) {
      throw new Error("unknown_parent_identity");
    }
  }
  const relations = parseArray(record.relations, parseTaskRelationSnapshot);
  if (new Set(relations.map(({ relation_id }) => relation_id)).size !== relations.length) {
    throw new Error("duplicate_relation_identity");
  }
  for (const relation of relations) {
    if (!issueIds.has(relation.source_issue_id) || !issueIds.has(relation.target_issue_id)) {
      throw new Error("unknown_relation_endpoint");
    }
  }
  const creationEvidence = parseArray(record.resource_creation_evidence, parseTaskResourceCreationEvidence);
  if (new Set(creationEvidence.map(({ evidence_id }) => evidence_id)).size !== creationEvidence.length) {
    throw new Error("duplicate_creation_evidence_identity");
  }
  const history = parseArray(record.issue_history, parseTaskIssueHistoryEntry);
  if (history.some(({ issue_id }) => !issueIds.has(issue_id))) throw new Error("unknown_history_issue_identity");
  const recordObservations = parseArray(record.issue_record_observations, parseTaskIssueRecordObservation);
  if (new Set(recordObservations.map(({ record_id }) => record_id)).size !== recordObservations.length) {
    throw new Error("duplicate_record_observation_identity");
  }
  if (recordObservations.some(({ issue_id }) => !issueIds.has(issue_id))) {
    throw new Error("unknown_record_owner_identity");
  }
  return Object.freeze({
    root_id: rootId,
    workflow_state_map: states,
    issues,
    relations,
    resource_creation_evidence: creationEvidence,
    issue_history: history,
    issue_record_observations: recordObservations,
  });
}

export function parseTaskSnapshotObservation(value: unknown): TaskSnapshotObservation {
  const record = asRecord(value);
  return "failure_kind" in record ? parseInvalidTaskSnapshot(value) : parseTaskSnapshot(value);
}
