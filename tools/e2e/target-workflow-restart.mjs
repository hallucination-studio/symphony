const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/u;
const OBSERVATION_FIELDS = new Set(["git"]);
const TRANSIENT_PENDING_ERRORS = new Set([
  "target_facts_human_action_missing",
  "target_facts_human_cycle_invalid",
]);
import { createAdaptivePoller } from "./target-workflow-polling.mjs";

export async function runTargetRestartRecoveryScenario({
  runner,
  boundary,
  rootInput,
  observationInput,
  humanResponseBody,
  timeoutMs = 5 * 60_000,
  pollIntervalMs = 1_000,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  now = Date.now,
  onProgress = () => {},
  readObservationInput = async () => observationInput,
} = {}) {
  validateDependencies({ runner, boundary, observationInput, humanResponseBody, timeoutMs, pollIntervalMs, sleep, now, onProgress, readObservationInput });
  const deadline = now() + timeoutMs;
  const created = validateRootResult(await runner.createRoot(rootInput));
  const readInput = async (phase) => Object.freeze({
    rootIssueId: created.rootIssueId,
    projectId: created.projectId,
    git: Object.freeze(validateObservationInput(await readObservationInput(Object.freeze({
      rootIssueId: created.rootIssueId,
      projectId: created.projectId,
      phase,
    }))).git),
  });

  const beforeRestart = await pollPending({
    runner, created, deadline, now, sleep, pollIntervalMs, onProgress,
    readInput, phase: "pending_before_restart",
  });
  onProgress({ phase: "restart", status: "starting" });
  const restartEvidence = validateRestartEvidence(await boundary.restart({
    rootIssueId: beforeRestart.rootIssueId,
    cycleIssueId: beforeRestart.cycleIssueId,
    nodeIssueId: beforeRestart.nodeIssueId,
    actionId: beforeRestart.actionId,
    contextDigest: beforeRestart.contextDigest,
  }));

  const afterRestart = await pollPending({
    runner, created, deadline, now, sleep, pollIntervalMs, onProgress,
    readInput, phase: "pending_after_restart",
  });
  if (!samePending(beforeRestart, afterRestart)) {
    throw new Error("target_restart_recovery_correlation_invalid");
  }
  await runner.appendHumanResponse({
    projectId: created.projectId,
    issueId: afterRestart.nodeIssueId,
    body: humanResponseBody,
  });

  const facts = await pollFacts({
    runner, created, deadline, now, sleep, pollIntervalMs, onProgress, readInput,
  });
  return Object.freeze({ facts, recovery: restartEvidence });
}

async function pollPending({ runner, created, deadline, now, sleep, pollIntervalMs, onProgress, readInput, phase }) {
  const poller = createAdaptivePoller({ baseIntervalMs: pollIntervalMs });
  while (now() < deadline) {
    try {
      const pending = validatePending(await runner.observePendingHuman(await readInput(phase)), created.rootIssueId);
      if (pending) {
        onProgress({ phase, status: pending.status });
        return pending;
      }
      await pause(deadline, now, sleep, poller, pending);
      continue;
    } catch (error) {
      if (!TRANSIENT_PENDING_ERRORS.has(reason(error))) throw error;
      onProgress({ phase, reason: reason(error) });
      await pause(deadline, now, sleep, poller, reason(error));
    }
  }
  throw new Error("target_restart_recovery_timeout");
}

async function pollFacts({ runner, created, deadline, now, sleep, pollIntervalMs, onProgress, readInput }) {
  const poller = createAdaptivePoller({ baseIntervalMs: pollIntervalMs });
  while (now() < deadline) {
    try {
      const observed = await runner.observeRoot(await readInput("durable_facts_after_restart"));
      const facts = observed?.facts;
      if (facts?.root?.rootIssueId === created.rootIssueId && facts.root.projectId === created.projectId) {
        onProgress({ phase: "durable_facts_after_restart", status: "observed" });
        return facts;
      }
      throw new Error("target_restart_recovery_facts_invalid");
    } catch (error) {
      if (reason(error) !== "target_restart_recovery_facts_pending") throw error;
      onProgress({ phase: "durable_facts_after_restart", reason: reason(error) });
      await pause(deadline, now, sleep, poller, reason(error));
    }
  }
  throw new Error("target_restart_recovery_timeout");
}

