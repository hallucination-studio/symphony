import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  parseStageIssueId,
  type CorrelationId,
  type CycleIssueId,
  type Revision,
  type RootIssueId,
  type RuntimeGeneration,
  type SchemaVersion,
  type StageIssueId,
} from "../../contracts/identity.js";
import type { RuntimeTarget } from "../../contracts/runtime.js";
import {
  asRecord,
  assertExactKeys,
  parseArray,
  parseBoundedString,
  parseEnum,
  parseStringArray,
  type UnknownRecord,
} from "../../contracts/validation.js";

export const PLAN_OUTCOMES = ["completed", "failed", "canceled"] as const;
export const MAX_PLAN_WORK_ITEMS = 32;
export const MAX_PLAN_RELATIONS = MAX_PLAN_WORK_ITEMS * (MAX_PLAN_WORK_ITEMS - 1) / 2;
export const MAX_PLAN_CHECKS = 32;
export const MAX_PLAN_PROPOSAL_DESCRIPTION_LENGTH = 2_048;
export const MAX_PERFORMER_CHECKS = 32;
export const MAX_PERFORMER_SUMMARY_LENGTH = 2_048;
export const MAX_AUTHORIZED_WORK_ISSUES = 32;

export const WORK_OUTCOMES = ["completed", "failed", "canceled"] as const;
export const VERIFY_CONCLUSIONS = ["passed", "failed", "inconclusive"] as const;
export const CHECK_STATUSES = ["passed", "failed", "not_run"] as const;

const MAX_FACT_DESCRIPTION_LENGTH = 100_000;
const WORK_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
declare const planWorkKeyBrand: unique symbol;

export type PlanWorkKey = string & { readonly [planWorkKeyBrand]: true };

export interface PlanTarget extends RuntimeTarget {
  readonly cycle_id: CycleIssueId;
}

export interface PlanIssueFacts {
  readonly title: string;
  readonly description: string | null;
}

export interface PlanRequest extends PlanTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
  readonly root: PlanIssueFacts;
  readonly cycle: PlanIssueFacts;
}

export interface ProposedPlan {
  readonly title: string;
  readonly description: string | null;
}

export interface ProposedWorkItem {
  readonly work_key: PlanWorkKey;
  readonly title: string;
  readonly description: string | null;
}

export interface ProposedWorkRelation {
  readonly prerequisite_work_key: PlanWorkKey;
  readonly dependent_work_key: PlanWorkKey;
}

export interface VerificationIntent {
  readonly title: string;
  readonly description: string | null;
  readonly checks: readonly string[];
}

interface PlanResultEnvelope extends PlanTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
}

export interface CompletedPlanResult extends PlanResultEnvelope {
  readonly outcome: "completed";
  readonly proposed_plan: ProposedPlan;
  readonly proposed_work_items: readonly ProposedWorkItem[];
  readonly proposed_relations: readonly ProposedWorkRelation[];
  readonly verification_intent: VerificationIntent;
  readonly sanitized_reason: null;
}

export interface TerminalPlanResult extends PlanResultEnvelope {
  readonly outcome: "failed" | "canceled";
  readonly proposed_plan: null;
  readonly proposed_work_items: readonly [];
  readonly proposed_relations: readonly [];
  readonly verification_intent: null;
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

export interface WorkRequest extends PlanTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
  readonly work_issue_id: StageIssueId;
  readonly authorized_work_issue_ids: readonly StageIssueId[];
  readonly root: PlanIssueFacts;
  readonly cycle: PlanIssueFacts;
  readonly work: PlanIssueFacts;
}

export interface CheckEvidence {
  readonly check: string;
  readonly status: typeof CHECK_STATUSES[number];
  readonly sanitized_summary: string | null;
}

interface WorkResultEnvelope extends PlanTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
  readonly work_issue_id: StageIssueId;
}

