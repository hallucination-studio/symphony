import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { blocked, runnerError, safeReason } from "./black-box-runner.mjs";
import { runGoldenScenario } from "./golden-runner.mjs";
import { partitionBoundaryEnvironment, readDotEnv, runIndividualBoundaries } from "./real-boundary-runners.mjs";
import { assertScenario, selectedScenarios } from "./scenario-catalog.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ENV_PATH = path.join(REPOSITORY_ROOT, ".env");
const DEFAULT_TEST_FILES = Object.freeze([
  path.join(REPOSITORY_ROOT, "tests/e2e/black-box-runner.test.mjs"),
  path.join(REPOSITORY_ROOT, "tests/e2e/deterministic-scenarios.test.mjs"),
  path.join(REPOSITORY_ROOT, "tests/e2e/real-boundary-runners.test.mjs"),
  path.join(REPOSITORY_ROOT, "tests/e2e/golden-runner.test.mjs"),
]);
export const MAX_E2E_DURATION_MS = 6 * 60_000;
export const MAX_E2E_SCENARIO_DURATION_MS = 5 * 60_000;
export const E2E_CLEANUP_GRACE_MS = 15_000;
const GOLDEN_COVERED_BOUNDARIES = new Set(["linear", "codex", "git", "pr"]);

export function parseScenarioArgs(arguments_ = []) {
  if (!Array.isArray(arguments_)) throw new Error("invalid_e2e_configuration");
  let scenario;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--scenario") {
      if (scenario !== undefined || typeof arguments_[index + 1] !== "string") {
        throw new Error("invalid_e2e_scenario");
      }
      scenario = arguments_[++index];
    } else if (argument.startsWith("--scenario=")) {
      if (scenario !== undefined) throw new Error("invalid_e2e_scenario");
      scenario = argument.slice("--scenario=".length);
    } else {
      throw new Error("invalid_e2e_scenario");
    }
  }
  if (scenario !== undefined) assertScenario(scenario);
  return scenario;
}

function inheritedEnvironment(environment) {
  return Object.fromEntries([
    "HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "TMP", "TMPDIR", "TEMP", "USER", "XDG_CONFIG_HOME",
  ].flatMap((key) => environment?.[key] === undefined ? [] : [[key, environment[key]]]));
}

export function partitionEnvironment(environment, inherited = process.env) {
  const base = inheritedEnvironment(inherited);
  return Object.freeze({
    testEnvironment: Object.freeze({ ...base }),
    linearEnvironment: partitionBoundaryEnvironment(environment, "linear", inherited),
    reconcileEnvironment: partitionBoundaryEnvironment(environment, "reconcile", inherited),
    artistEnvironment: partitionBoundaryEnvironment(environment, "artist", inherited),
    criticEnvironment: partitionBoundaryEnvironment(environment, "critic", inherited),
    gitEnvironment: partitionBoundaryEnvironment({ ...inherited, ...environment }, "git", inherited),
    prEnvironment: partitionBoundaryEnvironment(environment, "pr", inherited),
  });
}

async function loadConfiguration(envPath, inherited) {
  try {
    const environment = await readDotEnv(envPath);
    const controls = Object.fromEntries([
      "SYMPHONY_RUN_REAL_BOUNDARIES", "SYMPHONY_RUN_GOLDEN",
    ].flatMap((key) => inherited?.[key] === undefined ? [] : [[key, inherited[key]]]));
    return Object.freeze({
      environment: Object.freeze({ ...environment, ...controls }),
      partitions: partitionEnvironment(environment, inherited),
      envBlocked: undefined,
    });
  } catch {
    return Object.freeze({
      environment: Object.freeze({}),
      partitions: partitionEnvironment({}, inherited),
      envBlocked: blocked("supervisor", "env_unavailable"),
    });
  }
}

function validPath(value) {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value) && !value.includes("\0");
}

function timeoutResult() {
  return Object.freeze({ code: 124, signal: null, reason: "e2e_timeout" });
}

function suppressCoveredBlockedBoundary(result, goldenResult, diagnosticsRequested) {
  return goldenResult.status === "passed"
    && !diagnosticsRequested
    && result.status === "blocked"
    && GOLDEN_COVERED_BOUNDARIES.has(result.boundary);
}

