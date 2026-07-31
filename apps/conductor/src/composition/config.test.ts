import assert from "node:assert/strict";
import test from "node:test";

import { parseConductorConfig } from "./config.js";

const config = {
  linear_team_id: "team:1",
  agent_actor_id: "actor:agent",
  polling_interval_ms: 1_000,
  program_data_path: "/var/lib/symphony",
  performer_home: "/Users/example/.codex",
  codex_executable: "/usr/local/bin/codex",
  delivery_provider_endpoint: "https://api.github.example",
  root_states: {
    todo: "state:root:todo",
    in_progress: "state:root:in-progress",
    in_review: "state:root:in-review",
    done: "state:root:done",
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
  permission_policy: {
    managedMcpDenyAll: true,
    managedRemoteControlDisabled: true,
    remoteEnvironmentsAbsent: true,
    configurationImmutable: true,
  },
  root_routing: [
    { root_id: "LIN-1", repository_id: "repo:1", repository_path: "/srv/repo", base_branch: "main" },
  ],
};

test("configuration accepts only approved static integration fields", () => {
  assert.equal(parseConductorConfig(config).root_routing[0]?.repository_id, "repo:1");
  for (const secretKey of ["token", "api_key", "client_secret", "profile"]) {
    assert.throws(() => parseConductorConfig({ ...config, [secretKey]: "do-not-log" }), /invalid_contract_keys/u);
  }
  assert.throws(() => parseConductorConfig({ ...config, root_routing: [] }), /invalid_root_routing/u);
});

test("configuration fails closed when status, capability, or permission policy is missing or incomplete", () => {
  const without = (key: keyof typeof config) => Object.fromEntries(
    Object.entries(config).filter(([entry]) => entry !== key),
  );

  assert.throws(() => parseConductorConfig(without("root_states")), /invalid_contract_keys/u);
  assert.throws(() => parseConductorConfig(without("root_capabilities")), /invalid_contract_keys/u);
  assert.throws(() => parseConductorConfig(without("permission_policy")), /invalid_contract_keys/u);
  assert.throws(() => parseConductorConfig({
    ...config,
    root_capabilities: config.root_capabilities.slice(1),
  }), /invalid_root_capabilities/u);
  assert.throws(() => parseConductorConfig({
    ...config,
    permission_policy: { ...config.permission_policy, managedMcpDenyAll: false },
  }), /invalid_permission_policy/u);
  assert.throws(() => parseConductorConfig({
    ...config,
    root_states: { ...config.root_states, done: config.root_states.todo },
  }), /duplicate_root_state_identity/u);
});
