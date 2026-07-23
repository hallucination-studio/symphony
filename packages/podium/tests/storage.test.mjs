import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { bootstrapDevelopmentTokenInstallation } from "../dist/public/index.js";
import { SqlitePodiumStoreImpl } from "../dist/internal/storage/SqlitePodiumStoreImpl.js";
import { PodiumConductorServicesImpl } from "../dist/internal/composition/PodiumConductorServicesImpl.js";
import { ConductorPresenceImpl } from "../dist/internal/conductor-presence/ConductorPresenceImpl.js";

test("podium.db excludes transient Conductor presence and workflow observations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-podium-"));
  const store = new SqlitePodiumStoreImpl(path.join(directory, "podium.db"));

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
    name: "V1",
    updatedAt: "2026-07-16T00:00:00Z",
  });
  store.saveConductorBinding({
    bindingId: "binding-1",
    conductorId: "conductor-1",
    conductorShortHash: "abc123",
    linearInstallationId: "installation-1",
    organizationId: "organization-1",
    repositoryContext: {
      repositoryHandle: "repo-handle-1",
      repositoryIdentity: "repo-1",
      repositoryDisplayName: "symphony",
      repositoryRoot: "/private/repository",
      baseBranch: "main",
    },
    desiredState: "running",
  });
  const presence = new ConductorPresenceImpl();
  const services = new PodiumConductorServicesImpl(store, presence, {
    now: () => "2026-07-16T00:00:04Z",
    sleep: async () => undefined,
    createLinearSdk: () => { throw new Error("unused"); },
  });
  await services.handle({
    kind: "conductor_handshake",
    binding_id: "binding-1",
    instance_id: "instance-1",
    conductor_id: "conductor-1",
    conductor_short_hash: "abc123",
    linear_installation_id: "installation-1",
    organization_id: "organization-1",
    repository: {
      repository_handle: "repo-handle-1",
      canonical_path: "/private/repository",
      base_branch: "main",
    },
  });
  assert.equal(
    store.getLinearInstallation("installation-1")?.accessToken,
    "access-secret",
  );
  assert.equal(store.listProjects("installation-1").length, 1);
  assert.equal(
    store.getConductorBinding()?.repositoryContext.baseBranch,
    "main",
  );
  assert.equal(presence.snapshot("binding-1")?.presence, "online");
  assert.equal(presence.recentLogs("binding-1").length, 0);

  store.saveConductorBinding({
    bindingId: "binding-2",
    conductorId: "conductor-2",
    conductorShortHash: "def456",
    linearInstallationId: "installation-1",
    organizationId: "organization-1",
    repositoryContext: {
      repositoryHandle: "repo-handle-2",
      repositoryIdentity: "repo-2",
      repositoryDisplayName: "symphony-2",
      repositoryRoot: "/private/repository-2",
      baseBranch: "main",
    },
    desiredState: "running",
  });
  await services.handle({
    kind: "conductor_handshake",
    binding_id: "binding-2",
    instance_id: "instance-2",
    conductor_id: "conductor-2",
    conductor_short_hash: "def456",
    linear_installation_id: "installation-1",
    organization_id: "organization-1",
    repository: {
      repository_handle: "repo-handle-2",
      canonical_path: "/private/repository-2",
      base_branch: "main",
    },
  });
  services.observeExit({
    bindingId: "binding-1",
    instanceId: "instance-1",
    observedAt: "2026-07-16T00:00:06Z",
    sanitizedReason: "conductor_process_exited",
  });
  assert.equal(presence.snapshot("binding-1")?.presence, "offline");
  assert.equal(presence.snapshot("binding-2")?.presence, "online");

  assert.deepEqual(store.listTableNames(), [
    "conductor_bindings",
    "linear_installations",
    "oauth_attempts",
    "project_catalog",
  ]);

  store.close();
});

