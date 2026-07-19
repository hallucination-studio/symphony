import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { bootstrapDevelopmentTokenInstallation } from "../dist/public/index.js";
import { SqlitePodiumStoreImpl } from "../dist/internal/storage/SqlitePodiumStoreImpl.js";
import { PodiumConductorServicesImpl } from "../dist/internal/composition/PodiumConductorServicesImpl.js";

test("podium.db persists only approved control-plane facts", async () => {
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
  store.saveRuntimeObservation({
    bindingId: "binding-1",
    status: "ready",
    observedAt: "2026-07-16T00:00:01Z",
    sanitizedSummary: "Ready",
    lastResolvedProjectId: "project-1",
  });
  const services = new PodiumConductorServicesImpl(store, {
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
  for (const [rootIssueId, occurredAt] of [
    ["root-1", "2026-07-16T00:00:02Z"],
    ["root-2", "2026-07-16T00:00:03Z"],
  ]) {
    await services.handle({
      kind: "conductor_runtime_report",
      binding_id: "binding-1",
      instance_id: "instance-1",
      status: "ready",
      active_root_issue_id: rootIssueId,
      occurred_at: occurredAt,
      sanitized_summary: "root_dependency_cycle",
    });
  }

  assert.equal(
    store.getLinearInstallation("installation-1")?.accessToken,
    "access-secret",
  );
  assert.equal(store.listProjects("installation-1").length, 1);
  assert.equal(
    store.getConductorBinding()?.repositoryContext.baseBranch,
    "main",
  );
  assert.equal(store.getRuntimeObservation("binding-1")?.status, "ready");
  assert.equal(
    store.getRootRuntimeObservation("binding-1", "root-1")?.sanitizedSummary,
    "root_dependency_cycle",
  );
  assert.equal(
    store.getRootRuntimeObservation("binding-1", "root-2")?.observedAt,
    "2026-07-16T00:00:03Z",
  );

  assert.deepEqual(store.listTableNames(), [
    "conductor_bindings",
    "linear_installations",
    "oauth_attempts",
    "project_catalog",
    "root_runtime_observations",
    "runtime_observations",
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
  const services = new PodiumConductorServicesImpl(store, {
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

  assert.equal(store.getRuntimeObservation("binding-1")?.status, "crashed");
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
  const result = await bootstrapDevelopmentTokenInstallation({
    databasePath,
    developmentToken: "development-secret",
    delegateActorId: "app-user-1",
    discoverOrganizationId: async (token) => {
      assert.equal(token, "development-secret");
      return "organization-1";
    },
  });

  assert.deepEqual(result, {
    installationId: "development-token:organization-1",
    organizationId: "organization-1",
  });
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
