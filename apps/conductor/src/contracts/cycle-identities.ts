import { createHash } from "node:crypto";

export const CYCLE_IDENTITY_DERIVATION_VERSION = "symphony-identity:v1";
export const FIRST_CYCLE_PREDECESSOR = "first_cycle";

export interface CycleAnchorIds {
  readonly approval_record_id: string;
  readonly plan_issue_id: string;
  readonly plan_completion_record_id: string;
  readonly plan_invalidation_record_id: string;
  readonly cycle_completion_record_id: string;
  readonly cycle_invalidation_record_id: string;
  readonly delivery_completion_record_id: string;
  readonly delivery_invalidation_record_id: string;
}

function identityPart(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 1_024
    || /[\r\n\0]/u.test(value)
  ) throw new Error("invalid_identity_derivation_part");
  return value;
}

export function deriveCycleUuid(
  derivationVersion: string,
  kind: string,
  ...basis: readonly string[]
): string {
  const input = [derivationVersion, kind, ...basis].map(identityPart);
  const bytes = createHash("sha256").update(JSON.stringify(input), "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deriveFirstCycleIssueId(rootId: string): string {
  return deriveCycleUuid(
    CYCLE_IDENTITY_DERIVATION_VERSION,
    "cycle_issue",
    rootId,
    FIRST_CYCLE_PREDECESSOR,
    FIRST_CYCLE_PREDECESSOR,
  );
}

export function deriveCycleAnchorIds(version: string, cycleId: string): CycleAnchorIds {
  return Object.freeze({
    approval_record_id: deriveCycleUuid(version, "cycle_approval_record", cycleId),
    plan_issue_id: deriveCycleUuid(version, "plan_issue", cycleId),
    plan_completion_record_id: deriveCycleUuid(version, "plan_completion_record", cycleId),
    plan_invalidation_record_id: deriveCycleUuid(version, "plan_invalidation_record", cycleId),
    cycle_completion_record_id: deriveCycleUuid(version, "cycle_completion_record", cycleId),
    cycle_invalidation_record_id: deriveCycleUuid(version, "cycle_invalidation_record", cycleId),
    delivery_completion_record_id: deriveCycleUuid(version, "delivery_completion_record", cycleId),
    delivery_invalidation_record_id: deriveCycleUuid(version, "delivery_invalidation_record", cycleId),
  });
}
