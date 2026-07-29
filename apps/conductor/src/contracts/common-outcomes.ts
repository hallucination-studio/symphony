import type { CorrelationId, RootIssueId, RuntimeGeneration } from "./identity.js";

export const BOUNDARY_ERROR_CODES = [
  "invalid_contract",
  "stale_generation",
  "precondition_failed",
  "timed_out",
  "canceled",
  "boundary_unavailable",
  "acceptance_unknown",
  "readback_mismatch",
] as const;

export type BoundaryErrorCode = typeof BOUNDARY_ERROR_CODES[number];

export interface BoundaryError {
  readonly code: BoundaryErrorCode;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly reason: string;
}

const REASON_PATTERN = /^[\x20-\x7E]{1,256}$/u;

export function boundaryError(input: BoundaryError): BoundaryError {
  if (!BOUNDARY_ERROR_CODES.includes(input.code) || !REASON_PATTERN.test(input.reason)) {
    throw new Error("invalid_boundary_error");
  }
  return Object.freeze({ ...input });
}

export function assertNever(value: never): never {
  throw new Error(`unexpected_closed_variant:${String(value)}`);
}
