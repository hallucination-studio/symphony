import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverCurrentRoots } from "../../root-discovery/MultiRootDiscoveryPolicy.js";
import { FilePerformerProfileStoreImpl } from "../../performer-profiles/internal/FilePerformerProfileStoreImpl.js";

test("Root discovery returns every owned or delegated current Root without selecting one", () => {
  const candidate = {
    issueId: "root-1", identifier: "SYM-1", state: "In Progress" as const,
    title: "Build it", description: "Follow the approved architecture.", updatedAt: "2026-07-16T00:00:00Z",
    projectId: "project-1", parentIssueId: null, isDelegatedToSymphony: true,
    priority: "normal" as const, order: 1, blockers: [],
  };
  assert.deepEqual(discoverCurrentRoots({
    projectId: "project-1",
    roots: [
      candidate,
      { ...candidate, issueId: "root-owned", isDelegatedToSymphony: false, managedConductorId: "conductor-1" },
      { ...candidate, issueId: "root-other-project", projectId: "project-2" },
      { ...candidate, issueId: "root-descendant", parentIssueId: "parent-1" },
      { ...candidate, issueId: "root-done", state: "Done" },
      { ...candidate, issueId: "root-undelegated", isDelegatedToSymphony: false },
      { ...candidate, issueId: "root-owned-elsewhere", managedConductorId: "conductor-2" },
    ],
    conductorId: "conductor-1",
  }), [candidate, {
    ...candidate, issueId: "root-owned", isDelegatedToSymphony: false, managedConductorId: "conductor-1",
  }]);
});

test("Profile store atomically preserves fixed authentication and activates only ready Profiles", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "symphony-profiles-"));
  const store = new FilePerformerProfileStoreImpl(dataRoot);
  const created = await store.create({
    profileId: "profile-1", displayName: "Primary", backendKind: "codex", authenticationMethod: "api_key",
    codexTurnSettings: { model: "codex-model", reasoningEffort: "medium", isFastModeEnabled: false },
    now: "2026-07-16T00:00:00Z",
  });
  await assert.rejects(store.update({
    profileId: created.profileId, displayName: "Changed",
    codexTurnSettings: { model: "codex-model", reasoningEffort: "medium", isFastModeEnabled: true },
    now: "2026-07-16T00:01:00Z",
  }), /api_key_fast_unavailable/);
  await assert.rejects(store.activate("profile-1", "login-required"), /profile_not_ready/);
  await store.activate("profile-1", "ready");

  const persisted = JSON.parse(await readFile(path.join(dataRoot, "performer-profiles", "profiles.json"), "utf8"));
  assert.equal(persisted.activeProfileId, "profile-1");
  assert.equal("apiKey" in persisted.profiles[0], false);
});
