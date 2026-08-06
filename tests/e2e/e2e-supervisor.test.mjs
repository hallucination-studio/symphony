import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_E2E_DURATION_MS,
  MAX_E2E_SCENARIO_DURATION_MS,
  parseScenarioArgs,
  partitionEnvironment,
  runSupervisor,
} from "./e2e-supervisor.mjs";

const secret = "supervisor-secret-not-output";

function envSource(entries) {
  return Object.entries(entries).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n");
}

test("supervisor partitions .env credentials without crossing boundary ownership", () => {
  const partitions = partitionEnvironment({
    LINEAR_API_KEY: secret,
    SYMPHONY_RECONCILE_CODEX_API_KEY: "reconcile-secret-not-output",
    SYMPHONY_RECONCILE_CODEX_BASE_URL: "https://reconcile.example.test/v1",
    SYMPHONY_ARTIST_CODEX_API_KEY: "execute-secret-not-output",
    SYMPHONY_ARTIST_CODEX_BASE_URL: "https://execute.example.test/v1",
    SYMPHONY_CRITIC_CODEX_API_KEY: "audit-secret-not-output",
    SYMPHONY_CRITIC_CODEX_BASE_URL: "https://audit.example.test/v1",
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
  assert.equal(partitions.artistEnvironment.CODEX_API_KEY, "execute-secret-not-output");
  assert.equal(partitions.artistEnvironment.CODEX_BASE_URL, "https://execute.example.test/v1");
  assert.equal(partitions.criticEnvironment.CODEX_API_KEY, "audit-secret-not-output");
  assert.equal(partitions.criticEnvironment.CODEX_BASE_URL, "https://audit.example.test/v1");
  assert.equal(partitions.reconcileEnvironment.SYMPHONY_ARTIST_CODEX_API_KEY, undefined);
  assert.equal(partitions.artistEnvironment.SYMPHONY_CRITIC_CODEX_API_KEY, undefined);
  assert.equal(partitions.criticEnvironment.SYMPHONY_RECONCILE_CODEX_API_KEY, undefined);
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
    SYMPHONY_ARTIST_CODEX_API_KEY: "execute-secret-not-output",
    SYMPHONY_CRITIC_CODEX_API_KEY: "audit-secret-not-output",
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

test("a passed golden run suppresses covered blocked probes but preserves unknown boundaries", async (context) => {
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
      { status: "blocked", boundary: "codex", reason: "real_boundary_not_enabled" },
      { status: "blocked", boundary: "git", reason: "real_boundary_not_enabled" },
      { status: "blocked", boundary: "pr", reason: "real_boundary_not_enabled" },
      { status: "blocked", boundary: "future_boundary", reason: "diagnostic_not_enabled" },
    ],
    runGolden: async () => ({ status: "passed", layer: "golden", result: { status: "done" } }),
  });
  assert.deepEqual(result.boundary_results, [
    { status: "blocked", boundary: "future_boundary", reason: "diagnostic_not_enabled" },
    { status: "passed", layer: "golden", result: { status: "done" } },
  ]);
  assert.deepEqual(result.blocked, [
    { status: "blocked", boundary: "future_boundary", reason: "diagnostic_not_enabled" },
  ]);
});

test("explicit real-boundary diagnostics retain covered blocked probes after Golden success", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-golden-diagnostics-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  await writeFile(envPath, `SYMPHONY_LINEAR_TOKEN=${secret}\n`, { encoding: "utf8", mode: 0o600 });
  const independent = [
    { status: "blocked", boundary: "linear", reason: "root_input_missing" },
    { status: "blocked", boundary: "codex", reason: "real_boundary_not_enabled" },
    { status: "blocked", boundary: "git", reason: "real_boundary_not_enabled" },
    { status: "blocked", boundary: "pr", reason: "real_boundary_not_enabled" },
  ];
  const result = await runSupervisor({
    envPath,
    testFiles: [path.join(directory, "deterministic.test.mjs")],
    inherited: { SYMPHONY_RUN_REAL_BOUNDARIES: "1" },
    runTests: async () => ({ code: 0, signal: null }),
    runBoundaries: async () => independent,
    runGolden: async () => ({ status: "passed", layer: "golden" }),
  });
  assert.deepEqual(result.boundary_results, [...independent, { status: "passed", layer: "golden" }]);
  assert.deepEqual(result.blocked, independent);
});

