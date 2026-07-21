import assert from "node:assert/strict";
import test from "node:test";

import type { ManagedRecord } from "../api/ManagedRecords.js";
import {
  parseManagedRecord,
  serializeManagedRecord,
} from "../internal/ManagedRecordCodec.js";

const records: ManagedRecord[] = [
  {
    kind: "root_ownership",
    version: 1,
    rootIssueId: "root-1",
    conductorId: "conductor-1",
    performerProfileId: "profile-1",
    deliveryBranch: "symphony/root-1",
    pullRequest: "https://example.test/pr/1",
    ownerGeneration: "generation-1",
  },
  {
    kind: "delivery",
    version: 1,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    verifyResultId: "execution-verify-1",
    verifiedRevision: "git-head-1",
    deliveryKind: "pull_request",
    deliveryBranch: "symphony/root-1",
    pullRequest: "https://example.test/pr/1",
    deliveredAt: "2026-07-21T00:06:00Z",
  },
  {
    kind: "cycle_marker",
    version: 1,
    rootIssueId: "root-1",
    cycleKey: "cycle-initial",
    trigger: "initial",
    baselineRevision: "git-base-1",
  },
  {
    kind: "node_marker",
    version: 1,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeKey: "work-api",
    nodeKind: "work",
    planContractDigest: "plan-digest-1",
  },
  {
    kind: "plan_contract",
    version: 1,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    planContractDigest: "plan-digest-1",
    objectiveSummary: "Implement the bounded workflow codec.",
    includedScope: ["apps/conductor/src/root-workflow"],
    excludedScope: ["packages/podium"],
    acceptanceCriteria: [{
      criterionKey: "codec-round-trip",
      statement: "Managed records round-trip exactly.",
      verificationMethod: "focused Conductor tests",
    }],
    workNodes: [{
      workKey: "codec",
      title: "Implement codecs",
      description: "Add closed record parsing.",
      acceptanceCriteria: [{
        criterionKey: "strict-fields",
        statement: "Unknown fields are rejected.",
        verificationMethod: "negative fixture",
      }],
      dependencyWorkKeys: [],
    }],
    verifyNode: {
      title: "Verify codecs",
      acceptanceCriteria: [{
        criterionKey: "tests",
        statement: "The focused test suite passes.",
        verificationMethod: "npm test",
      }],
      requiredChecks: [{
        checkKey: "conductor-typecheck",
        commandOrMethod: "npm run typecheck -w @symphony/conductor",
        outcome: "not_run",
        summary: "Pending implementation.",
        artifactRevision: "git-base-1",
      }],
    },
  },
  {
    kind: "stage_execution",
    version: 1,
    stageExecutionId: "execution-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "node-1",
    stage: "work",
    planContractDigest: "plan-digest-1",
    contextDigest: "context-digest-1",
    sourceManifest: [{
      sourceKind: "linear_issue",
      sourceId: "node-1",
      versionOrDigest: "linear-version-1",
    }],
    coverage: { isComplete: true, omissions: [] },
    instructionSetId: "instructions-1",
    executionPolicyId: "policy-1",
    limits: {
      maxContextBytes: 100_000,
      maxResultBytes: 20_000,
      maxWallTimeMs: 60_000,
      maxToolCalls: 20,
      maxCommandDurationMs: 10_000,
      reservedTotalTokens: 4_000,
      maxOutputTokens: 2_000,
    },
    repositoryRevision: "git-base-1",
    startedAt: "2026-07-21T00:00:00Z",
    deadlineAt: "2026-07-21T00:10:00Z",
  },
  {
    kind: "stage_terminal",
    version: 1,
    stageExecutionId: "execution-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "node-1",
    stage: "work",
    contextDigest: "context-digest-1",
    outcome: "completed",
    completedAt: "2026-07-21T00:05:00Z",
    summary: "Work completed.",
    usage: {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 140,
    },
  },
  {
    kind: "work_completion",
    version: 1,
    stageExecutionId: "execution-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "node-1",
    workKey: "work-api",
    contextDigest: "context-digest-1",
    summary: "Work completed.",
    changedPaths: ["apps/conductor/src/root-workflow/ManagedRecords.ts"],
    checks: [{
      checkKey: "test",
      commandOrMethod: "focused test",
      outcome: "passed",
      summary: "The focused test passed.",
      artifactRevision: "git-result-1",
    }],
    commitRevision: "git-result-1",
  },
  {
    kind: "human_action",
    version: 1,
    actionId: "action-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "node-1",
    requestKind: "needs_approval",
    questionOrProposal: "Approve the plan.",
    reason: "A human must approve the generated graph.",
    impact: "Work remains blocked until approval.",
    contextDigest: "context-digest-1",
    expectedRootRemoteVersion: "root-version-1",
  },
  {
    kind: "finding",
    version: 1,
    findingId: "finding-1",
    sourceVerifyId: "verify-1",
    category: "code",
    severity: "high",
    evidence: [{
      evidenceId: "evidence-1",
      sourceKind: "check",
      sourceId: "check-1",
      summary: "The check exposed the failing behavior.",
      artifactRevision: "git-result-1",
    }],
    affectedScope: [{ scopeKind: "repository_path", identity: "src/example.ts" }],
    retryable: true,
    suggestedRemediation: ["Fix the failing behavior."],
    acceptanceCriteria: [{
      criterionKey: "fixed",
      statement: "The failing check passes.",
      verificationMethod: "check-1",
    }],
  },
  {
    kind: "finding_disposition",
    version: 1,
    findingId: "finding-1",
    sourceVerifyId: "verify-2",
    disposition: "resolved",
    evidence: [{
      evidenceId: "evidence-2",
      sourceKind: "check",
      sourceId: "check-2",
      summary: "The fix was verified.",
      artifactRevision: "git-result-2",
    }],
  },
  {
    kind: "verify_result",
    version: 1,
    stageExecutionId: "verify-2",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "verify-node-1",
    conclusion: "passed",
    criteriaResults: [{ criterionKey: "build", outcome: "passed", summary: "Build passed." }],
    checks: [{ checkKey: "typecheck", commandOrMethod: "typecheck", outcome: "passed", summary: "Typecheck passed.", artifactRevision: "git-result-2" }],
    verifiedRevision: "git-result-2",
  },
  {
    kind: "progress_assessment",
    version: 1,
    rootIssueId: "root-1",
    previousVerifyId: "verify-1",
    currentVerifyId: "verify-2",
    resolvedFindingIds: ["finding-1"],
    previousPassedCriterionKeys: ["build"],
    currentPassedCriterionKeys: ["build", "tests"],
    previousPassedCheckKeys: ["typecheck"],
    currentPassedCheckKeys: ["typecheck", "test"],
    isProgress: true,
  },
  {
    kind: "convergence",
    version: 1,
    rootIssueId: "root-1",
    observedAt: "2026-07-21T00:10:00Z",
    policy: {
      maxCyclesPerRoot: 3,
      maxSameOpenFindingCycles: 2,
      maxConsecutiveNoProgress: 2,
      maxTotalTokens: 20_000,
      deadlineAt: "2026-07-22T00:00:00Z",
    },
    view: {
      cycleCount: 1,
      openFindingPersistence: [{ findingId: "finding-1", openCycleCount: 1 }],
      consecutiveNoProgress: 0,
      settledTokens: 140,
      openTokenReservations: [{
        stageExecutionId: "execution-2",
        reservedTotalTokens: 4_000,
      }],
      isDeadlineExceeded: false,
      rootIsCanceled: false,
    },
    trigger: "none",
    decision: "allow",
  },
];

