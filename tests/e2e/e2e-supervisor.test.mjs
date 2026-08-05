import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MAX_E2E_DURATION_MS, partitionEnvironment, runSupervisor } from "./e2e-supervisor.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const secretValues = Object.freeze({
  human: "human-fixture-token-7e21",
  product: "product-linear-token-a314",
  codex: "codex-api-key-c092",
});

const fixtureEnvironment = Object.freeze({
  SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: secretValues.human,
  SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED: "true",
  SYMPHONY_E2E_PROJECT_SLUG_ID: "project-fixture",
});

const productEnvironment = Object.freeze({
  SYMPHONY_LINEAR_TOKEN: secretValues.product,
  SYMPHONY_CODEX_API_KEY: secretValues.codex,
  SYMPHONY_CODEX_MODEL: "gpt-test-model",
  SYMPHONY_CODEX_BASE_URL: "https://codex.example.test",
  SYMPHONY_LINEAR_EXCLUSIVE_MUTATION_ACTOR: "acknowledged",
  SYMPHONY_LINEAR_MANAGED_DESTRUCTION_PROHIBITED: "acknowledged",
  SYMPHONY_LINEAR_RELATION_PROVENANCE_AUDITED: "acknowledged",
});

const completeEnvironment = Object.freeze({
  ...fixtureEnvironment,
  ...productEnvironment,
  SYMPHONY_E2E_DIAGNOSTIC_EVENTS: "1",
});

function envSource(environment) {
  return Object.entries(environment)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-supervisor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("partitions complete configuration without crossing credential boundaries", () => {
  const partition = partitionEnvironment(completeEnvironment, {
    PATH: "/usr/bin",
    HOME: "/tmp/test-home",
    SYMPHONY_LINEAR_TOKEN: "host-product-token-must-not-leak-through",
    SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "host-fixture-token-must-not-win",
  });

  assert.equal(partition.runnerEnvironment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, secretValues.human);
  assert.equal(partition.runnerEnvironment.SYMPHONY_E2E_PROJECT_SLUG_ID, "project-fixture");
  assert.equal(partition.runnerEnvironment.SYMPHONY_LINEAR_TOKEN, undefined);
  assert.equal(partition.runnerEnvironment.SYMPHONY_CODEX_API_KEY, undefined);
  assert.equal(partition.runnerEnvironment.SYMPHONY_E2E_DIAGNOSTIC_EVENTS, "1");
  assert.equal(partition.runnerEnvironment.PATH, "/usr/bin");
  assert.equal(partition.runnerEnvironment.ARK_API_KEY, undefined);

  assert.equal(partition.conductorEnvironment.SYMPHONY_LINEAR_TOKEN, secretValues.product);
  assert.equal(partition.conductorEnvironment.SYMPHONY_CODEX_API_KEY, secretValues.codex);
  assert.equal(partition.conductorEnvironment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, undefined);
  assert.equal(partition.conductorEnvironment.SYMPHONY_E2E_PROJECT_SLUG_ID, undefined);
  assert.equal(partition.conductorEnvironment.SYMPHONY_E2E_DIAGNOSTIC_EVENTS, "1");
  assert.equal(partition.conductorEnvironment.HOME, "/tmp/test-home");
  assert.equal(partition.conductorEnvironment.ARK_API_KEY, undefined);
});

test("supervisor runs the existing entrypoint with product credentials outside the test child", async (t) => {
  const directory = await temporaryDirectory(t);
  const envPath = path.join(directory, ".env");
  const configPath = path.join(directory, "conductor.json");
  const observationPath = path.join(directory, "observation.json");
  const conductorPath = path.join(directory, "fake-conductor.mjs");
  const scenarioPath = path.join(directory, "scenario.test.mjs");
  const runnerModule = pathToFileURL(path.join(REPOSITORY_ROOT, "tests/e2e/black-box-runner.mjs")).href;

  await writeFile(envPath, envSource(completeEnvironment), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ observationPath }), { mode: 0o600 });
  await writeFile(conductorPath, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));",
    "writeFileSync(config.observationPath, JSON.stringify({",
    "  productCredential: typeof process.env.SYMPHONY_LINEAR_TOKEN === 'string',",
    "  codexCredential: typeof process.env.SYMPHONY_CODEX_API_KEY === 'string',",
    "  fixtureCredential: process.env.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN !== undefined,",
    "}));",
    "process.stdout.write(JSON.stringify({ event: 'conductor_ready' }) + '\\n');",
    "process.on('SIGTERM', () => {",
    "  process.stdout.write(JSON.stringify({ event: 'conductor_stopped' }) + '\\n');",
    "  process.exit(0);",
    "});",
    "setInterval(() => undefined, 1000);",
  ].join("\n"), { mode: 0o600 });
  await writeFile(scenarioPath, [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    `import { runBlackBoxScenario } from ${JSON.stringify(runnerModule)};`,
    `const configPath = ${JSON.stringify(configPath)};`,
    "test('supervised product lifecycle', async () => {",
    "  assert.equal(process.env.SYMPHONY_LINEAR_TOKEN, undefined);",
    "  assert.equal(process.env.SYMPHONY_CODEX_API_KEY, undefined);",
    "  await runBlackBoxScenario({",
    "    scenario: async ({ product }) => {",
    "      await product.start(configPath);",
    "    },",
    "  });",
    "});",
  ].join("\n"), { mode: 0o600 });

  const result = await runSupervisor({
    envPath,
    conductorEntryPath: conductorPath,
    testFiles: [scenarioPath],
    inheritedEnvironment: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
    ),
  });

  assert.deepEqual(result, { code: 0, signal: null });
  assert.deepEqual(JSON.parse(await readFile(observationPath, "utf8")), {
    productCredential: true,
    codexCredential: true,
    fixtureCredential: false,
  });
});

