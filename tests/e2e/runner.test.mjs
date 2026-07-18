import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createChildEnvironment,
  loadE2EConfig,
  summarizeConfig,
} from "../../tools/e2e/config.mjs";
import {
  acquireGlobalLock,
  lockPathForConfig,
} from "../../tools/e2e/global-lock.mjs";

function validEnvironment() {
  return {
    SYMPHONY_E2E_LINEAR_DEV_TOKEN: "linear-dev-canary",
    LINEAR_CLIENT_ID: "linear-client-id",
    SYMPHONY_E2E_CODEX_API_KEY: "codex-canary",
    SYMPHONY_E2E_CODEX_BASE_URL: "https://codex.example.test/v1",
    SYMPHONY_E2E_CODEX_MODEL: "codex-test-model",
  };
}

test("loads the five pipeline inputs and summarizes only secret presence", () => {
  const environment = validEnvironment();
  const config = loadE2EConfig({ environment, platform: "linux" });

  assert.equal(config.secrets.linearDevToken, "linear-dev-canary");
  assert.equal(config.secrets.codexApiKey, "codex-canary");
  assert.deepEqual(config.codex, {
    baseUrl: "https://codex.example.test/v1",
    model: "codex-test-model",
  });
  assert.deepEqual(config.linear, { clientId: "linear-client-id" });
  const summary = JSON.stringify(summarizeConfig(config));
  assert.equal(summary.includes("linear-dev-canary"), false);
  assert.equal(summary.includes("codex-canary"), false);
  assert.match(summary, /"linearDevToken":true/u);
  assert.match(summary, /"codexApiKey":true/u);
});

test("configuration reports stable missing-input codes without values", () => {
  const environment = validEnvironment();
  delete environment.SYMPHONY_E2E_CODEX_API_KEY;

  assert.throws(
    () => loadE2EConfig({ environment, platform: "linux" }),
    (error) => error.code === "e2e_configuration_invalid" &&
      error.issues.includes("codex_api_key_missing") &&
      !JSON.stringify(error).includes("linear-dev-canary"),
  );
});

for (const [baseUrl, issue] of [
  ["https://user:pass@codex.example.test/v1", "codex_base_url_credentials_forbidden"],
  ["https://codex.example.test/v1?q=secret", "codex_base_url_query_forbidden"],
  ["https://codex.example.test/v1#secret", "codex_base_url_fragment_forbidden"],
  ["https://codex.example.test/v1\nmalformed", "codex_base_url_control_character"],
  ["ftp://codex.example.test/v1", "codex_base_url_protocol_invalid"],
  ["https://other.example.test/v1", "codex_base_url_host_not_allowlisted"],
]) {
  test(`CI rejects unsafe Codex base URL: ${issue}`, () => {
    const environment = {
      ...validEnvironment(),
      CI: "true",
      SYMPHONY_E2E_CODEX_BASE_URL: baseUrl,
      SYMPHONY_E2E_CODEX_ALLOWED_HOSTS: "codex.example.test",
    };

    assert.throws(
      () => loadE2EConfig({ environment, platform: "linux" }),
      (error) => error.code === "e2e_configuration_invalid" &&
        error.issues.includes(issue),
    );
  });
}

test("CI permits an allowlisted HTTP Codex base URL", () => {
  const environment = {
    ...validEnvironment(),
    CI: "true",
    SYMPHONY_E2E_CODEX_BASE_URL: "http://codex.example.test/v1",
    SYMPHONY_E2E_CODEX_ALLOWED_HOSTS: "codex.example.test",
  };

  assert.equal(
    loadE2EConfig({ environment, platform: "linux" }).codex.baseUrl,
    "http://codex.example.test/v1",
  );
});

test("child environments are explicit allowlists and omit both E2E secrets", () => {
  const environment = {
    ...validEnvironment(),
    PATH: "/usr/bin",
    HOME: "/home/test",
    LANG: "en_US.UTF-8",
    UNRELATED: "must-not-cross",
  };

  assert.deepEqual(createChildEnvironment({ environment }), {
    HOME: "/home/test",
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin",
  });
});

test("doctor fails closed without printing a supplied secret canary", () => {
  const canary = "linear-secret-canary-82a1";
  const result = spawnSync(process.execPath, ["tools/e2e/doctor.mjs"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SYMPHONY_E2E_LINEAR_DEV_TOKEN: canary,
    },
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, new RegExp(canary, "u"));
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "failed",
    reason: "e2e_configuration_invalid",
    issues: ["linear_client_id_missing", "codex_api_key_missing", "codex_base_url_missing", "codex_model_missing"],
  });
});

test("global lock is atomic and second owner cannot enter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-e2e-lock-"));
  const config = { paths: { lock: lockPathForConfig(root) } };
  const first = await acquireGlobalLock(config, { runId: "first" });
  await assert.rejects(
    acquireGlobalLock(config, { runId: "second" }),
    /e2e_lock_unavailable/,
  );
  await first.release();
  const second = await acquireGlobalLock(config, { runId: "second" });
  await second.release();
});
