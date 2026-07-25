import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const campaignCli = "tools/e2e/run-parallel-black-box-campaign.mjs";

test("E2E command surface has one secret-free contract command and one real Campaign command", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const makefile = readFileSync("Makefile", "utf8");

  assert.equal(
    manifest.scripts.e2e,
    "node --env-file-if-exists=.env tools/e2e/run-parallel-black-box-campaign.mjs",
  );
  assert.equal(
    manifest.scripts["test:e2e:runner"],
    "node tools/e2e/run-with-timeout.mjs --timeout-ms 300000 -- node --test tests/e2e/*.test.mjs",
  );
  assert.equal(manifest.scripts["e2e:doctor"], undefined);
  assert.equal(manifest.scripts["test:e2e:target-architecture"], undefined);
  assert.equal(existsSync("tools/e2e/doctor.mjs"), false);
  assert.doesNotMatch(manifest.scripts["test:e2e:runner"], /env-file|target-architecture/u);
  assert.match(makefile, /^e2e:\n\tnpm run e2e$/mu);
  assert.doesNotMatch(makefile, /E2E is deferred/u);
});

test("real Campaign CLI fails closed with sanitized structured output when credentials are missing", () => {
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

test("real Campaign CLI does not claim success before the P06 runtime exists", () => {
  const result = runCampaignCli({
    SYMPHONY_E2E_LINEAR_DEV_TOKEN: "symphony-token",
    SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "human-token",
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    SYMPHONY_E2E_PROJECT_SLUG_ID: "project-slug",
    SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED: "true",
    SYMPHONY_E2E_CODEX_API_KEY: "codex-key",
    SYMPHONY_E2E_CODEX_BASE_URL: "https://example.test",
    SYMPHONY_E2E_CODEX_MODEL: "gpt-5-codex",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "failed",
    reason_code: "parallel_black_box_campaign_runtime_unavailable",
    issues: [],
  });
  assert.doesNotMatch(result.stderr, /symphony-token|human-token|client-secret|codex-key/u);
});

test("real Campaign CLI retains a stable invalid-configuration issue without exposing its input", () => {
  const result = runCampaignCli({
    SYMPHONY_E2E_LINEAR_DEV_TOKEN: "same-token",
    SYMPHONY_E2E_LINEAR_HUMAN_TOKEN: "same-token",
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    SYMPHONY_E2E_PROJECT_SLUG_ID: "project-slug",
    SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED: "true",
    SYMPHONY_E2E_CODEX_API_KEY: "codex-key",
    SYMPHONY_E2E_CODEX_BASE_URL: "https://example.test",
    SYMPHONY_E2E_CODEX_MODEL: "gpt-5-codex",
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "failed",
    reason_code: "e2e_configuration_invalid",
    issues: ["linear_actor_credentials_not_distinct"],
  });
  assert.doesNotMatch(result.stderr, /same-token|client-secret|codex-key/u);
});

function runCampaignCli(environment) {
  return spawnSync(process.execPath, [campaignCli], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...environment,
    },
  });
}
