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
