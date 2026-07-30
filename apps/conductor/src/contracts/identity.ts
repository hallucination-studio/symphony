const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/u;

declare const rootIssueIdBrand: unique symbol;
declare const taskIssueIdBrand: unique symbol;
declare const taskRelationIdBrand: unique symbol;
declare const taskRevisionBrand: unique symbol;
declare const taskStateIdBrand: unique symbol;
declare const taskLabelIdBrand: unique symbol;
declare const cycleIssueIdBrand: unique symbol;
declare const stageIssueIdBrand: unique symbol;
declare const repositoryIdBrand: unique symbol;
declare const revisionBrand: unique symbol;
declare const correlationIdBrand: unique symbol;
declare const threadIdBrand: unique symbol;
declare const observationDigestBrand: unique symbol;
declare const taskDigestBrand: unique symbol;

export type RootIssueId = string & { readonly [rootIssueIdBrand]: true };
export type TaskIssueId = string & { readonly [taskIssueIdBrand]: true };
export type TaskRelationId = string & { readonly [taskRelationIdBrand]: true };
export type TaskRevision = string & { readonly [taskRevisionBrand]: true };
export type TaskStateId = string & { readonly [taskStateIdBrand]: true };
export type TaskLabelId = string & { readonly [taskLabelIdBrand]: true };
export type CycleIssueId = string & { readonly [cycleIssueIdBrand]: true };
export type StageIssueId = string & { readonly [stageIssueIdBrand]: true };
export type RepositoryId = string & { readonly [repositoryIdBrand]: true };
export type Revision = string & { readonly [revisionBrand]: true };
export type CorrelationId = string & { readonly [correlationIdBrand]: true };
export type ThreadId = string & { readonly [threadIdBrand]: true };
export type ObservationDigest = string & { readonly [observationDigestBrand]: true };
export type TaskDigest = string & { readonly [taskDigestBrand]: true };

export type RuntimeGeneration = number & { readonly __runtimeGeneration: true };
export type SchemaVersion = 1;

function parseIdentity<T extends string>(value: unknown, name: string): T {
  if (typeof value !== "string" || !IDENTITY_PATTERN.test(value)) {
    throw new Error(`invalid_${name}`);
  }
  return value as T;
}

export const parseRootIssueId = (value: unknown): RootIssueId =>
  parseIdentity<RootIssueId>(value, "root_issue_id");
export const parseTaskIssueId = (value: unknown): TaskIssueId =>
  parseIdentity<TaskIssueId>(value, "task_issue_id");
export const parseTaskRelationId = (value: unknown): TaskRelationId =>
  parseIdentity<TaskRelationId>(value, "task_relation_id");
export const parseTaskRevision = (value: unknown): TaskRevision =>
  parseIdentity<TaskRevision>(value, "task_revision");
export const parseTaskStateId = (value: unknown): TaskStateId =>
  parseIdentity<TaskStateId>(value, "task_state_id");
export const parseTaskLabelId = (value: unknown): TaskLabelId =>
  parseIdentity<TaskLabelId>(value, "task_label_id");
export const parseCycleIssueId = (value: unknown): CycleIssueId =>
  parseIdentity<CycleIssueId>(value, "cycle_issue_id");
export const parseStageIssueId = (value: unknown): StageIssueId =>
  parseIdentity<StageIssueId>(value, "stage_issue_id");
export const parseRepositoryId = (value: unknown): RepositoryId =>
  parseIdentity<RepositoryId>(value, "repository_id");
export const parseCorrelationId = (value: unknown): CorrelationId =>
  parseIdentity<CorrelationId>(value, "correlation_id");
export const parseThreadId = (value: unknown): ThreadId =>
  parseIdentity<ThreadId>(value, "thread_id");
export const parseObservationDigest = (value: unknown): ObservationDigest =>
  parseIdentity<ObservationDigest>(value, "observation_digest");
export const parseTaskDigest = (value: unknown): TaskDigest =>
  parseIdentity<TaskDigest>(value, "task_digest");

export function parseRevision(value: unknown): Revision {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    throw new Error("invalid_revision");
  }
  return value as Revision;
}

export function parseRuntimeGeneration(value: unknown): RuntimeGeneration {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("invalid_runtime_generation");
  }
  return value as RuntimeGeneration;
}

export function parseSchemaVersion(value: unknown): SchemaVersion {
  if (value !== 1) throw new Error("unsupported_schema_version");
  return 1;
}
