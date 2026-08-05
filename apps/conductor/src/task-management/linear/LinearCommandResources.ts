import type { TaskIssueId } from "../../contracts/identity.js";
import {
  canonicalTaskRevision,
  parseTaskIssueSnapshotChange,
  parseTaskRelationSnapshot,
  type TaskIssueSnapshot,
  type TaskRelationSnapshot,
} from "../../contracts/task-management.js";
import {
  asRecord,
  assertExactKeys,
  markdownSemanticallyEqual,
  parseArray,
  parseBoundedString,
} from "../../contracts/validation.js";
import { taskStringSetsEqual } from "../../observation/TaskFacts.js";
import type { UpdateIssueDesired } from "../mcp/TaskMcpSchemas.js";

export interface LinearCommandIssueRecord {
  readonly snapshot: TaskIssueSnapshot;
  readonly teamId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly creatorId: string | null;
  readonly archived: boolean;
  readonly trashed: boolean;
}

export interface LinearCommandPage<T> {
  readonly nodes: readonly T[];
  readonly nextCursor: string | null;
}

export type LinearProviderOutcome = "accepted" | "rejected" | "uncertain" | "malformed";

export function linearCommandIssueFromSnapshot(
  snapshot: TaskIssueSnapshot,
  teamId: string,
): LinearCommandIssueRecord {
  const parsed = parseTaskIssueSnapshotChange(snapshot);
  return Object.freeze({
    snapshot: parsed,
    teamId: parseBoundedString(teamId, "invalid_linear_team_id", 128),
    createdAt: parsed.provider_created_at,
    updatedAt: parsed.provider_updated_at,
    creatorId: parsed.creation_actor_id,
    archived: parsed.archived,
    trashed: parsed.trashed,
  });
}

function parseTimestamp(value: unknown): string {
  const timestamp = parseBoundedString(value, "invalid_linear_timestamp", 64);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error("linear_invalid_payload");
  }
  return timestamp;
}

function parseRelation(value: unknown, serviceActorId: string): TaskRelationSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, [
    "id", "revision", "type", "source_issue_id", "target_issue_id", "created_at", "updated_at", "archived",
  ]);
  const providerCreatedAt = parseTimestamp(record.created_at);
  const providerUpdatedAt = parseTimestamp(record.updated_at);
  if (typeof record.archived !== "boolean") throw new Error("linear_invalid_payload");
  if (record.archived) throw new Error("linear_archived_relation");
  const fields = {
    relation_id: record.id,
    provider_created_at: providerCreatedAt,
    provider_updated_at: providerUpdatedAt,
    creation_actor_id: serviceActorId,
    creation_evidence_id: `linear:relation:${String(record.id)}`,
    type: record.type,
    source_issue_id: record.source_issue_id,
    target_issue_id: record.target_issue_id,
  };
  return parseTaskRelationSnapshot({ ...fields, revision: canonicalTaskRevision(fields) });
}

export function parseLinearRelationPage(
  value: unknown,
  limit: number,
  serviceActorId: string,
): LinearCommandPage<TaskRelationSnapshot> {
  const record = asRecord(value);
  assertExactKeys(record, ["nodes", "page_info"]);
  const pageInfo = asRecord(record.page_info);
  assertExactKeys(pageInfo, ["has_next_page", "end_cursor"]);
  if (typeof pageInfo.has_next_page !== "boolean") throw new Error("linear_invalid_payload");
  const nextCursor = pageInfo.end_cursor === null
    ? null
    : parseBoundedString(pageInfo.end_cursor, "invalid_linear_cursor", 512);
  if (pageInfo.has_next_page && nextCursor === null) throw new Error("linear_incomplete_page");
  return Object.freeze({
    nodes: parseArray(record.nodes, (entry) => parseRelation(entry, serviceActorId), limit),
    nextCursor: pageInfo.has_next_page ? nextCursor : null,
  });
}

export function parseLinearMutationReceipt(value: unknown): Exclude<LinearProviderOutcome, "uncertain"> {
  try {
    const record = asRecord(value);
    assertExactKeys(record, ["success"]);
    if (typeof record.success !== "boolean") return "malformed";
    return record.success ? "accepted" : "rejected";
  } catch {
    return "malformed";
  }
}

function priorityMatches(actual: number | null, desired: number | null): boolean {
  return actual === desired || (actual === null && desired === 0);
}

export function linearIssueMatches(issue: TaskIssueSnapshot, desired: UpdateIssueDesired): boolean {
  return (desired.title === undefined || issue.title === desired.title)
    && (desired.description === undefined
      || (desired.description !== null
        && (issue.description_markdown === desired.description
          || markdownSemanticallyEqual(issue.description_markdown, desired.description))))
    && (desired.state_id === undefined || issue.status_id === desired.state_id)
    && (desired.parent_id === undefined || issue.parent_issue_id === desired.parent_id)
    && (desired.label_ids === undefined || taskStringSetsEqual(issue.label_ids, desired.label_ids))
    && (desired.delegate_id === undefined || issue.delegate_id === desired.delegate_id)
    && (desired.priority === undefined || priorityMatches(issue.priority, desired.priority));
}

export function assertLinearIssueIdentity(
  issue: LinearCommandIssueRecord,
  issueId: TaskIssueId,
  teamId: string,
): LinearCommandIssueRecord {
  if (issue.snapshot.issue_id !== issueId) throw new Error("linear_issue_identity_mismatch");
  if (issue.teamId !== teamId) throw new Error("linear_team_mismatch");
  return issue;
}
