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
import { asRecord, assertExactKeys } from "./validation.js";

export interface RootRuntimeState {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly thread_id: ThreadId;
  readonly accepted_observation_digest: ObservationDigest;
  readonly in_flight_correlation: CorrelationId | null;
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
