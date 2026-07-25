import assert from "node:assert/strict";
import test from "node:test";

import { provisionParallelBlackBoxE2EControlPlane } from "../../tools/e2e/parallel-black-box-control-plane.mjs";

test("parallel black-box control plane bootstraps the target Project before releasing all starts", async () => {
  const events = [];
  const client = clientPort(events);
  const controlPlane = await provisionParallelBlackBoxE2EControlPlane({
    config: configuration(),
    runtime: runtime(),
    sourceRepositoryRoot: "/source",
    provisionRepositories: repositoryPool(events),
    podium: podium(events, { finalUpdatedAt: "2026-07-25T00:00:01.000Z" }),
    createProcessHost({ repositories: receivedRepositories, startProcess }) {
      events.push("process-host");
      assert.deepEqual(receivedRepositories, repositories());
      assert.equal(typeof startProcess, "function");
      return { host: { kind: "host" }, async close() { events.push("host-close"); } };
    },
    createProcessStarter(input) {
      events.push("process-starter");
      assert.equal(input.codexBaseUrl, "https://codex.example.test");
      return async () => ({ request() {}, close() {} });
    },
    async createPodiumClient(input) {
      events.push("podium-client");
      assert.equal(input.linearClientId, "client-id");
      assert.equal(input.linearClientSecret, "client-secret");
      return { command: client.command, async close() { events.push("client-close"); } };
    },
    createSetupShortHash: () => "012345abcdef",
  });

  assert.deepEqual(controlPlane, {
    project_id: "project-1",
    conductors: [
      conductor("a"),
      conductor("b"),
      conductor("c"),
    ],
    close: controlPlane.close,
  });
  assert.deepEqual(events.slice(0, 3), ["repositories", "setup:temporary", "bootstrap"]);
  assert.equal(events.indexOf("setup:pool") > events.indexOf("create:repo-c"), true);
  assert.equal(events.indexOf("start:conductor-a") > events.indexOf("setup:pool"), true);
  assert.equal(events.indexOf("profile:conductor-a") > events.indexOf("start:conductor-c"), true);

  await controlPlane.close();
  assert.deepEqual(events.slice(-2), ["client-close", "repositories-close"]);
});

test("parallel black-box control plane closes the public client when target Project pool read-back is incomplete", async () => {
  const events = [];
  await assert.rejects(
    provisionParallelBlackBoxE2EControlPlane({
      config: configuration(),
      runtime: runtime(),
      sourceRepositoryRoot: "/source",
      provisionRepositories: repositoryPool(events),
      podium: podium(events, { incompletePool: true }),
      createProcessHost() {
        return { host: {}, async close() { events.push("host-close"); } };
      },
      createProcessStarter: () => async () => ({ request() {}, close() {} }),
      async createPodiumClient() {
        const client = clientPort(events);
        return { command: client.command, async close() { events.push("client-close"); } };
      },
      createSetupShortHash: () => "012345abcdef",
    }),
    /parallel_black_box_control_plane_pool_read_back_invalid/u,
  );
  assert.deepEqual(events.slice(-2), ["client-close", "repositories-close"]);
  assert.equal(events.includes("start:conductor-a"), false);
});

test("parallel black-box control plane rejects invalid repository contexts before target Project setup", async () => {
  const events = [];
  let setupCalls = 0;
  await assert.rejects(
    provisionParallelBlackBoxE2EControlPlane({
      config: configuration(),
      runtime: runtime(),
      sourceRepositoryRoot: "/source",
      provisionRepositories: repositoryPool(events, [{ ...repositories()[0], repository_root: "" }, ...repositories().slice(1)]),
      podium: {
        createTargetWorkflowSetup() {
          setupCalls += 1;
          return { initialize() { throw new Error("not_called"); } };
        },
        async bootstrapDevelopmentTokenInstallation() { throw new Error("not_called"); },
      },
      createSetupShortHash: () => "012345abcdef",
    }),
    /parallel_black_box_control_plane_repositories_invalid/u,
  );
  assert.equal(setupCalls, 0);
});

test("parallel black-box control plane rejects a temporary setup hash that collides with a Binding", async () => {
  const events = [];
  await assert.rejects(
    provisionParallelBlackBoxE2EControlPlane({
      config: configuration(),
      runtime: runtime(),
      sourceRepositoryRoot: "/source",
      provisionRepositories: repositoryPool(events),
      podium: podium(events, { temporaryHash: "a".repeat(12) }),
      createProcessHost() {
        return { host: {}, async close() { events.push("host-close"); } };
      },
      createProcessStarter: () => async () => ({ request() {}, close() {} }),
      async createPodiumClient() {
        const client = clientPort(events);
        return { command: client.command, async close() { events.push("client-close"); } };
      },
      createSetupShortHash: () => "a".repeat(12),
    }),
    /parallel_black_box_control_plane_setup_hash_collision/u,
  );
  assert.equal(events.includes("setup:pool"), false);
  assert.equal(events.includes("start:conductor-a"), false);
  assert.deepEqual(events.slice(-2), ["client-close", "repositories-close"]);
});

