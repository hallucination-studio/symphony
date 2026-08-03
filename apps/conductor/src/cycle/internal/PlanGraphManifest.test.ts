import assert from "node:assert/strict";
import test from "node:test";

import { parseCycleApprovalRecord, parseCycleSpecification } from "../../contracts/cycle-records.js";
import { buildPlanGraphManifest } from "./PlanGraphManifest.js";

const digest = (character: string) => character.repeat(64);

function basis() {
  const specification = parseCycleSpecification({
    cycle_id: "11111111-1111-4111-8111-111111111111",
    root_id: "root:1",
    predecessor_cycle_issue_id: null,
    predecessor_terminal_record_id: "first_cycle",
    approval_record_id: "22222222-2222-4222-8222-222222222222",
    plan_issue_id: "33333333-3333-4333-8333-333333333333",
    plan_completion_record_id: "44444444-4444-4444-8444-444444444444",
    plan_invalidation_record_id: "55555555-5555-4555-8555-555555555555",
    cycle_completion_record_id: "66666666-6666-4666-8666-666666666666",
    cycle_invalidation_record_id: "77777777-7777-4777-8777-777777777777",
    delivery_completion_record_id: "88888888-8888-4888-8888-888888888888",
    delivery_invalidation_record_id: "99999999-9999-4999-8999-999999999999",
    identity_derivation_version: "symphony-identity:v1",
    workspace_base_revision: digest("a"),
    root_definition_revision: `symphony:v1:${digest("b")}`,
    cycle_specification_markdown: "# Cycle\n\nImplement both directives.",
    root_adr_markdown: "# ADR\n\nKeep the boundary closed.",
    execution_directives: [
      { directive_id: "directive:one", instruction_markdown: "Implement one.", depends_on_directive_ids: [], acceptance_criterion_ids: ["ac:one"] },
      { directive_id: "directive:two", instruction_markdown: "Implement two.", depends_on_directive_ids: ["directive:one"], acceptance_criterion_ids: ["ac:two"] },
    ],
    approved_work_groups: [
      { work_group_id: "group:one", directive_ids: ["directive:one"], depends_on_work_group_ids: [] },
      { work_group_id: "group:two", directive_ids: ["directive:two"], depends_on_work_group_ids: ["group:one"] },
    ],
    verify_directives: [
      { directive_id: "verify:all", instruction_markdown: "Verify both criteria.", acceptance_criterion_ids: ["ac:one", "ac:two"] },
    ],
    specification_seal_digest: digest("c"),
  });
  const approval = parseCycleApprovalRecord({
    record_id: specification.approval_record_id,
    revision: `symphony:v1:${digest("d")}`,
    issue_id: specification.cycle_id,
    cycle_id: specification.cycle_id,
    actor_id: "actor:symphony",
    created_at: "2026-08-02T01:00:00.000Z",
    updated_at: "2026-08-02T01:00:00.000Z",
    archived_at: null,
    basis_issue_revision: `symphony:v1:${digest("e")}`,
    basis_status: "Draft",
    basis_document_digest: digest("f"),
    record_kind: "cycle_approval",
    identity_derivation_version: specification.identity_derivation_version,
    predecessor_cycle_issue_id: null,
    predecessor_terminal_record_id: "first_cycle",
    plan_issue_id: specification.plan_issue_id,
    plan_completion_record_id: specification.plan_completion_record_id,
    plan_invalidation_record_id: specification.plan_invalidation_record_id,
    cycle_completion_record_id: specification.cycle_completion_record_id,
    cycle_invalidation_record_id: specification.cycle_invalidation_record_id,
    delivery_completion_record_id: specification.delivery_completion_record_id,
    delivery_invalidation_record_id: specification.delivery_invalidation_record_id,
    specification_seal_digest: specification.specification_seal_digest,
    workspace_base_revision: specification.workspace_base_revision,
  }, specification);
  return { specification, approval_record: approval };
}

test("manifest construction preallocates every exact identity from one sealed group order", () => {
  const sealed = basis();
  const built = buildPlanGraphManifest({
    basis: sealed,
    ordered_work_group_ids: ["group:one", "group:two"],
    plan_title: "Plan approved Cycle",
    plan_instruction_markdown: "## Plan\n\nCompile only the sealed groups.",
  });

  assert.deepEqual(built.manifest.ordered_work_nodes.map(({ approved_work_group_id }) => approved_work_group_id), [
    "group:one", "group:two",
  ]);
  assert.equal(built.manifest.relations.length, 3);
  assert.equal(new Set([
    ...built.manifest.ordered_work_issue_ids,
    built.manifest.verify_issue_id,
    ...built.manifest.relations.map(({ relation_id }) => relation_id),
  ]).size, 6);
  assert.match(built.instructions_by_issue_id[built.manifest.verify_issue_id] ?? "", /dmVyaWZ5OmFsbA/u);
  assert.deepEqual(buildPlanGraphManifest({
    basis: sealed,
    ordered_work_group_ids: ["group:one", "group:two"],
    plan_title: "Plan approved Cycle",
    plan_instruction_markdown: "## Plan\n\nCompile only the sealed groups.",
  }), built);
});

test("manifest construction rejects Plan regrouping, omission, and illegal order", () => {
  const sealed = basis();
  for (const order of [
    ["group:one"],
    ["group:one", "group:one"],
    ["group:two", "group:one"],
    ["group:one", "group:new"],
  ]) {
    assert.throws(() => buildPlanGraphManifest({
      basis: sealed,
      ordered_work_group_ids: order,
      plan_title: "Plan approved Cycle",
      plan_instruction_markdown: "## Plan\n\nCompile only the sealed groups.",
    }));
  }
});
