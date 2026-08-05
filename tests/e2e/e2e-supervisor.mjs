import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { blocked, runnerError, safeReason } from "./black-box-runner.mjs";
import { runGoldenScenario } from "./golden-runner.mjs";
import { partitionBoundaryEnvironment, readDotEnv, runIndividualBoundaries } from "./real-boundary-runners.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ENV_PATH = path.join(REPOSITORY_ROOT, ".env");
const DEFAULT_TEST_FILES = Object.freeze([
  path.join(REPOSITORY_ROOT, "tests/e2e/black-box-runner.test.mjs"),
  path.join(REPOSITORY_ROOT, "tests/e2e/deterministic-scenarios.test.mjs"),
  path.join(REPOSITORY_ROOT, "tests/e2e/real-boundary-runners.test.mjs"),
  path.join(REPOSITORY_ROOT, "tests/e2e/golden-runner.test.mjs"),
]);
export const MAX_E2E_DURATION_MS = 4 * 60_000 + 30_000;

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
    executeEnvironment: partitionBoundaryEnvironment(environment, "execute", inherited),
    auditEnvironment: partitionBoundaryEnvironment(environment, "audit", inherited),
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

async function runWithDeadline(operation, timeoutMs) {
  if (timeoutMs < 1) return { timedOut: true };
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    Promise.resolve()
      .then(operation)
      .then((value) => settle({ value }), (error) => settle({ error }));
  });
}

function runTests(testFiles, environment, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...testFiles], {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: "inherit",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, reason: "e2e_runner_start_failed" });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), signal, ...(timedOut ? { reason: "e2e_timeout" } : {}) });
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
} = {}) {
  if (typeof envPath !== "string" || !validPath(path.resolve(envPath))
    || !Array.isArray(testFiles) || testFiles.length === 0 || testFiles.some((file) => !validPath(file))) {
    throw runnerError("invalid_e2e_configuration");
  }
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > MAX_E2E_DURATION_MS) {
    throw runnerError("invalid_e2e_configuration");
  }
  const startedAt = Date.now();
  const phase = (operation) => runWithDeadline(
    operation,
    Math.max(0, maxDurationMs - (Date.now() - startedAt)),
  );
  const configuration = await loadConfiguration(path.resolve(envPath), inherited);
  const localEnvironment = configuration.partitions.testEnvironment;
  const localRun = await phase(() => (typeof runTestsOverride === "function"
    ? runTestsOverride(testFiles, localEnvironment, Math.max(1, maxDurationMs - (Date.now() - startedAt)))
    : runTests(testFiles, localEnvironment, Math.max(1, maxDurationMs - (Date.now() - startedAt)))));
  if (localRun.timedOut) return timeoutResult();
  if (localRun.error !== undefined) throw localRun.error;
  const testResult = localRun.value;
  if (testResult.code !== 0) return Object.freeze(testResult);

  const boundariesRun = await phase(() => runBoundaries({
    environment: configuration.environment,
    inheritedEnvironment: inherited,
  }));
  if (boundariesRun.timedOut) return timeoutResult();
  if (boundariesRun.error !== undefined) throw boundariesRun.error;
  const individualResults = boundariesRun.value;
  const goldenRun = await phase(() => runGolden({
    environment: configuration.environment,
    inheritedEnvironment: inherited,
  }));
  if (goldenRun.timedOut) return timeoutResult();
  if (goldenRun.error !== undefined) throw goldenRun.error;
  const goldenResult = goldenRun.value;
  const boundaryResults = Object.freeze([
    ...individualResults,
    goldenResult,
  ]);
  const boundaryFailed = boundaryResults.some((result) => result.status === "failed");
  const blockedResults = [
    ...(configuration.envBlocked === undefined ? [] : [configuration.envBlocked]),
    ...individualResults.filter((result) => result.status === "blocked" && !(goldenResult.status === "passed"
      && result.boundary === "linear"
      && result.reason === "root_input_missing")),
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

async function main() {
  try {
    const result = await runSupervisor();
    if (result.boundary_results !== undefined) {
      process.stdout.write(`${JSON.stringify({
        status: result.code !== 0 ? "failed" : result.blocked === undefined ? "passed" : "blocked",
        boundaries: result.boundary_results,
      })}\n`);
    }
    process.exitCode = result.code ?? 1;
  } catch (error) {
    process.stderr.write(`${safeReason(error, "e2e_supervisor_failed")}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
