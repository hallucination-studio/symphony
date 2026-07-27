import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LinearAuthImpl } from "../dist/internal/linear-auth/LinearAuthImpl.js";
import { ConductorBindingUseCase } from "../dist/internal/conductor-bindings/ConductorBindingUseCase.js";
import { PodiumClientServicesImpl } from "../dist/internal/composition/PodiumClientServicesImpl.js";
import { ConductorPresenceImpl } from "../dist/internal/conductor-presence/ConductorPresenceImpl.js";
import { ProjectCatalogUseCase } from "../dist/internal/project-catalog/ProjectCatalogUseCase.js";
import { SqlitePodiumStoreImpl } from "../dist/internal/storage/SqlitePodiumStoreImpl.js";

async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-podium-"));
  return new SqlitePodiumStoreImpl(path.join(directory, "podium.db"));
}

test("OAuth completion consumes state once and persists credentials only in Podium", async () => {
  const store = await createStore();
  const tokenClient = {
    async exchangeAuthorizationCode(input) {
      assert.equal(input.authorizationCode, "authorization-code");
      assert.equal(input.codeVerifier, "verifier");
      return {
        kind: "oauth",
        installationId: "installation-1",
        organizationId: "organization-1",
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        expiresAt: "2026-07-17T00:00:00Z",
      };
    },
    async refresh() {
      throw new Error("not used");
    },
  };
  const auth = new LinearAuthImpl(store, tokenClient, {
    createId: () => "attempt-1",
    createSecret: () => "verifier",
    createState: () => "state-1",
    now: () => "2026-07-16T00:00:00Z",
  });

  const attempt = auth.start();
  assert.deepEqual(attempt, {
    attemptId: "attempt-1",
    state: "state-1",
    codeChallenge: "iMnq5o6zALKXGivsnlom_0F5_WYda32GHkxlV7mq7hQ",
  });

  const view = await auth.complete({
    state: "state-1",
    authorizationCode: "authorization-code",
  });
  assert.deepEqual(view, {
    status: "connected",
    workspaceName: "organization-1",
    observedAt: "2026-07-16T00:00:00Z",
  });
  assert.equal(store.getLinearInstallation("installation-1")?.accessToken, "access-secret");

  await assert.rejects(
    auth.complete({ state: "state-1", authorizationCode: "replay" }),
    /oauth_state_invalid/,
  );
  store.close();
});

test("development-token installations never enter the OAuth refresh flow", async () => {
  const store = await createStore();
  store.saveLinearInstallation({
    kind: "development_token",
    installationId: "development-token:organization-1",
    organizationId: "organization-1",
    delegateActorId: "app-user-1",
    accessToken: "development-secret",
  });
  let refreshCalls = 0;
  const auth = new LinearAuthImpl(store, {
    async exchangeAuthorizationCode() { throw new Error("unused"); },
    async refresh() { refreshCalls += 1; throw new Error("must_not_run"); },
  }, {
    createId: () => "unused",
    createSecret: () => "unused",
    createState: () => "unused",
    now: () => "2026-07-16T00:00:00Z",
  });

  await assert.rejects(
    auth.refresh("development-token:organization-1"),
    /linear_installation_refresh_unsupported/u,
  );
  assert.equal(refreshCalls, 0);
  store.close();
});

