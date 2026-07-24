import assert from "node:assert/strict";
import test from "node:test";

import { parseManagedRecord, serializeManagedRecord } from "../api/index.js";

test("stage result records round-trip as closed managed records", () => {
  const record = {
    kind: "stage_result" as const,
    version: 1 as const,
    resultId: "work-execution-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "work-1",
    stage: "work" as const,
    roleSessionId: "work-session-1",
    roleTurnId: "work-turn-1",
    observedTreeDigest: "tree-v1",
    contextDigest: "context-v1",
    outcomeKind: "work_completed" as const,
    summary: "Work completed",
    sourceManifest: [],
    completedAt: "2026-07-23T00:00:06Z",
    changedPaths: ["src/example.ts"],
    commitRevision: "revision-1",
  };

  assert.deepEqual(parseManagedRecord(serializeManagedRecord(record)), { ok: true, value: record });
});

test("managed records require exactly one strict symphony code block", () => {
  const record = {
    kind: "stage_result" as const,
    version: 1 as const,
    resultId: "result-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "work-1",
    stage: "work" as const,
    roleSessionId: "session-1",
    roleTurnId: "turn-1",
    observedTreeDigest: "tree-1",
    contextDigest: "context-1",
    outcomeKind: "work_completed" as const,
    summary: "Implemented the requested change.",
    sourceManifest: [],
    completedAt: "2026-07-24T00:00:00Z",
    changedPaths: ["apps/conductor/src/root-reconciliation/tests/stage-result-records.test.ts"],
    commitRevision: "revision-1",
  };
  const rendered = serializeManagedRecord(record);

  assert.match(rendered, /```symphony\n\{.*\}\n```$/u);
  assert.deepEqual(parseManagedRecord(rendered), { ok: true, value: record });
  assert.deepEqual(
    parseManagedRecord(`<!-- ${"symphony"} managed-record\n${JSON.stringify(record)}\n-->`),
    { ok: false, error: "managed_record_block_missing" },
  );
  assert.deepEqual(
    parseManagedRecord(`\`\`\`json\n${JSON.stringify(record)}\n\`\`\``),
    { ok: false, error: "managed_record_block_missing" },
  );
  assert.deepEqual(
    parseManagedRecord(`\`\`\`symphony\n${JSON.stringify(record)}\n\`\`\`\n\n\`\`\`symphony\n${JSON.stringify(record)}\n\`\`\``),
    { ok: false, error: "managed_record_block_ambiguous" },
  );
});

test("retired node marker records cannot be decoded or recovered", () => {
  assert.deepEqual(
    parseManagedRecord(`\`\`\`symphony\n${JSON.stringify({ kind: ["node", "marker"].join("_"), version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_key: "work:one", node_kind: "work", plan_contract_digest: "contract-1" })}\n\`\`\``),
    { ok: false, error: "managed_record_kind_invalid" },
  );
});

test("workflow issue records bind a stable Issue identity without lifecycle state", () => {
  const record = {
    kind: "workflow_issue" as const,
    version: 1 as const,
    issueKey: "directive-1:work:database",
    rootIssueId: "root-1",
    parentIssueId: "cycle-1",
    issueKind: "work" as const,
  };
  const rendered = serializeManagedRecord(record, "## Implement database migration\n\nApply the reviewed schema change.");

  assert.match(rendered, /^## Implement database migration/u);
  assert.deepEqual(parseManagedRecord(rendered), { ok: true, value: record });
  assert.throws(() => serializeManagedRecord({ ...record, status: "Todo" }), /managed_record_unknown_field:status/u);
});

test("stage result records reject role-specific fields on the wrong outcome", () => {
  assert.throws(() => serializeManagedRecord({
    kind: "stage_result",
    version: 1,
    resultId: "verify-execution-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "verify-1",
    stage: "verify",
    roleSessionId: "verify-session-1",
    roleTurnId: "verify-turn-1",
    observedTreeDigest: "tree-v1",
    contextDigest: "context-v1",
    outcomeKind: "verify_passed",
    summary: "Verify passed",
    sourceManifest: [],
    completedAt: "2026-07-23T00:00:06Z",
    changedPaths: ["src/example.ts"],
  }), /managed_record_stage_result_field_invalid/u);
});

test("a completed Plan Stage Result requires its complete canonical input", () => {
  assert.throws(() => serializeManagedRecord({
    kind: "stage_result",
    version: 1,
    resultId: "plan-execution-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "plan-1",
    stage: "plan",
    roleSessionId: "plan-session-1",
    roleTurnId: "plan-turn-1",
    observedTreeDigest: "tree-v1",
    contextDigest: "context-v1",
    outcomeKind: "plan_completed",
    summary: "Plan completed",
    sourceManifest: [],
    completedAt: "2026-07-23T00:00:06Z",
  }), /managed_record_required_field:plan_completed/u);
});
