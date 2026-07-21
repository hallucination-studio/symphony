import assert from "node:assert/strict";
import test from "node:test";

import { runTargetSchedulingScenario } from "../../tools/e2e/target-workflow-scheduling.mjs";

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
