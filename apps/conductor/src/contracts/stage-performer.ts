import { createHash } from "node:crypto";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  parseStageIssueId,
  parseTaskRevision,
  type CorrelationId,
  type CycleIssueId,
  type Revision,
  type RootIssueId,
  type RuntimeGeneration,
  type SchemaVersion,
  type StageIssueId,
  type TaskRevision,
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

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_REVISION_PATTERN = /^symphony:v1:[0-9a-f]{64}$/u;
const CHECK_STATUSES = ["passed", "failed", "not_run"] as const;
const MAX_CHECKS = 32;
const MAX_WORK_GROUPS = 256;

declare const performerRequestDigestBrand: unique symbol;
declare const ephemeralContinuationBrand: unique symbol;

export type PerformerRequestDigest = string & { readonly [performerRequestDigestBrand]: true };
export type EphemeralContinuationText = MarkdownText & { readonly [ephemeralContinuationBrand]: true };

interface RoleRequestCommon {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly cycle_id: CycleIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
}

interface RoleResultCommon extends RoleRequestCommon {
  readonly input_request_digest: PerformerRequestDigest;
}

export interface PlanRequest extends RoleRequestCommon {
  readonly cycle_revision: TaskRevision;
  readonly plan_issue_id: StageIssueId;
  readonly plan_issue_revision: TaskRevision;
  readonly cycle_specification_markdown: MarkdownText;
  readonly root_adr_markdown: MarkdownText;
  readonly plan_instruction_markdown: MarkdownText;
}

interface CompletedPlanResult extends RoleResultCommon {
  readonly plan_issue_id: StageIssueId;
  readonly outcome: "completed";
  readonly ordered_work_group_ids: readonly [string, ...string[]];
}

interface TerminalPlanResult extends RoleResultCommon {
  readonly plan_issue_id: StageIssueId;
  readonly outcome: "failed" | "canceled";
  readonly reason_markdown: MarkdownText;
}

export type PlanResult = CompletedPlanResult | TerminalPlanResult;

export interface SealedWorkGroupOrderBasis {
  readonly work_group_id: string;
  readonly depends_on_work_group_ids: readonly string[];
}

export interface WorkRequest extends RoleRequestCommon {
  readonly cycle_revision: TaskRevision;
  readonly work_issue_id: StageIssueId;
  readonly work_issue_revision: TaskRevision;
  readonly cycle_specification_markdown: MarkdownText;
  readonly work_instruction_markdown: MarkdownText;
}

export interface PerformerCheck {
  readonly check: string;
  readonly status: typeof CHECK_STATUSES[number];
  readonly sanitized_summary_markdown: MarkdownText | null;
}

interface WorkResultEvidence {
  readonly work_issue_id: StageIssueId;
  readonly workspace_changed: boolean;
  readonly checks: readonly PerformerCheck[];
}

export type WorkResultCandidate = WorkResultEvidence & (
  { readonly outcome: "completed" }
  | { readonly outcome: "failed" | "canceled"; readonly reason_markdown: MarkdownText }
);

export type WorkResult = RoleResultCommon & WorkResultCandidate;

export interface WorkTurnResult extends RoleResultCommon {
  readonly completion_candidate: WorkResultCandidate;
  readonly ephemeral_continuation_markdown: EphemeralContinuationText | null;
}

export interface VerifyRequest extends RoleRequestCommon {
  readonly cycle_revision: TaskRevision;
  readonly verify_issue_id: StageIssueId;
  readonly verify_issue_revision: TaskRevision;
  readonly cycle_specification_markdown: MarkdownText;
  readonly verify_instruction_markdown: MarkdownText;
  readonly revision: Revision;
}

interface VerifyResultEvidence extends RoleResultCommon {
  readonly verify_issue_id: StageIssueId;
  readonly revision: Revision;
  readonly checks: readonly PerformerCheck[];
  readonly sanitized_summary_markdown: MarkdownText;
}

export type VerifyResult = VerifyResultEvidence & (
  { readonly conclusion: "passed" | "failed" | "inconclusive" }
  | { readonly conclusion: "canceled"; readonly reason_markdown: MarkdownText }
);

