import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseSchemaVersion,
  parseStageIssueId,
  type CorrelationId,
  type CycleIssueId,
  type RepositoryId,
  type RootIssueId,
  type SchemaVersion,
  type StageIssueId,
} from "../../contracts/identity.js";
import type { MutationResult } from "../../contracts/mutation.js";
import {
  CYCLE_STATUSES,
  ROOT_STATUSES,
  STAGE_KINDS,
  STAGE_STATUSES,
  type CycleStatus,
  type LinearObservation,
  type RootStatus,
  type StageKind,
  type StageStatus,
} from "../../contracts/observation.js";
import { asRecord, assertExactKeys, parseEnum } from "../../contracts/validation.js";

export interface RootCandidate {
  readonly root_id: RootIssueId;
  readonly status: RootStatus;
  readonly priority: number;
  readonly created_at: string;
  readonly repository_id: RepositoryId;
  readonly base_branch: string;
}

export type LinearMutation =
  | {
    readonly schema_version: SchemaVersion;
    readonly kind: "create_cycle";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly expected_root_status: "Todo" | "In Progress";
    readonly expected_no_active_cycle: true;
  }
  | {
    readonly schema_version: SchemaVersion;
    readonly kind: "set_root_status";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly expected_status: RootStatus;
    readonly desired_status: RootStatus;
  }
  | {
    readonly schema_version: SchemaVersion;
    readonly kind: "set_cycle_status";
    readonly root_id: RootIssueId;
    readonly cycle_issue_id: CycleIssueId;
    readonly correlation_id: CorrelationId;
    readonly expected_status: CycleStatus;
    readonly desired_status: CycleStatus;
  }
  | {
    readonly schema_version: SchemaVersion;
    readonly kind: "set_stage_status";
    readonly root_id: RootIssueId;
    readonly cycle_issue_id: CycleIssueId;
    readonly stage_issue_id: StageIssueId;
    readonly expected_kind: StageKind;
    readonly correlation_id: CorrelationId;
    readonly expected_status: StageStatus;
    readonly desired_status: StageStatus;
  };

export interface LinearGatewayInterface {
  discoverRoots(): Promise<readonly RootCandidate[]>;
  readRoot(rootId: RootIssueId): Promise<LinearObservation>;
  mutate(command: LinearMutation): Promise<MutationResult>;
}

export function parseLinearMutation(value: unknown): LinearMutation {
  const record = asRecord(value);
  const schemaVersion = parseSchemaVersion(record.schema_version);
  const kind = parseEnum(record.kind, ["create_cycle", "set_root_status", "set_cycle_status", "set_stage_status"] as const);
  const rootId = parseRootIssueId(record.root_id);
  const correlationId = parseCorrelationId(record.correlation_id);
  if (kind === "create_cycle") {
    assertExactKeys(record, ["schema_version", "kind", "root_id", "correlation_id", "expected_root_status", "expected_no_active_cycle"]);
    if (record.expected_no_active_cycle !== true) throw new Error("invalid_cycle_precondition");
    return Object.freeze({
      schema_version: schemaVersion,
      kind,
      root_id: rootId,
      correlation_id: correlationId,
      expected_root_status: parseEnum(record.expected_root_status, ["Todo", "In Progress"] as const),
      expected_no_active_cycle: true,
    });
  }
  if (kind === "set_root_status") {
    assertExactKeys(record, ["schema_version", "kind", "root_id", "correlation_id", "expected_status", "desired_status"]);
    const expectedStatus = parseEnum(record.expected_status, ROOT_STATUSES);
    const desiredStatus = parseEnum(record.desired_status, ROOT_STATUSES);
    if (desiredStatus === "Done") throw new Error("linear_root_done_forbidden");
    if (expectedStatus === desiredStatus) throw new Error("linear_noop_mutation");
    return Object.freeze({
      schema_version: schemaVersion, kind, root_id: rootId, correlation_id: correlationId,
      expected_status: expectedStatus, desired_status: desiredStatus,
    });
  }
  const cycleIssueId = parseCycleIssueId(record.cycle_issue_id);
  if (kind === "set_cycle_status") {
    assertExactKeys(record, ["schema_version", "kind", "root_id", "cycle_issue_id", "correlation_id", "expected_status", "desired_status"]);
    const expectedStatus = parseEnum(record.expected_status, CYCLE_STATUSES);
    const desiredStatus = parseEnum(record.desired_status, CYCLE_STATUSES);
    if (expectedStatus === desiredStatus) throw new Error("linear_noop_mutation");
    return Object.freeze({
      schema_version: schemaVersion, kind, root_id: rootId, cycle_issue_id: cycleIssueId,
      correlation_id: correlationId, expected_status: expectedStatus, desired_status: desiredStatus,
    });
  }
  assertExactKeys(record, [
    "schema_version", "kind", "root_id", "cycle_issue_id", "stage_issue_id", "expected_kind",
    "correlation_id", "expected_status", "desired_status",
  ]);
  const expectedStatus = parseEnum(record.expected_status, STAGE_STATUSES);
  const desiredStatus = parseEnum(record.desired_status, STAGE_STATUSES);
  if (expectedStatus === desiredStatus) throw new Error("linear_noop_mutation");
  return Object.freeze({
    schema_version: schemaVersion,
    kind,
    root_id: rootId,
    cycle_issue_id: cycleIssueId,
    stage_issue_id: parseStageIssueId(record.stage_issue_id),
    expected_kind: parseEnum(record.expected_kind, STAGE_KINDS),
    correlation_id: correlationId,
    expected_status: expectedStatus,
    desired_status: desiredStatus,
  });
}