test("Project catalog consumes every SDK page", async () => {
  const store = await createStore();
  store.saveLinearInstallation({
    kind: "oauth",
    installationId: "installation-1",
    organizationId: "organization-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2026-07-17T00:00:00Z",
  });
  store.saveProject({
    projectId: "stale-project",
    installationId: "installation-1",
    organizationId: "organization-1",
    name: "Removed",
    updatedAt: "2026-07-15T00:00:00Z",
  });
  const client = {
    async listProjects({ cursor }) {
      return cursor
        ? {
            items: [
              {
                projectId: "project-2",
                organizationId: "organization-1",
                name: "Two",
                updatedAt: "2026-07-16T00:00:01Z",
              },
            ],
            pageInfo: { hasNextPage: false },
          }
        : {
            items: [
              {
                projectId: "project-1",
                organizationId: "organization-1",
                name: "One",
                updatedAt: "2026-07-16T00:00:00Z",
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "next" },
          };
    },
  };

  const projects = await new ProjectCatalogUseCase(store, client).refresh(
    "installation-1",
  );
  assert.deepEqual(
    projects.map(({ projectId }) => projectId),
    ["project-1", "project-2"],
  );
  store.close();
});

test("Binding creation rejects a legacy label-only client", async () => {
  const store = await createStore();
  assert.throws(
    () => new ConductorBindingUseCase(store, {
      async assignConductorProjectLabel() {},
    }, {
      createBindingId: () => "binding-1",
      createConductorId: () => "conductor-1",
    }),
    /linear_project_pool_client_invalid/u,
  );
  store.close();
});

test("Binding creation allows multiple Conductors to join one Project pool", async () => {
  const store = await createStore();
  store.saveLinearInstallation({
    kind: "oauth",
    installationId: "installation-1",
    organizationId: "organization-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2026-07-17T00:00:00Z",
  });
  store.saveProject({
    projectId: "project-1",
    installationId: "installation-1",
    organizationId: "organization-1",
    name: "One",
    updatedAt: "2026-07-16T00:00:00Z",
  });
  const desiredMemberSets = [];
  let members = [];
  let sequence = 0;
  const client = {
    async readConductorProjectPool({ projectId }) {
      return { projectId, updatedAt: "2026-07-16T00:00:00Z", members: [...members] };
    },
    async preflightConductorProjectPool({ projectId, desiredMembers }) {
      desiredMemberSets.push([...desiredMembers]);
      return {
        kind: "ready",
        projectId,
        expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
        fingerprint: `pool-${desiredMemberSets.length}`,
        currentMembers: [...members],
        desiredMembers: [...desiredMembers],
        addMembers: desiredMembers.filter((member) => !members.includes(member)),
        removeMembers: [],
        routeRoots: [],
      };
    },
    async reconcileConductorProjectPool({ plan, authorized }) {
      assert.equal(authorized, true);
      members = [...plan.desiredMembers];
      return {
        kind: "applied",
        projectId: plan.projectId,
        fingerprint: plan.fingerprint,
        members: [...members],
      };
    },
  };
  const useCase = new ConductorBindingUseCase(store, client, {
    createBindingId: () => `binding-${++sequence}`,
    createConductorId: () => `conductor-${++sequence}`,
  });
  const repositoryContext = {
    repositoryHandle: "repo-handle-1",
    repositoryIdentity: "repo-1",
    repositoryDisplayName: "symphony",
    repositoryRoot: "/private/repository",
    baseBranch: "main",
  };

  const binding = await useCase.create({
    installationId: "installation-1",
    projectId: "project-1",
    repositoryContext,
  });
  assert.equal(binding.conductorShortHash.length, 12);
  assert.deepEqual(desiredMemberSets, [[binding.conductorShortHash]]);

  const second = await useCase.create({
    installationId: "installation-1",
    projectId: "project-1",
    repositoryContext,
  });
  assert.notEqual(second.conductorShortHash, binding.conductorShortHash);
  assert.equal(store.listConductorBindings().length, 2);
  assert.deepEqual(desiredMemberSets, [
    [binding.conductorShortHash],
    [binding.conductorShortHash, second.conductorShortHash],
  ]);
  assert.deepEqual(members, desiredMemberSets.at(-1));
  store.close();
});

test("creating a Conductor initializes the Team before extending its Project pool", async () => {
  const events = [];
  const installation = {
    kind: "oauth",
    installationId: "installation-1",
    organizationId: "organization-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2026-07-17T00:00:00Z",
  };
  const project = {
    projectId: "project-1",
    installationId: "installation-1",
    organizationId: "organization-1",
    name: "Project",
    updatedAt: "2026-07-16T00:00:00Z",
  };
  let binding;
  const store = {
    getOnlyLinearCredential: () => installation,
    getLinearCredential: (installationId) => installationId === installation.installationId ? installation : undefined,
    getProject: (projectId) => projectId === project.projectId ? project : undefined,
    listConductorBindings: () => binding ? [binding] : [],
    getConductorBindingById: (bindingId) => binding?.bindingId === bindingId ? binding : undefined,
    saveConductorBinding: (value) => { binding = value; },
    setConductorDesiredState: (_bindingId, desiredState) => { binding.desiredState = desiredState; },
  };
  const host = {
    async resolveRepository() {
      return {
        repositoryHandle: "repo-handle-1",
        repositoryIdentity: "repository-1",
        repositoryDisplayName: "Repository",
        repositoryRoot: "/private/repository",
        baseBranch: "main",
      };
    },
    async startConductor(input) { events.push(["start", input.conductorId]); },
  };
  const sdk = {
    async initializeTargetTeamWorkflow(input) {
      events.push(["team", input]);
      return { kind: "already_applied", projectId: input.projectId, teamId: "team-1", canonicalStatuses: [], nativeDuplicate: {} };
    },
    async readConductorProjectPool(input) {
      events.push(["pool-read", input]);
      return { projectId: input.projectId, updatedAt: "2026-07-16T00:00:00Z", members: [] };
    },
    async preflightConductorProjectPool(input) {
      events.push(["pool-preflight", input]);
      return {
        kind: "ready",
        projectId: input.projectId,
        expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
        fingerprint: "pool-1",
        currentMembers: [],
        desiredMembers: [...input.desiredMembers],
        addMembers: [...input.desiredMembers],
        removeMembers: [],
        routeRoots: [],
      };
    },
    async reconcileConductorProjectPool(input) {
      events.push(["pool-reconcile", input]);
      return {
        kind: "applied",
        projectId: input.plan.projectId,
        fingerprint: input.plan.fingerprint,
        members: [...input.plan.desiredMembers],
      };
    },
  };
  const services = new PodiumClientServicesImpl(
    store,
    new ConductorPresenceImpl(),
    {},
    {},
    host,
    () => "2026-07-16T00:00:00Z",
    () => sdk,
  );

  const created = await services.command({
    kind: "create_conductor",
    project_id: "project-1",
    repository: { repository_handle: "repo-handle-1", base_branch: "main" },
  });

  assert.deepEqual(events, [
    ["team", { projectId: "project-1", authorized: true }],
    ["pool-read", { projectId: "project-1" }],
    ["pool-preflight", { projectId: "project-1", desiredMembers: [binding.conductorShortHash] }],
    ["pool-reconcile", {
      plan: {
        kind: "ready",
        projectId: "project-1",
        expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
        fingerprint: "pool-1",
        currentMembers: [],
        desiredMembers: [binding.conductorShortHash],
        addMembers: [binding.conductorShortHash],
        removeMembers: [],
        routeRoots: [],
      },
      authorized: true,
    }],
  ]);
  assert.deepEqual(created, {
    kind: "conductor_created",
    conductor_id: binding.conductorId,
    binding_id: binding.bindingId,
    conductor_short_hash: binding.conductorShortHash,
    repository_identity: binding.repositoryContext.repositoryIdentity,
  });
  assert.equal(binding.desiredState, "stopped");

  await services.command({
    kind: "start_conductor",
    conductor_id: binding.conductorId,
  });
  assert.deepEqual(events.at(-1), ["start", binding.conductorId]);
  assert.equal(binding.desiredState, "running");
});

test("creating multiple Conductors reuses successful Project workflow initialization", async () => {
  const store = await createStore();
  store.saveLinearInstallation({
    kind: "oauth",
    installationId: "installation-1",
    organizationId: "organization-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2026-07-17T00:00:00Z",
  });
  store.saveProject({
    projectId: "project-1",
    installationId: "installation-1",
    organizationId: "organization-1",
    name: "Project",
    updatedAt: "2026-07-16T00:00:00Z",
  });

  let workflowInitializations = 0;
  let members = [];
  const client = {
    async initializeTargetTeamWorkflow() {
      workflowInitializations += 1;
      return { kind: "already_applied", projectId: "project-1", teamId: "team-1", canonicalStatuses: [], nativeDuplicate: {} };
    },
    async readConductorProjectPool({ projectId }) {
      return { projectId, updatedAt: "2026-07-16T00:00:00Z", members: [...members] };
    },
    async preflightConductorProjectPool({ projectId, desiredMembers }) {
      return {
        kind: "ready",
        projectId,
        expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
        fingerprint: desiredMembers.join(":"),
        currentMembers: [...members],
        desiredMembers: [...desiredMembers],
        addMembers: desiredMembers.filter((member) => !members.includes(member)),
        removeMembers: [],
        routeRoots: [],
      };
    },
    async reconcileConductorProjectPool({ plan }) {
      members = [...plan.desiredMembers];
      return {
        kind: "applied",
        projectId: plan.projectId,
        fingerprint: plan.fingerprint,
        members: [...members],
      };
    },
  };
  const services = new PodiumClientServicesImpl(
    store,
    new ConductorPresenceImpl(),
    {},
    {},
    {
      async resolveRepository(repositoryHandle, baseBranch) {
        return {
          repositoryHandle,
          repositoryIdentity: `${repositoryHandle}-identity`,
          repositoryDisplayName: repositoryHandle,
          repositoryRoot: `/private/${repositoryHandle}`,
          baseBranch,
        };
      },
    },
    () => "2026-07-16T00:00:00Z",
    () => client,
  );

  for (const repositoryHandle of ["repository-1", "repository-2"]) {
    await services.command({
      kind: "create_conductor",
      project_id: "project-1",
      repository: { repository_handle: repositoryHandle, base_branch: "main" },
    });
  }

  assert.equal(workflowInitializations, 1);
  assert.equal(store.listConductorBindings().length, 2);
  assert.equal(members.length, 2);
  store.close();
});

test("creating a Conductor retries failed Project workflow initialization", async () => {
  const store = await createStore();
  store.saveLinearInstallation({
    kind: "oauth",
    installationId: "installation-1",
    organizationId: "organization-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2026-07-17T00:00:00Z",
  });
  store.saveProject({
    projectId: "project-1",
    installationId: "installation-1",
    organizationId: "organization-1",
    name: "Project",
    updatedAt: "2026-07-16T00:00:00Z",
  });

  let initializationAttempts = 0;
  const client = {
    async initializeTargetTeamWorkflow() {
      initializationAttempts += 1;
      if (initializationAttempts === 1) throw new Error("temporary workflow initialization failure");
      return { kind: "already_applied", projectId: "project-1", teamId: "team-1", canonicalStatuses: [], nativeDuplicate: {} };
    },
    async readConductorProjectPool({ projectId }) {
      return { projectId, updatedAt: "2026-07-16T00:00:00Z", members: [] };
    },
    async preflightConductorProjectPool({ projectId, desiredMembers }) {
      return {
        kind: "ready",
        projectId,
        expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
        fingerprint: "pool-1",
        currentMembers: [],
        desiredMembers: [...desiredMembers],
        addMembers: [...desiredMembers],
        removeMembers: [],
        routeRoots: [],
      };
    },
    async reconcileConductorProjectPool({ plan }) {
      return {
        kind: "applied",
        projectId: plan.projectId,
        fingerprint: plan.fingerprint,
        members: [...plan.desiredMembers],
      };
    },
  };
  const services = new PodiumClientServicesImpl(
    store,
    new ConductorPresenceImpl(),
    {},
    {},
    {
      async resolveRepository(repositoryHandle, baseBranch) {
        return {
          repositoryHandle,
          repositoryIdentity: "repository-1",
          repositoryDisplayName: "Repository",
          repositoryRoot: "/private/repository",
          baseBranch,
        };
      },
    },
    () => "2026-07-16T00:00:00Z",
    () => client,
  );
  const command = {
    kind: "create_conductor",
    project_id: "project-1",
    repository: { repository_handle: "repository-1", base_branch: "main" },
  };

  await assert.rejects(
    services.command(command),
    (error) => error?.protocolError?.code === "conductor_target_workflow_initialization_failed",
  );
  await services.command(command);

  assert.equal(initializationAttempts, 2);
  assert.equal(store.listConductorBindings().length, 1);
  store.close();
});

test("creating a Conductor exposes stable sanitized failures for each external creation stage", async (t) => {
  const installation = {
    kind: "oauth",
    installationId: "installation-1",
    organizationId: "organization-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2026-07-17T00:00:00Z",
  };
  const project = {
    projectId: "project-1",
    installationId: "installation-1",
    organizationId: "organization-1",
    name: "Project",
    updatedAt: "2026-07-16T00:00:00Z",
  };
  const repositoryContext = {
    repositoryHandle: "repo-handle-1",
    repositoryIdentity: "repository-1",
    repositoryDisplayName: "Repository",
    repositoryRoot: "/private/repository",
    baseBranch: "main",
  };
  const scenarios = [
    {
      name: "repository resolution",
      expectedCode: "conductor_repository_resolution_failed",
      fail: "repository",
    },
    {
      name: "Team workflow initialization",
      expectedCode: "conductor_target_workflow_initialization_failed",
      fail: "workflow",
    },
    {
      name: "binding creation",
      expectedCode: "conductor_binding_creation_failed",
      fail: "binding",
    },
    {
      name: "initial desired state persistence",
      expectedCode: "conductor_initial_desired_state_persistence_failed",
      fail: "initial-state",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let binding;
      const store = {
        getOnlyLinearCredential: () => installation,
        getLinearCredential: (installationId) => installationId === installation.installationId ? installation : undefined,
        getProject: (projectId) => projectId === project.projectId ? project : undefined,
        listConductorBindings: () => {
          if (scenario.fail === "binding") throw new Error("binding store detail");
          return binding ? [binding] : [];
        },
        getConductorBindingById: () => undefined,
        saveConductorBinding: (value) => { binding = value; },
        setConductorDesiredState: (_bindingId, desiredState) => {
          if (scenario.fail === "initial-state" && desiredState === "stopped") {
            throw new Error("binding state store detail");
          }
          binding.desiredState = desiredState;
        },
      };
      const services = new PodiumClientServicesImpl(
        store,
        new ConductorPresenceImpl(),
        {},
        {},
        {
          async resolveRepository() {
            if (scenario.fail === "repository") throw new Error("repository host detail");
            return repositoryContext;
          },
        },
        () => "2026-07-16T00:00:00Z",
        () => ({
          async initializeTargetTeamWorkflow() {
            if (scenario.fail === "workflow") throw new Error("linear upstream detail");
            return { kind: "already_applied", projectId: "project-1", teamId: "team-1", canonicalStatuses: [], nativeDuplicate: {} };
          },
          async readConductorProjectPool() {
            return { projectId: "project-1", updatedAt: "2026-07-16T00:00:00Z", members: [] };
          },
          async preflightConductorProjectPool({ projectId, desiredMembers }) {
            return {
              kind: "ready",
              projectId,
              expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
              fingerprint: "pool-1",
              currentMembers: [],
              desiredMembers: [...desiredMembers],
              addMembers: [...desiredMembers],
              removeMembers: [],
              routeRoots: [],
            };
          },
          async reconcileConductorProjectPool({ plan }) {
            return {
              kind: "applied",
              projectId: plan.projectId,
              fingerprint: plan.fingerprint,
              members: [...plan.desiredMembers],
            };
          },
        }),
      );

      await assert.rejects(
        services.command({
          kind: "create_conductor",
          project_id: "project-1",
          repository: { repository_handle: "repo-handle-1", base_branch: "main" },
        }),
        (error) => error?.protocolError?.code === scenario.expectedCode &&
          error.protocolError.sanitizedReason === scenario.expectedCode,
      );
    });
  }
});

