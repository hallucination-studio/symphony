import {
  parseCycleIssueId,
  parseRootIssueId,
  parseStageIssueId,
  type CycleIssueId,
  type RootIssueId,
  type StageIssueId,
} from "../../contracts/identity.js";
import { asRecord, assertExactKeys, parseEnum, parseStringArray } from "../../contracts/validation.js";

export const ROOT_STATUSES = ["Todo", "In Progress", "In Review", "Done"] as const;
export const CYCLE_STATUSES = ["Planning", "Executing", "Verifying", "Succeeded", "Canceled"] as const;
export const STAGE_KINDS = ["plan", "work", "verify"] as const;
export const STAGE_STATUSES = ["Todo", "In Progress", "Done", "Failed", "Canceled"] as const;

export type RootStatus = typeof ROOT_STATUSES[number];
export type CycleStatus = typeof CYCLE_STATUSES[number];
export type StageKind = typeof STAGE_KINDS[number];
export type StageStatus = typeof STAGE_STATUSES[number];

export interface StageObservation {
  readonly issue_id: StageIssueId;
  readonly kind: StageKind;
  readonly status: StageStatus;
  readonly dependency_issue_ids: readonly StageIssueId[];
}

export interface CycleObservation {
  readonly issue_id: CycleIssueId;
  readonly status: CycleStatus;
  readonly stages: readonly StageObservation[];
}

export interface LinearObservation {
  readonly root_id: RootIssueId;
  readonly root_status: RootStatus;
  readonly active_cycle: CycleObservation | null;
}

function parseStage(value: unknown): StageObservation {
  const record = asRecord(value);
  assertExactKeys(record, ["issue_id", "kind", "status", "dependency_issue_ids"]);
  return Object.freeze({
    issue_id: parseStageIssueId(record.issue_id),
    kind: parseEnum(record.kind, STAGE_KINDS),
    status: parseEnum(record.status, STAGE_STATUSES),
    dependency_issue_ids: parseStringArray(record.dependency_issue_ids, parseStageIssueId) as readonly StageIssueId[],
  });
}

export function parseLinearObservation(value: unknown): LinearObservation {
  const record = asRecord(value);
  assertExactKeys(record, ["root_id", "root_status", "active_cycle"]);
  let activeCycle: CycleObservation | null = null;
  if (record.active_cycle !== null) {
    const cycle = asRecord(record.active_cycle);
    assertExactKeys(cycle, ["issue_id", "status", "stages"]);
    if (!Array.isArray(cycle.stages)) throw new Error("invalid_cycle_stages");
    const stages = cycle.stages.map(parseStage);
    if (new Set(stages.map(({ issue_id }) => issue_id)).size !== stages.length) {
      throw new Error("duplicate_stage_identity");
    }
    activeCycle = Object.freeze({
      issue_id: parseCycleIssueId(cycle.issue_id),
      status: parseEnum(cycle.status, CYCLE_STATUSES),
      stages: Object.freeze(stages),
    });
  }
  return Object.freeze({
    root_id: parseRootIssueId(record.root_id),
    root_status: parseEnum(record.root_status, ROOT_STATUSES),
    active_cycle: activeCycle,
  });
}
