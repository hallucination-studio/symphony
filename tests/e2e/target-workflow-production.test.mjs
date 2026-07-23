import assert from "node:assert/strict";
import test from "node:test";
import { LinearRequestObserverImpl } from "@symphony/podium";

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
  const observer = new LinearRequestObserverImpl();
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
    observer,
    dependencies: dependencies(events),
    createRunner() {
      return runner;
    },
  });

  assert.deepEqual(Object.keys(result).sort(), ["close", "restart", "runner"]);
  assert.equal(result.runner, runner);
  assert.equal(events.map(([kind]) => kind).join(","), [
    "bootstrapInstallation", "savePodiumState", "createPodiumOwner", "startConductor", "provisionProfile",
  ].join(","));
  assert.equal(events.find(([kind]) => kind === "provisionProfile")[1].apiKey, "length:13");
  assert.equal(events.find(([kind]) => kind === "bootstrapInstallation")[1].observeLinearRequest !== undefined, true);
  assert.equal(events.find(([kind]) => kind === "createPodiumOwner")[1].linearRequestObserver, observer);
  assert.equal(JSON.stringify(result).includes("linear-development-token"), false);
  await result.close();
  assert.deepEqual(events.slice(-2).map(([kind]) => kind), ["conductorClose", "podiumClose"]);
});

test("target production boundary bounds setup to five minutes when no deadline is provided", async () => {
  const events = [];
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
    now: () => 1_000,
    dependencies: {
      ...dependencies(events),
      async startConductor(input) {
        events.push(["startConductor", input]);
        return { close() {} };
      },
    },
    createRunner() { return {}; },
  });

  assert.equal(events.find(([kind]) => kind === "startConductor")[1].startupTimeoutMs, 300_000);
  await result.close();
});

test("target production boundary reports bootstrap requests to the shared observer", async () => {
  const observer = new LinearRequestObserverImpl();
  const events = [];
  const productionDependencies = dependencies(events);
  productionDependencies.bootstrapInstallation = async (input) => {
    input.observeLinearRequest({
      operation: "organization",
      correlationId: "bootstrap-1",
      durationMs: 1,
      status: 200,
    });
    return { installationId: "installation-1", organizationId: "organization-1" };
  };

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
    observer,
    dependencies: productionDependencies,
    createRunner() { return { marker: "runner" }; },
  });

  assert.equal(observer.snapshot().physicalRequests, 1);
  await result.close();
});

test("target production boundary aborts shared resources on a real 429", async () => {
  const events = [];
  const observer = new LinearRequestObserverImpl();
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
    observer,
    dependencies: {
      ...dependencies(events),
      async startConductor(input) {
        events.push(["startConductor", input]);
        return {
          abortSignal: input.abortSignal,
          async terminateAbruptly() { events.push(["terminate"]); },
          async close() { events.push(["conductorClose"]); },
        };
      },
    },
    createRunner() { return { marker: "runner" }; },
  });

  observer.observe({ status: 429 });
  assert.equal(events.find(([kind]) => kind === "startConductor")[1].abortSignal.aborted, true);
  assert.equal(events.some(([kind]) => kind === "terminate"), true);
  assert.equal(events.some(([kind]) => kind === "podiumClose"), true);
  await result.close();
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

test("target production boundary restarts Conductor with a fresh secret-free instance", async () => {
  const events = [];
  let starts = 0;
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
    environment: { SYMPHONY_INSTANCE_ID: "instance-1", PATH: "/usr/bin" },
    fetch: () => {},
    log: () => {},
    dependencies: {
      ...dependencies(events),
      async startConductor(input) {
        starts += 1;
        events.push(["startConductor", input]);
        return {
          async terminateAbruptly() { events.push(["terminate", input.environment.SYMPHONY_INSTANCE_ID]); return { signal: "SIGKILL" }; },
          close() { events.push(["conductorClose", input.environment.SYMPHONY_INSTANCE_ID]); },
        };
      },
    },
    createRunner() { return { marker: "runner" }; },
  });

  const restart = await result.restart({
    rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "plan-1",
    actionId: "action-1", contextDigest: "a".repeat(64),
  });
  assert.deepEqual(restart, { restarted: true, instanceId: "instance-1-restart-1" });
  assert.equal(starts, 2);
  assert.equal(events.at(-1)[1].SYMPHONY_E2E_LINEAR_DEV_TOKEN, undefined);
  assert.equal(events.at(-1)[1].SYMPHONY_E2E_CODEX_API_KEY, undefined);
  await result.close();
  assert.deepEqual(events.filter(([kind]) => kind === "terminate"), [["terminate", "instance-1"]]);
  assert.deepEqual(events.filter(([kind]) => kind === "conductorClose"), [["conductorClose", "instance-1-restart-1"]]);
});

test("target production boundary aborts Conductor when profile provisioning reaches its deadline", async () => {
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
      deadlineAtMs: Date.now() + 20,
      dependencies: {
        ...dependencies(events),
        async startConductor() {
          return {
            async terminateAbruptly() { events.push(["terminate"]); },
            async close() { events.push(["conductorClose"]); },
          };
        },
        async provisionProfile() { return new Promise(() => {}); },
      },
    }),
    /target_live_timeout/u,
  );
  assert.equal(events.some(([kind]) => kind === "terminate"), true);
});
