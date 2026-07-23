import assert from "node:assert/strict";
import test from "node:test";

import type { SerializedPerformerProcessRunnerInterface } from "../../performer-profiles/internal/SerializedPerformerProcessRunnerImpl.js";
import type { RootReconcilerOpenInput } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { SessionPerformerAgentClientImpl } from "../internal/SessionPerformerAgentClientImpl.js";

test("agent client sends the closed direct OpenRootReconcilerRequest", async () => {
  const calls: Parameters<SerializedPerformerProcessRunnerInterface["run"]>[0][] = [];
  const runner: SerializedPerformerProcessRunnerInterface = {
    async run(input) {
      calls.push(input);
      return {
        stdout: JSON.stringify({
          protocol_version: "1",
          request_id: "request-1",
          kind: "root_reconciler_opened",
          root_issue_id: "root-1",
          reconciler_session_id: "session-1",
        }) + "\n",
        stderr: "",
      };
    },
    async cancelAndReap() {},
  };
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({ CODEX_HOME: "/tmp/profile" }),
    lane: runner,
    deadlineMs: 30_000,
  });
  const input: RootReconcilerOpenInput = {
    protocolVersion: 1,
    requestId: "request-1",
    rootIssueId: "root-1",
    profileId: "profile-1",
    modelSettings: { model: "gpt", reasoningEffort: "medium", isFastModeEnabled: false },
  };

  assert.deepEqual(await client.openRootReconciler(input), { kind: "opened", sessionId: "session-1" });
  assert.equal(calls.length, 1);
  const sent = JSON.parse(Buffer.from(calls[0]?.stdin ?? "").toString("utf8").trim()) as Record<string, unknown>;
  assert.equal(sent.protocol_version, "1");
  assert.equal(sent.kind, "open_root_reconciler");
  assert.equal("payload" in sent, false);
  assert.equal(sent.root_issue_id, "root-1");
  assert.equal(sent.performer_profile_id, "profile-1");
});
