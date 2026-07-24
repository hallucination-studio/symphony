import assert from "node:assert/strict";
import test from "node:test";

import { PerformerRootReconcilerClientImpl } from "../internal/PerformerRootReconcilerClientImpl.js";

const directive = {
  protocolVersion: 1 as const, requestId: "request-1", rootDirectiveId: "directive-1",
  reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", basedOnTargetRootDigest: "root-1",
  rationale: "wait", evidenceRefs: [], consumedInputIds: [], commentReplies: [], humanActionResolutions: [],
  action: { kind: "wait" as const, reasonCode: "test", blockingFactRefs: [] },
};

test("root reconciler client owns session-to-root close correlation", async () => {
  const calls: Array<{ kind: string; rootIssueId?: string; sessionId?: string }> = [];
  const client = new PerformerRootReconcilerClientImpl({
    async openRootReconciler(input) {
      calls.push({ kind: "open", rootIssueId: input.rootIssueId });
      return { kind: "opened", sessionId: "session-1", bootstrapRootDigest: "root-1", initialDirective: directive };
    },
    async advanceRootReconciler(input) {
      calls.push({ kind: "advance", sessionId: input.sessionId });
      throw new Error("not exercised");
    },
    async closeRootReconciler(input) {
      calls.push({ kind: "close", rootIssueId: input.rootIssueId, sessionId: input.sessionId });
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
  await client.close({ requestId: "request-2", sessionId: opened.sessionId });
  assert.deepEqual(calls, [
    { kind: "open", rootIssueId: "root-1" },
    { kind: "close", rootIssueId: "root-1", sessionId: "session-1" },
  ]);
  await assert.rejects(() => client.close({ requestId: "request-3", sessionId: "session-1" }), /root_reconciler_session_unknown/u);
});
