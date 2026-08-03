import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  parseTaskIssueId,
  parseTaskLabelId,
  parseTaskRelationId,
  parseTaskRevision,
  parseTaskStateId,
  type CorrelationId,
  type RootIssueId,
  type RuntimeGeneration,
  type SchemaVersion,
  type TaskIssueId,
  type TaskLabelId,
  type TaskRelationId,
  type TaskRevision,
  type TaskStateId,
} from "../../contracts/identity.js";
import {
  parseConcreteTaskChange,
  type ConcreteTaskChange,
} from "../../contracts/observation.js";
import {
  parseTaskIssueSnapshotChange,
  parseTaskRelationSnapshot,
  type TaskIssueSnapshot,
  type TaskRelationSnapshot,
} from "../../contracts/task-management.js";
import { assertRuntimeTarget, type RuntimeTarget } from "../../contracts/runtime.js";
import { asRecord, assertExactKeys, parseArray, parseBoundedString, parseEnum, parseStringArray } from "../../contracts/validation.js";

export const TASK_MCP_FUNCTIONS = [
  "get_issue",
  "list_issues",
  "list_children",
  "create_issue",
  "update_issue",
  "archive_issue",
  "list_relations",
  "create_relation",
  "delete_relation",
  "list_states",
  "list_labels",
] as const;

export type TaskMcpPublicFunction = typeof TASK_MCP_FUNCTIONS[number];
export type TaskMcpFunction = TaskMcpPublicFunction | "create_issue_comment";
const TASK_MCP_ALL_FUNCTIONS = [...TASK_MCP_FUNCTIONS, "create_issue_comment"] as const;

export const TASK_MCP_CAPABILITIES = Object.freeze({
  get_issue: "task_manage:get_issue",
  list_issues: "task_manage:list_issues",
  list_children: "task_manage:list_children",
  create_issue: "task_manage:create_issue",
  update_issue: "task_manage:update_issue",
  archive_issue: "task_manage:archive_issue",
  create_issue_comment: "task_manage:create_issue_comment",
  list_relations: "task_manage:list_relations",
  create_relation: "task_manage:create_relation",
  delete_relation: "task_manage:delete_relation",
  list_states: "task_manage:list_states",
  list_labels: "task_manage:list_labels",
} as const satisfies Record<TaskMcpFunction, `task_manage:${TaskMcpFunction}`>);

type TaskMcpCapability<F extends TaskMcpFunction> = typeof TASK_MCP_CAPABILITIES[F];

interface TaskMcpEnvelope<F extends TaskMcpFunction> {
  readonly schema_version: SchemaVersion;
  readonly function: F;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly capability: TaskMcpCapability<F>;
}

interface CursorPageInput {
  readonly cursor: string | null;
  readonly page_size: number;
}

export type GetIssueCall = TaskMcpEnvelope<"get_issue"> & {
  readonly input: { readonly issue_id: TaskIssueId };
};
export type ListIssuesCall = TaskMcpEnvelope<"list_issues"> & { readonly input: CursorPageInput };
export type ListChildrenCall = TaskMcpEnvelope<"list_children"> & {
  readonly input: CursorPageInput & { readonly parent_issue_id: TaskIssueId };
};
export type ListRelationsCall = TaskMcpEnvelope<"list_relations"> & {
  readonly input: CursorPageInput & { readonly issue_id: TaskIssueId };
};
export type ListStatesCall = TaskMcpEnvelope<"list_states"> & { readonly input: CursorPageInput };
export type ListLabelsCall = TaskMcpEnvelope<"list_labels"> & { readonly input: CursorPageInput };

export interface CreateIssueDesired {
  readonly title: string;
  readonly description: string | null;
  readonly state_id: TaskStateId;
  readonly label_ids: readonly TaskLabelId[];
  readonly delegate_id: string | null;
  readonly priority: number | null;
}

export interface UpdateIssueDesired {
  readonly title?: string;
  readonly description?: string | null;
  readonly state_id?: TaskStateId;
  readonly parent_id?: TaskIssueId | null;
  readonly label_ids?: readonly TaskLabelId[];
  readonly delegate_id?: string | null;
  readonly priority?: number | null;
}

