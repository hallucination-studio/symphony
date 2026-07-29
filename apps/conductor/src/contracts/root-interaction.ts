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
import { asRecord, assertExactKeys, parseBoundedString, parseEnum } from "./validation.js";

interface RootEnvelope {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
}

export type RootToolCall = RootEnvelope & (
  | { readonly kind: "tool"; readonly tool: "plan"; readonly cycle_issue_id: CycleIssueId }
  | { readonly kind: "tool"; readonly tool: "work"; readonly work_issue_id: StageIssueId }
  | { readonly kind: "tool"; readonly tool: "verify"; readonly verify_issue_id: StageIssueId; readonly revision: Revision }
);

export type RootDecision = RootEnvelope & (
  | { readonly kind: "decision"; readonly decision: "StartCycle" }
  | { readonly kind: "decision"; readonly decision: "ContinueCycle"; readonly cycle_issue_id: CycleIssueId }
  | { readonly kind: "decision"; readonly decision: "CloseCycleAndReplan"; readonly cycle_issue_id: CycleIssueId; readonly reason: string }
  | { readonly kind: "decision"; readonly decision: "DeliverVerifiedRevision"; readonly cycle_issue_id: CycleIssueId; readonly revision: Revision }
  | { readonly kind: "decision"; readonly decision: "Wait"; readonly reason: string }
  | { readonly kind: "decision"; readonly decision: "Stop"; readonly reason: string }
);

export type RootOutput = RootToolCall | RootDecision;

function envelope(record: Record<string, unknown>): RootEnvelope {
  return {
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: parseRootIssueId(record.root_id),
    runtime_generation: parseRuntimeGeneration(record.runtime_generation),
    correlation_id: parseCorrelationId(record.correlation_id),
  };
}

export function parseRootOutput(value: unknown): RootOutput {
  const record = asRecord(value);
  const base = envelope(record);
  const kind = parseEnum(record.kind, ["tool", "decision"] as const);
  if (kind === "tool") {
    const tool = parseEnum(record.tool, ["plan", "work", "verify"] as const);
    if (tool === "plan") {
      assertExactKeys(record, ["schema_version", "root_id", "runtime_generation", "correlation_id", "kind", "tool", "cycle_issue_id"]);
      return Object.freeze({ ...base, kind, tool, cycle_issue_id: parseCycleIssueId(record.cycle_issue_id) });
    }
    if (tool === "work") {
      assertExactKeys(record, ["schema_version", "root_id", "runtime_generation", "correlation_id", "kind", "tool", "work_issue_id"]);
      return Object.freeze({ ...base, kind, tool, work_issue_id: parseStageIssueId(record.work_issue_id) });
    }
    assertExactKeys(record, ["schema_version", "root_id", "runtime_generation", "correlation_id", "kind", "tool", "verify_issue_id", "revision"]);
    return Object.freeze({ ...base, kind, tool, verify_issue_id: parseStageIssueId(record.verify_issue_id), revision: parseRevision(record.revision) });
  }

  const decision = parseEnum(record.decision, [
    "StartCycle", "ContinueCycle", "CloseCycleAndReplan", "DeliverVerifiedRevision", "Wait", "Stop",
  ] as const);
  const prefix = ["schema_version", "root_id", "runtime_generation", "correlation_id", "kind", "decision"];
  if (decision === "StartCycle") {
    assertExactKeys(record, prefix);
    return Object.freeze({ ...base, kind, decision });
  }
  if (decision === "ContinueCycle") {
    assertExactKeys(record, [...prefix, "cycle_issue_id"]);
    return Object.freeze({ ...base, kind, decision, cycle_issue_id: parseCycleIssueId(record.cycle_issue_id) });
  }
  if (decision === "DeliverVerifiedRevision") {
    assertExactKeys(record, [...prefix, "cycle_issue_id", "revision"]);
    return Object.freeze({ ...base, kind, decision, cycle_issue_id: parseCycleIssueId(record.cycle_issue_id), revision: parseRevision(record.revision) });
  }
  if (decision === "CloseCycleAndReplan") {
    assertExactKeys(record, [...prefix, "cycle_issue_id", "reason"]);
    return Object.freeze({ ...base, kind, decision, cycle_issue_id: parseCycleIssueId(record.cycle_issue_id), reason: parseBoundedString(record.reason, "invalid_decision_reason") });
  }
  assertExactKeys(record, [...prefix, "reason"]);
  return Object.freeze({ ...base, kind, decision, reason: parseBoundedString(record.reason, "invalid_decision_reason") });
}
