import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeHappyPathCampaignEvidence,
  assessApprovedHappyPathEvidence,
} from "../../tools/e2e/approved-happy-path-evidence.mjs";
import { executeHumanScript } from "../../tools/e2e/human-scripts.mjs";
import { happyPathRow } from "./approved-happy-path-fixture.mjs";

test("approve_plan resolves only the discovered Plan Review Action through the external Human Actor", async () => {
  const calls = [];
  await executeHumanScript({
    humanScript: { id: "approve_plan" },
    caseRoots: { root_issue_ids: ["root-a"] },
    human: { async resolveHumanAction(input) { calls.push(input); } },
    async waitForHumanAction(input) {
      assert.deepEqual(input, { root_issue_id: "root-a", action_kind: "plan_review" });
      return { human_action_issue_id: "action-a" };
    },
  });

  assert.deepEqual(calls, [{ human_action_issue_id: "action-a", terminal_status: "approved" }]);
});

test("reject_plan resolves only the discovered Plan Review Action through the external Human Actor with a required reason", async () => {
  const calls = [];
  await executeHumanScript({
    humanScript: { id: "reject_plan" },
    caseRoots: { root_issue_ids: ["root-a"] },
    human: { async resolveHumanAction(input) { calls.push(input); } },
    async waitForHumanAction(input) {
      assert.deepEqual(input, { root_issue_id: "root-a", action_kind: "plan_review" });
      return { human_action_issue_id: "action-a" };
    },
  });

  assert.deepEqual(calls, [{
    human_action_issue_id: "action-a",
    terminal_status: "rejected",
    reason_or_answer: "The Plan does not satisfy the requested outcome. Please replan it.",
  }]);
});

test("happy-path evidence requires one approved durable Plan to delivery chain", () => {
  const row = happyPathRow({ caseId: "happy-a", conductorId: "conductor-a", repositoryIdentity: "repository-a" });
  const assessment = assessApprovedHappyPathEvidence(row);

  assert.deepEqual(assessment.outcome, { kind: "satisfied", reason_code: "happy_path_chain_confirmed" });
  assert.equal(assessment.intervals.length, 3);
  assert.deepEqual(assessment.intervals.map(({ stage }) => stage), ["plan", "work", "verify"]);
});

test("happy-path evidence rejects a durable Root ownership mismatch", () => {
  const row = happyPathRow({ caseId: "happy-a", conductorId: "conductor-a", repositoryIdentity: "repository-a" });
  row.snapshot.root_trees[0].managed_blocks.find(({ record }) => record.kind === "root_ownership").record.conductor_id = "conductor-b";

  assert.deepEqual(assessApprovedHappyPathEvidence(row).outcome, {
    kind: "violated",
    reason_code: "happy_path_ownership_mismatch",
  });
});

test("happy-path evidence rejects a second durable delivery path", () => {
  const row = happyPathRow({ caseId: "happy-a", conductorId: "conductor-a", repositoryIdentity: "repository-a" });
  const tree = row.snapshot.root_trees[0];
  const original = tree.managed_blocks.find(({ record }) => record.kind === "delivery");
  const duplicate = {
    ...original,
    source_id: "comment-delivery-duplicate",
    record: { ...original.record },
  };
  tree.managed_blocks.push(duplicate);
  tree.comments.push({ comment_id: duplicate.source_id, issue_id: row.caseRoots.root_issue_ids[0] });

  assert.deepEqual(assessApprovedHappyPathEvidence(row).outcome, {
    kind: "violated",
    reason_code: "happy_path_delivery_ambiguous",
  });
});

test("campaign evidence proves a strict cross-Conductor durable interval overlap", () => {
  const a = happyPathRow({ caseId: "happy-a", conductorId: "conductor-a", repositoryIdentity: "repository-a", startOffset: 0 });
  const b = happyPathRow({ caseId: "happy-b", conductorId: "conductor-b", repositoryIdentity: "repository-b", startOffset: 500 });

  const campaign = analyzeHappyPathCampaignEvidence({ rows: [a, b] });

  assert.deepEqual(campaign.case_outcomes, [
    { case_id: "happy-a", outcome: { kind: "satisfied", reason_code: "happy_path_overlap_confirmed" } },
    { case_id: "happy-b", outcome: { kind: "satisfied", reason_code: "happy_path_overlap_confirmed" } },
  ]);
  assert.deepEqual(campaign.durable_overlap_evidence_refs, [
    "linear:root-happy-a:stage_execution:plan-execution-happy-a",
    "linear:root-happy-a:stage_result:plan-result-happy-a",
    "linear:root-happy-b:stage_execution:plan-execution-happy-b",
    "linear:root-happy-b:stage_result:plan-result-happy-b",
  ]);
});

test("campaign evidence does not treat two non-overlapping durable intervals as parallel work", () => {
  const a = happyPathRow({ caseId: "happy-a", conductorId: "conductor-a", repositoryIdentity: "repository-a", startOffset: 0 });
  const b = happyPathRow({ caseId: "happy-b", conductorId: "conductor-b", repositoryIdentity: "repository-b", startOffset: 10_000 });

  const campaign = analyzeHappyPathCampaignEvidence({ rows: [a, b] });

  assert.deepEqual(campaign.case_outcomes, [
    { case_id: "happy-a", outcome: { kind: "violated", reason_code: "happy_path_overlap_absent" } },
    { case_id: "happy-b", outcome: { kind: "violated", reason_code: "happy_path_overlap_absent" } },
  ]);
  assert.deepEqual(campaign.durable_overlap_evidence_refs, []);
});

test("happy-path campaign evidence ignores Cases owned by another predicate", () => {
  const row = happyPathRow({ caseId: "happy-a", conductorId: "conductor-a", repositoryIdentity: "repository-a" });
  row.e2eCase.evidence_predicate_id = "same_conductor_preemption";

  assert.deepEqual(analyzeHappyPathCampaignEvidence({ rows: [row] }), {
    case_outcomes: [],
    durable_overlap_evidence_refs: [],
  });
});