test("Golden coverage hides only blocked probes and keeps failed boundary evidence", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-golden-failed-boundary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  await writeFile(envPath, `SYMPHONY_LINEAR_TOKEN=${secret}\n`, { encoding: "utf8", mode: 0o600 });
  const failedBoundary = {
    status: "failed", layer: "real_linear", boundary: "linear", reason: "linear_probe_failed",
  };
  const unknownBlocked = { status: "blocked", boundary: "future_boundary", reason: "diagnostic_not_enabled" };
  const result = await runSupervisor({
    envPath,
    testFiles: [path.join(directory, "deterministic.test.mjs")],
    inherited: {},
    runTests: async () => ({ code: 0, signal: null }),
    runBoundaries: async () => [
      failedBoundary,
      { status: "blocked", boundary: "codex", reason: "real_boundary_not_enabled" },
      unknownBlocked,
    ],
    runGolden: async () => ({ status: "passed", layer: "golden" }),
  });
  assert.equal(result.code, 1);
  assert.equal(result.reason, "e2e_boundary_failed");
  assert.deepEqual(result.boundary_results, [failedBoundary, unknownBlocked, { status: "passed", layer: "golden" }]);
  assert.deepEqual(result.blocked, [unknownBlocked]);
});

test("Golden blocked or failed results retain all probes and diagnostic references", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-golden-outcome-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  await writeFile(envPath, `SYMPHONY_LINEAR_TOKEN=${secret}\n`, { encoding: "utf8", mode: 0o600 });
  const independent = [
    { status: "blocked", boundary: "linear", reason: "root_input_missing" },
    { status: "blocked", boundary: "codex", reason: "real_boundary_not_enabled" },
  ];
  const goldenOutcomes = [
    { status: "blocked", boundary: "golden", reason: "golden_not_enabled" },
    { status: "failed", layer: "golden", reason: "golden_conductor_failed", diagnostic_ref: "/tmp/golden-diagnostic" },
  ];
  for (const goldenResult of goldenOutcomes) {
    const result = await runSupervisor({
      envPath,
      testFiles: [path.join(directory, "deterministic.test.mjs")],
      inherited: {},
      runTests: async () => ({ code: 0, signal: null }),
      runBoundaries: async () => independent,
      runGolden: async () => goldenResult,
    });
    assert.deepEqual(result.boundary_results, [...independent, goldenResult]);
    assert.deepEqual(result.blocked, goldenResult.status === "blocked"
      ? [...independent, goldenResult]
      : independent);
    if (goldenResult.status === "failed") assert.equal(result.boundary_results.at(-1)?.diagnostic_ref, "/tmp/golden-diagnostic");
  }
});

