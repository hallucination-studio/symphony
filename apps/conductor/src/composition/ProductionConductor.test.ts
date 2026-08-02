import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTaskWorkflowConfiguration,
  runProductionPoll,
  type ProductionPollTarget,
  type TaskWorkflowCatalog,
} from "./ProductionConductor.js";
import { parseConductorConfig } from "./config.js";

function config() {
  return parseConductorConfig({
    linear_team_id: "team:1",
    agent_actor_id: "actor:agent",
    polling_interval_ms: 1_000,
    program_data_path: "/var/lib/symphony",
    performer_home: "/Users/example/.codex",
    codex_executable: "/usr/local/bin/codex",
    delivery_provider_endpoint: "https://api.github.com",
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
    root_routing: [{
      root_id: "ROOT-1",
      repository_id: "repo:1",
      repository_path: "/srv/repo",
      base_branch: "main",
    }],
  });
}

const expectedCatalog = Object.freeze({
  states: Object.freeze([
    ["state:root:todo", "Todo", false],
    ["state:root:in-progress", "In Progress", false],
    ["state:root:in-review", "In Review", false],
    ["state:root:done", "Done", false],
    ["state:cycle:draft", "Draft", false],
    ["state:cycle:in-progress", "In Progress", false],
    ["state:cycle:awaiting-acceptance", "Awaiting Acceptance", false],
    ["state:cycle:succeeded", "Succeeded", false],
    ["state:cycle:rejected", "Rejected", false],
    ["state:cycle:failed", "Failed", false],
    ["state:cycle:canceled", "Canceled", false],
    ["state:stage:todo", "Todo", false],
    ["state:stage:in-progress", "In Progress", false],
    ["state:stage:done", "Done", false],
    ["state:stage:failed", "Failed", false],
    ["state:stage:canceled", "Canceled", false],
  ]),
  labels: Object.freeze([
    ["label:root", "symphony:kind/root"],
    ["label:cycle", "symphony:kind/cycle"],
    ["label:plan", "symphony:kind/plan"],
    ["label:work", "symphony:kind/work"],
    ["label:verify", "symphony:kind/verify"],
  ]),
} as const satisfies TaskWorkflowCatalog);

test("startup validates every configured status and kind identity against the fresh provider catalog", () => {
  assert.doesNotThrow(() => assertTaskWorkflowConfiguration(config(), expectedCatalog));
  assert.throws(() => assertTaskWorkflowConfiguration(config(), {
    ...expectedCatalog,
    states: expectedCatalog.states.filter(([identity]) => identity !== "state:cycle:draft"),
  }), /invalid_task_workflow_configuration/u);
  assert.throws(() => assertTaskWorkflowConfiguration(config(), {
    ...expectedCatalog,
    states: expectedCatalog.states.map(([identity, name, archived]) => (
      identity === "state:cycle:draft" ? [identity, name, true] as const : [identity, name, archived] as const
    )),
  }), /invalid_task_workflow_configuration/u);
  assert.throws(() => assertTaskWorkflowConfiguration(config(), {
    ...expectedCatalog,
    labels: expectedCatalog.labels.map(([identity, name]) => (
      identity === "label:verify" ? [identity, "symphony:kind/work"] as const : [identity, name] as const
    )),
  }), /invalid_task_workflow_configuration/u);
});

test("one production poll drains only the single serial scheduler and continues after one Root fails", async () => {
  const order: string[] = [];
  let active = 0;
  let maximum = 0;
  const events = Object.freeze([{ root_id: "ROOT-1" }, { root_id: "ROOT-2" }]);
  const results = [
    { kind: "cycle_action_completed", root_id: "ROOT-1", outcome: "advanced" },
    { kind: "failed", root_id: "ROOT-1", reason_code: "cycle_boundary_failed" },
    { kind: "turn_completed", root_id: "ROOT-2", outcome: "quiescent" },
    { kind: "idle" },
  ] as const;
  const target: ProductionPollTarget = {
    observer: {
      poll_once: async () => events as never,
    },
    scheduler: {
      admit: (input) => {
        assert.equal(input, events);
        order.push("admit");
      },
      runNext: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        try {
          const result = results[order.length - 1];
          order.push(result?.kind ?? "missing");
          return result as never;
        } finally {
          active -= 1;
        }
      },
    },
  };

  const result = await runProductionPoll(target);

  assert.deepEqual(result, { observations: 2, actions: 3, failures: 1 });
  assert.equal(maximum, 1);
  assert.deepEqual(order, [
    "admit",
    "cycle_action_completed",
    "failed",
    "turn_completed",
    "idle",
  ]);
});