export interface CompletedWorkResult extends WorkResultEnvelope {
  readonly outcome: "completed";
  readonly workspace_changed: boolean;
  readonly checks: readonly CheckEvidence[];
  readonly sanitized_summary: string;
}

export interface FailedWorkResult extends WorkResultEnvelope {
  readonly outcome: "failed";
  readonly workspace_changed: boolean | null;
  readonly checks: readonly CheckEvidence[];
  readonly sanitized_summary: string;
}

export interface CanceledWorkResult extends WorkResultEnvelope {
  readonly outcome: "canceled";
  readonly workspace_changed: null;
  readonly checks: readonly CheckEvidence[];
  readonly sanitized_summary: string;
}

export type WorkResult = CompletedWorkResult | FailedWorkResult | CanceledWorkResult;

export interface WorkPerformerInterface extends StagePerformerLifecycle {
  readonly role: "work";
  work(request: WorkRequest): Promise<WorkResult>;
}

export interface VerifyTarget extends PlanTarget {
  readonly verify_issue_id: StageIssueId;
  readonly revision: Revision;
}

export interface VerifyRequest extends VerifyTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
  readonly root: PlanIssueFacts;
  readonly cycle: PlanIssueFacts;
  readonly verify: PlanIssueFacts;
  readonly requested_checks: readonly string[];
}

interface VerifyResultEnvelope extends VerifyTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
}

export interface VerifyResult extends VerifyResultEnvelope {
  readonly conclusion: typeof VERIFY_CONCLUSIONS[number];
  readonly checks: readonly CheckEvidence[];
  readonly sanitized_summary: string;
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
  "correlation_id",
  "outcome",
  "proposed_plan",
  "proposed_work_items",
  "proposed_relations",
  "verification_intent",
  "sanitized_reason",
] as const;

function parseDescription(value: unknown, code: string, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max || /\0/u.test(value)) throw new Error(code);
  return value;
}

function parseFacts(value: unknown): PlanIssueFacts {
  const record = asRecord(value);
  assertExactKeys(record, ["title", "description"]);
  return Object.freeze({
    title: parseBoundedString(record.title, "invalid_plan_fact_title", 1_024),
    description: parseDescription(
      record.description,
      "invalid_plan_fact_description",
      MAX_FACT_DESCRIPTION_LENGTH,
    ),
  });
}

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

export function parsePlanRequest(value: unknown, expected: PlanTarget): PlanRequest {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "runtime_generation",
    "cycle_id",
    "correlation_id",
    "root",
    "cycle",
  ]);
  const target = parsedTarget(record);
  assertPlanTarget(target, expected);
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    ...target,
    correlation_id: parseCorrelationId(record.correlation_id),
    root: parseFacts(record.root),
    cycle: parseFacts(record.cycle),
  });
}

function parseProposalDescription(value: unknown): string | null {
  return parseDescription(
    value,
    "invalid_plan_proposal_description",
    MAX_PLAN_PROPOSAL_DESCRIPTION_LENGTH,
  );
}

function parseProposal(value: unknown): ProposedPlan {
  const record = asRecord(value);
  assertExactKeys(record, ["title", "description"]);
  return Object.freeze({
    title: parseBoundedString(record.title, "invalid_plan_proposal_title", 1_024),
    description: parseProposalDescription(record.description),
  });
}

function parseWorkKey(value: unknown): PlanWorkKey {
  const key = parseBoundedString(value, "invalid_plan_work_key", 64);
  if (!WORK_KEY_PATTERN.test(key)) throw new Error("invalid_plan_work_key");
  return key as PlanWorkKey;
}

function parseWorkItem(value: unknown): ProposedWorkItem {
  const record = asRecord(value);
  assertExactKeys(record, ["work_key", "title", "description"]);
  return Object.freeze({
    work_key: parseWorkKey(record.work_key),
    title: parseBoundedString(record.title, "invalid_plan_work_title", 1_024),
    description: parseProposalDescription(record.description),
  });
}

