import { createHash } from "node:crypto";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SYMPHONY_BLOCK = /^```symphony\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gmu;

export function createRequiredWriteOutageController() {
  const outages = new Map();

  return Object.freeze({
    arm({ root_issue_id: rootIssueId } = {}) {
      assertRootIssueId(rootIssueId);
      if (outages.has(rootIssueId)) throw stableError("required_write_outage_already_armed");
      outages.set(rootIssueId, {
        kind: "armed",
        rootIssueId,
        blocked: deferred(),
        release: deferred(),
      });
    },
    async waitUntilBlocked({ root_issue_id: rootIssueId } = {}) {
      const outage = requireOutage(outages, rootIssueId);
      await outage.blocked.promise;
    },
    restore({ root_issue_id: rootIssueId } = {}) {
      const outage = requireOutage(outages, rootIssueId);
      if (outage.kind !== "blocked") throw stableError("required_write_outage_not_blocked");
      outage.release.resolve();
    },
    snapshot({ root_issue_id: rootIssueId } = {}) {
      const outage = requireOutage(outages, rootIssueId);
      return outage.kind === "armed"
        ? Object.freeze({ kind: "armed", root_issue_id: rootIssueId })
        : outage.kind === "blocked"
          ? Object.freeze({
            kind: "blocked",
            root_issue_id: rootIssueId,
            plan_result_id: outage.planResultId,
            timeline_event_id: outage.timelineEventId,
          })
          : Object.freeze({
            kind: "recovered",
            root_issue_id: rootIssueId,
            plan_result_id: outage.planResultId,
            timeline_event_id: outage.timelineEventId,
          });
    },
    async beforePhysicalRequest(input) {
      const request = physicalRequest(input);
      if (!isMutation(request.document) || request.scope?.mutation?.command_kind !== "append_workflow_comment") return;
      const outage = outages.get(request.scope.root_issue_id);
      if (!outage) return;
      const record = managedRecord(request.scope.mutation.body);
      if (!record) return;
      if (outage.kind === "armed" && completedPlanResult(record, request.scope.root_issue_id)) {
        outage.planResultId = record.result_id;
        outage.cycleIssueId = record.cycle_issue_id;
        return;
      }
      if (outage.kind !== "armed" || !matchingPlanTimeline(record, request.scope.mutation, outage)) return;
      outage.kind = "blocked";
      outage.timelineEventId = record.timeline_event_id;
      outage.blocked.resolve();
      await outage.release.promise;
      outage.kind = "recovered";
    },
  });
}

function completedPlanResult(record, rootIssueId) {
  return record.kind === "stage_result" && record.stage === "plan" && record.outcome_kind === "plan_completed" &&
    identifier(record.result_id) && record.root_issue_id === rootIssueId && identifier(record.cycle_issue_id);
}

function matchingPlanTimeline(record, mutation, outage) {
  return record.kind === "workflow_timeline" && record.timeline_kind === "cycle" &&
    record.target_issue_id === outage.cycleIssueId && mutation.target_issue_id === outage.cycleIssueId &&
    record.timeline_event_id === stageTimelineEventId(outage.rootIssueId, outage.cycleIssueId, outage.planResultId) &&
    Array.isArray(record.source_record_ids) && record.source_record_ids.length === 1 &&
    record.source_record_ids[0] === outage.planResultId;
}

function stageTimelineEventId(rootIssueId, cycleIssueId, resultId) {
  return createHash("sha256")
    .update(["stage_result", rootIssueId, cycleIssueId, resultId].join("\0"), "utf8")
    .digest("hex");
}

function physicalRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.document !== "string") {
    throw stableError("required_write_outage_request_invalid");
  }
  return value;
}

function managedRecord(body) {
  if (typeof body !== "string") return undefined;
  const blocks = [...body.matchAll(SYMPHONY_BLOCK)];
  if (blocks.length !== 1) return undefined;
  const block = blocks[0];
  if (!block || body.slice((block.index ?? 0) + block[0].length).trim()) return undefined;
  try {
    const value = JSON.parse(block[1].trim());
    return value && typeof value === "object" && !Array.isArray(value) && value.version === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isMutation(document) {
  return /^\s*mutation\b/u.test(document);
}

function requireOutage(outages, rootIssueId) {
  assertRootIssueId(rootIssueId);
  const outage = outages.get(rootIssueId);
  if (!outage) throw stableError("required_write_outage_not_armed");
  return outage;
}

function assertRootIssueId(value) {
  if (!identifier(value)) throw stableError("required_write_outage_root_invalid");
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function deferred() {
  let resolve;
  const promise = new Promise((result) => { resolve = result; });
  return { promise, resolve };
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
