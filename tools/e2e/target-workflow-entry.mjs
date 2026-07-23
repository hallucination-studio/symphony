import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isMissingInputConfiguration, loadE2EConfig } from "./config.mjs";
import { evaluateTargetWorkflowResults } from "./target-workflow-evidence.mjs";
import { TARGET_WORKFLOW_SCENARIOS } from "./target-workflow-verdict.mjs";
import { auditTargetWorkflowSources } from "./target-workflow-static-audit.mjs";
import {
  runTargetDeliveryLive,
  runTargetRepairLive,
  runTargetRestartLive,
  runTargetSchedulingLive,
  runTargetSuccessLive,
} from "./target-workflow-live.mjs";
import { prepareTargetWorkflowSetup, runIdentifiers } from "./target-workflow-setup.mjs";
import { createE2ELogger } from "./logging.mjs";
import { LinearRequestObserverImpl } from "@symphony/podium";
import {
  createPreparedSetupFile,
  removePreparedSetupFile,
  runTargetWorkflowScenarioProcess,
} from "./target-workflow-process.mjs";
import {
  createTargetWorkflowDeadline,
  remainingTargetWorkflowTimeout,
  withTargetWorkflowDeadline,
} from "./target-workflow-deadline.mjs";

const TARGET_E2E_TIMEOUT_MS = 5 * 60_000;
const TARGET_RATE_LIMIT_REASONS = new Set([
  "target_inputs_rate_limited",
  "target_transport_rate_limited",
  "target_live_rate_limited",
]);
const LIVE_SCENARIO_ARGUMENTS = Object.freeze({
  "--live-success": "success",
  "--live-repair": "repair",
  "--live-restart": "restart_recovery",
  "--live-delivery": "delivery",
  "--live-scheduling": "scheduling",
});

const TARGET_SOURCE_FILES = Object.freeze({
  runner: "tools/e2e/target-workflow-runner.mjs",
  inputs: "tools/e2e/target-workflow-inputs.mjs",
  transport: "tools/e2e/target-workflow-transport.mjs",
});

export async function runTargetWorkflowDryRun({ readSource = readFile } = {}) {
  const sources = {};
  for (const [name, file] of Object.entries(TARGET_SOURCE_FILES)) {
    sources[name] = await readSource(file, "utf8");
  }
  const staticAudit = auditTargetWorkflowSources(sources);
  if (!staticAudit.passed) throw new Error("target_entry_static_audit_failed");
  return Object.freeze({
    status: "dry_run",
    mutationAttempted: false,
    staticAudit,
    scenarios: Object.freeze(TARGET_WORKFLOW_SCENARIOS.map((scenario) => Object.freeze({
      scenario,
      status: "unverified",
    }))),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 3 && arguments_[0] === "--live-scenario" &&
      TARGET_WORKFLOW_SCENARIOS.includes(arguments_[1]) && arguments_[2] === "--setup-file") {
    process.stderr.write('{"status":"failed","reason":"target_entry_argument_invalid"}\n');
    process.exitCode = 2;
  } else if (arguments_.length === 4 && arguments_[0] === "--live-scenario" &&
      TARGET_WORKFLOW_SCENARIOS.includes(arguments_[1]) && arguments_[2] === "--setup-file") {
    runCliWithDeadline(({ deadlineAtMs, signal }) => readPreparedSetup(arguments_[3]).then((preparedSetup) =>
      runTargetWorkflowLive(arguments_[1], {
        deadlineAtMs,
        signal,
        preparedSetup,
        emitObservation: true,
      })))
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        process.stderr.write(`${JSON.stringify({
          status: isMissingInputConfiguration(error) ? "unverified" : "failed",
          reason: stableReason(error),
          ...(Array.isArray(error?.issues) ? { issues: error.issues } : {}),
        })}\n`);
        process.exitCode = 2;
      });
  } else if (arguments_.length !== 1 || arguments_[0] !== "--dry-run") {
    const liveScenario = arguments_.length === 1
      ? LIVE_SCENARIO_ARGUMENTS[arguments_[0]]
      : undefined;
    if (liveScenario) {
      runCliWithDeadline(({ deadlineAtMs, signal }) => runTargetWorkflowLive(liveScenario, { deadlineAtMs, signal }))
        .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
        .catch((error) => {
          process.stderr.write(`${JSON.stringify({
            status: isMissingInputConfiguration(error) ? "unverified" : "failed",
            reason: stableReason(error),
            ...(Array.isArray(error?.issues) ? { issues: error.issues } : {}),
          })}\n`);
          process.exitCode = 2;
        });
    } else if (arguments_.length === 1 && arguments_[0] === "--live-all") {
      runCliWithDeadline(({ deadlineAtMs, signal }) => runTargetWorkflowLive("all", { deadlineAtMs, signal }))
        .then((result) => {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          process.exitCode = targetWorkflowCliExitCode(result);
        })
        .catch((error) => {
          process.stderr.write(`${JSON.stringify({
            status: isMissingInputConfiguration(error) ? "unverified" : "failed",
            reason: stableReason(error),
            ...(Array.isArray(error?.issues) ? { issues: error.issues } : {}),
          })}\n`);
          process.exitCode = 2;
        });
    } else {
      process.stderr.write('{"status":"failed","reason":"target_entry_argument_invalid"}\n');
      process.exitCode = 2;
    }
  } else {
    runTargetWorkflowDryRun()
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        process.stderr.write(`${JSON.stringify({
          status: "failed",
          reason: stableReason(error),
        })}\n`);
        process.exitCode = 2;
      });
  }
}

