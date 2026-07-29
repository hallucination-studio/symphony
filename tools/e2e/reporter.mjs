const PHASES = new Set([
  "resetting",
  "starting",
  "ready",
  "admitting",
  "running",
  "quiescing",
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
const ADMISSION_MILESTONES = new Set(["roots-created", "roots-verified", "roots-delegated"]);
const ASSERTION_OUTCOMES = new Set(["satisfied", "contradicted", "coverage_missing"]);
const ACCEPTANCE_LEVELS = new Set(["L0", "L1", "L2", "L3", "L4"]);
const ACCEPTANCE_VERDICTS = new Set(["passed", "failed", "incomplete"]);

const RUNTIME_DIAGNOSTIC_LEVELS = new Set(["info", "warning", "error"]);
const FORWARDED_CONDUCTOR_RUNTIME_EVENTS = new Set([
  "private_ipc_failed",
  "root_project_unavailable",
  "root_discovery_blocked",
  "root_discovery_degraded",
  "root_profile_missing",
  "root_safety_blocked",
  "root_reconciliation_failed",
  "root_reconciler_failed",
  "root_directive_materialization_failed",
]);
const KNOWN_CONDUCTOR_RUNTIME_LOG_EVENTS = new Set([
  ...FORWARDED_CONDUCTOR_RUNTIME_EVENTS,
  "root_discovery_evidence",
  "root_candidate_selected",
  "root_turn_validated",
  "root_initial_execution_read_back",
  "plan_dag_seal_read_back",
  "root_next_action_materialized",
]);
const CONDUCTOR_RUNTIME_DIAGNOSTIC_EVENTS = new Set([
  ...FORWARDED_CONDUCTOR_RUNTIME_EVENTS,
  "conductor_runtime_log_unknown_event",
  "conductor_runtime_log_invalid_json",
  "conductor_runtime_log_invalid_fields",
]);

export function isForegroundE2EConductorRuntimeEvent(value) {
  return typeof value === "string" && CONDUCTOR_RUNTIME_DIAGNOSTIC_EVENTS.has(value);
}

export function isForwardableConductorRuntimeEvent(value) {
  return typeof value === "string" && FORWARDED_CONDUCTOR_RUNTIME_EVENTS.has(value);
}

export function isKnownConductorRuntimeLogEvent(value) {
  return typeof value === "string" && KNOWN_CONDUCTOR_RUNTIME_LOG_EVENTS.has(value);
}

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
    admissionProgress({ milestone, rootCount } = {}) {
      if (!ADMISSION_MILESTONES.has(milestone) || !Number.isSafeInteger(rootCount) || rootCount < 1) {
        throw stableError("foreground_e2e_reporter_admission_invalid");
      }
      emit({ event: "foreground_e2e_admission_progress", milestone, root_count: rootCount });
    },
    caseAssertion({ caseId, assertionId, outcome, reasonCode } = {}) {
      const reasonRequired = outcome !== "satisfied";
      if (!identifier(caseId) || !identifier(assertionId) || !ASSERTION_OUTCOMES.has(outcome) ||
          reasonRequired !== identifier(reasonCode)) {
        throw stableError("foreground_e2e_reporter_assertion_invalid");
      }
      emit({
        event: "foreground_e2e_case_assertion",
        case_id: caseId,
        assertion_id: assertionId,
        outcome,
        ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
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
    failure({ component, reasonCode } = {}) {
      if (!identifier(component) || !identifier(reasonCode)) {
        throw stableError("foreground_e2e_reporter_failure_invalid");
      }
      emit({ event: "foreground_e2e_failure", component, reason_code: reasonCode });
    },
    acceptanceVerdict({ level, verdict, reasonCodes = [], elapsedMs: levelElapsedMs } = {}) {
      if (!ACCEPTANCE_LEVELS.has(level) || !ACCEPTANCE_VERDICTS.has(verdict) ||
          !Array.isArray(reasonCodes) || reasonCodes.some((code) => !identifier(code)) ||
          !Number.isSafeInteger(levelElapsedMs) || levelElapsedMs < 0 ||
          (verdict === "passed") !== (reasonCodes.length === 0)) {
        throw stableError("foreground_e2e_reporter_acceptance_invalid");
      }
      emit({
        event: "foreground_e2e_acceptance_verdict",
        level,
        verdict,
        reason_codes: [...reasonCodes],
        level_elapsed_ms: levelElapsedMs,
      });
    },
    runtimeDiagnostic({
      component,
      conductorId,
      level,
      runtimeEvent,
      rootIssueId,
      reason,
      failureCode,
      sanitizedReason,
      phase,
      directiveId,
      directiveKind,
      operationGroup,
      operationIndex,
      operationKind,
    } = {}) {
      const hasDirectiveDiagnostic = directiveId !== undefined || directiveKind !== undefined;
      const hasOperationDiagnostic = operationGroup !== undefined || operationIndex !== undefined || operationKind !== undefined;
      if (component !== "conductor" || !identifier(conductorId) || !RUNTIME_DIAGNOSTIC_LEVELS.has(level) ||
          !isForegroundE2EConductorRuntimeEvent(runtimeEvent) ||
          rootIssueId !== undefined && !identifier(rootIssueId) ||
          reason !== undefined && !safeRuntimeCode(reason) ||
          failureCode !== undefined && !safeRuntimeCode(failureCode) ||
          sanitizedReason !== undefined && !safeSanitizedReason(sanitizedReason) ||
          phase !== undefined && !safeRuntimeCode(phase) ||
          hasDirectiveDiagnostic && (runtimeEvent !== "root_directive_materialization_failed" ||
            !identifier(directiveId) || !safeRuntimeCode(directiveKind)) ||
          hasOperationDiagnostic && (!hasDirectiveDiagnostic || !safeRuntimeCode(operationGroup) ||
            !Number.isSafeInteger(operationIndex) || operationIndex < 0 || !safeRuntimeCode(operationKind))) {
        throw stableError("foreground_e2e_reporter_runtime_diagnostic_invalid");
      }
      emit({
        event: "foreground_e2e_runtime_diagnostic",
        component,
        conductor_id: conductorId,
        level,
        runtime_event: runtimeEvent,
        ...(rootIssueId === undefined ? {} : { root_issue_id: rootIssueId }),
        ...(reason === undefined ? {} : { reason }),
        ...(failureCode === undefined ? {} : { failure_code: failureCode }),
        ...(sanitizedReason === undefined ? {} : { sanitized_reason: sanitizedReason }),
        ...(phase === undefined ? {} : { phase }),
        ...(directiveId === undefined ? {} : { directive_id: directiveId }),
        ...(directiveKind === undefined ? {} : { directive_kind: directiveKind }),
        ...(operationGroup === undefined ? {} : { operation_group: operationGroup }),
        ...(operationIndex === undefined ? {} : { operation_index: operationIndex }),
        ...(operationKind === undefined ? {} : { operation_kind: operationKind }),
      });
    },
    summary({ exitCode, cases } = {}) {
      if ((exitCode !== 0 && exitCode !== 1) || !Array.isArray(cases) || cases.length === 0 ||
          cases.some((item) => !identifier(item?.caseId) || !["passed", "failed", "incomplete"].includes(item.verdict) ||
            !Array.isArray(item.reasonCodes) || item.reasonCodes.some((code) => !identifier(code)) ||
            !Number.isSafeInteger(item.elapsedMs) || item.elapsedMs < 0)) {
        throw stableError("foreground_e2e_reporter_summary_invalid");
      }
      emit({
        event: "foreground_e2e_summary",
        exit_code: exitCode,
        cases: cases.map(({ caseId, verdict, reasonCodes, elapsedMs }) => ({
          case_id: caseId,
          verdict,
          reason_codes: [...reasonCodes],
          elapsed_ms: elapsedMs,
        })),
      });
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

function safeRuntimeCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(value);
}

function safeSanitizedReason(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !/[\p{Cc}]/u.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
