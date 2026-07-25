import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  ManagedRecord,
  ModelTurnRecord,
  WorkflowTimelineRecord,
} from "../../root-reconciliation/api/ManagedRecords.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-reconciliation/api/index.js";
import {
  deriveCycleUsageAggregate,
  deriveRootUsageAggregate,
  type UsageAggregate,
  type UsageAggregateGroup,
  type UsageAggregateHorizon,
} from "../../root-reconciliation/api/UsageAggregation.js";
import type { CycleTimelineEvent, RootTimelineEvent, WorkflowTimelineEvent } from "../../workflow-events/api/WorkflowTimelineEvents.js";
import type { WorkflowTimelineMaterializationResult } from "../../workflow-events/api/WorkflowTimelinePublisherInterface.js";

const MAX_COMMENT_BYTES = 32_768;
const MAX_SUMMARY_CHARS = 6_000;
const MAX_NEXT_STEP_CHARS = 2_000;

export async function materializeRootTimelineComment(
  linear: LinearGatewayInterface,
  event: RootTimelineEvent,
): Promise<WorkflowTimelineMaterializationResult> {
  return materializeTimelineComment(linear, event, event.rootIssueId);
}

export async function materializeCycleTimelineComment(
  linear: LinearGatewayInterface,
  event: CycleTimelineEvent,
): Promise<WorkflowTimelineMaterializationResult> {
  return materializeTimelineComment(linear, event, event.cycleIssueId);
}

async function materializeTimelineComment(
  linear: LinearGatewayInterface,
  event: WorkflowTimelineEvent,
  targetIssueId: string,
): Promise<WorkflowTimelineMaterializationResult> {
  if (!isValidEventText(event)) return failed(event, "timeline_event_text_invalid");

  let tree: Awaited<ReturnType<LinearGatewayInterface["readWorkflowIssueTree"]>>;
  try {
    tree = await linear.readWorkflowIssueTree(event.rootIssueId);
  } catch {
    return failed(event, "timeline_initial_read_failed");
  }
  const target = tree.issues.find((issue) => issue.issue_id === targetIssueId);
  const root = tree.issues.find((issue) => issue.issue_id === event.rootIssueId);
  if (!target || !root) return failed(event, "timeline_target_not_found");
  if (!validTarget(event, targetIssueId, target.parent_issue_id, target.issue_kind)) return failed(event, "timeline_target_invalid");

  let sources: TimelineSource[];
  let aggregate: UsageAggregate;
  try {
    sources = resolveSources(tree.comments, event);
    aggregate = event.timelineKind === "root"
      ? deriveRootUsageAggregate({ tree, rootIssueId: event.rootIssueId, horizon: usageHorizon(event, sources) })
      : deriveCycleUsageAggregate({ tree, cycleIssueId: event.cycleIssueId, horizon: usageHorizon(event, sources) });
  } catch (error) {
    return failed(event, error instanceof TimelineMaterializationError ? error.code : "timeline_source_record_invalid");
  }

  const record = timelineRecord(event, targetIssueId);
  let body: string;
  try {
    body = serializeManagedRecord(record, renderTimelineComment(event, sources, aggregate));
  } catch {
    return failed(event, "timeline_render_failed");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) return failed(event, "timeline_comment_too_large");

  let existing: ReturnType<typeof findTimelineComment>;
  try {
    existing = findTimelineComment(tree.comments, targetIssueId, record.timelineEventId);
  } catch (error) {
    return failed(event, error instanceof TimelineMaterializationError ? error.code : "timeline_record_invalid");
  }
  if (existing) {
    return existing.body === body && sameTimelineRecord(existing.record, record)
      ? materialized(event, existing.commentId)
      : failed(event, "timeline_existing_record_conflict");
  }

  let outcome: Awaited<ReturnType<LinearGatewayInterface["mutateWorkflow"]>>;
  try {
    outcome = await linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId: record.writeId,
      expectedProjectId: target.project_id,
      rootIssueId: event.rootIssueId,
      expectedRootRemoteVersion: root.remote_version,
      target: {
        targetIssueId,
        expectedRemoteVersion: target.remote_version,
        expectedStatusId: target.status_id,
        ...(target.parent_issue_id ? { expectedParentIssueId: target.parent_issue_id } : {}),
      },
      body,
    });
  } catch {
    return failed(event, "timeline_write_failed");
  }
  if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
    return failed(event, `timeline_write_${outcome.kind}`);
  }

  let readBack: typeof tree;
  try {
    readBack = await linear.readWorkflowIssueTree(event.rootIssueId);
  } catch {
    return failed(event, "timeline_read_back_failed");
  }
  let readBackSources: TimelineSource[];
  let readBackAggregate: UsageAggregate;
  try {
    readBackSources = resolveSources(readBack.comments, event);
    readBackAggregate = event.timelineKind === "root"
      ? deriveRootUsageAggregate({ tree: readBack, rootIssueId: event.rootIssueId, horizon: usageHorizon(event, readBackSources) })
      : deriveCycleUsageAggregate({ tree: readBack, cycleIssueId: event.cycleIssueId, horizon: usageHorizon(event, readBackSources) });
  } catch (error) {
    return failed(event, error instanceof TimelineMaterializationError ? error.code : "timeline_read_back_invalid");
  }
  let readBackBody: string;
  let comment: ReturnType<typeof findTimelineComment>;
  try {
    readBackBody = serializeManagedRecord(record, renderTimelineComment(event, readBackSources, readBackAggregate));
    comment = findTimelineComment(readBack.comments, targetIssueId, record.timelineEventId);
  } catch (error) {
    return failed(event, error instanceof TimelineMaterializationError ? error.code : "timeline_read_back_invalid");
  }
  if (!comment) return failed(event, "timeline_read_back_missing");
  if (comment.body !== readBackBody || !sameTimelineRecord(comment.record, record)) {
    return failed(event, "timeline_read_back_invalid");
  }
  return materialized(event, comment.commentId);
}

