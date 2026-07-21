import assert from "node:assert/strict";
import test from "node:test";

import { PerformerProfileControlProcessImpl } from "../internal/PerformerProfileControlProcessImpl.js";
import type { SerializedPerformerProcessRunnerInterface } from "../internal/SerializedPerformerProcessRunnerImpl.js";

test("Profile control uses the isolated CODEX_HOME and clears API Key frames", async () => {
  let invocation: Parameters<SerializedPerformerProcessRunnerInterface["run"]>[0] | undefined;
  const secret = new Uint8Array([11, 22, 33]);
  const control = new PerformerProfileControlProcessImpl(
    {
      async run(value) {
        invocation = value;
        return {
          stdout: `${JSON.stringify({
            protocol_version: "1",
            request_id: "profile-api-key-profile-1",
            profile_id: "profile-1",
            kind: "login_succeeded",
          })}\n`,
          stderr: "",
        };
      },
    },
    { codexHome: () => "/isolated/profile-1" },
    {
      executable: "performer",
      environment: () => ({ SAFE: "1" }),
      deadlineMs: 1_000,
    },
  );

  const result = await control.setApiKey("profile-1", secret);

  assert.equal(result.kind, "login_succeeded");
  assert.equal(invocation?.environment?.CODEX_HOME, "/isolated/profile-1");
  assert.deepEqual([...secret], [0, 0, 0]);
  assert.doesNotMatch(JSON.stringify(result), /11|22|33/);
});

test("Profile control rejects a mismatched result", async () => {
  const control = new PerformerProfileControlProcessImpl(
    {
      async run() {
        return {
          stdout: `${JSON.stringify({
            protocol_version: "1",
            request_id: "wrong-request",
            profile_id: "profile-1",
            kind: "profile_status",
            readiness: "ready",
          })}\n`,
          stderr: "",
        };
      },
    },
    { codexHome: () => "/isolated/profile-1" },
    { executable: "performer", environment: () => ({}), deadlineMs: 1_000 },
  );

  await assert.rejects(control.status("profile-1"), /profile_control_correlation_mismatch/);
});
