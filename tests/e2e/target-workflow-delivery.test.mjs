import assert from "node:assert/strict";
import test from "node:test";

import { runTargetDeliveryScenario } from "../../tools/e2e/target-workflow-delivery.mjs";

test("target delivery waits for a read-back matching the immutable Verify revision", async () => {
  let reads = 0;
  const result = await runTargetDeliveryScenario({
    runner: {
      async observeRoot(input) {
        reads += 1;
        assert.equal(input.rootIssueId, "root-1");
        return { facts: reads === 1 ? { root: { rootIssueId: "root-1", projectId: "project-1" } } : {
          root: { rootIssueId: "root-1", projectId: "project-1" },
          delivery: { kind: "local_branch", branch: "symphony/runs/root-1", head: "a".repeat(40), verifiedAgainst: "verify-1", readBack: true },
        } };
      },
    },
    rootIssueId: "root-1",
    projectId: "project-1",
    verifyIssueId: "verify-1",
    verifiedRevision: "a".repeat(40),
    deliveryBranch: "symphony/runs/root-1",
    observationInput: { git: { head: "a".repeat(40), branch: "main" } },
    timeoutMs: 10,
    pollIntervalMs: 0,
  });

  assert.deepEqual(result, {
    delivery: { kind: "local_branch", branch: "symphony/runs/root-1", head: "a".repeat(40), verifiedAgainst: "verify-1", readBack: true },
  });
  assert.equal(reads, 2);
});

test("target delivery rejects a different revision", async () => {
  await assert.rejects(
    runTargetDeliveryScenario({
      runner: { async observeRoot() { return { facts: {
        root: { rootIssueId: "root-1", projectId: "project-1" },
        delivery: { kind: "local_branch", branch: "symphony/runs/root-1", head: "b".repeat(40), verifiedAgainst: "verify-1", readBack: true },
      } }; } },
      rootIssueId: "root-1", projectId: "project-1", verifyIssueId: "verify-1", verifiedRevision: "a".repeat(40),
      deliveryBranch: "symphony/runs/root-1", observationInput: { git: { head: "a".repeat(40), branch: "main" } },
      timeoutMs: 10, pollIntervalMs: 0,
    }),
    /target_delivery_revision_mismatch/u,
  );
});
