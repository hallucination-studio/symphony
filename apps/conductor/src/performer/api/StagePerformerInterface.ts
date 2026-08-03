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
} from "../../contracts/identity.js";
import {
  parseCycleDraftMarkdown,
} from "../../contracts/cycle.js";
import type { RuntimeTarget } from "../../contracts/runtime.js";
import {
  asRecord,
  assertExactKeys,
  containsCredentialMaterial,
  parseArray,
  parseBoundedString,
  parseEnum,
  parseMarkdownText,
  type MarkdownText,
  type UnknownRecord,
} from "../../contracts/validation.js";

export const PLAN_OUTCOMES = ["completed", "failed", "canceled"] as const;
export const MAX_PLAN_WORK_ITEMS = 32;
export const MAX_PERFORMER_CHECKS = 32;
export const MAX_PERFORMER_SUMMARY_LENGTH = 2_048;

export const WORK_OUTCOMES = ["completed", "failed", "canceled"] as const;
export const VERIFY_CONCLUSIONS = ["passed", "failed", "inconclusive"] as const;
export const CHECK_STATUSES = ["passed", "failed", "not_run"] as const;

export interface PlanTarget extends RuntimeTarget {
  readonly cycle_id: CycleIssueId;
}

export interface PlanRequestTarget extends PlanTarget {
  readonly cycle_revision: TaskRevision;
}

export interface PlanRequest extends PlanRequestTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
  readonly cycle_description_markdown: MarkdownText;
  readonly root_adr_markdown: MarkdownText;
  readonly approved_work_groups: readonly [PlanWorkGroup, ...PlanWorkGroup[]];
}

export interface PlanWorkGroup {
  readonly work_group_id: string;
  readonly depends_on_work_group_ids: readonly string[];
}

interface PlanResultEnvelope extends PlanRequestTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
}

export interface CompletedPlanResult extends PlanResultEnvelope {
  readonly outcome: "completed";
  readonly ordered_work_group_ids: readonly [string, ...string[]];
  readonly sanitized_reason: null;
}

export interface TerminalPlanResult extends PlanResultEnvelope {
  readonly outcome: "failed" | "canceled";
  readonly ordered_work_group_ids: readonly [];
  readonly sanitized_reason: string;
}

export type PlanResult = CompletedPlanResult | TerminalPlanResult;

interface StagePerformerLifecycle {
  readonly rootId: RootIssueId;
  readonly runtimeGeneration: RuntimeGeneration;
  readonly cycleId: CycleIssueId;
  close(): Promise<void>;
}

export interface PlanPerformerInterface extends StagePerformerLifecycle {
  readonly role: "plan";
  plan(request: PlanRequest): Promise<PlanResult>;
}

export interface WorkRequestTarget extends PlanRequestTarget {
  readonly work_issue_id: StageIssueId;
  readonly work_issue_revision: TaskRevision;
}

export interface WorkRequest extends WorkRequestTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
  readonly cycle_description_markdown: MarkdownText;
  readonly work_issue_description_markdown: MarkdownText;
}

export interface VerifyCheckEvidence {
  readonly check: string;
  readonly status: typeof CHECK_STATUSES[number];
  readonly sanitized_summary_markdown: MarkdownText | null;
}

export interface WorkCheckEvidence {
  readonly check: string;
  readonly status: typeof CHECK_STATUSES[number];
  readonly sanitized_summary_markdown: MarkdownText | null;
}

interface WorkResultEnvelope extends WorkRequestTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
}

export interface CompletedWorkResult extends WorkResultEnvelope {
  readonly outcome: "completed";
  readonly workspace_changed: boolean;
  readonly checks: readonly WorkCheckEvidence[];
  readonly sanitized_summary_markdown: MarkdownText;
}

export interface FailedWorkResult extends WorkResultEnvelope {
  readonly outcome: "failed";
  readonly workspace_changed: boolean | null;
  readonly checks: readonly WorkCheckEvidence[];
  readonly sanitized_summary_markdown: MarkdownText;
}

export interface CanceledWorkResult extends WorkResultEnvelope {
  readonly outcome: "canceled";
  readonly workspace_changed: null;
  readonly checks: readonly WorkCheckEvidence[];
  readonly sanitized_summary_markdown: MarkdownText;
}

export type WorkResult = CompletedWorkResult | FailedWorkResult | CanceledWorkResult;

export interface WorkPerformerInterface extends StagePerformerLifecycle {
  readonly role: "work";
  work(request: WorkRequest): Promise<WorkResult>;
}

