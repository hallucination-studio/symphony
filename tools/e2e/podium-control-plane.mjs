const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const PROFILE_READINESS_ATTEMPTS = 10;

export function createPodiumClientCommandPort({ handler, createRequestId }) {
  if (!handler || typeof handler.handle !== "function" || typeof createRequestId !== "function") {
    throw stableError("e2e_podium_client_invalid");
  }
  return Object.freeze({
    async command(body, secret) {
      const requestId = createRequestId();
      assertIdentifier(requestId, "e2e_podium_request_invalid");
      const response = await handler.handle({
        protocol_version: "1",
        request_id: requestId,
        body,
      }, secret);
      if (!response || typeof response !== "object" || Array.isArray(response) ||
          response.protocol_version !== "1" || response.request_id !== requestId ||
          !response.body || typeof response.body !== "object" || Array.isArray(response.body)) {
        throw stableError("e2e_podium_response_invalid");
      }
      if (typeof response.body.code === "string") {
        throw stableError(`e2e_podium_client_${sanitizedCode(response.body.code)}`);
      }
      return response.body;
    },
  });
}

export async function provisionConductorBindings({ client, projectId, repositories }) {
  assertClient(client);
  assertIdentifier(projectId, "e2e_podium_project_invalid");
  if (!Array.isArray(repositories) || repositories.length < 3) {
    throw stableError("e2e_podium_repositories_invalid");
  }
  const repositoryIdentities = new Set();
  const bindings = [];
  for (const repository of repositories) {
    assertRepository(repository, repositoryIdentities);
    const response = await client.command({
      kind: "create_conductor",
      project_id: projectId,
      repository: {
        repository_handle: repository.repository_handle,
        display_name: repository.repository_display_name,
        base_branch: repository.base_branch,
      },
    });
    bindings.push(readCreatedConductor(response, repository.repository_identity));
  }
  if (new Set(bindings.map(({ conductor_id }) => conductor_id)).size !== bindings.length ||
      new Set(bindings.map(({ binding_id }) => binding_id)).size !== bindings.length ||
      new Set(bindings.map(({ conductor_short_hash }) => conductor_short_hash)).size !== bindings.length) {
    throw stableError("e2e_podium_conductor_creation_invalid");
  }
  return Object.freeze(bindings.map((binding) => Object.freeze(binding)));
}

export async function startConductorProcesses({ client, conductors }) {
  assertClient(client);
  if (!Array.isArray(conductors) || conductors.length < 3) {
    throw stableError("e2e_podium_conductors_invalid");
  }
  await Promise.all(conductors.map(async (conductor) => {
    assertConductor(conductor);
    const response = await client.command({
      kind: "start_conductor",
      conductor_id: conductor.conductor_id,
    });
    if (!sameStartResponse(response, conductor.conductor_id)) {
      throw stableError("e2e_podium_conductor_start_invalid");
    }
  }));
}

