import {
  parseTaskIssueRecordProjectionMarkdown,
  projectTaskIssueRecord,
} from "../../contracts/cycle-record-markdown.js";
import { parseTaskIssueRecord } from "../../contracts/cycle-records.js";
import {
  parseRootIssueId,
  parseTaskIssueId,
  parseTaskLabelId,
  parseTaskRevision,
  parseTaskStateId,
  type RootIssueId,
  type TaskIssueId,
  type TaskRevision,
} from "../../contracts/identity.js";
import type { TaskChangeOriginEvidence } from "../../contracts/observation.js";
import {
  canonicalTaskRevision,
  parseTaskIssueHistoryEntry,
  parseTaskIssueSnapshotChange,
  parseTaskResourceCreationEvidence,
  parseTaskRelationSnapshot,
  parseTaskSnapshot,
  parseTaskWorkflowStateMap,
  TASK_WORKFLOW_STATUSES,
  type TaskIssueHistoryEntry,
  type TaskIssueRecordObservation,
  type TaskResourceCreationEvidence,
  type TaskKind,
  type TaskIssueSnapshot,
  type TaskRelationSnapshot,
  type TaskSnapshot,
  type TaskWorkflowStateMap,
  type TaskWorkflowStatus,
} from "../../contracts/task-management.js";
import {
  asRecord,
  assertExactKeys,
  parseArray,
  parseBoundedString,
  parseEnum,
} from "../../contracts/validation.js";
import type {
  GetIssueCall,
  GetIssueResult,
  ListChildrenCall,
  ListChildrenResult,
  ListIssuesCall,
  ListIssuesResult,
  ListLabelsCall,
  ListLabelsResult,
  ListRelationsCall,
  ListRelationsResult,
  ListStatesCall,
  ListStatesResult,
  TaskLabelResource,
  TaskStateResource,
} from "../mcp/TaskMcpSchemas.js";

const INTERNAL_PAGE_SIZE = 50;
const MAX_PAGES = 100;
const MAX_NODES = 5_000;
const KIND_PREFIX = "symphony:kind/";
const ROOT_STATUSES = ["Todo", "In Progress", "In Review", "Done", "Failed"] as const;
const CYCLE_STATUSES = [
  "Draft", "In Progress", "Awaiting Acceptance", "Succeeded", "Rejected", "Failed", "Canceled",
] as const;
const STAGE_KINDS = ["plan", "work", "verify"] as const;
const STAGE_STATUSES = ["Todo", "In Progress", "Done", "Failed", "Canceled"] as const;
const RECORD_KINDS = [
  "root_family_invalidation", "cycle_approval", "stage_completion", "stage_invalidation",
  "cycle_completion", "cycle_invalidation", "delivery_completion", "delivery_invalidation",
] as const;

export interface LinearQueryClient {
  getIssue(issueId: string): Promise<unknown>;
  listIssues(cursor: string | null, pageSize: number): Promise<unknown>;
  listChildren(issueId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listIssueHistory(issueId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listIssueComments(issueId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listRelations(issueId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listStates(teamId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listLabels(teamId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  readViewer(): Promise<unknown>;
}

export interface LinearQueryOptions {
  readonly team_id: string;
  readonly service_actor_id: string;
}

export interface LinearServiceActor {
  readonly actor_id: string;
  readonly active: true;
  readonly app: true;
}

export interface LinearIssueCreationEvidence {
  readonly issue_id: TaskIssueId;
  readonly provider_created_at: string;
  readonly actor_id: string | null;
}

export interface LinearIssueCommentEvidence {
  readonly comment_id: string;
  readonly issue_id: string;
  readonly provider_created_at: string;
  readonly provider_updated_at: string;
  readonly provider_edited_at: string | null;
  readonly provider_archived_at: string | null;
  readonly actor_id: string | null;
  readonly body_digest: string;
}

export interface LinearIssueRecordComment extends LinearIssueCommentEvidence {
  readonly body_markdown: string;
}

export interface LinearIssueHistoryEvidence {
  readonly history_id: string;
  readonly issue_id: string;
  readonly provider_created_at: string;
  readonly provider_updated_at: string;
  readonly actor_id: string | null;
  readonly change_origin: "symphony" | "external" | "unknown";
  readonly changed_fields: readonly string[];
  readonly from_state_id: string | null;
  readonly to_state_id: string | null;
  readonly from_parent_id: string | null;
  readonly to_parent_id: string | null;
  readonly added_label_ids: readonly string[];
  readonly removed_label_ids: readonly string[];
  readonly archived: boolean | null;
  readonly trashed: boolean | null;
  readonly relation_changes: readonly { readonly type: string; readonly related_issue_identifier: string }[];
}

export interface RootInventoryItem {
  readonly root_id: RootIssueId;
  readonly revision: TaskRevision;
  readonly status: typeof ROOT_STATUSES[number];
  readonly priority: number;
  readonly created_at: string;
}

interface LinearIssueRecord {
  readonly issueId: TaskIssueId;
  readonly statusId: ReturnType<typeof parseTaskStateId>;
  readonly title: string;
  readonly descriptionMarkdown: string;
  readonly parentIssueId: TaskIssueId | null;
  readonly labelIds: readonly ReturnType<typeof parseTaskLabelId>[];
  readonly delegateId: string | null;
  readonly priority: number | null;
  readonly teamId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly creatorId: string | null;
  readonly archived: boolean;
  readonly trashed: boolean;
}

interface Page<T> {
  readonly nodes: readonly T[];
  readonly nextCursor: string | null;
}

type StateRecord = TaskStateResource & { readonly team_id: string; readonly archived: boolean };
type LabelRecord = TaskLabelResource & { readonly team_id: string | null };
type HistoryRecord = Omit<LinearIssueHistoryEvidence, "change_origin">;
type CommentRecord = LinearIssueCommentEvidence & { readonly body_markdown: string };

class LinearQueryError extends Error {}

function fail(code: string): never {
  throw new LinearQueryError(code);
}

function providerPayload<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof LinearQueryError) throw error;
    return fail("linear_invalid_payload");
  }
}

function parseNullableText(value: unknown, code: string, max: number): string | null {
  return value === null ? null : parseBoundedString(value, code, max);
}

function parseProviderDescription(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 100_000
    || value.includes("\0")
  ) return fail("invalid_linear_issue_description");
  return value;
}

function parseProviderCommentBody(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 100_000 || value.includes("\0")) {
    return fail("invalid_linear_comment_body");
  }
  return value;
}

function parsePriority(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 4) {
    return fail("linear_invalid_payload");
  }
  return value as number;
}