const COMMON_REQUEST_KEYS = [
  "schema_version", "root_id", "cycle_id", "runtime_generation", "correlation_id",
] as const;
const COMMON_RESULT_KEYS = [...COMMON_REQUEST_KEYS, "input_request_digest"] as const;

function parseCanonicalRevision(value: unknown): TaskRevision {
  const revision = parseTaskRevision(value);
  if (!CANONICAL_REVISION_PATTERN.test(revision)) throw new Error("invalid_canonical_task_revision");
  return revision;
}

function parseDigest(value: unknown, code: string): PerformerRequestDigest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new Error(code);
  return value as PerformerRequestDigest;
}

function parsedRequestCommon(record: UnknownRecord): RoleRequestCommon {
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: parseRootIssueId(record.root_id),
    cycle_id: parseCycleIssueId(record.cycle_id),
    runtime_generation: parseRuntimeGeneration(record.runtime_generation),
    correlation_id: parseCorrelationId(record.correlation_id),
  });
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const record = asRecord(value, "invalid_performer_request_digest_input");
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

export function canonicalPerformerRequestDigest(request: PlanRequest | WorkRequest | VerifyRequest): PerformerRequestDigest {
  return createHash("sha256").update(JSON.stringify(canonicalValue(request)), "utf8").digest("hex") as PerformerRequestDigest;
}

function assertResultEnvelope(record: UnknownRecord, request: PlanRequest | WorkRequest | VerifyRequest): RoleResultCommon {
  const common = parsedRequestCommon(record);
  if (
    common.root_id !== request.root_id
    || common.cycle_id !== request.cycle_id
    || common.runtime_generation !== request.runtime_generation
    || common.correlation_id !== request.correlation_id
  ) throw new Error("performer_result_target_mismatch");
  const digest = parseDigest(record.input_request_digest, "invalid_input_request_digest");
  if (digest !== canonicalPerformerRequestDigest(request)) throw new Error("performer_input_request_digest_mismatch");
  return Object.freeze({ ...common, input_request_digest: digest });
}

export function parsePlanRequest(value: unknown): PlanRequest {
  const record = asRecord(value);
  assertExactKeys(record, [
    ...COMMON_REQUEST_KEYS, "cycle_revision", "plan_issue_id", "plan_issue_revision",
    "cycle_specification_markdown", "root_adr_markdown", "plan_instruction_markdown",
  ]);
  return Object.freeze({
    ...parsedRequestCommon(record),
    cycle_revision: parseCanonicalRevision(record.cycle_revision),
    plan_issue_id: parseStageIssueId(record.plan_issue_id),
    plan_issue_revision: parseCanonicalRevision(record.plan_issue_revision),
    cycle_specification_markdown: parseMarkdownText(record.cycle_specification_markdown, "invalid_cycle_specification"),
    root_adr_markdown: parseMarkdownText(record.root_adr_markdown, "invalid_root_adr"),
    plan_instruction_markdown: parseMarkdownText(record.plan_instruction_markdown, "invalid_plan_instruction"),
  });
}

