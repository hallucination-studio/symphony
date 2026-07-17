import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  E2E_NON_SECRET_DEFAULTS,
  loadE2EConfig,
  parseDotEnv,
  summarizeConfig,
} from "../../tools/e2e/config.mjs";
import {
  StepRunner,
  StepTimeoutError,
} from "../../tools/e2e/step-runner.mjs";
import {
  acquireGlobalLock,
  lockPathForConfig,
} from "../../tools/e2e/global-lock.mjs";
import {
  executeLinearMutation,
  isRetryableLinearError,
} from "../../tools/e2e/linear-mutation.mjs";
import {
  createLinuxTauriUi,
  createMacTauriUi,
} from "../../tools/e2e/ui-adapters.mjs";
import { createE2EVerdict } from "../../tools/e2e/verdict.mjs";
import { createV1BusinessActions } from "../../tools/e2e/business-actions.mjs";
import { createDesktopClient } from "../../tools/e2e/desktop-client.mjs";

function validEnvironment(repositoryPath) {
  return {
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    LINEAR_E2E_USER_API_KEY: "linear-user-key",
    OPENAI_E2E_API_KEY: "openai-key",
    SYMPHONY_E2E_GITHUB_TOKEN: "github-token",
    SYMPHONY_E2E_PROJECT_SLUG_ID: E2E_NON_SECRET_DEFAULTS.projectSlugId,
    SYMPHONY_E2E_REPOSITORY_PATH: repositoryPath,
    SYMPHONY_E2E_GITHUB_REPOSITORY: "acme/symphony-e2e",
    SYMPHONY_E2E_GITHUB_BASE_BRANCH: "main",
  };
}

test("loads the same dotenv shape as CI environment variables and never summarizes secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-e2e-config-"));
  const repository = path.join(root, "repository");
  const environment = validEnvironment(repository);
  const dotenv = parseDotEnv("OPENAI_E2E_API_KEY=from-file\nSYMPHONY_E2E_PROJECT_SLUG_ID=" + environment.SYMPHONY_E2E_PROJECT_SLUG_ID + "\n");

  assert.equal(dotenv.OPENAI_E2E_API_KEY, "from-file");
  const config = loadE2EConfig({
    environment,
    dotenv,
    cwd: root,
    platform: "linux",
    pathExists: (value) => value === repository,
  });

  assert.equal(config.secrets.openAiApiKey, "openai-key");
  assert.equal(config.project.slugId, E2E_NON_SECRET_DEFAULTS.projectSlugId);
  assert.equal(config.repository.path, repository);
  const summary = JSON.stringify(summarizeConfig(config));
  assert.equal(summary.includes("openai-key"), false);
  assert.equal(summary.includes(repository), false);
});

test("preflight configuration rejects missing secrets and project drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-e2e-config-"));
  const environment = validEnvironment(path.join(root, "repository"));
  delete environment.OPENAI_E2E_API_KEY;
  environment.SYMPHONY_E2E_PROJECT_SLUG_ID = "wrong-project";

  assert.throws(
    () => loadE2EConfig({ environment, cwd: root, platform: "linux", pathExists: () => true }),
    (error) => error.code === "e2e_configuration_invalid" &&
      error.issues.includes("OPENAI_E2E_API_KEY_missing") &&
      error.issues.includes("project_slug_id_not_allowlisted"),
  );
});

test("preflight ignores the retired Project name and slug variable names", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-e2e-config-"));
  const environment = validEnvironment(path.join(root, "repository"));
  delete environment.SYMPHONY_E2E_PROJECT_SLUG_ID;
  environment.SYMPHONY_E2E_PROJECT_SLUG = E2E_NON_SECRET_DEFAULTS.projectSlugId;
  environment.SYMPHONY_E2E_EXPECTED_PROJECT_NAME = "renamed-project";

  assert.throws(
    () => loadE2EConfig({ environment, cwd: root, platform: "linux", pathExists: () => true }),
    (error) => error.code === "e2e_configuration_invalid" &&
      error.issues.includes("project_slug_id_missing"),
  );
});

test("step runner records evidence and fails fast on the first rejected step", async () => {
  const evidence = [];
  const runner = new StepRunner({ evidence });
  const calls = [];

  await runner.run({
    id: "connected",
    deadlineMs: 100,
    invoke: async () => { calls.push("connected"); return { status: "connected" }; },
    expect: (observation) => observation.status === "connected",
  });
  await assert.rejects(
    runner.run({
      id: "binding",
      deadlineMs: 100,
      invoke: async () => { calls.push("binding"); return { status: "failed" }; },
      expect: () => false,
    }),
    /step_expectation_failed/,
  );
  await assert.rejects(
    runner.run({ id: "never-runs", deadlineMs: 100, invoke: async () => calls.push("never") }),
    /step_runner_stopped/,
  );

  assert.deepEqual(calls, ["connected", "binding"]);
  assert.deepEqual(evidence.map(({ id, status }) => [id, status]), [
    ["connected", "passed"],
    ["binding", "failed"],
  ]);
});

