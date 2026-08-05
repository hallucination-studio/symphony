import assert from "node:assert/strict";
import test from "node:test";

import {
  cycleCompletionTerminalStatus,
  parseCycleApprovalRecord,
  parseCycleCompletionRecord,
  parseCycleInvalidationRecord,
  parseCycleSpecification,
  parseDeliveryInvalidationRecord,
  parsePlanGraphManifest,
  parseRootFamilyInvalidationRecord,
  parseStageCompletionRecord,
  parseStageInvalidationRecord,
  stageCompletionTerminalStatus,
} from "./cycle-records.js";

const digest = (character: string) => character.repeat(64);

function specificationSource() {
  return {
    cycle_id: "issue:cycle:1",
    root_id: "issue:root:1",
    predecessor_cycle_issue_id: null,
    predecessor_terminal_record_id: "first_cycle",
    approval_record_id: "record:approval:1",
    plan_issue_id: "issue:plan:1",
    plan_completion_record_id: "record:plan:completion:1",
    plan_invalidation_record_id: "record:plan:invalidation:1",
    cycle_completion_record_id: "record:cycle:completion:1",
    cycle_invalidation_record_id: "record:cycle:invalidation:1",
    delivery_completion_record_id: "record:delivery:completion:1",
    delivery_invalidation_record_id: "record:delivery:invalidation:1",
    identity_derivation_version: "symphony-identity:v1",
    workspace_base_revision: digest("a"),
    root_definition_revision: "symphony:v1:" + digest("b"),
    cycle_specification_markdown: "# Cycle\n\nImplement the approved directives.",
    root_adr_markdown: "# Root ADR\n\nKeep contracts closed.",
    execution_directives: [
      {
        directive_id: "directive:one",
        instruction_markdown: "Implement the first unit.",
        depends_on_directive_ids: [],
        acceptance_criterion_ids: ["acceptance:one"],
      },
      {
        directive_id: "directive:two",
        instruction_markdown: "Implement the second unit.",
        depends_on_directive_ids: ["directive:one"],
        acceptance_criterion_ids: ["acceptance:two"],
      },
    ],
    approved_work_groups: [
      {
        work_group_id: "group:one",
        directive_ids: ["directive:one"],
        depends_on_work_group_ids: [],
      },
      {
        work_group_id: "group:two",
        directive_ids: ["directive:two"],
        depends_on_work_group_ids: ["group:one"],
      },
    ],
    verify_directives: [
      {
        directive_id: "verify:one",
        instruction_markdown: "Verify both acceptance criteria.",
        acceptance_criterion_ids: ["acceptance:one", "acceptance:two"],
      },
    ],
    specification_seal_digest: digest("c"),
  } as const;
}

function approvalSource() {
  const specification = specificationSource();
  return {
    record_id: specification.approval_record_id,
    revision: "symphony:v1:" + digest("d"),
    issue_id: specification.cycle_id,
    cycle_id: specification.cycle_id,
    actor_id: "actor:symphony",
    created_at: "2026-08-02T01:00:00.000Z",
    updated_at: "2026-08-02T01:00:00.000Z",
    archived_at: null,
    basis_issue_revision: "symphony:v1:" + digest("e"),
    basis_status: "Draft",
    basis_document_digest: digest("f"),
    record_kind: "cycle_approval",
    identity_derivation_version: specification.identity_derivation_version,
    predecessor_cycle_issue_id: specification.predecessor_cycle_issue_id,
    predecessor_terminal_record_id: specification.predecessor_terminal_record_id,
    plan_issue_id: specification.plan_issue_id,
    plan_completion_record_id: specification.plan_completion_record_id,
    plan_invalidation_record_id: specification.plan_invalidation_record_id,
    cycle_completion_record_id: specification.cycle_completion_record_id,
    cycle_invalidation_record_id: specification.cycle_invalidation_record_id,
    delivery_completion_record_id: specification.delivery_completion_record_id,
    delivery_invalidation_record_id: specification.delivery_invalidation_record_id,
    specification_seal_digest: specification.specification_seal_digest,
    workspace_base_revision: specification.workspace_base_revision,
  } as const;
}

function commonRecord(recordId: string, issueId = "issue:work:1") {
  return {
    record_id: recordId,
    revision: "symphony:v1:" + digest("1"),
    issue_id: issueId,
    cycle_id: "issue:cycle:1",
    actor_id: "actor:symphony",
    created_at: "2026-08-02T02:00:00.000Z",
    updated_at: "2026-08-02T02:00:00.000Z",
    archived_at: null,
    basis_issue_revision: "symphony:v1:" + digest("2"),
    basis_status: "In Progress",
    basis_document_digest: digest("3"),
  } as const;
}

