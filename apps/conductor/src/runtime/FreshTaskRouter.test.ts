import assert from "node:assert/strict";
import test from "node:test";

import { parseTaskIssueId } from "../contracts/identity.js";
import { parseTaskSnapshot, type ConcreteTaskChange } from "../contracts/observation.js";
import { parseTaskWorkflowIdentities } from "../task-management/api/TaskManageCapability.js";
import { routeFreshTask } from "./FreshTaskRouter.js";

const workflow = parseTaskWorkflowIdentities({
  labels: {
    root: "label:root", cycle: "label:cycle", plan: "label:plan", work: "label:work", verify: "label:verify",
  },
  cycle_states: {
    draft: "cycle:draft",
    in_progress: "cycle:in-progress",
    awaiting_acceptance: "cycle:awaiting",
    succeeded: "cycle:succeeded",
    rejected: "cycle:rejected",
    failed: "cycle:failed",
    canceled: "cycle:canceled",
  },
  stage_states: {
    todo: "stage:todo",
    in_progress: "stage:in-progress",
    done: "stage:done",
    failed: "stage:failed",
    canceled: "stage:canceled",
  },
});

const rootStates = {
  todo: "root:todo",
  in_progress: "root:in-progress",
  in_review: "root:in-review",
  done: "root:done",
} as const;

function task(cycles: readonly (keyof typeof workflow.cycle_states)[], options: {
  readonly delegated?: boolean;
  readonly rootStatus?: string;
} = {}) {
  return parseTaskSnapshot({
    root_id: "root-1",
    issues: [{
      issue_id: "root-1",
      revision: "revision:root:1",
      status: options.rootStatus ?? rootStates.in_progress,
      title: "Root",
      description: null,
      parent_id: null,
      labels: [workflow.labels.root],
      delegate_id: options.delegated === false ? null : "actor:agent",
      priority: 1,
    }, ...cycles.map((status, index) => ({
      issue_id: `cycle-${index + 1}`,
      revision: `revision:cycle:${index + 1}`,
      status: workflow.cycle_states[status],
      title: `Cycle ${index + 1}`,
      description: null,
      parent_id: "root-1",
      labels: [workflow.labels.cycle],
      delegate_id: null,
      priority: null,
    }))],
    relations: [],
  });
}

function route(
  cycles: readonly (keyof typeof workflow.cycle_states)[],
  options: Parameters<typeof task>[1] = {},
  changes: readonly ConcreteTaskChange[] = [],
  origins: Parameters<typeof routeFreshTask>[0]["task_change_origins"] = [],
) {
  return routeFreshTask({
    task: task(cycles, options),
    task_changes: changes,
    task_change_origins: origins,
    agent_actor_id: "actor:agent",
    root_states: rootStates,
    workflow,
  });
}

test("bounded origin routes external Root edits at least once without treating service writes as external", () => {
  const external = route(["in_progress"], {}, [], [{
    issue_id: parseTaskIssueId("root-1"),
    change_origin: "external",
    changed_fields: ["title"],
  }]);
  assert.equal(external.matches.some(({ route_id }) => route_id === "WF-ROUTE-005"), true);
  assert.equal(external.selected.route_id, "WF-ROUTE-005");

  const symphony = route(["in_progress"], {}, [], [{
    issue_id: parseTaskIssueId("root-1"),
    change_origin: "symphony",
    changed_fields: ["title"],
  }]);
  assert.equal(symphony.matches.some(({ route_id }) => route_id === "WF-ROUTE-005"), false);
});

test("unknown sealed-subtree origin fails closed while service writeback remains mechanical", () => {
  const stageChange: ConcreteTaskChange = {
    kind: "field_changed",
    issue_id: parseTaskIssueId("stage-1"),
    field: "description",
    before: "before",
    after: "after",
  };
  const taskWithStage = parseTaskSnapshot({
    ...task(["in_progress"]),
    issues: [...task(["in_progress"]).issues, {
      issue_id: "stage-1", revision: "revision:stage:1", status: workflow.stage_states.in_progress,
      title: "Stage", description: "after", parent_id: "cycle-1", labels: [workflow.labels.work],
      delegate_id: null, priority: null,
    }],
  });
  const input = {
    task: taskWithStage,
    task_changes: [stageChange],
    agent_actor_id: "actor:agent",
    root_states: rootStates,
    workflow,
  } as const;
  assert.equal(routeFreshTask({ ...input, task_change_origins: [{
    issue_id: parseTaskIssueId("stage-1"), change_origin: "unknown", changed_fields: ["description"],
  }] }).selected.route_id, "WF-ROUTE-006");
  assert.equal(routeFreshTask({ ...input, task_change_origins: [{
    issue_id: parseTaskIssueId("stage-1"), change_origin: "symphony", changed_fields: ["description"],
  }] }).matches.some(({ route_id }) => route_id === "WF-ROUTE-006"), false);
});

test("routing evaluates all rows and selects the unique lowest numeric priority", () => {
  const rootEdit: ConcreteTaskChange = {
    kind: "field_changed",
    issue_id: parseTaskIssueId("root-1"),
    field: "title",
    before: "Before",
    after: "After",
  };
  const cycleWrite: ConcreteTaskChange = {
    kind: "field_changed",
    issue_id: parseTaskIssueId("cycle-1"),
    field: "description",
    before: "Before",
    after: "After",
  };
  const selected = route(["in_progress"], {}, [rootEdit, cycleWrite], [{
    issue_id: parseTaskIssueId("root-1"), change_origin: "external", changed_fields: ["title"],
  }, {
    issue_id: parseTaskIssueId("cycle-1"), change_origin: "symphony", changed_fields: ["description"],
  }]);

  assert.deepEqual(selected.matches.map(({ route_id, priority }) => [route_id, priority]), [
    ["WF-ROUTE-004", 80],
    ["WF-ROUTE-005", 130],
  ]);
  assert.equal(selected.selected.route_id, "WF-ROUTE-004");
  assert.equal(selected.selected.consumer, "cycle_machine");
});

test("family overlap and admission loss outrank ordinary mechanics without selecting Root", () => {
  const family = route(["draft", "in_progress"]);
  assert.equal(family.selected.route_id, "WF-ROUTE-009");
  assert.equal(family.selected.consumer, "family_guard");
  assert.equal(family.selected.cycle_id, null);

  const admission = route(["in_progress"], { delegated: false });
  assert.deepEqual(admission.matches.map(({ route_id }) => route_id), ["WF-ROUTE-015", "WF-ROUTE-004"]);
  assert.equal(admission.selected.route_id, "WF-ROUTE-015");
  assert.equal(admission.selected.consumer, "cycle_machine");
});

test("fresh boundary states and park have deterministic owners", () => {
  assert.equal(route([]).selected.route_id, "WF-ROUTE-001");
  assert.equal(route(["draft"]).selected.route_id, "WF-ROUTE-002");
  assert.equal(route(["awaiting_acceptance"]).selected.route_id, "WF-ROUTE-007");
  assert.equal(route(["succeeded"]).selected.route_id, "WF-ROUTE-008");
  assert.equal(route([], { delegated: false }).selected.route_id, "WF-ROUTE-014");
});
