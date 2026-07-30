import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  type CorrelationId,
  type CycleIssueId,
  type RootIssueId,
  type RuntimeGeneration,
  type SchemaVersion,
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

export interface StagePerformerInterface {
  readonly rootId: RootIssueId;
  readonly runtimeGeneration: RuntimeGeneration;
  readonly cycleId: CycleIssueId;
  plan(request: PlanRequest): Promise<PlanResult>;
  close(): Promise<void>;
}

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
