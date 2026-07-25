import { createHash } from "node:crypto";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function assessRequiredWriteFailClosedEvidence(row) {
  try {
    const input = rowInput(row);
    const tree = exact(input.snapshot.root_trees.filter((candidate) => candidate?.root_issue_id === input.rootIssueId));
    if (!validTree(tree)) return outcome("inconclusive", "required_write_root_missing");
    const facts = factsFromTree(tree, input.symphonyActorId);
    if (!facts) return outcome("inconclusive", "required_write_evidence_invalid");

    const planResults = facts.stageResults.filter((candidate) =>
      candidate.rootIssueId === input.rootIssueId && candidate.stage === "plan" && candidate.outcomeKind === "plan_completed",
    );
    if (planResults.length > 1) return outcome("violated", "required_write_plan_result_ambiguous");
    const planResult = exact(planResults);
    if (!planResult) return outcome("inconclusive", "required_write_plan_result_missing");
    if (!isCycleChild(tree, planResult.cycleIssueId, input.rootIssueId)) {
      return outcome("violated", "required_write_cycle_scope_invalid");
    }

    const timelineEventId = stageTimelineEventId(input.rootIssueId, planResult.cycleIssueId, planResult.resultId);
    const timelines = facts.timelines.filter((candidate) => candidate.timelineEventId === timelineEventId);
    if (timelines.length > 1) return outcome("violated", "required_write_timeline_ambiguous");
    const timeline = exact(timelines);
    if (!timeline) return outcome("inconclusive", "required_write_timeline_missing");
    if (
      timeline.sourceIssueId !== planResult.cycleIssueId ||
      timeline.timelineKind !== "cycle" ||
      timeline.targetIssueId !== planResult.cycleIssueId ||
      !sameArray(timeline.sourceRecordIds, [planResult.resultId]) ||
      !sameArray(timeline.sourceVersions, [planResult.observedTreeDigest]) ||
      timeline.writeId !== timelineEventId || timeline.renderedSchemaVersion !== "1" ||
      timeline.occurredAt !== planResult.completedAt ||
      Date.parse(timeline.createdAt) < Date.parse(planResult.completedAt)
    ) {
      return outcome("violated", "required_write_timeline_mismatch");
    }

    const laterFacts = [
      ...facts.stageExecutions.filter((candidate) => candidate.rootIssueId === input.rootIssueId &&
        candidate.cycleIssueId === planResult.cycleIssueId && candidate.stage !== "plan")
        .map((candidate) => ({ occurredAt: candidate.startedAt, kind: "execution" })),
      ...facts.stageResults.filter((candidate) => candidate.rootIssueId === input.rootIssueId &&
        candidate.cycleIssueId === planResult.cycleIssueId && candidate.stage !== "plan")
        .map((candidate) => ({ occurredAt: candidate.completedAt, kind: "result" })),
    ];
    if (laterFacts.some(({ occurredAt }) => Date.parse(occurredAt) <= Date.parse(timeline.createdAt))) {
      return outcome("violated", "required_write_later_stage_before_timeline");
    }
    const laterExecution = facts.stageExecutions
      .filter((candidate) => candidate.rootIssueId === input.rootIssueId &&
        candidate.cycleIssueId === planResult.cycleIssueId && candidate.stage !== "plan")
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))[0];
    if (!laterExecution) return outcome("inconclusive", "required_write_later_stage_missing");
    if (Date.parse(laterExecution.startedAt) <= Date.parse(timeline.createdAt)) {
      return outcome("violated", "required_write_later_stage_before_timeline");
    }
    return outcome("satisfied", "required_write_fail_closed_confirmed");
  } catch {
    return outcome("inconclusive", "required_write_evidence_invalid");
  }
}

export function analyzeRequiredWriteCampaignEvidence({ rows } = {}) {
  if (!Array.isArray(rows)) return Object.freeze({ case_outcomes: Object.freeze([]) });
  return Object.freeze({
    case_outcomes: Object.freeze(rows
      .filter((row) => row?.e2eCase?.evidence_predicate_id === "required_write_fail_closed")
      .map((row) => Object.freeze({
        case_id: row.e2eCase.case_id,
        outcome: assessRequiredWriteFailClosedEvidence(row),
      }))),
  });
}

function rowInput(value) {
  const row = object(value);
  const e2eCase = object(row.e2eCase);
  const roots = object(row.caseRoots);
  const context = object(row.caseContext);
  const snapshot = object(row.snapshot);
  if (e2eCase.evidence_predicate_id !== "required_write_fail_closed" || !identifier(e2eCase.case_id) ||
      !Array.isArray(roots.root_issue_ids) || roots.root_issue_ids.length !== 1 || !identifier(roots.root_issue_ids[0]) ||
      !identifier(context.symphony_actor_id) || snapshot.kind !== "complete" || !Array.isArray(snapshot.root_trees)) {
    throw new Error("invalid row");
  }
  return { rootIssueId: roots.root_issue_ids[0], symphonyActorId: context.symphony_actor_id, snapshot };
}

