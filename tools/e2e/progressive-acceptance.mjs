import { randomUUID } from "node:crypto";
import path from "node:path";

import { loadForegroundE2EConfig } from "./campaign-config.mjs";
import { createForegroundE2EEnvironment, installForegroundE2ESignalCleanup } from "./environment.mjs";
import { createForegroundE2EHumanActor } from "./human.mjs";
import { createForegroundReporter } from "./reporter.mjs";

const SUPPORTED_LEVELS = Object.freeze(["L0", "L1", "L2", "L3", "L4"]);
const DEFAULT_LEVEL_DEADLINE_MS = Object.freeze({ L0: 120_000, L1: 120_000, L2: 120_000, L3: 120_000, L4: 120_000 });
const SEMANTIC_GATE_INTENTS = new Set([
  "requirement_and_comment",
  "plan_human_decision",
  "recovery_strategy",
  "terminal_review",
]);

const DEFAULT_DEPENDENCIES = Object.freeze({
  loadConfig: loadForegroundE2EConfig,
  createReporter: createForegroundReporter,
  createEnvironment: createForegroundE2EEnvironment,
  createHuman: createForegroundE2EHumanActor,
  installSignalCleanup: installForegroundE2ESignalCleanup,
  randomUUID,
  now: () => performance.now(),
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
});

export async function runProgressiveAcceptance({
  targetLevel = "L1",
  environment = process.env,
  dependencies = {},
  signals = process,
  levelDeadlineMs = DEFAULT_LEVEL_DEADLINE_MS,
} = {}) {
  const operations = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  assertInput({ targetLevel, environment, operations, signals, levelDeadlineMs });
  const config = operations.loadConfig({ environment });
  const startedAt = operations.now();
  const reporter = operations.createReporter({
    campaignId: operations.randomUUID(),
    secrets: Object.values(config.secrets ?? {}),
    elapsedMs: () => elapsed(startedAt, operations.now()),
  });
  const runAbort = new AbortController();
  let activeEnvironment;
  let observations;
  let admittedRootIssueId;
  let signalCleanup;
  const levels = [];
  try {
    signalCleanup = operations.installSignalCleanup({
      signals,
      abortController: runAbort,
      reporter,
      cleanup: async () => undefined,
    });
    const l0 = await runLevel("L0", levelDeadlineMs.L0, runAbort.signal, operations, reporter, async (signal) => {
      activeEnvironment = await operations.createEnvironment({
        config,
        reporter,
        signal,
        repositoryCount: 1,
      });
      assertFocusedEnvironment(activeEnvironment);
    });
    levels.push(l0);
    if (targetLevel === "L0" || l0.verdict !== "passed") return result(targetLevel, levels);

    observations = createBoundedObservationCollector(activeEnvironment.runtime);
    const l1 = await runLevel("L1", levelDeadlineMs.L1, runAbort.signal, operations, reporter, async (signal) => {
      const conductor = activeEnvironment.runtime.conductors[0];
      const human = await operations.createHuman({
        apiKey: config.secrets.linearHumanApiKey,
        expectedActorId: activeEnvironment.actors.humanActorId,
        delegateActorId: activeEnvironment.project.delegateActorId,
      });
      const binding = await human.resolveFocusedRootCreationBinding({
        rootKey: "approved-root",
        teamId: activeEnvironment.project.teamId,
        projectId: activeEnvironment.project.projectId,
        conductor: {
          conductorRef: "conductor-a",
          conductorId: conductor.conductorId,
          conductorShortHash: conductor.conductorShortHash,
          performerProfileId: conductor.profileId,
          worktreeDirectory: path.join(conductor.dataRoot, "worktrees"),
        },
      });
      const admission = await human.admitRootIssues({
        rootCreationsByRootKey: { "approved-root": binding },
        signal,
      });
      admittedRootIssueId = admission?.rootsByKey?.["approved-root"]?.rootIssueId;
      if (!identifier(admittedRootIssueId)) throw stableError("progressive_acceptance_root_admission_invalid");
      await observations.waitFor((observation) =>
        observation.runtimeEvent === "root_candidate_selected" &&
        observation.conductorId === conductor.conductorId &&
        observation.rootIssueId === admittedRootIssueId,
      signal);
    });
    levels.push(l1);
    if (targetLevel === "L1" || l1.verdict !== "passed") return result(targetLevel, levels);

    const l2 = await runLevel("L2", levelDeadlineMs.L2, runAbort.signal, operations, reporter, async (signal) => {
      const conductor = activeEnvironment.runtime.conductors[0];
      const observation = await observations.waitFor((candidate) =>
        candidate.runtimeEvent === "root_turn_validated" &&
        candidate.conductorId === conductor.conductorId &&
        candidate.rootIssueId === admittedRootIssueId,
      signal);
      if (observation.contractFamily !== "semantic_gate" ||
          !SEMANTIC_GATE_INTENTS.has(observation.intentKind)) {
        throw stableError("progressive_acceptance_l2_contract_not_gate_specific");
      }
    });
    levels.push(l2);
    if (targetLevel === "L2" || l2.verdict !== "passed") return result(targetLevel, levels);

    const l3 = await runLevel("L3", levelDeadlineMs.L3, runAbort.signal, operations, reporter, async (signal) => {
      const conductor = activeEnvironment.runtime.conductors[0];
      await observations.waitFor((candidate) =>
        candidate.runtimeEvent === "root_initial_execution_read_back" &&
        candidate.conductorId === conductor.conductorId &&
        candidate.rootIssueId === admittedRootIssueId &&
        identifier(candidate.cycleIssueId) && identifier(candidate.planIssueId),
      signal);
    });
    levels.push(l3);
    if (targetLevel === "L3" || l3.verdict !== "passed") return result(targetLevel, levels);

    const l4 = await runLevel("L4", levelDeadlineMs.L4, runAbort.signal, operations, reporter, async (signal) => {
      const conductor = activeEnvironment.runtime.conductors[0];
      await observations.waitFor((candidate) =>
        candidate.runtimeEvent === "plan_dag_seal_read_back" &&
        candidate.conductorId === conductor.conductorId &&
        candidate.rootIssueId === admittedRootIssueId &&
        identifier(candidate.cycleIssueId) && identifier(candidate.planIssueId) &&
        sealDigest(candidate.sealDigest),
      signal);
    });
    levels.push(l4);
    return result(targetLevel, levels);
  } finally {
    observations?.close();
    signalCleanup?.dispose?.();
    await activeEnvironment?.close?.();
    reporter.close();
  }
}