test("every managed record has an exact closed round trip", () => {
  for (const record of records) {
    const serialized = serializeManagedRecord(record);
    const parsed = parseManagedRecord(serialized);
    assert.deepEqual(parsed, { ok: true, value: record });
    assert.equal(serializeManagedRecord(parsed.value), serialized);
    assert.match(serialized, /^<!-- symphony managed-record\n/u);
  }
});

test("managed record codecs reject unknown fields and malformed marker framing", () => {
  const serialized = serializeManagedRecord(records[0]!);
  const payload = JSON.parse(serialized.slice("<!-- symphony managed-record\n".length, -"\n-->".length));
  payload.untrusted_metadata = "do not accept";
  const unknownField = `<!-- symphony managed-record\n${JSON.stringify(payload)}\n-->`;

  assert.deepEqual(parseManagedRecord(unknownField), {
    ok: false,
    error: "managed_record_unknown_field:untrusted_metadata",
  });
  assert.deepEqual(parseManagedRecord(`${serialized}\nextra`), {
    ok: false,
    error: "managed_record_marker_invalid",
  });
});

test("convergence records require a closed trigger", () => {
  const serialized = serializeManagedRecord(records.find(({ kind }) => kind === "convergence")!);
  const payload = JSON.parse(serialized.slice("<!-- symphony managed-record\n".length, -"\n-->".length));
  delete payload.trigger;
  assert.deepEqual(parseManagedRecord(`<!-- symphony managed-record\n${JSON.stringify(payload)}\n-->`), {
    ok: false,
    error: "managed_record_required_field:trigger",
  });
});

test("managed record codecs require Conductor-owned Finding identity and Verify provenance", () => {
  const record = records.find(({ kind }) => kind === "finding")!;
  const payload = JSON.parse(serializeManagedRecord(record).slice(
    "<!-- symphony managed-record\n".length,
    -"\n-->".length,
  ));
  delete payload.finding_id;
  assert.deepEqual(parseManagedRecord(`<!-- symphony managed-record\n${JSON.stringify(payload)}\n-->`), {
    ok: false,
    error: "managed_record_required_field:finding_id",
  });

  const disposition = records.find(({ kind }) => kind === "finding_disposition")!;
  const dispositionPayload = JSON.parse(serializeManagedRecord(disposition).slice(
    "<!-- symphony managed-record\n".length,
    -"\n-->".length,
  ));
  delete dispositionPayload.source_verify_id;
  assert.deepEqual(parseManagedRecord(`<!-- symphony managed-record\n${JSON.stringify(dispositionPayload)}\n-->`), {
    ok: false,
    error: "managed_record_required_field:source_verify_id",
  });
});

test("stage execution stores reservation only under limits and never persists attempts", () => {
  const execution = records.find(({ kind }) => kind === "stage_execution")!;
  const serialized = serializeManagedRecord(execution);
  assert.match(serialized, /"reserved_total_tokens":4000/u);
  assert.equal(serialized.includes("reserved_total_tokens"), true);
  assert.equal(serialized.includes("attempt"), false);

  const payload = JSON.parse(serialized.slice(
    "<!-- symphony managed-record\n".length,
    -"\n-->".length,
  ));
  payload.attempt_count = 1;
  assert.deepEqual(parseManagedRecord(`<!-- symphony managed-record\n${JSON.stringify(payload)}\n-->`), {
    ok: false,
    error: "managed_record_unknown_field:attempt_count",
  });
});

test("managed record codecs reject unbounded text", () => {
  const record = records.find(({ kind }) => kind === "human_action")!;
  assert.throws(
    () => serializeManagedRecord({ ...record, questionOrProposal: "x".repeat(16_385) }),
    /managed_record_bounded_text_invalid/u,
  );
});
