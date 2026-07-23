import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createPreparedSetupFile,
  removePreparedSetupFile,
  runTargetWorkflowScenarioProcess,
} from "../../tools/e2e/target-workflow-process.mjs";

function fakeChildProcess(envelope, { exitCode = 0 } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners = new Map();
  const child = {
    pid: 999_991,
    stdout,
    stderr,
    once(event, listener) {
      listeners.set(event, listener);
      return this;
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
      return this;
    },
    kill() {},
  };
  queueMicrotask(() => {
    stdout.end(`${JSON.stringify(envelope)}\n`);
    listeners.get("exit")?.(exitCode, null);
  });
  return child;
}

test("scenario process runner gives each child its own watchdog command and correlation", async () => {
  const handle = await createPreparedSetupFile({ setup: {}, ids: {} });
  const calls = [];
  try {
    const result = await runTargetWorkflowScenarioProcess({
      scenario: "success",
      setupFile: handle.filePath,
      environment: { SYMPHONY_E2E_RUN_ID: "target-process" },
      deadlineAtMs: Date.now() + 30_000,
      executable: "node",
      entryPath: "target-entry.mjs",
      timeoutPath: "run-with-timeout.mjs",
      spawnProcess: (executable, arguments_, options) => {
        calls.push({ executable, arguments_, options });
        return fakeChildProcess({
          result: { scenario: "success", status: "passed" },
          observation: {
            logicalOperations: 1,
            physicalRequests: 2,
            complexityConsumed: 3,
            rateLimited: false,
          },
          cleanupCompleted: true,
        });
      },
    });
    assert.equal(result.result.scenario, "success");
    assert.deepEqual(result.observation, {
      logicalOperations: 1,
      physicalRequests: 2,
      complexityConsumed: 3,
      rateLimited: false,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].arguments_.slice(0, 1), ["run-with-timeout.mjs"]);
    const configuredTimeout = Number(calls[0].arguments_[2]);
    assert.ok(Number.isSafeInteger(configuredTimeout) && configuredTimeout >= 1 && configuredTimeout <= 30_000);
    assert.deepEqual(calls[0].arguments_.slice(3), [
      "--", "node", "target-entry.mjs", "--live-scenario", "success",
      "--setup-file", handle.filePath,
    ]);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.env.SYMPHONY_E2E_RUN_ID, "target-process");
  } finally {
    await removePreparedSetupFile(handle);
  }
});

test("scenario process runner converts a child watchdog exit into a stable timeout", async () => {
  const handle = await createPreparedSetupFile({ setup: {}, ids: {} });
  try {
    await assert.rejects(
      runTargetWorkflowScenarioProcess({
        scenario: "scheduling",
        setupFile: handle.filePath,
        environment: { SYMPHONY_E2E_RUN_ID: "target-process-timeout" },
        deadlineAtMs: Date.now() + 30_000,
        spawnProcess: () => fakeChildProcess({}, { exitCode: 124 }),
      }),
      /target_scenario_timeout/u,
    );
  } finally {
    await removePreparedSetupFile(handle);
  }
});

test("scenario process runner waits through bounded group termination on cancellation", async () => {
  const handle = await createPreparedSetupFile({ setup: {}, ids: {} });
  const controller = new AbortController();
  const signals = [];
  const child = {
    pid: 999_992,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    listeners: new Map(),
    once(event, listener) {
      this.listeners.set(event, listener);
      return this;
    },
    removeListener(event, listener) {
      if (this.listeners.get(event) === listener) this.listeners.delete(event);
      return this;
    },
    kill(signal) { signals.push(signal); },
  };
  try {
    const promise = runTargetWorkflowScenarioProcess({
      scenario: "success",
      setupFile: handle.filePath,
      environment: { SYMPHONY_E2E_RUN_ID: "target-process-cancel" },
      deadlineAtMs: Date.now() + 30_000,
      signal: controller.signal,
      spawnProcess: () => child,
    });
    controller.abort();
    await assert.rejects(promise, /target_scenario_aborted/u);
    assert.ok(signals.length >= 1);
  } finally {
    await removePreparedSetupFile(handle);
  }
});
