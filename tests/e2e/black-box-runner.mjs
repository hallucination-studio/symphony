import { open } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import path from "node:path";

const MAX_SECRET_LENGTH = 4096;
const MAX_OUTPUT_LINE_BYTES = 64 * 1024;
const START_TIMEOUT_MS = 30_000;
const PRODUCTION_CREDENTIAL_KEY = /^SYMPHONY_(?:E2E_LINEAR_DEV_TOKEN|LINEAR_TOKEN|CODEX_[A-Z0-9_]+|LINEAR_[A-Z0-9_]+)$/u;
const RETIRED_LAUNCHER_KEY = ["SYMPHONY_E2E", "CONDUCTOR", "LAUNCHER", "SOCKET"].join("_");
const DIAGNOSTIC_EVENTS = new Set([
  "code_inspection_diagnostic",
  "root_task_authorization_diagnostic",
  "root_task_tool_diagnostic",
  "root_tool_call_accepted",
  "root_tool_call_denied",
  "root_tool_call_failed",
  "root_observation_buffered",
  "root_observation_unchanged",
  "root_observation_failed",
  "fresh_route_selected",
  "root_admission_parked",
  "root_observation_paused",
  "cycle_action_started",
  "cycle_action_completed",
  "cycle_action_paused",
  "delivery_finalizer_started",
  "delivery_finalizer_completed",
  "delivery_finalizer_failed",
  "cycle_action_failed",
  "cycle_continuation_failed",
  "root_cleanup_failed",
  "root_turn_completed",
  "root_turn_failed",
  "root_turn_started",
]);
const DIAGNOSTIC_REASON_EVENTS = new Set([
  "code_inspection_diagnostic",
  "root_observation_failed",
  "root_observation_paused",
  "root_task_authorization_diagnostic",
  "root_turn_failed",
  "root_tool_call_denied",
  "root_tool_call_failed",
  "root_task_tool_diagnostic",
  "cycle_action_failed",
  "cycle_continuation_failed",
  "root_cleanup_failed",
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

function loadConfiguration(environment = process.env) {
  if (
    environment === null
    || typeof environment !== "object"
    || Object.keys(process.env).some((key) => (
      PRODUCTION_CREDENTIAL_KEY.test(key) || key === RETIRED_LAUNCHER_KEY
    ))
    || Object.keys(environment).some((key) => (
      PRODUCTION_CREDENTIAL_KEY.test(key) || key === RETIRED_LAUNCHER_KEY
    ))
  ) {
    throw runnerError("invalid_e2e_configuration");
  }
  if (environment.SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED !== "true") {
    throw runnerError("invalid_e2e_configuration");
  }
  const fixtureAccess = Object.freeze({
    linearHumanToken: requiredSecret(environment, "SYMPHONY_E2E_LINEAR_HUMAN_TOKEN"),
    projectSlugId: projectSlugId(environment),
  });
  return Object.freeze({ fixtureAccess });
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
    && /^[a-z][a-z0-9_]{0,63}(?::[a-z][a-z0-9_]{0,63})?$/u.test(value)
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
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || typeof value.event !== "string"
    || !DIAGNOSTIC_EVENTS.has(value.event)
  ) return undefined;
  const reasonCode = DIAGNOSTIC_REASON_EVENTS.has(value.event)
    ? (value.event === "root_task_tool_diagnostic"
      || value.event === "root_task_authorization_diagnostic"
      || value.event === "code_inspection_diagnostic")
      ? safeReasonCode(value.category)
        ?? safeReasonCode(value.code)
      : safeReasonCode(value.cause_code)
        ?? safeReasonCode(value.reason_code)
        ?? safeReasonCode(value.code)
    : undefined;
  const diagnosticTool = (value.event === "root_task_tool_diagnostic"
    || value.event === "code_inspection_diagnostic")
    && typeof value.tool === "string"
    && /^[a-z][a-z0-9_]{0,63}$/u.test(value.tool)
    ? value.tool
    : undefined;
  const toolName = ["root_tool_call_accepted", "root_tool_call_denied", "root_tool_call_failed"].includes(value.event)
    && typeof value.tool === "string"
    && /^[a-z][a-z0-9_]{0,63}$/u.test(value.tool)
    ? value.tool
    : undefined;
  const turnOutcome = value.event === "root_turn_completed"
    && ["quiescent", "stopped", "timed_out", "canceled"].includes(value.outcome)
    ? value.outcome
    : undefined;
  const diagnosticStage = value.event === "root_task_tool_diagnostic"
    && typeof value.stage === "string"
    && /^(?:parse_call|acceptance_guard|task_dispatch|result_validation)$/u.test(value.stage)
    ? value.stage
    : undefined;
  const diagnosticRoute = value.event === "fresh_route_selected"
    && typeof value.selected_route === "string"
    && /^WF-ROUTE-[0-9]{3}$/u.test(value.selected_route)
    ? value.selected_route
    : undefined;
  const diagnosticConsumer = value.event === "fresh_route_selected"
    && ["root_boundary", "cycle_machine", "family_guard", "delivery_finalizer", "cleanup", "park"].includes(value.consumer)
    ? value.consumer
    : undefined;
  return Object.freeze({
    diagnostic: "conductor_event",
    event: value.event,
    ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
    ...(diagnosticTool === undefined ? {} : { tool: diagnosticTool }),
    ...(toolName === undefined ? {} : { tool: toolName }),
    ...(diagnosticStage === undefined ? {} : { stage: diagnosticStage }),
    ...(diagnosticRoute === undefined ? {} : { selected_route: diagnosticRoute }),
    ...(diagnosticConsumer === undefined ? {} : { consumer: diagnosticConsumer }),
    ...(turnOutcome === undefined ? {} : { outcome: turnOutcome }),
  });
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

function sendSupervisorMessage(message, onError) {
  if (typeof process.send !== "function") {
    onError(runnerError("conductor_start_failed"));
    return;
  }
  try {
    process.send(message, (error) => {
      if (error) onError(runnerError("conductor_start_failed"));
    });
  } catch {
    onError(runnerError("conductor_start_failed"));
  }
}

function supervisorErrorFromMessage(message) {
  if (message.type === "stop_timeout") return runnerError("conductor_stop_timeout");
  if (message.code === "invalid_conductor_config_path") {
    return runnerError("invalid_conductor_config_path");
  }
  if (message.type === "supervisor_error") return runnerError("conductor_start_failed");
  return runnerError("conductor_start_failed");
}

async function startBuiltConductor({ configPath }) {
  if (typeof configPath !== "string" || !path.isAbsolute(configPath) || configPath.includes("\0")) {
    throw runnerError("invalid_conductor_config_path");
  }
  await assertReadableFile(configPath, "invalid_conductor_config_path");
  if (typeof process.send !== "function") throw runnerError("conductor_start_failed");

  const id = randomUUID().replaceAll("-", "");
  const output = new PassThrough();
  let readySettled = false;
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
  const onMessage = (message) => {
    if (message === null || typeof message !== "object" || message.id !== id) return;
    if (message.type === "product_output") {
      if (typeof message.chunk === "string") output.write(message.chunk);
      return;
    }
    if (message.type === "start_ack") return;
    if (message.type === "start_error" || message.type === "supervisor_error" || message.type === "stop_timeout") {
      fail(supervisorErrorFromMessage(message));
      if (message.type !== "stop_timeout") output.end();
      return;
    }
    if (message.type === "product_exit") {
      output.end();
      if (!readySettled) {
        fail(runnerError("conductor_start_failed"));
      } else if (!stopping && !stopped && runtimeFailure === undefined) {
        fail(runnerError("conductor_exited"));
      } else if (runtimeFailure === undefined) {
        resolveExit(Object.freeze({ status: "stopped" }));
      }
      process.off("message", onMessage);
    }
  };
  const fail = (error) => {
    runtimeFailure ??= error;
    resolveExit(Object.freeze({ status: "failed", error: runtimeFailure }));
    if (!readySettled) {
      readySettled = true;
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
    if (value.event === "conductor_ready" && !readySettled) {
      readySettled = true;
      resolveReady();
    } else if (value.event === "conductor_stopped") {
      stopped = true;
      resolveExit(Object.freeze({ status: "stopped" }));
    } else {
      const eventFailure = conductorFailureFromEvent(value);
      if (eventFailure !== undefined) fail(eventFailure);
    }
  };
  process.on("message", onMessage);
  output.on("error", () => fail(runnerError("invalid_conductor_output")));
  watchJsonLines(output, event, () => fail(runnerError("invalid_conductor_output")));
  sendSupervisorMessage({ type: "start", id, config_path: configPath }, fail);

  const timeout = setTimeout(() => fail(runnerError("conductor_start_timeout")), START_TIMEOUT_MS);
  timeout.unref();
  try {
    await ready;
  } catch (error) {
    process.off("message", onMessage);
    output.destroy();
    throw isRunnerError(error) ? error : runnerError("conductor_start_failed");
  } finally {
    clearTimeout(timeout);
  }

  return Object.freeze({
    waitForFailure: async () => { throw await failure; },
    waitForExit: async () => await exit,
    stop: async () => {
      stopping = true;
      sendSupervisorMessage({ type: "stop", id }, fail);
      const result = await exit;
      if (runtimeFailure) throw runtimeFailure;
      if (result.status !== "stopped") throw runnerError("conductor_runtime_failed");
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

function productManager(productHandles, startProduct) {
  return Object.freeze({
    start: async (configPath) => {
      if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
        throw runnerError("invalid_conductor_config_path");
      }
      let handle;
      try {
        handle = await startProduct(Object.freeze({ configPath }));
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
  fixtureEnvironment = process.env,
  scenario,
  startProduct = startBuiltConductor,
}) {
  if (typeof scenario !== "function" || typeof startProduct !== "function") {
    throw runnerError("invalid_runner_contract");
  }
  const configuration = loadConfiguration(fixtureEnvironment);
  const cleanupOperations = [];
  const productHandles = [];
  const fixtures = fixtureManager(configuration.fixtureAccess, cleanupOperations);
  const product = productManager(productHandles, startProduct);
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
