const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/u;
const MANAGED_RECORD_PREFIX = "<!-- symphony managed-record";
const ROOT_RESULT_FIELDS = new Set(["rootIssueId", "identifier", "projectId", "parentIssueId", "stateName"]);
const OBSERVATION_FIELDS = new Set(["git"]);
const FACTS_FIELDS = new Set(["root", "plan", "stageExecutions", "progress", "repairEscalation", "delivery"]);
const REPAIR_FIELDS = new Set(["findingId", "sourceVerifyId", "disposition", "breaker"]);
const BREAKER_FIELDS = new Set(["checked", "decision", "cycleCount", "maxCycles", "openFindingCount"]);
import { createAdaptivePoller } from "./target-workflow-polling.mjs";
const TRANSIENT_PENDING_ERRORS = new Set([
  "target_transport_issue_kind_invalid",
]);
const TRANSIENT_FACTS_ERRORS = new Set([
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
  "target_transport_issue_kind_invalid",
]);

export async function runTargetRepairEscalationScenario({
  runner,
  rootInput,
  observationInput,
  humanResponseBody,
  maxHumanActions = 16,
  timeoutMs = 5 * 60_000,
  pollIntervalMs = 1_000,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  now = Date.now,
  onProgress = () => {},
  readObservationInput = async () => observationInput,
} = {}) {
  validateDependencies({
    runner, observationInput, humanResponseBody, maxHumanActions, timeoutMs,
    pollIntervalMs, sleep, now, onProgress, readObservationInput,
  });
  const deadline = now() + timeoutMs;
  const created = validateRootResult(await runner.createRoot(rootInput));
  const submittedActionIds = new Set();
  let lastSubmittedActionId;
  const pollers = new Map();

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

  while (now() < deadline) {
    let pending;
    try {
      pending = validatePendingObservation(
        await runner.observePendingHuman(await readInput("pending_human")),
        created.rootIssueId,
      );
    } catch (error) {
      if (!TRANSIENT_PENDING_ERRORS.has(reason(error))) throw error;
      onProgress({ phase: "pending_human", reason: reason(error) });
      await pause(deadline, now, sleep, pollIntervalMs, pollers, "pending_human", error.message);
      continue;
    }
    if (pending.status === "waiting") {
      if (pending.requestKind !== "needs_approval") {
        throw new Error("target_repair_pending_kind_invalid");
      }
      if (submittedActionIds.has(pending.actionId)) {
        if (pending.actionId !== lastSubmittedActionId) {
          throw new Error("target_repair_duplicate_human_action");
        }
        onProgress({ phase: "human_response", status: "pending", actionId: pending.actionId });
        await pause(deadline, now, sleep, pollIntervalMs, pollers, "pending_human", pending);
        continue;
      }
      if (submittedActionIds.size >= maxHumanActions) {
        throw new Error("target_repair_human_action_limit");
      }
      onProgress({ phase: "human_response", status: "submitting", actionId: pending.actionId });
      await runner.appendHumanResponse({
        projectId: created.projectId,
        issueId: pending.nodeIssueId,
        body: humanResponseBody,
      });
      submittedActionIds.add(pending.actionId);
      lastSubmittedActionId = pending.actionId;
      continue;
    }

    let facts;
    try {
      facts = validateFactsObservation(
        await runner.observeRoot(await readInput("durable_facts")),
        created,
      );
    } catch (error) {
      if (!TRANSIENT_FACTS_ERRORS.has(reason(error))) throw error;
      onProgress({ phase: "durable_facts", reason: reason(error) });
      await pause(deadline, now, sleep, pollIntervalMs, pollers, "durable_facts", error.message);
      continue;
    }
    if (facts.repairEscalation) return Object.freeze({ facts });
    onProgress({ phase: "durable_facts", status: "awaiting_escalation" });
    await pause(deadline, now, sleep, pollIntervalMs, pollers, "durable_facts", facts);
  }
  throw new Error("target_repair_timeout");
}