export type CreateIssueCall = TaskMcpEnvelope<"create_issue"> & {
  readonly input: {
    readonly issue_id: TaskIssueId;
    readonly parent_issue_id: TaskIssueId;
    readonly expected_parent_revision: TaskRevision;
    readonly desired: CreateIssueDesired;
  };
};
export type UpdateIssueCall = TaskMcpEnvelope<"update_issue"> & {
  readonly input: {
    readonly issue_id: TaskIssueId;
    readonly expected_revision: TaskRevision;
    readonly desired: UpdateIssueDesired;
  };
};
export type ArchiveIssueCall = TaskMcpEnvelope<"archive_issue"> & {
  readonly input: { readonly issue_id: TaskIssueId; readonly expected_revision: TaskRevision };
};
export type CreateIssueCommentCall = TaskMcpEnvelope<"create_issue_comment"> & {
  readonly input: {
    readonly comment_id: string;
    readonly issue_id: TaskIssueId;
    readonly expected_issue_revision: TaskRevision;
    readonly body_markdown: string;
  };
};
export type CreateRelationCall = TaskMcpEnvelope<"create_relation"> & {
  readonly input: {
    readonly relation_id: TaskRelationId;
    readonly relation_type: string;
    readonly source_issue_id: TaskIssueId;
    readonly expected_source_revision: TaskRevision;
    readonly target_issue_id: TaskIssueId;
    readonly expected_target_revision: TaskRevision;
  };
};
export type DeleteRelationCall = TaskMcpEnvelope<"delete_relation"> & {
  readonly input: {
    readonly relation_id: TaskRelationId;
    readonly expected_relation_revision: TaskRevision;
    readonly source_issue_id: TaskIssueId;
    readonly expected_source_revision: TaskRevision;
    readonly target_issue_id: TaskIssueId;
    readonly expected_target_revision: TaskRevision;
  };
};

export type TaskMcpQueryCall =
  | GetIssueCall
  | ListIssuesCall
  | ListChildrenCall
  | ListRelationsCall
  | ListStatesCall
  | ListLabelsCall;

export type TaskMcpMutationCall =
  | CreateIssueCall
  | UpdateIssueCall
  | ArchiveIssueCall
  | CreateRelationCall
  | DeleteRelationCall;

export type TaskMcpWriteCall = TaskMcpMutationCall | CreateIssueCommentCall;
export type TaskMcpCall = TaskMcpQueryCall | TaskMcpWriteCall;

export interface TaskStateResource {
  readonly state_id: TaskStateId;
  readonly revision: TaskRevision;
  readonly name: string;
  readonly archived: boolean;
}

export interface TaskLabelResource {
  readonly label_id: TaskLabelId;
  readonly revision: TaskRevision;
  readonly name: string;
}

export type GetIssueResult = TaskMcpEnvelope<"get_issue"> & {
  readonly output: { readonly issue: TaskIssueSnapshot | null };
};
export type ListIssuesResult = TaskMcpEnvelope<"list_issues"> & {
  readonly output: { readonly issues: readonly TaskIssueSnapshot[]; readonly next_cursor: string | null };
};
export type ListChildrenResult = TaskMcpEnvelope<"list_children"> & {
  readonly output: { readonly issues: readonly TaskIssueSnapshot[]; readonly next_cursor: string | null };
};
export type ListRelationsResult = TaskMcpEnvelope<"list_relations"> & {
  readonly output: { readonly relations: readonly TaskRelationSnapshot[]; readonly next_cursor: string | null };
};
export type ListStatesResult = TaskMcpEnvelope<"list_states"> & {
  readonly output: { readonly states: readonly TaskStateResource[]; readonly next_cursor: string | null };
};
export type ListLabelsResult = TaskMcpEnvelope<"list_labels"> & {
  readonly output: { readonly labels: readonly TaskLabelResource[]; readonly next_cursor: string | null };
};

export type TaskMcpQueryResult =
  | GetIssueResult
  | ListIssuesResult
  | ListChildrenResult
  | ListRelationsResult
  | ListStatesResult
  | ListLabelsResult;

export type TaskMutationTarget =
  | { readonly kind: "issue"; readonly issue_id: TaskIssueId }
  | {
    readonly kind: "relation";
    readonly relation_id: TaskRelationId;
    readonly source_issue_id: TaskIssueId;
    readonly target_issue_id: TaskIssueId;
  };

