import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeSameConductorPreemptionCampaignEvidence,
  assessSameConductorPreemptionEvidence,
} from "../../tools/e2e/same-conductor-preemption-evidence.mjs";
import { executeHumanScript } from "../../tools/e2e/human-scripts.mjs";
import { sameConductorPreemptionRow } from "./same-conductor-preemption-fixture.mjs";

test("preempt_same_priority waits for an in-flight Stage before the Human updates the competing Root", async () => {
  const calls = [];
  await executeHumanScript({
    humanScript: { id: "preempt_same_priority" },
    caseRoots: { root_issue_ids: ["root-inflight", "root-updated"] },
    human: {
      async updateRoot(input) { calls.push(input); },
    },
    async waitForInFlightStage(input) {
      assert.deepEqual(input, { root_issue_id: "root-inflight" });
      return { stage_execution_id: "execution-inflight" };
    },
  });

  assert.deepEqual(calls, [{
    root_issue_id: "root-updated",
    description: "Please run this Root next.",
  }]);
});

test("same-Conductor preemption evidence proves the updated Root wins the next admission boundary", () => {
  const row = sameConductorPreemptionRow();

  assert.deepEqual(assessSameConductorPreemptionEvidence(row), {
    kind: "satisfied",
    reason_code: "same_conductor_preemption_confirmed",
  });
});

test("same-Conductor preemption evidence rejects an ownership mismatch", () => {
  const row = sameConductorPreemptionRow();
  row.snapshot.root_trees[1].managed_blocks.find(({ record }) => record.kind === "root_ownership").record.conductor_id = "conductor-b";

  assert.deepEqual(assessSameConductorPreemptionEvidence(row), {
    kind: "violated",
    reason_code: "same_conductor_preemption_ownership_mismatch",
  });
});

test("same-Conductor preemption evidence rejects a non-Human update", () => {
  const row = sameConductorPreemptionRow();
  row.snapshot.root_trees[1].activity[0].history[0].actor_id = "symphony-actor";

  assert.deepEqual(assessSameConductorPreemptionEvidence(row), {
    kind: "violated",
    reason_code: "same_conductor_preemption_update_not_human",
  });
});

test("same-Conductor preemption ignores an earlier completed Stage when identifying the in-flight turn", () => {
  const row = sameConductorPreemptionRow();
  const tree = row.snapshot.root_trees[0];
  const originalExecution = tree.managed_blocks.find(({ record }) => record.kind === "stage_execution");
  const originalResult = tree.managed_blocks.find(({ record }) => record.kind === "stage_result");
  const earlierExecution = structuredClone(originalExecution);
  earlierExecution.source_id = "comment-stage_execution-execution-earlier";
  earlierExecution.record.stage_execution_id = "execution-earlier";
  earlierExecution.record.started_at = "2026-07-25T00:00:00.500Z";
  const earlierResult = structuredClone(originalResult);
  earlierResult.source_id = "comment-stage_result-result-earlier";
  earlierResult.record.result_id = "result-earlier";
  earlierResult.record.completed_at = "2026-07-25T00:00:01.500Z";
  earlierResult.record.model_turn.turn_record_id = "execution-earlier:plan-turn-a";
  earlierResult.record.model_turn.stage_execution_id = "execution-earlier";
  earlierResult.record.model_turn.terminal_at = "2026-07-25T00:00:01.500Z";
  tree.managed_blocks.push(earlierExecution, earlierResult);
  tree.comments.push(
    { comment_id: earlierExecution.source_id, issue_id: earlierExecution.issue_id },
    { comment_id: earlierResult.source_id, issue_id: earlierResult.issue_id },
  );

  assert.deepEqual(assessSameConductorPreemptionEvidence(row), {
    kind: "satisfied",
    reason_code: "same_conductor_preemption_confirmed",
  });
});

test("same-Conductor preemption uses the first candidate Stage after the Human update", () => {
  const row = sameConductorPreemptionRow();
  const tree = row.snapshot.root_trees[1];
  const original = tree.managed_blocks.find(({ record }) => record.kind === "stage_execution");
  const later = structuredClone(original);
  later.source_id = "comment-stage_execution-execution-later";
  later.record.stage_execution_id = "execution-later";
  later.record.started_at = "2026-07-25T00:00:05.000Z";
  tree.managed_blocks.push(later);
  tree.comments.push({ comment_id: later.source_id, issue_id: later.issue_id });

  assert.deepEqual(assessSameConductorPreemptionEvidence(row), {
    kind: "satisfied",
    reason_code: "same_conductor_preemption_confirmed",
  });
});

test("same-Conductor preemption evidence is inconclusive when the first candidate Stage timestamp is tied", () => {
  const row = sameConductorPreemptionRow();
  const tree = row.snapshot.root_trees[1];
  const original = tree.managed_blocks.find(({ record }) => record.kind === "stage_execution");
  const tied = structuredClone(original);
  tied.source_id = "comment-stage_execution-execution-tied";
  tied.record.stage_execution_id = "execution-tied";
  tree.managed_blocks.push(tied);
  tree.comments.push({ comment_id: tied.source_id, issue_id: tied.issue_id });

  assert.deepEqual(assessSameConductorPreemptionEvidence(row), {
    kind: "inconclusive",
    reason_code: "same_conductor_preemption_candidate_stage_ambiguous",
  });
});

test("same-Conductor preemption evidence rejects a candidate Stage that began before the in-flight turn completed", () => {
  const row = sameConductorPreemptionRow();
  const candidateExecution = row.snapshot.root_trees[1].managed_blocks.find(({ record }) => record.kind === "stage_execution");
  candidateExecution.record.started_at = "2026-07-25T00:00:02.500Z";

  assert.deepEqual(assessSameConductorPreemptionEvidence(row), {
    kind: "violated",
    reason_code: "same_conductor_preemption_boundary_invalid",
  });
});

test("same-Conductor preemption campaign evidence ignores Cases owned by another predicate", () => {
  const row = sameConductorPreemptionRow();
  row.e2eCase.evidence_predicate_id = "happy_path";

  assert.deepEqual(analyzeSameConductorPreemptionCampaignEvidence({ rows: [row] }), {
    case_outcomes: [],
  });
});
