import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { TARGET_WORKFLOW_SCENARIOS } from "../../tools/e2e/target-workflow-verdict.mjs";
import {
  composeTargetWorkflowScenarioInput,
  createTargetWorkflowCliEnvironment,
  targetWorkflowCliExitCode,
  runTargetWorkflowAllLive,
  runTargetWorkflowDryRun,
} from "../../tools/e2e/target-workflow-entry.mjs";

function scenarioOutcome(scenario, status = "passed", observation = {}) {
  return {
    result: { scenario, status },
    observation: {
      logicalOperations: 0,
      physicalRequests: 0,
      complexityConsumed: 0,
      rateLimited: false,
      ...observation,
    },
    cleanupCompleted: true,
  };
}

test("target workflow CLI generates a safe local run ID when none is provided", () => {
  const environment = createTargetWorkflowCliEnvironment({
    environment: { PATH: "/usr/bin" },
    now: () => 1_721_707_200_000,
    randomUuid: () => "00000000-0000-4000-8000-000000000001",
  });

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.SYMPHONY_E2E_RUN_ID, "local-lyxw0hs0-00000000-0000-4000-8000-000000000001");
});

test("target workflow CLI preserves an explicit CI run ID", () => {
  const environment = { PATH: "/usr/bin", SYMPHONY_E2E_RUN_ID: "gha-123-1" };

  assert.deepEqual(createTargetWorkflowCliEnvironment({ environment }), environment);
});

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

