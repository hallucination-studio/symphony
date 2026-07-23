import assert from "node:assert/strict";
import test from "node:test";

import { PerformerRootReconcilerClientImpl } from "../internal/PerformerRootReconcilerClientImpl.js";

test("root reconciler client owns session-to-root close correlation", async () => {
  const calls: Array<{ kind: string; rootIssueId?: string; sessionId?: string }> = [];
  const client = new PerformerRootReconcilerClientImpl({
    async openRootReconciler(input) {
      calls.push({ kind: "open", rootIssueId: input.rootIssueId });
      return { kind: "opened", sessionId: "session-1" };
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
  });
  await client.close({ requestId: "request-2", sessionId: opened.sessionId });
  assert.deepEqual(calls, [
    { kind: "open", rootIssueId: "root-1" },
    { kind: "close", rootIssueId: "root-1", sessionId: "session-1" },
  ]);
  await assert.rejects(() => client.close({ requestId: "request-3", sessionId: "session-1" }), /root_reconciler_session_unknown/u);
});