export interface TaskMutationOutput {
  readonly outcome: "applied" | "not_applied" | "stale_before_effect" | "conflict_observed";
  readonly effect_may_have_occurred: boolean;
  readonly target: TaskMutationTarget;
  readonly fresh_resource: TaskIssueSnapshot | TaskRelationSnapshot | null;
  readonly concrete_diff: readonly ConcreteTaskChange[];
  readonly sanitized_reason: string | null;
}

export interface TaskCommentResource {
  readonly comment_id: string;
  readonly issue_id: TaskIssueId;
  readonly provider_created_at: string;
  readonly provider_updated_at: string;
  readonly provider_edited_at: string | null;
  readonly provider_archived_at: string | null;
  readonly actor_id: string | null;
  readonly body_digest: string;
}

export interface TaskCommentMutationOutput {
  readonly outcome: "applied" | "not_applied" | "stale_before_effect" | "conflict_observed";
  readonly effect_may_have_occurred: boolean;
  readonly target: {
    readonly kind: "comment";
    readonly comment_id: string;
    readonly issue_id: TaskIssueId;
  };
  readonly fresh_comment: TaskCommentResource | null;
  readonly sanitized_reason: string | null;
}

export type CreateIssueResult = TaskMcpEnvelope<"create_issue"> & { readonly output: TaskMutationOutput };
export type UpdateIssueResult = TaskMcpEnvelope<"update_issue"> & { readonly output: TaskMutationOutput };
export type ArchiveIssueResult = TaskMcpEnvelope<"archive_issue"> & { readonly output: TaskMutationOutput };
export type CreateIssueCommentResult = TaskMcpEnvelope<"create_issue_comment"> & {
  readonly output: TaskCommentMutationOutput;
};
export type CreateRelationResult = TaskMcpEnvelope<"create_relation"> & { readonly output: TaskMutationOutput };
export type DeleteRelationResult = TaskMcpEnvelope<"delete_relation"> & { readonly output: TaskMutationOutput };

export type TaskMcpMutationResult =
  | CreateIssueResult
  | UpdateIssueResult
  | ArchiveIssueResult
  | CreateRelationResult
  | DeleteRelationResult;

export type TaskMcpWriteResult = TaskMcpMutationResult | CreateIssueCommentResult;
export type TaskMcpResult = TaskMcpQueryResult | TaskMcpWriteResult;

const ENVELOPE_KEYS = [
  "schema_version", "function", "root_id", "runtime_generation", "correlation_id", "capability",
] as const;

function parseCursor(value: unknown): string | null {
  return value === null ? null : parseBoundedString(value, "invalid_cursor", 512);
}

function parsePageSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
    throw new Error("invalid_page_size");
  }
  return value as number;
}

function parseNullable<T>(value: unknown, parser: (input: unknown) => T): T | null {
  return value === null ? null : parser(value);
}

function parseDescription(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 100_000 || /\0/u.test(value)) {
    throw new Error("invalid_task_description");
  }
  return value;
}

function parseCommentBody(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100_000 || /\0/u.test(value)) {
    throw new Error("invalid_comment_body");
  }
  return value;
}

function parsePriority(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100) {
    throw new Error("invalid_task_priority");
  }
  return value as number;
}

function parseCreateDesired(value: unknown): CreateIssueDesired {
  const record = asRecord(value);
  assertExactKeys(record, ["title", "description", "state_id", "label_ids", "delegate_id", "priority"]);
  return Object.freeze({
    title: parseBoundedString(record.title, "invalid_task_title", 1_024),
    description: parseDescription(record.description),
    state_id: parseTaskStateId(record.state_id),
    label_ids: parseStringArray(record.label_ids, parseTaskLabelId, 256) as readonly TaskLabelId[],
    delegate_id: parseNullable(record.delegate_id, (entry) => parseBoundedString(entry, "invalid_task_delegate", 256)),
    priority: parsePriority(record.priority),
  });
}

const UPDATE_FIELDS = [
  "title", "description", "state_id", "parent_id", "label_ids", "delegate_id", "priority",
] as const;

