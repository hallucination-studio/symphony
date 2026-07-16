import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SqlitePodiumStoreImpl } from "../dist/internal/storage/SqlitePodiumStoreImpl.js";

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
