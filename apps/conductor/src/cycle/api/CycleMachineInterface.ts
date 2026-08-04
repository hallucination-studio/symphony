import type {
  CycleAdvanceRequest,
  CycleAdvanceResult,
} from "../../contracts/cycle.js";
import {
  parseCycleInvalidationEvidence,
  type CycleInvalidationEvidence,
} from "../../contracts/cycle-records.js";
import { parseTaskIssueId, type TaskIssueId } from "../../contracts/identity.js";
import { asRecord, assertExactKeys, parseArray } from "../../contracts/validation.js";

export interface SealedFactMutationObservation {
  readonly affected_stage_ids: readonly TaskIssueId[];
  readonly offending_resources: readonly [CycleInvalidationEvidence, ...CycleInvalidationEvidence[]];
}

export function parseSealedFactMutationObservation(value: unknown): SealedFactMutationObservation {
  const record = asRecord(value);
  assertExactKeys(record, ["affected_stage_ids", "offending_resources"]);
  const affectedStageIds = parseArray(record.affected_stage_ids, parseTaskIssueId, 256);
  if (new Set(affectedStageIds).size !== affectedStageIds.length) {
    throw new Error("duplicate_sealed_fact_stage_identity");
  }
  const offendingResources = parseArray(record.offending_resources, parseCycleInvalidationEvidence, 256);
  if (offendingResources.length === 0) throw new Error("empty_sealed_fact_mutation_evidence");
  return Object.freeze({
    affected_stage_ids: affectedStageIds,
    offending_resources: Object.freeze(offendingResources) as readonly [CycleInvalidationEvidence, ...CycleInvalidationEvidence[]],
  });
}

export interface CycleMachineExecution {
  readonly ownership: "live" | "lost";
  readonly closure?: "admission_lost" | "sealed_fact_mutated";
  readonly sealed_fact_mutation?: SealedFactMutationObservation;
}

export interface CycleMachineInterface {
  advance(
    request: CycleAdvanceRequest,
    execution: CycleMachineExecution,
  ): Promise<CycleAdvanceResult>;
}
