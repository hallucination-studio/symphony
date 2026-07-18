const OBSERVATION_KEYS = Object.freeze([
  "podium_backend_responded",
  "schema_version",
  "suite",
  "webview_loaded",
]);

export function createDesktopShellVerdict({
  runId,
  observation,
  failureReason,
} = {}) {
  const safeRunId = identifier(runId, "desktop_shell_run_id_invalid");
  const validObservation = isObservation(observation);
  const observations = Object.freeze({
    podium_backend_responded: observation?.podium_backend_responded === true,
    webview_loaded: observation?.webview_loaded === true,
  });
  const passed = failureReason === undefined && validObservation &&
    Object.values(observations).every(Boolean);
  const reason = failureReason ?? (validObservation
    ? "desktop_shell_observation_incomplete"
    : "desktop_shell_observation_invalid");
  return Object.freeze({
    schema_version: 1,
    suite: "desktop-shell-smoke",
    run_id: safeRunId,
    status: passed ? "passed" : "failed",
    reason: passed
      ? null
      : stableReason(reason),
    observations,
  });
}

function isObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === OBSERVATION_KEYS.length &&
    keys.every((key, index) => key === OBSERVATION_KEYS[index]) &&
    value.schema_version === 1 &&
    value.suite === "desktop-shell-smoke-observation" &&
    typeof value.webview_loaded === "boolean" &&
    typeof value.podium_backend_responded === "boolean";
}

function stableReason(value) {
  if (typeof value !== "string" || !/^desktop_shell_[a-z0-9_]{1,96}$/u.test(value)) {
    return "desktop_shell_failed";
  }
  return value;
}

function identifier(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error(code);
  }
  return value;
}
