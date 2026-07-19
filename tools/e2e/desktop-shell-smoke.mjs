import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

import { createDesktopShellEnvironment } from "./desktop-shell-environment.mjs";
import { createDesktopShellVerdict } from "./desktop-shell-verdict.mjs";

const STARTUP_EVENT_KEYS = Object.freeze([
  "component",
  "event",
  "schema_version",
]);
const REQUIRED_STARTUP_EVENTS = Object.freeze([
  "desktop_webview_loaded",
  "desktop_podium_backend_responded",
]);
const MAX_OUTPUT_LINE_CHARACTERS = 2_048;

export async function runDesktopShellSmoke({
  environment = process.env,
  evidenceRoot = path.resolve(".test", "e2e-desktop-shell"),
  observe = observeDesktopShell,
  removeIsolation = rm,
} = {}) {
  const runId = identifier(
    environment.SYMPHONY_DESKTOP_SMOKE_RUN_ID ?? randomUUID(),
    "desktop_shell_run_id_invalid",
  );
  const binary = path.resolve(
    environment.SYMPHONY_DESKTOP_SMOKE_BINARY ?? defaultBinary(),
  );
  const evidenceDirectory = path.resolve(evidenceRoot, runId);
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });

  let isolationRoot;
  let observation;
  let failureReason;
  try {
    try {
      await access(binary, constants.X_OK);
    } catch {
      failureReason = "desktop_shell_binary_missing";
    }
    if (!failureReason) {
      isolationRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-desktop-shell-"));
      await Promise.all([
        "app-data",
        "cache",
        "config",
        "data",
        "local-data",
        "tmp",
      ].map((directory) => mkdir(path.join(isolationRoot, directory), { mode: 0o700 })));
      try {
        observation = await observe({
          binary,
          environment: createDesktopShellEnvironment({
            environment,
            isolationRoot,
            additions: {
              SYMPHONY_LINEAR_CLIENT_ID: `desktop-shell-${randomUUID()}`,
              SYMPHONY_LINEAR_CLIENT_SECRET: randomUUID(),
            },
          }),
        });
      } catch (error) {
        failureReason = observationFailure(error);
      }
    }
  } catch {
    failureReason = "desktop_shell_observation_invalid";
  }

  if (isolationRoot) {
    try {
      await removeIsolation(isolationRoot, { recursive: true, force: true });
    } catch {
      failureReason = "desktop_shell_cleanup_failed";
    }
  }

  const verdict = createDesktopShellVerdict({
    runId,
    observation,
    ...(failureReason ? { failureReason } : {}),
  });
  await writeFile(
    path.join(evidenceDirectory, "result.json"),
    `${JSON.stringify(verdict, null, 2)}\n`,
    { mode: 0o600 },
  );
  return verdict;
}

export async function observeDesktopShell({
  binary,
  environment = {},
  timeoutMs = 60_000,
  launch = spawn,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("desktop_shell_timeout_invalid");
  }
  const child = launch(binary, [], {
    cwd: path.dirname(binary),
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    return await waitForStartupEvents(child, timeoutMs);
  } finally {
    await stopProcessTree(child, exited);
  }
}

function waitForStartupEvents(child, timeoutMs) {
  if (!child.stdout) {
    throw new Error("desktop_shell_output_unavailable");
  }
  return new Promise((resolve, reject) => {
    const observed = new Set();
    let settled = false;
    const onLine = (line) => {
      const event = parseStartupEvent(line);
      if (!event) return;
      observed.add(event);
      if (REQUIRED_STARTUP_EVENTS.every((required) => observed.has(required))) {
        finish(resolve, Object.freeze({
          schema_version: 1,
          suite: "desktop-shell-smoke-observation",
          webview_loaded: true,
          podium_backend_responded: true,
        }));
      }
    };
    const onStdout = createLineConsumer(onLine);
    const onError = () => finish(reject, new Error("desktop_shell_process_start_failed"));
    const onExit = () => finish(reject, new Error("desktop_shell_process_exited"));
    const timer = setTimeout(
      () => finish(reject, new Error("desktop_shell_observation_timeout")),
      timeoutMs,
    );

    child.stdout.on("data", onStdout);
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.off("error", onError);
      child.off("exit", onExit);
      callback(value);
    }
  });
}

function createLineConsumer(onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let discarding = false;
  return (chunk) => {
    let text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (text.length > 0) {
      const newline = text.indexOf("\n");
      if (newline < 0) {
        if (!discarding) {
          if (buffer.length + text.length <= MAX_OUTPUT_LINE_CHARACTERS) {
            buffer += text;
          } else {
            buffer = "";
            discarding = true;
          }
        }
        return;
      }
      const segment = text.slice(0, newline);
      text = text.slice(newline + 1);
      if (!discarding) {
        const line = `${buffer}${segment}`;
        onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
      buffer = "";
      discarding = false;
    }
  };
}

function parseStartupEvent(line) {
  if (line.length === 0 || line.length > MAX_OUTPUT_LINE_CHARACTERS) return undefined;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== STARTUP_EVENT_KEYS.length ||
    !keys.every((key, index) => key === STARTUP_EVENT_KEYS[index]) ||
    value.schema_version !== 1 ||
    value.component !== "podium-desktop" ||
    !REQUIRED_STARTUP_EVENTS.includes(value.event)
  ) {
    return undefined;
  }
  return value.event;
}

async function stopProcessTree(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, "SIGTERM");
  await waitForExit(exited, 5_000);
  if (child.exitCode === null && child.signalCode === null) {
    signalProcessTree(child, "SIGKILL");
    await waitForExit(exited, 2_000);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("desktop_shell_process_stop_timeout");
  }
}

function signalProcessTree(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForExit(exited, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function defaultBinary() {
  return path.join(
    "apps",
    "podium-desktop",
    "src-tauri",
    "target",
    "debug",
    process.platform === "win32"
      ? "symphony-podium-desktop.exe"
      : "symphony-podium-desktop",
  );
}

function identifier(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

function observationFailure(error) {
  const reason = error instanceof Error ? error.message : undefined;
  return typeof reason === "string" && /^desktop_shell_[a-z0-9_]{1,96}$/u.test(reason)
    ? reason
    : "desktop_shell_observation_failed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDesktopShellSmoke()
    .then((verdict) => {
      process.stdout.write(`${JSON.stringify(verdict)}\n`);
      if (verdict.status !== "passed") process.exitCode = 1;
    })
    .catch(() => {
      process.stderr.write(`${JSON.stringify({
        suite: "desktop-shell-smoke",
        status: "failed",
        reason: "desktop_shell_runner_failed",
      })}\n`);
      process.exitCode = 1;
    });
}