function parseTimestamp(value: unknown): string {
  const timestamp = parseBoundedString(value, "invalid_linear_timestamp", 64);
  if (Number.isNaN(Date.parse(timestamp))) return fail("linear_invalid_payload");
  return new Date(timestamp).toISOString();
}

function parseIssue(value: unknown): LinearIssueRecord {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, [
      "id", "revision", "team_id", "parent_id", "status", "title", "description", "labels",
      "delegate_id", "priority", "created_at", "updated_at", "creator_id", "archived", "trashed",
    ]);
    const labels = parseArray(record.labels, (label) => parseBoundedString(label, "invalid_linear_label", 256), 256);
    return Object.freeze({
      issueId: parseTaskIssueId(record.id),
      statusId: parseTaskStateId(record.status),
      title: parseBoundedString(record.title, "invalid_linear_issue_title", 1_024),
      descriptionMarkdown: parseProviderDescription(record.description) ?? "# Empty",
      parentIssueId: record.parent_id === null ? null : parseTaskIssueId(record.parent_id),
      labelIds: Object.freeze(labels.map(parseTaskLabelId)),
      delegateId: record.delegate_id === null
        ? null
        : parseBoundedString(record.delegate_id, "invalid_linear_delegate_id", 128),
      priority: parsePriority(record.priority),
      teamId: parseBoundedString(record.team_id, "invalid_linear_team_id", 128),
      createdAt: parseTimestamp(record.created_at),
      updatedAt: parseTimestamp(record.updated_at),
      creatorId: record.creator_id === null
        ? null
        : parseBoundedString(record.creator_id, "invalid_linear_creator_id", 128),
      archived: typeof record.archived === "boolean" ? record.archived : fail("linear_invalid_payload"),
      trashed: typeof record.trashed === "boolean" ? record.trashed : fail("linear_invalid_payload"),
    });
  });
}

function parseRelation(value: unknown, serviceActorId: string): TaskRelationSnapshot {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, [
      "id", "revision", "type", "source_issue_id", "target_issue_id", "created_at", "updated_at", "archived",
    ]);
    const providerCreatedAt = parseTimestamp(record.created_at);
    const providerUpdatedAt = parseTimestamp(record.updated_at);
    if (typeof record.archived !== "boolean") fail("linear_invalid_payload");
    if (record.archived) fail("linear_archived_relation");
    const fields = {
      relation_id: record.id,
      provider_created_at: providerCreatedAt,
      provider_updated_at: providerUpdatedAt,
      creation_actor_id: serviceActorId,
      creation_evidence_id: `linear:relation:${String(record.id)}`,
      type: record.type,
      source_issue_id: record.source_issue_id,
      target_issue_id: record.target_issue_id,
    };
    return parseTaskRelationSnapshot({ ...fields, revision: canonicalTaskRevision(fields) });
  });
}

function parseState(value: unknown): StateRecord {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, ["id", "revision", "name", "team_id", "archived"]);
    if (typeof record.archived !== "boolean") return fail("linear_invalid_payload");
    return Object.freeze({
      state_id: parseTaskStateId(record.id),
      revision: parseTaskRevision(record.revision),
      name: parseBoundedString(record.name, "invalid_linear_state_name", 256),
      team_id: parseBoundedString(record.team_id, "invalid_linear_team_id", 128),
      archived: record.archived,
    });
  });
}

function parseLabel(value: unknown): LabelRecord {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, ["id", "revision", "name", "team_id"]);
    return Object.freeze({
      label_id: parseTaskLabelId(record.id),
      revision: parseTaskRevision(record.revision),
      name: parseBoundedString(record.name, "invalid_linear_label_name", 256),
      team_id: record.team_id === null
        ? null
        : parseBoundedString(record.team_id, "invalid_linear_team_id", 128),
    });
  });
}

function parseNullableBoolean(value: unknown): boolean | null {
  if (value === null) return null;
  return typeof value === "boolean" ? value : fail("linear_invalid_payload");
}