export async function provisionApiKeyProfiles({
  client,
  conductors,
  model,
  apiKey,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) {
  assertClient(client);
  if (!Array.isArray(conductors) || conductors.length < 3 ||
      typeof model !== "string" || model.length === 0 || model.length > 256 ||
      !(apiKey instanceof Uint8Array) || apiKey.byteLength === 0 || apiKey.byteLength > 16_384 ||
      typeof wait !== "function") {
    apiKey?.fill?.(0);
    throw stableError("e2e_podium_profile_input_invalid");
  }
  const frames = conductors.map(() => Buffer.from(apiKey));
  apiKey.fill(0);
  try {
    const outcomes = await Promise.allSettled(conductors.map(async (conductor, index) => {
      assertConductor(conductor);
      const created = profile(await profileCommand({
        client,
        requestFailureCode: "e2e_podium_profile_create_request_failed",
        body: {
          kind: "create_performer_profile",
          conductor_id: conductor.conductor_id,
          display_name: "Parallel Black-Box E2E",
          backend_kind: "codex",
          authentication_method: "api_key",
          codex_turn_settings: {
            model,
            reasoning_effort: "minimal",
            is_fast_mode_enabled: false,
          },
          execution_policy: {
            sandbox_mode: "workspace_write",
            command_allowlist: [],
            command_denylist: [],
          },
        },
      }), "e2e_podium_profile_create_invalid");
      const frame = frames[index];
      if (!frame) throw stableError("e2e_podium_profile_secret_invalid");
      let current = profile(await profileCommand({
        client,
        requestFailureCode: "e2e_podium_profile_set_api_key_request_failed",
        frame,
        body: {
          kind: "set_codex_api_key",
          conductor_id: conductor.conductor_id,
          profile_id: created.profile_id,
          secret_frame_length: frame.byteLength,
        },
      }), "e2e_podium_profile_secret_invalid");
      for (let attempt = 1; current.readiness !== "ready" && attempt < PROFILE_READINESS_ATTEMPTS; attempt += 1) {
        await wait(250);
        current = profile(await profileCommand({
          client,
          requestFailureCode: "e2e_podium_profile_status_request_failed",
          body: {
            kind: "get_performer_profile_status",
            conductor_id: conductor.conductor_id,
            profile_id: created.profile_id,
          },
        }), "e2e_podium_profile_status_invalid");
      }
      if (current.readiness !== "ready") throw stableError("e2e_podium_profile_not_ready");
      const activated = profile(await profileCommand({
        client,
        requestFailureCode: "e2e_podium_profile_activate_request_failed",
        body: {
          kind: "activate_performer_profile",
          conductor_id: conductor.conductor_id,
          profile_id: created.profile_id,
        },
      }), "e2e_podium_profile_activate_invalid");
      if (activated.profile_id !== created.profile_id || activated.readiness !== "ready" || !activated.is_active) {
        throw stableError("e2e_podium_profile_activate_invalid");
      }
      return Object.freeze({
        conductor_id: conductor.conductor_id,
        profile_id: activated.profile_id,
      });
    }));
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed) throw failed.reason;
    return Object.freeze(outcomes.map((outcome) => outcome.value));
  } finally {
    for (const frame of frames) frame.fill(0);
  }
}

async function profileCommand({ client, body, frame, requestFailureCode }) {
  try {
    return await client.command(body, frame);
  } catch {
    throw stableError(requestFailureCode);
  }
}

function readCreatedConductor(value, repositoryIdentity) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.kind !== "conductor_created" ||
      !identifier(value.conductor_id) || !identifier(value.binding_id) ||
      !identifier(value.conductor_short_hash) || value.repository_identity !== repositoryIdentity) {
    throw stableError("e2e_podium_conductor_creation_invalid");
  }
  return {
    binding_id: value.binding_id,
    conductor_id: value.conductor_id,
    conductor_short_hash: value.conductor_short_hash,
    repository_identity: value.repository_identity,
  };
}

function sameStartResponse(value, conductorId) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    value.kind === "conductor_command_completed" && value.command_kind === "start_conductor" &&
    value.conductor_id === conductorId;
}

function profile(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !identifier(value.profile_id) ||
      !["login-required", "ready", "invalid"].includes(value.readiness) || typeof value.is_active !== "boolean") {
    throw stableError(code);
  }
  return value;
}

function assertRepository(repository, identities) {
  if (!repository || typeof repository !== "object" || Array.isArray(repository) ||
      !identifier(repository.repository_handle) || !identifier(repository.repository_identity) ||
      typeof repository.repository_display_name !== "string" || repository.repository_display_name.length === 0 ||
      repository.repository_display_name.length > 256 ||
      typeof repository.base_branch !== "string" || repository.base_branch.length === 0 ||
      identities.has(repository.repository_identity)) {
    throw stableError("e2e_podium_repositories_invalid");
  }
  identities.add(repository.repository_identity);
}

function assertConductor(conductor) {
  if (!conductor || typeof conductor !== "object" || Array.isArray(conductor) ||
      !identifier(conductor.binding_id) || !identifier(conductor.conductor_id) ||
      !identifier(conductor.conductor_short_hash) || !identifier(conductor.repository_identity)) {
    throw stableError("e2e_podium_conductors_invalid");
  }
}

function assertClient(client) {
  if (!client || typeof client.command !== "function") throw stableError("e2e_podium_client_invalid");
}

function assertIdentifier(value, code) {
  if (!identifier(value)) throw stableError(code);
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function sanitizedCode(value) {
  return IDENTIFIER.test(value) ? value : "request_failed";
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