function parseUpdateDesired(value: unknown): UpdateIssueDesired {
  const record = asRecord(value);
  const keys = Object.keys(record);
  if (keys.some((key) => !UPDATE_FIELDS.includes(key as typeof UPDATE_FIELDS[number]))) {
    throw new Error("invalid_contract_keys");
  }
  if (keys.length !== 1) throw new Error(keys.length === 0 ? "empty_issue_update" : "compound_issue_update");
  const desired: Record<string, unknown> = {};
  if ("title" in record) desired.title = parseBoundedString(record.title, "invalid_task_title", 1_024);
  if ("description" in record) desired.description = parseDescription(record.description);
  if ("state_id" in record) desired.state_id = parseTaskStateId(record.state_id);
  if ("parent_id" in record) desired.parent_id = parseNullable(record.parent_id, parseTaskIssueId);
  if ("label_ids" in record) desired.label_ids = parseStringArray(record.label_ids, parseTaskLabelId, 256);
  if ("delegate_id" in record) {
    desired.delegate_id = parseNullable(record.delegate_id, (entry) => parseBoundedString(entry, "invalid_task_delegate", 256));
  }
  if ("priority" in record) desired.priority = parsePriority(record.priority);
  return Object.freeze(desired) as UpdateIssueDesired;
}

function parseCallerUuid(value: unknown, kind: "issue" | "relation" | "comment"): string {
  const parsed = kind === "issue"
    ? parseTaskIssueId(value)
    : kind === "relation" ? parseTaskRelationId(value) : parseBoundedString(value, "invalid_comment_id", 128);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(parsed)) {
    throw new Error(`invalid_${kind}_uuid`);
  }
  return parsed;
}

function parsePageInput(value: unknown, extraKeys: readonly string[] = []): CursorPageInput {
  const record = asRecord(value);
  assertExactKeys(record, ["cursor", "page_size", ...extraKeys]);
  return Object.freeze({ cursor: parseCursor(record.cursor), page_size: parsePageSize(record.page_size) });
}

function parseCallEnvelope<F extends TaskMcpFunction>(
  record: Record<string, unknown>,
  functionName: F,
  expected: RuntimeTarget,
): TaskMcpEnvelope<F> {
  const rootId = parseRootIssueId(record.root_id);
  const runtimeGeneration = parseRuntimeGeneration(record.runtime_generation);
  assertRuntimeTarget({ root_id: rootId, runtime_generation: runtimeGeneration }, expected);
  const capability = parseBoundedString(record.capability, "invalid_task_capability", 128);
  if (capability !== TASK_MCP_CAPABILITIES[functionName]) throw new Error("capability_mismatch");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    function: functionName,
    root_id: rootId,
    runtime_generation: runtimeGeneration,
    correlation_id: parseCorrelationId(record.correlation_id),
    capability: capability as TaskMcpCapability<F>,
  });
}