test("Binding creation persists one stopped intent and safely resumes Pool reconciliation", async () => {
  const store = await createStore();
  store.saveLinearInstallation({
    kind: "oauth",
    installationId: "installation-1",
    organizationId: "organization-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2026-07-17T00:00:00Z",
  });
  store.saveProject({
    projectId: "project-1",
    installationId: "installation-1",
    organizationId: "organization-1",
    name: "Project",
    updatedAt: "2026-07-16T00:00:00Z",
  });
  let attempts = 0;
  const useCase = new ConductorBindingUseCase(
    store,
    {
      async readConductorProjectPool({ projectId }) {
        return { projectId, updatedAt: "2026-07-16T00:00:00Z", members: [] };
      },
      async preflightConductorProjectPool({ projectId, desiredMembers }) {
        attempts += 1;
        if (attempts === 1) {
          return { kind: "blocked", projectId, reason: "project_roots_invalid" };
        }
        return {
          kind: "ready",
          projectId,
          expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
          fingerprint: "pool-1",
          currentMembers: [],
          desiredMembers: [...desiredMembers],
          addMembers: [...desiredMembers],
          removeMembers: [],
          routeRoots: [],
        };
      },
      async reconcileConductorProjectPool({ plan }) {
        return {
          kind: "applied",
          projectId: plan.projectId,
          fingerprint: plan.fingerprint,
          members: [...plan.desiredMembers],
        };
      },
    },
    {
      createBindingId: () => "binding-1",
      createConductorId: () => "conductor-1",
    },
  );
  const repositoryContext = {
    repositoryHandle: "repo-handle-1",
    repositoryIdentity: "repository-1",
    repositoryDisplayName: "Repository",
    repositoryRoot: "/private/repository",
    baseBranch: "main",
  };

  await assert.rejects(
    useCase.create({
      installationId: "installation-1",
      projectId: "project-1",
      repositoryContext,
    }),
    (error) => error?.protocolError?.code === "linear_project_pool_project_roots_invalid" &&
      error.protocolError.sanitizedReason === "linear_project_pool_project_roots_invalid",
  );
  assert.equal(store.listConductorBindings()[0]?.desiredState, "stopped");

  const recovered = await useCase.create({
    installationId: "installation-1",
    projectId: "project-1",
    repositoryContext,
  });
  assert.equal(recovered.bindingId, "binding-1");
  assert.equal(recovered.desiredState, "running");
  assert.equal(attempts, 2);
  store.close();
});

