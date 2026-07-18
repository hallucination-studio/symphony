import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { createE2ELogger } from "./logging.mjs";

const MAX_FRAME_BYTES = 1_048_576;
const SECRET_KEYS = new Set([
  "SYMPHONY_E2E_LINEAR_DEV_TOKEN",
  "SYMPHONY_E2E_CODEX_API_KEY",
]);

export async function createProductionPodiumConductorOwner({ databasePath }) {
  const {
    createPodiumConductorServices,
    PodiumConductorProtocolHandler,
  } = await import("@symphony/podium");
  const owner = createPodiumConductorServices({ databasePath });
  return Object.freeze({
    handler: new PodiumConductorProtocolHandler(owner.services),
    observeExit: (input) => owner.services.observeExit(input),
    close: () => owner.close(),
  });
}

export async function startConductorHarness({
  podium,
  executable = process.execPath,
  arguments: arguments_ = ["apps/conductor/dist/main.js"],
  environment,
  cwd = process.cwd(),
  startupTimeoutMs = 30_000,
  shutdownTimeoutMs = 5_000,
  spawnProcess = spawn,
  log,
}) {
  validateEnvironment(environment);
  const emit = log ?? createE2ELogger({ runId: environment.SYMPHONY_INSTANCE_ID });
  const child = spawnProcess(executable, arguments_, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  emit({ event: "e2e_child_started", component: "conductor" });
  const channel = child.stdio?.[3];
  if (!channel?.readable || !channel?.writable) {
    child.kill("SIGKILL");
    throw stableError("conductor_ipc_unavailable");
  }

  const observations = [];
  const observationWaiters = new Set();
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let processing = Promise.resolve();
  let closed = false;
  let firstFailure;
  const handshake = deferred();
  const exit = deferred();
  child.once("error", () => fail("conductor_process_start_failed"));
  child.once("exit", (code, signal) => {
    emit({ event: "e2e_child_exited", component: "conductor", exit_code: code, signal });
    exit.resolve({ code, signal });
    if (!closed && !firstFailure) fail("conductor_process_exited");
  });
  forwardChildStream(child.stdout, "stdout");
  forwardChildStream(child.stderr, "stderr");
  channel.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    processing = processing
      .then(() => drain())
      .catch(() => fail("conductor_protocol_failed"));
  });
  channel.once("error", () => fail("conductor_protocol_failed"));

  const startupTimer = setTimeout(() => fail("conductor_startup_timeout"), startupTimeoutMs);
  try {
    await handshake.promise;
  } catch (error) {
    closed = true;
    channel.destroy();
    child.kill("SIGKILL");
    await boundedExit(exit.promise, shutdownTimeoutMs);
    podium.close();
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }

  return Object.freeze({
    observations,
    waitForObservation(predicate, timeoutMs = startupTimeoutMs) {
      const existing = observations.find(predicate);
      if (existing) return Promise.resolve(existing);
      const waiter = deferred();
      const timer = setTimeout(() => {
        observationWaiters.delete(entry);
        waiter.reject(stableError("conductor_observation_timeout"));
      }, timeoutMs);
      const entry = { predicate, waiter, timer };
      observationWaiters.add(entry);
      return waiter.promise;
    },
    async request(body, secret) {
      if (closed) throw stableError("conductor_harness_closed");
      const requestId = `e2e-${randomUUID()}`;
      const result = deferred();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        result.reject(stableError("conductor_request_timeout"));
      }, startupTimeoutMs);
      pending.set(requestId, { ...result, timer });
      const message = { protocol_version: "1", request_id: requestId, body };
      await write(channel, `${JSON.stringify(message)}\n`, secret);
      return result.promise;
    },
    async close() {
      if (closed) return;
      try {
        const requestId = `e2e-shutdown-${randomUUID()}`;
        await write(channel, `${JSON.stringify({
          protocol_version: "1",
          request_id: requestId,
          body: {
          kind: "shutdown_conductor",
          binding_id: environment.SYMPHONY_BINDING_ID,
          instance_id: environment.SYMPHONY_INSTANCE_ID,
          deadline_at: new Date(Date.now() + shutdownTimeoutMs).toISOString(),
          },
        })}\n`);
      } catch {}
      closed = true;
      channel.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), shutdownTimeoutMs);
      await boundedExit(exit.promise, shutdownTimeoutMs + 1_000);
      clearTimeout(timer);
      podium.observeExit?.({
        bindingId: environment.SYMPHONY_BINDING_ID,
        instanceId: environment.SYMPHONY_INSTANCE_ID,
        observedAt: new Date().toISOString(),
        sanitizedReason: "conductor_process_exited",
      });
      podium.close();
    },
  });

  async function drain() {
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.byteLength > MAX_FRAME_BYTES) fail("conductor_frame_too_large");
        return;
      }
      if (newline > MAX_FRAME_BYTES) throw stableError("conductor_frame_too_large");
      let message;
      try {
        message = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        throw stableError("conductor_frame_json_invalid");
      }
      buffer = buffer.subarray(newline + 1);
      const waiting = pending.get(message.request_id);
      if (waiting) {
        clearTimeout(waiting.timer);
        pending.delete(message.request_id);
        waiting.resolve(message.body);
        continue;
      }
      const response = await podium.handler.handle(message);
      const body = response?.body;
      if (body?.code) throw stableError("conductor_handshake_rejected");
      const observation = Object.freeze({
        kind: message.body?.kind ?? "unknown",
        ...(typeof message.body?.status === "string" ? { status: message.body.status } : {}),
        ...(typeof message.body?.sanitized_summary === "string"
          ? { sanitizedSummary: message.body.sanitized_summary }
          : {}),
      });
      observations.push(observation);
      for (const entry of observationWaiters) {
        if (!entry.predicate(observation)) continue;
        clearTimeout(entry.timer);
        observationWaiters.delete(entry);
        entry.waiter.resolve(observation);
      }
      await write(channel, `${JSON.stringify(response)}\n`);
      if (message.body?.kind === "conductor_handshake") handshake.resolve();
    }
  }

  function fail(code) {
    if (firstFailure) return;
    emit({ event: "e2e_child_failed", component: "conductor", reason: code });
    firstFailure = stableError(code);
    handshake.reject(firstFailure);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(firstFailure);
    }
    pending.clear();
    for (const entry of observationWaiters) {
      clearTimeout(entry.timer);
      entry.waiter.reject(firstFailure);
    }
    observationWaiters.clear();
  }

  function forwardChildStream(stream, streamName) {
    if (!stream) return;
    let pendingLine = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
      pendingLine += String(chunk);
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        emit({ event: "e2e_child_log", component: "conductor", stream: streamName, message: line });
      }
    });
    stream.on("end", () => {
      if (pendingLine) {
        emit({ event: "e2e_child_log", component: "conductor", stream: streamName, message: pendingLine });
      }
    });
  }

}

function validateEnvironment(environment) {
  if (!environment || typeof environment !== "object") throw stableError("conductor_environment_invalid");
  for (const key of SECRET_KEYS) {
    if (environment[key] !== undefined) throw stableError("conductor_environment_secret_forbidden");
  }
}

async function write(channel, frame, secret) {
  const bytes = secret ? Buffer.concat([Buffer.from(frame), Buffer.from(secret)]) : Buffer.from(frame);
  try {
    await new Promise((resolve, reject) => channel.write(bytes, (error) => error ? reject(error) : resolve()));
  } catch {
    throw stableError("conductor_protocol_write_failed");
  } finally {
    if (secret) {
      bytes.fill(0);
      secret.fill(0);
    }
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolve_, reject_) => { resolve = resolve_; reject = reject_; });
  return { promise, resolve, reject };
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function boundedExit(exit, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      exit,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ code: null, signal: "SIGKILL" }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
