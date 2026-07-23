import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createChildEnvironment } from "../../tools/e2e/config.mjs";
import {
  createProductionPodiumConductorOwner,
  startConductorHarness,
} from "../../tools/e2e/conductor-harness.mjs";

test("production harness observes a real Conductor handshake and shuts down boundedly", {
  skip: !existsSync("packages/podium/dist/internal/storage/SqlitePodiumStoreImpl.js") ||
    !existsSync("apps/conductor/dist/main.js"),
}, async () => {
  const logs = [];
  const { SqlitePodiumStoreImpl } = await import(
    "../../packages/podium/dist/internal/storage/SqlitePodiumStoreImpl.js"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-core-harness-"));
  const databasePath = path.join(root, "podium.db");
  const repositoryRoot = path.join(root, "repository");
  const store = new SqlitePodiumStoreImpl(databasePath);
  store.saveLinearInstallation({
    kind: "development_token",
    installationId: "development-token:organization-1",
    organizationId: "organization-1",
    delegateActorId: "app-user-1",
    accessToken: "test-only-token",
  });
  store.saveConductorBinding({
    bindingId: "binding-1",
    conductorId: "conductor-1",
    conductorShortHash: "abc123def456",
    linearInstallationId: "development-token:organization-1",
    organizationId: "organization-1",
    repositoryContext: {
      repositoryHandle: "repository-1",
      repositoryIdentity: "repository-1",
      repositoryDisplayName: "repository",
      repositoryRoot,
      baseBranch: "main",
    },
    desiredState: "running",
  });
  store.close();

  const podium = await createProductionPodiumConductorOwner({ databasePath });
  const environment = createChildEnvironment({
    additions: {
      SYMPHONY_PRIVATE_IPC_FD: "3",
      SYMPHONY_INSTANCE_ID: "instance-1",
      SYMPHONY_BINDING_ID: "binding-1",
      SYMPHONY_CONDUCTOR_ID: "conductor-1",
      SYMPHONY_CONDUCTOR_SHORT_HASH: "abc123def456",
      SYMPHONY_LINEAR_INSTALLATION_ID: "development-token:organization-1",
      SYMPHONY_ORGANIZATION_ID: "organization-1",
      SYMPHONY_REPOSITORY_HANDLE: "repository-1",
      SYMPHONY_REPOSITORY_ROOT: repositoryRoot,
      SYMPHONY_BASE_BRANCH: "main",
      SYMPHONY_CONDUCTOR_DATA_ROOT: path.join(root, "conductor"),
      SYMPHONY_CYCLE_DELAY_MS: "1000",
    },
  });
  const harness = await startConductorHarness({
    podium,
    environment,
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
    log: (event) => logs.push(event),
  });

  assert.deepEqual(harness.observations[0], { kind: "conductor_handshake" });
  assert.equal(JSON.stringify(environment).includes("test-only-token"), false);
  await harness.close();
  assert.equal(logs.some(({ event }) => event === "e2e_child_started"), true);
  assert.equal(logs.some(({ event }) => event === "e2e_child_exited"), true);
  assert.equal(logs.some(({ event }) => event === "e2e_child_failed"), false);
  assert.deepEqual(logs.filter(({ event }) => event === "e2e_podium_response_error"), []);
  assert.equal(JSON.stringify(logs).includes("test-only-token"), false);
});

test("real Conductor reports ready with an unbound generated-protocol result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-unbound-harness-"));
  const environment = createChildEnvironment({ additions: {
    SYMPHONY_PRIVATE_IPC_FD: "3",
    SYMPHONY_INSTANCE_ID: "instance-1",
    SYMPHONY_BINDING_ID: "binding-1",
    SYMPHONY_CONDUCTOR_ID: "conductor-1",
    SYMPHONY_CONDUCTOR_SHORT_HASH: "abc123def456",
    SYMPHONY_LINEAR_INSTALLATION_ID: "development-token:organization-1",
    SYMPHONY_ORGANIZATION_ID: "organization-1",
    SYMPHONY_REPOSITORY_HANDLE: "repository-1",
    SYMPHONY_REPOSITORY_ROOT: path.join(root, "repository"),
    SYMPHONY_BASE_BRANCH: "main",
    SYMPHONY_CONDUCTOR_DATA_ROOT: path.join(root, "conductor"),
    SYMPHONY_CYCLE_DELAY_MS: "1000",
  } });
  const handler = {
    async handle(message) {
      const body = message.body;
      let result;
      if (body.kind === "resolve_conductor_project") {
        result = { kind: "unbound" };
      } else {
        result = {
          kind: "conductor_runtime_report",
          binding_id: "binding-1",
          instance_id: "instance-1",
          status: body.status ?? (body.kind === "conductor_handshake" ? "starting" : "ready"),
          observed_at: new Date().toISOString(),
        };
      }
      return { ...message, body: result };
    },
  };
  const harness = await startConductorHarness({
    podium: {
      handler,
      observeExit: () => {},
      close: () => {},
    },
    environment,
    executable: process.execPath,
    arguments: ["--import", "tsx", path.resolve("apps/conductor/src/main.ts")],
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
  });

  const observation = await harness.waitForObservation(
    (value) => value.kind === "conductor_runtime_report",
  );
  assert.deepEqual(observation, {
    kind: "conductor_runtime_report",
    status: "recovering",
    sanitizedSummary: "project_unbound",
  });
  await harness.close();
});

