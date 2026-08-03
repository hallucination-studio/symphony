import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  parseTaskIssueRecordProjectionMarkdown,
  projectTaskIssueRecord,
  renderTaskIssueRecordProjectionMarkdown,
} from "./cycle-record-markdown.js";

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

test("record Markdown round-trips one canonical semantic projection", () => {
  const markdown = renderTaskIssueRecordProjectionMarkdown(projection);
  assert.deepEqual(parseTaskIssueRecordProjectionMarkdown(markdown), projection);
  assert.equal(markdown, renderTaskIssueRecordProjectionMarkdown({
    completion: projection.completion,
    record_kind: projection.record_kind,
    basis_document_digest: projection.basis_document_digest,
    basis_status: projection.basis_status,
    basis_issue_revision: projection.basis_issue_revision,
    cycle_id: projection.cycle_id,
    issue_id: projection.issue_id,
    stage_id: projection.stage_id,
  }));

  assert.throws(
    () => renderTaskIssueRecordProjectionMarkdown({ ...projection, created_at: "forged" }),
    /record_provider_field_forbidden/u,
  );
  assert.throws(
    () => parseTaskIssueRecordProjectionMarkdown("## Symphony Record\n\nnot structured"),
    /invalid_record_markdown/u,
  );
});

test("fresh immutable provider evidence materializes the full canonical record", () => {
  const markdown = renderTaskIssueRecordProjectionMarkdown(projection);
  const record = projectTaskIssueRecord(markdown, {
    comment_id: "record:plan:completion:1",
    issue_id: "issue:plan:1",
    provider_created_at: "2026-08-02T01:00:00.000Z",
    provider_updated_at: "2026-08-02T01:00:00.000Z",
    provider_edited_at: null,
    provider_archived_at: null,
    actor_id: "actor:symphony",
    body_digest: createHash("sha256").update(markdown, "utf8").digest("hex"),
  });

  assert.equal(record.record_id, "record:plan:completion:1");
  assert.match(record.revision as string, /^symphony:v1:[0-9a-f]{64}$/u);
  assert.equal(record.created_at, "2026-08-02T01:00:00.000Z");
  assert.equal(record.archived_at, null);

  for (const invalid of [
    { provider_updated_at: "2026-08-02T01:00:01.000Z" },
    { provider_edited_at: "2026-08-02T01:00:01.000Z" },
    { provider_archived_at: "2026-08-02T01:00:01.000Z" },
    { actor_id: null },
    { issue_id: "issue:other" },
  ]) {
    assert.throws(() => projectTaskIssueRecord(markdown, {
      comment_id: "record:plan:completion:1",
      issue_id: "issue:plan:1",
      provider_created_at: "2026-08-02T01:00:00.000Z",
      provider_updated_at: "2026-08-02T01:00:00.000Z",
      provider_edited_at: null,
      provider_archived_at: null,
      actor_id: "actor:symphony",
      body_digest: createHash("sha256").update(markdown, "utf8").digest("hex"),
      ...invalid,
    }), /record_provider_evidence_invalid/u);
  }
});