test("supervisor applies one overall deadline across all phases", async () => {
  const phases = [];
  const startedAt = Date.now();
  const result = await runSupervisor({
    envPath: path.join(os.tmpdir(), "symphony-e2e-deadline-env-does-not-exist"),
    testFiles: [path.join(process.cwd(), "tests/e2e/black-box-runner.test.mjs")],
    inherited: {},
    maxDurationMs: 40,
    cleanupGraceMs: 20,
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

test("supervisor aborts an active golden operation and returns after bounded cleanup grace", async () => {
  const startedAt = Date.now();
  let goldenSignal;
  let aborts = 0;
  const result = await runSupervisor({
    envPath: path.join(os.tmpdir(), "symphony-e2e-abort-env-does-not-exist"),
    inherited: {},
    maxDurationMs: 20,
    cleanupGraceMs: 20,
    runTests: async () => ({ code: 0, signal: null }),
    runBoundaries: async () => [],
    runGolden: async ({ signal }) => {
      goldenSignal = signal;
      signal.addEventListener("abort", () => { aborts += 1; }, { once: true });
      return new Promise(() => {});
    },
  });

  assert.equal(result.code, 124);
  assert.equal(result.reason, "e2e_timeout");
  assert.ok(goldenSignal instanceof AbortSignal);
  assert.equal(goldenSignal.aborted, true);
  assert.equal(aborts, 1);
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
  assert.equal(MAX_E2E_DURATION_MS, 6 * 60_000);
  assert.equal(MAX_E2E_SCENARIO_DURATION_MS, 5 * 60_000);
  await assert.rejects(
    runSupervisor({ maxDurationMs: MAX_E2E_DURATION_MS + 1, runTests: async () => ({ code: 0, signal: null }) }),
    /invalid_e2e_configuration/u,
  );
});

test("scenario selection defaults to all six and validates explicit focus", () => {
  assert.equal(parseScenarioArgs([]), undefined);
  assert.equal(parseScenarioArgs(["--scenario", "cycle-human-action-cycle"]), "cycle-human-action-cycle");
  assert.equal(parseScenarioArgs(["--scenario=human-action-unanswered"]), "human-action-unanswered");
  assert.throws(() => parseScenarioArgs(["--scenario", "unknown"]), /e2e_scenario_invalid/u);
  assert.throws(() => parseScenarioArgs(["--scenario", "single-cycle", "--scenario", "multi-cycle"]), /invalid_e2e_scenario/u);
});

test("default supervisor evaluates every deterministic and golden scenario", async () => {
  const seenLocalEnvironments = [];
  const seenGolden = [];
  const result = await runSupervisor({
    envPath: path.join(os.tmpdir(), "symphony-e2e-scenario-selection-env-does-not-exist"),
    inherited: {},
    runAllScenarios: true,
    runTests: async (_files, environment) => {
      seenLocalEnvironments.push(environment);
      return { code: 0, signal: null };
    },
    runGolden: async ({ scenario }) => {
      seenGolden.push(scenario);
      return { status: "blocked", boundary: "golden", reason: "scenario_not_enabled" };
    },
  });
  assert.equal(seenLocalEnvironments.length, 1);
  assert.equal(seenLocalEnvironments[0].SYMPHONY_E2E_SCENARIO, undefined);
  assert.deepEqual(seenGolden, [
    "single-cycle",
    "multi-cycle",
    "single-cycle-human-action",
    "cycle-human-action-cycle",
    "human-action-rejected-supplement",
    "human-action-unanswered",
  ]);
  assert.equal(result.boundary_results.at(-1).scenario_results.length, seenGolden.length);
});

test("default supervisor starts all six golden scenarios directly in parallel", async () => {
  const started = [];
  const reported = [];
  let active = 0;
  let peak = 0;
  let release;
  const allStarted = new Promise((resolve) => { release = resolve; });
  const result = await runSupervisor({
    envPath: path.join(os.tmpdir(), "symphony-e2e-parallel-env-does-not-exist"),
    inherited: {},
    maxDurationMs: 200,
    cleanupGraceMs: 20,
    runAllScenarios: true,
    runTests: async () => ({ code: 0, signal: null }),
    runBoundaries: async () => [],
    onScenarioResult: (result_) => { reported.push(result_.scenario); },
    runGolden: async ({ scenario }) => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(scenario);
      if (started.length === 6) release();
      await allStarted;
      active -= 1;
      return { status: "passed", layer: "golden", result: { scenario } };
    },
  });

  assert.equal(result.code, 0);
  assert.equal(started.length, 6);
  assert.deepEqual(new Set(reported), new Set(started));
  assert.equal(peak, 6);
});

test("each parallel golden scenario has an independent deadline", async () => {
  const reported = [];
  const startedAt = Date.now();
  const abortedAt = [];
  const result = await runSupervisor({
    envPath: path.join(os.tmpdir(), "symphony-e2e-scenario-timeout-env-does-not-exist"),
    inherited: {},
    maxDurationMs: 200,
    scenarioDurationMs: 40,
    cleanupGraceMs: 20,
    runAllScenarios: true,
    runTests: async () => ({ code: 0, signal: null }),
    runBoundaries: async () => [],
    runGolden: async ({ signal }) => new Promise(() => {
      signal.addEventListener("abort", () => { abortedAt.push(Date.now()); }, { once: true });
    }),
    onScenarioResult: (scenarioResult) => { reported.push(scenarioResult); },
  });
  assert.equal(result.code, 1);
  assert.equal(reported.length, 6);
  assert.equal(reported.every(({ reason }) => reason === "e2e_timeout"), true);
  assert.equal(abortedAt.length, 6);
  assert.ok(Math.min(...abortedAt) - startedAt >= 35);
  assert.ok(Date.now() - startedAt >= 35);
});

test("explicit supervisor scenario forwards one focus to local tests and golden", async () => {
  let localScenario;
  const goldenScenarios = [];
  await runSupervisor({
    scenario: "human-action-rejected-supplement",
    envPath: path.join(os.tmpdir(), "symphony-e2e-explicit-scenario-env-does-not-exist"),
    inherited: {},
    runTests: async (_files, environment) => {
      localScenario = environment.SYMPHONY_E2E_SCENARIO;
      return { code: 0, signal: null };
    },
    runGolden: async ({ scenario }) => {
      goldenScenarios.push(scenario);
      return { status: "blocked", boundary: "golden", reason: "scenario_not_supported" };
    },
  });
  assert.equal(localScenario, "human-action-rejected-supplement");
  assert.deepEqual(goldenScenarios, ["human-action-rejected-supplement"]);
});
