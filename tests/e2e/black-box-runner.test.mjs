import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBlackBoxScenario } from "./black-box-runner.mjs";

const secretValues = Object.freeze({
  human: "human-fixture-token-7e21",
  product: "product-linear-token-a314",
  codex: "codex-api-key-c092",
});

const requiredEnvironment = Object.freeze({
  SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: secretValues.human,
  SYMPHONY_E2E_LINEAR_DEV_TOKEN: secretValues.product,
  SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED: "true",
  SYMPHONY_E2E_PROJECT_SLUG_ID: "project-fixture",
  SYMPHONY_E2E_CODEX_API_KEY: secretValues.codex,
  SYMPHONY_E2E_CODEX_BASE_URL: "https://api.example.com/v1",
  SYMPHONY_E2E_CODEX_MODEL: "model-fixture",
});

function envSource(environment = requiredEnvironment) {
  return Object.entries(environment)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function errorText(error) {
  return [String(error), error instanceof Error ? error.stack : "", JSON.stringify(error)].join("\n");
}

test("missing or incomplete configuration fails before fixture or product operations", async (t) => {
  const directory = await temporaryDirectory(t);
  const cases = [
    { name: "missing file", environment: null },
    ...Object.keys(requiredEnvironment).map((missingKey) => ({
      name: `missing ${missingKey}`,
      environment: Object.fromEntries(
        Object.entries(requiredEnvironment).filter(([key]) => key !== missingKey),
      ),
    })),
  ];

  for (const [index, entry] of cases.entries()) {
    const envPath = path.join(directory, `case-${index}.env`);
    if (entry.environment) await writeFile(envPath, envSource(entry.environment), { mode: 0o600 });
    let scenarioCalled = false;
    let productCalled = false;

    await assert.rejects(
      runBlackBoxScenario({
        envPath,
        scenario: async () => { scenarioCalled = true; },
        startProduct: async () => {
          productCalled = true;
          return { stop: async () => undefined };
        },
      }),
      (error) => {
        assert.equal(error?.code, "invalid_e2e_configuration", entry.name);
        return true;
      },
    );
    assert.equal(scenarioCalled, false, entry.name);
    assert.equal(productCalled, false, entry.name);
  }
});

test("runner keeps fixture credentials out of the built product environment", async (t) => {
  const directory = await temporaryDirectory(t);
  const envPath = path.join(directory, ".env");
  const configPath = path.join(directory, "conductor.json");
  await writeFile(envPath, envSource(), { mode: 0o600 });
  await writeFile(configPath, "{}", { mode: 0o600 });
  const calls = [];
  let launch;

  const result = await runBlackBoxScenario({
    envPath,
    startProduct: async (request) => {
      calls.push("start_product");
      launch = request;
      return {
        stop: async () => { calls.push("stop_product"); },
      };
    },
    scenario: async ({ fixtures, product }) => {
      const fixture = await fixtures.create({
        setup: async (access) => {
          calls.push("create_fixture");
          assert.deepEqual(access, {
            linearHumanToken: secretValues.human,
            projectSlugId: "project-fixture",
          });
          return Object.freeze({ id: "fixture-1" });
        },
        cleanup: async (access, created) => {
          calls.push("cleanup_fixture");
          assert.equal(access.linearHumanToken, secretValues.human);
          assert.equal(created.id, "fixture-1");
        },
      });
      await product.start(configPath);
      await fixtures.operate(async (access) => {
        calls.push("observe_fixture");
        assert.equal(access.linearHumanToken, secretValues.human);
        assert.equal(fixture.id, "fixture-1");
      });
      return "observed";
    },
  });

  assert.equal(result, "observed");
  assert.deepEqual(calls, [
    "create_fixture",
    "start_product",
    "observe_fixture",
    "stop_product",
    "cleanup_fixture",
  ]);
  assert.equal(launch.configPath, configPath);
  assert.deepEqual(launch.environment, {
    SYMPHONY_LINEAR_TOKEN: secretValues.product,
    SYMPHONY_CODEX_API_KEY: secretValues.codex,
    SYMPHONY_CODEX_BASE_URL: "https://api.example.com/v1",
    SYMPHONY_CODEX_MODEL: "model-fixture",
  });
  assert.equal(JSON.stringify(launch).includes(secretValues.human), false);
  assert.equal(Object.keys(launch.environment).some((key) => key.startsWith("SYMPHONY_E2E_")), false);
});

test("runner sanitizes untrusted fixture and product failures", async (t) => {
  const directory = await temporaryDirectory(t);
  const envPath = path.join(directory, ".env");
  const configPath = path.join(directory, "conductor.json");
  await writeFile(envPath, envSource(), { mode: 0o600 });
  await writeFile(configPath, "{}", { mode: 0o600 });

  const fixtureFailure = await runBlackBoxScenario({
    envPath,
    scenario: async ({ fixtures }) => fixtures.operate(async () => {
      throw new Error(`provider rejected ${secretValues.human}`);
    }),
  }).catch((error) => error);
  assert.equal(fixtureFailure?.code, "fixture_operation_failed");
  for (const secret of Object.values(secretValues)) assert.doesNotMatch(errorText(fixtureFailure), new RegExp(secret, "u"));

  const productFailure = await runBlackBoxScenario({
    envPath,
    startProduct: async () => {
      throw new Error(`spawn rejected ${secretValues.codex}`);
    },
    scenario: async ({ product }) => product.start(configPath),
  }).catch((error) => error);
  assert.equal(productFailure?.code, "conductor_start_failed");
  for (const secret of Object.values(secretValues)) assert.doesNotMatch(errorText(productFailure), new RegExp(secret, "u"));
});

test("fixture cleanup still runs when product shutdown fails", async (t) => {
  const directory = await temporaryDirectory(t);
  const envPath = path.join(directory, ".env");
  const configPath = path.join(directory, "conductor.json");
  await writeFile(envPath, envSource(), { mode: 0o600 });
  await writeFile(configPath, "{}", { mode: 0o600 });
  let fixtureCleaned = false;

  const failure = await runBlackBoxScenario({
    envPath,
    startProduct: async () => ({
      stop: async () => { throw new Error(`stop rejected ${secretValues.product}`); },
    }),
    scenario: async ({ fixtures, product }) => {
      await fixtures.create({
        setup: async () => ({ id: "fixture-1" }),
        cleanup: async () => { fixtureCleaned = true; },
      });
      await product.start(configPath);
    },
  }).catch((error) => error);

  assert.equal(fixtureCleaned, true);
  assert.equal(failure?.code, "e2e_cleanup_failed");
  for (const secret of Object.values(secretValues)) assert.doesNotMatch(errorText(failure), new RegExp(secret, "u"));
});

test("runner source stays outside Conductor and internal operation boundaries", async () => {
  const source = await readFile(new URL("./black-box-runner.mjs", import.meta.url), "utf8");
  const conductorImport = /\b(?:from\s*|import\s*\()\s*["'][^"']*(?:apps\/conductor|conductor\/(?:src|dist))[^"']*["']/u;
  const internalOperation = /\b(?:RootReconcill|runProductionPoll|LinearCommands|CycleMachine|TaskManageCommand|CodexLocalOnly|GitCommand|GitHubDelivery)\b/u;
  const credentialOutput = /\b(?:console\.|process\.(?:stdout|stderr)|writeFile|appendFile|createWriteStream)\b/u;

  assert.doesNotMatch(source, conductorImport);
  assert.doesNotMatch(source, internalOperation);
  assert.doesNotMatch(source, credentialOutput);
  assert.match(source, /"apps",\s*"conductor",\s*"dist",\s*"main\.js"/u);
  assert.match(source, /\["--config",\s*configPath\]/u);
});
