import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzePlanRejectionSupersessionCampaignEvidence,
  assessPlanRejectionSupersessionEvidence,
} from "../../tools/e2e/plan-rejection-supersession-evidence.mjs";
import { planRejectionSupersessionRow } from "./plan-rejection-supersession-fixture.mjs";

test("Plan rejection evidence proves the durable rejected-to-replanned chain", () => {
  assert.deepEqual(assessPlanRejectionSupersessionEvidence(planRejectionSupersessionRow()), {
    kind: "satisfied",
    reason_code: "plan_rejection_supersession_confirmed",
  });
});

test("Plan rejection evidence rejects a native archive fact that differs from the accepted directive", () => {
  const row = planRejectionSupersessionRow();
  const action = row.snapshot.root_trees[0].issues.find(({ issue_id: issueId }) => issueId === "action-plan-rejection");
  action.is_archived = false;
  action.archived_at = null;

  assert.deepEqual(assessPlanRejectionSupersessionEvidence(row), {
    kind: "violated",
    reason_code: "plan_rejection_archive_mismatch",
  });
});

test("Plan rejection evidence requires native Human Action and Plan Review labels", () => {
  const row = planRejectionSupersessionRow();
  const action = row.snapshot.root_trees[0].issues.find(({ issue_id: issueId }) => issueId === "action-plan-rejection");
  action.labels = [{ label_id: "label-human-action-only", name: "Human Action" }];

  assert.deepEqual(assessPlanRejectionSupersessionEvidence(row), {
    kind: "violated",
    reason_code: "plan_rejection_action_mismatch",
  });
});

test("Plan rejection evidence remains incomplete until the durable supersession record is readable", () => {
  const row = planRejectionSupersessionRow();
  const tree = row.snapshot.root_trees[0];
  const index = tree.managed_blocks.findIndex(({ record }) => record.kind === "plan_contract_supersession");
  tree.managed_blocks.splice(index, 1);

  assert.deepEqual(assessPlanRejectionSupersessionEvidence(row), {
    kind: "inconclusive",
    reason_code: "plan_rejection_supersession_missing",
  });
});

test("Plan rejection evidence rejects a supersession ID that is not deterministically derived from its directive", () => {
  const row = planRejectionSupersessionRow();
  row.snapshot.root_trees[0].managed_blocks.find(({ record }) => record.kind === "plan_contract_supersession").record.supersession_id = "not-derived";

  assert.deepEqual(assessPlanRejectionSupersessionEvidence(row), {
    kind: "violated",
    reason_code: "plan_rejection_supersession_mismatch",
  });
});

test("Plan rejection evidence rejects a Work execution that starts after the rejected resolution", () => {
  const row = planRejectionSupersessionRow();
  const execution = row.snapshot.root_trees[0].managed_blocks.find(({ record }) =>
    record.kind === "stage_execution" && record.stage_execution_id === "plan-execution-plan-rejection-fresh",
  ).record;
  execution.stage = "work";
  execution.plan_contract_digest = "digest-plan-rejection-fresh";

  assert.deepEqual(assessPlanRejectionSupersessionEvidence(row), {
    kind: "violated",
    reason_code: "plan_rejection_work_advanced",
  });
});

test("Plan rejection evidence rejects a delivery record after rejection", () => {
  const row = planRejectionSupersessionRow();
  const tree = row.snapshot.root_trees[0];
  tree.comments.push({ comment_id: "comment-delivery-after-rejection", issue_id: "root-plan-rejection" });
  tree.managed_blocks.push({
    source_kind: "comment",
    source_id: "comment-delivery-after-rejection",
    record: {
      kind: "delivery",
      version: 1,
      root_issue_id: "root-plan-rejection",
      cycle_issue_id: "cycle-plan-rejection",
      verify_result_id: "verify-after-rejection",
      verified_revision: "a".repeat(40),
      delivery_kind: "remote_branch",
      delivery_branch: "symphony/plan-rejection",
      delivered_at: "2026-07-25T00:00:03.000Z",
    },
  });

  assert.deepEqual(assessPlanRejectionSupersessionEvidence(row), {
    kind: "violated",
    reason_code: "plan_rejection_delivery_advanced",
  });
});

test("Plan rejection campaign evidence ignores Cases owned by another predicate", () => {
  const row = planRejectionSupersessionRow();
  row.e2eCase.evidence_predicate_id = "happy_path";

  assert.deepEqual(analyzePlanRejectionSupersessionCampaignEvidence({ rows: [row] }), {
    case_outcomes: [],
  });
});
