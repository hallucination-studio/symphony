import {
  projectTaskIssueRecord,
  renderTaskIssueRecordProjectionMarkdown,
} from "../../contracts/cycle-record-markdown.js";
import type {
  CorrelationId,
  RootIssueId,
  RuntimeGeneration,
  TaskIssueId,
  TaskRevision,
} from "../../contracts/identity.js";
import type { UnknownRecord } from "../../contracts/validation.js";
import { TASK_MCP_CAPABILITIES, type CreateIssueCommentCall, type CreateIssueCommentResult } from "../../task-management/mcp/TaskMcpSchemas.js";
import type { LinearIssueRecordComment } from "../../task-management/linear/LinearQueries.js";

interface RecordCallTarget {
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
}

interface RecordCallInput {
  readonly record_id: string;
  readonly issue_id: TaskIssueId;
  readonly expected_issue_revision: TaskRevision;
  readonly projection: unknown;
}

export function createTaskIssueRecordCall(
  target: RecordCallTarget,
  input: RecordCallInput,
): CreateIssueCommentCall {
  return Object.freeze({
    schema_version: 1,
    function: "create_issue_comment",
    root_id: target.root_id,
    runtime_generation: target.runtime_generation,
    correlation_id: target.correlation_id,
    capability: TASK_MCP_CAPABILITIES.create_issue_comment,
    input: Object.freeze({
      comment_id: input.record_id,
      issue_id: input.issue_id,
      expected_issue_revision: input.expected_issue_revision,
      body_markdown: renderTaskIssueRecordProjectionMarkdown(input.projection),
    }),
  });
}

export function appliedTaskIssueRecord(
  call: CreateIssueCommentCall,
  result: CreateIssueCommentResult,
  expectedActorId: string,
): UnknownRecord {
  const comment = result.output.fresh_comment;
  if (result.output.outcome !== "applied" || comment === null) {
    const reason = result.output.sanitized_reason;
    const reasonCode = typeof reason === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(reason)
      ? reason
      : "unknown";
    throw new Error(`record_mutation_not_applied:${reasonCode}`);
  }
  if (comment.actor_id !== expectedActorId) throw new Error("record_actor_mismatch");
  return projectTaskIssueRecord(call.input.body_markdown, comment);
}

export function readExactTaskIssueRecord(
  comments: readonly LinearIssueRecordComment[],
  issueId: TaskIssueId,
  recordId: string,
  expectedActorId: string,
): UnknownRecord | null {
  const matches = comments.filter(({ comment_id }) => comment_id === recordId);
  if (matches.length > 1) throw new Error("duplicate_record_identity");
  const comment = matches[0];
  if (comment === undefined) return null;
  if (comment.issue_id !== issueId) throw new Error("record_issue_mismatch");
  if (comment.actor_id !== expectedActorId) throw new Error("record_actor_mismatch");
  return projectTaskIssueRecord(comment.body_markdown, comment);
}