test("real Conductor can be restarted after an abrupt process exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-restart-harness-"));
  const requests = [];
  const handler = {
    async handle(message) {
      requests.push(message.body?.kind);
      const body = message.body;
      let result;
      if (body.kind === "resolve_conductor_project") {
        result = { kind: "unbound" };
      } else {
        result = {
          kind: "conductor_runtime_report",
          binding_id: body.binding_id ?? "binding-1",
          instance_id: body.instance_id ?? "instance-1",
          status: body.status ?? "recovering",
          observed_at: new Date().toISOString(),
          ...(body.status === "blocked" ? { sanitized_summary: body.sanitized_reason ?? "blocked" } : {}),
        };
      }
      return { ...message, body: result };
    },
  };
  const podium = { handler, observeExit: () => {}, close: () => {} };
  const environment = (instanceId) => createChildEnvironment({ additions: {
    SYMPHONY_PRIVATE_IPC_FD: "3",
    SYMPHONY_INSTANCE_ID: instanceId,
    SYMPHONY_BINDING_ID: "binding-1",
    SYMPHONY_CONDUCTOR_ID: "conductor-1",
    SYMPHONY_CONDUCTOR_SHORT_HASH: "abc123def456",
    SYMPHONY_LINEAR_INSTALLATION_ID: "development-token:organization-1",
    SYMPHONY_ORGANIZATION_ID: "organization-1",
    SYMPHONY_REPOSITORY_HANDLE: "repository-1",
    SYMPHONY_REPOSITORY_ROOT: path.join(root, "repository"),
    SYMPHONY_BASE_BRANCH: "main",
    SYMPHONY_CONDUCTOR_DATA_ROOT: path.join(root, "conductor"),
    SYMPHONY_CYCLE_DELAY_MS: "1000",
  } });

  const first = await startConductorHarness({
    podium,
    environment: environment("instance-1"),
    executable: process.execPath,
    arguments: ["--import", "tsx", path.resolve("apps/conductor/src/main.ts")],
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
  });
  await first.waitForObservation((value) => value.kind === "conductor_runtime_report");
  const firstExit = await first.terminateAbruptly();
  assert.equal(firstExit.signal, "SIGKILL");

  const second = await startConductorHarness({
    podium,
    environment: environment("instance-2"),
    executable: process.execPath,
    arguments: ["--import", "tsx", path.resolve("apps/conductor/src/main.ts")],
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
  });
  assert.deepEqual(second.observations[0], { kind: "conductor_handshake" });
  await second.waitForObservation((value) => value.kind === "conductor_runtime_report");
  assert.ok(requests.filter((kind) => kind === "conductor_handshake").length >= 2);
  const secondExit = await second.terminateAbruptly();
  assert.equal(secondExit.signal, "SIGKILL");
});

test("harness rejects Linear and Codex token environment variables before spawn", async () => {
  await assert.rejects(
    startConductorHarness({
      podium: {},
      environment: { SYMPHONY_E2E_LINEAR_DEV_TOKEN: "secret" },
      spawnProcess: () => { throw new Error("must_not_spawn"); },
    }),
    /conductor_environment_secret_forbidden/u,
  );
});

test("harness terminates a child blocked on a failed inbound handler", async () => {
  const logs = [];
  const script = [
    "const fs = require('node:fs');",
    "const channel = fs.createWriteStream(null, { fd: 3 });",
    "channel.write(JSON.stringify({ protocol_version: '1', request_id: 'handshake', body: { kind: 'conductor_handshake' } }) + '\\n');",
    "setTimeout(() => channel.write(JSON.stringify({ protocol_version: '1', request_id: 'failed', body: { kind: 'fail_request' } }) + '\\n'), 10);",
  ].join("\n");
  const harness = await startConductorHarness({
    podium: {
      handler: {
        async handle(message) {
          if (message.body?.kind === "fail_request") throw new Error("linear_test_failure");
          return { kind: "conductor_handshake" };
        },
      },
      observeExit: () => {},
      close: () => {},
    },
    environment: createChildEnvironment(),
    executable: process.execPath,
    arguments: ["-e", script],
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 500,
    log: (event) => logs.push(event),
  });

  await assert.rejects(
    harness.request({ kind: "parent_request" }),
    /conductor_protocol_failed/u,
  );
  await harness.close();
  assert.equal(logs.some(({ event, reason }) => event === "e2e_child_failed" && reason === "conductor_protocol_failed"), true);
});

test("harness kills and closes a child when observation times out", async () => {
  const logs = [];
  let podiumClosed = 0;
  const script = [
    "const fs = require('node:fs');",
    "const channel = fs.createWriteStream(null, { fd: 3 });",
    "channel.write(JSON.stringify({ protocol_version: '1', request_id: 'handshake', body: { kind: 'conductor_handshake' } }) + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const harness = await startConductorHarness({
    podium: {
      handler: {
        async handle(message) {
          return { ...message, body: {
            kind: "conductor_runtime_report",
            binding_id: "binding-1",
            instance_id: "instance-1",
            status: "starting",
            observed_at: new Date().toISOString(),
          } };
        },
      },
      observeExit: () => {},
      close: () => { podiumClosed += 1; },
    },
    environment: createChildEnvironment(),
    executable: process.execPath,
    arguments: ["-e", script],
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: (event) => logs.push(event),
  });

  try {
    await assert.rejects(
      harness.waitForObservation(() => false, 20),
      /conductor_observation_timeout/u,
    );
    await waitFor(() => logs.some(({ event }) => event === "e2e_child_exited"), 500);
    assert.equal(podiumClosed, 1);
  } finally {
    await harness.terminateAbruptly();
  }
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test_wait_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