export interface VerifyTarget extends PlanRequestTarget {
  readonly verify_issue_id: StageIssueId;
  readonly verify_issue_revision: TaskRevision;
  readonly revision: Revision;
}

export interface VerifyRequest extends VerifyTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
  readonly cycle_description_markdown: MarkdownText;
  readonly verify_issue_description_markdown: MarkdownText;
}

interface VerifyResultEnvelope extends VerifyTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
}

export interface VerifyResult extends VerifyResultEnvelope {
  readonly conclusion: typeof VERIFY_CONCLUSIONS[number];
  readonly checks: readonly VerifyCheckEvidence[];
  readonly sanitized_summary_markdown: MarkdownText;
}

export interface VerifyPerformerInterface extends StagePerformerLifecycle {
  readonly role: "verify";
  verify(request: VerifyRequest): Promise<VerifyResult>;
}

export type StagePerformerInterface =
  | PlanPerformerInterface
  | WorkPerformerInterface
  | VerifyPerformerInterface;

const PLAN_RESULT_KEYS = [
  "schema_version",
  "root_id",
  "runtime_generation",
  "cycle_id",
  "cycle_revision",
  "correlation_id",
  "outcome",
  "ordered_work_group_ids",
  "sanitized_reason",
] as const;

function parsedTarget(record: UnknownRecord): PlanTarget {
  return Object.freeze({
    root_id: parseRootIssueId(record.root_id),
    runtime_generation: parseRuntimeGeneration(record.runtime_generation),
    cycle_id: parseCycleIssueId(record.cycle_id),
  });
}

function assertPlanTarget(actual: PlanTarget, expected: PlanTarget): void {
  if (
    actual.root_id !== expected.root_id
    || actual.runtime_generation !== expected.runtime_generation
    || actual.cycle_id !== expected.cycle_id
  ) throw new Error("plan_target_mismatch");
}

function parsedPlanRequestTarget(record: UnknownRecord): PlanRequestTarget {
  return Object.freeze({
    ...parsedTarget(record),
    cycle_revision: parseTaskRevision(record.cycle_revision),
  });
}

function assertPlanRequestTarget(actual: PlanRequestTarget, expected: PlanRequestTarget): void {
  assertPlanTarget(actual, expected);
  if (actual.cycle_revision !== expected.cycle_revision) throw new Error("plan_target_mismatch");
}

export function parsePlanRequest(value: unknown, expected: PlanRequestTarget): PlanRequest {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "runtime_generation",
    "cycle_id",
    "cycle_revision",
    "correlation_id",
    "cycle_description_markdown",
    "root_adr_markdown",
    "approved_work_groups",
  ]);
  const target = parsedPlanRequestTarget(record);
  assertPlanRequestTarget(target, expected);
  const cycleDescription = parseMarkdownText(
    record.cycle_description_markdown,
    "invalid_plan_cycle_markdown",
  );
  const cycleDraft = parseCycleDraftMarkdown(cycleDescription);
  const rootAdr = parseMarkdownText(record.root_adr_markdown, "invalid_plan_root_adr_markdown");
  if (rootAdr !== cycleDraft.root_adr_markdown) throw new Error("plan_root_adr_mismatch");
  const approvedWorkGroups = parseArray(record.approved_work_groups, (value) => {
    const group = asRecord(value);
    assertExactKeys(group, ["work_group_id", "depends_on_work_group_ids"]);
    return Object.freeze({
      work_group_id: parseBoundedString(group.work_group_id, "invalid_plan_work_group_id", 128),
      depends_on_work_group_ids: parseArray(
        group.depends_on_work_group_ids,
        (entry) => parseBoundedString(entry, "invalid_plan_work_group_dependency_id", 128),
        MAX_PLAN_WORK_ITEMS,
      ),
    });
  }, MAX_PLAN_WORK_ITEMS);
  if (approvedWorkGroups.length === 0) throw new Error("plan_work_groups_required");
  const groupIds = approvedWorkGroups.map(({ work_group_id }) => work_group_id);
  if (new Set(groupIds).size !== groupIds.length) throw new Error("duplicate_plan_work_group_id");
  const known = new Set(groupIds);
  for (const group of approvedWorkGroups) {
    if (new Set(group.depends_on_work_group_ids).size !== group.depends_on_work_group_ids.length) {
      throw new Error("duplicate_plan_work_group_dependency");
    }
    if (group.depends_on_work_group_ids.some((id) => id === group.work_group_id || !known.has(id))) {
      throw new Error("invalid_plan_work_group_dependency");
    }
  }
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    ...target,
    correlation_id: parseCorrelationId(record.correlation_id),
    cycle_description_markdown: cycleDescription,
    root_adr_markdown: rootAdr,
    approved_work_groups: approvedWorkGroups as readonly [PlanWorkGroup, ...PlanWorkGroup[]],
  });
}