async function runLevel(level, deadlineMs, parentSignal, operations, reporter, operation) {
  const startedAt = operations.now();
  const controller = new AbortController();
  let timer;
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
  const onParentAbort = () => {
    controller.abort("progressive_acceptance_interrupted");
    rejectInterrupted(stableError("progressive_acceptance_interrupted"));
  };
  if (parentSignal.aborted) onParentAbort();
  else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  let verdict = "passed";
  let reasonCodes = [];
  try {
    await Promise.race([
      operation(controller.signal),
      interrupted,
      new Promise((_, reject) => {
        timer = operations.setTimeout(() => {
          controller.abort("progressive_acceptance_level_timeout");
          reject(stableError("progressive_acceptance_level_timeout"));
        }, deadlineMs);
      }),
    ]);
  } catch (error) {
    const reasonCode = safeProgressiveReasonCode(error?.code)
      ? error.code
      : "progressive_acceptance_level_failed";
    verdict = reasonCode.endsWith("_timeout") ? "incomplete" : "failed";
    reasonCodes = [reasonCode];
  } finally {
    if (timer !== undefined) operations.clearTimeout(timer);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
  const value = Object.freeze({
    level,
    verdict,
    reasonCodes: Object.freeze(reasonCodes),
    elapsedMs: elapsed(startedAt, operations.now()),
  });
  reporter.acceptanceVerdict(value);
  return value;
}

function createBoundedObservationCollector(runtime) {
  const retained = [];
  const waiters = new Set();
  const unsubscribe = runtime.subscribeObservation((observation) => {
    if (!observation || typeof observation !== "object") return;
    if (retained.length === 16) retained.shift();
    retained.push(observation);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(observation)) waiter.resolve(observation);
    }
  });
  return Object.freeze({
    waitFor(predicate, signal) {
      const existing = retained.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve(value) {
            cleanup();
            resolve(value);
          },
        };
        const onAbort = () => {
          cleanup();
          reject(stableError(
            signal.reason === "progressive_acceptance_interrupted"
              ? "progressive_acceptance_interrupted"
              : "progressive_acceptance_level_timeout",
          ));
        };
        const cleanup = () => {
          waiters.delete(waiter);
          signal.removeEventListener("abort", onAbort);
        };
        waiters.add(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    },
    close() {
      unsubscribe();
      retained.length = 0;
    },
  });
}

function assertFocusedEnvironment(value) {
  const conductor = value?.runtime?.conductors?.[0];
  if (!value || !identifier(value.project?.projectId) || !identifier(value.project?.teamId) ||
      !identifier(value.project?.delegateActorId) || !identifier(value.actors?.humanActorId) ||
      value.runtime?.conductors?.length !== 1 || !identifier(conductor?.conductorId) ||
      !shortHash(conductor?.conductorShortHash) || !identifier(conductor?.profileId) ||
      typeof conductor?.dataRoot !== "string" || !path.isAbsolute(conductor.dataRoot) ||
      typeof value.runtime.subscribeObservation !== "function" || typeof value.close !== "function") {
    throw stableError("progressive_acceptance_l0_readiness_invalid");
  }
}

function result(targetLevel, levels) {
  return Object.freeze({
    exitCode: levels.every(({ verdict }) => verdict === "passed") ? 0 : 1,
    targetLevel,
    levels: Object.freeze(levels),
  });
}

function assertInput({ targetLevel, environment, operations, signals, levelDeadlineMs }) {
  const targetIndex = SUPPORTED_LEVELS.indexOf(targetLevel);
  if (!SUPPORTED_LEVELS.includes(targetLevel) || !environment || typeof environment !== "object" ||
      !signals || typeof signals.once !== "function" || !levelDeadlineMs ||
      SUPPORTED_LEVELS.slice(0, targetIndex + 1)
        .some((level) => !Number.isSafeInteger(levelDeadlineMs[level]) || levelDeadlineMs[level] < 1) ||
      ["loadConfig", "createReporter", "createEnvironment", "createHuman", "installSignalCleanup",
        "randomUUID", "now", "setTimeout", "clearTimeout"].some((key) => typeof operations[key] !== "function")) {
    throw stableError("progressive_acceptance_input_invalid");
  }
}

function elapsed(startedAt, current) {
  const value = Math.max(0, Math.floor(current - startedAt));
  if (!Number.isSafeInteger(value)) throw stableError("progressive_acceptance_clock_invalid");
  return value;
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function shortHash(value) {
  return typeof value === "string" && /^[a-f0-9]{12}$/u.test(value);
}

function safeProgressiveReasonCode(value) {
  return typeof value === "string" && /^progressive_acceptance_[a-z0-9_]{1,96}$/u.test(value);
}

function sealDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
