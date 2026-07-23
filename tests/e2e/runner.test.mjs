import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createChildEnvironment,
  loadE2EConfig,
  summarizeConfig,
} from "../../tools/e2e/config.mjs";
import { run as runCleanup } from "../../tools/e2e/cleanup.mjs";

function validEnvironment() {
  return {
    SYMPHONY_E2E_LINEAR_DEV_TOKEN: "linear-dev-canary",
    LINEAR_CLIENT_ID: "linear-client-id",
    SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED: "true",
    SYMPHONY_E2E_PROJECT_SLUG_ID: "project-retained-123",
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
  assert.deepEqual(config.linear, {
    clientId: "linear-client-id",
    projectSlugId: "project-retained-123",
    setupAuthorized: true,
  });
  const summary = JSON.stringify(summarizeConfig(config));
  assert.equal(summary.includes("linear-dev-canary"), false);
  assert.equal(summary.includes("codex-canary"), false);
  assert.match(summary, /"linearDevToken":true/u);
  assert.match(summary, /"codexApiKey":true/u);
});

test("loads the retained Linear Project slug without making it a secret", () => {
  const environment = {
    ...validEnvironment(),
    SYMPHONY_E2E_PROJECT_SLUG_ID: "project-debug-123",
  };

  const config = loadE2EConfig({ environment, platform: "linux" });
  assert.deepEqual(config.linear, {
    clientId: "linear-client-id",
    projectSlugId: "project-debug-123",
    setupAuthorized: true,
  });
  assert.equal(summarizeConfig(config).linear.projectSlugId, "project-debug-123");
});

test("requires the retained Linear Project slug before a live run", () => {
  const environment = validEnvironment();
  delete environment.SYMPHONY_E2E_PROJECT_SLUG_ID;

  assert.throws(
    () => loadE2EConfig({ environment, platform: "linux" }),
    (error) => error.code === "e2e_configuration_invalid" &&
      error.issues.includes("linear_project_slug_id_missing"),
  );
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
    status: "unverified",
    reason: "e2e_configuration_invalid",
      issues: ["linear_client_id_missing", "linear_project_slug_id_missing", "linear_setup_authorization_missing", "codex_api_key_missing", "codex_base_url_missing", "codex_model_missing"],
  });
});

test("standalone cleanup resolves the Project with Linear's supported id argument", async () => {
  const requests = [];
  const result = await runCleanup({
    environment: { ...validEnvironment() },
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.operationName === "TargetWorkflowResolveProject") {
        return {
          ok: true,
          status: 200,
          async json() { return { data: { project: { id: "project-1" } } }; },
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => undefined },
        async json() {
          return { data: { project: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } };
        },
      };
    },
  });

  assert.deepEqual(result, { status: "passed", archived: 0, projectDigest: "a33e35d30212" });
  assert.match(requests[0].query, /project\(id: \$projectSlugId\)/u);
  assert.deepEqual(requests[0].variables, { projectSlugId: "project-retained-123" });
  assert.equal(requests.length, 2);
});

test("standalone cleanup refuses workflow mutation without explicit setup authorization", async () => {
  let requests = 0;
  await assert.rejects(
    runCleanup({
      environment: { ...validEnvironment(), SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED: "false" },
      fetch: async () => { requests += 1; },
    }),
    /target_live_cleanup_authorization_required/u,
  );
  assert.equal(requests, 0);
});