test("Cycle specification seals a non-empty exact-cover Work-group DAG and ordered Verify set", () => {
  const parsed = parseCycleSpecification(specificationSource());
  assert.equal(parsed.approved_work_groups.length, 2);
  assert.ok(Object.isFrozen(parsed.execution_directives));

  const duplicateCover = {
    ...specificationSource(),
    approved_work_groups: specificationSource().approved_work_groups.map((group, index) =>
      index === 1 ? { ...group, directive_ids: ["directive:one"] } : group),
  };
  assert.throws(() => parseCycleSpecification(duplicateCover), /work_group_directive_partition/u);

  const cycle = {
    ...specificationSource(),
    approved_work_groups: specificationSource().approved_work_groups.map((group, index) =>
      index === 0 ? { ...group, depends_on_work_group_ids: ["group:two"] } : group),
  };
  assert.throws(() => parseCycleSpecification(cycle), /work_group_dependency_cycle/u);

  assert.throws(
    () => parseCycleSpecification({ ...specificationSource(), verify_directives: [] }),
    /empty_verification_directives/u,
  );
});

test("Cycle approval and manifest bind every sealed identity, one Work per group, and one Verify", () => {
  const specification = parseCycleSpecification(specificationSource());
  const approval = parseCycleApprovalRecord(approvalSource(), specification);
  const manifest = {
    cycle_id: specification.cycle_id,
    approval_record_id: approval.record_id,
    specification_seal_digest: specification.specification_seal_digest,
    plan_issue_id: specification.plan_issue_id,
    plan: {
      kind: "plan",
      issue_id: specification.plan_issue_id,
      parent_issue_id: specification.cycle_id,
      completion_record_id: specification.plan_completion_record_id,
      invalidation_record_id: specification.plan_invalidation_record_id,
      title: "Plan",
      instruction_digest: digest("4"),
    },
    ordered_work_nodes: [
      {
        kind: "work", issue_id: "issue:work:1", parent_issue_id: specification.cycle_id,
        completion_record_id: "record:work:completion:1",
        invalidation_record_id: "record:work:invalidation:1", title: "Work one",
        instruction_digest: digest("5"), approved_work_group_id: "group:one",
        directive_ids: ["directive:one"],
      },
      {
        kind: "work", issue_id: "issue:work:2", parent_issue_id: specification.cycle_id,
        completion_record_id: "record:work:completion:2",
        invalidation_record_id: "record:work:invalidation:2", title: "Work two",
        instruction_digest: digest("6"), approved_work_group_id: "group:two",
        directive_ids: ["directive:two"],
      },
    ],
    ordered_work_issue_ids: ["issue:work:1", "issue:work:2"],
    verify_node: {
      kind: "verify", issue_id: "issue:verify:1", parent_issue_id: specification.cycle_id,
      completion_record_id: "record:verify:completion:1",
      invalidation_record_id: "record:verify:invalidation:1", title: "Verify",
      instruction_digest: digest("7"), directive_ids: ["verify:one"],
    },
    verify_issue_id: "issue:verify:1",
    relations: [
      {
        relation_id: "relation:dependency:1", relation_role: "work_dependency", type: "blocks",
        prerequisite_work_group_id: "group:one", dependent_work_group_id: "group:two",
        source_issue_id: "issue:work:1", target_issue_id: "issue:work:2",
      },
      {
        relation_id: "relation:verify:1", relation_role: "verify_barrier", type: "blocks",
        prerequisite_work_group_id: "group:one", source_issue_id: "issue:work:1",
        target_issue_id: "issue:verify:1",
      },
      {
        relation_id: "relation:verify:2", relation_role: "verify_barrier", type: "blocks",
        prerequisite_work_group_id: "group:two", source_issue_id: "issue:work:2",
        target_issue_id: "issue:verify:1",
      },
    ],
  } as const;

  const parsed = parsePlanGraphManifest(manifest, { specification, approval_record: approval });
  assert.deepEqual(parsed.ordered_work_issue_ids, ["issue:work:1", "issue:work:2"]);

  assert.throws(
    () => parsePlanGraphManifest({
      ...manifest,
      ordered_work_issue_ids: ["issue:work:2", "issue:work:1"],
    }, { specification, approval_record: approval }),
    /manifest_work_order_mismatch/u,
  );
  assert.throws(
    () => parsePlanGraphManifest({ ...manifest, relations: manifest.relations.slice(1) }, {
      specification, approval_record: approval,
    }),
    /manifest_relation_set_mismatch/u,
  );
  assert.throws(
    () => parsePlanGraphManifest({
      ...manifest,
      ordered_work_nodes: [...manifest.ordered_work_nodes].reverse(),
      ordered_work_issue_ids: [...manifest.ordered_work_issue_ids].reverse(),
    }, { specification, approval_record: approval }),
    /manifest_work_order_not_topological/u,
  );
});

