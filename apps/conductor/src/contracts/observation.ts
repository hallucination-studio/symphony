import {
  parseCorrelationId,
  parseObservationDigest,
  parseProviderEventId,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  parseTaskIssueId,
  parseTaskRelationId,
  parseTaskRevision,
  type CorrelationId,
  type ObservationDigest,
  type ProviderEventId,
  type RepositoryId,
  type Revision,
  type RootIssueId,
  type RuntimeGeneration,
  type SchemaVersion,
  type TaskIssueId,
  type TaskRelationId,
  type TaskRevision,
} from "./identity.js";
import { assertRuntimeTarget, type RuntimeTarget } from "./runtime.js";
import { asRecord, assertExactKeys, parseArray, parseBoundedString, parseEnum, parseStringArray } from "./validation.js";

export const TASK_CHANGE_KINDS = [
  "issue_created", "issue_archived", "field_changed", "relation_added", "relation_removed",
] as const;
export const TASK_FIELDS = [
  "status", "title", "description", "parent", "labels", "delegate", "priority",
] as const;
export const PR_STATES = ["open", "closed", "merged"] as const;

export interface WakeRoot {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly provider_event_id: ProviderEventId;
  readonly received_at: string;
}

export interface TaskIssueSnapshot {
  readonly issue_id: TaskIssueId;
  readonly revision: TaskRevision;
  readonly status: string;
  readonly title: string;
  readonly description: string | null;
  readonly parent_id: TaskIssueId | null;
  readonly labels: readonly string[];
  readonly delegate_id: string | null;
  readonly priority: number | null;
}

export interface TaskRelationSnapshot {
  readonly relation_id: TaskRelationId;
  readonly revision: TaskRevision;
  readonly type: string;
  readonly source_issue_id: TaskIssueId;
  readonly target_issue_id: TaskIssueId;
}

export interface TaskSnapshot {
  readonly root_id: RootIssueId;
  readonly issues: readonly TaskIssueSnapshot[];
  readonly relations: readonly TaskRelationSnapshot[];
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

function parseTaskIssue(value: unknown): TaskIssueSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, [
    "issue_id", "revision", "status", "title", "description", "parent_id", "labels", "delegate_id", "priority",
  ]);
  return Object.freeze({
    issue_id: parseTaskIssueId(record.issue_id),
    revision: parseTaskRevision(record.revision),
    status: parseBoundedString(record.status, "invalid_task_status", 128),
    title: parseText(record.title, "invalid_task_title", 1_024),
    description: parseNullable(record.description, (entry) => parseText(entry, "invalid_task_description", 100_000)),
    parent_id: parseNullable(record.parent_id, parseTaskIssueId),
    labels: parseStringArray(record.labels, (entry) => parseBoundedString(entry, "invalid_task_label", 256), 256),
    delegate_id: parseNullable(record.delegate_id, (entry) => parseBoundedString(entry, "invalid_task_delegate", 256)),
    priority: parsePriority(record.priority),
  });
}

function parseTaskRelation(value: unknown): TaskRelationSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, ["relation_id", "revision", "type", "source_issue_id", "target_issue_id"]);
  const relation = Object.freeze({
    relation_id: parseTaskRelationId(record.relation_id),
    revision: parseTaskRevision(record.revision),
    type: parseBoundedString(record.type, "invalid_task_relation_type", 128),
    source_issue_id: parseTaskIssueId(record.source_issue_id),
    target_issue_id: parseTaskIssueId(record.target_issue_id),
  });
  if (relation.source_issue_id === relation.target_issue_id) throw new Error("self_task_relation");
  return relation;
}

export function parseWakeRoot(value: unknown): WakeRoot {
  const record = asRecord(value);
  assertExactKeys(record, ["schema_version", "root_id", "provider_event_id", "received_at"]);
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: parseRootIssueId(record.root_id),
    provider_event_id: parseProviderEventId(record.provider_event_id),
    received_at: parseTimestamp(record.received_at, "invalid_received_at"),
  });
}

export function parseTaskSnapshot(value: unknown): TaskSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, ["root_id", "issues", "relations"]);
  const rootId = parseRootIssueId(record.root_id);
  const taskRootId = parseTaskIssueId(rootId);
  const issues = parseArray(record.issues, parseTaskIssue);
  const issueIds = new Set(issues.map(({ issue_id }) => issue_id));
  if (issueIds.size !== issues.length) throw new Error("duplicate_issue_identity");
  if (!issueIds.has(taskRootId)) throw new Error("missing_root_identity");
  for (const issue of issues) {
    if (issue.issue_id === taskRootId && issue.parent_id !== null) throw new Error("root_parent_forbidden");
    if (issue.parent_id !== null && !issueIds.has(issue.parent_id)) throw new Error("unknown_parent_identity");
  }
  const relations = parseArray(record.relations, parseTaskRelation);
  if (new Set(relations.map(({ relation_id }) => relation_id)).size !== relations.length) {
    throw new Error("duplicate_relation_identity");
  }
  for (const relation of relations) {
    if (!issueIds.has(relation.source_issue_id) || !issueIds.has(relation.target_issue_id)) {
      throw new Error("unknown_relation_endpoint");
    }
  }
  return Object.freeze({ root_id: rootId, issues, relations });
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

function parseConcreteTaskChange(value: unknown): ConcreteTaskChange {
  const record = asRecord(value);
  const kind = parseEnum(record.kind, TASK_CHANGE_KINDS);
  if (kind === "issue_created" || kind === "issue_archived") {
    assertExactKeys(record, ["kind", "issue"]);
    return Object.freeze({ kind, issue: parseTaskIssue(record.issue) });
  }
  if (kind === "relation_added" || kind === "relation_removed") {
    assertExactKeys(record, ["kind", "relation"]);
    return Object.freeze({ kind, relation: parseTaskRelation(record.relation) });
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