export function parsePlanResult(
  value: unknown,
  request: PlanRequest,
  sealedWorkGroups: readonly SealedWorkGroupOrderBasis[],
): PlanResult {
  const record = asRecord(value);
  const outcome = parseEnum(record.outcome, ["completed", "failed", "canceled"] as const);
  assertExactKeys(record, outcome === "completed"
    ? [...COMMON_RESULT_KEYS, "plan_issue_id", "outcome", "ordered_work_group_ids"]
    : [...COMMON_RESULT_KEYS, "plan_issue_id", "outcome", "reason_markdown"]);
  const envelope = assertResultEnvelope(record, request);
  const planIssueId = parseStageIssueId(record.plan_issue_id);
  if (planIssueId !== request.plan_issue_id) throw new Error("plan_result_issue_mismatch");
  if (outcome !== "completed") {
    return Object.freeze({
      ...envelope, plan_issue_id: planIssueId, outcome,
      reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_plan_reason"),
    });
  }
  if (sealedWorkGroups.length === 0) throw new Error("empty_sealed_work_groups");
  const sealedWorkGroupIds = sealedWorkGroups.map(({ work_group_id }) => work_group_id);
  if (new Set(sealedWorkGroupIds).size !== sealedWorkGroupIds.length) {
    throw new Error("duplicate_sealed_work_group_id");
  }
  const order = parseStringArray(
    record.ordered_work_group_ids,
    (entry) => parseBoundedString(entry, "invalid_work_group_id", 128),
    MAX_WORK_GROUPS,
  );
  const sealed = new Set(sealedWorkGroupIds);
  if (order.length !== sealed.size || order.some((id) => !sealed.has(id))) {
    throw new Error("plan_work_group_order_mismatch");
  }
  const position = new Map(order.map((id, index) => [id, index]));
  for (const group of sealedWorkGroups) {
    const groupPosition = position.get(group.work_group_id);
    if (
      groupPosition === undefined
      || group.depends_on_work_group_ids.some((dependency) => {
        const dependencyPosition = position.get(dependency);
        return dependencyPosition === undefined || dependencyPosition >= groupPosition;
      })
    ) throw new Error("plan_work_group_order_not_topological");
  }
  return Object.freeze({
    ...envelope, plan_issue_id: planIssueId, outcome,
    ordered_work_group_ids: order as readonly [string, ...string[]],
  });
}

export function parseWorkRequest(value: unknown): WorkRequest {
  const record = asRecord(value);
  assertExactKeys(record, [
    ...COMMON_REQUEST_KEYS, "cycle_revision", "work_issue_id", "work_issue_revision",
    "cycle_specification_markdown", "work_instruction_markdown",
  ]);
  return Object.freeze({
    ...parsedRequestCommon(record),
    cycle_revision: parseCanonicalRevision(record.cycle_revision),
    work_issue_id: parseStageIssueId(record.work_issue_id),
    work_issue_revision: parseCanonicalRevision(record.work_issue_revision),
    cycle_specification_markdown: parseMarkdownText(record.cycle_specification_markdown, "invalid_cycle_specification"),
    work_instruction_markdown: parseMarkdownText(record.work_instruction_markdown, "invalid_work_instruction"),
  });
}

function parseChecks(value: unknown): readonly PerformerCheck[] {
  const checks = parseArray(value, (entry): PerformerCheck => {
    const record = asRecord(entry);
    assertExactKeys(record, ["check", "status", "sanitized_summary_markdown"]);
    return Object.freeze({
      check: parseBoundedString(record.check, "invalid_performer_check", 1_024),
      status: parseEnum(record.status, CHECK_STATUSES),
      sanitized_summary_markdown: record.sanitized_summary_markdown === null ? null
        : parseMarkdownText(record.sanitized_summary_markdown, "invalid_check_summary", 2_048),
    });
  }, MAX_CHECKS);
  if (new Set(checks.map(({ check }) => check)).size !== checks.length) throw new Error("duplicate_performer_check");
  return checks;
}

function parseWorkCandidate(value: unknown, request: WorkRequest): WorkResultCandidate {
  const record = asRecord(value);
  const outcome = parseEnum(record.outcome, ["completed", "failed", "canceled"] as const);
  assertExactKeys(record, outcome === "completed"
    ? ["work_issue_id", "workspace_changed", "checks", "outcome"]
    : ["work_issue_id", "workspace_changed", "checks", "outcome", "reason_markdown"]);
  const workIssueId = parseStageIssueId(record.work_issue_id);
  if (workIssueId !== request.work_issue_id) throw new Error("work_result_issue_mismatch");
  if (typeof record.workspace_changed !== "boolean") throw new Error("invalid_workspace_changed");
  const evidence = {
    work_issue_id: workIssueId,
    workspace_changed: record.workspace_changed,
    checks: parseChecks(record.checks),
  };
  if (outcome === "completed") return Object.freeze({ ...evidence, outcome });
  return Object.freeze({
    ...evidence, outcome,
    reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_work_reason"),
  });
}

