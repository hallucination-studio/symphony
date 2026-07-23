import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { killProcessTree } from "./run-with-timeout.mjs";
import { TARGET_E2E_TIMEOUT_MS, remainingTargetWorkflowTimeout } from "./target-workflow-deadline.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SCENARIOS = new Set([
  "success", "repair_escalation", "restart_recovery", "delivery", "scheduling",
]);

export async function createPreparedSetupFile(setup, { temporaryRoot = os.tmpdir() } = {}) {
  if (!setup || typeof setup !== "object" || Array.isArray(setup)) {
    throw stableError("target_scenario_setup_invalid");
  }
  let directory;
  try {
    directory = await mkdtemp(path.join(temporaryRoot, "symphony-e2e-all-"));
    const filePath = path.join(directory, "prepared-setup.json");
    await writeFile(filePath, `${JSON.stringify(setup)}\n`, { mode: 0o600 });
    return Object.freeze({ directory, filePath });
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw stableError("target_scenario_setup_write_failed");
  }
}

export async function removePreparedSetupFile(handle) {
  if (!handle || typeof handle.directory !== "string") return;
  await rm(handle.directory, { recursive: true, force: true });
}

export async function runTargetWorkflowScenarioProcess({
  scenario,
  setupFile,
  environment = process.env,
  deadlineAtMs,
  signal,
  executable = process.execPath,
  entryPath = path.resolve("tools/e2e/target-workflow-entry.mjs"),
  timeoutPath = path.resolve("tools/e2e/run-with-timeout.mjs"),
  cwd = process.cwd(),
  spawnProcess = spawn,
} = {}) {
  if (!SCENARIOS.has(scenario) || typeof setupFile !== "string" || setupFile.length === 0 ||
      !environment || typeof environment !== "object" || !Number.isSafeInteger(deadlineAtMs) ||
      typeof executable !== "string" || typeof entryPath !== "string" || typeof timeoutPath !== "string" ||
      typeof cwd !== "string" || typeof spawnProcess !== "function") {
    throw stableError("target_scenario_process_input_invalid");
  }
  const baseRunId = environment.SYMPHONY_E2E_RUN_ID;
  if (!SAFE_ID.test(baseRunId ?? "")) throw stableError("target_live_run_id_invalid");
  const remaining = remainingTargetWorkflowTimeout(deadlineAtMs);
  const child = spawnProcess(executable, [
    timeoutPath,
    "--timeout-ms", String(Math.min(TARGET_E2E_TIMEOUT_MS, remaining)),
    "--",
    executable,
    entryPath,
    "--live-scenario", scenario,
    "--setup-file", setupFile,
  ], {
    cwd,
    env: { ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding?.("utf8");
  child.stderr?.setEncoding?.("utf8");
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

  return new Promise((resolve, reject) => {
    let settled = false;
    let aborting = false;
    let childExited = false;
    const abortHandler = () => {
      if (settled || aborting) return;
      aborting = true;
      killProcessTree(child);
      void finishAbort();
    };
    const cleanup = () => signal?.removeEventListener("abort", abortHandler);
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    if (signal?.aborted) {
      abortHandler();
      return;
    }
    signal?.addEventListener("abort", abortHandler, { once: true });
    child.once("error", () => {
      if (!aborting) finishReject(stableError("target_scenario_process_start_failed"));
    });
    child.once("exit", (code, childSignal) => {
      childExited = true;
      if (aborting) return;
      if (code !== 0) {
        finishReject(stableError(code === 124 ? "target_scenario_timeout" :
          childSignal ? "target_scenario_terminated" : childErrorReason(stderr)));
        return;
      }
      let envelope;
      try {
        const line = stdout.trim().split("\n").at(-1);
        envelope = JSON.parse(line ?? "");
      } catch {
        finishReject(stableError("target_scenario_output_invalid"));
        return;
      }
      if (!envelope || typeof envelope !== "object" ||
          envelope.result?.scenario !== scenario || !envelope.observation ||
          typeof envelope.observation !== "object") {
        finishReject(stableError("target_scenario_output_invalid"));
        return;
      }
      finishResolve(Object.freeze({
        result: envelope.result,
        observation: envelope.observation,
        cleanupCompleted: true,
      }));
    });

    async function finishAbort() {
      await waitForChildExit(child, () => childExited, 250);
      if (!childExited) {
        killProcessTree(child, "SIGKILL");
        await waitForChildExit(child, () => childExited, 100);
      }
      finishReject(stableError("target_scenario_aborted", { cleanupCompleted: childExited }));
    }
  });
}

function waitForChildExit(child, hasExited, timeoutMs) {
  if (hasExited()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onExit);
    };
    child.once("exit", onExit);
    child.once("error", onExit);
  });
}

function childErrorReason(stderr) {
  const lines = String(stderr).trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (typeof value?.reason === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(value.reason)) {
        return value.reason;
      }
    } catch {
      // Child logs are diagnostic only; never return arbitrary stderr.
    }
  }
  return "target_scenario_process_failed";
}

function stableError(code, properties = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, properties);
  return error;
}
