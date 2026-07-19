import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateCoreLiveEvidence } from "../../tools/e2e/core-live-verdict.mjs";
import {
  observeDesktopShell,
  runDesktopShellSmoke,
} from "../../tools/e2e/desktop-shell-smoke.mjs";
import { createDesktopShellVerdict } from "../../tools/e2e/desktop-shell-verdict.mjs";

const PASSED_OBSERVATION = Object.freeze({
  schema_version: 1,
  suite: "desktop-shell-smoke-observation",
  webview_loaded: true,
  podium_backend_responded: true,
});

test("Desktop shell verdict cannot satisfy the core live contract", () => {
  const verdict = createDesktopShellVerdict({
    runId: "desktop-run-1",
    observation: PASSED_OBSERVATION,
  });

  assert.deepEqual(verdict, {
    schema_version: 1,
    suite: "desktop-shell-smoke",
    run_id: "desktop-run-1",
    status: "passed",
    reason: null,
    observations: {
      podium_backend_responded: true,
      webview_loaded: true,
    },
  });
  assert.equal(evaluateCoreLiveEvidence(verdict).verdict, "failed");
});

test("Desktop shell runner uses an isolated secret-free process and writes bounded evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-desktop-smoke-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "symphony-podium-desktop");
  const evidenceRoot = path.join(root, "evidence");
  await writeFile(binary, "desktop", { mode: 0o700 });
  await chmod(binary, 0o700);
  let childEnvironment;

  const verdict = await runDesktopShellSmoke({
    environment: {
      PATH: process.env.PATH,
      HOME: "/private/user-home",
      SYMPHONY_DESKTOP_SMOKE_BINARY: binary,
      SYMPHONY_DESKTOP_SMOKE_RUN_ID: "desktop-run-1",
      SYMPHONY_E2E_LINEAR_DEV_TOKEN: "linear-secret-canary",
      SYMPHONY_E2E_CODEX_API_KEY: "codex-secret-canary",
      SYMPHONY_LINEAR_CLIENT_ID: "operator-client-id",
      SYMPHONY_LINEAR_CLIENT_SECRET: "operator-client-secret",
      LINEAR_CLIENT_SECRET: "legacy-linear-secret-canary",
      OPENAI_API_KEY: "legacy-codex-secret-canary",
      GH_TOKEN: "github-secret-canary",
    },
    evidenceRoot,
    async observe(options) {
      childEnvironment = options.environment;
      return PASSED_OBSERVATION;
    },
  });

  assert.equal(verdict.status, "passed");
  assert.equal(childEnvironment.HOME.includes("/private/user-home"), false);
  assert.notEqual(childEnvironment.SYMPHONY_LINEAR_CLIENT_ID, "operator-client-id");
  assert.notEqual(
    childEnvironment.SYMPHONY_LINEAR_CLIENT_SECRET,
    "operator-client-secret",
  );
  for (const key of [
    "SYMPHONY_E2E_LINEAR_DEV_TOKEN",
    "SYMPHONY_E2E_CODEX_API_KEY",
    "LINEAR_CLIENT_SECRET",
    "OPENAI_API_KEY",
    "GH_TOKEN",
  ]) {
    assert.equal(childEnvironment[key], undefined);
  }
  assert.deepEqual(
    JSON.parse(await readFile(path.join(evidenceRoot, "desktop-run-1", "result.json"), "utf8")),
    verdict,
  );
});

test("Desktop shell runner records a stable observation failure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-desktop-smoke-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "symphony-podium-desktop");
  const evidenceRoot = path.join(root, "evidence");
  await writeFile(binary, "desktop", { mode: 0o700 });

  const verdict = await runDesktopShellSmoke({
    environment: {
      PATH: process.env.PATH,
      SYMPHONY_DESKTOP_SMOKE_BINARY: binary,
      SYMPHONY_DESKTOP_SMOKE_RUN_ID: "desktop-run-failed",
    },
    evidenceRoot,
    async observe() {
      throw new Error("driver failed");
    },
  });

  assert.equal(verdict.status, "failed");
  assert.equal(verdict.reason, "desktop_shell_observation_failed");
});

test("Desktop shell runner records cleanup failure in its verdict", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-desktop-smoke-test-"));
  const binary = path.join(root, "symphony-podium-desktop");
  const evidenceRoot = path.join(root, "evidence");
  let isolationRoot;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (isolationRoot) await rm(isolationRoot, { recursive: true, force: true });
  });
  await writeFile(binary, "desktop", { mode: 0o700 });

  const verdict = await runDesktopShellSmoke({
    environment: {
      PATH: process.env.PATH,
      SYMPHONY_DESKTOP_SMOKE_BINARY: binary,
      SYMPHONY_DESKTOP_SMOKE_RUN_ID: "desktop-run-cleanup-failed",
    },
    evidenceRoot,
    async observe(options) {
      isolationRoot = options.environment.HOME;
      return PASSED_OBSERVATION;
    },
    async removeIsolation() {
      throw new Error("filesystem detail must not escape");
    },
  });

  assert.equal(verdict.status, "failed");
  assert.equal(verdict.reason, "desktop_shell_cleanup_failed");
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(evidenceRoot, "desktop-run-cleanup-failed", "result.json"),
        "utf8",
      ),
    ),
    verdict,
  );
});

test("Desktop shell observer accepts only exact production startup events", async () => {
  const lines = [
    "unstructured startup output",
    JSON.stringify({
      schema_version: 1,
      component: "podium-desktop",
      event: "desktop_webview_loaded",
      injected: true,
    }),
    JSON.stringify({
      schema_version: 1,
      component: "podium-desktop",
      event: "desktop_webview_loaded",
    }),
    JSON.stringify({
      schema_version: 1,
      component: "podium-desktop",
      event: "desktop_podium_backend_responded",
    }),
  ];
  const program = `for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + "\\n"); setInterval(() => {}, 1_000);`;

  const observation = await observeDesktopShell({
    binary: "unused-test-binary",
    environment: { PATH: process.env.PATH },
    timeoutMs: 5_000,
    launch(_binary, _arguments, options) {
      return spawn(process.execPath, ["-e", program], options);
    },
  });

  assert.deepEqual(observation, PASSED_OBSERVATION);
});

test("Desktop shell observer rejects startup markers written by a sidecar to stderr", async () => {
  const events = [
    "desktop_webview_loaded",
    "desktop_podium_backend_responded",
  ];
  const program = `for (const event of ${JSON.stringify(events)}) process.stderr.write(JSON.stringify({ schema_version: 1, component: "podium-desktop", event }) + "\\n"); setTimeout(() => process.exit(0), 25);`;

  await assert.rejects(
    observeDesktopShell({
      binary: "unused-test-binary",
      environment: { PATH: process.env.PATH },
      timeoutMs: 5_000,
      launch(_binary, _arguments, options) {
        return spawn(process.execPath, ["-e", program], options);
      },
    }),
    /desktop_shell_process_exited/u,
  );
});

test("Desktop shell observer preserves a process start failure when no PID exists", async () => {
  const missingBinary = path.join(
    os.tmpdir(),
    `symphony-missing-desktop-${process.pid}-${Date.now()}`,
    "symphony-podium-desktop",
  );

  await assert.rejects(
    observeDesktopShell({
      binary: missingBinary,
      timeoutMs: 100,
    }),
    /desktop_shell_process_start_failed/u,
  );
});