export function parseWorkResult(value: unknown, request: WorkRequest): WorkResult {
  const record = asRecord(value);
  const outcome = parseEnum(record.outcome, ["completed", "failed", "canceled"] as const);
  assertExactKeys(record, outcome === "completed"
    ? [...COMMON_RESULT_KEYS, "work_issue_id", "workspace_changed", "checks", "outcome"]
    : [...COMMON_RESULT_KEYS, "work_issue_id", "workspace_changed", "checks", "outcome", "reason_markdown"]);
  const envelope = assertResultEnvelope(record, request);
  const candidate = parseWorkCandidate(Object.fromEntries(Object.entries(record)
    .filter(([key]) => !COMMON_RESULT_KEYS.includes(key as typeof COMMON_RESULT_KEYS[number]))), request);
  return Object.freeze({ ...envelope, ...candidate });
}

export function parseWorkTurnResult(
  value: unknown,
  request: WorkRequest,
  continuationAllowed: boolean,
): WorkTurnResult {
  const record = asRecord(value);
  assertExactKeys(record, [...COMMON_RESULT_KEYS, "completion_candidate", "ephemeral_continuation_markdown"]);
  const envelope = assertResultEnvelope(record, request);
  const continuation = record.ephemeral_continuation_markdown === null ? null
    : (parseMarkdownText(
      record.ephemeral_continuation_markdown,
      "invalid_ephemeral_continuation",
      16_384,
    ) as EphemeralContinuationText);
  const candidate = parseWorkCandidate(record.completion_candidate, request);
  if (continuation !== null && (candidate.outcome !== "completed" || !continuationAllowed)) {
    throw new Error("ephemeral_continuation_forbidden");
  }
  return Object.freeze({
    ...envelope,
    completion_candidate: candidate,
    ephemeral_continuation_markdown: continuation,
  });
}

export function parseVerifyRequest(value: unknown): VerifyRequest {
  const record = asRecord(value);
  assertExactKeys(record, [
    ...COMMON_REQUEST_KEYS, "cycle_revision", "verify_issue_id", "verify_issue_revision",
    "cycle_specification_markdown", "verify_instruction_markdown", "revision",
  ]);
  return Object.freeze({
    ...parsedRequestCommon(record),
    cycle_revision: parseCanonicalRevision(record.cycle_revision),
    verify_issue_id: parseStageIssueId(record.verify_issue_id),
    verify_issue_revision: parseCanonicalRevision(record.verify_issue_revision),
    cycle_specification_markdown: parseMarkdownText(record.cycle_specification_markdown, "invalid_cycle_specification"),
    verify_instruction_markdown: parseMarkdownText(record.verify_instruction_markdown, "invalid_verify_instruction"),
    revision: parseRevision(record.revision),
  });
}

export function parseVerifyResult(value: unknown, request: VerifyRequest): VerifyResult {
  const record = asRecord(value);
  const conclusion = parseEnum(record.conclusion, ["passed", "failed", "inconclusive", "canceled"] as const);
  assertExactKeys(record, conclusion === "canceled" ? [
    ...COMMON_RESULT_KEYS, "verify_issue_id", "revision", "checks", "sanitized_summary_markdown",
    "conclusion", "reason_markdown",
  ] : [
    ...COMMON_RESULT_KEYS, "verify_issue_id", "revision", "checks", "sanitized_summary_markdown",
    "conclusion",
  ]);
  const envelope = assertResultEnvelope(record, request);
  const verifyIssueId = parseStageIssueId(record.verify_issue_id);
  const revision = parseRevision(record.revision);
  if (verifyIssueId !== request.verify_issue_id || revision !== request.revision) {
    throw new Error("verify_result_target_mismatch");
  }
  const evidence = {
    ...envelope, verify_issue_id: verifyIssueId, revision,
    checks: parseChecks(record.checks),
    sanitized_summary_markdown: parseMarkdownText(record.sanitized_summary_markdown, "invalid_verify_summary"),
  };
  if (conclusion !== "canceled") return Object.freeze({ ...evidence, conclusion });
  return Object.freeze({
    ...evidence, conclusion,
    reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_verify_reason"),
  });
}