type TimelineSource = {
  recordId: string;
  sourceVersion: string;
  occurredAt: string;
  modelTurn?: ModelTurnRecord;
};

function resolveSources(
  comments: Awaited<ReturnType<LinearGatewayInterface["readWorkflowIssueTree"]>>["comments"],
  event: WorkflowTimelineEvent,
): TimelineSource[] {
  if (event.sourceRecordIds.length === 0 || event.sourceRecordIds.length !== event.sourceVersions.length) {
    throw new TimelineMaterializationError("timeline_source_record_shape_invalid");
  }
  const byRecordId = new Map<string, TimelineSource>();
  for (const comment of comments) {
    if (comment.author_kind !== "symphony") continue;
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok) throw new TimelineMaterializationError("timeline_source_record_invalid");
    const source = sourceForManagedRecord(parsed.value, comment.issue_id);
    if (!source) continue;
    if (byRecordId.has(source.recordId)) throw new TimelineMaterializationError("timeline_source_record_ambiguous");
    byRecordId.set(source.recordId, source);
  }
  return event.sourceRecordIds.map((recordId, index) => {
    const source = byRecordId.get(recordId);
    if (!source) throw new TimelineMaterializationError("timeline_source_record_missing");
    if (source.sourceVersion !== event.sourceVersions[index]) {
      throw new TimelineMaterializationError("timeline_source_record_version_mismatch");
    }
    return source;
  });
}

function sourceForManagedRecord(record: ManagedRecord, commentIssueId: string): TimelineSource | undefined {
  if (record.kind === "root_directive") {
    if (record.rootIssueId !== commentIssueId) throw new TimelineMaterializationError("timeline_source_record_scope_invalid");
    return {
      recordId: record.rootDirectiveId,
      sourceVersion: record.basedOnTargetRootDigest,
      occurredAt: record.directive.modelTurn.terminalAt,
      modelTurn: record.directive.modelTurn,
    };
  }
  if (record.kind === "root_reconciler_failure") {
    if (record.modelTurn.rootIssueId !== commentIssueId) throw new TimelineMaterializationError("timeline_source_record_scope_invalid");
    return {
      recordId: record.failureId,
      sourceVersion: record.targetRootDigest,
      occurredAt: record.modelTurn.terminalAt,
      modelTurn: record.modelTurn,
    };
  }
  if (record.kind === "stage_result") {
    if (record.nodeIssueId !== commentIssueId) throw new TimelineMaterializationError("timeline_source_record_scope_invalid");
    return {
      recordId: record.resultId,
      sourceVersion: record.observedTreeDigest,
      occurredAt: record.completedAt,
      modelTurn: record.modelTurn,
    };
  }
  if (record.kind === "human_action_resolution") {
    if (record.actionIssueId !== commentIssueId) throw new TimelineMaterializationError("timeline_source_record_scope_invalid");
    return {
      recordId: record.resolutionId,
      sourceVersion: record.terminalRemoteVersion,
      occurredAt: record.resolvedAt,
    };
  }
  return undefined;
}

function usageHorizon(event: WorkflowTimelineEvent, sources: TimelineSource[]): UsageAggregateHorizon {
  const sourceTurnRecordIds = sources.flatMap(({ modelTurn }) => modelTurn ? [modelTurn.turnRecordId] : []);
  const occurredAt = Date.parse(event.occurredAt);
  const latestSourceOccurrence = Math.max(...sources.map((source) => Date.parse(source.occurredAt)));
  const latestSources = sources.filter((source) => Date.parse(source.occurredAt) === latestSourceOccurrence);
  if (
    !Number.isFinite(occurredAt) ||
    !Number.isFinite(latestSourceOccurrence) ||
    occurredAt !== latestSourceOccurrence ||
    latestSources.some((source) => source.occurredAt !== event.occurredAt)
  ) {
    throw new TimelineMaterializationError("timeline_source_occurrence_mismatch");
  }
  return { occurredAt: event.occurredAt, sourceTurnRecordIds };
}

