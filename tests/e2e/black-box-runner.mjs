import { open } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ENV_PATH = path.join(REPOSITORY_ROOT, ".env");
const MAX_ENV_BYTES = 64 * 1024;
const MAX_SECRET_LENGTH = 4096;
const MAX_OUTPUT_LINE_BYTES = 64 * 1024;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const PRODUCTION_LINEAR_CREDENTIAL = /^SYMPHONY_(?:E2E_LINEAR_DEV|LINEAR)_TOKEN$/u;
const DIAGNOSTIC_EVENTS = new Set([
  "code_inspection_diagnostic",
  "root_task_authorization_diagnostic",
  "root_task_tool_diagnostic",
  "root_tool_call_accepted",
  "root_tool_call_denied",
  "root_tool_call_failed",
  "root_turn_completed",
  "root_turn_failed",
  "root_turn_started",
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

function launcherSocketPath(environment) {
  const value = requiredValue(environment, "SYMPHONY_E2E_CONDUCTOR_LAUNCHER_SOCKET", 4096);
  if (!path.isAbsolute(value)) throw runnerError("invalid_e2e_configuration");
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
  if (Object.keys(process.env).some((key) => PRODUCTION_LINEAR_CREDENTIAL.test(key))) {
    throw runnerError("invalid_e2e_configuration");
  }
  const environment = await readEnvironment(envPath);
  if (Object.keys(environment).some((key) => PRODUCTION_LINEAR_CREDENTIAL.test(key))) {
    throw runnerError("invalid_e2e_configuration");
  }
  if (environment.SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED !== "true") {
    throw runnerError("invalid_e2e_configuration");
  }
  const fixtureAccess = Object.freeze({
    linearHumanToken: requiredSecret(environment, "SYMPHONY_E2E_LINEAR_HUMAN_TOKEN"),
    projectSlugId: projectSlugId(environment),
  });
  return Object.freeze({ fixtureAccess, launcherSocketPath: launcherSocketPath(environment) });
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

function safeReasonCode(value) {
  return typeof value === "string"
    && /^[a-z][a-z0-9_]{0,63}(?::[a-z][a-z0-9_]{0,31})?$/u.test(value)
    ? value
    : undefined;
}

export function conductorFailureFromEvent(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.event === "conductor_failed") {
    return runnerError("conductor_failed", safeReasonCode(value.reason_code));
  }
  if (value.event === "root_observation_failed") {
    const reasonCode = value.reason_code === "runtime_preparation_failed"
      ? value.reason_code
      : undefined;
    return runnerError("conductor_runtime_failed", safeReasonCode(value.cause_code) ?? reasonCode);
  }
  if (value.event === "root_turn_completed") {
    const reasonCode = {
      timed_out: "root_turn_timed_out",
      stopped: "root_turn_stopped",
      canceled: "root_turn_canceled",
    }[value.outcome];
    return reasonCode === undefined
      ? undefined
      : runnerError("conductor_runtime_failed", reasonCode);
  }
  if ([
    "root_turn_failed",
    "cycle_action_failed",
    "cycle_continuation_failed",
    "root_cleanup_failed",
  ].includes(value.event)) {
    return runnerError(
      "conductor_runtime_failed",
      safeReasonCode(value.cause_code) ?? safeReasonCode(value.reason_code),
    );
  }
  return undefined;
}

export function conductorDiagnosticFromEvent(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.event === "string"
    && DIAGNOSTIC_EVENTS.has(value.event)
    ? Object.freeze({ diagnostic: "conductor_event", event: value.event })
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

function waitForClose(connection) {
  return new Promise((resolve) => {
    if (connection.destroyed) {
      resolve();
      return;
    }
    connection.once("close", () => resolve());
  });
}

async function closeLauncher(connection, close, timeoutMilliseconds) {
  if (connection.destroyed) return false;
  connection.end(`${JSON.stringify({ type: "stop" })}\n`);
  const closed = await Promise.race([
    close.then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMilliseconds);
      timer.unref();
    }),
  ]);
  if (!closed) {
    connection.destroy();
    await close;
    return true;
  }
  return false;
}

