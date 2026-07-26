import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  FOREGROUND_E2E_CASES,
  FOREGROUND_E2E_CASE_IDS,
  FOREGROUND_E2E_COMMON_ASSERTION_IDS,
} from "../../tools/e2e/cases.mjs";

const CASE_ASSERTION_IDS = Object.freeze({
  approved_happy_path: [
    "plan_approval_precedes_work",
    "stage_chain_delivered",
    "turn_usage_aggregated",
    "boundary_in_review_delivery",
    "work_before_approval",
    "duplicate_or_synthetic_completion",
    "usage_missing_or_double_counted",
  ],
  plan_rejected_and_replanned: [
    "rejection_consumed_and_replied",
    "rejected_lineage_retained",
    "rejected_contract_superseded",
    "boundary_fresh_plan_review",
    "work_against_rejected_contract",
    "contract_overwritten_or_history_deleted",
    "test_created_replacement",
  ],
  information_requested_and_answered: [
    "information_action_actionable",
    "answer_consumed_and_receipted",
    "answer_drives_fresh_plan",
    "boundary_fresh_plan_review",
    "missing_answer_assumed",
    "test_unblocks_or_mutates_stage",
  ],
  root_revision_and_comment: [
    "ordinary_inputs_consumed_once",
    "thread_transitions_receipted",
    "revision_supersedes_cycle",
    "boundary_successor_plan_review",
    "system_comment_treated_as_input",
    "thread_history_lost",
    "undeclared_revision_or_conductor_interpretation",
  ],
  parallel_multi_conductor: [
    "root_ownership_and_workspace_isolated",
    "independent_delivery_chains",
    "cross_conductor_stage_overlap",
    "boundary_all_roots_delivered",
    "cross_conductor_takeover",
    "shared_workspace_writer",
    "telemetry_substitutes_overlap",
  ],
  same_conductor_preemption: [
    "inflight_stage_completes",
    "latest_ready_root_runs_next",
    "remaining_ready_root_progresses",
    "boundary_all_roots_delivered",
    "inflight_turn_interrupted",
    "test_selects_next_root",
    "semantic_requirement_touch",
  ],
  conductor_restart_recovery: [
    "old_execution_terminal_once",
    "recovery_uses_fresh_execution",
    "ownership_persists",
    "unaffected_root_continues",
    "boundary_recovered_and_continuous_delivered",
    "late_old_session_success",
    "checkpoint_or_linear_rewrite",
    "unaffected_conductor_reconfigured",
  ],
});

test("immutable Case catalog contains every architecture assertion exactly once", () => {
  assert.deepEqual(FOREGROUND_E2E_CASES.map(({ caseId }) => caseId), FOREGROUND_E2E_CASE_IDS);
  assert.equal(Object.isFrozen(FOREGROUND_E2E_CASES), true);

  for (const definition of FOREGROUND_E2E_CASES) {
    const expected = [
      ...FOREGROUND_E2E_COMMON_ASSERTION_IDS,
      ...CASE_ASSERTION_IDS[definition.caseId],
    ].sort();
    const assertions = definition.assertions.map(({ assertionId }) => assertionId).sort();

    assert.deepEqual(assertions, expected, definition.caseId);
    assert.equal(new Set(assertions).size, assertions.length, definition.caseId);
    assert.equal(Object.isFrozen(definition), true, definition.caseId);
    assertNoFunctions(definition, definition.caseId);
    assertRequirementHashes(definition);
    assert.equal(new Set(definition.rootTopology.map(({ rootKey }) => rootKey)).size, definition.rootTopology.length);
    assert.equal(new Set(definition.rootTopology.map(({ repositoryRef }) => repositoryRef)).size, definition.rootTopology.length);
    const rootKeys = new Set(definition.rootTopology.map(({ rootKey }) => rootKey));
    for (const interaction of definition.declaredUserInteractions) {
      assert.equal(rootKeys.has(interaction.rootKey), true, `${definition.caseId}.${interaction.kind}`);
    }

    for (const assertion of definition.assertions) {
      assert.match(assertion.reasonCode, new RegExp(`^e2e\\.${definition.caseId}\\.${assertion.assertionId}$`, "u"));
      assert.ok(["required", "prohibited", "boundary"].includes(assertion.kind));
      assert.ok(Array.isArray(assertion.factScope) && assertion.factScope.length > 0);
      assert.ok(Array.isArray(assertion.correlation) && assertion.correlation.length > 0);
      assert.ok(typeof assertion.predicate === "string" && assertion.predicate.length > 0);
    }
  }
});

test("Case topology and declared interactions satisfy the mandatory human and concurrency scenarios", () => {
  const byId = new Map(FOREGROUND_E2E_CASES.map((definition) => [definition.caseId, definition]));

  assert.equal(byId.get("approved_happy_path").rootTopology.length, 1);
  assert.equal(byId.get("plan_rejected_and_replanned").declaredUserInteractions.at(-1).terminalStatus, "Rejected");
  assert.equal(byId.get("information_requested_and_answered").declaredUserInteractions.at(-1).terminalStatus, "Answered");
  assert.deepEqual(
    byId.get("root_revision_and_comment").declaredUserInteractions.map(({ kind }) => kind),
    ["update_root_description", "create_comment", "edit_comment", "resolve_comment_thread", "reopen_comment_thread"],
  );
  assert.equal(byId.get("parallel_multi_conductor").rootTopology.length, 2);
  assert.equal(byId.get("same_conductor_preemption").rootTopology.length, 3);
  assert.equal(new Set(byId.get("same_conductor_preemption").rootTopology.map(({ conductorRef }) => conductorRef)).size, 1);
  assert.equal(byId.get("conductor_restart_recovery").rootTopology.length, 2);
  assert.deepEqual(byId.get("conductor_restart_recovery").allowedProcessFaults, ["kill_and_restart_owning_conductor"]);
});

function assertRequirementHashes(definition) {
  assert.equal(definition.initialRequirements.length, definition.rootTopology.length, definition.caseId);
  assert.equal(definition.rootCreationInputs.length, definition.rootTopology.length, definition.caseId);
  for (const input of definition.initialRequirements) {
    const serialized = JSON.stringify({
      rootKey: input.rootKey,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
    });
    const hash = createHash("sha256").update(serialized).digest("hex");
    assert.equal(input.hash, hash, `${definition.caseId}.${input.rootKey}`);
    const rootCreationInput = definition.rootCreationInputs.find(({ rootKey }) => rootKey === input.rootKey);
    assert.deepEqual(
      rootCreationInput && { rootKey: rootCreationInput.rootKey, title: rootCreationInput.title },
      { rootKey: input.rootKey, title: input.title },
      definition.caseId,
    );
    assert.match(rootCreationInput.description, new RegExp(`^${escapeRegExp(input.description)}\\n\\n`, "u"), definition.caseId);
    assert.match(rootCreationInput.description, /^## Acceptance Criteria$/mu, definition.caseId);
    for (const criterion of input.acceptanceCriteria) {
      assert.match(rootCreationInput.description, new RegExp(`^- ${escapeRegExp(criterion)}$`, "mu"), definition.caseId);
    }
  }
}

function assertNoFunctions(value, path) {
  assert.notEqual(typeof value, "function", path);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) assertNoFunctions(child, `${path}.${key}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
