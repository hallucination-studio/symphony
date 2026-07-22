const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const MANAGED_RECORD_PREFIX = "<!-- symphony managed-record";
const ROOT_RESULT_FIELDS = new Set([
  "rootIssueId", "identifier", "projectId", "parentIssueId", "stateName",
]);
const OBSERVATION_FIELDS = new Set(["git"]);
const PENDING_TRANSIENT_ERRORS = new Set(["target_facts_human_action_missing"]);
const FACTS_TRANSIENT_ERRORS = new Set([
  "target_facts_cycle_invalid",
  "target_facts_dag_incomplete",
  "target_facts_plan_invalid",
  "target_facts_stage_correlation_invalid",
  "target_facts_stage_shape_invalid",
  "target_facts_stage_terminal_missing",
  "target_facts_work_completion_invalid",
  "target_facts_work_incomplete",
  "target_facts_verify_result_invalid",
  "target_facts_delivery_revision_mismatch",
]);
const FACTS_FIELDS = new Set([
  "root", "plan", "stageExecutions", "progress", "repairEscalation", "delivery",
]);
import { createAdaptivePoller } from "./target-workflow-polling.mjs";

export async function runTargetSuccessScenario({
  runner,
  rootInput,
  observationInput,
  humanResponseBody,
  timeoutMs = 30 * 60_000,
  pollIntervalMs = 1_000,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  now = Date.now,
  onProgress = () => {},
  readObservationInput = async () => observationInput,
} = {}) {
  validateDependencies({ runner, observationInput, humanResponseBody, timeoutMs, pollIntervalMs, sleep, now, onProgress, readObservationInput });
  const deadline = now() + timeoutMs;
  const created = validateRootResult(await runner.createRoot(rootInput));
  const readInput = async (phase) => Object.freeze({
    rootIssueId: created.rootIssueId,
    projectId: created.projectId,
    git: Object.freeze(validateObservationInput(
      await readObservationInput(Object.freeze({
        rootIssueId: created.rootIssueId,
        projectId: created.projectId,
        phase,
      })),
    ).git),
  });

  const pending = await pollUntil({
    phase: "pending_human",
    deadline,
    now,
    sleep,
    pollIntervalMs,
    onProgress,
    read: async () => {
      try {
        return validatePendingObservation(
          await runner.observePendingHuman(await readInput("pending_human")),
          created.rootIssueId,
        );
      } catch (error) {
        if (!PENDING_TRANSIENT_ERRORS.has(reason(error))) throw error;
        onProgress({ phase: "pending_human", reason: reason(error) });
        return undefined;
      }
    },
    accepted: (value) => value?.status === "waiting",
  });
  if (pending.requestKind !== "needs_approval") {
    throw new Error("target_success_pending_kind_invalid");
  }
  onProgress({ phase: "human_response", status: "submitting" });
  await runner.appendHumanResponse({
    projectId: created.projectId,
    issueId: pending.nodeIssueId,
    body: humanResponseBody,
  });

  const observed = await pollUntil({
    phase: "durable_facts",
    deadline,
    now,
    sleep,
    pollIntervalMs,
    onProgress,
    read: async () => {
      try {
        return validateFactsObservation(
          await runner.observeRoot(await readInput("durable_facts")),
          created,
        );
      } catch (error) {
        if (!FACTS_TRANSIENT_ERRORS.has(reason(error))) throw error;
        onProgress({ phase: "durable_facts", reason: reason(error) });
        return undefined;
      }
    },
    accepted: (value) => value !== undefined,
  });
  return Object.freeze({ facts: observed });
}

async function pollUntil({ phase, deadline, now, sleep, pollIntervalMs, onProgress, read, accepted }) {
  const poller = createAdaptivePoller({ baseIntervalMs: pollIntervalMs });
  while (now() < deadline) {
    const value = await read();
    if (value?.status) onProgress({ phase, status: value.status });
    if (accepted(value)) return value;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(poller.observe(value), remaining));
  }
  throw new Error("target_success_timeout");
}