function parseResultEnvelope(record: UnknownRecord, request: PlanRequest): PlanResultEnvelope {
  const target = parsedPlanRequestTarget(record);
  assertPlanRequestTarget(target, request);
  const correlationId = parseCorrelationId(record.correlation_id);
  if (correlationId !== request.correlation_id) throw new Error("plan_correlation_mismatch");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    ...target,
    correlation_id: correlationId,
  });
}

function parseReason(value: unknown): string {
  const reason = parseBoundedString(value, "invalid_plan_reason", 256);
  if (!/^[\x20-\x7E]+$/u.test(reason)) throw new Error("invalid_plan_reason");
  return reason;
}

export function parsePlanResult(value: unknown, request: PlanRequest): PlanResult {
  const record = asRecord(value);
  assertExactKeys(record, PLAN_RESULT_KEYS);
  const envelope = parseResultEnvelope(record, request);
  const outcome = parseEnum(record.outcome, PLAN_OUTCOMES);

  if (outcome === "completed") {
    if (record.sanitized_reason !== null) throw new Error("completed_plan_reason_forbidden");
    const orderedIds = parseArray(
      record.ordered_work_group_ids,
      (entry) => parseBoundedString(entry, "invalid_plan_work_group_id", 128),
      MAX_PLAN_WORK_ITEMS,
    );
    const expectedIds = request.approved_work_groups.map(({ work_group_id }) => work_group_id);
    if (
      orderedIds.length !== expectedIds.length
      || new Set(orderedIds).size !== orderedIds.length
      || orderedIds.some((id) => !expectedIds.includes(id))
    ) throw new Error("plan_work_group_order_mismatch");
    const position = new Map(orderedIds.map((id, index) => [id, index]));
    for (const group of request.approved_work_groups) {
      if (group.depends_on_work_group_ids.some((dependency) => position.get(dependency)! >= position.get(group.work_group_id)!)) {
        throw new Error("plan_work_group_order_illegal");
      }
    }
    return Object.freeze({
      ...envelope,
      outcome,
      ordered_work_group_ids: orderedIds as readonly [string, ...string[]],
      sanitized_reason: null,
    });
  }

  if (!Array.isArray(record.ordered_work_group_ids) || record.ordered_work_group_ids.length !== 0) {
    throw new Error("terminal_plan_order_forbidden");
  }
  return Object.freeze({
    ...envelope,
    outcome,
    ordered_work_group_ids: Object.freeze([]) as readonly [],
    sanitized_reason: parseReason(record.sanitized_reason),
  });
}

const WORK_RESULT_KEYS = [
  "schema_version",
  "root_id",
  "runtime_generation",
  "cycle_id",
  "cycle_revision",
  "correlation_id",
  "work_issue_id",
  "work_issue_revision",
  "outcome",
  "workspace_changed",
  "checks",
  "sanitized_summary_markdown",
] as const;

const VERIFY_RESULT_KEYS = [
  "schema_version",
  "root_id",
  "runtime_generation",
  "cycle_id",
  "cycle_revision",
  "correlation_id",
  "verify_issue_id",
  "verify_issue_revision",
  "revision",
  "conclusion",
  "checks",
  "sanitized_summary_markdown",
] as const;

function assertWorkCycleTarget(
  actual: PlanRequestTarget,
  expected: PlanRequestTarget,
): void {
  if (
    actual.root_id !== expected.root_id
    || actual.runtime_generation !== expected.runtime_generation
    || actual.cycle_id !== expected.cycle_id
    || actual.cycle_revision !== expected.cycle_revision
  ) throw new Error("work_target_mismatch");
}