function parseRelation(value: unknown): ProposedWorkRelation {
  const record = asRecord(value);
  assertExactKeys(record, ["prerequisite_work_key", "dependent_work_key"]);
  return Object.freeze({
    prerequisite_work_key: parseWorkKey(record.prerequisite_work_key),
    dependent_work_key: parseWorkKey(record.dependent_work_key),
  });
}

function parseVerificationIntent(value: unknown): VerificationIntent {
  const record = asRecord(value);
  assertExactKeys(record, ["title", "description", "checks"]);
  const checks = parseStringArray(
    record.checks,
    (entry) => parseBoundedString(entry, "invalid_plan_verification_check", 1_024),
    MAX_PLAN_CHECKS,
  );
  if (checks.length === 0) throw new Error("plan_verification_checks_required");
  return Object.freeze({
    title: parseBoundedString(record.title, "invalid_plan_verification_title", 1_024),
    description: parseProposalDescription(record.description),
    checks,
  });
}

function assertValidRelations(
  workItems: readonly ProposedWorkItem[],
  relations: readonly ProposedWorkRelation[],
): void {
  const workKeys = new Set(workItems.map(({ work_key }) => work_key));
  const relationKeys = new Set<string>();
  const dependents = new Map<PlanWorkKey, PlanWorkKey[]>(
    workItems.map(({ work_key }) => [work_key, []]),
  );
  const incoming = new Map<PlanWorkKey, number>(workItems.map(({ work_key }) => [work_key, 0]));

  for (const relation of relations) {
    const { prerequisite_work_key: prerequisite, dependent_work_key: dependent } = relation;
    if (!workKeys.has(prerequisite) || !workKeys.has(dependent)) {
      throw new Error("unknown_plan_relation_endpoint");
    }
    if (prerequisite === dependent) throw new Error("self_plan_relation");
    const relationKey = `${prerequisite}\0${dependent}`;
    if (relationKeys.has(relationKey)) throw new Error("duplicate_plan_relation");
    relationKeys.add(relationKey);
    dependents.get(prerequisite)?.push(dependent);
    incoming.set(dependent, (incoming.get(dependent) ?? 0) + 1);
  }

  const ready = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([workKey]) => workKey);
  let visited = 0;
  while (ready.length > 0) {
    const workKey = ready.pop();
    if (workKey === undefined) break;
    visited += 1;
    for (const dependent of dependents.get(workKey) ?? []) {
      const nextCount = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, nextCount);
      if (nextCount === 0) ready.push(dependent);
    }
  }
  if (visited !== workItems.length) throw new Error("cyclic_plan_relations");
}

function parseResultEnvelope(record: UnknownRecord, request: PlanRequest): PlanResultEnvelope {
  const target = parsedTarget(record);
  assertPlanTarget(target, request);
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
    const proposedWorkItems = parseArray(record.proposed_work_items, parseWorkItem, MAX_PLAN_WORK_ITEMS);
    if (proposedWorkItems.length === 0) throw new Error("plan_work_items_required");
    if (new Set(proposedWorkItems.map(({ work_key }) => work_key)).size !== proposedWorkItems.length) {
      throw new Error("duplicate_plan_work_key");
    }
    const proposedRelations = parseArray(record.proposed_relations, parseRelation, MAX_PLAN_RELATIONS);
    assertValidRelations(proposedWorkItems, proposedRelations);
    return Object.freeze({
      ...envelope,
      outcome,
      proposed_plan: parseProposal(record.proposed_plan),
      proposed_work_items: proposedWorkItems,
      proposed_relations: proposedRelations,
      verification_intent: parseVerificationIntent(record.verification_intent),
      sanitized_reason: null,
    });
  }

  if (
    record.proposed_plan !== null
    || !Array.isArray(record.proposed_work_items)
    || record.proposed_work_items.length !== 0
    || !Array.isArray(record.proposed_relations)
    || record.proposed_relations.length !== 0
    || record.verification_intent !== null
  ) throw new Error("terminal_plan_proposal_forbidden");
  return Object.freeze({
    ...envelope,
    outcome,
    proposed_plan: null,
    proposed_work_items: Object.freeze([]) as readonly [],
    proposed_relations: Object.freeze([]) as readonly [],
    verification_intent: null,
    sanitized_reason: parseReason(record.sanitized_reason),
  });
}