test("Binding creation preserves Linear rate limiting as a retryable failure", async () => {
  class RatelimitedLinearError extends Error {}

  const store = await createStore();
  store.saveLinearInstallation({
    kind: "oauth",
    installationId: "installation-1",
    organizationId: "organization-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2026-07-17T00:00:00Z",
  });
  store.saveProject({
    projectId: "project-1",
    installationId: "installation-1",
    organizationId: "organization-1",
    name: "Project",
    updatedAt: "2026-07-16T00:00:00Z",
  });
  const useCase = new ConductorBindingUseCase(
    store,
    {
      async readConductorProjectPool({ projectId }) {
        return { projectId, updatedAt: "2026-07-16T00:00:00Z", members: [] };
      },
      async preflightConductorProjectPool() {
        throw new RatelimitedLinearError("rate limit detail must not cross the boundary");
      },
      async reconcileConductorProjectPool() {
        throw new Error("unreachable");
      },
    },
    {
      createBindingId: () => "binding-1",
      createConductorId: () => "conductor-1",
    },
  );

  await assert.rejects(
    useCase.create({
      installationId: "installation-1",
      projectId: "project-1",
      repositoryContext: {
        repositoryHandle: "repository-1",
        repositoryIdentity: "repository-1",
        repositoryDisplayName: "Repository",
        repositoryRoot: "/private/repository",
        baseBranch: "main",
      },
    }),
    (error) => error?.protocolError?.code === "linear_rate_limited" &&
      error.protocolError.sanitizedReason === "Linear rate limit exceeded." &&
      error.protocolError.retryable === true &&
      error.protocolError.actionRequired === "retry_request",
  );
  assert.equal(store.listConductorBindings()[0]?.desiredState, "stopped");
  store.close();
});

