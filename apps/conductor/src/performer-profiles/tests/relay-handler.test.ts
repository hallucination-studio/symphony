import assert from "node:assert/strict";
import test from "node:test";

import type { PerformerProfile } from "../api/PerformerProfileStoreInterface.js";
import { ConductorProfileRelayHandler } from "../internal/ConductorProfileRelayHandler.js";

test("Profile relay creates, reads, and activates one Conductor-owned Profile", async () => {
  const profiles: PerformerProfile[] = [];
  let activeProfileId: string | undefined;
  const handler = new ConductorProfileRelayHandler(
    "conductor-1",
    {
      async list() {
        return activeProfileId ? { profiles, activeProfileId } : { profiles };
      },
      async create(input) {
        const profile = { ...input, createdAt: input.now, updatedAt: input.now };
        profiles.push(profile);
        return profile;
      },
      async update() {
        throw new Error("unused");
      },
      async activate(profileId) {
        activeProfileId = profileId;
      },
      codexHome() {
        return "/not-read";
      },
    },
    {
      async status(profileId) {
        return { kind: "profile_status", profile_id: profileId, readiness: "ready" };
      },
      async startChatGptLogin() {
        throw new Error("unused");
      },
      async setApiKey() {
        throw new Error("unused");
      },
    },
    () => "2026-07-17T00:00:00.000Z",
    () => "profile-1",
  );

  const saved = await handler.handleRequest({
    kind: "create_profile",
    conductor_id: "conductor-1",
    display_name: "Default",
    backend_kind: "codex",
    authentication_method: "chatgpt",
    codex_turn_settings: {
      model: "gpt-5",
      reasoning_effort: "high",
      is_fast_mode_enabled: true,
    },
  });
  assert.equal((saved as { kind: string }).kind, "profile_saved");

  const activated = await handler.handleRequest({
    kind: "activate_profile",
    conductor_id: "conductor-1",
    profile_id: "profile-1",
  });
  assert.equal((activated as { profile: { is_active: boolean } }).profile.is_active, true);
});

test("Profile relay rejects a mismatched Conductor before touching Profiles", async () => {
  let listed = false;
  const handler = new ConductorProfileRelayHandler(
    "conductor-1",
    {
      async list() {
        listed = true;
        return { profiles: [] };
      },
    } as never,
    {} as never,
    () => "2026-07-17T00:00:00.000Z",
  );

  await assert.rejects(
    handler.handleRequest({
      kind: "get_profiles",
      conductor_id: "conductor-2",
    }),
    /profile_conductor_mismatch/,
  );
  assert.equal(listed, false);
});