export function parseWorkRequest(value: unknown, expected: PlanRequestTarget): WorkRequest {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "runtime_generation",
    "cycle_id",
    "cycle_revision",
    "correlation_id",
    "work_issue_id",
    "work_issue_revision",
    "cycle_description_markdown",
    "work_issue_description_markdown",
  ]);
  const target = parsedPlanRequestTarget(record);
  assertWorkCycleTarget(target, expected);
  const cycleDescription = parseMarkdownText(
    record.cycle_description_markdown,
    "invalid_work_cycle_markdown",
  );
  parseCycleDraftMarkdown(cycleDescription);
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    ...target,
    correlation_id: parseCorrelationId(record.correlation_id),
    work_issue_id: parseStageIssueId(record.work_issue_id),
    work_issue_revision: parseTaskRevision(record.work_issue_revision),
    cycle_description_markdown: cycleDescription,
    work_issue_description_markdown: parseMarkdownText(
      record.work_issue_description_markdown,
      "invalid_work_issue_markdown",
    ),
  });
}

function parseVerifyCheckEvidence(value: unknown): VerifyCheckEvidence {
  const record = asRecord(value);
  assertExactKeys(record, ["check", "status", "sanitized_summary_markdown"]);
  const check = parseBoundedString(record.check, "invalid_verify_check", 1_024);
  if (containsCredentialMaterial(check)) throw new Error("invalid_verify_check");
  return Object.freeze({
    check,
    status: parseEnum(record.status, CHECK_STATUSES),
    sanitized_summary_markdown: record.sanitized_summary_markdown === null
      ? null
      : parseMarkdownText(
        record.sanitized_summary_markdown,
        "invalid_verify_check_summary_markdown",
        1_024,
      ),
  });
}

function parseVerifyChecks(value: unknown): readonly VerifyCheckEvidence[] {
  const checks = parseArray(
    value,
    parseVerifyCheckEvidence,
    MAX_PERFORMER_CHECKS,
  );
  if (new Set(checks.map(({ check }) => check)).size !== checks.length) {
    throw new Error("duplicate_verify_check");
  }
  return checks;
}

function parseWorkCheckEvidence(value: unknown): WorkCheckEvidence {
  const record = asRecord(value);
  assertExactKeys(record, ["check", "status", "sanitized_summary_markdown"]);
  const check = parseBoundedString(record.check, "invalid_work_check", 1_024);
  if (containsCredentialMaterial(check)) throw new Error("invalid_work_check");
  return Object.freeze({
    check,
    status: parseEnum(record.status, CHECK_STATUSES),
    sanitized_summary_markdown: record.sanitized_summary_markdown === null
      ? null
      : parseMarkdownText(
        record.sanitized_summary_markdown,
        "invalid_check_summary_markdown",
        1_024,
      ),
  });
}

function parseWorkChecks(value: unknown): readonly WorkCheckEvidence[] {
  const checks = parseArray(value, parseWorkCheckEvidence, MAX_PERFORMER_CHECKS);
  if (new Set(checks.map(({ check }) => check)).size !== checks.length) {
    throw new Error("duplicate_work_check");
  }
  return checks;
}

function parseWorkspaceChanged(value: unknown): boolean | null {
  if (value !== null && typeof value !== "boolean") throw new Error("invalid_workspace_changed");
  return value;
}

function parseWorkResultEnvelope(
  record: UnknownRecord,
  request: WorkRequest,
): WorkResultEnvelope {
  const target = parsedPlanRequestTarget(record);
  assertWorkCycleTarget(target, request);
  const correlationId = parseCorrelationId(record.correlation_id);
  if (correlationId !== request.correlation_id) throw new Error("work_correlation_mismatch");
  const workIssueId = parseStageIssueId(record.work_issue_id);
  if (workIssueId !== request.work_issue_id) throw new Error("work_issue_mismatch");
  const workIssueRevision = parseTaskRevision(record.work_issue_revision);
  if (workIssueRevision !== request.work_issue_revision) throw new Error("work_issue_mismatch");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    ...target,
    correlation_id: correlationId,
    work_issue_id: workIssueId,
    work_issue_revision: workIssueRevision,
  });
}

