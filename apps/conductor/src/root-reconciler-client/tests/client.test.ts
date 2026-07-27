import assert from "node:assert/strict";
import test from "node:test";

import { PerformerRootReconcilerClientImpl } from "../internal/PerformerRootReconcilerClientImpl.js";
import type { RootDirective, RootReconcilerFailure } from "../../root-reconciliation/api/RootReconciliationContracts.js";

const directive = {
  protocolVersion: 1 as const, requestId: "request-1", rootDirectiveId: "directive-1",
  reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", modelTurn: rootModelTurn(), basedOnTargetRootDigest: "root-1",
  rationale: "wait", evidenceRefs: [], consumedInputIds: [], commentReplies: [],
  action: { kind: "wait" as const, reasonCode: "test", blockingFactRefs: [] },
};

function rootModelTurn(): RootDirective["modelTurn"] {
  return {
    turnRecordId: "root-1:turn-1", role: "root_reconciler", rootIssueId: "root-1",
    reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", invocationState: "confirmed",
    model: "gpt", outcome: "directive_accepted", usage: { status: "unavailable", reason: "provider_omitted" },
    terminalAt: "2026-07-23T00:00:01Z",
  };
}

test("root reconciler client owns session-to-root close correlation", async () => {
  const calls: Array<{ kind: string; rootIssueId?: string; sessionId?: string; reason?: string }> = [];
  const client = new PerformerRootReconcilerClientImpl({
    async openRootReconciler(input) {
      calls.push({ kind: "open", rootIssueId: input.rootIssueId });
      return {
        kind: "opened",
        sessionId: "session-1",
        bootstrapRootDigest: "root-1",
        initialResult: { kind: "directive", directive },
      };
    },
    async advanceRootReconciler(input) {
      calls.push({ kind: "advance", sessionId: input.sessionId });
      throw new Error("not exercised");
    },
    async closeRootReconciler(input) {
      calls.push({ kind: "close", rootIssueId: input.rootIssueId, sessionId: input.sessionId, reason: input.reason });
    },
  });

  const opened = await client.open({
    protocolVersion: 1,
    requestId: "request-1",
    rootIssueId: "root-1",
    profileId: "profile-1",
    modelSettings: { model: "model", reasoningEffort: "medium", isFastModeEnabled: false },
    reconcilerSessionId: "session-request", reconcilerTurnId: "turn-1", observedAt: "2026-07-23T00:00:00Z",
    bootstrap: {} as never,
    limits: { maxContextBytes: 1, maxResultBytes: 1, maxOutputTokens: 1, maxToolCalls: 0, maxWallTimeMs: 1, deadlineAt: "2026-07-23T00:00:01Z" },
  });
  await client.close({ requestId: "request-2", sessionId: opened.sessionId, reason: "root_terminal" });
  assert.deepEqual(calls, [
    { kind: "open", rootIssueId: "root-1" },
    { kind: "close", rootIssueId: "root-1", sessionId: "session-1", reason: "root_terminal" },
  ]);
  await assert.rejects(() => client.close({ requestId: "request-3", sessionId: "session-1", reason: "root_terminal" }), /root_reconciler_session_unknown/u);
});

test("root reconciler client retains close correlation for a retained bootstrap failure", async () => {
  let closeCalls = 0;
  const client = new PerformerRootReconcilerClientImpl({
    async openRootReconciler() {
      return {
        kind: "opened" as const,
        sessionId: "session-1",
        bootstrapRootDigest: "root-1",
        initialResult: { kind: "failed" as const, failure: failureRecord({
          kind: "retained",
          appendOutcome: "accepted",
          providerVisibleContextDigest: "root-1",
        }) },
      };
    },
    async advanceRootReconciler() { throw new Error("not exercised"); },
    async closeRootReconciler() { closeCalls += 1; },
  });

  const opened = await client.open({
    protocolVersion: 1,
    requestId: "request-1",
    rootIssueId: "root-1",
    profileId: "profile-1",
    modelSettings: { model: "model", reasoningEffort: "medium", isFastModeEnabled: false },
    reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", observedAt: "2026-07-23T00:00:00Z",
    bootstrap: {} as never,
    limits: { maxContextBytes: 1, maxResultBytes: 1, maxOutputTokens: 1, maxToolCalls: 0, maxWallTimeMs: 1, deadlineAt: "2026-07-23T00:00:01Z" },
  });

  assert.equal(opened.initialResult.kind, "failed");
  await client.close({ requestId: "request-2", sessionId: "session-1", reason: "turn_failed" });
  assert.equal(closeCalls, 1);
  await assert.rejects(() => client.close({ requestId: "request-3", sessionId: "session-1", reason: "turn_failed" }), /root_reconciler_session_unknown/u);
});

test("root reconciler client discards an advance session after a closed failure", async () => {
  const client = new PerformerRootReconcilerClientImpl({
    async openRootReconciler() {
      return {
        kind: "opened" as const,
        sessionId: "session-1",
        bootstrapRootDigest: "root-1",
        initialResult: { kind: "directive" as const, directive },
      };
    },
    async advanceRootReconciler() {
      return { kind: "failed" as const, failure: failureRecord() };
    },
    async closeRootReconciler() { throw new Error("not exercised"); },
  });

  await client.open({
    protocolVersion: 1,
    requestId: "request-1",
    rootIssueId: "root-1",
    profileId: "profile-1",
    modelSettings: { model: "model", reasoningEffort: "medium", isFastModeEnabled: false },
    reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", observedAt: "2026-07-23T00:00:00Z",
    bootstrap: {} as never,
    limits: { maxContextBytes: 1, maxResultBytes: 1, maxOutputTokens: 1, maxToolCalls: 0, maxWallTimeMs: 1, deadlineAt: "2026-07-23T00:00:01Z" },
  });
  const result = await client.advance({
    requestId: "request-2",
    sessionId: "session-1",
    reconcilerTurnId: "turn-2",
    observedAt: "2026-07-23T00:00:02Z",
    delta: {} as never,
  });

  assert.equal(result.kind, "failed");
  await assert.rejects(() => client.close({ requestId: "request-3", sessionId: "session-1", reason: "turn_failed" }), /root_reconciler_session_unknown/u);
});

function failureRecord(
  continuity: RootReconcilerFailure["continuity"] = { kind: "closed", appendOutcome: "session_lost" },
): RootReconcilerFailure {
  return {
    failureId: "root-1:turn-1:failure",
    reconcilerSessionId: "session-1",
    reconcilerTurnId: "turn-1",
    targetRootDigest: "root-1",
    attemptedInputIds: [],
    modelTurn: {
      turnRecordId: "root-1:turn-1",
      role: "root_reconciler",
      rootIssueId: "root-1",
      reconcilerSessionId: "session-1",
      reconcilerTurnId: "turn-1",
      invocationState: "confirmed",
      model: "gpt",
      outcome: "schema_invalid",
      usage: { status: "unavailable", reason: "provider_omitted" },
      terminalAt: "2026-07-23T00:00:01Z",
    },
    code: "provider_output_invalid",
    category: "schema_invalid",
    sanitizedReason: "The Root Reconciler response was invalid.",
    continuity,
    failedAt: "2026-07-23T00:00:01Z",
  };
}