export function parseTaskMcpCall(value: unknown, expected: RuntimeTarget): TaskMcpCall {
  const record = asRecord(value);
  assertExactKeys(record, [...ENVELOPE_KEYS, "input"]);
  const functionName = parseEnum(record.function, TASK_MCP_ALL_FUNCTIONS);
  const input = asRecord(record.input);
  switch (functionName) {
    case "get_issue": {
      assertExactKeys(input, ["issue_id"]);
      return Object.freeze({ ...parseCallEnvelope(record, functionName, expected), input: Object.freeze({
        issue_id: parseTaskIssueId(input.issue_id),
      }) });
    }
    case "list_issues": return Object.freeze({
      ...parseCallEnvelope(record, functionName, expected), input: parsePageInput(input),
    });
    case "list_states": return Object.freeze({
      ...parseCallEnvelope(record, functionName, expected), input: parsePageInput(input),
    });
    case "list_labels": return Object.freeze({
      ...parseCallEnvelope(record, functionName, expected), input: parsePageInput(input),
    });
    case "list_children": {
      const page = parsePageInput(input, ["parent_issue_id"]);
      return Object.freeze({ ...parseCallEnvelope(record, functionName, expected), input: Object.freeze({
        parent_issue_id: parseTaskIssueId(input.parent_issue_id), ...page,
      }) });
    }
    case "list_relations": {
      const page = parsePageInput(input, ["issue_id"]);
      return Object.freeze({ ...parseCallEnvelope(record, functionName, expected), input: Object.freeze({
        issue_id: parseTaskIssueId(input.issue_id), ...page,
      }) });
    }
    case "create_issue":
      assertExactKeys(input, ["issue_id", "parent_issue_id", "expected_parent_revision", "desired"]);
      return Object.freeze({ ...parseCallEnvelope(record, functionName, expected), input: Object.freeze({
        issue_id: parseCallerUuid(input.issue_id, "issue") as TaskIssueId,
        parent_issue_id: parseTaskIssueId(input.parent_issue_id),
        expected_parent_revision: parseTaskRevision(input.expected_parent_revision),
        desired: parseCreateDesired(input.desired),
      }) });
    case "update_issue":
      assertExactKeys(input, ["issue_id", "expected_revision", "desired"]);
      return Object.freeze({ ...parseCallEnvelope(record, functionName, expected), input: Object.freeze({
        issue_id: parseTaskIssueId(input.issue_id),
        expected_revision: parseTaskRevision(input.expected_revision),
        desired: parseUpdateDesired(input.desired),
      }) });
    case "archive_issue":
      assertExactKeys(input, ["issue_id", "expected_revision"]);
      return Object.freeze({ ...parseCallEnvelope(record, functionName, expected), input: Object.freeze({
        issue_id: parseTaskIssueId(input.issue_id),
        expected_revision: parseTaskRevision(input.expected_revision),
      }) });
    case "create_issue_comment":
      assertExactKeys(input, ["comment_id", "issue_id", "expected_issue_revision", "body_markdown"]);
      return Object.freeze({ ...parseCallEnvelope(record, functionName, expected), input: Object.freeze({
        comment_id: parseCallerUuid(input.comment_id, "comment"),
        issue_id: parseTaskIssueId(input.issue_id),
        expected_issue_revision: parseTaskRevision(input.expected_issue_revision),
        body_markdown: parseCommentBody(input.body_markdown),
      }) });
    case "create_relation": {
      assertExactKeys(input, [
        "relation_id", "relation_type", "source_issue_id", "expected_source_revision", "target_issue_id",
        "expected_target_revision",
      ]);
      const sourceIssueId = parseTaskIssueId(input.source_issue_id);
      const targetIssueId = parseTaskIssueId(input.target_issue_id);
      if (sourceIssueId === targetIssueId) throw new Error("self_task_relation");
      return Object.freeze({ ...parseCallEnvelope(record, functionName, expected), input: Object.freeze({
        relation_id: parseCallerUuid(input.relation_id, "relation") as TaskRelationId,
        relation_type: parseBoundedString(input.relation_type, "invalid_task_relation_type", 128),
        source_issue_id: sourceIssueId,
        expected_source_revision: parseTaskRevision(input.expected_source_revision),
        target_issue_id: targetIssueId,
        expected_target_revision: parseTaskRevision(input.expected_target_revision),
      }) });
    }
    case "delete_relation": {
      assertExactKeys(input, [
        "relation_id", "expected_relation_revision", "source_issue_id", "expected_source_revision",
        "target_issue_id", "expected_target_revision",
      ]);
      const sourceIssueId = parseTaskIssueId(input.source_issue_id);
      const targetIssueId = parseTaskIssueId(input.target_issue_id);
      if (sourceIssueId === targetIssueId) throw new Error("self_task_relation");
      return Object.freeze({ ...parseCallEnvelope(record, functionName, expected), input: Object.freeze({
        relation_id: parseTaskRelationId(input.relation_id),
        expected_relation_revision: parseTaskRevision(input.expected_relation_revision),
        source_issue_id: sourceIssueId,
        expected_source_revision: parseTaskRevision(input.expected_source_revision),
        target_issue_id: targetIssueId,
        expected_target_revision: parseTaskRevision(input.expected_target_revision),
      }) });
    }
  }
}

function assertResultEnvelope(record: Record<string, unknown>, call: TaskMcpCall): void {
  const functionName = parseEnum(record.function, TASK_MCP_ALL_FUNCTIONS);
  if (functionName !== call.function) throw new Error("function_mismatch");
  if (parseRootIssueId(record.root_id) !== call.root_id) throw new Error("runtime_root_mismatch");
  if (parseRuntimeGeneration(record.runtime_generation) !== call.runtime_generation) throw new Error("stale_generation");
  if (parseCorrelationId(record.correlation_id) !== call.correlation_id) throw new Error("correlation_mismatch");
  if (record.capability !== call.capability) throw new Error("capability_mismatch");
  parseSchemaVersion(record.schema_version);
}