export function parseWorkResult(value: unknown, request: WorkRequest): WorkResult {
  const record = asRecord(value);
  assertExactKeys(record, WORK_RESULT_KEYS);
  const envelope = parseWorkResultEnvelope(record, request);
  const outcome = parseEnum(record.outcome, WORK_OUTCOMES);
  const workspaceChanged = parseWorkspaceChanged(record.workspace_changed);
  const checks = parseWorkChecks(record.checks);
  const sanitizedSummary = parseMarkdownText(
    record.sanitized_summary_markdown,
    "invalid_work_summary_markdown",
    MAX_PERFORMER_SUMMARY_LENGTH,
  );

  if (outcome === "completed") {
    if (workspaceChanged === null) throw new Error("completed_work_change_unknown");
    if (checks.length === 0) throw new Error("completed_work_checks_required");
    if (checks.some(({ status }) => status !== "passed")) {
      throw new Error("completed_work_check_failed");
    }
    return Object.freeze({
      ...envelope,
      outcome,
      workspace_changed: workspaceChanged,
      checks,
      sanitized_summary_markdown: sanitizedSummary,
    });
  }

  if (outcome === "failed") {
    return Object.freeze({
      ...envelope,
      outcome,
      workspace_changed: workspaceChanged,
      checks,
      sanitized_summary_markdown: sanitizedSummary,
    });
  }
  if (workspaceChanged !== null) throw new Error("canceled_work_change_unknown");
  return Object.freeze({
    ...envelope,
    outcome,
    workspace_changed: null,
    checks,
    sanitized_summary_markdown: sanitizedSummary,
  });
}

function parsedVerifyTarget(record: UnknownRecord): VerifyTarget {
  return Object.freeze({
    ...parsedPlanRequestTarget(record),
    verify_issue_id: parseStageIssueId(record.verify_issue_id),
    verify_issue_revision: parseTaskRevision(record.verify_issue_revision),
    revision: parseRevision(record.revision),
  });
}

function assertVerifyTarget(actual: VerifyTarget, expected: VerifyTarget): void {
  if (
    actual.root_id !== expected.root_id
    || actual.runtime_generation !== expected.runtime_generation
    || actual.cycle_id !== expected.cycle_id
    || actual.cycle_revision !== expected.cycle_revision
  ) throw new Error("verify_target_mismatch");
  if (
    actual.verify_issue_id !== expected.verify_issue_id
    || actual.verify_issue_revision !== expected.verify_issue_revision
    || actual.revision !== expected.revision
  ) throw new Error("verify_target_mismatch");
}

export function parseVerifyRequest(value: unknown, expected: VerifyTarget): VerifyRequest {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "runtime_generation",
    "cycle_id",
    "cycle_revision",
    "correlation_id",
    "verify_issue_id",
    "verify_issue_revision",
    "revision",
    "cycle_description_markdown",
    "verify_issue_description_markdown",
  ]);
  const target = parsedVerifyTarget(record);
  assertVerifyTarget(target, expected);
  const cycleDescription = parseMarkdownText(
    record.cycle_description_markdown,
    "invalid_verify_cycle_markdown",
  );
  parseCycleDraftMarkdown(cycleDescription);
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    ...target,
    correlation_id: parseCorrelationId(record.correlation_id),
    cycle_description_markdown: cycleDescription,
    verify_issue_description_markdown: parseMarkdownText(
      record.verify_issue_description_markdown,
      "invalid_verify_issue_markdown",
    ),
  });
}

function parseVerifyResultEnvelope(
  record: UnknownRecord,
  request: VerifyRequest,
): VerifyResultEnvelope {
  const target = parsedVerifyTarget(record);
  assertVerifyTarget(target, request);
  const correlationId = parseCorrelationId(record.correlation_id);
  if (correlationId !== request.correlation_id) throw new Error("verify_correlation_mismatch");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    ...target,
    correlation_id: correlationId,
  });
}

export function parseVerifyResult(value: unknown, request: VerifyRequest): VerifyResult {
  const record = asRecord(value);
  assertExactKeys(record, VERIFY_RESULT_KEYS);
  const envelope = parseVerifyResultEnvelope(record, request);
  const conclusion = parseEnum(record.conclusion, VERIFY_CONCLUSIONS);
  const checks = parseVerifyChecks(record.checks);

  if (conclusion === "passed") {
    if (checks.length === 0) throw new Error("passed_verify_checks_required");
    if (checks.some(({ status }) => status !== "passed")) {
      throw new Error("passed_verify_check_failed");
    }
  } else if (conclusion === "failed") {
    if (!checks.some(({ status }) => status === "failed")) {
      throw new Error("failed_verify_check_required");
    }
  } else if (checks.some(({ status }) => status === "failed")) {
    throw new Error("inconclusive_verify_failed_check");
  }

  return Object.freeze({
    ...envelope,
    conclusion,
    checks,
    sanitized_summary_markdown: parseMarkdownText(
      record.sanitized_summary_markdown,
      "invalid_verify_summary_markdown",
      MAX_PERFORMER_SUMMARY_LENGTH,
    ),
  });
}