test("Host can acknowledge a Conductor exit before its handshake", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-podium-exit-"));
  const store = new SqlitePodiumStoreImpl(path.join(directory, "podium.db"));
  store.saveLinearInstallation({
    kind: "oauth",
    installationId: "installation-1",
    organizationId: "organization-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2026-07-17T00:00:00Z",
  });
  store.saveConductorBinding({
    bindingId: "binding-1",
    conductorId: "conductor-1",
    conductorShortHash: "abc123",
    linearInstallationId: "installation-1",
    organizationId: "organization-1",
    repositoryContext: {
      repositoryHandle: "repo-handle-1",
      repositoryIdentity: "repo-1",
      repositoryDisplayName: "symphony",
      repositoryRoot: "/private/repository",
      baseBranch: "main",
    },
    desiredState: "running",
  });
  const presence = new ConductorPresenceImpl();
  const services = new PodiumConductorServicesImpl(store, presence, {
    now: () => "2026-07-17T00:00:00Z",
    sleep: async () => undefined,
    createLinearSdk: () => {
      throw new Error("unused");
    },
  });

  services.observeExit({
    bindingId: "binding-1",
    instanceId: "instance-before-handshake",
    observedAt: "2026-07-17T00:00:01Z",
    sanitizedReason: "conductor_process_exited",
  });

  assert.equal(presence.snapshot("binding-1")?.presence, "offline");
  await services.handle({
    kind: "conductor_handshake",
    binding_id: "binding-1",
    instance_id: "active-instance",
    conductor_id: "conductor-1",
    conductor_short_hash: "abc123",
    linear_installation_id: "installation-1",
    organization_id: "organization-1",
    repository: {
      repository_handle: "repo-handle-1",
      canonical_path: "/private/repository",
      base_branch: "main",
    },
  });
  assert.throws(
    () =>
      services.observeExit({
        bindingId: "binding-1",
        instanceId: "stale-instance",
        observedAt: "2026-07-17T00:00:02Z",
      }),
    /conductor_exit_observation_mismatch/,
  );
  store.close();
});

test("development-token installation persists without OAuth placeholders", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-podium-dev-token-"));
  const databasePath = path.join(directory, "podium.db");
  const observations = [];
  const result = await bootstrapDevelopmentTokenInstallation({
    databasePath,
    developmentToken: "development-secret",
    delegateActorId: "app-user-1",
    observeLinearRequest: (observation) => observations.push(observation),
    discoverOrganizationId: async (token, observe) => {
      assert.equal(token, "development-secret");
      observe({
        operation: "LinearOrganization",
        correlationId: "request-1",
        durationMs: 5,
        status: 200,
        requestWindow: { limit: 1000, remaining: 999, reset: 60 },
        complexityWindow: { limit: 250000, remaining: 249900, reset: 60 },
      });
      return "organization-1";
    },
  });

  assert.deepEqual(result, {
    installationId: "development-token:organization-1",
    organizationId: "organization-1",
  });
  assert.deepEqual(observations, [{
    operation: "LinearOrganization",
    correlationId: "request-1",
    durationMs: 5,
    status: 200,
    requestWindow: { limit: 1000, remaining: 999, reset: 60 },
    complexityWindow: { limit: 250000, remaining: 249900, reset: 60 },
  }]);
  const store = new SqlitePodiumStoreImpl(databasePath);
  assert.deepEqual(store.getOnlyLinearInstallation(), {
    kind: "development_token",
    installationId: "development-token:organization-1",
    organizationId: "organization-1",
    delegateActorId: "app-user-1",
    accessToken: "development-secret",
  });
  store.close();
});

test("legacy OAuth installation schema migrates without losing credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-podium-migration-"));
  const databasePath = path.join(directory, "podium.db");
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE linear_installations (
      installation_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    INSERT INTO linear_installations VALUES (
      'installation-1', 'organization-1', 'access-secret',
      'refresh-secret', '2026-07-17T00:00:00Z'
    );
  `);
  database.close();

  const store = new SqlitePodiumStoreImpl(databasePath);
  assert.deepEqual(store.getLinearInstallation("installation-1"), {
    kind: "oauth",
    installationId: "installation-1",
    organizationId: "organization-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "2026-07-17T00:00:00Z",
  });
  store.saveLinearInstallation({
    kind: "development_token",
    installationId: "development-token:organization-1",
    organizationId: "organization-1",
    delegateActorId: "app-user-1",
    accessToken: "development-secret",
  });
  store.close();
});

test("development-token bootstrap fails closed with sanitized errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-podium-invalid-token-"));
  const secret = "invalid-development-secret";
  await assert.rejects(
    bootstrapDevelopmentTokenInstallation({
      databasePath: path.join(directory, "podium.db"),
      developmentToken: secret,
      delegateActorId: "app-user-1",
      discoverOrganizationId: async () => { throw new Error(secret); },
    }),
    (error) => error.message === "linear_development_token_invalid" &&
      !error.message.includes(secret),
  );
});
