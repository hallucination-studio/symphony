import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SqlitePodiumStoreImpl } from "../dist/internal/storage/SqlitePodiumStoreImpl.js";
import { PodiumConductorServicesImpl } from "../dist/internal/composition/PodiumConductorServicesImpl.js";

test("podium.db persists only approved control-plane facts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-podium-"));
  const store = new SqlitePodiumStoreImpl(path.join(directory, "podium.db"));

  store.saveLinearInstallation({
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

  assert.deepEqual(store.listTableNames(), [
    "conductor_bindings",
    "linear_installations",
    "oauth_attempts",
    "project_catalog",
    "runtime_observations",
  ]);

  store.close();
});

test("Host can acknowledge a Conductor exit before its handshake", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-podium-exit-"));
  const store = new SqlitePodiumStoreImpl(path.join(directory, "podium.db"));
  store.saveLinearInstallation({
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
