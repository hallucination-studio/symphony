import { createHash } from "node:crypto";

import type { RootReconciliationView } from "../api/RootReconciliationContracts.js";
import type {
  ModelTurnRecord,
  RootDirectiveRecord,
  RootReconcilerFailureRecord,
  StageResultRecord,
} from "../api/ManagedRecords.js";
import { parseManagedRecord, serializeManagedRecord } from "../api/index.js";

export interface UsageAggregateGroup {
  cycleIssueId?: string;
  role: "root_reconciler" | "plan" | "work" | "verify";
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  unavailableTurnCount: number;
}

export interface UsageAggregate {
  scope: "stage" | "cycle" | "root";
  sourceRecordCount: number;
  sourceDigest: string;
  isComplete: boolean;
  unknownTurnCount: number;
  groups: UsageAggregateGroup[];
}

type UsageSource = {
  recordId: string;
  record: RootDirectiveRecord | RootReconcilerFailureRecord | StageResultRecord;
  turn: ModelTurnRecord;
};

export function deriveIssueUsageAggregate(input: {
  tree: RootReconciliationView["tree"];
  targetIssueId: string;
  prospectiveRecord?: StageResultRecord;
}): UsageAggregate {
  const sources = strictUsageSources(input.tree).filter((source) =>
    source.record.kind === "stage_result" && source.record.nodeIssueId === input.targetIssueId,
  );
  if (input.prospectiveRecord) {
    if (input.prospectiveRecord.nodeIssueId !== input.targetIssueId) {
      throw new Error("usage_aggregate_prospective_stage_target_invalid");
    }
    sources.push(stageSource(input.prospectiveRecord));
  }
  return aggregate("stage", sources);
}

export function deriveCycleUsageAggregate(input: {
  tree: RootReconciliationView["tree"];
  cycleIssueId: string;
}): UsageAggregate {
  return aggregate("cycle", strictUsageSources(input.tree).filter((source) =>
    source.record.kind === "stage_result" && source.record.cycleIssueId === input.cycleIssueId,
  ));
}

export function deriveRootUsageAggregate(input: {
  tree: RootReconciliationView["tree"];
  rootIssueId: string;
}): UsageAggregate {
  return aggregate("root", strictUsageSources(input.tree).filter((source) =>
    source.turn.rootIssueId === input.rootIssueId,
  ));
}

function strictUsageSources(tree: RootReconciliationView["tree"]): UsageSource[] {
  const sources: UsageSource[] = [];
  for (const comment of tree.comments) {
    if (comment.author_kind !== "symphony") continue;
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok) throw new Error(`usage_aggregate_managed_record_invalid:${parsed.error}`);
    if (parsed.value.kind === "stage_result") {
      if (comment.issue_id !== parsed.value.nodeIssueId) throw new Error("usage_aggregate_stage_target_invalid");
      sources.push(stageSource(parsed.value));
    }
    if (parsed.value.kind === "root_directive") {
      if (comment.issue_id !== parsed.value.rootIssueId) throw new Error("usage_aggregate_root_directive_target_invalid");
      sources.push({ recordId: parsed.value.rootDirectiveId, record: parsed.value, turn: parsed.value.directive.modelTurn });
    }
    if (parsed.value.kind === "root_reconciler_failure") {
      if (comment.issue_id !== parsed.value.modelTurn.rootIssueId) throw new Error("usage_aggregate_root_failure_target_invalid");
      sources.push({ recordId: parsed.value.failureId, record: parsed.value, turn: parsed.value.modelTurn });
    }
  }
  return sources;
}

function stageSource(record: StageResultRecord): UsageSource {
  return { recordId: record.resultId, record, turn: record.modelTurn };
}

function aggregate(scope: UsageAggregate["scope"], sources: UsageSource[]): UsageAggregate {
  const turnRecordIds = new Set<string>();
  const groups = new Map<string, UsageAggregateGroup>();
  const canonicalSources = sources
    .map((source) => ({
      recordId: source.recordId,
      turnRecordId: source.turn.turnRecordId,
      canonicalRecord: serializeManagedRecord(source.record),
    }))
    .sort((left, right) => left.recordId.localeCompare(right.recordId) || left.turnRecordId.localeCompare(right.turnRecordId));
  let unknownTurnCount = 0;
  for (const source of sources) {
    const { turn } = source;
    if (turnRecordIds.has(turn.turnRecordId)) throw new Error("usage_aggregate_duplicate_turn");
    turnRecordIds.add(turn.turnRecordId);
    const cycleIssueId = turn.role === "root_reconciler" ? undefined : turn.cycleIssueId;
    const key = `${cycleIssueId ?? ""}\u0000${turn.role}\u0000${turn.model}`;
    const group = groups.get(key) ?? {
      ...(cycleIssueId ? { cycleIssueId } : {}),
      role: turn.role,
      model: turn.model,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      unavailableTurnCount: 0,
    };
    if (turn.usage.status === "measured") {
      group.inputTokens += turn.usage.inputTokens;
      group.cachedInputTokens += turn.usage.cachedInputTokens;
      group.outputTokens += turn.usage.outputTokens;
      group.reasoningOutputTokens += turn.usage.reasoningOutputTokens;
      group.totalTokens += turn.usage.totalTokens;
    } else {
      group.unavailableTurnCount += 1;
      unknownTurnCount += 1;
    }
    groups.set(key, group);
  }
  return {
    scope,
    sourceRecordCount: sources.length,
    sourceDigest: createHash("sha256").update(JSON.stringify(canonicalSources), "utf8").digest("hex"),
    isComplete: unknownTurnCount === 0,
    unknownTurnCount,
    groups: [...groups.values()].sort((left, right) =>
      (left.cycleIssueId ?? "").localeCompare(right.cycleIssueId ?? "") ||
      left.role.localeCompare(right.role) ||
      left.model.localeCompare(right.model),
    ),
  };
}
