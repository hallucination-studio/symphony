import assert from "node:assert/strict";
import test from "node:test";

import { provisionApiKeyProfile } from "../../tools/e2e/conductor-profile.mjs";

test("Profile provisioning uses only closed commands and a bounded secret frame", async () => {
  const calls = [];
  const secret = new TextEncoder().encode("codex-secret-canary");
  const summary = (readiness, isActive = false) => ({
    profile_id: "profile-1",
    display_name: "Core live E2E",
    authentication_method: "api_key",
    codex_turn_settings: {
      model: "codex-test-model",
      reasoning_effort: "medium",
      is_fast_mode_enabled: false,
    },
    readiness,
    is_active: isActive,
    observed_at: "2026-07-18T00:00:00Z",
  });
  const harness = {
    async request(body, secretFrame) {
      calls.push({ body, secretLength: secretFrame?.byteLength ?? 0 });
      if (body.kind === "create_profile") return { kind: "profile_saved", profile: summary("login-required") };
      if (body.kind === "set_api_key") return { kind: "profile_status", profile: summary("ready") };
      if (body.kind === "activate_profile") return { kind: "profile_activated", profile: summary("ready", true) };
      throw new Error("unexpected_call");
    },
  };

  const result = await provisionApiKeyProfile({
    harness,
    conductorId: "conductor-1",
    model: "codex-test-model",
    apiKey: secret,
  });

  assert.deepEqual(result, {
    profileId: "profile-1",
    readiness: "ready",
    isActive: true,
    model: "codex-test-model",
    reasoningEffort: "medium",
    isFastModeEnabled: false,
  });
  assert.deepEqual(calls.map(({ body }) => body.kind), [
    "create_profile", "set_api_key", "activate_profile",
  ]);
  assert.equal(calls[1].secretLength, "codex-secret-canary".length);
  assert.equal(JSON.stringify(calls).includes("codex-secret-canary"), false);
  assert.deepEqual([...secret], Array(secret.length).fill(0));
});

test("Profile provisioning clears the API key when a relay command fails", async () => {
  const secret = new TextEncoder().encode("failure-secret");
  await assert.rejects(
    provisionApiKeyProfile({
      harness: { async request() { throw new Error("relay_failed"); } },
      conductorId: "conductor-1",
      model: "codex-test-model",
      apiKey: secret,
    }),
    /relay_failed/u,
  );
  assert.deepEqual([...secret], Array(secret.length).fill(0));
});