test("Stage records are exact-slot, source-status-owned, and keep Work continuation out of persistence", () => {
  const completed = parseStageCompletionRecord({
    ...commonRecord("record:work:completion:1"),
    record_kind: "stage_completion",
    stage_id: "issue:work:1",
    completion: {
      outcome: "completed",
      instruction_digest: digest("4"),
      workspace_parent_revision: digest("5"),
      workspace_diff_digest: digest("6"),
      checks_markdown: "Checks passed.",
      normalized_handoff_markdown: "Implemented the contract.",
    },
  }, "work");
  assert.equal(completed.completion.outcome, "completed");
  assert.equal(stageCompletionTerminalStatus(completed.completion), "Done");
  assert.equal("ephemeral_continuation_markdown" in completed.completion, false);

  const providerClockSkew = parseStageCompletionRecord({
    ...commonRecord("record:work:completion:clock-skew"),
    updated_at: "2026-08-02T02:00:00.037Z",
    record_kind: "stage_completion",
    stage_id: "issue:work:1",
    completion: {
      outcome: "completed",
      instruction_digest: digest("4"),
      workspace_parent_revision: digest("5"),
      workspace_diff_digest: digest("6"),
      checks_markdown: "Checks passed.",
      normalized_handoff_markdown: "Implemented the contract.",
    },
  }, "work");
  assert.equal(providerClockSkew.created_at, "2026-08-02T02:00:00.000Z");
  assert.equal(providerClockSkew.updated_at, "2026-08-02T02:00:00.037Z");

  assert.throws(() => parseStageCompletionRecord({
    ...completed,
    completion: { ...completed.completion, ephemeral_continuation_markdown: "Continue." },
  }, "work"), /invalid_contract_keys/u);

  const invalidation = parseStageInvalidationRecord({
    ...commonRecord("record:work:invalidation:1"),
    record_kind: "stage_invalidation",
    stage_id: "issue:work:1",
    observed_status: "Done",
    observed_instruction_digest: digest("7"),
    observed_completion_record_digest: digest("8"),
    observed_history_digest: digest("9"),
    reason_code: "terminal_without_valid_record",
    reason_markdown: "The terminal projection lacks a valid record.",
    invalidation_kind: "invalid_terminal",
    terminal_status: "Done",
  });
  assert.equal(invalidation.invalidation_kind, "invalid_terminal");
});

test("Cycle terminal records bind phase-owned evidence and reserve successor allowance for intact invalid-terminal proof", () => {
  const cycleCommon = commonRecord("record:cycle:completion:1", "issue:cycle:1");
  const failed = parseCycleCompletionRecord({
    ...cycleCommon,
    record_kind: "cycle_completion",
    successor_policy: "allowed",
    completion: {
      outcome: "failed", failure_phase: "in_progress",
      specification_seal_digest: digest("4"), graph_seal_digest: null,
      observed_execution_graph_digest: digest("5"), observed_cycle_document_digest: digest("6"),
      failed_stage_id: "issue:work:1", reason_code: "work_failed",
      reason_markdown: "The Work stage failed.",
    },
  });
  assert.equal(failed.successor_policy, "allowed");
  assert.equal(cycleCompletionTerminalStatus(failed.completion), "Failed");

  const invalidation = {
    ...commonRecord("record:cycle:invalidation:1", "issue:cycle:1"),
    record_kind: "cycle_invalidation",
    last_valid_phase: "in_progress",
    expected_status: "In Progress",
    observed_status: "Failed",
    observed_cycle_document_digest: digest("7"),
    observed_execution_graph_digest: digest("8"),
    offending_resources: [{
      evidence_kind: "missing_manifest_resource", resource_kind: "stage",
      resource_id: "issue:work:2", expected_manifest_entry_digest: digest("9"),
      last_known_revision: null, creation_evidence_digest: null,
    }],
    observed_history_digest: digest("a"),
    observed_record_set_digest: digest("b"),
    reason_code: "partial_graph",
    reason_markdown: "A sealed Work resource is missing.",
    invalidation_kind: "partial_graph_materialization",
    terminal_status: "Failed",
    successor_policy: "permanently_quarantined",
    successor_evidence: null,
  } as const;
  assert.equal(parseCycleInvalidationRecord(invalidation).offending_resources.length, 1);
  assert.throws(
    () => parseCycleInvalidationRecord({ ...invalidation, successor_policy: "allowed" }),
    /invalid_cycle_successor_policy/u,
  );
  assert.throws(
    () => parseCycleInvalidationRecord({ ...invalidation, offending_resources: [] }),
    /empty_cycle_invalidation_evidence/u,
  );
});