function validTree(value) {
  return value && typeof value === "object" && Array.isArray(value.issues) && Array.isArray(value.comments) &&
    Array.isArray(value.managed_blocks);
}

function factsFromTree(tree, symphonyActorId) {
  const comments = new Map();
  for (const comment of tree.comments) {
    if (!validComment(comment)) return null;
    if (comments.has(comment.comment_id)) return null;
    comments.set(comment.comment_id, comment);
  }
  const facts = { stageResults: [], stageExecutions: [], timelines: [] };
  for (const block of tree.managed_blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block) || block.source_kind !== "comment" ||
        !identifier(block.source_id) || !identifier(block.issue_id) || !validActor(block.actor) ||
        block.actor.actor_id !== symphonyActorId || !record(block.record)) return null;
    const comment = comments.get(block.source_id);
    if (!comment || comment.issue_id !== block.issue_id || comment.author.actor_id !== symphonyActorId) return null;
    if (block.record.kind === "stage_result") {
      const value = stageResult(block.record, block.issue_id);
      if (!value) return null;
      facts.stageResults.push(value);
    } else if (block.record.kind === "stage_execution") {
      const value = stageExecution(block.record, block.issue_id);
      if (!value) return null;
      facts.stageExecutions.push(value);
    } else if (block.record.kind === "workflow_timeline") {
      const value = timeline(block.record, block.issue_id, comment.created_at);
      if (!value) return null;
      facts.timelines.push(value);
    }
  }
  return facts;
}

function stageResult(value, sourceIssueId) {
  if (value.version !== 1 || !identifier(value.result_id) || !identifier(value.root_issue_id) ||
      !identifier(value.cycle_issue_id) || !identifier(value.node_issue_id) || !["plan", "work", "verify"].includes(value.stage) ||
      !identifier(value.outcome_kind) || !timestamp(value.completed_at) || !identifier(value.observed_tree_digest) ||
      sourceIssueId !== value.node_issue_id) return null;
  return {
    resultId: value.result_id,
    rootIssueId: value.root_issue_id,
    cycleIssueId: value.cycle_issue_id,
    stage: value.stage,
    outcomeKind: value.outcome_kind,
    completedAt: value.completed_at,
    observedTreeDigest: value.observed_tree_digest,
  };
}

function stageExecution(value, sourceIssueId) {
  if (value.version !== 1 || !identifier(value.stage_execution_id) || !identifier(value.root_issue_id) ||
      !identifier(value.cycle_issue_id) || !identifier(value.node_issue_id) || !["plan", "work", "verify"].includes(value.stage) ||
      !timestamp(value.started_at) || sourceIssueId !== value.node_issue_id) return null;
  return {
    rootIssueId: value.root_issue_id,
    cycleIssueId: value.cycle_issue_id,
    stage: value.stage,
    startedAt: value.started_at,
  };
}

function timeline(value, sourceIssueId, createdAt) {
  if (!exactKeys(value, [
    "kind", "version", "timeline_event_id", "timeline_kind", "target_issue_id", "source_record_ids",
    "source_versions", "write_id", "rendered_schema_version", "occurred_at",
  ]) || value.version !== 1 || !identifier(value.timeline_event_id) || !["root", "cycle"].includes(value.timeline_kind) ||
      !identifier(value.target_issue_id) || !identifierArray(value.source_record_ids) || !textArray(value.source_versions) ||
      !identifier(value.write_id) || value.rendered_schema_version !== "1" || !timestamp(value.occurred_at)) return null;
  return {
    timelineEventId: value.timeline_event_id,
    timelineKind: value.timeline_kind,
    targetIssueId: value.target_issue_id,
    sourceRecordIds: value.source_record_ids,
    sourceVersions: value.source_versions,
    writeId: value.write_id,
    renderedSchemaVersion: value.rendered_schema_version,
    occurredAt: value.occurred_at,
    sourceIssueId,
    createdAt,
  };
}

function isCycleChild(tree, cycleIssueId, rootIssueId) {
  return tree.issues.some((issue) => issue?.issue_id === cycleIssueId && issue.parent_issue_id === rootIssueId);
}

function stageTimelineEventId(rootIssueId, cycleIssueId, resultId) {
  return createHash("sha256")
    .update(["stage_result", rootIssueId, cycleIssueId, resultId].join("\0"), "utf8")
    .digest("hex");
}

function validComment(value) {
  return value && typeof value === "object" && !Array.isArray(value) && identifier(value.comment_id) &&
    identifier(value.issue_id) && timestamp(value.created_at) && text(value.remote_version) && validActor(value.author);
}

function validActor(value) {
  return value && typeof value === "object" && !Array.isArray(value) && identifier(value.actor_id) &&
    ["user", "bot", "external_user"].includes(value.actor_kind);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function identifierArray(value) {
  return Array.isArray(value) && value.every(identifier);
}

function textArray(value) {
  return Array.isArray(value) && value.every(text);
}

function timestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.kind === "string";
}

function object(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
  return value;
}

function exact(values) {
  return values.length === 1 ? values[0] : undefined;
}

function outcome(kind, reasonCode) {
  return Object.freeze({ kind, reason_code: reasonCode });
}
