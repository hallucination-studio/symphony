import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createChildEnvironment } from "../../../tools/e2e/config.mjs";
import { startConductorHarness } from "../../../tools/e2e/conductor-harness.mjs";

const EVIDENCE_DEADLINE_MS = 300_000;

test("production Conductor completes its closed process boundary before agent admission", {
  timeout: EVIDENCE_DEADLINE_MS,
}, async () => {
  assert.equal(existsSync("apps/conductor/dist/main.js"), true, "build Conductor before running process evidence");
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-agent-boundary-"));
  const logs = [];
  const handler = {
    async handle(message) {
      if (message.body?.kind === "conductor_handshake") {
        return {
          ...message,
          body: {
            kind: "conductor_handshake_ack",
            binding_id: message.body.binding_id,
            instance_id: message.body.instance_id,
            observed_at: new Date().toISOString(),
          },
        };
      }
      if (message.body?.kind === "resolve_conductor_project") {
        return { ...message, body: { kind: "unbound" } };
      }
      throw new Error("unexpected_conductor_request");
    },
  };
  const environment = createChildEnvironment({ additions: {
    SYMPHONY_PRIVATE_IPC_FD: "3",
    SYMPHONY_INSTANCE_ID: "agent-boundary-instance",
    SYMPHONY_BINDING_ID: "agent-boundary-binding",
    SYMPHONY_CONDUCTOR_ID: "agent-boundary-conductor",
    SYMPHONY_CONDUCTOR_SHORT_HASH: "abc123def456",
    SYMPHONY_LINEAR_INSTALLATION_ID: "development-token:organization-1",
    SYMPHONY_ORGANIZATION_ID: "organization-1",
    SYMPHONY_REPOSITORY_HANDLE: "repository-1",
    SYMPHONY_REPOSITORY_ROOT: path.join(root, "repository"),
    SYMPHONY_BASE_BRANCH: "main",
    SYMPHONY_CONDUCTOR_DATA_ROOT: path.join(root, "conductor"),
    SYMPHONY_ROOT_DEADLINE_AT: new Date(Date.now() + EVIDENCE_DEADLINE_MS).toISOString(),
    SYMPHONY_CYCLE_DELAY_MS: "25",
  } });
  const harness = await startConductorHarness({
    podium: { handler, observeExit: () => {}, close: () => {} },
    executable: process.execPath,
    arguments: [path.resolve("apps/conductor/dist/main.js")],
    environment,
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000,
    log: (event) => logs.push(event),
  });

  try {
    assert.deepEqual(harness.observations[0], { kind: "conductor_handshake" });
    assert.deepEqual(
      await harness.waitForObservation((value) => value.kind === "resolve_conductor_project"),
      { kind: "resolve_conductor_project" },
    );
  } finally {
    await harness.close();
  }
  assert.equal(logs.some(({ event }) => event === "e2e_child_started" && event), true);
  assert.equal(logs.some(({ event }) => event === "e2e_child_exited"), true);
  assert.equal(logs.some(({ event }) => event === "e2e_child_failed"), false);
});
