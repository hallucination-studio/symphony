import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { FOREGROUND_E2E_CASE_IDS } from "../../tools/e2e/cases.mjs";

const campaignCli = "tools/e2e/run-foreground-campaign.mjs";

test("foreground E2E command keeps one .env-loaded foreground entrypoint", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const makefile = readFileSync("Makefile", "utf8");

  assert.equal(
    manifest.scripts.e2e,
    "node --env-file-if-exists=.env tools/e2e/run-foreground-campaign.mjs",
  );
  assert.equal(manifest.scripts["test:e2e:runner"], "node --test tests/e2e/*.test.mjs");
  assert.equal(manifest.scripts["desktop-shell-smoke:build"], "node tools/desktop-smoke/build.mjs");
  assert.equal(
    manifest.scripts["desktop-shell-smoke"],
    "npm run desktop-shell-smoke:build && node tools/desktop-smoke/smoke.mjs",
  );
  assert.equal(existsSync("tools/e2e/run-parallel-black-box-campaign.mjs"), false);
  assert.doesNotMatch(manifest.scripts.e2e, /nohup|parallel-black-box|target-architecture/u);
  assert.match(makefile, /^e2e:\n\tnpm run e2e$/mu);
});

test("foreground E2E skeleton fixes the seven mandatory Cases", () => {
  assert.deepEqual(FOREGROUND_E2E_CASE_IDS, [
    "approved_happy_path",
    "plan_rejected_and_replanned",
    "information_requested_and_answered",
    "root_revision_and_comment",
    "parallel_multi_conductor",
    "same_conductor_preemption",
    "conductor_restart_recovery",
  ]);
});

test("foreground E2E CLI fails closed with sanitized configuration errors", () => {
  const result = runCampaignCli({ SYMPHONY_E2E_TEST_CANARY: "must-not-appear" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "failed",
    reason_code: "e2e_configuration_invalid",
    issues: [
      "linear_dev_token_missing",
      "linear_human_token_missing",
      "linear_client_id_missing",
      "linear_client_secret_missing",
      "linear_project_slug_id_missing",
      "linear_setup_authorization_missing",
      "codex_api_key_missing",
      "codex_base_url_missing",
      "codex_model_missing",
    ],
  });
  assert.doesNotMatch(result.stderr, /must-not-appear/u);
});

test("foreground E2E skeleton never converts complete configuration into synthetic success", () => {
  const result = runCampaignCli(validEnvironment());

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "failed",
    reason_code: "foreground_e2e_environment_unavailable",
    issues: [],
  });
  assert.doesNotMatch(result.stderr, /symphony-token|human-token|client-secret|codex-key/u);
});

function runCampaignCli(environment) {
  return spawnSync(process.execPath, [campaignCli], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...environment },
  });
}

function validEnvironment() {
  return {
    SYMPHONY_E2E_LINEAR_DEV_TOKEN: "symphony-token",
    SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "human-token",
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    SYMPHONY_E2E_PROJECT_SLUG_ID: "project-slug",
    SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED: "true",
    SYMPHONY_E2E_CODEX_API_KEY: "codex-key",
    SYMPHONY_E2E_CODEX_BASE_URL: "https://example.test",
    SYMPHONY_E2E_CODEX_MODEL: "gpt-5-codex",
  };
}
