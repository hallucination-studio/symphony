import assert from "node:assert/strict";
import test from "node:test";

import type { RootReconciliationView } from "../api/RootReconciliationContracts.js";
import type { RootReconcilerFailureRecord, StageResultRecord } from "../api/ManagedRecords.js";
import { serializeManagedRecord } from "../api/index.js";
import {
  deriveCycleUsageAggregate,
  deriveRootUsageAggregate,
  deriveIssueUsageAggregate,
} from "../internal/UsageAggregation.js";

test("Root usage includes accepted and failed Reconciler turns while Cycle usage excludes both", () => {
  const tree = usageTree([
    comment("work-1", serializeManagedRecord(stageRecord({ resultId: "work-result-1", model: "gpt-5", totalTokens: 5 }))),
    comment("root-1", serializeManagedRecord(rootDirectiveRecord())),
    comment("root-1", serializeManagedRecord(rootFailureRecord())),
  ]);

  const root = deriveRootUsageAggregate({ tree, rootIssueId: "root-1" });
  const cycle = deriveCycleUsageAggregate({ tree, cycleIssueId: "cycle-1" });

  assert.equal(root.sourceRecordCount, 3);
  assert.equal(root.isComplete, false);
  assert.equal(root.unknownTurnCount, 1);
  assert.deepEqual(root.groups.map((group) => [group.role, group.model, group.totalTokens]), [
    ["root_reconciler", "gpt-5", 2],
    ["work", "gpt-5", 5],
  ]);
  assert.equal(cycle.sourceRecordCount, 1);
  assert.deepEqual(cycle.groups.map((group) => group.role), ["work"]);
});

test("an unavailable turn makes its aggregate incomplete without discarding measured totals", () => {
  const tree = usageTree([
    comment("work-1", serializeManagedRecord(stageRecord({ resultId: "work-result-1", model: "gpt-5", totalTokens: 5 }))),
    comment("work-1", serializeManagedRecord(stageRecord({
      resultId: "work-result-2",
      model: "gpt-5-mini",
      usage: { status: "unavailable", reason: "provider_omitted" },
    }))),
  ]);

  const aggregate = deriveIssueUsageAggregate({ tree, targetIssueId: "work-1" });

  assert.equal(aggregate.isComplete, false);
  assert.equal(aggregate.unknownTurnCount, 1);
  assert.equal(aggregate.groups.find((group) => group.model === "gpt-5")?.totalTokens, 5);
  assert.equal(aggregate.groups.find((group) => group.model === "gpt-5-mini")?.unavailableTurnCount, 1);
});

test("usage aggregation rejects duplicate ModelTurnRecord identities", () => {
  const first = stageRecord({ resultId: "work-result-1", model: "gpt-5", totalTokens: 5 });
  const tree = usageTree([
    comment("work-1", serializeManagedRecord(first)),
    comment("work-1", serializeManagedRecord(first)),
  ]);

  assert.throws(
    () => deriveIssueUsageAggregate({ tree, targetIssueId: "work-1" }),
    /usage_aggregate_duplicate_turn/u,
  );
});

test("usage aggregate groups and source digest are deterministic across Linear comment order", () => {
  const comments = [
    comment("work-1", serializeManagedRecord(stageRecord({ resultId: "work-result-1", model: "gpt-5", totalTokens: 5 }))),
    comment("plan-1", serializeManagedRecord(stageRecord({ resultId: "plan-result-1", stage: "plan", targetIssueId: "plan-1", model: "gpt-4.1", totalTokens: 3 }))),
    comment("root-1", serializeManagedRecord(rootDirectiveRecord())),
    comment("root-1", serializeManagedRecord(rootFailureRecord())),
  ];

  const first = deriveRootUsageAggregate({ tree: usageTree(comments), rootIssueId: "root-1" });
  const second = deriveRootUsageAggregate({ tree: usageTree([...comments].reverse()), rootIssueId: "root-1" });

  assert.deepEqual(second, first);
});