const WORK_RESULT_KEYS = [
  "schema_version",
  "root_id",
  "runtime_generation",
  "cycle_id",
  "correlation_id",
  "work_issue_id",
  "outcome",
  "workspace_changed",
  "checks",
  "sanitized_summary",
] as const;

const VERIFY_RESULT_KEYS = [
  "schema_version",
  "root_id",
  "runtime_generation",
  "cycle_id",
  "correlation_id",
  "verify_issue_id",
  "revision",
  "conclusion",
  "checks",
  "sanitized_summary",
] as const;

function parseRoleFacts(value: unknown, role: "work" | "verify"): PlanIssueFacts {
  const record = asRecord(value);
  assertExactKeys(record, ["title", "description"]);
  return Object.freeze({
    title: parseBoundedString(record.title, `invalid_${role}_fact_title`, 1_024),
    description: parseDescription(
      record.description,
      `invalid_${role}_fact_description`,
      MAX_FACT_DESCRIPTION_LENGTH,
    ),
  });
}

function assertCycleTarget(
  actual: PlanTarget,
  expected: PlanTarget,
  code: "work_target_mismatch" | "verify_target_mismatch",
): void {
  if (
    actual.root_id !== expected.root_id
    || actual.runtime_generation !== expected.runtime_generation
    || actual.cycle_id !== expected.cycle_id
  ) throw new Error(code);
}

export function parseWorkRequest(value: unknown, expected: PlanTarget): WorkRequest {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "runtime_generation",
    "cycle_id",
    "correlation_id",
    "work_issue_id",
    "authorized_work_issue_ids",
    "root",
    "cycle",
    "work",
  ]);
  const target = parsedTarget(record);
  assertCycleTarget(target, expected, "work_target_mismatch");
  const workIssueId = parseStageIssueId(record.work_issue_id);
  const authorizedWorkIssueIds = parseArray(
    record.authorized_work_issue_ids,
    parseStageIssueId,
    MAX_AUTHORIZED_WORK_ISSUES,
  );
  if (authorizedWorkIssueIds.length === 0) throw new Error("work_authority_required");
  if (new Set(authorizedWorkIssueIds).size !== authorizedWorkIssueIds.length) {
    throw new Error("duplicate_work_authority");
  }
  if (!authorizedWorkIssueIds.includes(workIssueId)) throw new Error("work_issue_not_authorized");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    ...target,
    correlation_id: parseCorrelationId(record.correlation_id),
    work_issue_id: workIssueId,
    authorized_work_issue_ids: authorizedWorkIssueIds,
    root: parseRoleFacts(record.root, "work"),
    cycle: parseRoleFacts(record.cycle, "work"),
    work: parseRoleFacts(record.work, "work"),
  });
}

function parseSanitizedSummary(
  value: unknown,
  code: "invalid_work_summary" | "invalid_verify_summary" | "invalid_check_summary",
  max = MAX_PERFORMER_SUMMARY_LENGTH,
): string {
  const summary = parseBoundedString(value, code, max);
  if (!/^[\x20-\x7E]+$/u.test(summary)) throw new Error(code);
  return summary;
}

function parseCheckEvidence(value: unknown, role: "work" | "verify"): CheckEvidence {
  const record = asRecord(value);
  assertExactKeys(record, ["check", "status", "sanitized_summary"]);
  return Object.freeze({
    check: parseBoundedString(record.check, `invalid_${role}_check`, 1_024),
    status: parseEnum(record.status, CHECK_STATUSES),
    sanitized_summary: record.sanitized_summary === null
      ? null
      : parseSanitizedSummary(record.sanitized_summary, "invalid_check_summary", 1_024),
  });
}

