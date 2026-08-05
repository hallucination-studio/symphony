import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryLinearGateway } from "./InMemoryLinearGateway.js";
import { ensureLinearWorkflow, resolveLinearWorkflow } from "./LinearWorkflow.js";

const canonicalStates = [
  { id: "state-todo", name: "Todo", type: "unstarted" as const, team_id: "team-id" },
  { id: "state-progress", name: "In Progress", type: "started" as const, team_id: "team-id" },
  { id: "state-review", name: "In Review", type: "started" as const, team_id: "team-id" },
  { id: "state-done", name: "Done", type: "completed" as const, team_id: "team-id" },
  { id: "state-canceled", name: "Canceled", type: "canceled" as const, team_id: "team-id" },
];

test("workflow resolution selects exact canonical names and types", () => {
  assert.deepEqual(resolveLinearWorkflow("team-id", [
    ...canonicalStates,
    { id: "state-custom-started", name: "Provider Active", type: "started", team_id: "team-id" },
    { id: "state-custom-future", name: "Provider Extension", type: "future_type", team_id: "team-id" },
  ]), {
    team_id: "team-id",
    todo_status_id: "state-todo",
    in_progress_status_id: "state-progress",
    in_review_status_id: "state-review",
    done_status_id: "state-done",
    canceled_status_id: "state-canceled",
  });
});

test("workflow resolution fails closed on missing, duplicate, wrong-type, or foreign canonical states", () => {
  assert.throws(
    () => resolveLinearWorkflow("team-id", canonicalStates.slice(0, 4)),
    /linear_workflow_state_missing/u,
  );
  assert.throws(
    () => resolveLinearWorkflow("team-id", [
      ...canonicalStates,
      { ...canonicalStates[0]!, id: "state-todo-2" },
    ]),
    /linear_workflow_state_duplicated/u,
  );
  assert.throws(
    () => resolveLinearWorkflow("team-id", canonicalStates.map((state) => (
      state.name === "In Review" ? { ...state, type: "completed" } : state
    ))),
    /linear_workflow_state_type_mismatch/u,
  );
  assert.throws(
    () => resolveLinearWorkflow("team-id", canonicalStates.map((state) => (
      state.name === "Todo" ? { ...state, team_id: "other-team" } : state
    ))),
    /linear_workflow_team_mismatch/u,
  );
});

test("workflow ensure creates only missing canonical states and ignores provider extensions", async () => {
  const gateway = new InMemoryLinearGateway({
    states: [
      canonicalStates[0]!, canonicalStates[1]!, canonicalStates[3]!, canonicalStates[4]!,
      { id: "state-custom", name: "Provider Active", type: "started", team_id: "team-id" },
    ],
  });

  const workflow = await ensureLinearWorkflow("team-id", gateway);

  assert.equal(workflow.todo_status_id, "state-todo");
  assert.equal(workflow.in_progress_status_id, "state-progress");
  assert.match(workflow.in_review_status_id, /^fake-state-/u);
  assert.equal(workflow.done_status_id, "state-done");
  assert.equal(workflow.canceled_status_id, "state-canceled");
  assert.equal((await gateway.list_team_states("team-id")).filter(({ name }) => name === "In Review").length, 1);
  assert.equal((await gateway.list_team_states("team-id")).filter(({ name }) => name === "Provider Active").length, 1);
});

test("workflow ensure fails before creation when a canonical name has the wrong type", async () => {
  const gateway = new InMemoryLinearGateway({
    states: canonicalStates.map((state) => state.name === "In Review"
      ? { ...state, type: "completed" }
      : state),
  });

  await assert.rejects(ensureLinearWorkflow("team-id", gateway), /linear_workflow_state_type_mismatch/u);
  assert.equal((await gateway.list_team_states("team-id")).length, canonicalStates.length);
});
