import assert from "node:assert/strict";
import test from "node:test";

import { createProductionE2EProcessStarter } from "../../tools/e2e/podium-production-starter.mjs";

test("production E2E process starter passes only non-secret runtime configuration to the Conductor", async () => {
  const calls = [];
  const startProcess = createProductionE2EProcessStarter({
    databasePath: "/tmp/podium.db",
    conductorDataRoot: "/tmp/conductor",
    performerExecutable: "/tmp/performer",
    codexBaseUrl: "https://codex.example.test",
    rootDeadlineAt: "2026-07-25T00:05:00.000Z",
    environment: {
      HOME: "/tmp/home",
      PATH: "/usr/bin",
      SYMPHONY_E2E_LINEAR_DEV_TOKEN: "linear-secret",
      SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "human-secret",
      LINEAR_CLIENT_SECRET: "client-secret",
      SYMPHONY_E2E_CODEX_API_KEY: "codex-secret",
    },
  }, {
    async createPodiumOwner(input) {
      calls.push({ kind: "owner", input });
      return { handler: {}, close() {} };
    },
    async startHarness(input) {
      calls.push({ kind: "harness", input });
      return { request() {}, close() {} };
    },
    createInstanceId: () => "instance-1",
  });

  await startProcess({
    bindingId: "binding-a",
    conductorId: "conductor-a",
    conductorShortHash: "hash-a",
    linearInstallationId: "installation-a",
    organizationId: "organization-a",
    repositoryHandle: "repo-a",
    repositoryRoot: "/tmp/repository-a",
    baseBranch: "main",
  });

  const environment = calls[1].input.environment;
  assert.equal(environment.SYMPHONY_INSTANCE_ID, "instance-1");
  assert.equal(environment.SYMPHONY_CONDUCTOR_ID, "conductor-a");
  assert.equal(environment.SYMPHONY_REPOSITORY_ROOT, "/tmp/repository-a");
  assert.equal(environment.SYMPHONY_CODEX_BASE_URL, "https://codex.example.test");
  assert.equal(environment.SYMPHONY_E2E_LINEAR_DEV_TOKEN, undefined);
  assert.equal(environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, undefined);
  assert.equal(environment.LINEAR_CLIENT_SECRET, undefined);
  assert.equal(environment.SYMPHONY_E2E_CODEX_API_KEY, undefined);
});

test("production E2E process starter closes its Podium owner when the Conductor cannot start", async () => {
  let closes = 0;
  const startProcess = createProductionE2EProcessStarter(runtimeInput(), {
    async createPodiumOwner() {
      return { handler: {}, close() { closes += 1; } };
    },
    async startHarness() { throw new Error("conductor_start_failed"); },
    createInstanceId: () => "instance-1",
  });

  await assert.rejects(startProcess(conductorInput()), /conductor_start_failed/u);
  assert.equal(closes, 1);
});

function runtimeInput() {
  return {
    databasePath: "/tmp/podium.db",
    conductorDataRoot: "/tmp/conductor",
    performerExecutable: "/tmp/performer",
    codexBaseUrl: "https://codex.example.test",
    rootDeadlineAt: "2026-07-25T00:05:00.000Z",
    environment: { HOME: "/tmp/home", PATH: "/usr/bin" },
  };
}

function conductorInput() {
  return {
    bindingId: "binding-a",
    conductorId: "conductor-a",
    conductorShortHash: "hash-a",
    linearInstallationId: "installation-a",
    organizationId: "organization-a",
    repositoryHandle: "repo-a",
    repositoryRoot: "/tmp/repository-a",
    baseBranch: "main",
  };
}