function parseHistory(value: unknown): HistoryRecord {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, [
      "id", "issue_id", "created_at", "updated_at", "actor_id", "changed_fields", "from_state_id",
      "to_state_id", "from_parent_id", "to_parent_id", "added_label_ids", "removed_label_ids", "archived",
      "trashed", "relation_changes",
    ]);
    const nullableId = (entry: unknown) => entry === null
      ? null
      : parseBoundedString(entry, "invalid_linear_identity", 128);
    const relationChanges = parseArray(record.relation_changes, (entry) => {
      const change = asRecord(entry);
      assertExactKeys(change, ["type", "related_issue_identifier"]);
      return Object.freeze({
        type: parseBoundedString(change.type, "invalid_linear_relation_type", 64),
        related_issue_identifier: parseBoundedString(
          change.related_issue_identifier,
          "invalid_linear_related_issue",
          128,
        ),
      });
    }, 64);
    const changedFields = parseArray(
      record.changed_fields,
      (entry) => parseBoundedString(entry, "invalid_linear_history_field", 32),
      16,
    );
    if (changedFields.length === 0) fail("linear_empty_history_entry");
    return Object.freeze({
      history_id: parseBoundedString(record.id, "invalid_linear_history_id", 128),
      issue_id: parseBoundedString(record.issue_id, "invalid_linear_issue_id", 128),
      provider_created_at: parseTimestamp(record.created_at),
      provider_updated_at: parseTimestamp(record.updated_at),
      actor_id: nullableId(record.actor_id),
      changed_fields: changedFields,
      from_state_id: nullableId(record.from_state_id),
      to_state_id: nullableId(record.to_state_id),
      from_parent_id: nullableId(record.from_parent_id),
      to_parent_id: nullableId(record.to_parent_id),
      added_label_ids: parseArray(record.added_label_ids, (entry) => parseBoundedString(entry, "invalid_linear_label", 128), 32),
      removed_label_ids: parseArray(record.removed_label_ids, (entry) => parseBoundedString(entry, "invalid_linear_label", 128), 32),
      archived: parseNullableBoolean(record.archived),
      trashed: parseNullableBoolean(record.trashed),
      relation_changes: relationChanges,
    });
  });
}

function parseComment(value: unknown): CommentRecord {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, [
      "id", "issue_id", "created_at", "updated_at", "edited_at", "archived_at", "actor_id",
      "body_markdown", "body_digest",
    ]);
    const nullableTimestamp = (entry: unknown) => entry === null ? null : parseTimestamp(entry);
    const digest = parseBoundedString(record.body_digest, "invalid_linear_comment_digest", 64);
    if (!/^[0-9a-f]{64}$/u.test(digest)) fail("linear_invalid_payload");
    return Object.freeze({
      comment_id: parseBoundedString(record.id, "invalid_linear_comment_id", 128),
      issue_id: parseBoundedString(record.issue_id, "invalid_linear_issue_id", 128),
      provider_created_at: parseTimestamp(record.created_at),
      provider_updated_at: parseTimestamp(record.updated_at),
      provider_edited_at: nullableTimestamp(record.edited_at),
      provider_archived_at: nullableTimestamp(record.archived_at),
      actor_id: record.actor_id === null ? null : parseBoundedString(record.actor_id, "invalid_linear_actor_id", 128),
      body_markdown: parseProviderCommentBody(record.body_markdown),
      body_digest: digest,
    });
  });
}

function parsePage<T>(value: unknown, parser: (entry: unknown) => T, limit: number): Page<T> {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, ["nodes", "page_info"]);
    const nodes = parseArray(record.nodes, parser, limit);
    const pageInfo = asRecord(record.page_info);
    assertExactKeys(pageInfo, ["has_next_page", "end_cursor"]);
    if (typeof pageInfo.has_next_page !== "boolean") return fail("linear_invalid_payload");
    const endCursor = parseNullableText(pageInfo.end_cursor, "invalid_linear_cursor", 512);
    if (pageInfo.has_next_page && endCursor === null) return fail("linear_incomplete_page");
    return Object.freeze({ nodes, nextCursor: pageInfo.has_next_page ? endCursor : null });
  });
}

type QueryCall = GetIssueCall | ListIssuesCall | ListChildrenCall | ListRelationsCall | ListStatesCall | ListLabelsCall;

function resultEnvelope<C extends QueryCall>(call: C): Omit<C, "input"> {
  return {
    schema_version: call.schema_version,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
  } as Omit<C, "input">;
}

function issueKind(
  issue: LinearIssueRecord,
  labelNames: ReadonlyMap<string, string>,
): TaskKind | null {
  for (const labelId of issue.labelIds) {
    if (!labelNames.has(labelId)) return fail("linear_unknown_label_identity");
  }
  const kindLabels = issue.labelIds
    .map((labelId) => labelNames.get(labelId))
    .filter((name): name is string => name?.startsWith(KIND_PREFIX) === true);
  if (kindLabels.length === 0) return null;
  if (kindLabels.length !== 1) return fail("linear_ambiguous_kind");
  const kind = kindLabels[0]?.slice(KIND_PREFIX.length);
  if (kind === "root" || kind === "cycle" || STAGE_KINDS.includes(kind as typeof STAGE_KINDS[number])) {
    return kind as "root" | "cycle" | typeof STAGE_KINDS[number];
  }
  return fail("linear_invalid_kind");
}

