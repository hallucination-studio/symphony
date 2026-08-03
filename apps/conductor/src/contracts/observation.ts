import {
  parseCorrelationId,
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  parseTaskIssueId,
  parseTaskDigest,
  type CorrelationId,
  type ObservationDigest,
  type RepositoryId,
  type Revision,
  type RootIssueId,
  type RuntimeGeneration,
  type SchemaVersion,
  type TaskIssueId,
  type TaskDigest,
} from "./identity.js";
import { assertRuntimeTarget, type RuntimeTarget } from "./runtime.js";
import {
  parseTaskIssueSnapshotChange,
  parseTaskRelationSnapshot,
  parseTaskSnapshot,
  type TaskIssueSnapshot,
  type TaskRelationSnapshot,
  type TaskSnapshot,
} from "./task-management.js";
import { asRecord, assertExactKeys, parseArray, parseBoundedString, parseEnum, parseStringArray } from "./validation.js";

export const TASK_CHANGE_KINDS = [
  "issue_created", "issue_archived", "field_changed", "relation_added", "relation_removed",
] as const;
export const TASK_FIELDS = [
  "status", "title", "description", "parent", "labels", "delegate", "priority",
] as const;
export const PR_STATES = ["open", "closed", "merged"] as const;

export interface TaskObservationEvent {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly correlation_id: CorrelationId;
  readonly observed_at: string;
  readonly from_task_digest: TaskDigest | null;
  readonly to_task_digest: TaskDigest;
  readonly task: TaskSnapshot;
  readonly task_changes: readonly ConcreteTaskChange[];
  readonly task_change_origins: readonly TaskChangeOriginEvidence[];
}

export interface TaskChangeOriginEvidence {
  readonly issue_id: TaskIssueId;
  readonly change_origin: "symphony" | "external" | "unknown";
  readonly changed_fields: readonly string[];
}

export interface PullRequestSnapshot {
  readonly provider: string;
  readonly repository_id: RepositoryId;
  readonly base_branch: string;
  readonly head_branch: string;
  readonly state: typeof PR_STATES[number];
  readonly head_revision: Revision;
  readonly url: string;
}

export interface GitSnapshot {
  readonly repository_id: RepositoryId;
  readonly base_branch: string;
  readonly head_branch: string;
  readonly head_revision: Revision | null;
  readonly workspace_state: "clean" | "dirty";
  readonly diff_digest: ObservationDigest;
  readonly pull_request: PullRequestSnapshot | null;
}

export interface RootBootstrap {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly observed_at: string;
  readonly task: TaskSnapshot;
  readonly git: GitSnapshot;
}

type ScalarTaskFieldChange =
  | { readonly kind: "field_changed"; readonly issue_id: TaskIssueId; readonly field: "status" | "title"; readonly before: string; readonly after: string }
  | { readonly kind: "field_changed"; readonly issue_id: TaskIssueId; readonly field: "description"; readonly before: string | null; readonly after: string | null }
  | { readonly kind: "field_changed"; readonly issue_id: TaskIssueId; readonly field: "parent"; readonly before: TaskIssueId | null; readonly after: TaskIssueId | null }
  | { readonly kind: "field_changed"; readonly issue_id: TaskIssueId; readonly field: "labels"; readonly before: readonly string[]; readonly after: readonly string[] }
  | { readonly kind: "field_changed"; readonly issue_id: TaskIssueId; readonly field: "delegate"; readonly before: string | null; readonly after: string | null }
  | { readonly kind: "field_changed"; readonly issue_id: TaskIssueId; readonly field: "priority"; readonly before: number | null; readonly after: number | null };

export type ConcreteTaskChange =
  | { readonly kind: "issue_created" | "issue_archived"; readonly issue: TaskIssueSnapshot }
  | ScalarTaskFieldChange
  | { readonly kind: "relation_added" | "relation_removed"; readonly relation: TaskRelationSnapshot };

export type ConcreteGitChange =
  | { readonly kind: "head_changed"; readonly before: Revision | null; readonly after: Revision | null }
  | { readonly kind: "workspace_changed"; readonly before: "clean" | "dirty"; readonly after: "clean" | "dirty" }
  | { readonly kind: "pull_request_changed"; readonly before: Revision | null; readonly after: Revision | null };

export interface RootFactDiff {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly from_observation_digest: ObservationDigest;
  readonly to_observation_digest: ObservationDigest;
  readonly task_changes: readonly ConcreteTaskChange[];
  readonly git_changes: readonly ConcreteGitChange[];
}

