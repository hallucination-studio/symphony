import assert from "node:assert/strict";
import test from "node:test";

import { provisionConductorBindings } from "../../tools/e2e/podium-control-plane.mjs";
import { provisionParallelBlackBoxE2EControlPlane } from "../../tools/e2e/parallel-black-box-control-plane.mjs";

test("public control-plane Binding creation sends the complete RepositorySelection contract", async () => {
  const requests = [];
  const values = repositories();

  await provisionConductorBindings({
    projectId: "project-1",
    repositories: values,
    client: {
      async command(body) {
        requests.push(body);
        return {
          kind: "conductor_created",
          ...conductor(body.repository.repository_handle.slice(-1)),
        };
      },
    },
  });

  assert.deepEqual(requests.map((request) => request.repository), values.map((repository) => ({
    repository_handle: repository.repository_handle,
    display_name: repository.repository_display_name,
    base_branch: repository.base_branch,
  })));
});

test("public control-plane serializes Binding creation against the shared Project pool", async () => {
  const calls = [];
  let releaseFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });

  const provisioning = provisionConductorBindings({
    projectId: "project-1",
    repositories: repositories(),
    client: {
      async command(body) {
        calls.push(body);
        if (calls.length === 1) {
          firstStartedResolve();
          await firstReleased;
        }
        return {
          kind: "conductor_created",
          ...conductor(body.repository.repository_handle.slice(-1)),
        };
      },
    },
  });

  await firstStarted;
  await Promise.resolve();
  assert.equal(calls.length, 1);
  releaseFirst();
  await provisioning;
  assert.equal(calls.length, 3);
});

test("parallel black-box control plane bootstraps the target Project before releasing all starts", async () => {
  const events = [];
  const client = clientPort(events);
  const physicalRequestGate = { async beforePhysicalRequest() {} };
  const controlPlane = await provisionParallelBlackBoxE2EControlPlane({
    config: configuration(),
    runtime: { ...runtime(), linearPhysicalRequestGate: physicalRequestGate },
    sourceRepositoryRoot: "/source",
    provisionRepositories: repositoryPool(events),
    podium: podium(events, { finalUpdatedAt: "2026-07-25T00:00:01.000Z" }),
    createProcessHost({ repositories: receivedRepositories, startProcess }) {
      events.push("process-host");
      assert.deepEqual(receivedRepositories, repositories());
      assert.equal(typeof startProcess, "function");
      return {
        host: {
          kind: "host",
          async restartConductor(conductorId) { events.push(`restart:${conductorId}`); },
        },
        async close() { events.push("host-close"); },
      };
    },
    createProcessStarter(input) {
      events.push("process-starter");
      assert.equal(input.codexBaseUrl, "https://codex.example.test");
      assert.deepEqual(input.convergencePolicy, convergencePolicy());
      assert.equal(input.linearPhysicalRequestGate, physicalRequestGate);
      return async () => ({ request() {}, close() {} });
    },
    async createPodiumClient(input) {
      events.push("podium-client");
      assert.equal(input.linearClientId, "client-id");
      assert.equal(input.linearClientSecret, "client-secret");
      return { command: client.command, async close() { events.push("client-close"); } };
    },
  });

  assert.deepEqual(controlPlane, {
    project_id: "project-1",
    conductors: [
      conductor("a"),
      conductor("b"),
      conductor("c"),
    ],
    repository_contexts: repositories().map(({ repository_identity, repository_root, base_branch }) => ({
      repository_identity,
      repository_root,
      base_branch,
    })),
    restartConductor: controlPlane.restartConductor,
    close: controlPlane.close,
  });
  assert.deepEqual(events.slice(0, 3), ["repositories", "setup:workflow", "bootstrap"]);
  assert.equal(events.indexOf("setup:workflow:2") > events.indexOf("create:repo-c"), true);
  assert.equal(events.indexOf("start:conductor-a") > events.indexOf("setup:workflow:2"), true);
  assert.equal(events.indexOf("profile:conductor-a") > events.indexOf("start:conductor-c"), true);

  await controlPlane.restartConductor("conductor-b");
  await assert.rejects(controlPlane.restartConductor("conductor-foreign"), /parallel_black_box_control_plane_restart_invalid/u);
  assert.equal(events.includes("restart:conductor-b"), true);

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
    }),
    /parallel_black_box_control_plane_repositories_invalid/u,
  );
  assert.equal(setupCalls, 0);
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
    }),
    /podium_client_create_failed/u,
  );
  assert.deepEqual(events.slice(-2), ["host-close", "repositories-close"]);
});

