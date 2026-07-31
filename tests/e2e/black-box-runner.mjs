import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ENV_PATH = path.join(REPOSITORY_ROOT, ".env");
const CONDUCTOR_ENTRY = path.join(REPOSITORY_ROOT, "apps", "conductor", "dist", "main.js");
const MAX_ENV_BYTES = 64 * 1024;
const MAX_SECRET_LENGTH = 4096;
const MAX_OUTPUT_LINE_BYTES = 64 * 1024;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const PASSTHROUGH_ENVIRONMENT = Object.freeze([
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

class E2ERunnerError extends Error {
  constructor(code, reasonCode) {
    super(code);
    this.name = "E2ERunnerError";
    this.code = code;
    if (reasonCode !== undefined) this.reasonCode = reasonCode;
  }
}

function runnerError(code, reasonCode) {
  return new E2ERunnerError(code, reasonCode);
}

function isRunnerError(error) {
  return error instanceof E2ERunnerError;
}

function requiredSecret(environment, key) {
  const value = environment[key];
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_SECRET_LENGTH
    || /\s/u.test(value)
  ) throw runnerError("invalid_e2e_configuration");
  return value;
}

function requiredValue(environment, key, maximumLength = 256) {
  const value = environment[key];
  const hasControlCharacter = typeof value === "string" && [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
    || hasControlCharacter
  ) throw runnerError("invalid_e2e_configuration");
  return value;
}

function projectSlugId(environment) {
  const value = requiredValue(environment, "SYMPHONY_E2E_PROJECT_SLUG_ID", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw runnerError("invalid_e2e_configuration");
  }
  return value;
}

function baseUrl(environment) {
  const value = requiredValue(environment, "SYMPHONY_E2E_CODEX_BASE_URL", 2048);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw runnerError("invalid_e2e_configuration");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username !== ""
    || parsed.password !== ""
  ) throw runnerError("invalid_e2e_configuration");
  return value;
}

async function readEnvironment(envPath) {
  let handle;
  try {
    handle = await open(envPath, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ENV_BYTES) {
      throw runnerError("invalid_e2e_configuration");
    }
    return parseEnv(await handle.readFile({ encoding: "utf8" }));
  } catch (error) {
    if (isRunnerError(error)) throw error;
    throw runnerError("invalid_e2e_configuration");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function loadConfiguration(envPath) {
  const environment = await readEnvironment(envPath);
  if (environment.SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED !== "true") {
    throw runnerError("invalid_e2e_configuration");
  }
  const fixtureAccess = Object.freeze({
    linearHumanToken: requiredSecret(environment, "SYMPHONY_E2E_LINEAR_HUMAN_TOKEN"),
    projectSlugId: projectSlugId(environment),
  });
  const productEnvironment = Object.freeze({
    SYMPHONY_LINEAR_TOKEN: requiredSecret(environment, "SYMPHONY_E2E_LINEAR_DEV_TOKEN"),
    SYMPHONY_CODEX_API_KEY: requiredSecret(environment, "SYMPHONY_E2E_CODEX_API_KEY"),
    SYMPHONY_CODEX_BASE_URL: baseUrl(environment),
    SYMPHONY_CODEX_MODEL: requiredSecret(environment, "SYMPHONY_E2E_CODEX_MODEL"),
  });
  return Object.freeze({ fixtureAccess, productEnvironment });
}

async function assertReadableFile(file, failureCode) {
  let handle;
  try {
    handle = await open(file, "r");
    if (!(await handle.stat()).isFile()) throw runnerError(failureCode);
  } catch (error) {
    if (isRunnerError(error)) throw error;
    throw runnerError(failureCode);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function childEnvironment(productEnvironment) {
  const environment = {};
  for (const key of PASSTHROUGH_ENVIRONMENT) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze({ ...environment, ...productEnvironment });
}

function safeReasonCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : undefined;
}

function watchJsonLines(stream, onEvent, onInvalid) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered, "utf8") > MAX_OUTPUT_LINE_BYTES && !buffered.includes("\n")) {
      buffered = "";
      onInvalid();
      return;
    }
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_OUTPUT_LINE_BYTES) {
        onInvalid();
      } else if (line.trim() !== "") {
        try {
          const event = JSON.parse(line);
          if (event === null || typeof event !== "object" || Array.isArray(event)) onInvalid();
          else onEvent(event);
        } catch {
          onInvalid();
        }
      }
      newline = buffered.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffered.trim() !== "") onInvalid();
    buffered = "";
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
  });
}

async function terminateChild(child, exit, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exit.then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMilliseconds);
      timer.unref();
    }),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exit;
    return true;
  }
  return false;
}

