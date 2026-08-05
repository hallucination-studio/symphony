import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_E2E_DURATION_MS, partitionEnvironment, runSupervisor } from "./e2e-supervisor.mjs";

const secret = "supervisor-secret-not-output";

function envSource(entries) {
  return Object.entries(entries).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n");
}

test("supervisor partitions .env credentials without crossing boundary ownership", () => {
  const partitions = partitionEnvironment({
    LINEAR_API_KEY: secret,
    SYMPHONY_RECONCILE_CODEX_API_KEY: "reconcile-secret-not-output",
    SYMPHONY_RECONCILE_CODEX_BASE_URL: "https://reconcile.example.test/v1",
    SYMPHONY_EXECUTE_CODEX_API_KEY: "execute-secret-not-output",
    SYMPHONY_EXECUTE_CODEX_BASE_URL: "https://execute.example.test/v1",
    SYMPHONY_AUDIT_CODEX_API_KEY: "audit-secret-not-output",
    SYMPHONY_AUDIT_CODEX_BASE_URL: "https://audit.example.test/v1",
    CODEX_API_KEY: "generic-secret-must-not-forward",
    GH_TOKEN: "pr-secret-not-output",
    SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "human-secret-not-output",
    SYMPHONY_E2E_PROJECT_SLUG_ID: "golden-project",
    SYMPHONY_CODEX_BASE_URL: "https://codex.example.test/v1",
    ARBITRARY_API_KEY: "must-not-forward",
  }, { PATH: "/usr/bin", HOME: "/tmp/home" });
  assert.equal(partitions.testEnvironment.LINEAR_API_KEY, undefined);
  assert.equal(partitions.linearEnvironment.LINEAR_API_KEY, secret);
  assert.equal(partitions.reconcileEnvironment.CODEX_API_KEY, "reconcile-secret-not-output");
  assert.equal(partitions.reconcileEnvironment.CODEX_BASE_URL, "https://reconcile.example.test/v1");
  assert.equal(partitions.executeEnvironment.CODEX_API_KEY, "execute-secret-not-output");
  assert.equal(partitions.executeEnvironment.CODEX_BASE_URL, "https://execute.example.test/v1");
  assert.equal(partitions.auditEnvironment.CODEX_API_KEY, "audit-secret-not-output");
  assert.equal(partitions.auditEnvironment.CODEX_BASE_URL, "https://audit.example.test/v1");
  assert.equal(partitions.reconcileEnvironment.SYMPHONY_EXECUTE_CODEX_API_KEY, undefined);
  assert.equal(partitions.executeEnvironment.SYMPHONY_AUDIT_CODEX_API_KEY, undefined);
  assert.equal(partitions.auditEnvironment.SYMPHONY_RECONCILE_CODEX_API_KEY, undefined);
  assert.equal(partitions.prEnvironment.GH_TOKEN, "pr-secret-not-output");
  assert.equal(partitions.linearEnvironment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, undefined);
  assert.equal(partitions.reconcileEnvironment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, undefined);
  assert.equal(partitions.prEnvironment.SYMPHONY_E2E_PROJECT_SLUG_ID, undefined);
  assert.equal(partitions.linearEnvironment.CODEX_BASE_URL, undefined);
  assert.equal(partitions.linearEnvironment.ARBITRARY_API_KEY, undefined);
});