test("parallel black-box control plane reports a closed Binding provisioning failure", async () => {
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
      async createPodiumClient() {
        return {
          async command() {
            const error = new Error("remote failure with private input");
            error.code = "e2e_podium_client_conductor_project_invalid";
            throw error;
          },
          async close() { events.push("client-close"); },
        };
      },
    }),
    (error) => error.code === "parallel_black_box_control_plane_binding_project_invalid" &&
      !error.message.includes("private input"),
  );
  assert.deepEqual(events.slice(-2), ["client-close", "repositories-close"]);
});

test("parallel black-box control plane preserves the API-key Profile phase without provider detail", async () => {
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
      async createPodiumClient() {
        return {
          async command(body) {
            if (body.kind === "create_conductor") return {
              kind: "conductor_created",
              ...conductor(body.repository.repository_handle.slice(-1)),
            };
            if (body.kind === "start_conductor") {
              return { kind: "conductor_command_completed", conductor_id: body.conductor_id, command_kind: body.kind };
            }
            if (body.kind === "create_performer_profile") return profile(body.conductor_id, "login-required", false);
            if (body.kind === "set_codex_api_key") {
              throw new Error("provider rejected private API-key material");
            }
            throw new Error(`unexpected_command:${body.kind}`);
          },
          async close() { events.push("client-close"); },
        };
      },
    }),
    (error) => error.code === "parallel_black_box_control_plane_profile_set_api_key_failed" &&
      !error.message.includes("private API-key material"),
  );
  assert.deepEqual(events.slice(-2), ["client-close", "repositories-close"]);
});

test("parallel black-box control plane preserves a closed Project pool routing failure", async () => {
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
      async createPodiumClient() {
        return {
          async command() {
            const error = new Error("untrusted detail");
            error.code = "e2e_podium_client_linear_project_pool_root_routing_conflict";
            throw error;
          },
          async close() { events.push("client-close"); },
        };
      },
    }),
    (error) => error.code === "parallel_black_box_control_plane_binding_project_pool_routing_conflict" &&
      !error.message.includes("untrusted detail"),
  );
  assert.deepEqual(events.slice(-2), ["client-close", "repositories-close"]);
});

test("parallel black-box control plane preserves a closed Project label creation failure", async () => {
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
      async createPodiumClient() {
        return {
          async command() {
            const error = new Error("untrusted provider detail");
            error.code = "e2e_podium_client_linear_project_label_create_failed";
            throw error;
          },
          async close() { events.push("client-close"); },
        };
      },
    }),
    (error) => error.code === "parallel_black_box_control_plane_binding_project_label_failed" &&
      !error.message.includes("untrusted provider detail"),
  );
  assert.deepEqual(events.slice(-2), ["client-close", "repositories-close"]);
});

test("parallel black-box control plane preserves a shared label organization mismatch", async () => {
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
      async createPodiumClient() {
        return {
          async command() {
            const error = new Error("untrusted provider detail");
            error.code = "e2e_podium_client_linear_label_organization_mismatch";
            throw error;
          },
          async close() { events.push("client-close"); },
        };
      },
    }),
    (error) => error.code === "parallel_black_box_control_plane_binding_label_organization_mismatch" &&
      !error.message.includes("untrusted provider detail"),
  );
  assert.deepEqual(events.slice(-2), ["client-close", "repositories-close"]);
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
      linearHumanApiKey: "human-token",
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
    convergencePolicy: convergencePolicy(),
    environment: { HOME: "/tmp/home", PATH: "/usr/bin" },
  };
}

function convergencePolicy() {
  return {
    maxCyclesPerRoot: 3,
    maxSameOpenFindingCycles: 2,
    maxConsecutiveNoProgress: 2,
    maxTotalTokens: 10_000,
    maxCycleRepairAttempts: 0,
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
  finalUpdatedAt,
} = {}) {
  return {
    createTargetWorkflowSetup() {
      let calls = 0;
      return {
        async initialize(input) {
          calls += 1;
          events.push(`setup:workflow${calls === 1 ? "" : `:${calls}`}`);
          assert.deepEqual(Object.keys(input).sort(), [
            "authorized",
            "clientId",
            "developmentToken",
            "projectSlugId",
          ]);
          return setupResult({
            members: calls === 1 || incompletePool
              ? ["abcdef000001"]
              : ["abcdef000001", "a".repeat(12), "b".repeat(12), "c".repeat(12)],
            updatedAt: calls === 1 ? undefined : finalUpdatedAt,
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
    projectPool: { members: members ?? [] },
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