function normalizedIssue(
  issue: LinearIssueRecord,
  stateNames: ReadonlyMap<string, string>,
  labelNames: ReadonlyMap<string, string>,
): TaskIssueSnapshot {
  const status = parseProviderEnum(stateNames.get(issue.statusId), [
    "Todo", "Draft", "In Progress", "Awaiting Acceptance", "In Review", "Done",
    "Succeeded", "Rejected", "Failed", "Canceled",
  ] as const) as TaskWorkflowStatus;
  const kind = issueKind(issue, labelNames);
  if (kind === null) return fail("linear_missing_kind");
  const fields = {
    issue_id: issue.issueId,
    provider_created_at: issue.createdAt,
    provider_updated_at: issue.updatedAt,
    creation_actor_id: issue.creatorId ?? fail("linear_missing_issue_creator"),
    kind,
    status_id: issue.statusId,
    status,
    title: issue.title,
    description_markdown: issue.descriptionMarkdown,
    parent_issue_id: issue.parentIssueId,
    label_ids: issue.labelIds,
    delegate_id: issue.delegateId,
    priority: issue.priority,
    archived: issue.archived,
    trashed: issue.trashed,
  };
  return parseTaskIssueSnapshotChange({ ...fields, revision: canonicalTaskRevision(fields) });
}

function parseProviderEnum<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  return providerPayload(() => parseEnum(value, allowed));
}

function historyStatus(
  stateNames: ReadonlyMap<string, string>,
  stateId: string | null,
): typeof TASK_WORKFLOW_STATUSES[number] | null {
  if (stateId === null) return null;
  const name = stateNames.get(stateId);
  if (name === undefined) fail("linear_unknown_history_state");
  return parseProviderEnum(name, TASK_WORKFLOW_STATUSES);
}

function normalizedHistory(
  entry: LinearIssueHistoryEvidence,
  stateNames: ReadonlyMap<string, string>,
): TaskIssueHistoryEntry {
  return parseTaskIssueHistoryEntry({
    history_id: entry.history_id,
    issue_id: parseTaskIssueId(entry.issue_id),
    provider_created_at: entry.provider_created_at,
    provider_updated_at: entry.provider_updated_at,
    actor_id: entry.actor_id,
    change_origin: entry.change_origin,
    changed_fields: entry.changed_fields,
    from_status: historyStatus(stateNames, entry.from_state_id),
    to_status: historyStatus(stateNames, entry.to_state_id),
    from_parent_issue_id: entry.from_parent_id === null ? null : parseTaskIssueId(entry.from_parent_id),
    to_parent_issue_id: entry.to_parent_id === null ? null : parseTaskIssueId(entry.to_parent_id),
    added_label_ids: entry.added_label_ids.map(parseTaskLabelId),
    removed_label_ids: entry.removed_label_ids.map(parseTaskLabelId),
    archived: entry.archived,
    trashed: entry.trashed,
    relation_changes: entry.relation_changes,
  });
}

function issueCreationEvidence(evidence: LinearIssueCreationEvidence): TaskResourceCreationEvidence {
  const fields = {
    evidence_id: `linear:issue:${String(evidence.issue_id)}`,
    resource_kind: "issue" as const,
    resource_id: evidence.issue_id,
    creation_actor_id: evidence.actor_id ?? fail("linear_missing_issue_creator"),
    provider_created_at: evidence.provider_created_at,
    evidence_source: "current_resource" as const,
  };
  return parseTaskResourceCreationEvidence({
    ...fields,
    canonical_evidence_digest: canonicalTaskRevision(fields),
  });
}

function relationCreationEvidence(relation: TaskRelationSnapshot): TaskResourceCreationEvidence {
  const fields = {
    evidence_id: relation.creation_evidence_id,
    resource_kind: "relation" as const,
    resource_id: relation.relation_id,
    creation_actor_id: relation.creation_actor_id,
    provider_created_at: relation.provider_created_at,
    evidence_source: "current_resource" as const,
  };
  return parseTaskResourceCreationEvidence({
    ...fields,
    canonical_evidence_digest: canonicalTaskRevision(fields),
  });
}

function recordKind(projection: Record<string, unknown>): typeof RECORD_KINDS[number] | null {
  try {
    return parseEnum(projection.record_kind, RECORD_KINDS);
  } catch {
    return null;
  }
}

function recordObservation(comment: CommentRecord): TaskIssueRecordObservation | null {
  let projection: Record<string, unknown>;
  try {
    projection = parseTaskIssueRecordProjectionMarkdown(comment.body_markdown);
  } catch {
    return null;
  }
  const expectedRecordKind = recordKind(projection);
  if (expectedRecordKind === null) return null;
  const providerEvidence = {
    comment_id: comment.comment_id,
    issue_id: comment.issue_id,
    provider_created_at: comment.provider_created_at,
    provider_updated_at: comment.provider_updated_at,
    provider_edited_at: comment.provider_edited_at,
    provider_archived_at: comment.provider_archived_at,
    actor_id: comment.actor_id,
    body_digest: comment.body_digest,
  };
  try {
    const projected = projectTaskIssueRecord(comment.body_markdown, providerEvidence);
    return parseTaskIssueRecord(projected);
  } catch {
    const observationKind = comment.provider_archived_at !== null
      ? "archived" as const
      : comment.provider_edited_at !== null || comment.provider_updated_at !== comment.provider_created_at
        ? "updated" as const
        : "malformed" as const;
    return Object.freeze({
      record_id: comment.comment_id,
      issue_id: parseTaskIssueId(comment.issue_id),
      expected_record_kind: expectedRecordKind,
      observation_kind: observationKind,
      provider_created_at: comment.provider_created_at,
      provider_updated_at: comment.provider_updated_at,
      archived_at: comment.provider_archived_at,
      observed_body_digest: comment.body_digest,
      parse_error_code: observationKind === "archived"
        ? "record_archived"
        : observationKind === "updated" ? "record_updated" : "record_malformed",
    });
  }
}