test("supervisor runs local layers and reports external layers as blocked", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-supervisor-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  await writeFile(envPath, envSource({
    LINEAR_API_KEY: secret,
    SYMPHONY_RECONCILE_CODEX_API_KEY: "reconcile-secret-not-output",
    SYMPHONY_EXECUTE_CODEX_API_KEY: "execute-secret-not-output",
    SYMPHONY_AUDIT_CODEX_API_KEY: "audit-secret-not-output",
  }), { encoding: "utf8", mode: 0o600 });
  let testRun = false;
  const result = await runSupervisor({
    envPath,
    testFiles: [path.join(directory, "deterministic.test.mjs")],
    inherited: { PATH: "/usr/bin", HOME: "/tmp/home" },
    runTests: async (_files, environment) => {
      testRun = true;
      assert.equal(environment.LINEAR_API_KEY, undefined);
      assert.equal(environment.CODEX_API_KEY, undefined);
      return { code: 0, signal: null };
    },
  });
  assert.equal(testRun, true);
  assert.equal(result.code, 0);
  assert.equal(result.boundary_results.length, 5);
  assert.equal(result.blocked.every((entry) => entry.status === "blocked"), true);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("supervisor reports missing .env as blocked while still allowing deterministic layers", async () => {
  const result = await runSupervisor({
    envPath: path.join(os.tmpdir(), "symphony-e2e-env-does-not-exist"),
    testFiles: [path.join(process.cwd(), "tests/e2e/black-box-runner.test.mjs")],
    inherited: {},
    runTests: async () => ({ code: 0, signal: null }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.boundary_results.length, 5);
  assert.equal(result.blocked.some((entry) => entry.boundary === "supervisor" && entry.reason === "env_unavailable"), true);
});

test("supervisor fails when an external boundary fails", async () => {
  const result = await runSupervisor({
    envPath: path.join(os.tmpdir(), "symphony-e2e-valid-env-does-not-exist"),
    testFiles: [path.join(process.cwd(), "tests/e2e/black-box-runner.test.mjs")],
    inherited: {},
    runTests: async () => ({ code: 0, signal: null }),
    runBoundaries: async () => [{ status: "failed", layer: "real_linear", reason: "linear_boundary_failed" }],
    runGolden: async () => ({ status: "passed", layer: "golden" }),
  });

  assert.equal(result.code, 1);
  assert.equal(result.reason, "e2e_boundary_failed");
  assert.deepEqual(result.boundary_results, [
    { status: "failed", layer: "real_linear", reason: "linear_boundary_failed" },
    { status: "passed", layer: "golden" },
  ]);
  assert.equal(result.blocked.some((entry) => entry.boundary === "supervisor"), true);
});

test("a passed golden run covers the independent Linear probe without a preconfigured Root", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-golden-coverage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  await writeFile(envPath, `SYMPHONY_LINEAR_TOKEN=${secret}\n`, { encoding: "utf8", mode: 0o600 });
  const result = await runSupervisor({
    envPath,
    testFiles: [path.join(directory, "deterministic.test.mjs")],
    inherited: {},
    runTests: async () => ({ code: 0, signal: null }),
    runBoundaries: async () => [
      { status: "blocked", boundary: "linear", reason: "root_input_missing" },
      { status: "passed", layer: "real_codex", boundary: "codex" },
      { status: "passed", layer: "real_git", boundary: "git" },
      { status: "passed", layer: "real_pr", boundary: "pr" },
    ],
    runGolden: async () => ({ status: "passed", layer: "golden", result: { status: "done" } }),
  });
  assert.equal(result.blocked, undefined);
});

test("supervisor applies one deadline across local, real-boundary, and golden phases", async () => {
  const phases = [];
  const startedAt = Date.now();
  const result = await runSupervisor({
    envPath: path.join(os.tmpdir(), "symphony-e2e-deadline-env-does-not-exist"),
    testFiles: [path.join(process.cwd(), "tests/e2e/black-box-runner.test.mjs")],
    inherited: {},
    maxDurationMs: 40,
    runTests: async (_files, _environment, timeoutMs) => {
      phases.push(["local", timeoutMs]);
      return { code: 0, signal: null };
    },
    runBoundaries: async () => {
      phases.push(["real"]);
      return [];
    },
    runGolden: async () => {
      phases.push(["golden"]);
      return new Promise(() => {});
    },
  });

  assert.equal(result.code, 124);
  assert.equal(result.reason, "e2e_timeout");
  assert.deepEqual(phases.map(([phase]) => phase), ["local", "real", "golden"]);
  assert.ok(phases[0][1] <= 40);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("the default E2E runner command includes every local layer", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const command = packageJson.scripts["test:e2e:runner"];
  for (const file of [
    "black-box-runner.test.mjs",
    "deterministic-scenarios.test.mjs",
    "real-boundary-runners.test.mjs",
    "golden-runner.test.mjs",
    "e2e-supervisor.test.mjs",
  ]) {
    assert.equal(command.includes(`tests/e2e/${file}`), true);
  }
});

test("supervisor enforces the bounded E2E duration", async () => {
  assert.ok(MAX_E2E_DURATION_MS < 5 * 60_000);
  await assert.rejects(
    runSupervisor({ maxDurationMs: MAX_E2E_DURATION_MS + 1, runTests: async () => ({ code: 0, signal: null }) }),
    /invalid_e2e_configuration/u,
  );
});
