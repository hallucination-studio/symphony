import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  conductorDiagnosticFromEvent,
  conductorFailureFromEvent,
  runBlackBoxScenario,
} from "./black-box-runner.mjs";

const secretValues = Object.freeze({
  human: "human-fixture-token-7e21",
  product: "product-linear-token-a314",
  codex: "codex-api-key-c092",
});

const requiredEnvironment = Object.freeze({
  SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: secretValues.human,
  SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED: "true",
  SYMPHONY_E2E_PROJECT_SLUG_ID: "project-fixture",
  SYMPHONY_E2E_CONDUCTOR_LAUNCHER_SOCKET: "/tmp/symphony-launcher.sock",
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

test("runner exposes only public launcher coordinates to product startup", async (t) => {
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
  assert.equal(launch.launcherSocketPath, "/tmp/symphony-launcher.sock");
  assert.equal("environment" in launch, false);
  assert.equal(JSON.stringify(launch).includes(secretValues.human), false);
  assert.equal(JSON.stringify(launch).includes(secretValues.product), false);
  assert.equal(JSON.stringify(launch).includes(secretValues.codex), false);
});

test("runner rejects production credentials in its file or process environment before effects", async (t) => {
  const directory = await temporaryDirectory(t);
  const envPath = path.join(directory, ".env");
  const forbiddenKeys = ["SYMPHONY_E2E_LINEAR_DEV_TOKEN", "SYMPHONY_LINEAR_TOKEN"];

  for (const key of forbiddenKeys) {
    await writeFile(envPath, envSource({ ...requiredEnvironment, [key]: secretValues.product }), {
      mode: 0o600,
    });
    let scenarioCalled = false;
    await assert.rejects(
      runBlackBoxScenario({
        envPath,
        scenario: async () => { scenarioCalled = true; },
        startProduct: async () => { throw new Error("product_must_not_start"); },
      }),
      (error) => error?.code === "invalid_e2e_configuration",
    );
    assert.equal(scenarioCalled, false);
  }

  await writeFile(envPath, envSource(), { mode: 0o600 });
  const previous = process.env.SYMPHONY_LINEAR_TOKEN;
  process.env.SYMPHONY_LINEAR_TOKEN = secretValues.product;
  try {
    await assert.rejects(
      runBlackBoxScenario({ envPath, scenario: async () => undefined }),
      (error) => error?.code === "invalid_e2e_configuration",
    );
  } finally {
    if (previous === undefined) delete process.env.SYMPHONY_LINEAR_TOKEN;
    else process.env.SYMPHONY_LINEAR_TOKEN = previous;
  }
});

test("deployment launcher injects the production credential outside runner requests and output", async (t) => {
  const directory = await temporaryDirectory(t);
  const socketPath = path.join(directory, "launcher.sock");
  const envPath = path.join(directory, ".env");
  const configPath = path.join(directory, "conductor.json");
  const fakeConductorPath = path.join(directory, "fake-conductor.mjs");
  await writeFile(envPath, envSource({
    ...requiredEnvironment,
    SYMPHONY_E2E_CONDUCTOR_LAUNCHER_SOCKET: socketPath,
  }), { mode: 0o600 });
  await writeFile(configPath, "{}", { mode: 0o600 });
  await writeFile(fakeConductorPath, [
    "const credential = process.env.SYMPHONY_LINEAR_TOKEN;",
    "if (!credential || process.argv.join(' ').includes(credential)) process.exit(2);",
    "process.stdout.write(JSON.stringify({ event: 'conductor_ready' }) + '\\n');",
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => undefined, 1000).unref();",
  ].join("\n"), { mode: 0o600 });

  const requests = [];
  const outputs = [];
  const server = createServer((connection) => {
    let buffered = "";
    let conductor;
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const request = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        requests.push(request);
        if (request.type === "start") {
          conductor = spawn(process.execPath, [fakeConductorPath, "--config", request.config_path], {
            env: { SYMPHONY_LINEAR_TOKEN: secretValues.product },
            stdio: ["ignore", "pipe", "pipe"],
          });
          conductor.stdout.on("data", (value) => {
            outputs.push(String(value));
            connection.write(value);
          });
        } else if (request.type === "stop") {
          conductor?.kill("SIGTERM");
          connection.end();
        }
        newline = buffered.indexOf("\n");
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  t.after(() => server.close());

  await runBlackBoxScenario({
    envPath,
    scenario: async ({ product }) => { await product.start(configPath); },
  });

  assert.deepEqual(requests, [
    { type: "start", config_path: configPath },
    { type: "stop" },
  ]);
  assert.equal(JSON.stringify(requests).includes(secretValues.product), false);
  assert.equal(outputs.join("").includes(secretValues.product), false);
  assert.equal((await readFile(fakeConductorPath, "utf8")).includes(secretValues.product), false);
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

test("product health monitor reports a sanitized runtime failure", async (t) => {
  const directory = await temporaryDirectory(t);
  const envPath = path.join(directory, ".env");
  const configPath = path.join(directory, "conductor.json");
  await writeFile(envPath, envSource(), { mode: 0o600 });
  await writeFile(configPath, "{}", { mode: 0o600 });
  let productStopped = false;

  const failure = await runBlackBoxScenario({
    envPath,
    startProduct: async () => ({
      stop: async () => { productStopped = true; },
      waitForFailure: async () => { throw new Error(`runtime rejected ${secretValues.codex}`); },
    }),
    scenario: async ({ product }) => {
      const running = await product.start(configPath);
      await running.waitForFailure();
    },
  }).catch((error) => error);

  assert.equal(productStopped, true);
  assert.equal(failure?.code, "conductor_runtime_failed");
  for (const secret of Object.values(secretValues)) assert.doesNotMatch(errorText(failure), new RegExp(secret, "u"));
});

test("Conductor Root preparation failures stop the health monitor with a closed reason", () => {
  const failure = conductorFailureFromEvent({
    event: "root_observation_failed",
    root_id: "fixture-root",
    correlation_id: "fixture-correlation",
    reason_code: "runtime_preparation_failed",
    cause_code: "codex_local_only_preflight_failed:config",
  });
  assert.equal(failure?.code, "conductor_runtime_failed");
  assert.equal(failure?.reasonCode, "codex_local_only_preflight_failed:config");

  const untrusted = conductorFailureFromEvent({
    event: "root_observation_failed",
    reason_code: `provider rejected ${secretValues.codex}`,
  });
  assert.equal(untrusted?.code, "conductor_runtime_failed");
  assert.equal(untrusted?.reasonCode, undefined);
  assert.doesNotMatch(errorText(untrusted), new RegExp(secretValues.codex, "u"));
  const untrustedCause = conductorFailureFromEvent({
    event: "root_observation_failed",
    reason_code: "runtime_preparation_failed",
    cause_code: `provider rejected ${secretValues.codex}`,
  });
  assert.equal(untrustedCause?.reasonCode, "runtime_preparation_failed");
  assert.doesNotMatch(errorText(untrustedCause), new RegExp(secretValues.codex, "u"));
  assert.equal(conductorFailureFromEvent({ event: "root_turn_started" }), undefined);
});

test("Conductor terminal Root and runtime failures stop the health monitor", () => {
  for (const [event, reasonCode] of [
    [{ event: "root_turn_completed", outcome: "timed_out" }, "root_turn_timed_out"],
    [{ event: "root_turn_completed", outcome: "stopped" }, "root_turn_stopped"],
    [{ event: "root_turn_completed", outcome: "canceled" }, "root_turn_canceled"],
    [{
      event: "root_turn_failed",
      reason_code: "turn_boundary_failed",
      cause_code: "codex_thread_turn_failed",
    }, "codex_thread_turn_failed"],
    [{ event: "cycle_action_failed", reason_code: "cycle_boundary_failed" }, "cycle_boundary_failed"],
    [{ event: "cycle_continuation_failed", reason_code: "cycle_preparation_failed" }, "cycle_preparation_failed"],
    [{ event: "root_cleanup_failed", reason_code: "runtime_shutdown_failed" }, "runtime_shutdown_failed"],
  ]) {
    const failure = conductorFailureFromEvent(event);
    assert.equal(failure?.code, "conductor_runtime_failed");
    assert.equal(failure?.reasonCode, reasonCode);
  }
  assert.equal(conductorFailureFromEvent({ event: "root_turn_completed", outcome: "quiescent" }), undefined);
  assert.equal(conductorFailureFromEvent({}), undefined);
});

test("diagnostic projection drops every untrusted event field", () => {
  assert.deepEqual(conductorDiagnosticFromEvent({
    event: "root_turn_failed",
    cause_code: secretValues.product,
    tool: secretValues.codex,
  }), {
    diagnostic: "conductor_event",
    event: "root_turn_failed",
  });
  assert.equal(conductorDiagnosticFromEvent({ event: `root_turn_${secretValues.product}` }), undefined);
});

test("runner source stays outside Conductor and internal operation boundaries", async () => {
  const source = await readFile(new URL("./black-box-runner.mjs", import.meta.url), "utf8");
  const conductorImport = /\b(?:from\s*|import\s*\()\s*["'][^"']*(?:apps\/conductor|conductor\/(?:src|dist))[^"']*["']/u;
  const internalOperation = /\b(?:RootReconcill|runProductionPoll|LinearCommands|CycleMachine|TaskManageCommand|CodexLocalOnly|GitCommand|GitHubDelivery)\b/u;
  const unsafeOutput = /\b(?:console\.|process\.stdout|writeFile|appendFile|createWriteStream)\b/u;

  assert.doesNotMatch(source, conductorImport);
  assert.doesNotMatch(source, internalOperation);
  assert.doesNotMatch(source, unsafeOutput);
  assert.equal(source.match(/process\.stderr\.write/gu)?.length, 1);
  assert.doesNotMatch(source, /SYMPHONY_E2E_LINEAR_DEV_TOKEN/u);
  assert.doesNotMatch(source, /SYMPHONY_CODEX_API_KEY/u);
  assert.match(source, /SYMPHONY_E2E_CONDUCTOR_LAUNCHER_SOCKET/u);
});
