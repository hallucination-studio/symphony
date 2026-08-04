import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadStartup } from "./startup.js";

const secrets = {
  SYMPHONY_LINEAR_TOKEN: "runtime-secret",
  SYMPHONY_CODEX_API_KEY: "codex-secret",
  SYMPHONY_CODEX_BASE_URL: "https://api.example.com/v1",
  SYMPHONY_CODEX_MODEL: "model-1",
  SYMPHONY_LINEAR_EXCLUSIVE_MUTATION_ACTOR: "acknowledged",
  SYMPHONY_LINEAR_MANAGED_DESTRUCTION_PROHIBITED: "acknowledged",
  SYMPHONY_LINEAR_RELATION_PROVENANCE_AUDITED: "acknowledged",
};

function config(programData: string) {
  return {
    linear_team_id: "team-1",
    agent_actor_id: "actor:agent",
    polling_interval_ms: 1_000,
    program_data_path: programData,
    performer_home: path.join(programData, "performer"),
    codex_executable: "/usr/local/bin/codex",
    delivery_provider_endpoint: "https://api.github.com",
    root_states: {
      todo: "state:root:todo",
      in_progress: "state:root:in-progress",
      in_review: "state:root:in-review",
      done: "state:root:done",
      failed: "state:cycle:failed",
    },
    workflow: {
      labels: {
        root: "label:root",
        cycle: "label:cycle",
        plan: "label:plan",
        work: "label:work",
        verify: "label:verify",
      },
      cycle_states: {
        draft: "state:cycle:draft",
        in_progress: "state:cycle:in-progress",
        awaiting_acceptance: "state:cycle:awaiting-acceptance",
        succeeded: "state:cycle:succeeded",
        rejected: "state:cycle:rejected",
        failed: "state:cycle:failed",
        canceled: "state:cycle:canceled",
      },
      stage_states: {
        todo: "state:stage:todo",
        in_progress: "state:stage:in-progress",
        done: "state:stage:done",
        failed: "state:stage:failed",
        canceled: "state:stage:canceled",
      },
    },
    root_capabilities: [
      "task_manage:get_issue",
      "task_manage:list_issues",
      "task_manage:list_children",
      "task_manage:create_issue",
      "task_manage:update_issue",
      "task_manage:list_relations",
      "task_manage:list_states",
      "task_manage:list_labels",
      "git:get_workspace",
      "git:get_status",
      "git:get_diff",
    ],
    root: {
      root_id: "ROOT-1",
      repository_id: "repo-1",
      repository_path: path.join(programData, "repository"),
      base_branch: "main",
    },
  };
}

test("startup loads one strict public config and required Linear secret", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-startup-"));
  const configPath = path.join(directory, "conductor.json");
  await writeFile(configPath, JSON.stringify(config(directory)), { mode: 0o600 });

  const startup = await loadStartup(["--config", configPath], secrets);

  assert.equal(startup.config.linear_team_id, "team-1");
  assert.equal(startup.config_path, configPath);
  assert.equal(startup.linear_token, "runtime-secret");
  assert.equal(startup.codex_api_key, "codex-secret");
  assert.equal(startup.codex_base_url, "https://api.example.com/v1");
  assert.equal(startup.codex_model, "model-1");
  assert.deepEqual(startup.linear_provider_capabilities, {
    exclusive_mutation_actor: true,
    managed_destruction_prohibited: true,
    relation_provenance_audited: true,
  });
  assert.ok(Object.isFrozen(startup));
});

test("startup rejects missing, relative, duplicate, and unknown arguments", async () => {
  for (const argv of [
    [],
    ["--config"],
    ["--config", "relative.json"],
    ["--config", "/tmp/a.json", "--config", "/tmp/b.json"],
    ["--unknown", "/tmp/a.json"],
  ]) {
    await assert.rejects(loadStartup(argv, secrets), /invalid_startup_arguments/u);
  }
});

test("startup accepts an explicit credential-free HTTP Codex endpoint", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-startup-"));
  const configPath = path.join(directory, "conductor.json");
  await writeFile(configPath, JSON.stringify(config(directory)), { mode: 0o600 });

  const startup = await loadStartup(["--config", configPath], {
    ...secrets,
    SYMPHONY_CODEX_BASE_URL: "http://codex.internal/v1",
  });

  assert.equal(startup.codex_base_url, "http://codex.internal/v1");
});

test("startup fails closed without exposing missing or malformed secrets and config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-startup-"));
  const configPath = path.join(directory, "conductor.json");
  await writeFile(configPath, "{", { mode: 0o600 });

  await assert.rejects(loadStartup(["--config", configPath], {}), /missing_linear_token/u);
  await assert.rejects(
    loadStartup(["--config", configPath], { ...secrets, SYMPHONY_LINEAR_TOKEN: " secret-with-spaces " }),
    /invalid_linear_token/u,
  );
  await assert.rejects(
    loadStartup(["--config", configPath], { ...secrets, SYMPHONY_LINEAR_TOKEN: "secret-value" }),
    (error: unknown) => error instanceof Error
      && error.message === "invalid_startup_config"
      && !error.message.includes("secret-value"),
  );
});

test("startup requires explicit external Linear safety attestations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-startup-"));
  const configPath = path.join(directory, "conductor.json");
  await writeFile(configPath, JSON.stringify(config(directory)), { mode: 0o600 });

  for (const name of [
    "SYMPHONY_LINEAR_EXCLUSIVE_MUTATION_ACTOR",
    "SYMPHONY_LINEAR_MANAGED_DESTRUCTION_PROHIBITED",
    "SYMPHONY_LINEAR_RELATION_PROVENANCE_AUDITED",
  ]) {
    const incomplete = { ...secrets, [name]: "" };
    await assert.rejects(
      loadStartup(["--config", configPath], incomplete),
      /unsupported_linear_provider_capability/u,
    );
  }
});
