import assert from "node:assert/strict";
import test from "node:test";

import {
  createE2EPodiumServiceComposition,
} from "../dist/e2e/index.js";

test("E2E composition keeps one client-credentials token in a shared in-memory Podium owner", async () => {
  const tokenRequests = [];
  const labels = [];
  const hostStarts = [];
  const composition = await createE2EPodiumServiceComposition({
    linearClientId: "client-id",
    linearClientSecret: "client-secret",
    projectSlugId: "8ab43179fb54",
    fetch: async (_url, init) => {
      tokenRequests.push(new URLSearchParams(init.body));
      return new Response(JSON.stringify({
        access_token: "app-access-token",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    createLinearSdk: (accessToken, organizationId) => {
      assert.equal(accessToken, "app-access-token");
      assert.equal(organizationId, "organization-1");
      return {
        async listProjects() {
          return {
            items: [{
              projectId: "project-1",
              organizationId,
              name: "renamed-project",
              slugId: "8ab43179fb54",
              updatedAt: "2026-07-17T00:00:00.000Z",
            }, {
              projectId: "project-2",
              organizationId,
              name: "other-project",
              slugId: "other-project-slug",
              updatedAt: "2026-07-17T00:00:00.000Z",
            }],
            pageInfo: { hasNextPage: false },
          };
        },
        async assignConductorProjectLabel(input) {
          labels.push(input);
        },
      };
    },
    discoverOrganizationId: async (accessToken) => {
      assert.equal(accessToken, "app-access-token");
      return "organization-1";
    },
  });
  const client = composition.createClientServices({
    async openLinearAuthorization() {
      throw new Error("E2E composition must not start browser OAuth");
    },
    async resolveRepository(repositoryHandle, baseBranch) {
      return {
        repositoryHandle,
        repositoryIdentity: "github.com/acme/e2e",
        repositoryDisplayName: "e2e",
        repositoryRoot: "/private/e2e",
        baseBranch,
      };
    },
    async startConductor(input) {
      hostStarts.push(input);
    },
    async stopConductor() {},
    async restartConductor() {},
    async relayProfile() {
      return { kind: "profiles", profiles: [] };
    },
  });

  const overview = await client.query({ kind: "get_desktop_overview" });
  assert.equal(overview.linear_connection.status, "connected");
  assert.deepEqual(overview.projects.map(({ project_id, name }) => ({
    project_id,
    name,
  })), [{ project_id: "project-1", name: "renamed-project" }]);
  assert.doesNotMatch(JSON.stringify(overview), /app-access-token|client-secret/);

  await client.command({
    kind: "create_conductor",
    project_id: "project-1",
    repository: {
      repository_handle: "repository-1",
      display_name: "e2e",
      base_branch: "main",
    },
  });
  const start = hostStarts[0];
  assert.equal(start.linearInstallationId, "e2e-linear-app");
  assert.equal(labels.length, 1);

  const handshake = await composition.conductorServices.handle({
    kind: "conductor_handshake",
    binding_id: start.bindingId,
    instance_id: "instance-1",
    conductor_id: start.conductorId,
    conductor_short_hash: start.conductorShortHash,
    linear_installation_id: start.linearInstallationId,
    organization_id: start.organizationId,
    repository: {
      repository_handle: "repository-1",
      canonical_path: "/private/e2e",
      base_branch: "main",
    },
  });
  assert.equal(handshake.status, "starting");

  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].get("grant_type"), "client_credentials");
  assert.equal(tokenRequests[0].has("refresh_token"), false);
  composition.close();
});

test("E2E composition rejects Project allowlist drift before creating services", async () => {
  await assert.rejects(
    createE2EPodiumServiceComposition({
      linearClientId: "client-id",
      linearClientSecret: "client-secret",
      projectSlugId: "8ab43179fb54",
      fetch: async () => new Response(JSON.stringify({
        access_token: "app-access-token",
        expires_in: 3600,
      }), { status: 200 }),
      discoverOrganizationId: async () => "organization-1",
      createLinearSdk: () => ({
        async listProjects() {
          return {
            items: [{
              projectId: "project-other",
              organizationId: "organization-1",
              name: "NOT-HELL",
              slugId: "other",
              updatedAt: "2026-07-17T00:00:00.000Z",
            }],
            pageInfo: { hasNextPage: false },
          };
        },
      }),
    }),
    /e2e_linear_project_not_allowlisted/,
  );
});