test("parallel black-box control plane closes its process host when public client construction fails", async () => {
  const events = [];
  await assert.rejects(
    provisionParallelBlackBoxE2EControlPlane({
      config: configuration(),
      runtime: runtime(),
      sourceRepositoryRoot: "/source",
      provisionRepositories: repositoryPool(events),
      podium: podium(events),
      createProcessHost() {
        return { host: {}, async close() { events.push("host-close"); } };
      },
      createProcessStarter: () => async () => ({ request() {}, close() {} }),
      async createPodiumClient() { throw new Error("podium_client_create_failed"); },
      createSetupShortHash: () => "012345abcdef",
    }),
    /podium_client_create_failed/u,
  );
  assert.deepEqual(events.slice(-2), ["host-close", "repositories-close"]);
});

function configuration() {
  return {
    linear: {
      clientId: "client-id",
      projectSlugId: "project-slug",
      setupAuthorized: true,
    },
    secrets: {
      linearDevToken: "linear-token",
      linearHumanToken: "human-token",
      linearClientSecret: "client-secret",
      codexApiKey: "codex-secret",
    },
    codex: {
      baseUrl: "https://codex.example.test",
      model: "gpt-5-codex",
    },
  };
}

function runtime() {
  return {
    databasePath: "/tmp/podium.db",
    conductorDataRoot: "/tmp/conductors",
    performerExecutable: "/tmp/performer",
    rootDeadlineAt: "2026-07-25T00:05:00.000Z",
    environment: { HOME: "/tmp/home", PATH: "/usr/bin" },
  };
}

function repositories() {
  return ["a", "b", "c"].map((suffix) => ({
    repository_handle: `repo-${suffix}`,
    repository_identity: `repository-${suffix}`,
    repository_display_name: `Repository ${suffix.toUpperCase()}`,
    repository_root: `/tmp/repository-${suffix}`,
    base_branch: "main",
  }));
}

function repositoryPool(events, values = repositories()) {
  return async ({ sourceRepositoryRoot }) => {
    assert.equal(sourceRepositoryRoot, "/source");
    events.push("repositories");
    return {
      repositories: values,
      async close() { events.push("repositories-close"); },
    };
  };
}

function conductor(suffix) {
  return {
    binding_id: `binding-${suffix}`,
    conductor_id: `conductor-${suffix}`,
    conductor_short_hash: `${suffix.repeat(12)}`,
    repository_identity: `repository-${suffix}`,
  };
}

function podium(events, {
  incompletePool = false,
  temporaryHash = "012345abcdef",
  finalUpdatedAt,
} = {}) {
  return {
    createTargetWorkflowSetup() {
      return {
        async initialize(input) {
          if (input.conductorShortHashes === undefined) {
            events.push("setup:temporary");
            assert.equal(input.conductorShortHash, temporaryHash);
            return setupResult();
          }
          events.push("setup:pool");
          assert.deepEqual(input.conductorShortHashes, ["a".repeat(12), "b".repeat(12), "c".repeat(12)]);
          assert.equal(input.conductorShortHash, "a".repeat(12));
          return setupResult({
            members: incompletePool ? ["a".repeat(12)] : input.conductorShortHashes,
            updatedAt: finalUpdatedAt,
          });
        },
      };
    },
    async bootstrapDevelopmentTokenInstallation(input) {
      events.push("bootstrap");
      assert.deepEqual(input.targetProject, {
        projectId: "project-1",
        name: "E2E Project",
        updatedAt: "2026-07-25T00:00:00.000Z",
      });
      assert.equal(input.delegateActorId, "delegate-actor");
      return { installationId: "development-token:organization-1", organizationId: "organization-1" };
    },
  };
}

function setupResult({ members, updatedAt = "2026-07-25T00:00:00.000Z" } = {}) {
  return {
    kind: "ready",
    organizationId: "organization-1",
    delegateActorId: "delegate-actor",
    project: {
      projectId: "project-1",
      name: "E2E Project",
      updatedAt,
    },
    teamId: "team-1",
    todoStateId: "todo-1",
    workflow: "already_applied",
    projectLabel: "applied",
    projectPool: { members: members ?? [] },
    resolution: { kind: "resolved", projectId: "project-1", updatedAt },
    identityDigest: "digest-1",
  };
}

function clientPort(events) {
  return {
    async command(body) {
      if (body.kind === "create_conductor") {
        events.push(`create:${body.repository.repository_handle}`);
        return {
          kind: "conductor_created",
          ...conductor(body.repository.repository_handle.slice(-1)),
        };
      }
      if (body.kind === "start_conductor") {
        events.push(`start:${body.conductor_id}`);
        return { kind: "conductor_command_completed", conductor_id: body.conductor_id, command_kind: body.kind };
      }
      if (body.kind === "create_performer_profile") {
        events.push(`profile:${body.conductor_id}`);
        return profile(body.conductor_id, "login-required", false);
      }
      if (body.kind === "set_codex_api_key") return profile(body.conductor_id, "ready", false);
      if (body.kind === "activate_performer_profile") return profile(body.conductor_id, "ready", true);
      throw new Error(`unexpected_command:${body.kind}`);
    },
  };
}

function profile(conductorId, readiness, isActive) {
  return {
    profile_id: `profile-${conductorId.slice(-1)}`,
    readiness,
    is_active: isActive,
  };
}
