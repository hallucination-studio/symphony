import assert from "node:assert/strict";
import test from "node:test";

import { parseStageHandoff, parseStageRequest } from "./stage-interaction.js";

const envelope = {
  schema_version: 1, root_id: "LIN-1", runtime_generation: 1,
  correlation_id: "corr:1", cycle_issue_id: "LIN-2",
};

test("role-specific Handoffs expose only closed outcomes", () => {
  const plan = parseStageHandoff({
    ...envelope, role: "plan", plan_issue_id: "LIN-3", work_issue_ids: ["LIN-4"],
    verify_issue_id: "LIN-5", outcome: "completed",
  });
  assert.equal(plan.role, "plan");
  assert.throws(() => parseStageHandoff({
    ...envelope, role: "work", work_issue_id: "LIN-4", outcome: "partial", workspace_changed: true,
  }), /invalid_contract_variant/u);
  assert.throws(() => parseStageHandoff({
    ...envelope, role: "work", work_issue_id: "LIN-4", outcome: "completed",
    workspace_changed: true, session: {},
  }), /invalid_contract_keys/u);
});

test("Plan request targets the empty Cycle and does not invent a Plan identity", () => {
  assert.deepEqual(parseStageRequest({ ...envelope, role: "plan" }), { ...envelope, role: "plan" });
  assert.throws(() => parseStageRequest({
    ...envelope, role: "plan", plan_issue_id: "LIN-3",
  }), /invalid_contract_keys/u);
});
