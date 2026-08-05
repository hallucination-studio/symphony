import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ENV_PATH = path.join(REPOSITORY_ROOT, ".env");
const DEFAULT_CONDUCTOR_ENTRY_PATH = path.join(REPOSITORY_ROOT, "apps/conductor/dist/main.js");
const DEFAULT_TEST_FILES = Object.freeze([
  path.join(REPOSITORY_ROOT, "tests/e2e/accepted-root.test.mjs"),
  path.join(REPOSITORY_ROOT, "tests/e2e/failure-scenarios.test.mjs"),
  path.join(REPOSITORY_ROOT, "tests/e2e/sealed-fact-scenarios.test.mjs"),
  path.join(REPOSITORY_ROOT, "tests/e2e/cleanup-scenario.test.mjs"),
]);
const MAX_ENV_BYTES = 64 * 1024;
const MAX_SECRET_LENGTH = 4096;
const STOP_TIMEOUT_MS = 10_000;
export const MAX_E2E_DURATION_MS = 4 * 60_000 + 30_000;
const E2E_TIMEOUT_EXIT_CODE = 124;
const FIXTURE_KEYS = Object.freeze([
  "SYMPHONY_E2E_LINEAR_HUMAN_TOKEN",
  "SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED",
  "SYMPHONY_E2E_PROJECT_SLUG_ID",
]);
const PRODUCT_KEYS = Object.freeze([
  "SYMPHONY_LINEAR_TOKEN",
  "SYMPHONY_CODEX_API_KEY",
  "SYMPHONY_CODEX_MODEL",
  "SYMPHONY_CODEX_BASE_URL",
  "SYMPHONY_LINEAR_EXCLUSIVE_MUTATION_ACTOR",
  "SYMPHONY_LINEAR_MANAGED_DESTRUCTION_PROHIBITED",
  "SYMPHONY_LINEAR_RELATION_PROVENANCE_AUDITED",
]);
const OPTIONAL_SHARED_KEYS = Object.freeze(["SYMPHONY_E2E_DIAGNOSTIC_EVENTS"]);
const RETIRED_KEYS = new Set(["SYMPHONY_E2E_CONDUCTOR_LAUNCHER_SOCKET"]);
const INHERITED_RUNTIME_KEYS = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SSH_AUTH_SOCK",
  "TMP",
  "TMPDIR",
  "TEMP",
  "USER",
  "XDG_CONFIG_HOME",
]);

class SupervisorError extends Error {
  constructor(code) {
    super(code);
    this.name = "SupervisorError";
    this.code = code;
  }
}

function supervisorError(code) {
  return new SupervisorError(code);
}

function requiredValue(environment, key) {
  const value = environment[key];
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_SECRET_LENGTH
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    })
  ) throw supervisorError("invalid_e2e_configuration");
  return value;
}

