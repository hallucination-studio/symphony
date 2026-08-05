import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function errorText(error) {
  return [String(error), error instanceof Error ? error.stack : "", JSON.stringify(error)].join("\n");
}

test("missing or incomplete fixture configuration fails before effects", async () => {
  const cases = [
    { name: "missing environment", environment: null },
    ...Object.keys(requiredEnvironment).map((missingKey) => ({
      name: `missing ${missingKey}`,
      environment: Object.fromEntries(
        Object.entries(requiredEnvironment).filter(([key]) => key !== missingKey),
      ),
    })),
  ];

  for (const entry of cases) {
    let scenarioCalled = false;
    let productCalled = false;

    await assert.rejects(
      runBlackBoxScenario({
        fixtureEnvironment: entry.environment ?? {},
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

test("runner passes only the config path to product startup", async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = path.join(directory, "conductor.json");
  await writeFile(configPath, "{}", { mode: 0o600 });
  const calls = [];
  let launch;

  const result = await runBlackBoxScenario({
    fixtureEnvironment: requiredEnvironment,
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
  assert.equal("environment" in launch, false);
  assert.equal(JSON.stringify(launch).includes(secretValues.human), false);
  assert.equal(JSON.stringify(launch).includes(secretValues.product), false);
  assert.equal(JSON.stringify(launch).includes(secretValues.codex), false);
});

test("runner rejects production credentials in its process environment before effects", async () => {
  const forbiddenKeys = ["SYMPHONY_E2E_LINEAR_DEV_TOKEN", "SYMPHONY_LINEAR_TOKEN"];

  for (const key of forbiddenKeys) {
    let scenarioCalled = false;
    await assert.rejects(
      runBlackBoxScenario({
        fixtureEnvironment: { ...requiredEnvironment, [key]: secretValues.product },
        scenario: async () => { scenarioCalled = true; },
        startProduct: async () => { throw new Error("product_must_not_start"); },
      }),
      (error) => error?.code === "invalid_e2e_configuration",
    );
    assert.equal(scenarioCalled, false);
  }

  const previous = process.env.SYMPHONY_LINEAR_TOKEN;
  process.env.SYMPHONY_LINEAR_TOKEN = secretValues.product;
  try {
    await assert.rejects(
      runBlackBoxScenario({ fixtureEnvironment: requiredEnvironment, scenario: async () => undefined }),
      (error) => error?.code === "invalid_e2e_configuration",
    );
  } finally {
    if (previous === undefined) delete process.env.SYMPHONY_LINEAR_TOKEN;
    else process.env.SYMPHONY_LINEAR_TOKEN = previous;
  }
});

test("runner sanitizes untrusted fixture and product failures", async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = path.join(directory, "conductor.json");
  await writeFile(configPath, "{}", { mode: 0o600 });

  const fixtureFailure = await runBlackBoxScenario({
    fixtureEnvironment: requiredEnvironment,
    scenario: async ({ fixtures }) => fixtures.operate(async () => {
      throw new Error(`provider rejected ${secretValues.human}`);
    }),
  }).catch((error) => error);
  assert.equal(fixtureFailure?.code, "fixture_operation_failed");
  for (const secret of Object.values(secretValues)) assert.doesNotMatch(errorText(fixtureFailure), new RegExp(secret, "u"));

  const productFailure = await runBlackBoxScenario({
    fixtureEnvironment: requiredEnvironment,
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
  const configPath = path.join(directory, "conductor.json");
  await writeFile(configPath, "{}", { mode: 0o600 });
  let fixtureCleaned = false;

  const failure = await runBlackBoxScenario({
    fixtureEnvironment: requiredEnvironment,
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
  const configPath = path.join(directory, "conductor.json");
  await writeFile(configPath, "{}", { mode: 0o600 });
  let productStopped = false;

  const failure = await runBlackBoxScenario({
    fixtureEnvironment: requiredEnvironment,
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
    event: "root_tool_call_denied",
    reason_code: "capability_denied",
    tool: secretValues.codex,
  }), {
    diagnostic: "conductor_event",
    event: "root_tool_call_denied",
    reason_code: "capability_denied",
  });
  assert.deepEqual(conductorDiagnosticFromEvent({
    event: "root_task_tool_diagnostic",
    code: "other",
    category: "invalid_root_issue_id",
    tool: secretValues.codex,
  }), {
    diagnostic: "conductor_event",
    event: "root_task_tool_diagnostic",
    reason_code: "invalid_root_issue_id",
  });
  assert.deepEqual(conductorDiagnosticFromEvent({
    event: "root_task_authorization_diagnostic",
    category: "draft_not_observed",
    tool: secretValues.codex,
  }), {
    diagnostic: "conductor_event",
    event: "root_task_authorization_diagnostic",
    reason_code: "draft_not_observed",
  });
  assert.deepEqual(conductorDiagnosticFromEvent({
    event: "root_task_authorization_diagnostic",
    category: "cycle_approval_invalid:cycle_identity_derivation_mismatch",
  }), {
    diagnostic: "conductor_event",
    event: "root_task_authorization_diagnostic",
    reason_code: "cycle_approval_invalid:cycle_identity_derivation_mismatch",
  });
  assert.deepEqual(conductorDiagnosticFromEvent({
    event: "fresh_route_selected",
    selected_route: "WF-ROUTE-004",
    consumer: "cycle_machine",
    root_id: secretValues.codex,
  }), {
    diagnostic: "conductor_event",
    event: "fresh_route_selected",
    selected_route: "WF-ROUTE-004",
    consumer: "cycle_machine",
  });
  assert.deepEqual(conductorDiagnosticFromEvent({
    event: "root_tool_call_accepted",
    tool: "create_issue",
    arguments: { secret: secretValues.codex },
  }), {
    diagnostic: "conductor_event",
    event: "root_tool_call_accepted",
    tool: "create_issue",
  });
  assert.deepEqual(conductorDiagnosticFromEvent({
    event: "root_turn_completed",
    outcome: "quiescent",
    root_id: secretValues.codex,
  }), {
    diagnostic: "conductor_event",
    event: "root_turn_completed",
    outcome: "quiescent",
  });
  assert.deepEqual(conductorDiagnosticFromEvent({
    event: "root_turn_failed",
    cause_code: secretValues.product,
    tool: secretValues.codex,
  }), {
    diagnostic: "conductor_event",
    event: "root_turn_failed",
  });
  assert.deepEqual(conductorDiagnosticFromEvent({
    event: "root_observation_failed",
    reason_code: "runtime_preparation_failed",
    cause_code: "root_local_only_tool_denied",
  }), {
    diagnostic: "conductor_event",
    event: "root_observation_failed",
    reason_code: "root_local_only_tool_denied",
  });
  assert.deepEqual(conductorDiagnosticFromEvent({
    event: "code_inspection_diagnostic",
    tool: secretValues.codex,
    category: "boundary_invalid_contract",
  }), {
    diagnostic: "conductor_event",
    event: "code_inspection_diagnostic",
    reason_code: "boundary_invalid_contract",
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
  assert.doesNotMatch(source, /SYMPHONY_E2E_CONDUCTOR_LAUNCHER_SOCKET/u);
  assert.match(source, /process\.send/u);
});