function parseChecks(value: unknown, role: "work" | "verify"): readonly CheckEvidence[] {
  const checks = parseArray(
    value,
    (entry) => parseCheckEvidence(entry, role),
    MAX_PERFORMER_CHECKS,
  );
  if (new Set(checks.map(({ check }) => check)).size !== checks.length) {
    throw new Error(`duplicate_${role}_check`);
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
  const target = parsedTarget(record);
  assertCycleTarget(target, request, "work_target_mismatch");
  const correlationId = parseCorrelationId(record.correlation_id);
  if (correlationId !== request.correlation_id) throw new Error("work_correlation_mismatch");
  const workIssueId = parseStageIssueId(record.work_issue_id);
  if (workIssueId !== request.work_issue_id) throw new Error("work_issue_mismatch");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    ...target,
    correlation_id: correlationId,
    work_issue_id: workIssueId,
  });
}

export function parseWorkResult(value: unknown, request: WorkRequest): WorkResult {
  const record = asRecord(value);
  assertExactKeys(record, WORK_RESULT_KEYS);
  const envelope = parseWorkResultEnvelope(record, request);
  const outcome = parseEnum(record.outcome, WORK_OUTCOMES);
  const workspaceChanged = parseWorkspaceChanged(record.workspace_changed);
  const checks = parseChecks(record.checks, "work");
  const sanitizedSummary = parseSanitizedSummary(record.sanitized_summary, "invalid_work_summary");

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
      sanitized_summary: sanitizedSummary,
    });
  }

  if (outcome === "failed") {
    return Object.freeze({
      ...envelope,
      outcome,
      workspace_changed: workspaceChanged,
      checks,
      sanitized_summary: sanitizedSummary,
    });
  }
  if (workspaceChanged !== null) throw new Error("canceled_work_change_unknown");
  return Object.freeze({
    ...envelope,
    outcome,
    workspace_changed: null,
    checks,
    sanitized_summary: sanitizedSummary,
  });
}

function parsedVerifyTarget(record: UnknownRecord): VerifyTarget {
  return Object.freeze({
    ...parsedTarget(record),
    verify_issue_id: parseStageIssueId(record.verify_issue_id),
    revision: parseRevision(record.revision),
  });
}

function assertVerifyTarget(actual: VerifyTarget, expected: VerifyTarget): void {
  assertCycleTarget(actual, expected, "verify_target_mismatch");
  if (
    actual.verify_issue_id !== expected.verify_issue_id
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
    "correlation_id",
    "verify_issue_id",
    "revision",
    "root",
    "cycle",
    "verify",
    "requested_checks",
  ]);
  const target = parsedVerifyTarget(record);
  assertVerifyTarget(target, expected);
  const requestedChecks = parseStringArray(
    record.requested_checks,
    (entry) => parseBoundedString(entry, "invalid_verify_check", 1_024),
    MAX_PERFORMER_CHECKS,
  );
  if (requestedChecks.length === 0) throw new Error("verify_checks_required");
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    ...target,
    correlation_id: parseCorrelationId(record.correlation_id),
    root: parseRoleFacts(record.root, "verify"),
    cycle: parseRoleFacts(record.cycle, "verify"),
    verify: parseRoleFacts(record.verify, "verify"),
    requested_checks: requestedChecks,
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
  const checks = parseChecks(record.checks, "verify");
  const requestedChecks = new Set(request.requested_checks);
  if (checks.some(({ check }) => !requestedChecks.has(check))) {
    throw new Error("unknown_verify_check");
  }

  if (conclusion === "passed") {
    if (checks.length !== request.requested_checks.length) {
      throw new Error("passed_verify_check_coverage");
    }
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
    sanitized_summary: parseSanitizedSummary(record.sanitized_summary, "invalid_verify_summary"),
  });
}