function runCliWithDeadline(run) {
  const deadlineAtMs = createTargetWorkflowDeadline(TARGET_E2E_TIMEOUT_MS);
  const abortController = new AbortController();
  let finished = false;
  const hardTimer = setTimeout(() => {
    if (finished) return;
    process.stderr.write('{"status":"failed","reason":"target_entry_timeout"}\n');
    abortController.abort();
    process.exit(124);
  }, TARGET_E2E_TIMEOUT_MS);
  return withTargetWorkflowDeadline(
    () => run({ deadlineAtMs, signal: abortController.signal }),
    deadlineAtMs,
    { errorCode: "target_entry_timeout", onTimeout: () => abortController.abort() },
  ).finally(() => {
    finished = true;
    clearTimeout(hardTimer);
    abortController.abort();
  });
}

async function runTargetWorkflowLive(scenario = "success", {
  deadlineAtMs,
  signal,
  preparedSetup,
  emitObservation = false,
} = {}) {
  const config = loadE2EConfig();
  if (!config.linear.projectSlugId) {
    const error = new Error("e2e_configuration_invalid");
    error.code = "e2e_configuration_invalid";
    error.issues = ["target_project_slug_id_missing"];
    throw error;
  }
  const observer = new LinearRequestObserverImpl();
  const log = createE2ELogger({
    runId: process.env.SYMPHONY_E2E_RUN_ID,
    secrets: [config.secrets.linearDevToken, config.secrets.codexApiKey],
  });
  const effectiveDeadlineAtMs = deadlineAtMs ?? createTargetWorkflowDeadline(TARGET_E2E_TIMEOUT_MS);
  const effectiveSignal = signal ?? AbortSignal.timeout(remainingTargetWorkflowTimeout(effectiveDeadlineAtMs));
  let result;
  if (preparedSetup !== undefined && scenario !== "all") {
    result = await runPreparedTargetWorkflowScenario(scenario, {
      config,
      environment: process.env,
      fetch: globalThis.fetch,
      log,
      observer,
      setup: preparedSetup,
      deadlineAtMs: effectiveDeadlineAtMs,
      signal: effectiveSignal,
    });
  } else if (scenario === "repair") {
    result = await runTargetRepairLive({ config, observer, log, deadlineAtMs: effectiveDeadlineAtMs, signal: effectiveSignal });
  } else if (scenario === "delivery") {
    result = await runTargetDeliveryLive({ config, observer, log, deadlineAtMs: effectiveDeadlineAtMs, signal: effectiveSignal });
  } else if (scenario === "restart_recovery") {
    result = await runTargetRestartLive({ config, observer, log, deadlineAtMs: effectiveDeadlineAtMs, signal: effectiveSignal });
  } else if (scenario === "scheduling") {
    result = await runTargetSchedulingLive({ config, observer, log, deadlineAtMs: effectiveDeadlineAtMs, signal: effectiveSignal });
  } else if (scenario === "all") {
    result = await runTargetWorkflowAllLive({ config, observer, log, deadlineAtMs: effectiveDeadlineAtMs, signal: effectiveSignal });
  } else {
    result = await runTargetSuccessLive({ config, observer, log, deadlineAtMs: effectiveDeadlineAtMs, signal: effectiveSignal });
  }
  return emitObservation ? Object.freeze({ result, observation: observer.snapshot() }) : result;
}

async function runPreparedTargetWorkflowScenario(scenario, input) {
  return withTargetWorkflowDeadline(
    () => defaultRunScenario(scenario, {
      ...input,
      environment: process.env,
      timeoutMs: remainingTargetWorkflowTimeout(input.deadlineAtMs),
      deadlineAtMs: input.deadlineAtMs,
      setup: input.setup,
    }),
    input.deadlineAtMs,
    { errorCode: "target_scenario_timeout", onTimeout: () => input.signal?.throwIfAborted?.() },
  );
}

