import assert from "node:assert/strict";
import test from "node:test";

import { parseTaskIssueId } from "../contracts/identity.js";
import type { ConcreteTaskChange } from "../contracts/observation.js";
import { canonicalTaskRevision, parseTaskSnapshot, type TaskIssueSnapshot } from "../contracts/task-management.js";
import { parseTaskWorkflowIdentities } from "../task-management/api/TaskManageCapability.js";
import { routeFreshTask } from "./FreshTaskRouter.js";

const workflow = parseTaskWorkflowIdentities({
  labels: {
    root: "label:root", cycle: "label:cycle", plan: "label:plan", work: "label:work", verify: "label:verify",
  },
  cycle_states: {
    draft: "cycle:draft",
    in_progress: "root:in-progress",
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

const states = {
  team_id: "team:router", revision: `symphony:v1:${"0".repeat(64)}`,
  todo_state_id: rootStates.todo, draft_state_id: workflow.cycle_states.draft,
  in_progress_state_id: rootStates.in_progress, awaiting_acceptance_state_id: workflow.cycle_states.awaiting_acceptance,
  in_review_state_id: rootStates.in_review, done_state_id: rootStates.done,
  succeeded_state_id: workflow.cycle_states.succeeded, rejected_state_id: workflow.cycle_states.rejected,
  failed_state_id: workflow.cycle_states.failed, canceled_state_id: workflow.cycle_states.canceled,
} as const;

function canonicalIssue(input: {
  readonly issue_id: string; readonly kind: TaskIssueSnapshot["kind"];
  readonly status_id: string; readonly status: TaskIssueSnapshot["status"];
  readonly title: string; readonly description_markdown: string;
  readonly parent_issue_id: string | null; readonly label_ids: readonly string[];
  readonly delegate_id: string | null; readonly priority: number | null;
}) {
  const fields = {
    ...input, provider_created_at: "2026-08-03T00:00:00.000Z",
    provider_updated_at: "2026-08-03T00:00:00.000Z", creation_actor_id: "actor:agent",
    archived: false, trashed: false,
  };
  return { ...fields, revision: canonicalTaskRevision(fields) };
}

function cycleStatus(status: keyof typeof workflow.cycle_states): TaskIssueSnapshot["status"] {
  return status === "draft" ? "Draft" : status === "in_progress" ? "In Progress"
    : status === "awaiting_acceptance" ? "Awaiting Acceptance" : status === "succeeded" ? "Succeeded"
      : status === "rejected" ? "Rejected" : status === "failed" ? "Failed" : "Canceled";
}

function task(cycles: readonly (keyof typeof workflow.cycle_states)[], options: {
  readonly delegated?: boolean;
  readonly rootStatus?: string;
} = {}) {
  return parseTaskSnapshot({
    root_id: "root-1",
    workflow_state_map: states,
    issues: [canonicalIssue({
      issue_id: "root-1",
      kind: "root", status_id: options.rootStatus ?? rootStates.in_progress,
      status: options.rootStatus === rootStates.done ? "Done" : options.rootStatus === rootStates.in_review ? "In Review" : options.rootStatus === rootStates.todo ? "Todo" : "In Progress",
      title: "Root",
      description_markdown: "# Root", parent_issue_id: null, label_ids: [workflow.labels.root],
      delegate_id: options.delegated === false ? null : "actor:agent",
      priority: 1,
    }), ...cycles.map((status, index) => canonicalIssue({
      issue_id: `cycle-${index + 1}`,
      kind: "cycle", status_id: workflow.cycle_states[status], status: cycleStatus(status),
      title: `Cycle ${index + 1}`,
      description_markdown: "# Cycle", parent_issue_id: "root-1", label_ids: [workflow.labels.cycle],
      delegate_id: null,
      priority: null,
    }))],
    relations: [],
    resource_creation_evidence: [], issue_history: [], issue_record_observations: [],
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
    issues: [...task(["in_progress"]).issues, canonicalIssue({
      issue_id: "stage-1", kind: "work", status_id: states.in_progress_state_id, status: "In Progress",
      title: "Stage", description_markdown: "after", parent_issue_id: "cycle-1", label_ids: [workflow.labels.work],
      delegate_id: null, priority: null,
    })],
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
