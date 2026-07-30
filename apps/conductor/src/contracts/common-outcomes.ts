import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  type CorrelationId,
  type RootIssueId,
  type RuntimeGeneration,
  type SchemaVersion,
} from "./identity.js";
import { asRecord, assertExactKeys, parseEnum } from "./validation.js";

export const BOUNDARY_ERROR_CODES = [
  "invalid_contract",
  "stale_generation",
  "capability_denied",
  "timed_out",
  "canceled",
  "boundary_unavailable",
  "acceptance_unknown",
  "readback_mismatch",
] as const;

export type BoundaryErrorCode = typeof BOUNDARY_ERROR_CODES[number];

export interface BoundaryError {
  readonly schema_version: SchemaVersion;
  readonly code: BoundaryErrorCode;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly reason: string;
}

const REASON_PATTERN = /^[\x20-\x7E]{1,256}$/u;

export function boundaryError(input: BoundaryError): BoundaryError {
  return parseBoundaryError(input);
}

export function parseBoundaryError(value: unknown): BoundaryError {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version", "code", "root_id", "runtime_generation", "correlation_id", "reason",
  ]);
  if (typeof record.reason !== "string" || !REASON_PATTERN.test(record.reason)) {
    throw new Error("invalid_boundary_reason");
  }
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    code: parseEnum(record.code, BOUNDARY_ERROR_CODES),
    root_id: parseRootIssueId(record.root_id),
    runtime_generation: parseRuntimeGeneration(record.runtime_generation),
    correlation_id: parseCorrelationId(record.correlation_id),
    reason: record.reason,
  });
}

export function assertNever(value: never): never {
  throw new Error(`unexpected_closed_variant:${String(value)}`);
}