async function readPreparedSetup(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) throw stableError("target_scenario_setup_invalid");
  try {
    const preparedSetup = JSON.parse(await readFile(filePath, "utf8"));
    if (!preparedSetup || typeof preparedSetup !== "object" || Array.isArray(preparedSetup)) {
      throw new Error();
    }
    return preparedSetup;
  } catch {
    throw stableError("target_scenario_setup_read_failed");
  }
}

export async function runTargetWorkflowAllLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  runScenarioProcess = runTargetWorkflowScenarioProcess,
  prepareSetup = prepareTargetWorkflowSetup,
  observer = new LinearRequestObserverImpl(),
  timeoutMs = TARGET_E2E_TIMEOUT_MS,
  deadlineAtMs: suppliedDeadlineAtMs,
  signal: suppliedSignal,
  now = Date.now,
  writeEvidence = true,
  evidenceDirectory,
} = {}) {
  if (!config?.linear?.projectSlugId) throw stableError("target_all_configuration_invalid");
  if (!environment || typeof environment !== "object" ||
      typeof runScenarioProcess !== "function" ||
      typeof prepareSetup !== "function" || typeof fetch !== "function" || typeof log !== "function" ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TARGET_E2E_TIMEOUT_MS ||
      typeof now !== "function") {
    throw stableError("target_all_input_invalid");
  }
  const deadline = suppliedDeadlineAtMs ?? now() + timeoutMs;
  remainingTargetWorkflowTimeout(deadline, now);
  const signal = suppliedSignal ?? AbortSignal.timeout(Math.ceil(remainingTargetWorkflowTimeout(deadline, now)));
  const preparedSetup = await withTargetWorkflowDeadline(() => prepareSetup({
    config,
    runId: environment.SYMPHONY_E2E_RUN_ID,
    poolMode: "parallel",
    fetch,
    log,
    observer,
    signal,
  }), deadline, { now, errorCode: "target_all_timeout" });
  const observationEvidence = { setup: observer.snapshot(), scenarios: {} };
  const scenarioController = new AbortController();
  const scenarioSignal = AbortSignal.any([signal, scenarioController.signal]);
  const setupFile = await withTargetWorkflowDeadline(() => createPreparedSetupFile(preparedSetup), deadline, {
    now, errorCode: "target_all_timeout",
  });
  let results;
  let cleanupCompleted = true;
  try {
    results = await Promise.all(TARGET_WORKFLOW_SCENARIOS.map(async (scenario) => {
    const scenarioDeadline = Math.min(deadline, now() + TARGET_E2E_TIMEOUT_MS);
    const childController = new AbortController();
    const childSignal = AbortSignal.any([scenarioSignal, childController.signal]);
    try {
      const outcome = await withTargetWorkflowDeadline(() => {
        remainingTargetWorkflowTimeout(scenarioDeadline, now);
        return runScenarioProcess({
          scenario,
          setupFile: setupFile.filePath,
          environment,
          deadlineAtMs: scenarioDeadline,
          signal: childSignal,
        });
      }, scenarioDeadline, {
        now,
        errorCode: "target_scenario_timeout",
        onTimeout: () => childController.abort(),
      });
      const result = outcome.result;
      const scenarioObservation = outcome.observation;
      if (outcome.cleanupCompleted !== true) cleanupCompleted = false;
      if (!result || typeof result !== "object" || result.scenario !== scenario) {
        throw stableError("target_all_scenario_result_invalid");
      }
      const rateLimited = isTargetRateLimited(undefined, scenarioObservation);
      observationEvidence.scenarios[scenario] = scenarioObservation;
      if (rateLimited) {
        observer.observe({ status: 429 });
        scenarioController.abort();
      }
      return rateLimited
        ? Object.freeze({ ...result, status: "failed", reason: "target_rate_limited" })
        : result;
    } catch (error) {
      cleanupCompleted = false;
      observationEvidence.scenarios[scenario] = error?.observation ?? { status: "invalid" };
      if (isTargetRateLimited(error, observationEvidence.scenarios[scenario])) {
        observer.observe({ status: 429 });
        scenarioController.abort();
      }
      return Object.freeze({
        scenario,
        status: "failed",
        reason: isTargetRateLimited(error, observationEvidence.scenarios[scenario])
          ? "target_rate_limited"
          : stableReason(error),
      });
    } finally {
      childController.abort();
    }
    }));
  } finally {
    scenarioController.abort();
    if (setupFile) await removePreparedSetupFile(setupFile).catch(() => {});
  }
  observationEvidence.total = aggregateObservationEvidence(observationEvidence);
  const evaluated = evaluateTargetWorkflowResults({ results, cleanupCompleted, setup: preparedSetup, observationEvidence }, {
    secrets: [config.secrets?.linearDevToken, config.secrets?.codexApiKey],
  });
  const result = Object.freeze({
    status: evaluated.verdict.verdict,
    runId: environment.SYMPHONY_E2E_RUN_ID,
    evidence: evaluated.evidence,
    verdict: evaluated.verdict,
    observation: observationEvidence.total,
  });
  if (writeEvidence) await persistTargetWorkflowEvidence(result, evidenceDirectory);
  return result;
}

