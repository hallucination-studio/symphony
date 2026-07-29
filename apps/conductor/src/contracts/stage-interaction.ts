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
} from "./identity.js";
import { asRecord, assertExactKeys, parseEnum, parseStringArray } from "./validation.js";

interface StageEnvelope {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly cycle_issue_id: CycleIssueId;
}

export type PlanRequest = StageEnvelope & { readonly role: "plan" };
export type WorkRequest = StageEnvelope & { readonly role: "work"; readonly work_issue_id: StageIssueId };
export type VerifyRequest = StageEnvelope & { readonly role: "verify"; readonly verify_issue_id: StageIssueId; readonly revision: Revision };
export type StageRequest = PlanRequest | WorkRequest | VerifyRequest;

export type PlanHandoff = StageEnvelope & {
  readonly role: "plan";
  readonly plan_issue_id: StageIssueId;
  readonly work_issue_ids: readonly StageIssueId[];
  readonly verify_issue_id: StageIssueId;
  readonly outcome: "completed" | "failed" | "canceled";
};

export type WorkHandoff = StageEnvelope & {
  readonly role: "work";
  readonly work_issue_id: StageIssueId;
  readonly outcome: "completed" | "failed" | "canceled";
  readonly workspace_changed: boolean;
};

export type VerifyHandoff = StageEnvelope & {
  readonly role: "verify";
  readonly verify_issue_id: StageIssueId;
  readonly revision: Revision;
  readonly conclusion: "passed" | "failed" | "inconclusive";
};

export type StageHandoff = PlanHandoff | WorkHandoff | VerifyHandoff;

function envelope(record: Record<string, unknown>): StageEnvelope {
  return {
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: parseRootIssueId(record.root_id),
    runtime_generation: parseRuntimeGeneration(record.runtime_generation),
    correlation_id: parseCorrelationId(record.correlation_id),
    cycle_issue_id: parseCycleIssueId(record.cycle_issue_id),
  };
}

export function parseStageRequest(value: unknown): StageRequest {
  const record = asRecord(value);
  const base = envelope(record);
  const role = parseEnum(record.role, ["plan", "work", "verify"] as const);
  const prefix = ["schema_version", "root_id", "runtime_generation", "correlation_id", "cycle_issue_id", "role"];
  if (role === "plan") {
    assertExactKeys(record, prefix);
    return Object.freeze({ ...base, role });
  }
  if (role === "work") {
    assertExactKeys(record, [...prefix, "work_issue_id"]);
    return Object.freeze({ ...base, role, work_issue_id: parseStageIssueId(record.work_issue_id) });
  }
  assertExactKeys(record, [...prefix, "verify_issue_id", "revision"]);
  return Object.freeze({
    ...base,
    role,
    verify_issue_id: parseStageIssueId(record.verify_issue_id),
    revision: parseRevision(record.revision),
  });
}

export function parseStageHandoff(value: unknown): StageHandoff {
  const record = asRecord(value);
  const base = envelope(record);
  const role = parseEnum(record.role, ["plan", "work", "verify"] as const);
  const prefix = ["schema_version", "root_id", "runtime_generation", "correlation_id", "cycle_issue_id", "role"];
  if (role === "plan") {
    assertExactKeys(record, [...prefix, "plan_issue_id", "work_issue_ids", "verify_issue_id", "outcome"]);
    return Object.freeze({
      ...base,
      role,
      plan_issue_id: parseStageIssueId(record.plan_issue_id),
      work_issue_ids: parseStringArray(record.work_issue_ids, parseStageIssueId) as readonly StageIssueId[],
      verify_issue_id: parseStageIssueId(record.verify_issue_id),
      outcome: parseEnum(record.outcome, ["completed", "failed", "canceled"] as const),
    });
  }
  if (role === "work") {
    assertExactKeys(record, [...prefix, "work_issue_id", "outcome", "workspace_changed"]);
    if (typeof record.workspace_changed !== "boolean") throw new Error("invalid_workspace_changed");
    return Object.freeze({
      ...base,
      role,
      work_issue_id: parseStageIssueId(record.work_issue_id),
      outcome: parseEnum(record.outcome, ["completed", "failed", "canceled"] as const),
      workspace_changed: record.workspace_changed,
    });
  }
  assertExactKeys(record, [...prefix, "verify_issue_id", "revision", "conclusion"]);
  return Object.freeze({
    ...base,
    role,
    verify_issue_id: parseStageIssueId(record.verify_issue_id),
    revision: parseRevision(record.revision),
    conclusion: parseEnum(record.conclusion, ["passed", "failed", "inconclusive"] as const),
  });
}