async function startBuiltConductor({ configPath, launcherSocketPath: socketPath }) {
  if (
    typeof configPath !== "string"
    || !path.isAbsolute(configPath)
    || typeof socketPath !== "string"
    || !path.isAbsolute(socketPath)
  ) {
    throw runnerError("invalid_conductor_config_path");
  }
  await assertReadableFile(configPath, "invalid_conductor_config_path");

  const connection = createConnection({ path: socketPath });
  const close = waitForClose(connection);
  let settled = false;
  let stopping = false;
  let stopped = false;
  let runtimeFailure;
  let resolveFailure;
  let resolveExit;
  let resolveReady;
  let rejectReady;
  const failure = new Promise((resolve) => { resolveFailure = resolve; });
  const exit = new Promise((resolve) => { resolveExit = resolve; });
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = (error) => {
    runtimeFailure ??= error;
    resolveExit(Object.freeze({ status: "failed", error: runtimeFailure }));
    if (!settled) {
      settled = true;
      rejectReady(error);
    } else {
      resolveFailure(runtimeFailure);
    }
  };
  const event = (value) => {
    const diagnostic = conductorDiagnosticFromEvent(value);
    if (process.env.SYMPHONY_E2E_DIAGNOSTIC_EVENTS === "1" && diagnostic !== undefined) {
      process.stderr.write(`# ${JSON.stringify(diagnostic)}\n`);
    }
    if (value.event === "conductor_ready" && !settled) {
      settled = true;
      resolveReady();
    } else if (value.event === "conductor_stopped") {
      stopped = true;
      resolveExit(Object.freeze({ status: "stopped" }));
    } else {
      const eventFailure = conductorFailureFromEvent(value);
      if (eventFailure !== undefined) fail(eventFailure);
    }
  };
  watchJsonLines(connection, event, () => fail(runnerError("invalid_conductor_output")));
  connection.once("connect", () => {
    connection.write(`${JSON.stringify({ type: "start", config_path: configPath })}\n`);
  });
  connection.once("error", () => fail(runnerError("conductor_start_failed")));
  connection.once("close", () => {
    if (!settled) fail(runnerError("conductor_start_failed"));
    else if (!stopping && !stopped && runtimeFailure === undefined) {
      runtimeFailure = runnerError("conductor_exited");
      resolveFailure(runtimeFailure);
      resolveExit(Object.freeze({ status: "failed", error: runtimeFailure }));
    }
  });

  const timeout = setTimeout(() => fail(runnerError("conductor_start_timeout")), START_TIMEOUT_MS);
  timeout.unref();
  try {
    await ready;
  } catch (error) {
    connection.destroy();
    await close;
    throw isRunnerError(error) ? error : runnerError("conductor_start_failed");
  } finally {
    clearTimeout(timeout);
  }

  return Object.freeze({
    waitForFailure: async () => { throw await failure; },
    waitForExit: async () => await exit,
    stop: async () => {
      stopping = true;
      const forced = await closeLauncher(connection, close, STOP_TIMEOUT_MS);
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

function productManager(launcherSocketPath, productHandles, startProduct) {
  return Object.freeze({
    start: async (configPath) => {
      if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
        throw runnerError("invalid_conductor_config_path");
      }
      let handle;
      try {
        handle = await startProduct(Object.freeze({ configPath, launcherSocketPath }));
      } catch (error) {
        if (isRunnerError(error)) throw error;
        throw runnerError("conductor_start_failed");
      }
      if (handle === null || typeof handle !== "object" || typeof handle.stop !== "function") {
        throw runnerError("invalid_conductor_process_handle");
      }
      productHandles.push(handle);
      return Object.freeze({
        waitForFailure: async () => {
          if (typeof handle.waitForFailure !== "function") {
            await new Promise(() => undefined);
          }
          try {
            await handle.waitForFailure();
          } catch (error) {
            if (isRunnerError(error)) throw error;
            throw runnerError("conductor_runtime_failed");
          }
          throw runnerError("conductor_exited");
        },
        waitForExit: async () => {
          if (typeof handle.waitForExit !== "function") {
            throw runnerError("conductor_exit_observation_unavailable");
          }
          try {
            return await handle.waitForExit();
          } catch (error) {
            if (isRunnerError(error)) throw error;
            throw runnerError("conductor_runtime_failed");
          }
        },
      });
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
  const product = productManager(configuration.launcherSocketPath, productHandles, startProduct);
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

  if (
    scenarioFailure
    && cleanupFailure
    && scenarioFailure.code === cleanupFailure.code
    && scenarioFailure.reasonCode === cleanupFailure.reasonCode
  ) throw scenarioFailure;
  if (scenarioFailure && cleanupFailure) throw runnerError("black_box_scenario_cleanup_failed");
  if (scenarioFailure) throw scenarioFailure;
  if (cleanupFailure) throw cleanupFailure;
  return result;
}