test("supervisor runs independent E2E scenarios concurrently within one budget", async (t) => {
  const directory = await temporaryDirectory(t);
  const envPath = path.join(directory, ".env");
  const configPath = path.join(directory, "conductor.json");
  const conductorPath = path.join(directory, "fake-conductor.mjs");
  const firstReadyPath = path.join(directory, "first.ready");
  const secondReadyPath = path.join(directory, "second.ready");
  const firstScenarioPath = path.join(directory, "first-scenario.test.mjs");
  const secondScenarioPath = path.join(directory, "second-scenario.test.mjs");
  const runnerModule = pathToFileURL(path.join(REPOSITORY_ROOT, "tests/e2e/black-box-runner.mjs")).href;

  await writeFile(envPath, envSource(completeEnvironment), { mode: 0o600 });
  await writeFile(configPath, "{}\n", { mode: 0o600 });
  await writeFile(conductorPath, [
    "process.stdout.write(JSON.stringify({ event: 'conductor_ready' }) + '\\n');",
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => undefined, 1000);",
  ].join("\n"), { mode: 0o600 });

  const scenarioSource = (readyPath) => [
    "import { access, writeFile } from 'node:fs/promises';",
    "import { setTimeout as delay } from 'node:timers/promises';",
    "import test from 'node:test';",
    `import { runBlackBoxScenario } from ${JSON.stringify(runnerModule)};`,
    `const configPath = ${JSON.stringify(configPath)};`,
    `const readyPath = ${JSON.stringify(readyPath)};`,
    `const otherReadyPath = ${JSON.stringify(readyPath === firstReadyPath ? secondReadyPath : firstReadyPath)};`,
    "test('independent scenario reaches the shared barrier', async () => {",
    "  await runBlackBoxScenario({",
    "    scenario: async ({ product }) => {",
    "      await product.start(configPath);",
    "      await writeFile(readyPath, 'ready\\n', { mode: 0o600 });",
    "      const deadline = Date.now() + 1_500;",
    "      while (Date.now() < deadline) {",
    "        try {",
    "          await access(otherReadyPath);",
    "          return;",
    "        } catch {",
    "          await delay(10);",
    "        }",
    "      }",
    "      throw new Error('parallel_scenario_barrier_timeout');",
    "    },",
    "  });",
    "});",
  ].join("\n");
  await writeFile(firstScenarioPath, scenarioSource(firstReadyPath), { mode: 0o600 });
  await writeFile(secondScenarioPath, scenarioSource(secondReadyPath), { mode: 0o600 });

  const result = await runSupervisor({
    envPath,
    conductorEntryPath: conductorPath,
    testFiles: [firstScenarioPath, secondScenarioPath],
    maxDurationMs: 3_000,
    shutdownTimeoutMs: 100,
    inheritedEnvironment: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
    ),
  });

  assert.deepEqual(result, { code: 0, signal: null });
});

test("supervisor enforces a hard deadline and kills a hung product", async (t) => {
  const directory = await temporaryDirectory(t);
  const envPath = path.join(directory, ".env");
  const configPath = path.join(directory, "conductor.json");
  const observationPath = path.join(directory, "observation.json");
  const conductorPath = path.join(directory, "hanging-conductor.mjs");
  const scenarioPath = path.join(directory, "hanging-scenario.test.mjs");
  const runnerModule = pathToFileURL(path.join(REPOSITORY_ROOT, "tests/e2e/black-box-runner.mjs")).href;

  await writeFile(envPath, envSource(completeEnvironment), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ observationPath }), { mode: 0o600 });
  await writeFile(conductorPath, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));",
    "writeFileSync(config.observationPath, JSON.stringify({ pid: process.pid }));",
    "process.stdout.write(JSON.stringify({ event: 'conductor_ready' }) + '\\n');",
    "process.on('SIGTERM', () => undefined);",
    "setInterval(() => undefined, 1000);",
  ].join("\n"), { mode: 0o600 });
  await writeFile(scenarioPath, [
    "import { runBlackBoxScenario } from " + JSON.stringify(runnerModule) + ";",
    "import test from 'node:test';",
    "const configPath = " + JSON.stringify(configPath) + ";",
    "test('hangs until the supervisor deadline', async () => {",
    "  await runBlackBoxScenario({",
    "    scenario: async ({ product }) => {",
    "      await product.start(configPath);",
    "      await new Promise(() => undefined);",
    "    },",
    "  });",
    "});",
  ].join("\n"), { mode: 0o600 });

  const startedAt = Date.now();
  const result = await runSupervisor({
    envPath,
    conductorEntryPath: conductorPath,
    testFiles: [scenarioPath],
    maxDurationMs: 800,
    shutdownTimeoutMs: 100,
    inheritedEnvironment: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
    ),
  });

  assert.deepEqual(result, { code: 124, signal: null, reason: "e2e_timeout" });
  assert.ok(Date.now() - startedAt < 5_000);
  const observation = JSON.parse(await readFile(observationPath, "utf8"));
  assert.equal(typeof observation.pid, "number");
  assert.throws(() => process.kill(observation.pid, 0), { code: "ESRCH" });
});

test("supervisor rejects a total E2E budget above the sub-five-minute ceiling", async () => {
  assert.ok(MAX_E2E_DURATION_MS < 5 * 60_000);
  await assert.rejects(
    runSupervisor({ maxDurationMs: MAX_E2E_DURATION_MS + 1 }),
    /invalid_e2e_configuration/u,
  );
});