function parseTimestamp(value: unknown, code: string): string {
  const parsed = parseBoundedString(value, code, 64);
  if (Number.isNaN(Date.parse(parsed))) throw new Error(code);
  return parsed;
}

function parseNullable<T>(value: unknown, parser: (input: unknown) => T): T | null {
  return value === null ? null : parser(value);
}

function parseText(value: unknown, code: string, max: number): string {
  if (typeof value !== "string" || value.length > max || /\0/u.test(value)) throw new Error(code);
  return value;
}

function parsePriority(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100) {
    throw new Error("invalid_task_priority");
  }
  return value as number;
}

function parsePullRequest(value: unknown): PullRequestSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, ["provider", "repository_id", "base_branch", "head_branch", "state", "head_revision", "url"]);
  const url = parseBoundedString(record.url, "invalid_pr_url", 2_048);
  if (!URL.canParse(url) || new URL(url).protocol !== "https:") throw new Error("invalid_pr_url");
  return Object.freeze({
    provider: parseBoundedString(record.provider, "invalid_provider", 64),
    repository_id: parseRepositoryId(record.repository_id),
    base_branch: parseBoundedString(record.base_branch, "invalid_base_branch"),
    head_branch: parseBoundedString(record.head_branch, "invalid_head_branch"),
    state: parseEnum(record.state, PR_STATES),
    head_revision: parseRevision(record.head_revision),
    url,
  });
}

export function parseGitSnapshot(value: unknown): GitSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, ["repository_id", "base_branch", "head_branch", "head_revision", "workspace_state", "diff_digest", "pull_request"]);
  return Object.freeze({
    repository_id: parseRepositoryId(record.repository_id),
    base_branch: parseBoundedString(record.base_branch, "invalid_base_branch"),
    head_branch: parseBoundedString(record.head_branch, "invalid_head_branch"),
    head_revision: parseNullable(record.head_revision, parseRevision),
    workspace_state: parseEnum(record.workspace_state, ["clean", "dirty"] as const),
    diff_digest: parseObservationDigest(record.diff_digest),
    pull_request: parseNullable(record.pull_request, parsePullRequest),
  });
}

export function parseRootBootstrap(value: unknown, expected: RuntimeTarget): RootBootstrap {
  const record = asRecord(value);
  assertExactKeys(record, ["schema_version", "root_id", "runtime_generation", "correlation_id", "observed_at", "task", "git"]);
  const rootId = parseRootIssueId(record.root_id);
  const runtimeGeneration = parseRuntimeGeneration(record.runtime_generation);
  assertRuntimeTarget({ root_id: rootId, runtime_generation: runtimeGeneration }, expected);
  const task = parseTaskSnapshot(record.task);
  if (task.root_id !== rootId) throw new Error("bootstrap_root_mismatch");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: rootId,
    runtime_generation: runtimeGeneration,
    correlation_id: parseCorrelationId(record.correlation_id),
    observed_at: parseTimestamp(record.observed_at, "invalid_observed_at"),
    task,
    git: parseGitSnapshot(record.git),
  });
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index])
    : left === right;
}

function parseTaskFieldValue(field: typeof TASK_FIELDS[number], value: unknown): string | number | readonly string[] | null {
  switch (field) {
    case "status": return parseBoundedString(value, "invalid_task_status", 128);
    case "title": return parseText(value, "invalid_task_title", 1_024);
    case "description": return parseNullable(value, (entry) => parseText(entry, "invalid_task_description", 100_000));
    case "parent": return parseNullable(value, parseTaskIssueId);
    case "labels": return parseStringArray(value, (entry) => parseBoundedString(entry, "invalid_task_label", 256));
    case "delegate": return parseNullable(value, (entry) => parseBoundedString(entry, "invalid_task_delegate", 256));
    case "priority": return parsePriority(value);
  }
}