function validateDependencies({ runner, boundary, observationInput, humanResponseBody, timeoutMs, pollIntervalMs, sleep, now, onProgress, readObservationInput }) {
  if (typeof runner?.createRoot !== "function" || typeof runner?.observePendingHuman !== "function" ||
      typeof runner?.appendHumanResponse !== "function" || typeof runner?.observeRoot !== "function" ||
      typeof boundary?.restart !== "function") {
    throw new Error("target_restart_recovery_boundary_invalid");
  }
  validateObservationInput(observationInput);
  if (typeof humanResponseBody !== "string" || humanResponseBody.trim().length === 0 || humanResponseBody.length > 8_192) {
    throw new Error("target_restart_recovery_human_body_invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 300_000 ||
      typeof sleep !== "function" || typeof now !== "function" || typeof onProgress !== "function" ||
      typeof readObservationInput !== "function") {
    throw new Error("target_restart_recovery_timing_invalid");
  }
}

function validateRootResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !SAFE_ID.test(value.rootIssueId ?? "") || !SAFE_ID.test(value.projectId ?? "")) {
    throw new Error("target_restart_recovery_root_invalid");
  }
  return value;
}

function validateObservationInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![...Object.keys(value)].every((key) => OBSERVATION_FIELDS.has(key)) ||
      !SHA.test(value.git?.head ?? "") || !SAFE_ID.test(value.git?.branch ?? "")) {
    throw new Error("target_restart_recovery_observation_invalid");
  }
  return value;
}

function validatePending(value, rootIssueId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.status !== "waiting" ||
      value.rootIssueId !== rootIssueId || value.requestKind !== "needs_approval" ||
      !SAFE_ID.test(value.rootIssueId ?? "") || !SAFE_ID.test(value.cycleIssueId ?? "") ||
      !SAFE_ID.test(value.nodeIssueId ?? "") || !SAFE_ID.test(value.actionId ?? "") ||
      !DIGEST.test(value.contextDigest ?? "")) {
    throw new Error("target_restart_recovery_pending_invalid");
  }
  return value;
}

function validateRestartEvidence(value) {
  const fields = new Set([
    "instanceId", "restarted", "rebuiltFromLinearAndGit", "freshContextUsed",
    "staleResultRejected", "recoveredExecutionId",
  ]);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![...Object.keys(value)].every((key) => fields.has(key)) ||
      !SAFE_ID.test(value.instanceId ?? "") || value.restarted !== true ||
      value.rebuiltFromLinearAndGit !== true || value.freshContextUsed !== true ||
      value.staleResultRejected !== true || !SAFE_ID.test(value.recoveredExecutionId ?? "")) {
    throw new Error("target_restart_recovery_evidence_invalid");
  }
  return Object.freeze({
    restarted: true,
    rebuiltFromLinearAndGit: true,
    freshContextUsed: true,
    staleResultRejected: true,
    recoveredExecutionId: value.recoveredExecutionId,
    instanceId: value.instanceId,
  });
}

function samePending(left, right) {
  return ["rootIssueId", "cycleIssueId", "nodeIssueId", "requestKind", "actionId", "contextDigest"]
    .every((key) => left[key] === right[key]);
}

async function pause(deadline, now, sleep, poller, value) {
  const remaining = deadline - now();
  if (remaining > 0) await sleep(Math.min(poller.observe(value), remaining));
}

function reason(error) {
  return error instanceof Error ? error.message : "target_restart_recovery_failed";
}
