import type { TaskIssueId } from "../../contracts/identity.js";
import {
  parseTaskIssueSnapshot,
  parseTaskRelationSnapshot,
  type TaskIssueSnapshot,
  type TaskRelationSnapshot,
} from "../../contracts/observation.js";
import { asRecord, assertExactKeys, parseArray, parseBoundedString } from "../../contracts/validation.js";
import { taskStringSetsEqual } from "../../observation/TaskFacts.js";
import type { UpdateIssueDesired } from "../mcp/TaskMcpSchemas.js";

export interface LinearCommandIssueRecord {
  readonly snapshot: TaskIssueSnapshot;
  readonly teamId: string;
  readonly archived: boolean;
}

export interface LinearCommandPage<T> {
  readonly nodes: readonly T[];
  readonly nextCursor: string | null;
}

export type LinearProviderOutcome = "accepted" | "rejected" | "uncertain" | "malformed";

export function parseLinearCommandIssue(value: unknown): LinearCommandIssueRecord {
  const record = asRecord(value);
  assertExactKeys(record, [
    "id", "revision", "team_id", "parent_id", "status", "title", "description", "labels",
    "delegate_id", "priority", "archived",
  ]);
  if (typeof record.archived !== "boolean") throw new Error("linear_invalid_payload");
  return Object.freeze({
    snapshot: parseTaskIssueSnapshot({
      issue_id: record.id,
      revision: record.revision,
      status: record.status,
      title: record.title,
      description: record.description,
      parent_id: record.parent_id,
      labels: record.labels,
      delegate_id: record.delegate_id,
      priority: record.priority,
    }),
    teamId: parseBoundedString(record.team_id, "invalid_linear_team_id", 128),
    archived: record.archived,
  });
}

function parseRelation(value: unknown): TaskRelationSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, ["id", "revision", "type", "source_issue_id", "target_issue_id"]);
  return parseTaskRelationSnapshot({
    relation_id: record.id,
    revision: record.revision,
    type: record.type,
    source_issue_id: record.source_issue_id,
    target_issue_id: record.target_issue_id,
  });
}

export function parseLinearRelationPage(value: unknown, limit: number): LinearCommandPage<TaskRelationSnapshot> {
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
    nodes: parseArray(record.nodes, parseRelation, limit),
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
    && (desired.description === undefined || issue.description === desired.description)
    && (desired.state_id === undefined || issue.status === desired.state_id)
    && (desired.parent_id === undefined || issue.parent_id === desired.parent_id)
    && (desired.label_ids === undefined || taskStringSetsEqual(issue.labels, desired.label_ids))
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
