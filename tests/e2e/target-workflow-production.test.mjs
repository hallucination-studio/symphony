import assert from "node:assert/strict";
import test from "node:test";

import { startTargetProductionBoundary } from "../../tools/e2e/target-workflow-production.mjs";

function dependencies(events) {
  return {
    async bootstrapInstallation(input) {
      events.push(["bootstrapInstallation", input]);
      return { installationId: "installation-1", organizationId: "organization-1" };
    },
    async savePodiumState(input) {
      events.push(["savePodiumState", input]);
    },
    async createPodiumOwner(input) {
      events.push(["createPodiumOwner", input]);
      return { handler: {}, close() { events.push(["podiumClose"]); } };
    },
    async startConductor(input) {
      events.push(["startConductor", input]);
      return {
        request() {},
        close() {
          events.push(["conductorClose"]);
          events.push(["podiumClose"]);
        },
      };
    },
    async provisionProfile(input) {
      events.push(["provisionProfile", {
        ...input,
        apiKey: `length:${input.apiKey.byteLength}`,
      }]);
      return { profileId: "profile-1", readiness: "ready", isActive: true };
    },
  };
}

test("target production boundary composes real boundary adapters without leaking setup state", async () => {
  const events = [];
  const runner = { marker: "runner" };
  const result = await startTargetProductionBoundary({
    developmentToken: "linear-development-token",
    codexApiKey: "codex-api-key",
    databasePath: "/tmp/podium.db",
    project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
    binding: {
      bindingId: "binding-1", conductorId: "conductor-1", conductorShortHash: "hash-1",
      repositoryHandle: "repository-1", repositoryRoot: "/tmp/repository", baseBranch: "main",
    },
    delegateActorId: "actor-1",
    environment: { SYMPHONY_INSTANCE_ID: "instance-1" },
    fetch: () => {},
    log: () => {},
    dependencies: dependencies(events),
    createRunner() {
      return runner;
    },
  });

  assert.deepEqual(Object.keys(result).sort(), ["close", "runner"]);
  assert.equal(result.runner, runner);
  assert.equal(events.map(([kind]) => kind).join(","), [
    "bootstrapInstallation", "savePodiumState", "createPodiumOwner", "startConductor", "provisionProfile",
  ].join(","));
  assert.equal(events.find(([kind]) => kind === "provisionProfile")[1].apiKey, "length:13");
  assert.equal(JSON.stringify(result).includes("linear-development-token"), false);
  await result.close();
  assert.deepEqual(events.slice(-2).map(([kind]) => kind), ["conductorClose", "podiumClose"]);
});

test("target production boundary cleans the Podium owner when Conductor startup fails", async () => {
  const events = [];
  await assert.rejects(
    startTargetProductionBoundary({
      developmentToken: "linear-development-token",
      codexApiKey: "codex-api-key",
      databasePath: "/tmp/podium.db",
      project: { projectId: "project-1", name: "Target", updatedAt: "2026-07-22T00:00:00Z" },
      binding: {
        bindingId: "binding-1", conductorId: "conductor-1", conductorShortHash: "hash-1",
        repositoryHandle: "repository-1", repositoryRoot: "/tmp/repository", baseBranch: "main",
      },
      delegateActorId: "actor-1",
      environment: { SYMPHONY_INSTANCE_ID: "instance-1" },
      fetch: () => {},
      log: () => {},
      dependencies: {
        ...dependencies(events),
        async startConductor() {
          events.push(["startConductor"]);
          throw new Error("conductor_start_failed");
        },
      },
    }),
    /conductor_start_failed/u,
  );
  assert.deepEqual(events.slice(-1).map(([kind]) => kind), ["podiumClose"]);
});