function timelineRecord(event: WorkflowTimelineEvent, targetIssueId: string): WorkflowTimelineRecord {
  return {
    kind: "workflow_timeline",
    version: 1,
    timelineEventId: event.timelineEventId,
    timelineKind: event.timelineKind,
    targetIssueId,
    sourceRecordIds: event.sourceRecordIds,
    sourceVersions: event.sourceVersions,
    writeId: event.timelineEventId,
    renderedSchemaVersion: "1",
    occurredAt: event.occurredAt,
  };
}

function findTimelineComment(
  comments: Awaited<ReturnType<LinearGatewayInterface["readWorkflowIssueTree"]>>["comments"],
  targetIssueId: string,
  timelineEventId: string,
): { commentId: string; body: string; record: WorkflowTimelineRecord } | undefined {
  const matches = comments.flatMap((comment) => {
    if (comment.author_kind !== "symphony") return [];
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok || parsed.value.kind !== "workflow_timeline" || parsed.value.timelineEventId !== timelineEventId) return [];
    if (comment.issue_id !== targetIssueId || parsed.value.targetIssueId !== targetIssueId) {
      throw new TimelineMaterializationError("timeline_record_target_mismatch");
    }
    return [{ commentId: comment.comment_id, body: comment.body, record: parsed.value }];
  });
  if (matches.length > 1) throw new TimelineMaterializationError("timeline_record_ambiguous");
  return matches[0];
}

function validTarget(
  event: WorkflowTimelineEvent,
  targetIssueId: string,
  parentIssueId: string | undefined,
  issueKind: string | undefined,
): boolean {
  return event.timelineKind === "root"
    ? targetIssueId === event.rootIssueId
    : targetIssueId === event.cycleIssueId && parentIssueId === event.rootIssueId && issueKind === "cycle";
}

function isValidEventText(event: WorkflowTimelineEvent): boolean {
  return event.summary.trim().length > 0 && event.summary.length <= MAX_SUMMARY_CHARS &&
    !event.summary.includes("```symphony") &&
    (event.nextStep === undefined || (event.nextStep.trim().length > 0 && event.nextStep.length <= MAX_NEXT_STEP_CHARS && !event.nextStep.includes("```symphony")));
}

function renderTimelineComment(
  event: WorkflowTimelineEvent,
  sources: TimelineSource[],
  aggregate: UsageAggregate,
): string {
  const scope = event.timelineKind === "root" ? "Root Reconciliation" : "Cycle";
  const aggregateLabel = event.timelineKind === "root" ? "Root cumulative" : "Cycle cumulative";
  const sections = [
    `## Symphony · ${scope}`,
    event.summary.trim(),
    `Observed\n- ${displayLabel(event.kind)}`,
    `Evidence\n${sources.map((source) => `- ${source.recordId}`).join("\n")}`,
  ];
  const usage = [
    ...uniqueModelTurns(sources).map((turn) => `- This turn: ${displayRole(turn.role)} · ${turn.model} · ${displayUsage(turn)}`),
    `- ${aggregateLabel} (${aggregate.isComplete ? "complete" : `incomplete: ${aggregate.unknownTurnCount} unavailable`}): ${displayAggregate(aggregate.groups)}`,
  ];
  sections.push(`Usage\n${usage.join("\n")}`);
  if (event.nextStep) sections.push(`Next\n${event.nextStep.trim()}`);
  return sections.join("\n\n");
}

function uniqueModelTurns(sources: TimelineSource[]): ModelTurnRecord[] {
  const seen = new Set<string>();
  return sources.flatMap(({ modelTurn }) => {
    if (!modelTurn || seen.has(modelTurn.turnRecordId)) return [];
    seen.add(modelTurn.turnRecordId);
    return [modelTurn];
  });
}

function displayAggregate(groups: UsageAggregateGroup[]): string {
  return groups.length === 0
    ? "No model turns"
    : groups.map((group) => {
      const unavailable = group.unavailableTurnCount === 0 ? "" : `; ${group.unavailableTurnCount} unavailable`;
      return `${displayRole(group.role)} · ${group.model} · ${group.totalTokens} tokens${unavailable}`;
    }).join("; ");
}

function displayUsage(turn: ModelTurnRecord): string {
  return turn.usage.status === "measured"
    ? `${turn.usage.totalTokens} tokens`
    : `usage unavailable (${displayLabel(turn.usage.reason)})`;
}

function displayRole(role: ModelTurnRecord["role"]): string {
  return role === "root_reconciler" ? "Root Reconciler" : displayLabel(role);
}

function displayLabel(value: string): string {
  return value.split("_").map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}

function sameTimelineRecord(left: WorkflowTimelineRecord, right: WorkflowTimelineRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function materialized(event: WorkflowTimelineEvent, commentId: string): WorkflowTimelineMaterializationResult {
  return { kind: "materialized", timelineEventId: event.timelineEventId, commentId };
}

function failed(event: WorkflowTimelineEvent, code: string): WorkflowTimelineMaterializationResult {
  return { kind: "failed", timelineEventId: event.timelineEventId, code, sanitizedReason: code };
}

class TimelineMaterializationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
