import {
  parseCorrelationId,
  parseObservationDigest,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  parseThreadId,
  type CorrelationId,
  type ObservationDigest,
  type RootIssueId,
  type RuntimeGeneration,
  type SchemaVersion,
  type ThreadId,
} from "./identity.js";
import { asRecord, assertExactKeys, parseBoundedString, parseEnum } from "./validation.js";

export const ROOT_TURN_OUTCOMES = ["quiescent", "stopped", "timed_out", "canceled"] as const;

export interface RootRuntimeState {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly thread_id: ThreadId;
  readonly accepted_observation_digest: ObservationDigest;
  readonly in_flight_correlation: CorrelationId | null;
}

export interface RuntimeTarget {
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
}

interface RootTurnEnvelope extends RuntimeTarget {
  readonly schema_version: SchemaVersion;
  readonly correlation_id: CorrelationId;
}

export type RootTurnOutcome =
  | (RootTurnEnvelope & { readonly outcome: "quiescent" })
  | (RootTurnEnvelope & {
    readonly outcome: "stopped" | "timed_out" | "canceled";
    readonly sanitized_reason: string;
  });

export function assertRuntimeTarget(actual: RuntimeTarget, expected: RuntimeTarget): void {
  if (actual.root_id !== expected.root_id) throw new Error("runtime_root_mismatch");
  if (actual.runtime_generation !== expected.runtime_generation) throw new Error("stale_generation");
}

export function parseRootTurnOutcome(value: unknown, expected: RuntimeTarget): RootTurnOutcome {
  const record = asRecord(value);
  const outcome = parseEnum(record.outcome, ROOT_TURN_OUTCOMES);
  const envelope = {
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: parseRootIssueId(record.root_id),
    runtime_generation: parseRuntimeGeneration(record.runtime_generation),
    correlation_id: parseCorrelationId(record.correlation_id),
  };
  assertRuntimeTarget(envelope, expected);
  if (outcome === "quiescent") {
    assertExactKeys(record, ["schema_version", "root_id", "runtime_generation", "correlation_id", "outcome"]);
    return Object.freeze({ ...envelope, outcome });
  }
  assertExactKeys(record, [
    "schema_version", "root_id", "runtime_generation", "correlation_id", "outcome", "sanitized_reason",
  ]);
  return Object.freeze({
    ...envelope,
    outcome,
    sanitized_reason: parseBoundedString(record.sanitized_reason, "invalid_turn_reason"),
  });
}

export function parseRootRuntimeState(value: unknown): RootRuntimeState {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "runtime_generation",
    "thread_id",
    "accepted_observation_digest",
    "in_flight_correlation",
  ]);
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: parseRootIssueId(record.root_id),
    runtime_generation: parseRuntimeGeneration(record.runtime_generation),
    thread_id: parseThreadId(record.thread_id),
    accepted_observation_digest: parseObservationDigest(record.accepted_observation_digest),
    in_flight_correlation: record.in_flight_correlation === null
      ? null
      : parseCorrelationId(record.in_flight_correlation),
  });
}
