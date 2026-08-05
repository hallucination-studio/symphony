import {
  parseIssueStatus,
  parseProviderId,
  type IssueStatus,
} from "./identity.js";
import {
  asRecord,
  assertExactKeys,
  freezeObject,
  parseArray,
  parseBoundedString,
  parseMarkdownText,
  parseOptional,
  type MarkdownText,
} from "./validation.js";

export interface LinearIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: MarkdownText;
  readonly url: string;
  readonly status: IssueStatus;
  readonly status_id: string;
  readonly parent_id: string | null;
  readonly team_id: string;
  readonly creator_id: string | null;
}

export interface LinearComment {
  readonly id: string;
  readonly issue_id: string;
  readonly body: MarkdownText;
  readonly creator_id: string;
  readonly created_at: string;
}

export interface LinearWorkflow {
  readonly team_id: string;
  readonly todo_status_id: string;
  readonly in_progress_status_id: string;
  readonly in_review_status_id: string;
  readonly done_status_id: string;
  readonly canceled_status_id: string;
}

export function parseLinearIssue(value: unknown): LinearIssue {
  const record = asRecord(value, "invalid_linear_issue");
  assertExactKeys(record, [
    "id",
    "identifier",
    "title",
    "description",
    "url",
    "status",
    "status_id",
    "parent_id",
    "team_id",
    "creator_id",
  ]);
  const url = parseBoundedString(record.url, "invalid_issue_url", 2_048);
  if (!URL.canParse(url)) throw new Error("invalid_issue_url");
  return freezeObject({
    id: parseProviderId(record.id, "linear_issue_id"),
    identifier: parseProviderId(record.identifier, "linear_issue_identifier"),
    title: parseBoundedString(record.title, "invalid_issue_title", 512),
    description: parseMarkdownText(record.description, "invalid_issue_description"),
    url,
    status: parseIssueStatus(record.status),
    status_id: parseProviderId(record.status_id, "linear_status_id"),
    parent_id: record.parent_id === null ? null : parseProviderId(record.parent_id, "linear_parent_id"),
    team_id: parseProviderId(record.team_id, "linear_team_id"),
    creator_id: parseOptional(record.creator_id, (entry) => (
      entry === null ? null : parseProviderId(entry, "linear_creator_id")
    )) ?? null,
  });
}

export function parseLinearComment(value: unknown): LinearComment {
  const record = asRecord(value, "invalid_linear_comment");
  assertExactKeys(record, ["id", "issue_id", "body", "creator_id", "created_at"]);
  return freezeObject({
    id: parseProviderId(record.id, "linear_comment_id"),
    issue_id: parseProviderId(record.issue_id, "linear_comment_issue_id"),
    body: parseMarkdownText(record.body, "invalid_comment_body"),
    creator_id: parseProviderId(record.creator_id, "linear_comment_creator_id"),
    created_at: parseBoundedString(record.created_at, "invalid_comment_created_at", 64),
  });
}

export function parseLinearWorkflow(value: unknown): LinearWorkflow {
  const record = asRecord(value, "invalid_linear_workflow");
  assertExactKeys(record, [
    "team_id",
    "todo_status_id",
    "in_progress_status_id",
    "in_review_status_id",
    "done_status_id",
    "canceled_status_id",
  ]);
  const workflow = {
    team_id: parseProviderId(record.team_id, "linear_team_id"),
    todo_status_id: parseProviderId(record.todo_status_id, "linear_todo_status_id"),
    in_progress_status_id: parseProviderId(record.in_progress_status_id, "linear_in_progress_status_id"),
    in_review_status_id: parseProviderId(record.in_review_status_id, "linear_in_review_status_id"),
    done_status_id: parseProviderId(record.done_status_id, "linear_done_status_id"),
    canceled_status_id: parseProviderId(record.canceled_status_id, "linear_canceled_status_id"),
  };
  if (new Set(Object.values(workflow)).size !== Object.keys(workflow).length) {
    throw new Error("duplicate_linear_workflow_state");
  }
  return freezeObject(workflow);
}

export function parseLinearComments(value: unknown): readonly LinearComment[] {
  return parseArray(value, parseLinearComment);
}