for (const argument of ["--live-restart", "--live-scheduling"]) {
  test(`target workflow ${argument} reports unverified before mutation when credentials are absent`, () => {
    const result = spawnSync(process.execPath, ["tools/e2e/target-workflow-entry.mjs", argument], {
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
}

test("target workflow all-run reports unverified before setup when credentials are absent", () => {
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

test("target workflow all-run attempts every scenario and recomputes a failed verdict", async () => {
  const calls = [];
  const result = await runTargetWorkflowAllLive({
    config: {
      linear: { clientId: "client-1", projectSlugId: "project-1" },
      secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
      codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
    },
    environment: { SYMPHONY_E2E_RUN_ID: "target-all" },
    runScenarioProcess: async ({ scenario }) => {
      calls.push(scenario);
      if (scenario === "repair_escalation") throw new Error("repair_live_failed");
      return scenarioOutcome(scenario);
    },
    prepareSetup: async () => ({ setup: {}, ids: {} }),
    writeEvidence: false,
  });

  assert.deepEqual(calls, ["success", "repair_escalation", "restart_recovery", "delivery", "scheduling"]);
  assert.equal(result.status, "failed");
  assert.equal(result.verdict.verdict, "failed");
  assert.deepEqual(result.verdict.missingScenarios, ["repair_escalation"]);
  assert.deepEqual(Object.keys(result.evidence.linearObservation.scenarios).sort(), TARGET_WORKFLOW_SCENARIOS.slice().sort());
  assert.equal(result.evidence.linearObservation.setup.physicalRequests, 0);
  assert.equal(result.evidence.linearObservation.total.physicalRequests, 0);
  assert.equal(JSON.stringify(result).includes("linear-secret"), false);
  assert.equal(JSON.stringify(result).includes("codex-secret"), false);
});

test("target workflow all-run starts every scenario before any scenario finishes", async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const resultPromise = runTargetWorkflowAllLive({
    config: {
      linear: { clientId: "client-1", projectSlugId: "project-1" },
      secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
      codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
    },
    environment: { SYMPHONY_E2E_RUN_ID: "target-all-parallel" },
    prepareSetup: async () => ({ setup: {}, ids: {} }),
    runScenarioProcess: async ({ scenario }) => {
      started.push(scenario);
      await gate;
      return scenarioOutcome(scenario);
    },
    writeEvidence: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started, TARGET_WORKFLOW_SCENARIOS);
  release();
  const result = await resultPromise;
  assert.equal(result.status, "failed");
});

test("target workflow all-run uses isolated scenario processes after one prepared setup", async () => {
  const starts = [];
  const preparedSetup = {
    setup: {
      kind: "ready", workflow: "already_applied", projectLabel: "already_applied",
      identityDigest: "a".repeat(16),
    },
    ids: { conductorShortHash: "abcdef123456" },
  };
  const result = await runTargetWorkflowAllLive({
    config: {
      linear: { clientId: "client-1", projectSlugId: "project-1" },
      secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
      codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
    },
    environment: { SYMPHONY_E2E_RUN_ID: "target-process-all" },
    prepareSetup: async () => preparedSetup,
    runScenarioProcess: async (input) => {
      starts.push({ scenario: input.scenario, setupFile: input.setupFile });
      const persisted = JSON.parse(await readFile(input.setupFile, "utf8"));
      assert.deepEqual(persisted, preparedSetup);
      return {
        result: { scenario: input.scenario, status: "failed" },
        observation: {
          logicalOperations: 0,
          physicalRequests: 0,
          complexityConsumed: 0,
          rateLimited: false,
        },
      };
    },
    writeEvidence: false,
  });

  assert.deepEqual(starts.map(({ scenario }) => scenario), TARGET_WORKFLOW_SCENARIOS);
  assert.equal(new Set(starts.map(({ setupFile }) => setupFile)).size, 1);
  await assert.rejects(readFile(starts[0].setupFile, "utf8"));
  assert.equal(result.status, "failed");
});

test("target workflow all-run stops later scenarios after a real 429", async () => {
  const calls = [];
  const result = await runTargetWorkflowAllLive({
    config: {
      linear: { clientId: "client-1", projectSlugId: "project-1" },
      secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
      codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
    },
    environment: { SYMPHONY_E2E_RUN_ID: "target-all-rate-limited" },
    prepareSetup: async () => ({ setup: {}, ids: {}, rootInput: {} }),
    runScenarioProcess: async ({ scenario }) => {
      calls.push(scenario);
      return scenarioOutcome(scenario, "failed", { rateLimited: true });
    },
    writeEvidence: false,
  });

  assert.deepEqual(calls, TARGET_WORKFLOW_SCENARIOS);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.verdict.missingScenarios, TARGET_WORKFLOW_SCENARIOS);
  assert.equal(result.observation.rateLimited, true);
  assert.deepEqual(Object.keys(result.evidence.linearObservation.scenarios).sort(), TARGET_WORKFLOW_SCENARIOS.slice().sort());
});

test("target workflow all-run prepares Linear setup once before every scenario", async () => {
  const events = [];
  const preparedSetup = {
    setup: {
      kind: "ready", workflow: "already_applied", projectLabel: "already_applied",
      identityDigest: "a".repeat(16),
    },
    ids: { conductorShortHash: "abcdef123456" },
  };
  const result = await runTargetWorkflowAllLive({
    config: {
      linear: { clientId: "client-1", projectSlugId: "project-1" },
      secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
      codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
    },
    environment: { SYMPHONY_E2E_RUN_ID: "target-all-setup" },
    prepareSetup: async ({ poolMode }) => {
      events.push(["setup", poolMode]);
      return preparedSetup;
    },
    runScenarioProcess: async ({ scenario, setupFile }) => {
      const persisted = JSON.parse(await readFile(setupFile, "utf8"));
      events.push([scenario, persisted]);
      return scenarioOutcome(scenario);
    },
    writeEvidence: false,
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(events[0], ["setup", "parallel"]);
  assert.deepEqual(events.slice(1).sort(([left], [right]) => left.localeCompare(right)), [
    ["delivery", preparedSetup],
    ["repair_escalation", preparedSetup],
    ["restart_recovery", preparedSetup],
    ["scheduling", preparedSetup],
    ["success", preparedSetup],
  ]);
});

test("default scenario composition isolates run IDs and Root inputs", () => {
  const setup = {
    ids: {
      conductorId: "conductor-1",
      bindingId: "binding-1",
      instanceId: "instance-1",
      repositoryHandle: "repository-1",
    },
    rootInput: { title: "Target Root", description: "Target description" },
  };
  const inputs = TARGET_WORKFLOW_SCENARIOS.map((scenario) => composeTargetWorkflowScenarioInput(scenario, {
    setup,
    environment: { SYMPHONY_E2E_RUN_ID: "target-all-composition" },
  }));
  const runIds = inputs.map(({ environment }) => environment.SYMPHONY_E2E_RUN_ID);
  assert.equal(new Set(runIds).size, TARGET_WORKFLOW_SCENARIOS.length);
  const conductorIds = inputs.map(({ setup: value }) => value.ids.conductorId);
  const bindingIds = inputs.map(({ setup: value }) => value.ids.bindingId);
  const instanceIds = inputs.map(({ setup: value }) => value.ids.instanceId);
  const repositoryHandles = inputs.map(({ setup: value }) => value.ids.repositoryHandle);
  const conductorShortHashes = inputs.map(({ setup: value }) => value.ids.conductorShortHash);
  assert.equal(new Set(conductorIds).size, TARGET_WORKFLOW_SCENARIOS.length);
  assert.equal(new Set(conductorShortHashes).size, TARGET_WORKFLOW_SCENARIOS.length);
  assert.equal(new Set(bindingIds).size, TARGET_WORKFLOW_SCENARIOS.length);
  assert.equal(new Set(instanceIds).size, TARGET_WORKFLOW_SCENARIOS.length);
  assert.equal(new Set(repositoryHandles).size, TARGET_WORKFLOW_SCENARIOS.length);
  assert.deepEqual(inputs.map(({ setup: value }) => value.rootInput.title), TARGET_WORKFLOW_SCENARIOS.map((scenario) => `Target Root [${scenario}]`));
  assert.deepEqual(inputs.map(({ setup: value }) => value.rootInput.conductorShortHash), conductorShortHashes);
  assert.ok(inputs.every(({ setup: value }, index) => value.rootInput.description.includes(runIds[index])));
});

test("target workflow all-run dispatches a scenario without local request authorization", async () => {
  const calls = [];
  const result = await runTargetWorkflowAllLive({
    config: {
      linear: { clientId: "client-1", projectSlugId: "project-1" },
      secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
      codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
    },
    environment: { SYMPHONY_E2E_RUN_ID: "target-all-observer" },
    prepareSetup: async () => ({ setup: {}, ids: {}, rootInput: {} }),
    runScenarioProcess: async ({ scenario }) => {
      calls.push(scenario);
      return scenarioOutcome(scenario);
    },
    writeEvidence: false,
  });

  assert.deepEqual(calls, TARGET_WORKFLOW_SCENARIOS);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.verdict.missingScenarios, []);
});

test("each target workflow rerun starts with a fresh observation stream", async () => {
  const setupSnapshots = [];
  const input = {
    config: {
      linear: { clientId: "client-1", projectSlugId: "project-1" },
      secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
      codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
    },
    environment: { SYMPHONY_E2E_RUN_ID: "target-all-fresh-observer" },
    prepareSetup: async ({ observer }) => {
      observer.observe({
        requestWindow: { limit: 1000, remaining: 251, reset: 3600 },
        complexityWindow: { limit: 2_000_000, remaining: 506_726, reset: 3600 },
      });
      setupSnapshots.push(observer.snapshot());
      return { setup: {}, ids: {}, rootInput: {} };
    },
    runScenarioProcess: async ({ scenario }) => scenarioOutcome(scenario),
    writeEvidence: false,
  };

  await runTargetWorkflowAllLive(input);
  await runTargetWorkflowAllLive(input);

  assert.deepEqual(setupSnapshots.map((snapshot) => ({
    physicalRequests: snapshot.physicalRequests,
    complexityConsumed: snapshot.complexityConsumed,
  })), [
    { physicalRequests: 1, complexityConsumed: 0 },
    { physicalRequests: 1, complexityConsumed: 0 },
  ]);
});

test("target workflow all-run shares one five-minute deadline across scenarios", async () => {
  let currentTime = 0;
  const calls = [];
  const result = await runTargetWorkflowAllLive({
    config: {
      linear: { clientId: "client-1", projectSlugId: "project-1" },
      secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
      codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
    },
    environment: { SYMPHONY_E2E_RUN_ID: "target-all-deadline" },
    timeoutMs: 250,
    now: () => currentTime,
    prepareSetup: async () => {
      currentTime = 100;
      return { setup: {}, ids: {}, rootInput: {} };
    },
    runScenarioProcess: async ({ scenario, deadlineAtMs }) => {
      calls.push([scenario, deadlineAtMs - currentTime]);
      currentTime += 60;
      return scenarioOutcome(scenario);
    },
    writeEvidence: false,
  });

  assert.deepEqual(calls, [
    ["success", 150],
    ["repair_escalation", 90],
    ["restart_recovery", 30],
  ]);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.verdict.missingScenarios, ["delivery", "scheduling"]);
});

test("target workflow all-run enforces its deadline while setup is stalled", async () => {
  await assert.rejects(
    runTargetWorkflowAllLive({
      config: {
        linear: { clientId: "client-1", projectSlugId: "project-1" },
        secrets: { linearDevToken: "linear-secret", codexApiKey: "codex-secret" },
        codex: { baseUrl: "https://codex.example.test/v1", model: "model-1" },
      },
      environment: { SYMPHONY_E2E_RUN_ID: "target-all-deadline-stalled" },
      timeoutMs: 20,
      prepareSetup: () => new Promise(() => {}),
      writeEvidence: false,
    }),
    /target_all_timeout/u,
  );
});

test("target workflow all-run binds the production setup as its default", async () => {
  const source = await readFile("tools/e2e/target-workflow-entry.mjs", "utf8");

  assert.match(source, /import \{ prepareTargetWorkflowSetup(?:, runIdentifiers)? \} from "\.\/target-workflow-setup\.mjs";/u);
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
