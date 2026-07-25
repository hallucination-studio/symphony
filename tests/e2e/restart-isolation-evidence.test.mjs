import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeRestartIsolationCampaignEvidence,
  assessRestartIsolationEvidence,
} from "../../tools/e2e/restart-isolation-evidence.mjs";
import { restartIsolationRow } from "./restart-isolation-fixture.mjs";

test("restart isolation evidence proves C recovery and uninterrupted A/B durable chains", () => {
  assert.deepEqual(assessRestartIsolationEvidence(restartIsolationRow()), {
    kind: "satisfied",
    reason_code: "restart_isolation_confirmed",
  });
});

test("restart isolation evidence rejects a successful stale Result for C's failed execution", () => {
  const row = restartIsolationRow();
  const tree = row.snapshot.root_trees[0];
  const stale = structuredClone(tree.managed_blocks.find(({ record }) => record.result_id === "result-c-before-restart"));
  stale.source_id = "comment-stage-result-c-stale";
  stale.record = {
    ...stale.record,
    result_id: "result-c-stale",
    outcome_kind: "plan_completed",
    role_turn_id: "turn-result-c-stale",
    observed_tree_digest: "tree-result-c-stale",
    model_turn: {
      ...stale.record.model_turn,
      turn_record_id: "turn-record-result-c-stale",
      role_turn_id: "turn-result-c-stale",
      outcome: "plan_completed",
    },
  };
  delete stale.record.failure_code;
  tree.managed_blocks.push(stale);
  tree.comments.push({ comment_id: stale.source_id, issue_id: stale.issue_id });

  assert.deepEqual(assessRestartIsolationEvidence(row), {
    kind: "violated",
    reason_code: "restart_isolation_stale_output_materialized",
  });
});

test("restart isolation evidence rejects a second failed Result for C's old execution", () => {
  const row = restartIsolationRow();
  const tree = row.snapshot.root_trees[0];
  const duplicate = structuredClone(tree.managed_blocks.find(({ record }) => record.result_id === "result-c-before-restart"));
  duplicate.source_id = "comment-stage-result-c-duplicate";
  duplicate.record = {
    ...duplicate.record,
    result_id: "result-c-before-restart-duplicate",
    role_turn_id: "turn-result-c-before-restart-duplicate",
    observed_tree_digest: "tree-result-c-before-restart-duplicate",
    model_turn: {
      ...duplicate.record.model_turn,
      turn_record_id: "turn-record-result-c-before-restart-duplicate",
      role_turn_id: "turn-result-c-before-restart-duplicate",
    },
  };
  tree.managed_blocks.push(duplicate);
  tree.comments.push({ comment_id: duplicate.source_id, issue_id: duplicate.issue_id });

  assert.deepEqual(assessRestartIsolationEvidence(row), {
    kind: "violated",
    reason_code: "restart_isolation_stale_output_materialized",
  });
});

test("restart isolation evidence rejects a replacement C Result that reuses the lost role session", () => {
  const row = restartIsolationRow();
  const replacement = row.snapshot.root_trees[0].managed_blocks.find(({ record }) => record.result_id === "result-c-after-restart").record;
  replacement.role_session_id = "session-c-before-restart";
  replacement.model_turn.role_session_id = "session-c-before-restart";

  assert.deepEqual(assessRestartIsolationEvidence(row), {
    kind: "violated",
    reason_code: "restart_isolation_replacement_session_reused",
  });
});

test("restart isolation evidence rejects an A/B ownership takeover", () => {
  const row = restartIsolationRow();
  row.snapshot.root_trees[1].managed_blocks.find(({ record }) => record.kind === "root_ownership").record.conductor_id = "conductor-c";

  assert.deepEqual(assessRestartIsolationEvidence(row), {
    kind: "violated",
    reason_code: "restart_isolation_peer_ownership_mismatch",
  });
});

test("restart isolation evidence rejects a peer chain that does not span C recovery", () => {
  const row = restartIsolationRow();
  const result = row.snapshot.root_trees[2].managed_blocks.find(({ record }) => record.result_id === "result-b-continuous").record;
  result.completed_at = "2026-07-25T00:00:09.000Z";
  result.model_turn.terminal_at = result.completed_at;

  assert.deepEqual(assessRestartIsolationEvidence(row), {
    kind: "violated",
    reason_code: "restart_isolation_peer_interval_interrupted",
  });
});

test("restart isolation evidence remains incomplete until C's old terminal failure is durably readable", () => {
  const row = restartIsolationRow();
  const tree = row.snapshot.root_trees[0];
  const index = tree.managed_blocks.findIndex(({ record }) => record.result_id === "result-c-before-restart");
  tree.managed_blocks.splice(index, 1);

  assert.deepEqual(assessRestartIsolationEvidence(row), {
    kind: "inconclusive",
    reason_code: "restart_isolation_old_terminal_missing",
  });
});

test("restart isolation evidence rejects a Stage record projected onto the wrong Issue", () => {
  const row = restartIsolationRow();
  const tree = row.snapshot.root_trees[0];
  const block = tree.managed_blocks.find(({ record }) => record.result_id === "result-c-after-restart");
  block.issue_id = "root-restart-c";
  tree.comments.find(({ comment_id: commentId }) => commentId === block.source_id).issue_id = "root-restart-c";

  assert.deepEqual(assessRestartIsolationEvidence(row), {
    kind: "inconclusive",
    reason_code: "restart_isolation_evidence_invalid",
  });
});

test("restart isolation campaign evidence ignores another predicate", () => {
  const row = restartIsolationRow();
  row.e2eCase.evidence_predicate_id = "happy_path";

  assert.deepEqual(analyzeRestartIsolationCampaignEvidence({ rows: [row] }), {
    case_outcomes: [],
  });
});
