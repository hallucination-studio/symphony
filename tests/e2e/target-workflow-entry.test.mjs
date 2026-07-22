import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { TARGET_WORKFLOW_SCENARIOS } from "../../tools/e2e/target-workflow-verdict.mjs";
import {
  targetWorkflowCliExitCode,
  runTargetWorkflowAllLive,
  runTargetWorkflowDryRun,
} from "../../tools/e2e/target-workflow-entry.mjs";

test("target workflow dry-run performs no mutation and reports the static audit", async () => {
  const result = await runTargetWorkflowDryRun();

  assert.equal(result.status, "dry_run");
  assert.equal(result.mutationAttempted, false);
  assert.deepEqual(result.staticAudit, { passed: true, failures: [] });
  assert.deepEqual(result.scenarios, TARGET_WORKFLOW_SCENARIOS.map((scenario) => ({
    scenario,
    status: "unverified",
  })));
});

test("target workflow dry-run fails before mutation when the source audit fails", async () => {
  const originalRunner = await readFile("tools/e2e/target-workflow-runner.mjs", "utf8");
  await assert.rejects(
    runTargetWorkflowDryRun({
      readSource: async (file) => file.endsWith("target-workflow-runner.mjs")
        ? originalRunner.replace("externalInputs.createRoot", "seedCycle")
        : readFile(file, "utf8"),
    }),
    /target_entry_static_audit_failed/u,
  );
});

test("target workflow entry accepts only dry-run", () => {
  const result = spawnSync(process.execPath, ["tools/e2e/target-workflow-entry.mjs", "--unexpected"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "failed",
    reason: "target_entry_argument_invalid",
  });
});

test("target workflow live success reports unverified before mutation when credentials are absent", () => {
  const result = spawnSync(process.execPath, ["tools/e2e/target-workflow-entry.mjs", "--live-success"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "unverified",
    reason: "e2e_configuration_invalid",
    issues: [
      "linear_dev_token_missing", "linear_client_id_missing", "linear_project_slug_id_missing",
      "linear_setup_authorization_missing",
      "codex_api_key_missing",
      "codex_base_url_missing", "codex_model_missing",
    ],
  });
  assert.equal(result.stdout, "");
});

test("target workflow live repair reports unverified before mutation when credentials are absent", () => {
  const result = spawnSync(process.execPath, ["tools/e2e/target-workflow-entry.mjs", "--live-repair"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "unverified",
    reason: "e2e_configuration_invalid",
    issues: [
      "linear_dev_token_missing", "linear_client_id_missing", "linear_project_slug_id_missing",
      "linear_setup_authorization_missing",
      "codex_api_key_missing",
      "codex_base_url_missing", "codex_model_missing",
    ],
  });
  assert.equal(result.stdout, "");
});

test("target workflow live delivery reports unverified before mutation when credentials are absent", () => {
  const result = spawnSync(process.execPath, ["tools/e2e/target-workflow-entry.mjs", "--live-delivery"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "unverified",
    reason: "e2e_configuration_invalid",
    issues: [
      "linear_dev_token_missing", "linear_client_id_missing", "linear_project_slug_id_missing",
      "linear_setup_authorization_missing",
      "codex_api_key_missing",
      "codex_base_url_missing", "codex_model_missing",
    ],
  });
  assert.equal(result.stdout, "");
});

test("target workflow all-run attempts every scenario and recomputes a failed verdict", async () => {
  const calls = [];
  const result = await runTargetWorkflowAllLive({
    config: {
      linear: { clientId: "client-1", projectSlugId: "project-1" },
      secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
      codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
    },
    environment: { SYMPHONY_E2E_RUN_ID: "target-all" },
    runScenario: async (scenario) => {
      calls.push(scenario);
      if (scenario === "repair_escalation") throw new Error("repair_live_failed");
      return { scenario, status: "passed" };
    },
    prepareSetup: async () => ({ setup: {}, ids: {} }),
    writeEvidence: false,
  });

  assert.deepEqual(calls, ["success", "repair_escalation", "restart_recovery", "delivery", "scheduling"]);
  assert.equal(result.status, "failed");
  assert.equal(result.verdict.verdict, "failed");
  assert.deepEqual(result.verdict.missingScenarios, ["repair_escalation"]);
  assert.equal(JSON.stringify(result).includes("linear-secret"), false);
  assert.equal(JSON.stringify(result).includes("codex-secret"), false);
});

test("target workflow all-run prepares Linear setup once before every scenario", async () => {
  const events = [];
  const preparedSetup = { setup: { identityDigest: "a".repeat(16) }, ids: { conductorShortHash: "abcdef123456" } };
  const result = await runTargetWorkflowAllLive({
    config: {
      linear: { clientId: "client-1", projectSlugId: "project-1" },
      secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
      codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
    },
    environment: { SYMPHONY_E2E_RUN_ID: "target-all-setup" },
    prepareSetup: async () => {
      events.push(["setup"]);
      return preparedSetup;
    },
    runScenario: async (scenario, input) => {
      events.push([scenario, input.setup]);
      return { scenario, status: "passed" };
    },
    writeEvidence: false,
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(events, [
    ["setup"],
    ["success", preparedSetup],
    ["repair_escalation", preparedSetup],
    ["restart_recovery", preparedSetup],
    ["delivery", preparedSetup],
    ["scheduling", preparedSetup],
  ]);
});

test("target workflow CLI returns failure for a recomputed failed all-run verdict", () => {
  assert.equal(targetWorkflowCliExitCode({ status: "passed" }), 0);
  assert.equal(targetWorkflowCliExitCode({ status: "failed" }), 1);
  assert.equal(targetWorkflowCliExitCode({ status: "unverified" }), 2);
});

test("target workflow all-run reports unverified before creating any scenario", () => {
  const result = spawnSync(process.execPath, ["tools/e2e/target-workflow-entry.mjs", "--live-all"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "unverified",
    reason: "e2e_configuration_invalid",
    issues: [
      "linear_dev_token_missing", "linear_client_id_missing", "linear_project_slug_id_missing",
      "linear_setup_authorization_missing",
      "codex_api_key_missing",
      "codex_base_url_missing", "codex_model_missing",
    ],
  });
  assert.equal(result.stdout, "");
});