function validateDependencies({ runner, observationInput, humanResponseBody, timeoutMs, pollIntervalMs, sleep, now, onProgress, readObservationInput }) {
  if (typeof runner?.createRoot !== "function" ||
      typeof runner?.observePendingHuman !== "function" ||
      typeof runner?.appendHumanResponse !== "function" ||
      typeof runner?.observeRoot !== "function") {
    throw new Error("target_success_runner_invalid");
  }
  assertClosedObject(observationInput, OBSERVATION_FIELDS, "target_success_observation_input_invalid");
  validateObservationInput(observationInput);
  if (typeof readObservationInput !== "function") throw new Error("target_success_observation_reader_invalid");
  if (typeof humanResponseBody !== "string" || humanResponseBody.trim().length === 0 ||
      humanResponseBody.length > 8_192 || humanResponseBody.includes(MANAGED_RECORD_PREFIX)) {
    throw new Error("target_success_human_body_invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 300_000 ||
      typeof sleep !== "function" || typeof now !== "function" || typeof onProgress !== "function") {
    throw new Error("target_success_timing_invalid");
  }
}

function validateObservationInput(value) {
  assertClosedObject(value, OBSERVATION_FIELDS, "target_success_observation_input_invalid");
  if (!SHA.test(value.git?.head ?? "") || !SAFE_ID.test(value.git?.branch ?? "")) {
    throw new Error("target_success_observation_input_invalid");
  }
  return value;
}

function validateRootResult(value) {
  assertClosedObject(value, ROOT_RESULT_FIELDS, "target_success_root_result_invalid");
  if (!SAFE_ID.test(value.rootIssueId ?? "") || !SAFE_ID.test(value.projectId ?? "") ||
      (value.identifier !== undefined && !SAFE_ID.test(value.identifier)) ||
      (value.parentIssueId !== undefined) ||
      (value.stateName !== undefined && typeof value.stateName !== "string")) {
    throw new Error("target_success_root_result_invalid");
  }
  return value;
}

function validatePendingObservation(value, rootIssueId) {
  const pending = value?.pendingHuman;
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
    throw new Error("target_success_pending_observation_invalid");
  }
  if (pending.status === "not_waiting" && Object.keys(pending).length === 1) return pending;
  if (pending.status !== "waiting" || Object.keys(pending).some((key) => ![
    "status", "rootIssueId", "cycleIssueId", "nodeIssueId", "requestKind", "actionId", "contextDigest",
  ].includes(key)) || !SAFE_ID.test(pending.rootIssueId ?? "") ||
      !SAFE_ID.test(pending.cycleIssueId ?? "") || !SAFE_ID.test(pending.nodeIssueId ?? "") ||
      !SAFE_ID.test(pending.actionId ?? "") || !/^[0-9a-f]{64}$/u.test(pending.contextDigest ?? "") ||
      !["needs_approval", "needs_info"].includes(pending.requestKind) ||
      pending.rootIssueId !== rootIssueId) {
    throw new Error("target_success_pending_observation_invalid");
  }
  return pending;
}

function validateFactsObservation(value, created) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "facts")) {
    throw new Error("target_success_facts_invalid");
  }
  const facts = value.facts;
  if (!facts || typeof facts !== "object" || Array.isArray(facts) ||
      Object.keys(facts).some((key) => !FACTS_FIELDS.has(key)) ||
      facts.root?.rootIssueId !== created.rootIssueId || facts.root?.projectId !== created.projectId) {
    throw new Error("target_success_facts_invalid");
  }
  return facts;
}

function assertClosedObject(value, fields, errorCode) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.has(key))) throw new Error(errorCode);
}

function reason(error) {
  return error instanceof Error ? error.message : "target_success_boundary_failed";
}
