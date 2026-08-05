import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseCorrelationId, parseRootIssueId, parseRuntimeGeneration, parseTaskIssueId, parseTaskRevision } from "../../contracts/identity.js";
import { parseTaskMcpResult } from "../../task-management/mcp/TaskMcpSchemas.js";
import {
  appliedTaskIssueRecord,
  createTaskIssueRecordCall,
  readExactTaskIssueRecord,
} from "./CycleRecords.js";

const projection = {
  issue_id: "issue:plan:1",
  cycle_id: "issue:cycle:1",
  basis_issue_revision: `symphony:v1:${"a".repeat(64)}`,
  basis_status: "In Progress",
  basis_document_digest: "b".repeat(64),
  record_kind: "stage_completion",
  stage_id: "issue:plan:1",
  completion: { outcome: "failed", instruction_digest: "c".repeat(64), reason_markdown: "Plan failed." },
} as const;

test("Cycle record calls bind exact identity, owner revision, and canonical Markdown", () => {
  const call = createTaskIssueRecordCall({
    root_id: parseRootIssueId("issue:root:1"),
    runtime_generation: parseRuntimeGeneration(2),
    correlation_id: parseCorrelationId("corr:cycle:2"),
  }, {
    record_id: "33333333-3333-4333-8333-333333333333",
    issue_id: parseTaskIssueId("issue:plan:1"),
    expected_issue_revision: parseTaskRevision("revision:plan:1"),
    projection,
  });

  assert.equal(call.function, "create_issue_comment");
  assert.equal(call.input.comment_id, "33333333-3333-4333-8333-333333333333");
  assert.match(call.input.body_markdown, /^## Symphony Record\n\n```json/u);
});

test("applied and restarted records use the same exact immutable provider projection", () => {
  const call = createTaskIssueRecordCall({
    root_id: parseRootIssueId("issue:root:1"),
    runtime_generation: parseRuntimeGeneration(2),
    correlation_id: parseCorrelationId("corr:cycle:2"),
  }, {
    record_id: "33333333-3333-4333-8333-333333333333",
    issue_id: parseTaskIssueId("issue:plan:1"),
    expected_issue_revision: parseTaskRevision("revision:plan:1"),
    projection,
  });
  const comment = {
    comment_id: call.input.comment_id,
    issue_id: call.input.issue_id,
    provider_created_at: "2026-08-02T01:00:00.000Z",
    provider_updated_at: "2026-08-02T01:00:00.000Z",
    provider_edited_at: null,
    provider_archived_at: null,
    actor_id: "actor:symphony",
    body_digest: createHash("sha256").update(call.input.body_markdown, "utf8").digest("hex"),
  } as const;
  const result = parseTaskMcpResult({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      outcome: "applied",
      effect_may_have_occurred: true,
      target: { kind: "comment", comment_id: call.input.comment_id, issue_id: call.input.issue_id },
      fresh_comment: comment,
      sanitized_reason: null,
    },
  }, call);

  const notApplied = parseTaskMcpResult({
    ...result,
    output: {
      ...result.output,
      outcome: "not_applied",
      effect_may_have_occurred: false,
      fresh_comment: null,
      sanitized_reason: "fresh_precondition_unavailable",
    },
  }, call);
  assert.throws(
    () => appliedTaskIssueRecord(call, notApplied, "actor:symphony"),
    /record_mutation_not_applied:fresh_precondition_unavailable/u,
  );

  const applied = appliedTaskIssueRecord(call, result, "actor:symphony");
  const restarted = readExactTaskIssueRecord([{
    ...comment,
    body_markdown: call.input.body_markdown,
  }], call.input.issue_id, call.input.comment_id, "actor:symphony");
  assert.deepEqual(restarted, applied);

  assert.throws(
    () => readExactTaskIssueRecord([
      { ...comment, body_markdown: call.input.body_markdown },
      { ...comment, body_markdown: call.input.body_markdown },
    ], call.input.issue_id, call.input.comment_id, "actor:symphony"),
    /duplicate_record_identity/u,
  );
  assert.throws(
    () => appliedTaskIssueRecord(call, result, "actor:other"),
    /record_actor_mismatch/u,
  );
});