function validateDependencies({ runner, observationInput, humanResponseBody, maxHumanActions, timeoutMs, pollIntervalMs, sleep, now, onProgress, readObservationInput }) {
  if (typeof runner?.createRoot !== "function" ||
      typeof runner?.observePendingHuman !== "function" ||
      typeof runner?.appendHumanResponse !== "function" ||
      typeof runner?.observeRoot !== "function") {
    throw new Error("target_repair_runner_invalid");
  }
  validateObservationInput(observationInput);
  if (typeof readObservationInput !== "function") throw new Error("target_repair_observation_reader_invalid");
  if (typeof humanResponseBody !== "string" || humanResponseBody.trim().length === 0 ||
      humanResponseBody.length > 8_192 || humanResponseBody.includes(MANAGED_RECORD_PREFIX)) {
    throw new Error("target_repair_human_body_invalid");
  }
  if (!Number.isSafeInteger(maxHumanActions) || maxHumanActions < 1 || maxHumanActions > 64 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 300_000 ||
      typeof sleep !== "function" || typeof now !== "function" || typeof onProgress !== "function") {
    throw new Error("target_repair_timing_invalid");
  }
}

function validateRootResult(value) {
  if (!isClosedObject(value, ROOT_RESULT_FIELDS) ||
      !SAFE_ID.test(value.rootIssueId ?? "") || !SAFE_ID.test(value.projectId ?? "")) {
    throw new Error("target_repair_root_result_invalid");
  }
  return value;
}

function validateObservationInput(value) {
  if (!isClosedObject(value, OBSERVATION_FIELDS) ||
      !SHA.test(value.git?.head ?? "") || !SAFE_ID.test(value.git?.branch ?? "")) {
    throw new Error("target_repair_observation_input_invalid");
  }
  return value;
}

function validatePendingObservation(value, rootIssueId) {
  const pending = value?.pendingHuman;
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
    throw new Error("target_repair_pending_observation_invalid");
  }
  if (pending.status === "not_waiting" && Object.keys(pending).length === 1) return pending;
  if (pending.status !== "waiting" ||
      Object.keys(pending).some((key) => ![
        "status", "rootIssueId", "cycleIssueId", "nodeIssueId", "requestKind", "actionId", "contextDigest",
      ].includes(key)) ||
      pending.rootIssueId !== rootIssueId || !SAFE_ID.test(pending.cycleIssueId ?? "") ||
      !SAFE_ID.test(pending.nodeIssueId ?? "") || !SAFE_ID.test(pending.actionId ?? "") ||
      !DIGEST.test(pending.contextDigest ?? "") ||
      !["needs_approval", "needs_info"].includes(pending.requestKind)) {
    throw new Error("target_repair_pending_observation_invalid");
  }
  return pending;
}

function validateFactsObservation(value, created) {
  const facts = value?.facts;
  if (!isClosedObject(facts, FACTS_FIELDS) ||
      facts.root?.rootIssueId !== created.rootIssueId || facts.root?.projectId !== created.projectId) {
    throw new Error("target_repair_facts_invalid");
  }
  if (facts.repairEscalation === undefined) return facts;
  const repair = facts.repairEscalation;
  const breaker = repair && typeof repair === "object" && !Array.isArray(repair)
    ? repair.breaker
    : undefined;
  if (!isClosedObject(repair, REPAIR_FIELDS) ||
      !SAFE_ID.test(repair.findingId ?? "") || !SAFE_ID.test(repair.sourceVerifyId ?? "") ||
      repair.disposition !== "escalated" || !breaker || typeof breaker !== "object" ||
      !isClosedObject(breaker, BREAKER_FIELDS) || breaker.checked !== true || breaker.decision !== "escalate" ||
      !Number.isSafeInteger(breaker.cycleCount) || !Number.isSafeInteger(breaker.maxCycles) ||
      breaker.cycleCount < breaker.maxCycles || !Number.isSafeInteger(breaker.openFindingCount) ||
      breaker.openFindingCount < 1) {
    throw new Error("target_repair_facts_invalid");
  }
  return facts;
}

function isClosedObject(value, fields) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.has(key));
}

async function pause(deadline, now, sleep, pollIntervalMs, pollers, phase, value) {
  const remaining = deadline - now();
  if (remaining <= 0) return;
  let poller = pollers.get(phase);
  if (!poller) {
    poller = createAdaptivePoller({ baseIntervalMs: pollIntervalMs });
    pollers.set(phase, poller);
  }
  await sleep(Math.min(poller.observe(value), remaining));
}

function reason(error) {
  return error instanceof Error ? error.message : "target_repair_boundary_failed";
}