test("Binding creation preserves unknown official Linear failures as retryable", async () => {
  class UnknownLinearError extends Error {}

  const store = await createStore();
  store.saveLinearInstallation({
    kind: "oauth",
    installationId: "installation-1",
    organizationId: "organization-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2026-07-17T00:00:00Z",
  });
  store.saveProject({
    projectId: "project-1",
    installationId: "installation-1",
    organizationId: "organization-1",
    name: "Project",
    updatedAt: "2026-07-16T00:00:00Z",
  });
  const useCase = new ConductorBindingUseCase(
    store,
    {
      async readConductorProjectPool({ projectId }) {
        return { projectId, updatedAt: "2026-07-16T00:00:00Z", members: [] };
      },
      async preflightConductorProjectPool() {
        throw new UnknownLinearError("upstream detail must not cross the boundary");
      },
      async reconcileConductorProjectPool() {
        throw new Error("unreachable");
      },
    },
    {
      createBindingId: () => "binding-1",
      createConductorId: () => "conductor-1",
    },
  );

  await assert.rejects(
    useCase.create({
      installationId: "installation-1",
      projectId: "project-1",
      repositoryContext: {
        repositoryHandle: "repository-1",
        repositoryIdentity: "repository-1",
        repositoryDisplayName: "Repository",
        repositoryRoot: "/private/repository",
        baseBranch: "main",
      },
    }),
    (error) => error?.protocolError?.code === "linear_unknown_failed" &&
      error.protocolError.sanitizedReason === "Linear request failed." &&
      error.protocolError.retryable === true &&
      error.protocolError.actionRequired === "retry_request",
  );
  assert.equal(store.listConductorBindings()[0]?.desiredState, "stopped");
  store.close();
});
