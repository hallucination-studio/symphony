import assert from "node:assert/strict";
import test from "node:test";

import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateOpenFindingPersistencePolicyImpl } from "../internal/RootStateOpenFindingPersistencePolicyImpl.js";
import { RootStateRepeatedFindingExhaustedCycleCompilerImpl } from "../internal/RootStateRepeatedFindingExhaustedCycleCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";
import { repeatedFindingState } from "./root-state-repeated-finding-fixture.js";

const conclusion = [
  "# Recovery Conclusion", "", "The same open Finding persisted through the configured Cycle limit.", "",
  "## Outcome", "", "recovery_exhausted",
].join("\n");

function compiler() {
  return new RootStateRepeatedFindingExhaustedCycleCompilerImpl(
    new RootStateViewPolicyImpl(),
    new RootStateOpenFindingPersistencePolicyImpl(),
  );
}

test("concludes the exact active Cycle when a directed Finding lineage reaches the limit", () => {
  assert.deepEqual(compiler().compile({
    state: repeatedFindingState(), cycleIssueId: "cycle-2", findingIssueIds: ["finding-2"],
    maxSameOpenFindingCycles: 2, sessionFence: "closed",
  }), {
    kind: "effect",
    effect: {
      kind: "update_issue", issueId: "cycle-2", statusId: "status-canceled", title: "cycle-2",
      description: conclusion, labelNames: ["Recovery Exhausted", "symphony:kind/cycle"], order: 0,
    },
  });
});

test("requires the exact at-limit Finding set and a closed Stage fence", () => {
  const state = repeatedFindingState();
  assert.deepEqual(compiler().compile({
    state, cycleIssueId: "cycle-2", findingIssueIds: [], maxSameOpenFindingCycles: 2, sessionFence: "closed",
  }), { kind: "invalid_facts", reason: "topology_invalid" });
  assert.deepEqual(compiler().compile({
    state, cycleIssueId: "cycle-2", findingIssueIds: ["finding-2"], maxSameOpenFindingCycles: 2, sessionFence: "active",
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });
});

test("does not terminalize below the configured limit and is restart-equivalent", () => {
  const state = repeatedFindingState();
  assert.deepEqual(compiler().compile({
    state, cycleIssueId: "cycle-2", findingIssueIds: ["finding-2"], maxSameOpenFindingCycles: 3, sessionFence: "closed",
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });

  const restarted = structuredClone(state) as RecoveredRootState;
  restarted.observation.facts = [...restarted.observation.facts].reverse();
  const input = { cycleIssueId: "cycle-2", findingIssueIds: ["finding-2"], maxSameOpenFindingCycles: 2, sessionFence: "closed" as const };
  assert.deepEqual(compiler().compile({ state, ...input }), compiler().compile({ state: restarted, ...input }));
});