function parseMutationTarget(value: unknown): TaskMutationTarget {
  const record = asRecord(value);
  const kind = parseEnum(record.kind, ["issue", "relation"] as const);
  if (kind === "issue") {
    assertExactKeys(record, ["kind", "issue_id"]);
    return Object.freeze({ kind, issue_id: parseTaskIssueId(record.issue_id) });
  }
  assertExactKeys(record, ["kind", "relation_id", "source_issue_id", "target_issue_id"]);
  const sourceIssueId = parseTaskIssueId(record.source_issue_id);
  const targetIssueId = parseTaskIssueId(record.target_issue_id);
  if (sourceIssueId === targetIssueId) throw new Error("self_task_relation");
  return Object.freeze({
    kind,
    relation_id: parseTaskRelationId(record.relation_id),
    source_issue_id: sourceIssueId,
    target_issue_id: targetIssueId,
  });
}

function parseMutationOutput(value: unknown, call: TaskMcpMutationCall): TaskMutationOutput {
  const record = asRecord(value);
  assertExactKeys(record, [
    "outcome", "effect_may_have_occurred", "target", "fresh_resource", "concrete_diff", "sanitized_reason",
  ]);
  const outcome = parseEnum(record.outcome, [
    "applied", "not_applied", "stale_before_effect", "conflict_observed",
  ] as const);
  if (typeof record.effect_may_have_occurred !== "boolean") throw new Error("invalid_effect_ambiguity");
  if (record.effect_may_have_occurred !== (outcome === "applied" || outcome === "conflict_observed")) {
    throw new Error("invalid_effect_ambiguity");
  }
  const mutationTarget = parseMutationTarget(record.target);
  const relationCall = call.function === "create_relation" || call.function === "delete_relation";
  if ((mutationTarget.kind === "relation") !== relationCall) throw new Error("mutation_target_mismatch");
  if (call.function === "update_issue" || call.function === "archive_issue") {
    if (mutationTarget.kind !== "issue" || mutationTarget.issue_id !== call.input.issue_id) {
      throw new Error("mutation_target_mismatch");
    }
  }
  if (call.function === "create_issue") {
    if (mutationTarget.kind !== "issue" || mutationTarget.issue_id !== call.input.issue_id) {
      throw new Error("mutation_target_mismatch");
    }
  }
  if (relationCall) {
    if (
      mutationTarget.kind !== "relation"
      || mutationTarget.source_issue_id !== call.input.source_issue_id
      || mutationTarget.target_issue_id !== call.input.target_issue_id
      || (call.function === "create_relation" && mutationTarget.relation_id !== call.input.relation_id)
      || (call.function === "delete_relation" && mutationTarget.relation_id !== call.input.relation_id)
    ) throw new Error("mutation_target_mismatch");
  }
  let freshResource: TaskIssueSnapshot | TaskRelationSnapshot | null = null;
  if (record.fresh_resource !== null) {
    freshResource = mutationTarget.kind === "issue"
      ? parseTaskIssueSnapshotChange(record.fresh_resource)
      : parseTaskRelationSnapshot(record.fresh_resource);
    const resourceMatches = mutationTarget.kind === "issue"
      ? "issue_id" in freshResource && freshResource.issue_id === mutationTarget.issue_id
      : "relation_id" in freshResource
        && freshResource.relation_id === mutationTarget.relation_id
        && freshResource.source_issue_id === mutationTarget.source_issue_id
        && freshResource.target_issue_id === mutationTarget.target_issue_id;
    if (!resourceMatches) throw new Error("mutation_resource_mismatch");
  }
  const concreteDiff = parseArray(record.concrete_diff, parseConcreteTaskChange, 100);
  if (outcome === "applied" && concreteDiff.length === 0) throw new Error("applied_without_concrete_diff");
  const reason = record.sanitized_reason === null
    ? null
    : parseBoundedString(record.sanitized_reason, "invalid_mutation_reason", 256);
  if (outcome === "applied" ? reason !== null : reason === null) throw new Error("invalid_mutation_reason");
  return Object.freeze({
    outcome,
    effect_may_have_occurred: record.effect_may_have_occurred,
    target: mutationTarget,
    fresh_resource: freshResource,
    concrete_diff: concreteDiff,
    sanitized_reason: reason,
  });
}

function isMutationCall(call: TaskMcpCall): call is TaskMcpMutationCall {
  return call.function === "create_issue"
    || call.function === "update_issue"
    || call.function === "archive_issue"
    || call.function === "create_relation"
    || call.function === "delete_relation";
}