export class LinearQueries {
  readonly #teamId: string;
  readonly #serviceActorId: string;

  constructor(private readonly client: LinearQueryClient, options: LinearQueryOptions) {
    this.#teamId = parseBoundedString(options.team_id, "invalid_linear_team_id", 128);
    this.#serviceActorId = parseBoundedString(options.service_actor_id, "invalid_linear_service_actor_id", 128);
  }

  readServiceActor(): Promise<LinearServiceActor> {
    return this.#boundary(async () => {
      const record = asRecord(await this.client.readViewer());
      assertExactKeys(record, ["id", "active", "app"]);
      if (record.id !== this.#serviceActorId || record.active !== true || record.app !== true) {
        fail("linear_service_actor_unsupported");
      }
      return Object.freeze({ actor_id: this.#serviceActorId, active: true, app: true });
    });
  }

  readIssueSnapshot(issueId: TaskIssueId): Promise<TaskIssueSnapshot | null> {
    return this.#boundary(async () => {
      const parsedIssueId = parseTaskIssueId(issueId);
      const issue = await this.#optionalIssue(parsedIssueId);
      if (issue === null) return null;
      this.#assertTeam([issue]);
      if (issue.issueId !== parsedIssueId) fail("linear_issue_identity_mismatch");
      return normalizedIssue(issue, await this.#stateNames(), await this.#labelNames());
    });
  }

  readIssueCreationEvidence(issueId: TaskIssueId): Promise<LinearIssueCreationEvidence> {
    return this.#boundary(() => this.#readIssueCreationEvidence(parseTaskIssueId(issueId)));
  }

  readIssueHistory(issueId: TaskIssueId): Promise<readonly LinearIssueHistoryEvidence[]> {
    return this.#boundary(() => this.#readIssueHistory(parseTaskIssueId(issueId)));
  }

  readLatestIssueChangeOrigin(issueId: TaskIssueId): Promise<TaskChangeOriginEvidence | null> {
    return this.#boundary(async () => {
      const page = parsePage(await this.client.listIssueHistory(issueId, null, 1), parseHistory, 1);
      const entry = page.nodes[0];
      if (entry === undefined) return null;
      if (entry.issue_id !== issueId) fail("linear_history_issue_mismatch");
      return Object.freeze({
        issue_id: parseTaskIssueId(entry.issue_id),
        change_origin: entry.actor_id === null
          ? "unknown" as const
          : entry.actor_id === this.#serviceActorId ? "symphony" as const : "external" as const,
        changed_fields: entry.changed_fields,
      });
    });
  }

  readIssueComments(issueId: TaskIssueId): Promise<readonly LinearIssueCommentEvidence[]> {
    return this.#boundary(() => this.#readIssueComments(parseTaskIssueId(issueId)));
  }

  readIssueRecordComments(issueId: TaskIssueId): Promise<readonly LinearIssueRecordComment[]> {
    return this.#boundary(() => this.#readIssueRecordComments(parseTaskIssueId(issueId)));
  }

  get_issue(call: GetIssueCall): Promise<GetIssueResult> {
    return this.#boundary(async () => {
      const issue = await this.#optionalIssue(call.input.issue_id);
      if (issue === null) {
        return Object.freeze({
          ...resultEnvelope(call),
          output: Object.freeze({ issue: null }),
        });
      }
      this.#assertTeam([issue]);
      if (issue.issueId !== call.input.issue_id) fail("linear_issue_identity_mismatch");
      const snapshot = normalizedIssue(issue, await this.#stateNames(), await this.#labelNames());
      return Object.freeze({
        ...resultEnvelope(call),
        output: Object.freeze({ issue: snapshot }),
      });
    });
  }

  list_issues(call: ListIssuesCall): Promise<ListIssuesResult> {
    return this.#boundary(async () => {
      const page = parsePage(
        await this.client.listIssues(call.input.cursor, call.input.page_size),
        parseIssue,
        call.input.page_size,
      );
      const teamIssues = page.nodes.filter(({ teamId }) => teamId === this.#teamId);
      const stateNames = await this.#stateNames();
      const labelNames = await this.#labelNames();
      return Object.freeze({ ...resultEnvelope(call), output: Object.freeze({
        issues: Object.freeze(teamIssues.map((issue) => normalizedIssue(issue, stateNames, labelNames))),
        next_cursor: page.nextCursor,
      }) });
    });
  }

  list_children(call: ListChildrenCall): Promise<ListChildrenResult> {
    return this.#boundary(async () => {
      const page = parsePage(
        await this.client.listChildren(call.input.parent_issue_id, call.input.cursor, call.input.page_size),
        parseIssue,
        call.input.page_size,
      );
      this.#assertTeam(page.nodes);
      for (const child of page.nodes) {
        if (child.parentIssueId !== call.input.parent_issue_id) fail("linear_child_parent_mismatch");
      }
      const stateNames = await this.#stateNames();
      const labelNames = await this.#labelNames();
      return Object.freeze({ ...resultEnvelope(call), output: Object.freeze({
        issues: Object.freeze(page.nodes.map((issue) => normalizedIssue(issue, stateNames, labelNames))),
        next_cursor: page.nextCursor,
      }) });
    });
  }

  list_relations(call: ListRelationsCall): Promise<ListRelationsResult> {
    return this.#boundary(async () => {
      const page = parsePage(
        await this.client.listRelations(call.input.issue_id, call.input.cursor, call.input.page_size),
        (entry) => parseRelation(entry, this.#serviceActorId),
        call.input.page_size,
      );
      for (const relation of page.nodes) {
        if (relation.source_issue_id !== call.input.issue_id && relation.target_issue_id !== call.input.issue_id) {
          fail("linear_relation_identity_mismatch");
        }
      }
      return Object.freeze({ ...resultEnvelope(call), output: Object.freeze({
        relations: page.nodes,
        next_cursor: page.nextCursor,
      }) });
    });
  }

  list_states(call: ListStatesCall): Promise<ListStatesResult> {
    return this.#boundary(async () => {
      const page = parsePage(
        await this.client.listStates(this.#teamId, call.input.cursor, call.input.page_size),
        parseState,
        call.input.page_size,
      );
      for (const state of page.nodes) if (state.team_id !== this.#teamId) fail("linear_team_mismatch");
      return Object.freeze({ ...resultEnvelope(call), output: Object.freeze({
        states: Object.freeze(page.nodes.map((state) => Object.freeze({
          state_id: state.state_id,
          revision: state.revision,
          name: state.name,
          archived: state.archived,
        }))),
        next_cursor: page.nextCursor,
      }) });
    });
  }

  list_labels(call: ListLabelsCall): Promise<ListLabelsResult> {
    return this.#boundary(async () => {
      const page = parsePage(
        await this.client.listLabels(this.#teamId, call.input.cursor, call.input.page_size),
        parseLabel,
        call.input.page_size,
      );
      for (const label of page.nodes) {
        if (label.team_id !== null && label.team_id !== this.#teamId) fail("linear_team_mismatch");
      }
      return Object.freeze({ ...resultEnvelope(call), output: Object.freeze({
        labels: Object.freeze(page.nodes.map((label) => Object.freeze({
          label_id: label.label_id,
          revision: label.revision,
          name: label.name,
        }))),
        next_cursor: page.nextCursor,
      }) });
    });
  }

  inventoryRoots(): Promise<readonly RootInventoryItem[]> {
    return this.#boundary(async () => {
      const issues = await this.#all(
        (cursor) => this.client.listIssues(cursor, INTERNAL_PAGE_SIZE),
        parseIssue,
      );
      this.#assertUniqueIssues(issues);
      const teamIssues = issues.filter(({ teamId }) => teamId === this.#teamId);
      const labelNames = await this.#labelNames();
      const stateNames = await this.#stateNames();
      const roots: RootInventoryItem[] = [];
      for (const issue of teamIssues) {
        if (issueKind(issue, labelNames) !== "root") continue;
        if (issue.parentIssueId !== null) fail("linear_root_has_parent");
        const snapshot = normalizedIssue(issue, stateNames, labelNames);
        roots.push(Object.freeze({
          root_id: parseRootIssueId(snapshot.issue_id),
          revision: snapshot.revision,
          status: parseProviderEnum(stateNames.get(snapshot.status_id), ROOT_STATUSES),
          priority: snapshot.priority ?? 0,
          created_at: issue.createdAt,
        }));
      }
      roots.sort((left, right) => left.priority - right.priority
        || left.created_at.localeCompare(right.created_at)
        || left.root_id.localeCompare(right.root_id));
      return Object.freeze(roots);
    });
  }

  readRootSnapshot(rootId: RootIssueId): Promise<TaskSnapshot> {
    return this.#boundary(async () => {
      const parsedRootId = parseRootIssueId(rootId);
      const labelNames = await this.#labelNames();
      const stateNames = await this.#stateNames();
      const root = await this.#issue(parseTaskIssueId(parsedRootId));
      this.#assertTeam([root]);
      if (root.issueId !== parseTaskIssueId(parsedRootId)) fail("linear_root_identity_mismatch");
      if (root.parentIssueId !== null) fail("linear_root_has_parent");
      if (issueKind(root, labelNames) !== "root") fail("linear_root_kind_mismatch");
      parseProviderEnum(stateNames.get(root.statusId), ROOT_STATUSES);

      const cycles = await this.#children(root.issueId);
      this.#assertUniqueIssues(cycles);
      const issues = [root];
      for (const cycle of cycles) {
        if (cycle.parentIssueId !== root.issueId) fail("linear_cycle_parent_mismatch");
        if (issueKind(cycle, labelNames) !== "cycle") fail("linear_cycle_kind_mismatch");
        parseProviderEnum(stateNames.get(cycle.statusId), CYCLE_STATUSES);
        const stages = await this.#children(cycle.issueId);
        this.#assertUniqueIssues(stages);
        for (const stage of stages) {
          if (stage.parentIssueId !== cycle.issueId) fail("linear_stage_parent_mismatch");
          if (stage.creatorId !== this.#serviceActorId) fail("linear_stage_creator_mismatch");
          if (!STAGE_KINDS.includes(issueKind(stage, labelNames) as typeof STAGE_KINDS[number])) {
            fail("linear_stage_kind_mismatch");
          }
          parseProviderEnum(stateNames.get(stage.statusId), STAGE_STATUSES);
          if ((await this.#children(stage.issueId)).length !== 0) fail("linear_stage_has_children");
        }
        issues.push(cycle, ...stages);
      }
      this.#assertUniqueIssues(issues);

      const relations = new Map<string, TaskRelationSnapshot>();
      for (const issue of issues) {
        for (const relation of await this.#relations(issue.issueId)) {
          const current = relations.get(relation.relation_id);
          if (current && (
            current.revision !== relation.revision
            || current.type !== relation.type
            || current.source_issue_id !== relation.source_issue_id
            || current.target_issue_id !== relation.target_issue_id
          )) fail("linear_relation_identity_conflict");
          relations.set(relation.relation_id, relation);
        }
      }
      const issueIds = new Set(issues.map(({ issueId }) => issueId));
      for (const relation of relations.values()) {
        if (!issueIds.has(relation.source_issue_id) || !issueIds.has(relation.target_issue_id)) {
          fail("linear_external_relation");
        }
      }
      const issueFacts = await Promise.all(issues.map(async (issue) => {
        const [history, comments] = await Promise.all([
          this.#readIssueHistory(issue.issueId),
          this.#readIssueRecordComments(issue.issueId),
        ]);
        return Object.freeze({
          issue,
          creation: Object.freeze({
            issue_id: issue.issueId,
            provider_created_at: issue.createdAt,
            actor_id: issue.creatorId,
          }),
          history,
          comments,
        });
      }));
      const normalizedHistories = issueFacts
        .flatMap(({ history }) => history.map((entry) => normalizedHistory(entry, stateNames)))
        .sort((left, right) => left.history_id.localeCompare(right.history_id));
      const creationEvidence = [
        ...issueFacts.map(({ creation }) => issueCreationEvidence(creation)),
        ...[...relations.values()].map(relationCreationEvidence),
      ].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
      const recordObservations = issueFacts
        .flatMap(({ comments }) => comments.map(recordObservation).filter(
          (observation): observation is TaskIssueRecordObservation => observation !== null,
        ))
        .sort((left, right) => left.record_id.localeCompare(right.record_id));
      return parseTaskSnapshot({
        root_id: parsedRootId,
        workflow_state_map: await this.#workflowStateMap(),
        issues: issues.map((issue) => normalizedIssue(issue, stateNames, labelNames))
          .sort((left, right) => left.issue_id.localeCompare(right.issue_id)),
        relations: [...relations.values()].sort((left, right) => left.relation_id.localeCompare(right.relation_id)),
        resource_creation_evidence: creationEvidence,
        issue_history: normalizedHistories,
        issue_record_observations: recordObservations,
      });
    });
  }

  async #readIssueCreationEvidence(issueId: TaskIssueId): Promise<LinearIssueCreationEvidence> {
    const issue = await this.#issue(issueId);
    this.#assertTeam([issue]);
    if (issue.issueId !== issueId) fail("linear_issue_identity_mismatch");
    return Object.freeze({
      issue_id: issue.issueId,
      provider_created_at: issue.createdAt,
      actor_id: issue.creatorId,
    });
  }

  async #readIssueHistory(issueId: TaskIssueId): Promise<readonly LinearIssueHistoryEvidence[]> {
    const history = await this.#all(
      (cursor) => this.client.listIssueHistory(issueId, cursor, INTERNAL_PAGE_SIZE),
      parseHistory,
    );
    this.#assertUnique(history.map(({ history_id }) => history_id), "linear_duplicate_history_identity");
    return Object.freeze(history.map((entry) => {
      if (entry.issue_id !== issueId) fail("linear_history_issue_mismatch");
      return Object.freeze({
        ...entry,
        change_origin: entry.actor_id === null
          ? "unknown" as const
          : entry.actor_id === this.#serviceActorId ? "symphony" as const : "external" as const,
      });
    }));
  }

  async #readIssueComments(issueId: TaskIssueId): Promise<readonly LinearIssueCommentEvidence[]> {
    const comments = await this.#all(
      (cursor) => this.client.listIssueComments(issueId, cursor, INTERNAL_PAGE_SIZE),
      parseComment,
    );
    this.#assertUnique(comments.map(({ comment_id }) => comment_id), "linear_duplicate_comment_identity");
    return Object.freeze(comments.map((comment) => {
      if (comment.issue_id !== issueId) fail("linear_comment_issue_mismatch");
      return Object.freeze({
        comment_id: comment.comment_id,
        issue_id: comment.issue_id,
        provider_created_at: comment.provider_created_at,
        provider_updated_at: comment.provider_updated_at,
        provider_edited_at: comment.provider_edited_at,
        provider_archived_at: comment.provider_archived_at,
        actor_id: comment.actor_id,
        body_digest: comment.body_digest,
      });
    }));
  }

  async #readIssueRecordComments(issueId: TaskIssueId): Promise<readonly LinearIssueRecordComment[]> {
    const comments = await this.#all(
      (cursor) => this.client.listIssueComments(issueId, cursor, INTERNAL_PAGE_SIZE),
      parseComment,
    );
    this.#assertUnique(comments.map(({ comment_id }) => comment_id), "linear_duplicate_comment_identity");
    return Object.freeze(comments.map((comment) => {
      if (comment.issue_id !== issueId) fail("linear_comment_issue_mismatch");
      return Object.freeze({ ...comment });
    }));
  }

  async #issue(issueId: TaskIssueId): Promise<LinearIssueRecord> {
    return (await this.#optionalIssue(issueId)) ?? fail("linear_invalid_payload");
  }

  async #optionalIssue(issueId: TaskIssueId): Promise<LinearIssueRecord | null> {
    const value = await this.client.getIssue(issueId);
    return value === null ? null : parseIssue(value);
  }

  #children(issueId: TaskIssueId): Promise<readonly LinearIssueRecord[]> {
    return this.#all((cursor) => this.client.listChildren(issueId, cursor, INTERNAL_PAGE_SIZE), parseIssue);
  }

  #relations(issueId: TaskIssueId): Promise<readonly TaskRelationSnapshot[]> {
    return this.#all(
      (cursor) => this.client.listRelations(issueId, cursor, INTERNAL_PAGE_SIZE),
      (entry) => parseRelation(entry, this.#serviceActorId),
    );
  }

  async #stateNames(): Promise<ReadonlyMap<string, string>> {
    const states = await this.#all(
      (cursor) => this.client.listStates(this.#teamId, cursor, INTERNAL_PAGE_SIZE),
      parseState,
    );
    const names = new Map<string, string>();
    for (const state of states) {
      if (state.team_id !== this.#teamId) fail("linear_team_mismatch");
      if (names.has(state.state_id)) fail("linear_duplicate_state_identity");
      names.set(state.state_id, state.name);
    }
    return names;
  }

  async #workflowStateMap(): Promise<TaskWorkflowStateMap> {
    const states = await this.#all(
      (cursor) => this.client.listStates(this.#teamId, cursor, INTERNAL_PAGE_SIZE),
      parseState,
    );
    const byName = new Map<string, StateRecord>();
    for (const state of states) {
      if (state.team_id !== this.#teamId) fail("linear_team_mismatch");
      if (state.archived) continue;
      if (byName.has(state.name)) fail("linear_duplicate_state_name");
      byName.set(state.name, state);
    }
    const stateId = (name: TaskWorkflowStatus) => byName.get(name)?.state_id
      ?? fail("linear_missing_workflow_state");
    const fields = {
      team_id: this.#teamId,
      todo_state_id: stateId("Todo"),
      draft_state_id: stateId("Draft"),
      in_progress_state_id: stateId("In Progress"),
      awaiting_acceptance_state_id: stateId("Awaiting Acceptance"),
      in_review_state_id: stateId("In Review"),
      done_state_id: stateId("Done"),
      succeeded_state_id: stateId("Succeeded"),
      rejected_state_id: stateId("Rejected"),
      failed_state_id: stateId("Failed"),
      canceled_state_id: stateId("Canceled"),
    };
    return parseTaskWorkflowStateMap({ ...fields, revision: canonicalTaskRevision(fields) });
  }

  async #labelNames(): Promise<ReadonlyMap<string, string>> {
    const labels = await this.#all(
      (cursor) => this.client.listLabels(this.#teamId, cursor, INTERNAL_PAGE_SIZE),
      parseLabel,
    );
    const names = new Map<string, string>();
    for (const label of labels) {
      if (label.team_id !== null && label.team_id !== this.#teamId) fail("linear_team_mismatch");
      if (names.has(label.label_id)) fail("linear_duplicate_label_identity");
      names.set(label.label_id, label.name);
    }
    return names;
  }

  async #all<T>(fetch: (cursor: string | null) => Promise<unknown>, parser: (entry: unknown) => T): Promise<readonly T[]> {
    const nodes: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page: Page<T> = parsePage(await fetch(cursor), parser, INTERNAL_PAGE_SIZE);
      nodes.push(...page.nodes);
      if (nodes.length > MAX_NODES) fail("linear_node_limit_exceeded");
      if (page.nextCursor === null) return Object.freeze(nodes);
      if (page.nextCursor === cursor || cursors.has(page.nextCursor)) fail("linear_cursor_cycle");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return fail("linear_page_limit_exceeded");
  }

  #assertTeam(issues: readonly LinearIssueRecord[]): void {
    for (const issue of issues) if (issue.teamId !== this.#teamId) fail("linear_team_mismatch");
  }

  #assertUniqueIssues(issues: readonly LinearIssueRecord[]): void {
    if (new Set(issues.map(({ issueId }) => issueId)).size !== issues.length) {
      fail("linear_duplicate_issue_identity");
    }
  }

  #assertUnique(identities: readonly string[], code: string): void {
    if (new Set(identities).size !== identities.length) fail(code);
  }

  async #boundary<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof LinearQueryError) throw new Error(error.message);
      throw new Error("linear_boundary_unavailable");
    }
  }
}
