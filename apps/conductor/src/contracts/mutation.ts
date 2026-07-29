import {
  parseCorrelationId,
  parseSchemaVersion,
  type CorrelationId,
  type SchemaVersion,
} from "./identity.js";
import { asRecord, assertExactKeys, parseBoundedString, parseEnum } from "./validation.js";

export const MUTATION_OUTCOMES = [
  "applied", "not_applied", "precondition_failed", "acceptance_unknown", "readback_mismatch",
] as const;
export type MutationOutcome = typeof MUTATION_OUTCOMES[number];

export type MutationResult =
  | { readonly schema_version: SchemaVersion; readonly outcome: "applied"; readonly target_id: string; readonly correlation_id: CorrelationId }
  | { readonly schema_version: SchemaVersion; readonly outcome: Exclude<MutationOutcome, "applied">; readonly target_id: string; readonly correlation_id: CorrelationId; readonly reason: string };

export function parseMutationResult(value: unknown): MutationResult {
  const record = asRecord(value);
  const outcome = parseEnum(record.outcome, MUTATION_OUTCOMES);
  const schemaVersion = parseSchemaVersion(record.schema_version);
  const targetId = parseBoundedString(record.target_id, "invalid_mutation_target", 128);
  const correlationId = parseCorrelationId(record.correlation_id);
  if (outcome === "applied") {
    assertExactKeys(record, ["schema_version", "outcome", "target_id", "correlation_id"]);
    return Object.freeze({ schema_version: schemaVersion, outcome, target_id: targetId, correlation_id: correlationId });
  }
  assertExactKeys(record, ["schema_version", "outcome", "target_id", "correlation_id", "reason"]);
  return Object.freeze({
    schema_version: schemaVersion,
    outcome,
    target_id: targetId,
    correlation_id: correlationId,
    reason: parseBoundedString(record.reason, "invalid_mutation_reason"),
  });
}