export function targetWorkflowCliExitCode(result) {
  if (result?.status === "passed") return 0;
  if (result?.status === "unverified") return 2;
  return 1;
}

async function persistTargetWorkflowEvidence(result, evidenceDirectory) {
  const runId = result.runId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId ?? "")) {
    throw stableError("target_all_run_id_invalid");
  }
  const directory = evidenceDirectory ?? path.resolve(".test", "e2e-target-workflow", runId);
  if (typeof directory !== "string" || directory.length === 0) throw stableError("target_all_evidence_path_invalid");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, "verdict.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
  } catch {
    throw stableError("target_all_evidence_write_failed");
  }
}

function isTargetRateLimited(error, observer) {
  return TARGET_RATE_LIMIT_REASONS.has(error?.message) || observer?.rateLimited === true;
}

function aggregateObservationEvidence(evidence) {
  const snapshots = [evidence.setup, ...TARGET_WORKFLOW_SCENARIOS.map((scenario) => evidence.scenarios[scenario])];
  const validSnapshots = snapshots.filter((snapshot) => snapshot && typeof snapshot === "object");
  const latestWindow = (name) => [...validSnapshots].reverse().find((snapshot) => snapshot?.[name])?.[name];
  return Object.freeze({
    logicalOperations: validSnapshots.reduce((total, snapshot) => total + (snapshot.logicalOperations ?? 0), 0),
    physicalRequests: validSnapshots.reduce((total, snapshot) => total + (snapshot.physicalRequests ?? 0), 0),
    complexityConsumed: validSnapshots.reduce((total, snapshot) => total + (snapshot.complexityConsumed ?? 0), 0),
    rateLimited: validSnapshots.some((snapshot) => snapshot.rateLimited === true),
    ...(latestWindow("requestWindow") ? { requestWindow: { ...latestWindow("requestWindow") } } : {}),
    ...(latestWindow("complexityWindow") ? { complexityWindow: { ...latestWindow("complexityWindow") } } : {}),
  });
}

async function defaultRunScenario(scenario, { setup, observer, timeoutMs, deadlineAtMs, signal, ...input }) {
  const composed = composeTargetWorkflowScenarioInput(scenario, {
    setup,
    environment: input.environment,
  });
  const scenarioSetup = composed.setup;
  const dependencies = { prepareSetup: async () => scenarioSetup };
  const scenarioInput = {
    ...input,
    environment: composed.environment,
  };
  if (scenario === "success") return runTargetSuccessLive({ ...scenarioInput, observer, timeoutMs, deadlineAtMs, signal, dependencies });
  if (scenario === "repair_escalation") return runTargetRepairLive({ ...scenarioInput, observer, timeoutMs, deadlineAtMs, signal, dependencies });
  if (scenario === "restart_recovery") return runTargetRestartLive({ ...scenarioInput, observer, timeoutMs, deadlineAtMs, signal, dependencies });
  if (scenario === "delivery") return runTargetDeliveryLive({ ...scenarioInput, observer, timeoutMs, deadlineAtMs, signal, dependencies });
  return runTargetSchedulingLive({ ...scenarioInput, observer, timeoutMs, deadlineAtMs, signal, dependencies });
}

export function composeTargetWorkflowScenarioInput(scenario, { setup, environment } = {}) {
  if (typeof scenario !== "string" || !environment || typeof environment.SYMPHONY_E2E_RUN_ID !== "string") {
    throw stableError("target_all_scenario_composition_invalid");
  }
  const scenarioSuffix = `-${scenario}`;
  const scenarioRunId = `${environment.SYMPHONY_E2E_RUN_ID.slice(0, 128 - scenarioSuffix.length)}${scenarioSuffix}`;
  const scenarioIds = runIdentifiers(scenarioRunId);
  return Object.freeze({
    setup: Object.freeze({
      ...setup,
      ids: Object.freeze({ ...setup?.ids, ...scenarioIds }),
      ...(setup?.rootInput ? {
        rootInput: Object.freeze({
          ...setup.rootInput,
          conductorShortHash: scenarioIds.conductorShortHash,
          title: `${setup.rootInput.title} [${scenario}]`,
          description: `${setup.rootInput.description} Scenario correlation: ${scenarioRunId}.`,
        }),
      } : {}),
    }),
    environment: Object.freeze({ ...environment, SYMPHONY_E2E_RUN_ID: scenarioRunId }),
  });
}

function stableReason(error) {
  return typeof error?.message === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(error.message)
    ? error.message
    : "target_entry_failed";
}