function parseCommentResource(value: unknown): TaskCommentResource {
  const record = asRecord(value);
  assertExactKeys(record, [
    "comment_id", "issue_id", "provider_created_at", "provider_updated_at", "provider_edited_at",
    "provider_archived_at", "actor_id", "body_digest",
  ]);
  const timestamp = (entry: unknown) => {
    const parsed = parseBoundedString(entry, "invalid_comment_timestamp", 64);
    if (Number.isNaN(Date.parse(parsed))) throw new Error("invalid_comment_timestamp");
    return parsed;
  };
  const nullableTimestamp = (entry: unknown) => entry === null ? null : timestamp(entry);
  const digest = parseBoundedString(record.body_digest, "invalid_comment_digest", 64);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error("invalid_comment_digest");
  return Object.freeze({
    comment_id: parseBoundedString(record.comment_id, "invalid_comment_id", 128),
    issue_id: parseTaskIssueId(record.issue_id),
    provider_created_at: timestamp(record.provider_created_at),
    provider_updated_at: timestamp(record.provider_updated_at),
    provider_edited_at: nullableTimestamp(record.provider_edited_at),
    provider_archived_at: nullableTimestamp(record.provider_archived_at),
    actor_id: record.actor_id === null ? null : parseBoundedString(record.actor_id, "invalid_comment_actor", 128),
    body_digest: digest,
  });
}

function parseCommentMutationOutput(value: unknown, call: CreateIssueCommentCall): TaskCommentMutationOutput {
  const record = asRecord(value);
  assertExactKeys(record, ["outcome", "effect_may_have_occurred", "target", "fresh_comment", "sanitized_reason"]);
  const outcome = parseEnum(record.outcome, [
    "applied", "not_applied", "stale_before_effect", "conflict_observed",
  ] as const);
  if (typeof record.effect_may_have_occurred !== "boolean"
    || record.effect_may_have_occurred !== (outcome === "applied" || outcome === "conflict_observed")) {
    throw new Error("invalid_effect_ambiguity");
  }
  const target = asRecord(record.target);
  assertExactKeys(target, ["kind", "comment_id", "issue_id"]);
  if (target.kind !== "comment" || target.comment_id !== call.input.comment_id
    || target.issue_id !== call.input.issue_id) throw new Error("mutation_target_mismatch");
  const freshComment = record.fresh_comment === null ? null : parseCommentResource(record.fresh_comment);
  if (freshComment !== null
    && (freshComment.comment_id !== call.input.comment_id || freshComment.issue_id !== call.input.issue_id)) {
    throw new Error("mutation_resource_mismatch");
  }
  const reason = record.sanitized_reason === null
    ? null : parseBoundedString(record.sanitized_reason, "invalid_mutation_reason", 256);
  if (outcome === "applied" ? reason !== null || freshComment === null : reason === null) {
    throw new Error("invalid_mutation_reason");
  }
  return Object.freeze({
    outcome,
    effect_may_have_occurred: record.effect_may_have_occurred,
    target: Object.freeze({ kind: "comment", comment_id: call.input.comment_id, issue_id: call.input.issue_id }),
    fresh_comment: freshComment,
    sanitized_reason: reason,
  });
}

function parsePageOutput<T>(
  value: unknown,
  key: string,
  parser: (entry: unknown) => T,
  pageSize: number,
): { readonly items: readonly T[]; readonly next_cursor: string | null } {
  const record = asRecord(value);
  assertExactKeys(record, [key, "next_cursor"]);
  return Object.freeze({
    items: parseArray(record[key], parser, pageSize),
    next_cursor: parseCursor(record.next_cursor),
  });
}

function parseTaskState(value: unknown): TaskStateResource {
  const record = asRecord(value);
  assertExactKeys(record, ["state_id", "revision", "name", "archived"]);
  if (typeof record.archived !== "boolean") throw new Error("invalid_task_state_activity");
  return Object.freeze({
    state_id: parseTaskStateId(record.state_id),
    revision: parseTaskRevision(record.revision),
    name: parseBoundedString(record.name, "invalid_task_state_name", 256),
    archived: record.archived,
  });
}

function parseTaskLabel(value: unknown): TaskLabelResource {
  const record = asRecord(value);
  assertExactKeys(record, ["label_id", "revision", "name"]);
  return Object.freeze({
    label_id: parseTaskLabelId(record.label_id),
    revision: parseTaskRevision(record.revision),
    name: parseBoundedString(record.name, "invalid_task_label_name", 256),
  });
}

