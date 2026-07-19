const READINESS_ATTEMPTS = 10;

export async function provisionApiKeyProfile({
  harness,
  conductorId,
  model,
  apiKey,
  displayName = "Core live E2E",
  reasoningEffort = "medium",
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  log = () => {},
}) {
  validateInput({ harness, conductorId, model, apiKey, displayName, reasoningEffort });
  let profileId;
  try {
    log({ event: "e2e_profile_command_started", command: "create_profile" });
    const saved = await harness.request({
      kind: "create_profile",
      conductor_id: conductorId,
      display_name: displayName,
      backend_kind: "codex",
      authentication_method: "api_key",
      codex_turn_settings: {
        model,
        reasoning_effort: reasoningEffort,
        is_fast_mode_enabled: false,
      },
    });
    profileId = profile(saved, "profile_saved", log).profile_id;
    log({ event: "e2e_profile_command_completed", command: "create_profile" });
    log({ event: "e2e_profile_command_started", command: "set_api_key" });
    const status = await harness.request({
      kind: "set_api_key",
      conductor_id: conductorId,
      profile_id: profileId,
      secret_frame_length: apiKey.byteLength,
    }, apiKey);
    let current = profile(status, "profile_status", log);
    log({ event: "e2e_profile_command_completed", command: "set_api_key" });
    for (let attempt = 1; current.readiness !== "ready" && attempt < READINESS_ATTEMPTS; attempt += 1) {
      await wait(250);
      current = profile(await harness.request({
        kind: "get_profile_status",
        conductor_id: conductorId,
        profile_id: profileId,
      }), "profile_status", log);
    }
    if (current.readiness !== "ready") throw stableError("e2e_profile_not_ready");
    log({ event: "e2e_profile_command_started", command: "activate_profile" });
    const activated = profile(await harness.request({
      kind: "activate_profile",
      conductor_id: conductorId,
      profile_id: profileId,
    }), "profile_activated", log);
    log({ event: "e2e_profile_command_completed", command: "activate_profile" });
    if (!activated.is_active || activated.readiness !== "ready") {
      throw stableError("e2e_profile_activation_failed");
    }
    return Object.freeze({
      profileId,
      readiness: "ready",
      isActive: true,
      model: activated.codex_turn_settings.model,
      reasoningEffort: activated.codex_turn_settings.reasoning_effort,
      isFastModeEnabled: activated.codex_turn_settings.is_fast_mode_enabled,
    });
  } finally {
    apiKey.fill(0);
  }
}

function profile(result, expectedKind, log) {
  if (result?.kind !== expectedKind || !result.profile || typeof result.profile !== "object") {
    log({
      event: "e2e_profile_response_rejected",
      expected_kind: expectedKind,
      actual_kind: typeof result?.kind === "string" ? result.kind : "missing",
    });
    throw stableError("e2e_profile_response_invalid");
  }
  const value = result.profile;
  if (typeof value.profile_id !== "string" || !["login-required", "ready", "invalid"].includes(value.readiness)) {
    throw stableError("e2e_profile_response_invalid");
  }
  return value;
}

function validateInput({ harness, conductorId, model, apiKey, displayName, reasoningEffort }) {
  if (typeof harness?.request !== "function") throw stableError("e2e_profile_harness_invalid");
  if (!identifier(conductorId) || !model || model.length > 256 || !displayName || displayName.length > 256) {
    throw stableError("e2e_profile_metadata_invalid");
  }
  if (!(apiKey instanceof Uint8Array) || apiKey.byteLength < 1 || apiKey.byteLength > 16_384) {
    apiKey?.fill?.(0);
    throw stableError("e2e_profile_secret_invalid");
  }
  if (!new Set(["none", "minimal", "low", "medium", "high", "xhigh"]).has(reasoningEffort)) {
    throw stableError("e2e_profile_metadata_invalid");
  }
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