function stageRecord(input: {
  resultId: string;
  stage?: "plan" | "work" | "verify";
  targetIssueId?: string;
  model: string;
  totalTokens?: number;
  usage?: StageResultRecord["modelTurn"]["usage"];
}): StageResultRecord {
  const stage = input.stage ?? "work";
  const targetIssueId = input.targetIssueId ?? "work-1";
  const totalTokens = input.totalTokens ?? 0;
  const usage = input.usage ?? {
    status: "measured" as const,
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
  };
  return {
    kind: "stage_result",
    version: 1,
    resultId: input.resultId,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: targetIssueId,
    stage,
    roleSessionId: `${stage}-session-1`,
    roleTurnId: `${input.resultId}-turn-1`,
    observedTreeDigest: "tree-1",
    contextDigest: "context-1",
    outcomeKind: "execution_failed",
    summary: "The stage stopped.",
    sourceManifest: [],
    completedAt: "2026-07-25T00:00:01Z",
    modelTurn: {
      turnRecordId: `${input.resultId}:${input.resultId}-turn-1`,
      role: stage,
      rootIssueId: "root-1",
      cycleIssueId: "cycle-1",
      targetIssueId,
      stageExecutionId: input.resultId,
      roleSessionId: `${stage}-session-1`,
      roleTurnId: `${input.resultId}-turn-1`,
      invocationState: "confirmed",
      model: input.model,
      outcome: "execution_failed",
      usage,
      terminalAt: "2026-07-25T00:00:01Z",
    },
    failureCode: "test_failure",
  };
}

function rootDirectiveRecord() {
  const directive = {
    protocolVersion: 1 as const,
    requestId: "directive-request-1",
    rootDirectiveId: "directive-1",
    reconcilerSessionId: "root-session-1",
    reconcilerTurnId: "root-turn-1",
    modelTurn: {
      turnRecordId: "root-1:root-turn-1",
      role: "root_reconciler" as const,
      rootIssueId: "root-1",
      reconcilerSessionId: "root-session-1",
      reconcilerTurnId: "root-turn-1",
      invocationState: "confirmed" as const,
      model: "gpt-5",
      outcome: "directive_accepted" as const,
      usage: { status: "measured" as const, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 },
      terminalAt: "2026-07-25T00:00:02Z",
    },
    basedOnTargetRootDigest: "tree-1",
    rationale: "Wait for the next durable fact.",
    evidenceRefs: [],
    consumedInputIds: [],
    commentReplies: [],
    humanActionResolutions: [],
    action: { kind: "wait" as const, reasonCode: "test", blockingFactRefs: [] },
  };
  return {
    kind: "root_directive" as const,
    version: 1 as const,
    rootDirectiveId: directive.rootDirectiveId,
    rootIssueId: "root-1",
    reconcilerSessionId: directive.reconcilerSessionId,
    reconcilerTurnId: directive.reconcilerTurnId,
    basedOnTargetRootDigest: directive.basedOnTargetRootDigest,
    consumedInputIds: directive.consumedInputIds,
    directive,
    acceptedAt: "2026-07-25T00:00:02Z",
  };
}

function rootFailureRecord(): RootReconcilerFailureRecord {
  return {
    kind: "root_reconciler_failure",
    version: 1,
    failureId: "root-1:root-turn-2:failure",
    reconcilerSessionId: "root-session-1",
    reconcilerTurnId: "root-turn-2",
    targetRootDigest: "tree-2",
    attemptedInputIds: [],
    modelTurn: {
      turnRecordId: "root-1:root-turn-2",
      role: "root_reconciler",
      rootIssueId: "root-1",
      reconcilerSessionId: "root-session-1",
      reconcilerTurnId: "root-turn-2",
      invocationState: "confirmed",
      model: "gpt-5",
      outcome: "schema_invalid",
      usage: { status: "unavailable", reason: "provider_omitted" },
      terminalAt: "2026-07-25T00:00:03Z",
    },
    category: "schema_invalid",
    sanitizedReason: "The Root Reconciler response was invalid.",
    failedAt: "2026-07-25T00:00:03Z",
  };
}

function usageTree(comments: RootReconciliationView["tree"]["comments"]): RootReconciliationView["tree"] {
  return { comments } as RootReconciliationView["tree"];
}

function comment(issueId: string, body: string): RootReconciliationView["tree"]["comments"][number] {
  return {
    comment_id: `comment-${issueId}-${createCommentSequence++}`,
    issue_id: issueId,
    body,
    author_kind: "symphony",
    author_id: "symphony-bot",
    thread_root_comment_id: `thread-${createCommentSequence}`,
    thread_state: "unresolved",
    reactions: [],
    remote_version: `comment-v${createCommentSequence}`,
    created_at: `2026-07-25T00:00:${String(createCommentSequence).padStart(2, "0")}Z`,
    updated_at: `2026-07-25T00:00:${String(createCommentSequence++).padStart(2, "0")}Z`,
  };
}

let createCommentSequence = 1;