test("step runner turns an overdue operation into a bounded timeout", async () => {
  const runner = new StepRunner({ evidence: [] });
  await assert.rejects(
    runner.run({
      id: "slow",
      deadlineMs: 1,
      invoke: () => new Promise(() => {}),
    }),
    (error) => error instanceof StepTimeoutError && error.stepId === "slow",
  );
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

test("Linear mutation retries transient failures, refreshes conflicts, and reports blocked exhaustion", async () => {
  let attempts = 0;
  let refreshes = 0;
  const result = await executeLinearMutation({
    maxAttempts: 3,
    baseDelayMs: 0,
    sleep: async () => {},
    mutate: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      if (attempts === 2) throw Object.assign(new Error("user changed state"), { code: "linear_precondition_conflict" });
    },
    readBack: async () => attempts === 3 ? { state: "accepted" } : undefined,
    refresh: async () => { refreshes += 1; },
    matches: (value) => value?.state === "accepted",
    writeSanitizedComment: async () => { throw new Error("should not comment"); },
  });
  assert.deepEqual(result, { status: "succeeded", attempts: 3, value: { state: "accepted" } });
  assert.equal(refreshes, 1);
  assert.equal(isRetryableLinearError(Object.assign(new Error(), { status: 503 })), true);
  assert.equal(isRetryableLinearError(Object.assign(new Error(), { code: "linear_precondition_conflict" })), true);
});

test("Linear mutation writes a sanitized blocker and stops when retries are exhausted", async () => {
  const comments = [];
  const stops = [];
  const result = await executeLinearMutation({
    maxAttempts: 2,
    baseDelayMs: 0,
    sleep: async () => {},
    mutate: async () => { throw Object.assign(new Error("provider secret"), { status: 500 }); },
    readBack: async () => undefined,
    matches: () => false,
    writeSanitizedComment: async (comment) => comments.push(comment),
    stop: async (reason) => stops.push(reason),
  });
  assert.equal(result.status, "blocked");
  assert.equal(comments.length, 1);
  assert.equal(JSON.stringify(comments[0]).includes("provider secret"), false);
  assert.equal(stops[0], "linear_mutation_attempts_exhausted");
});

test("Linear mutation reports the actual attempt count for a terminal failure", async () => {
  const comments = [];
  const result = await executeLinearMutation({
    maxAttempts: 5,
    baseDelayMs: 0,
    sleep: async () => {},
    mutate: async () => {
      throw Object.assign(new Error("not authorized"), { status: 401 });
    },
    readBack: async () => undefined,
    matches: () => false,
    writeSanitizedComment: async (comment) => comments.push(comment),
  });

  assert.equal(result.attempts, 1);
  assert.equal(comments[0].attempts, 1);
});

test("Linux and macOS adapters expose the same UI action contract", async () => {
  const calls = [];
  const browser = {
    $: async (selector) => ({
      click: async () => calls.push(["click", selector]),
      setValue: async (value) => calls.push(["type", selector, value]),
      selectByVisibleText: async (value) => calls.push(["select", selector, value]),
      selectByIndex: async (value) => calls.push(["select-first", selector, value]),
      getText: async () => "Connected",
    }),
  };
  const linux = createLinuxTauriUi({ browser });
  const mac = createMacTauriUi({ browser });
  for (const ui of [linux, mac]) {
    await ui.click("[data-testid=linear-status]");
    await ui.type("[name=project]", "HELL");
    await ui.select("[name=branch]", "main");
    await ui.selectFirst("[name=project]");
    assert.equal(await ui.read("[data-testid=linear-status]"), "Connected");
  }
  assert.equal(linux.platform, "linux");
  assert.equal(mac.platform, "darwin");
  assert.equal(calls.length, 8);
});

test("business actions select the only allowlisted Project and keep repository paths out of UI observations", async () => {
  const calls = [];
  const actions = createV1BusinessActions({
    ui: {
      async select(selector, value) {
        calls.push(["select", selector, value]);
      },
      async selectFirst(selector) {
        calls.push(["select-first", selector]);
      },
      async click(selector) {
        calls.push(["click", selector]);
      },
    },
    client: {
      async readSelectedProject() {
        return { projectName: "renamed-project" };
      },
      async selectRepository() {
        return { repositoryPathAccepted: true };
      },
    },
    runner: new StepRunner({ evidence: [] }),
    config: {
      project: { slugId: "8ab43179fb54" },
      repository: { path: "/must-not-cross-browser-boundary" },
      github: { baseBranch: "main" },
    },
  });

  await actions.selectProject();
  await actions.selectRepository();

  assert.deepEqual(calls, [
    ["select-first", "[data-testid=project-select]"],
    ["click", "[data-testid=choose-repository]"],
  ]);
});

test("secondary Profile reuses the bounded secret frame before applying settings", async () => {
  const calls = [];
  const actions = createV1BusinessActions({
    ui: {},
    client: {
      async createApiKeyProfile(input) { calls.push(["create", input]); },
      async setApiKeyAndActivate(secret, displayName) {
        calls.push(["secret", secret, displayName]);
      },
      async updateProfileSettings(input) {
        calls.push(["settings", input]);
        return { ...input, fastMode: false };
      },
    },
    runner: new StepRunner({ evidence: [] }),
    config: { secrets: { openAiApiKey: "bounded-secret" } },
  });

  await actions.createSecondaryApiKeyProfile({
    model: "fixture-model",
    reasoningEffort: "high",
  });

  assert.deepEqual(calls, [
    ["create", { displayName: "E2E secondary" }],
    ["secret", "bounded-secret", "E2E secondary"],
    ["settings", {
      displayName: "E2E secondary",
      model: "fixture-model",
      reasoningEffort: "high",
    }],
  ]);
});

test("desktop client reacquires the Profile row through secret entry and activation", async () => {
  let profileText = "E2E primary\nNeeds API Key";
  let updatedModel;
  let rowReads = 0;
  const calls = [];
  const profileRow = () => ({
    async getText() {
      rowReads += 1;
      return profileText;
    },
    async $(selector) {
      return {
        async click() {
          calls.push(["row-click", selector]);
          if (selector === "[data-testid=profile-activate]") {
            profileText = "E2E primary\nReady\nActive for new Roots";
          }
        },
        async waitForDisplayed() {},
      };
    },
  });
  const browser = {
    async $(selector) {
      return {
        async getText() { return selector.includes("option:checked") ? "main" : ""; },
        async waitForDisplayed() {},
      };
    },
    async $$(selector) {
      assert.equal(selector, "[data-testid=profile-row]");
      return [profileRow()];
    },
    async waitUntil(predicate) {
      assert.equal(await predicate(), true);
    },
  };
  const ui = {
    async click(selector) {
      calls.push(["click", selector]);
      if (selector === "[data-testid=profile-save]" && updatedModel) {
        profileText = `E2E primary\nReady\nActive for new Roots\n${updatedModel}`;
      }
    },
    async type(selector, value) {
      calls.push(["type", selector, value]);
      if (selector.includes("[name=model]")) updatedModel = value;
    },
    async select(selector, value) { calls.push(["select", selector, value]); },
    async read() { return "Ready"; },
  };
  const client = createDesktopClient({ browser, ui, timeoutMs: 10 });

  await client.createApiKeyProfile({ displayName: "E2E primary" });
  assert.deepEqual(
    await client.setApiKeyAndActivate("bounded-secret", "E2E primary"),
    { readiness: "ready", isActive: true },
  );
  assert.deepEqual(
    await client.updateProfileSettings({
      displayName: "E2E primary",
      model: "gpt-5.1",
      reasoningEffort: "xhigh",
    }),
    {
      displayName: "E2E primary",
      model: "gpt-5.1",
      reasoningEffort: "xhigh",
      fastMode: false,
    },
  );

  assert.equal(rowReads >= 3, true);
  assert.equal(calls.some((call) => call.includes("bounded-secret")), true);
  assert.equal(calls.some((call) => call.includes("[data-testid=profile-activate]")), true);
  assert.equal(calls.some((call) => call.includes("Extra high")), true);
});

test("verdict keeps automated API-key evidence separate from incomplete full V1 evidence", () => {
  const verdict = createE2EVerdict({
    apiKeyChecks: [{ id: "S1", status: "passed" }, { id: "S2", status: "passed" }, { id: "S3", status: "passed" }],
    fullRoadmapChecks: [{ id: "chatgpt-live-login", status: "not_run" }],
  });
  assert.equal(verdict.automated_api_key_v1_e2e.status, "passed");
  assert.equal(verdict.roadmap_v1.status, "incomplete");
  assert.equal(verdict.roadmap_v1.reason, "chatgpt_live_login_not_run");
});