async function readEnvironment(envPath) {
  let handle;
  try {
    handle = await open(envPath, "r");
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || stat.size < 1
      || stat.size > MAX_ENV_BYTES
      || (stat.mode & 0o077) !== 0
    ) throw supervisorError("invalid_e2e_configuration");
    return parseEnv(await handle.readFile({ encoding: "utf8" }));
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    throw supervisorError("invalid_e2e_configuration");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function baseEnvironment(environment) {
  return Object.fromEntries(
    INHERITED_RUNTIME_KEYS
      .filter((key) => environment[key] !== undefined)
      .map((key) => [key, environment[key]]),
  );
}

function copyKeys(target, source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

export function partitionEnvironment(environment, inheritedEnvironment = process.env) {
  const inherited = baseEnvironment(inheritedEnvironment);
  const runnerEnvironment = { ...inherited };
  const conductorEnvironment = { ...inherited };
  copyKeys(runnerEnvironment, environment, [...FIXTURE_KEYS, ...OPTIONAL_SHARED_KEYS]);
  copyKeys(conductorEnvironment, environment, [...PRODUCT_KEYS, ...OPTIONAL_SHARED_KEYS]);
  return Object.freeze({
    runnerEnvironment: Object.freeze(runnerEnvironment),
    conductorEnvironment: Object.freeze(conductorEnvironment),
  });
}

async function loadConfiguration(envPath, inheritedEnvironment) {
  const environment = await readEnvironment(envPath);
  if ([...RETIRED_KEYS].some((key) => environment[key] !== undefined)) {
    throw supervisorError("invalid_e2e_configuration");
  }
  for (const key of [...FIXTURE_KEYS, ...PRODUCT_KEYS]) requiredValue(environment, key);
  if (environment.SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED !== "true") {
    throw supervisorError("invalid_e2e_configuration");
  }
  for (const key of [
    "SYMPHONY_LINEAR_EXCLUSIVE_MUTATION_ACTOR",
    "SYMPHONY_LINEAR_MANAGED_DESTRUCTION_PROHIBITED",
    "SYMPHONY_LINEAR_RELATION_PROVENANCE_AUDITED",
  ]) {
    if (environment[key] !== "acknowledged") throw supervisorError("invalid_e2e_configuration");
  }
  return Object.freeze({
    environment: Object.freeze(environment),
    ...partitionEnvironment(environment, inheritedEnvironment),
  });
}

function validAbsolutePath(value) {
  return typeof value === "string"
    && value.length > 0
    && path.isAbsolute(value)
    && !value.includes("\0");
}

function validRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function sendMessage(child, message) {
  if (!child.connected) return;
  try {
    child.send(message, () => undefined);
  } catch {
    // The child may have exited between the connected check and send.
  }
}

function normalizeDuration(value, fallback, maximum) {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > maximum) {
    throw supervisorError("invalid_e2e_configuration");
  }
  return duration;
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function killChild(child, signal) {
  if (childHasExited(child)) return;
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the state check and the signal.
  }
}

async function waitFor(promise, timeoutMs) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });
  const settled = await Promise.race([
    promise.then(() => true),
    timedOut,
  ]);
  clearTimeout(timer);
  return settled;
}

function shutdownWindows(timeoutMs) {
  const graceful = Math.max(1, Math.floor(timeoutMs / 2));
  return Object.freeze({
    graceful,
    forced: Math.max(1, timeoutMs - graceful),
  });
}

