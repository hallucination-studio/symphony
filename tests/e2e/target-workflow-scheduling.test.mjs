import assert from "node:assert/strict";
import test from "node:test";

import { runTargetSchedulingScenario } from "../../tools/e2e/target-workflow-scheduling.mjs";
import { readTargetSchedulingEvidence } from "../../tools/e2e/target-workflow-scheduling-live.mjs";
import { LinearRunBudgetImpl } from "@symphony/podium";

test("target scheduling accepts bounded blocker-aware single-writer evidence", async () => {
  const result = await runTargetSchedulingScenario({
    readScheduling: async () => ({
      selectedRootIds: ["root-1"], waitingRootIds: ["root-2"], maxConcurrentRoots: 1, blockerRespected: true,
    }),
  });
  assert.deepEqual(result, {
    selectedRootIds: ["root-1"], waitingRootIds: ["root-2"], maxConcurrentRoots: 1, blockerRespected: true,
  });
});

test("target scheduling rejects a selected Root whose blocker is unresolved", async () => {
  await assert.rejects(
    runTargetSchedulingScenario({
      readScheduling: async () => ({
        selectedRootIds: ["root-1"], waitingRootIds: ["root-2"], maxConcurrentRoots: 1, blockerRespected: false,
      }),
    }),
    /target_scheduling_evidence_invalid/u,
  );
});

test("target scheduling reader derives the single writer from Linear priority and blockers", async () => {
  const budget = new LinearRunBudgetImpl();
  const result = await readTargetSchedulingEvidence({
    developmentToken: "linear-secret",
    projectId: "project-1",
    delegateActorId: "actor-1",
    linearRunBudget: budget,
    fetch: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.operationName, "TargetWorkflowSchedulingRoots");
      return response({ data: { project: {
        id: "project-1",
        issues: {
          nodes: [
            root("root-urgent", 1, 1, "In Progress", []),
            root("root-blocked", 2, 2, "Todo", [blocks("root-blocker", "In Progress")]),
            root("root-low", 4, 3, "Todo", []),
          ],
          pageInfo: { hasNextPage: false },
        },
      } } });
    },
  });

  assert.deepEqual(result, {
    selectedRootIds: ["root-urgent"],
    waitingRootIds: ["root-blocked", "root-low"],
    maxConcurrentRoots: 1,
    blockerRespected: true,
  });
  assert.equal(budget.snapshot().physicalRequests, 1);
});

function root(id, priority, sortOrder, state, relations) {
  return {
    id,
    identifier: id.toUpperCase(),
    title: id,
    description: "",
    priority,
    sortOrder,
    updatedAt: "2026-07-22T00:00:00Z",
    project: { id: "project-1" },
    parent: null,
    delegate: { id: "actor-1" },
    state: { name: state },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: relations, pageInfo: { hasNextPage: false } },
  };
}

function blocks(id, state) {
  return {
    type: "blocks",
    issue: { id, state: { name: state }, project: { id: "project-1" } },
    relatedIssue: { id: "root-blocked", project: { id: "project-1" } },
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
