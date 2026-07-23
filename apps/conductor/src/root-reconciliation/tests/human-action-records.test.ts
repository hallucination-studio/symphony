import assert from "node:assert/strict";
import test from "node:test";

import { parseManagedRecord, serializeManagedRecord } from "../api/index.js";

test("Human Action request and resolution records round-trip as closed managed records", () => {
  const request = {
    kind: "human_action_request" as const,
    version: 1 as const,
    actionId: "action-1",
    actionIssueId: "action-issue-1",
    actionKind: "plan_review" as const,
    parentScope: "cycle" as const,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    relatedIssueIds: ["plan-1"],
    sourceRootDirectiveId: "directive-1",
    sourceRootConvergenceRecordId: "convergence-1",
    basedOnTreeDigest: "tree-digest-1",
    proposalDigest: "proposal-digest-1",
    expectedParentRemoteVersion: "parent-v1",
    createdAt: "2026-07-23T00:00:00Z",
  };
  const resolution = {
    kind: "human_action_resolution" as const,
    version: 1 as const,
    resolutionId: "resolution-1",
    actionId: "action-1",
    actionIssueId: "action-issue-1",
    actionKind: "plan_review" as const,
    outcome: "rejected" as const,
    terminalStatus: "Rejected",
    terminalRemoteVersion: "action-v2",
    sourceCommentIds: ["reason-1"],
    sourceCommentVersions: ["reason-v1"],
    actorKind: "human" as const,
    proposalDigest: "proposal-digest-1",
    resolvedAt: "2026-07-23T00:00:03Z",
  };

  assert.deepEqual(parseManagedRecord(serializeManagedRecord(request)), { ok: true, value: request });
  assert.deepEqual(parseManagedRecord(serializeManagedRecord(resolution)), { ok: true, value: resolution });
});

test("Human Action request records enforce root/cycle scope and resolution actor/outcome enums", () => {
  assert.throws(() => serializeManagedRecord({
    ...requestRecord(),
    parentScope: "root",
    cycleIssueId: "cycle-1",
  }), /managed_record_scope_invalid/u);
  assert.throws(() => serializeManagedRecord({
    ...resolutionRecord(),
    actorKind: "symphony",
  }), /managed_record_enum_invalid:actor_kind/u);
  assert.throws(() => serializeManagedRecord({
    ...resolutionRecord(),
    outcome: "unknown",
  }), /managed_record_enum_invalid:outcome/u);
});

test("Human Action managed records reject unknown fields and missing required provenance", () => {
  assert.throws(() => serializeManagedRecord({
    ...requestRecord(),
    unexpected: "not allowed",
  }), /managed_record_unknown_field:unexpected/u);
  assert.throws(() => serializeManagedRecord({
    ...resolutionRecord(),
    proposalDigest: "",
  }), /managed_record_identifier_invalid:proposal_digest/u);
});

function requestRecord() {
  return {
    kind: "human_action_request" as const,
    version: 1 as const,
    actionId: "action-1",
    actionIssueId: "action-issue-1",
    actionKind: "clarification" as const,
    parentScope: "root" as const,
    rootIssueId: "root-1",
    relatedIssueIds: [],
    proposalDigest: "proposal-digest-1",
    expectedParentRemoteVersion: "root-v1",
    createdAt: "2026-07-23T00:00:00Z",
  };
}

function resolutionRecord() {
  return {
    kind: "human_action_resolution" as const,
    version: 1 as const,
    resolutionId: "resolution-1",
    actionId: "action-1",
    actionIssueId: "action-issue-1",
    actionKind: "clarification" as const,
    outcome: "answered" as const,
    terminalStatus: "Answered",
    terminalRemoteVersion: "action-v2",
    sourceCommentIds: ["answer-1"],
    sourceCommentVersions: ["answer-v1"],
    actorKind: "human" as const,
    proposalDigest: "proposal-digest-1",
    resolvedAt: "2026-07-23T00:00:03Z",
  };
}
