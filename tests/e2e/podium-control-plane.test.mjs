import assert from "node:assert/strict";
import test from "node:test";

import {
  createPodiumClientCommandPort,
  provisionApiKeyProfiles,
  provisionConductorBindings,
  startConductorProcesses,
} from "../../tools/e2e/podium-control-plane.mjs";

test("public control plane provisions and activates one ready API-key Profile per live Conductor", async () => {
  const commands = [];
  const secret = Buffer.from("codex-secret", "utf8");
  const profiles = await provisionApiKeyProfiles({
    client: {
      async command(body, frame) {
        commands.push({ body, frame });
        const profileId = `profile-${body.conductor_id.slice(-1)}`;
        if (body.kind === "create_performer_profile") return profile(profileId, "login-required", false);
        if (body.kind === "set_codex_api_key") return profile(profileId, "ready", false);
        if (body.kind === "get_performer_profile_status") return profile(profileId, "ready", false);
        return profile(profileId, "ready", true);
      },
    },
    conductors: [conductor("a"), conductor("b"), conductor("c")],
    model: "gpt-5-codex",
    apiKey: secret,
    wait: async () => {},
  });

  assert.deepEqual(profiles.map(({ conductor_id, profile_id }) => ({ conductor_id, profile_id })), [
    { conductor_id: "conductor-a", profile_id: "profile-a" },
    { conductor_id: "conductor-b", profile_id: "profile-b" },
    { conductor_id: "conductor-c", profile_id: "profile-c" },
  ]);
  assert.equal(secret.every((value) => value === 0), true);
  const frames = commands.filter(({ body }) => body.kind === "set_codex_api_key").map(({ frame }) => frame);
  assert.equal(new Set(frames).size, 3);
  assert.equal(frames.every((frame) => frame.every((value) => value === 0)), true);
});

test("public control plane port sends closed requests and fails on a Podium protocol error", async () => {
  const messages = [];
  const port = createPodiumClientCommandPort({
    handler: {
      async handle(message, secret) {
        messages.push({ message, secret });
        return {
          protocol_version: "1",
          request_id: message.request_id,
          body: message.body.kind === "start_conductor"
            ? {
                kind: "conductor_command_completed",
                conductor_id: "conductor-a",
                command_kind: "start_conductor",
              }
            : {
                code: "podium_client_request_failed",
                category: "podium_client",
                sanitized_reason: "Podium could not complete the request.",
                retryable: false,
                action_required: "retry_request",
                next_action: "Retry after resolving the reported local runtime problem.",
              },
        };
      },
    },
    createRequestId: () => "request-1",
  });
  const secret = Buffer.from("secret", "utf8");
  const result = await port.command({ kind: "start_conductor", conductor_id: "conductor-a" }, secret);

  assert.deepEqual(result, {
    kind: "conductor_command_completed",
    conductor_id: "conductor-a",
    command_kind: "start_conductor",
  });
  assert.deepEqual(messages[0].message, {
    protocol_version: "1",
    request_id: "request-1",
    body: { kind: "start_conductor", conductor_id: "conductor-a" },
  });
  assert.equal(messages[0].secret, secret);
  await assert.rejects(
    port.command({ kind: "create_conductor", project_id: "project-1", repository: {} }),
    /e2e_podium_client_podium_client_request_failed/u,
  );
});

test("public control plane waits for concurrent Profile commands before clearing their API-key frames", async () => {
  const secret = Buffer.from("codex-secret", "utf8");
  let resolveLateProfile;
  const lateProfileObserved = new Promise((resolve) => { resolveLateProfile = resolve; });
  const provision = provisionApiKeyProfiles({
    client: {
      async command(body, frame) {
        const profileId = `profile-${body.conductor_id.slice(-1)}`;
        if (body.kind === "create_performer_profile") return profile(profileId, "login-required", false);
        if (body.kind === "set_codex_api_key" && body.conductor_id === "conductor-a") {
          throw new Error("profile_relay_failed");
        }
        if (body.kind === "set_codex_api_key") {
          await new Promise((resolve) => setImmediate(resolve));
          resolveLateProfile(Buffer.from(frame).toString("utf8"));
          return profile(profileId, "ready", false);
        }
        return profile(profileId, "ready", true);
      },
    },
    conductors: [conductor("a"), conductor("b"), conductor("c")],
    model: "gpt-5-codex",
    apiKey: secret,
    wait: async () => {},
  });

  await assert.rejects(provision, /profile_relay_failed/u);
  assert.equal(await lateProfileObserved, "codex-secret");
  assert.equal(secret.every((value) => value === 0), true);
});

test("public control plane creates every Binding before it starts any Conductor process", async () => {
  const events = [];
  const client = {
    async command(body) {
      if (body.kind === "create_conductor") {
        events.push(`create:${body.repository.repository_handle}`);
        const suffix = body.repository.repository_handle.slice(-1);
        return {
          kind: "conductor_created",
          conductor_id: `conductor-${suffix}`,
          binding_id: `binding-${suffix}`,
          conductor_short_hash: `hash-${suffix}`,
          repository_identity: `repository-${suffix}`,
        };
      }
      events.push(`start:${body.conductor_id}`);
      return {
        kind: "conductor_command_completed",
        conductor_id: body.conductor_id,
        command_kind: "start_conductor",
      };
    },
  };
  const bindings = await provisionConductorBindings({
    client,
    projectId: "project-1",
    repositories: repositories(),
  });

  assert.deepEqual(events, ["create:repo-a", "create:repo-b", "create:repo-c"]);
  assert.deepEqual(bindings.map(({ conductor_id }) => conductor_id), [
    "conductor-a", "conductor-b", "conductor-c",
  ]);

  await startConductorProcesses({ client, conductors: bindings });
  assert.deepEqual(events.slice(3), [
    "start:conductor-a", "start:conductor-b", "start:conductor-c",
  ]);
});

test("public control plane rejects malformed Binding metadata before process start", async () => {
  let starts = 0;
  await assert.rejects(
    provisionConductorBindings({
      client: {
        async command(body) {
          if (body.kind === "start_conductor") starts += 1;
          return { kind: "conductor_created", conductor_id: "conductor-a" };
        },
      },
      projectId: "project-1",
      repositories: repositories(),
    }),
    /e2e_podium_conductor_creation_invalid/u,
  );
  assert.equal(starts, 0);
});

function repositories() {
  return ["a", "b", "c"].map((suffix) => ({
    repository_handle: `repo-${suffix}`,
    repository_identity: `repository-${suffix}`,
    repository_display_name: `Repository ${suffix}`,
    base_branch: "main",
  }));
}

function conductor(suffix) {
  return {
    binding_id: `binding-${suffix}`,
    conductor_id: `conductor-${suffix}`,
    conductor_short_hash: `hash-${suffix}`,
    repository_identity: `repository-${suffix}`,
  };
}

function profile(profileId, readiness, isActive) {
  return {
    profile_id: profileId,
    display_name: "Parallel E2E",
    authentication_method: "api_key",
    codex_turn_settings: {
      model: "gpt-5-codex",
      reasoning_effort: "minimal",
      is_fast_mode_enabled: false,
    },
    execution_policy: {
      sandbox_mode: "workspace_write",
      command_allowlist: [],
      command_denylist: [],
    },
    readiness,
    is_active: isActive,
    observed_at: "2026-07-25T00:00:00.000Z",
  };
}
