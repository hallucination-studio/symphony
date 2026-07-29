import {
  parseCycleIssueId,
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  parseStageIssueId,
  type CorrelationId,
  type CycleIssueId,
  type ObservationDigest,
  type RepositoryId,
  type Revision,
  type RootIssueId,
  type RuntimeGeneration,
  type SchemaVersion,
  type StageIssueId,
} from "./identity.js";
import { parseCorrelationId } from "./identity.js";
import { asRecord, assertExactKeys, parseBoundedString, parseEnum, parseStringArray } from "./validation.js";

export const ROOT_STATUSES = ["Todo", "In Progress", "In Review", "Done"] as const;
export const CYCLE_STATUSES = ["Planning", "Executing", "Verifying", "Succeeded", "Canceled"] as const;
export const STAGE_KINDS = ["plan", "work", "verify"] as const;
export const STAGE_STATUSES = ["Todo", "In Progress", "Done", "Failed", "Canceled"] as const;
export const PR_STATES = ["open", "closed", "merged"] as const;

export type RootStatus = typeof ROOT_STATUSES[number];
export type CycleStatus = typeof CYCLE_STATUSES[number];
export type StageKind = typeof STAGE_KINDS[number];
export type StageStatus = typeof STAGE_STATUSES[number];

export interface StageObservation {
  readonly issue_id: StageIssueId;
  readonly kind: StageKind;
  readonly status: StageStatus;
  readonly dependency_issue_ids: readonly StageIssueId[];
}

export interface CycleObservation {
  readonly issue_id: CycleIssueId;
  readonly status: typeof CYCLE_STATUSES[number];
  readonly stages: readonly StageObservation[];
}

export interface LinearObservation {
  readonly root_id: RootIssueId;
  readonly root_status: RootStatus;
  readonly active_cycle: CycleObservation | null;
}

export interface PullRequestObservation {
  readonly provider: string;
  readonly repository_id: RepositoryId;
  readonly base_branch: string;
  readonly head_branch: string;
  readonly state: typeof PR_STATES[number];
  readonly head_revision: Revision;
  readonly url: string;
}

export interface GitObservation {
  readonly repository_id: RepositoryId;
  readonly base_branch: string;
  readonly head_branch: string;
  readonly head_revision: Revision | null;
  readonly workspace_state: "clean" | "dirty";
  readonly diff_digest: ObservationDigest;
  readonly pull_request: PullRequestObservation | null;
}

export interface RootBootstrap {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly observed_at: string;
  readonly linear: LinearObservation;
  readonly git: GitObservation;
}

export type LinearFactChange =
  | { readonly kind: "root_status_changed"; readonly before: RootStatus; readonly after: RootStatus }
  | { readonly kind: "active_cycle_changed"; readonly before: CycleIssueId | null; readonly after: CycleIssueId | null }
  | { readonly kind: "stage_changed"; readonly stage_id: StageIssueId; readonly before: StageStatus | null; readonly after: StageStatus | null };

export type GitFactChange =
  | { readonly kind: "head_changed"; readonly before: Revision | null; readonly after: Revision | null }
  | { readonly kind: "workspace_changed"; readonly before: "clean" | "dirty"; readonly after: "clean" | "dirty" }
  | { readonly kind: "pull_request_changed"; readonly before: Revision | null; readonly after: Revision | null };

export interface RootObservationDiff {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly from_observation_digest: ObservationDigest;
  readonly to_observation_digest: ObservationDigest;
  readonly changed_linear_facts: readonly LinearFactChange[];
  readonly changed_git_facts: readonly GitFactChange[];
}

function parseNullable<T>(value: unknown, parser: (input: unknown) => T): T | null {
  return value === null ? null : parser(value);
}

function parseLinearFactChange(value: unknown): LinearFactChange {
  const record = asRecord(value);
  const kind = parseEnum(record.kind, ["root_status_changed", "active_cycle_changed", "stage_changed"] as const);
  if (kind === "root_status_changed") {
    assertExactKeys(record, ["kind", "before", "after"]);
    return Object.freeze({ kind, before: parseEnum(record.before, ROOT_STATUSES), after: parseEnum(record.after, ROOT_STATUSES) });
  }
  if (kind === "active_cycle_changed") {
    assertExactKeys(record, ["kind", "before", "after"]);
    return Object.freeze({ kind, before: parseNullable(record.before, parseCycleIssueId), after: parseNullable(record.after, parseCycleIssueId) });
  }
  assertExactKeys(record, ["kind", "stage_id", "before", "after"]);
  return Object.freeze({
    kind,
    stage_id: parseStageIssueId(record.stage_id),
    before: parseNullable(record.before, (entry) => parseEnum(entry, STAGE_STATUSES)),
    after: parseNullable(record.after, (entry) => parseEnum(entry, STAGE_STATUSES)),
  });
}

