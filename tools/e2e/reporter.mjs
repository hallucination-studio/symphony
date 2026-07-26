const PHASES = new Set([
  "resetting",
  "starting",
  "ready",
  "running",
  "final-reading",
  "cleaning",
]);

const CASE_OBSERVATIONS = new Set([
  "creating-root",
  "running",
  "waiting-human",
  "final-reading",
  "passed",
  "failed",
  "incomplete",
]);

export function createForegroundReporter({
  campaignId,
  secrets = [],
  now = () => new Date().toISOString(),
  elapsedMs = () => 0,
  write = (line) => process.stderr.write(line),
  setInterval: setHeartbeat = globalThis.setInterval,
  clearInterval: clearHeartbeat = globalThis.clearInterval,
} = {}) {
  if (!identifier(campaignId) || !Array.isArray(secrets) || typeof now !== "function" ||
      typeof elapsedMs !== "function" || typeof write !== "function" ||
      typeof setHeartbeat !== "function" || typeof clearHeartbeat !== "function") {
    throw stableError("foreground_e2e_reporter_input_invalid");
  }
  const redactions = [...new Set(secrets.filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => right.length - left.length);
  let heartbeat;
  let closed = false;

  return Object.freeze({
    phase(value) {
      if (!PHASES.has(value)) throw stableError("foreground_e2e_reporter_phase_invalid");
      emit({ event: "foreground_e2e_phase", phase: value });
    },
    caseObservation({ caseId, observation, detail } = {}) {
      if (!identifier(caseId) || !CASE_OBSERVATIONS.has(observation) ||
          detail !== undefined && typeof detail !== "string") {
        throw stableError("foreground_e2e_reporter_case_invalid");
      }
      emit({
        event: "foreground_e2e_case_observation",
        case_id: caseId,
        observation,
        ...(detail === undefined ? {} : { detail }),
      });
    },
    waitingHuman({ caseId, detail } = {}) {
      this.caseObservation({ caseId, observation: "waiting-human", detail });
    },
    signal(signal) {
      if (signal !== "SIGINT" && signal !== "SIGTERM") {
        throw stableError("foreground_e2e_reporter_signal_invalid");
      }
      emit({ event: "foreground_e2e_signal", signal });
    },
    childExit({ component, reasonCode } = {}) {
      if (!identifier(component) || !identifier(reasonCode)) {
        throw stableError("foreground_e2e_reporter_child_invalid");
      }
      emit({ event: "foreground_e2e_child_exit", component, reason_code: reasonCode });
    },
    startHeartbeat(intervalMs) {
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || heartbeat !== undefined) {
        throw stableError("foreground_e2e_reporter_heartbeat_invalid");
      }
      heartbeat = setHeartbeat(() => emit({ event: "foreground_e2e_heartbeat" }), intervalMs);
    },
    close() {
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) clearHeartbeat(heartbeat);
    },
  });

  function emit(fields) {
    if (closed) return;
    const value = sanitize({
      at: timestamp(now()),
      campaign_id: campaignId,
      elapsed_ms: elapsed(),
      ...fields,
    }, redactions);
    write(`${JSON.stringify(value)}\n`);
  }

  function elapsed() {
    const value = elapsedMs();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw stableError("foreground_e2e_reporter_elapsed_invalid");
    }
    return value;
  }
}

function sanitize(value, redactions) {
  if (typeof value === "string") return redact(value, redactions);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, redactions));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, redactions)]));
}

function redact(value, redactions) {
  let result = value.slice(0, 4_096);
  for (const secret of redactions) result = result.replaceAll(secret, "[REDACTED]");
  return result.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, "[REDACTED]");
}

function timestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw stableError("foreground_e2e_reporter_timestamp_invalid");
  }
  return value;
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