export function parseConcreteTaskChange(value: unknown): ConcreteTaskChange {
  const record = asRecord(value);
  const kind = parseEnum(record.kind, TASK_CHANGE_KINDS);
  if (kind === "issue_created" || kind === "issue_archived") {
    assertExactKeys(record, ["kind", "issue"]);
    return Object.freeze({ kind, issue: parseTaskIssueSnapshotChange(record.issue) });
  }
  if (kind === "relation_added" || kind === "relation_removed") {
    assertExactKeys(record, ["kind", "relation"]);
    return Object.freeze({ kind, relation: parseTaskRelationSnapshot(record.relation) });
  }
  assertExactKeys(record, ["kind", "issue_id", "field", "before", "after"]);
  const field = parseEnum(record.field, TASK_FIELDS);
  const before = parseTaskFieldValue(field, record.before);
  const after = parseTaskFieldValue(field, record.after);
  if (valuesEqual(before, after)) throw new Error("unchanged_task_field");
  return Object.freeze({
    kind,
    issue_id: parseTaskIssueId(record.issue_id),
    field,
    before,
    after,
  }) as ConcreteTaskChange;
}

export function parseTaskObservationEvent(value: unknown): TaskObservationEvent {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version", "root_id", "correlation_id", "observed_at",
    "from_task_digest", "to_task_digest", "task", "task_changes", "task_change_origins",
  ]);
  const rootId = parseRootIssueId(record.root_id);
  const task = parseTaskSnapshot(record.task);
  if (task.root_id !== rootId) throw new Error("task_observation_root_mismatch");
  const fromTaskDigest = parseNullable(record.from_task_digest, parseTaskDigest);
  const toTaskDigest = parseTaskDigest(record.to_task_digest);
  const taskChanges = parseArray(record.task_changes, parseConcreteTaskChange);
  const taskChangeOrigins = parseArray(record.task_change_origins, (entry) => {
    const evidence = asRecord(entry);
    assertExactKeys(evidence, ["issue_id", "change_origin", "changed_fields"]);
    return Object.freeze({
      issue_id: parseTaskIssueId(evidence.issue_id),
      change_origin: parseEnum(evidence.change_origin, ["symphony", "external", "unknown"] as const),
      changed_fields: parseStringArray(evidence.changed_fields, (field) => (
        parseBoundedString(field, "invalid_task_change_origin_field", 64)
      )),
    });
  });
  if (new Set(taskChangeOrigins.map(({ issue_id }) => issue_id)).size !== taskChangeOrigins.length) {
    throw new Error("duplicate_task_change_origin_issue");
  }
  if (fromTaskDigest === toTaskDigest && taskChanges.length > 0) {
    throw new Error("unchanged_task_changes");
  }
  if (fromTaskDigest === null && taskChanges.length > 0) {
    throw new Error("initial_task_changes_forbidden");
  }
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: rootId,
    correlation_id: parseCorrelationId(record.correlation_id),
    observed_at: parseTimestamp(record.observed_at, "invalid_observed_at"),
    from_task_digest: fromTaskDigest,
    to_task_digest: toTaskDigest,
    task,
    task_changes: taskChanges,
    task_change_origins: taskChangeOrigins,
  });
}

function parseConcreteGitChange(value: unknown): ConcreteGitChange {
  const record = asRecord(value);
  const kind = parseEnum(record.kind, ["head_changed", "workspace_changed", "pull_request_changed"] as const);
  assertExactKeys(record, ["kind", "before", "after"]);
  if (kind === "workspace_changed") {
    const before = parseEnum(record.before, ["clean", "dirty"] as const);
    const after = parseEnum(record.after, ["clean", "dirty"] as const);
    if (before === after) throw new Error("unchanged_git_fact");
    return Object.freeze({ kind, before, after });
  }
  const before = parseNullable(record.before, parseRevision);
  const after = parseNullable(record.after, parseRevision);
  if (before === after) throw new Error("unchanged_git_fact");
  return Object.freeze({ kind, before, after });
}

export function parseRootFactDiff(value: unknown, expected: RuntimeTarget): RootFactDiff {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version", "root_id", "runtime_generation", "correlation_id",
    "from_observation_digest", "to_observation_digest", "task_changes", "git_changes",
  ]);
  const rootId = parseRootIssueId(record.root_id);
  const runtimeGeneration = parseRuntimeGeneration(record.runtime_generation);
  assertRuntimeTarget({ root_id: rootId, runtime_generation: runtimeGeneration }, expected);
  const from = parseObservationDigest(record.from_observation_digest);
  const to = parseObservationDigest(record.to_observation_digest);
  if (from === to) throw new Error("unchanged_observation_diff");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: rootId,
    runtime_generation: runtimeGeneration,
    correlation_id: parseCorrelationId(record.correlation_id),
    from_observation_digest: from,
    to_observation_digest: to,
    task_changes: parseArray(record.task_changes, parseConcreteTaskChange),
    git_changes: parseArray(record.git_changes, parseConcreteGitChange),
  });
}
