import { parseCorrelationId, type CorrelationId } from "./identity.js";
import { asRecord, assertExactKeys, parseBoundedString, parseEnum } from "./validation.js";

export const MUTATION_OUTCOMES = [
  "applied", "not_applied", "precondition_failed", "acceptance_unknown", "readback_mismatch",
] as const;
export type MutationOutcome = typeof MUTATION_OUTCOMES[number];

export type MutationResult =
  | { readonly outcome: "applied"; readonly target_id: string; readonly correlation_id: CorrelationId }
  | { readonly outcome: Exclude<MutationOutcome, "applied">; readonly target_id: string; readonly correlation_id: CorrelationId; readonly reason: string };

export function parseMutationResult(value: unknown): MutationResult {
  const record = asRecord(value);
  const outcome = parseEnum(record.outcome, MUTATION_OUTCOMES);
  const targetId = parseBoundedString(record.target_id, "invalid_mutation_target", 128);
  const correlationId = parseCorrelationId(record.correlation_id);
  if (outcome === "applied") {
    assertExactKeys(record, ["outcome", "target_id", "correlation_id"]);
    return Object.freeze({ outcome, target_id: targetId, correlation_id: correlationId });
  }
  assertExactKeys(record, ["outcome", "target_id", "correlation_id", "reason"]);
  return Object.freeze({
    outcome,
    target_id: targetId,
    correlation_id: correlationId,
    reason: parseBoundedString(record.reason, "invalid_mutation_reason"),
  });
}