function parseGitFactChange(value: unknown): GitFactChange {
  const record = asRecord(value);
  const kind = parseEnum(record.kind, ["head_changed", "workspace_changed", "pull_request_changed"] as const);
  assertExactKeys(record, ["kind", "before", "after"]);
  if (kind === "workspace_changed") {
    return Object.freeze({
      kind,
      before: parseEnum(record.before, ["clean", "dirty"] as const),
      after: parseEnum(record.after, ["clean", "dirty"] as const),
    });
  }
  return Object.freeze({
    kind,
    before: parseNullable(record.before, parseRevision),
    after: parseNullable(record.after, parseRevision),
  });
}

export function parseRootObservationDiff(value: unknown): RootObservationDiff {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version", "root_id", "runtime_generation", "correlation_id",
    "from_observation_digest", "to_observation_digest", "changed_linear_facts", "changed_git_facts",
  ]);
  if (!Array.isArray(record.changed_linear_facts) || !Array.isArray(record.changed_git_facts)) {
    throw new Error("invalid_observation_diff");
  }
  const from = parseObservationDigest(record.from_observation_digest);
  const to = parseObservationDigest(record.to_observation_digest);
  if (from === to) throw new Error("unchanged_observation_diff");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: parseRootIssueId(record.root_id),
    runtime_generation: parseRuntimeGeneration(record.runtime_generation),
    correlation_id: parseCorrelationId(record.correlation_id),
    from_observation_digest: from,
    to_observation_digest: to,
    changed_linear_facts: Object.freeze(record.changed_linear_facts.map(parseLinearFactChange)),
    changed_git_facts: Object.freeze(record.changed_git_facts.map(parseGitFactChange)),
  });
}

function parseStage(value: unknown): StageObservation {
  const record = asRecord(value);
  assertExactKeys(record, ["issue_id", "kind", "status", "dependency_issue_ids"]);
  return Object.freeze({
    issue_id: parseStageIssueId(record.issue_id),
    kind: parseEnum(record.kind, STAGE_KINDS),
    status: parseEnum(record.status, STAGE_STATUSES),
    dependency_issue_ids: parseStringArray(record.dependency_issue_ids, parseStageIssueId) as readonly StageIssueId[],
  });
}

export function parseLinearObservation(value: unknown): LinearObservation {
  const record = asRecord(value);
  assertExactKeys(record, ["root_id", "root_status", "active_cycle"]);
  let activeCycle: CycleObservation | null = null;
  if (record.active_cycle !== null) {
    const cycle = asRecord(record.active_cycle);
    assertExactKeys(cycle, ["issue_id", "status", "stages"]);
    if (!Array.isArray(cycle.stages)) throw new Error("invalid_cycle_stages");
    const stages = cycle.stages.map(parseStage);
    if (new Set(stages.map(({ issue_id }) => issue_id)).size !== stages.length) {
      throw new Error("duplicate_stage_identity");
    }
    activeCycle = Object.freeze({
      issue_id: parseCycleIssueId(cycle.issue_id),
      status: parseEnum(cycle.status, CYCLE_STATUSES),
      stages: Object.freeze(stages),
    });
  }
  return Object.freeze({
    root_id: parseRootIssueId(record.root_id),
    root_status: parseEnum(record.root_status, ROOT_STATUSES),
    active_cycle: activeCycle,
  });
}

function parsePullRequest(value: unknown): PullRequestObservation {
  const record = asRecord(value);
  assertExactKeys(record, ["provider", "repository_id", "base_branch", "head_branch", "state", "head_revision", "url"]);
  const url = parseBoundedString(record.url, "invalid_pr_url", 2048);
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

export function parseGitObservation(value: unknown): GitObservation {
  const record = asRecord(value);
  assertExactKeys(record, ["repository_id", "base_branch", "head_branch", "head_revision", "workspace_state", "diff_digest", "pull_request"]);
  return Object.freeze({
    repository_id: parseRepositoryId(record.repository_id),
    base_branch: parseBoundedString(record.base_branch, "invalid_base_branch"),
    head_branch: parseBoundedString(record.head_branch, "invalid_head_branch"),
    head_revision: record.head_revision === null ? null : parseRevision(record.head_revision),
    workspace_state: parseEnum(record.workspace_state, ["clean", "dirty"] as const),
    diff_digest: parseObservationDigest(record.diff_digest),
    pull_request: record.pull_request === null ? null : parsePullRequest(record.pull_request),
  });
}

export function parseRootBootstrap(value: unknown): RootBootstrap {
  const record = asRecord(value);
  assertExactKeys(record, ["schema_version", "root_id", "runtime_generation", "correlation_id", "observed_at", "linear", "git"]);
  const rootId = parseRootIssueId(record.root_id);
  const linear = parseLinearObservation(record.linear);
  if (linear.root_id !== rootId) throw new Error("bootstrap_root_mismatch");
  const observedAt = parseBoundedString(record.observed_at, "invalid_observed_at", 64);
  if (Number.isNaN(Date.parse(observedAt))) throw new Error("invalid_observed_at");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: rootId,
    runtime_generation: parseRuntimeGeneration(record.runtime_generation),
    correlation_id: parseCorrelationId(record.correlation_id),
    observed_at: observedAt,
    linear,
    git: parseGitObservation(record.git),
  });
}
