import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeCycleSuccessorCampaignEvidence,
  assessCycleSuccessorEvidence,
} from "../../tools/e2e/cycle-successor-evidence.mjs";
import { cycleSuccessorRow } from "./cycle-successor-fixture.mjs";

test("Cycle exhaustion evidence proves the durable exhausted predecessor and fresh successor Plan", () => {
  assert.deepEqual(assessCycleSuccessorEvidence(cycleSuccessorRow()), {
    kind: "satisfied",
    reason_code: "cycle_successor_confirmed",
  });
});

test("Cycle exhaustion evidence remains incomplete without the predecessor Finding", () => {
  const row = cycleSuccessorRow();
  const tree = row.snapshot.root_trees[0];
  const index = tree.managed_blocks.findIndex(({ record }) => record.kind === "finding");
  tree.managed_blocks.splice(index, 1);

  assert.deepEqual(assessCycleSuccessorEvidence(row), {
    kind: "inconclusive",
    reason_code: "cycle_successor_finding_missing",
  });
});

test("Cycle exhaustion evidence rejects a successor without the native predecessor relation", () => {
  const row = cycleSuccessorRow();
  row.snapshot.root_trees[0].relations = [];

  assert.deepEqual(assessCycleSuccessorEvidence(row), {
    kind: "violated",
    reason_code: "cycle_successor_predecessor_relation_missing",
  });
});

test("Cycle exhaustion evidence rejects a convergence record that omits the open predecessor Finding", () => {
  const row = cycleSuccessorRow();
  const convergence = row.snapshot.root_trees[0].managed_blocks.find(({ record }) => record.kind === "convergence").record;
  convergence.view.open_finding_persistence = [];

  assert.deepEqual(assessCycleSuccessorEvidence(row), {
    kind: "violated",
    reason_code: "cycle_successor_convergence_mismatch",
  });
});

test("Cycle exhaustion evidence rejects a successor that reuses the predecessor Plan Contract", () => {
  const row = cycleSuccessorRow();
  const records = row.snapshot.root_trees[0].managed_blocks
    .filter(({ record }) => record.kind === "plan_contract");
  const predecessorDigest = records[0].record.plan_contract_digest;
  records[1].record.plan_contract_digest = predecessorDigest;
  const successorPlanResult = row.snapshot.root_trees[0].managed_blocks.find(({ record }) =>
    record.kind === "stage_result" && record.node_issue_id === "plan-cycle-exhaustion-successor",
  ).record;
  successorPlanResult.plan_contract_digest = predecessorDigest;

  assert.deepEqual(assessCycleSuccessorEvidence(row), {
    kind: "violated",
    reason_code: "cycle_successor_plan_not_fresh",
  });
});

test("Cycle successor campaign evidence ignores another predicate", () => {
  const row = cycleSuccessorRow();
  row.e2eCase.evidence_predicate_id = "happy_path";

  assert.deepEqual(analyzeCycleSuccessorCampaignEvidence({ rows: [row] }), {
    case_outcomes: [],
  });
});
