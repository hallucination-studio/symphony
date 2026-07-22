import assert from "node:assert/strict";
import test from "node:test";

import { inspectTargetWorkflowCatalog } from "../dist/public/index.js";

function canonicalStates() {
  return [
    ["todo-1", "Todo", "unstarted"],
    ["draft-1", "Draft", "backlog"],
    ["planning-1", "Planning", "started"],
    ["sealed-1", "Sealed", "started"],
    ["executing-1", "Executing", "started"],
    ["verifying-1", "Verifying", "started"],
    ["progress-1", "In Progress", "started"],
    ["review-1", "In Review", "started"],
    ["approval-1", "Needs Approval", "started"],
    ["info-1", "Needs Info", "started"],
    ["inconclusive-1", "Inconclusive", "started"],
    ["escalated-1", "Escalated", "started"],
    ["succeeded-1", "Succeeded", "completed"],
    ["changes-1", "Changes Required", "completed"],
    ["done-1", "Done", "completed"],
    ["canceled-1", "Canceled", "canceled"],
    ["failed-1", "Failed", "canceled"],
  ].map(([id, name, type], position) => ({ id, name, type, position }));
}

test("target workflow catalog accepts canonical states plus native Duplicate", () => {
  const result = inspectTargetWorkflowCatalog([
    ...canonicalStates(),
    { id: "duplicate-1", name: "Duplicate", type: "duplicate", position: 18 },
  ]);

  assert.equal(result.kind, "complete");
  assert.deepEqual(result.canonicalStatuses.map(({ name }) => name), [
    "Draft", "Todo", "Planning", "Sealed", "Executing", "Verifying",
    "In Progress", "In Review", "Needs Approval", "Needs Info", "Inconclusive",
    "Escalated", "Succeeded", "Changes Required", "Done", "Canceled", "Failed",
  ]);
  assert.deepEqual(result.nativeDuplicate, {
    statusId: "duplicate-1", name: "Duplicate", category: "canceled", position: 18,
  });
});

test("target workflow catalog rejects Duplicate repurposed as Failed", () => {
  const states = canonicalStates().filter(({ name }) => name !== "Failed");
  states.push({ id: "duplicate-1", name: "Failed", type: "duplicate", position: 18 });

  assert.deepEqual(inspectTargetWorkflowCatalog(states), {
    kind: "incomplete", reason: "native_duplicate_invalid",
  });
});

test("target workflow catalog rejects non-native extra states", () => {
  const result = inspectTargetWorkflowCatalog([
    ...canonicalStates(),
    { id: "duplicate-1", name: "Duplicate", type: "duplicate" },
    { id: "extra-1", name: "Backlog", type: "backlog" },
  ]);

  assert.deepEqual(result, {
    kind: "incomplete", reason: "unexpected_status",
  });
});

test("target workflow catalog reports missing canonical states", () => {
  const states = canonicalStates().filter(({ name }) => name !== "Failed");
  states.push({ id: "duplicate-1", name: "Duplicate", type: "duplicate" });

  assert.deepEqual(inspectTargetWorkflowCatalog(states), {
    kind: "incomplete", reason: "canonical_status_missing",
  });
});