test("Root family invalidation deterministically quarantines multiple non-terminal Cycles", () => {
  const parsed = parseRootFamilyInvalidationRecord({
    record_id: "record:root:family:1",
    revision: "symphony:v1:" + digest("c"),
    issue_id: "issue:root:1",
    root_id: "issue:root:1",
    actor_id: "actor:symphony",
    created_at: "2026-08-02T03:00:00.000Z",
    updated_at: "2026-08-02T03:00:00.037Z",
    archived_at: null,
    record_kind: "root_family_invalidation",
    identity_derivation_version: "symphony-identity:v1",
    basis_issue_revision: "symphony:v1:" + digest("d"),
    basis_status: "In Progress",
    basis_document_digest: digest("e"),
    invalidation_kind: "multiple_non_terminal_cycles",
    observed_task_snapshot_digest: digest("f"),
    observed_at: "2026-08-02T02:59:59.000Z",
    non_terminal_cycle_ids: ["issue:cycle:1", "issue:cycle:2"],
    overlap_evidence_digests: [digest("1"), digest("2")],
    resolution_policy: "permanently_quarantined",
    reason_code: "multiple_non_terminal_cycles",
    reason_markdown: "Two non-terminal Cycles overlap.",
  });
  assert.equal(parsed.non_terminal_cycle_ids.length, 2);
  assert.ok(Object.isFrozen(parsed));
  assert.throws(
    () => parseRootFamilyInvalidationRecord({ ...parsed, non_terminal_cycle_ids: ["issue:cycle:1"] }),
    /insufficient_non_terminal_cycle_overlap/u,
  );
});

test("delivery invalidation is Root-attached, Cycle-bound, and reason-discriminated", () => {
  const parsed = parseDeliveryInvalidationRecord({
    ...commonRecord("record:delivery:invalidation:1", "issue:root:1"),
    cycle_id: "issue:cycle:1",
    basis_status: "In Review",
    record_kind: "delivery_invalidation",
    root_id: "issue:root:1",
    accepted_cycle_id: "issue:cycle:1",
    exact_revision: digest("4"),
    accepted_record_digest: digest("5"),
    acceptance_basis_digest: digest("6"),
    observed_root_status: "In Review",
    observed_remote_revision: null,
    observed_pull_request_identity: null,
    observed_pull_request_head: null,
    invalidation_evidence: {
      kind: "completion_slot_conflict",
      invalid_record_observation_digest: digest("7"),
    },
    resolution_policy: "permanently_quarantined",
    reason_code: "completion_slot_conflict",
    reason_markdown: "The exact delivery completion slot conflicts.",
  });
  assert.equal(parsed.invalidation_evidence.kind, "completion_slot_conflict");
  assert.throws(() => parseDeliveryInvalidationRecord({
    ...parsed,
    invalidation_evidence: {
      kind: "delivery_effect_conflict",
      effect_may_have_occurred: false,
      observed_delivery_facts_digest: digest("8"),
    },
  }), /invalid_delivery_effect_conflict/u);
});

test("failed Verify completion persists lost execution context as Markdown explanation", () => {
  const parsed = parseStageCompletionRecord({
    ...commonRecord("record:verify:completion:lost", "issue:verify:1"),
    record_kind: "stage_completion",
    stage_id: "issue:verify:1",
    completion: {
      conclusion: "failed",
      instruction_digest: digest("1"),
      exact_revision: digest("2"),
      checks_markdown: "## Checks\n\n- not_run",
      evidence_markdown: "Execution context was lost.",
      reason_markdown: "lost_execution_context",
    },
  }, "verify");
  assert.equal(parsed.completion.conclusion, "failed");
  assert.equal(parsed.completion.reason_markdown, "lost_execution_context");
});