function redact(value, secrets) {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function createRedactor(secrets, emit) {
  const maximumSecretLength = Math.max(...secrets.map((secret) => secret.length), 1);
  const retainedLength = maximumSecretLength - 1;
  let pending = "";
  return Object.freeze({
    write(chunk) {
      pending += String(chunk);
      const newlineBoundary = pending.lastIndexOf("\n") + 1;
      const lengthBoundary = pending.length > retainedLength
        ? pending.length - retainedLength
        : 0;
      const boundary = Math.max(newlineBoundary, lengthBoundary);
      if (boundary === 0) return;
      emit(redact(pending.slice(0, boundary), secrets));
      pending = pending.slice(boundary);
    },
    end() {
      if (pending.length > 0) emit(redact(pending, secrets));
      pending = "";
    },
  });
}

function startProduct({ id, configPath, conductorEntryPath, conductorEnvironment, testChild, products }) {
  let child;
  try {
    child = spawn(process.execPath, [conductorEntryPath, "--config", configPath], {
      cwd: REPOSITORY_ROOT,
      env: conductorEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    sendMessage(testChild, { type: "start_error", id, code: "conductor_start_failed" });
    return;
  }

  const secrets = PRODUCT_KEYS
    .map((key) => conductorEnvironment[key])
    .filter((value) => typeof value === "string" && value.length > 0);
  let stateResolveExit;
  const state = {
    child,
    exited: false,
    stopRequested: false,
    redactor: createRedactor(secrets, (chunk) => {
      sendMessage(testChild, { type: "product_output", id, chunk });
    }),
    resolveExit: null,
    exit: new Promise((resolve) => { stateResolveExit = resolve; }),
  };
  state.resolveExit = (result) => stateResolveExit(result);
  products.set(id, state);

  const output = (chunk) => state.redactor.write(chunk);
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  child.once("error", () => {
    sendMessage(testChild, { type: "start_error", id, code: "conductor_start_failed" });
  });
  child.once("exit", (code, signal) => {
    state.exited = true;
    state.redactor.end();
    products.delete(id);
    const result = Object.freeze({ type: "product_exit", id, code, signal });
    sendMessage(testChild, result);
    state.resolveExit(result);
  });
  sendMessage(testChild, { type: "start_ack", id });
}

async function stopProduct(id, testChild, products, timeoutMs = STOP_TIMEOUT_MS) {
  const state = products.get(id);
  if (!state || state.exited) return;
  const windows = shutdownWindows(timeoutMs);
  state.stopRequested = true;
  killChild(state.child, "SIGTERM");
  const exited = await waitFor(state.exit, windows.graceful);
  if (!exited && !state.exited) {
    killChild(state.child, "SIGKILL");
    sendMessage(testChild, { type: "stop_timeout", id });
    await waitFor(state.exit, windows.forced);
  }
}

async function stopAllProducts(testChild, products, timeoutMs = STOP_TIMEOUT_MS) {
  await Promise.all([...products.keys()].map((id) => stopProduct(id, testChild, products, timeoutMs)));
}

async function stopTestChild(testChild, exit, timeoutMs) {
  if (childHasExited(testChild)) return;
  const windows = shutdownWindows(timeoutMs);
  killChild(testChild, "SIGTERM");
  if (await waitFor(exit, windows.graceful)) return;
  killChild(testChild, "SIGKILL");
  await waitFor(exit, windows.forced);
}

function startTestChild({ testFile, conductorEntryPath, conductorEnvironment, runnerEnvironment }) {
  const products = new Map();
  const testChild = spawn(
    process.execPath,
    ["--experimental-test-isolation=none", "--test", "--test-concurrency=1", testFile],
    {
      cwd: REPOSITORY_ROOT,
      env: runnerEnvironment,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  const testChildExit = new Promise((resolve) => {
    testChild.once("exit", (code, signal) => resolve(Object.freeze({ code, signal })));
  });
  const testChildError = new Promise((_, reject) => {
    testChild.once("error", () => reject(supervisorError("e2e_runner_failed")));
  });
  let stopProductsPromise;
  let stopTestChildPromise;
  const stopProductsOnce = (timeoutMs = STOP_TIMEOUT_MS) => {
    stopProductsPromise ??= stopAllProducts(testChild, products, timeoutMs);
    return stopProductsPromise;
  };
  const stopTestChildOnce = (timeoutMs) => {
    stopTestChildPromise ??= stopTestChild(testChild, testChildExit, timeoutMs);
    return stopTestChildPromise;
  };
  testChild.on("message", (message) => handleRequest(message, {
    testChild,
    products,
    conductorEntryPath,
    conductorEnvironment,
  }));
  return Object.freeze({
    testChild,
    products,
    testChildExit,
    testChildError,
    stopProductsOnce,
    stopTestChildOnce,
  });
}

function handleRequest(message, context) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return;
  const { testChild, products, conductorEntryPath, conductorEnvironment } = context;
  if (message.type === "start") {
    if (!validRequestId(message.id) || !validAbsolutePath(message.config_path)) {
      sendMessage(testChild, { type: "start_error", id: message.id, code: "invalid_conductor_config_path" });
      return;
    }
    if (products.has(message.id)) {
      sendMessage(testChild, { type: "start_error", id: message.id, code: "conductor_start_failed" });
      return;
    }
    startProduct({
      id: message.id,
      configPath: message.config_path,
      conductorEntryPath,
      conductorEnvironment,
      testChild,
      products,
    });
  } else if (message.type === "stop" && validRequestId(message.id)) {
    void stopProduct(message.id, testChild, products);
  } else {
    sendMessage(testChild, { type: "supervisor_error", code: "invalid_supervisor_request" });
  }
}

export async function runSupervisor({
  envPath = DEFAULT_ENV_PATH,
  conductorEntryPath = DEFAULT_CONDUCTOR_ENTRY_PATH,
  testFiles = DEFAULT_TEST_FILES,
  inheritedEnvironment = process.env,
  maxDurationMs = MAX_E2E_DURATION_MS,
  shutdownTimeoutMs,
} = {}) {
  const startedAt = Date.now();
  const totalDurationMs = normalizeDuration(maxDurationMs, MAX_E2E_DURATION_MS, MAX_E2E_DURATION_MS);
  const cleanupDurationMs = normalizeDuration(
    shutdownTimeoutMs,
    Math.min(STOP_TIMEOUT_MS, Math.max(1, Math.floor(totalDurationMs / 10))),
    Math.min(STOP_TIMEOUT_MS, totalDurationMs - 1),
  );
  const testDeadlineAt = startedAt + totalDurationMs - cleanupDurationMs;
  const normalizedEnvPath = typeof envPath === "string" ? path.resolve(envPath) : null;
  if (!validAbsolutePath(normalizedEnvPath) || !validAbsolutePath(conductorEntryPath)) {
    throw supervisorError("invalid_e2e_configuration");
  }
  if (!Array.isArray(testFiles) || testFiles.length === 0 || testFiles.some((file) => !validAbsolutePath(file))) {
    throw supervisorError("invalid_e2e_configuration");
  }
  const configuration = await loadConfiguration(normalizedEnvPath, inheritedEnvironment);
  if (Date.now() >= testDeadlineAt) {
    return Object.freeze({ code: E2E_TIMEOUT_EXIT_CODE, signal: null, reason: "e2e_timeout" });
  }
  let testChildren;
  try {
    testChildren = testFiles.map((testFile) => startTestChild({
      testFile,
      conductorEntryPath,
      conductorEnvironment: configuration.conductorEnvironment,
      runnerEnvironment: configuration.runnerEnvironment,
    }));
  } catch (error) {
    await Promise.all(testChildren?.map((child) => Promise.all([
      child.stopProductsOnce(STOP_TIMEOUT_MS),
      child.stopTestChildOnce(STOP_TIMEOUT_MS),
    ])) ?? []);
    throw error;
  }
  let timedOut = false;
  let deadlineTimer;
  const stopEverything = () => Promise.all(testChildren.flatMap((child) => [
    child.stopProductsOnce(cleanupDurationMs),
    child.stopTestChildOnce(cleanupDurationMs),
  ]));
  const signalHandler = () => {
    void stopEverything().catch(() => undefined);
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      Promise.race(testChildren.map((child) => child.testChildError)).catch(reject);
      Promise.all(testChildren.map((child) => child.testChildExit)).then((results) => {
        if (timedOut) return;
        const failed = results.find((result) => result.code !== 0 || result.signal !== null);
        finish(failed ?? Object.freeze({ code: 0, signal: null }));
      }, reject);
      const delayMs = Math.max(0, testDeadlineAt - Date.now());
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        void stopEverything().then(
          () => finish(Object.freeze({ code: E2E_TIMEOUT_EXIT_CODE, signal: null, reason: "e2e_timeout" })),
          reject,
        );
      }, delayMs);
      deadlineTimer.unref();
    });
    return result;
  } finally {
    clearTimeout(deadlineTimer);
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
    await stopEverything();
  }
}

async function main() {
  try {
    const result = await runSupervisor();
    if (result.reason === "e2e_timeout") process.stderr.write("e2e_timeout\n");
    process.exitCode = result.code ?? 1;
  } catch (error) {
    process.stderr.write(`${error instanceof SupervisorError ? error.code : "e2e_supervisor_failed"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