async function waitForCleanup(operationPromise, cleanupGraceMs) {
  let timer;
  try {
    await Promise.race([operationPromise, new Promise((resolve) => {
      timer = setTimeout(resolve, cleanupGraceMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runWithDeadline(operation, timeoutMs, cleanupGraceMs) {
  if (timeoutMs < 1) return { timedOut: true };
  const controller = new AbortController();
  let timeout;
  const operationPromise = Promise.resolve()
    .then(() => operation(controller.signal))
    .then((value) => ({ value }), (error) => ({ error }));
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const result = await Promise.race([operationPromise, timeoutPromise]);
  if (!result.timedOut) {
    clearTimeout(timeout);
    if (result.error !== undefined) {
      controller.abort();
      await waitForCleanup(operationPromise, cleanupGraceMs);
    }
    return result;
  }

  controller.abort();
  await waitForCleanup(operationPromise, cleanupGraceMs);
  return { timedOut: true };
}

function runTests(testFiles, environment, timeoutMs, signal) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...testFiles], {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: "inherit",
    });
    let timedOut = false;
    let forceKillTimer;
    let settled = false;
    const stop = () => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      forceKillTimer.unref();
    };
    const timer = setTimeout(() => {
      stop();
    }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.once("error", () => {
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", stop);
      resolve({ code: 1, reason: "e2e_runner_start_failed" });
    });
    child.once("exit", (code, exitSignal) => {
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", stop);
      resolve({ code: timedOut ? 124 : (code ?? 1), signal: exitSignal, ...(timedOut ? { reason: "e2e_timeout" } : {}) });
    });
  });
}

export async function runSupervisor({
  envPath = DEFAULT_ENV_PATH,
  testFiles = DEFAULT_TEST_FILES,
  inherited = process.env,
  maxDurationMs = MAX_E2E_DURATION_MS,
  runTests: runTestsOverride,
  runBoundaries = runIndividualBoundaries,
  runGolden = runGoldenScenario,
  scenario,
  runAllScenarios = runGolden === runGoldenScenario,
  cleanupGraceMs = E2E_CLEANUP_GRACE_MS,
  scenarioDurationMs = MAX_E2E_SCENARIO_DURATION_MS,
  onScenarioResult = () => undefined,
} = {}) {
  if (scenario !== undefined) assertScenario(scenario);
  if (typeof envPath !== "string" || !validPath(path.resolve(envPath))
    || !Array.isArray(testFiles) || testFiles.length === 0 || testFiles.some((file) => !validPath(file))) {
    throw runnerError("invalid_e2e_configuration");
  }
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > MAX_E2E_DURATION_MS) {
    throw runnerError("invalid_e2e_configuration");
  }
  if (!Number.isSafeInteger(cleanupGraceMs) || cleanupGraceMs < 1 || cleanupGraceMs > E2E_CLEANUP_GRACE_MS) {
    throw runnerError("invalid_e2e_configuration");
  }
  if (!Number.isSafeInteger(scenarioDurationMs)
    || scenarioDurationMs <= cleanupGraceMs
    || scenarioDurationMs > MAX_E2E_SCENARIO_DURATION_MS) {
    throw runnerError("invalid_e2e_configuration");
  }
  if (typeof onScenarioResult !== "function") throw runnerError("invalid_e2e_configuration");
  const startedAt = Date.now();
  const phase = (operation) => runWithDeadline(
    operation,
    Math.max(1, maxDurationMs - cleanupGraceMs - (Date.now() - startedAt)),
    cleanupGraceMs,
  );
  const configuration = await loadConfiguration(path.resolve(envPath), inherited);
  const localEnvironment = {
    ...configuration.partitions.testEnvironment,
    ...(scenario === undefined ? {} : { SYMPHONY_E2E_SCENARIO: scenario }),
  };
  const localRun = await phase((signal) => (typeof runTestsOverride === "function"
    ? runTestsOverride(testFiles, localEnvironment, Math.max(1, maxDurationMs - (Date.now() - startedAt)), signal)
    : runTests(testFiles, localEnvironment, Math.max(1, maxDurationMs - (Date.now() - startedAt)), signal)));
  if (localRun.timedOut) return timeoutResult();
  if (localRun.error !== undefined) throw localRun.error;
  const testResult = localRun.value;
  if (testResult.code !== 0) return Object.freeze(testResult);

  const boundariesRun = await phase((signal) => runBoundaries({
    environment: configuration.environment,
    inheritedEnvironment: inherited,
    signal,
  }));
  if (boundariesRun.timedOut) return timeoutResult();
  if (boundariesRun.error !== undefined) throw boundariesRun.error;
  const individualResults = boundariesRun.value;
  const goldenNames = runAllScenarios ? selectedScenarios(scenario) : [scenario];
  const goldenRun = await phase(async (suiteSignal) => Promise.all(goldenNames.map(async (selectedScenario) => {
    const run = await runWithDeadline(
      (scenarioSignal) => runGolden({
        scenario: selectedScenario,
        environment: configuration.environment,
        inheritedEnvironment: inherited,
        signal: AbortSignal.any([suiteSignal, scenarioSignal]),
      }),
      scenarioDurationMs,
      cleanupGraceMs,
    );
    const result = run.timedOut
      ? Object.freeze({ status: "failed", layer: "golden", scenario: selectedScenario, reason: "e2e_timeout" })
      : run.error !== undefined
        ? Object.freeze({ status: "failed", layer: "golden", scenario: selectedScenario, reason: safeReason(run.error) })
        : Object.freeze({
          ...run.value,
          ...(selectedScenario === undefined ? {} : { scenario: selectedScenario }),
        });
    onScenarioResult(result);
    return result;
  })));
  if (goldenRun.timedOut) return timeoutResult();
  if (goldenRun.error !== undefined) throw goldenRun.error;
  const results = goldenRun.value;
  const goldenResult = (() => {
    if (results.length === 1) return results[0];
    const failedScenario = results.find((result) => result.status === "failed");
    if (failedScenario !== undefined) {
      return Object.freeze({
        status: "failed",
        layer: "golden",
        reason: "golden_scenario_failed",
        scenario_results: Object.freeze(results),
      });
    }
    return Object.freeze({
      status: results.every((result) => result.status === "passed") ? "passed" : "blocked",
      layer: "golden",
      ...(results.every((result) => result.status === "passed") ? {} : { boundary: "golden", reason: "golden_scenarios_partial" }),
      scenario_results: Object.freeze(results),
    });
  })();
  const diagnosticsRequested = configuration.environment.SYMPHONY_RUN_REAL_BOUNDARIES === "1";
  const publishedIndividualResults = individualResults.filter((result) => !suppressCoveredBlockedBoundary(
    result,
    goldenResult,
    diagnosticsRequested,
  ));
  const boundaryResults = Object.freeze([
    ...publishedIndividualResults,
    goldenResult,
  ]);
  const boundaryFailed = boundaryResults.some((result) => result.status === "failed");
  const blockedResults = [
    ...(configuration.envBlocked === undefined ? [] : [configuration.envBlocked]),
    ...publishedIndividualResults.filter((result) => result.status === "blocked"),
    ...(goldenResult.status === "blocked" ? [goldenResult] : []),
  ].map(({ status, boundary, reason }) => ({ status, boundary, reason }));
  return Object.freeze({
    code: boundaryFailed ? 1 : 0,
    signal: null,
    boundary_results: boundaryResults,
    ...(boundaryFailed ? { reason: "e2e_boundary_failed" } : {}),
    ...(blockedResults.length === 0 ? {} : { blocked: Object.freeze(blockedResults) }),
  });
}

export function renderSupervisorResult(result) {
  if (result.boundary_results !== undefined) {
    return JSON.stringify({
      status: result.code !== 0 ? "failed" : result.blocked === undefined ? "passed" : "blocked",
      boundaries: result.boundary_results,
    });
  }
  if (result.code === 124) return JSON.stringify({ status: "failed", reason: result.reason });
  return undefined;
}

async function main() {
  try {
    const scenario = parseScenarioArgs(process.argv.slice(2));
    const result = await runSupervisor({
      scenario,
      onScenarioResult: (scenarioResult) => {
        process.stdout.write(`${JSON.stringify({ event: "e2e_scenario_completed", ...scenarioResult })}\n`);
      },
    });
    const rendered = renderSupervisorResult(result);
    if (rendered !== undefined) process.stdout.write(`${rendered}\n`);
    const code = result.code ?? 1;
    process.exitCode = code;
    setImmediate(() => process.exit(code));
  } catch (error) {
    process.stderr.write(`${safeReason(error, "e2e_supervisor_failed")}\n`);
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