export function parseTaskMcpResult(value: unknown, call: GetIssueCall): GetIssueResult;
export function parseTaskMcpResult(value: unknown, call: ListIssuesCall): ListIssuesResult;
export function parseTaskMcpResult(value: unknown, call: ListChildrenCall): ListChildrenResult;
export function parseTaskMcpResult(value: unknown, call: ListRelationsCall): ListRelationsResult;
export function parseTaskMcpResult(value: unknown, call: ListStatesCall): ListStatesResult;
export function parseTaskMcpResult(value: unknown, call: ListLabelsCall): ListLabelsResult;
export function parseTaskMcpResult(value: unknown, call: CreateIssueCall): CreateIssueResult;
export function parseTaskMcpResult(value: unknown, call: UpdateIssueCall): UpdateIssueResult;
export function parseTaskMcpResult(value: unknown, call: ArchiveIssueCall): ArchiveIssueResult;
export function parseTaskMcpResult(value: unknown, call: CreateIssueCommentCall): CreateIssueCommentResult;
export function parseTaskMcpResult(value: unknown, call: CreateRelationCall): CreateRelationResult;
export function parseTaskMcpResult(value: unknown, call: DeleteRelationCall): DeleteRelationResult;
export function parseTaskMcpResult(value: unknown, call: TaskMcpCall): TaskMcpResult;
export function parseTaskMcpResult(value: unknown, call: TaskMcpCall): TaskMcpResult {
  const record = asRecord(value);
  assertExactKeys(record, [...ENVELOPE_KEYS, "output"]);
  assertResultEnvelope(record, call);
  if (call.function === "create_issue_comment") {
    return Object.freeze({
      ...parseCallEnvelope(record, call.function, call),
      output: parseCommentMutationOutput(record.output, call),
    });
  }
  if (isMutationCall(call)) {
    const output = parseMutationOutput(record.output, call);
    switch (call.function) {
      case "create_issue": return Object.freeze({ ...parseCallEnvelope(record, call.function, call), output });
      case "update_issue": return Object.freeze({ ...parseCallEnvelope(record, call.function, call), output });
      case "archive_issue": return Object.freeze({ ...parseCallEnvelope(record, call.function, call), output });
      case "create_relation": return Object.freeze({ ...parseCallEnvelope(record, call.function, call), output });
      case "delete_relation": return Object.freeze({ ...parseCallEnvelope(record, call.function, call), output });
    }
  }
  if (call.function === "get_issue") {
    const output = asRecord(record.output);
    assertExactKeys(output, ["issue"]);
    return Object.freeze({ ...parseCallEnvelope(record, call.function, call), output: Object.freeze({
      issue: output.issue === null ? null : parseTaskIssueSnapshotChange(output.issue),
    }) });
  }
  if (call.function === "list_issues") {
    const page = parsePageOutput(record.output, "issues", parseTaskIssueSnapshotChange, call.input.page_size);
    return Object.freeze({ ...parseCallEnvelope(record, call.function, call), output: Object.freeze({
      issues: page.items, next_cursor: page.next_cursor,
    }) });
  }
  if (call.function === "list_children") {
    const page = parsePageOutput(record.output, "issues", parseTaskIssueSnapshotChange, call.input.page_size);
    return Object.freeze({ ...parseCallEnvelope(record, call.function, call), output: Object.freeze({
      issues: page.items, next_cursor: page.next_cursor,
    }) });
  }
  if (call.function === "list_relations") {
    const page = parsePageOutput(record.output, "relations", parseTaskRelationSnapshot, call.input.page_size);
    return Object.freeze({ ...parseCallEnvelope(record, call.function, call), output: Object.freeze({
      relations: page.items, next_cursor: page.next_cursor,
    }) });
  }
  if (call.function === "list_states") {
    const page = parsePageOutput(record.output, "states", parseTaskState, call.input.page_size);
    return Object.freeze({ ...parseCallEnvelope(record, call.function, call), output: Object.freeze({
      states: page.items, next_cursor: page.next_cursor,
    }) });
  }
  const page = parsePageOutput(record.output, "labels", parseTaskLabel, call.input.page_size);
  return Object.freeze({ ...parseCallEnvelope(record, call.function, call), output: Object.freeze({
    labels: page.items, next_cursor: page.next_cursor,
  }) });
}