async function startBuiltConductor({ configPath, environment }) {
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
    throw runnerError("invalid_conductor_config_path");
  }
  await Promise.all([
    assertReadableFile(CONDUCTOR_ENTRY, "conductor_build_missing"),
    assertReadableFile(configPath, "invalid_conductor_config_path"),
  ]);

  const conductorArguments = ["--config", configPath];
  const child = spawn(process.execPath, [CONDUCTOR_ENTRY, ...conductorArguments], {
    cwd: REPOSITORY_ROOT,
    env: childEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = waitForExit(child);
  let settled = false;
  let stopping = false;
  let runtimeFailure;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = (error) => {
    runtimeFailure ??= error;
    if (!settled) {
      settled = true;
      rejectReady(error);
    }
  };
  const event = (value) => {
    if (value.event === "conductor_ready" && !settled) {
      settled = true;
      resolveReady();
    } else if (value.event === "conductor_failed") {
      fail(runnerError("conductor_failed", safeReasonCode(value.reason_code)));
    }
  };
  watchJsonLines(child.stdout, event, () => fail(runnerError("invalid_conductor_output")));
  watchJsonLines(child.stderr, event, () => fail(runnerError("invalid_conductor_output")));
  child.once("error", () => fail(runnerError("conductor_start_failed")));
  child.once("close", () => {
    if (!settled) fail(runnerError("conductor_start_failed"));
    else if (!stopping && runtimeFailure === undefined) {
      runtimeFailure = runnerError("conductor_exited");
    }
  });

  const timeout = setTimeout(() => fail(runnerError("conductor_start_timeout")), START_TIMEOUT_MS);
  timeout.unref();
  try {
    await ready;
  } catch (error) {
    await terminateChild(child, exit, STOP_TIMEOUT_MS);
    throw isRunnerError(error) ? error : runnerError("conductor_start_failed");
  } finally {
    clearTimeout(timeout);
  }

  return Object.freeze({
    stop: async () => {
      stopping = true;
      const forced = await terminateChild(child, exit, STOP_TIMEOUT_MS);
      if (runtimeFailure) throw runtimeFailure;
      if (forced) throw runnerError("conductor_stop_timeout");
    },
  });
}

function fixtureManager(fixtureAccess, cleanupOperations) {
  const operate = async (operation, failureCode = "fixture_operation_failed") => {
    if (typeof operation !== "function") throw runnerError("invalid_runner_contract");
    try {
      return await operation(fixtureAccess);
    } catch {
      throw runnerError(failureCode);
    }
  };
  return Object.freeze({
    operate,
    create: async ({ setup, cleanup }) => {
      if (typeof setup !== "function" || typeof cleanup !== "function") {
        throw runnerError("invalid_runner_contract");
      }
      const fixture = await operate(setup);
      cleanupOperations.push(async () => {
        try {
          await cleanup(fixtureAccess, fixture);
        } catch {
          throw runnerError("fixture_cleanup_failed");
        }
      });
      return fixture;
    },
  });
}

function productManager(productEnvironment, productHandles, startProduct) {
  return Object.freeze({
    start: async (configPath) => {
      if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
        throw runnerError("invalid_conductor_config_path");
      }
      let handle;
      try {
        handle = await startProduct(Object.freeze({ configPath, environment: productEnvironment }));
      } catch (error) {
        if (isRunnerError(error)) throw error;
        throw runnerError("conductor_start_failed");
      }
      if (handle === null || typeof handle !== "object" || typeof handle.stop !== "function") {
        throw runnerError("invalid_conductor_process_handle");
      }
      productHandles.push(handle);
    },
  });
}

async function runCleanup(operations) {
  const failures = [];
  for (const operation of [...operations].reverse()) {
    try {
      await operation();
    } catch (error) {
      failures.push(isRunnerError(error) ? error : runnerError("e2e_cleanup_failed"));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw runnerError("e2e_cleanup_failed");
}

export async function runBlackBoxScenario({
  envPath = DEFAULT_ENV_PATH,
  scenario,
  startProduct = startBuiltConductor,
}) {
  if (typeof scenario !== "function" || typeof startProduct !== "function") {
    throw runnerError("invalid_runner_contract");
  }
  if (typeof envPath !== "string" || envPath.length === 0) {
    throw runnerError("invalid_runner_contract");
  }
  const normalizedEnvPath = path.resolve(envPath);
  const configuration = await loadConfiguration(normalizedEnvPath);
  const cleanupOperations = [];
  const productHandles = [];
  const fixtures = fixtureManager(configuration.fixtureAccess, cleanupOperations);
  const product = productManager(configuration.productEnvironment, productHandles, startProduct);
  let result;
  let scenarioFailure;

  try {
    result = await scenario(Object.freeze({ fixtures, product }));
  } catch (error) {
    scenarioFailure = isRunnerError(error) ? error : runnerError("black_box_scenario_failed");
  }

  const cleanupFailures = [];
  for (const operations of [
    productHandles.map((handle) => () => handle.stop()),
    cleanupOperations,
  ]) {
    try {
      await runCleanup(operations);
    } catch (error) {
      cleanupFailures.push(isRunnerError(error) ? error : runnerError("e2e_cleanup_failed"));
    }
  }
  const cleanupFailure = cleanupFailures.length === 1
    ? cleanupFailures[0]
    : cleanupFailures.length > 1
      ? runnerError("e2e_cleanup_failed")
      : undefined;

  if (scenarioFailure && cleanupFailure) throw runnerError("black_box_scenario_cleanup_failed");
  if (scenarioFailure) throw scenarioFailure;
  if (cleanupFailure) throw cleanupFailure;
  return result;
}
