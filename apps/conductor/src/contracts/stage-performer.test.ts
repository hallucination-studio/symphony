import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalPerformerRequestDigest,
  parsePlanRequest,
  parsePlanResult,
  parseVerifyRequest,
  parseWorkRequest,
  parseWorkResult,
  parseWorkTurnResult,
} from "./stage-performer.js";

const digest = (character: string) => character.repeat(64);
const common = {
  schema_version: 1,
  root_id: "issue:root:1",
  cycle_id: "issue:cycle:1",
  runtime_generation: 2,
  correlation_id: "correlation:1",
} as const;

function planRequestSource() {
  return {
    ...common,
    cycle_revision: "symphony:v1:" + digest("a"),
    plan_issue_id: "issue:plan:1",
    plan_issue_revision: "symphony:v1:" + digest("b"),
    cycle_specification_markdown: "# Cycle\n\nUse the sealed Work groups.",
    root_adr_markdown: "# Root ADR\n\nKeep public contracts closed.",
    plan_instruction_markdown: "Return one total order over every sealed Work group.",
  } as const;
}

test("Plan result can return only an exact total order over all sealed Work groups", () => {
  const request = parsePlanRequest(planRequestSource());
  const groups = [
    { work_group_id: "group:one", depends_on_work_group_ids: [] },
    { work_group_id: "group:two", depends_on_work_group_ids: ["group:one"] },
  ] as const;
  const parsed = parsePlanResult({
    ...common,
    input_request_digest: canonicalPerformerRequestDigest(request),
    plan_issue_id: request.plan_issue_id,
    outcome: "completed",
    ordered_work_group_ids: ["group:one", "group:two"],
  }, request, groups);
  assert.equal(parsed.outcome, "completed");
  if (parsed.outcome !== "completed") throw new Error("expected_completed_plan");
  assert.deepEqual(parsed.ordered_work_group_ids, ["group:one", "group:two"]);

  assert.throws(() => parsePlanResult({
    ...parsed,
    manifest: {},
  }, request, groups), /invalid_contract_keys/u);
  assert.throws(() => parsePlanResult({
    ...parsed,
    ordered_work_group_ids: ["group:one"],
  }, request, groups), /plan_work_group_order_mismatch/u);
  assert.throws(() => parsePlanResult({
    ...parsed,
    ordered_work_group_ids: ["group:one", "group:one"],
  }, request, groups), /duplicate_contract_identity/u);
  assert.throws(() => parsePlanResult({
    ...parsed,
    ordered_work_group_ids: ["group:two", "group:one"],
  }, request, groups), /plan_work_group_order_not_topological/u);
});

test("role requests reject sibling Issue or Result context", () => {
  const siblingClaims = [
    { sibling_issue: { issue_id: "issue:work:2" } },
    { prior_result_markdown: "A sibling result." },
    { manifest: {} },
  ];
  for (const claim of siblingClaims) {
    assert.throws(() => parsePlanRequest({ ...planRequestSource(), ...claim }), /invalid_contract_keys/u);
  }

  const work = {
    ...common,
    cycle_revision: "symphony:v1:" + digest("a"),
    work_issue_id: "issue:work:1",
    work_issue_revision: "symphony:v1:" + digest("c"),
    cycle_specification_markdown: "# Cycle\n\nUse the sealed Work groups.",
    work_instruction_markdown: "Implement only this Work instruction.",
  } as const;
  assert.equal(parseWorkRequest(work).work_issue_id, "issue:work:1");
  assert.throws(() => parseWorkRequest({ ...work, sibling_results: [] }), /invalid_contract_keys/u);

  const verify = {
    ...common,
    cycle_revision: "symphony:v1:" + digest("a"),
    verify_issue_id: "issue:verify:1",
    verify_issue_revision: "symphony:v1:" + digest("d"),
    cycle_specification_markdown: "# Cycle\n\nUse the sealed Verify directives.",
    verify_instruction_markdown: "Verify every sealed directive exactly once.",
    revision: digest("e"),
  } as const;
  assert.equal(parseVerifyRequest(verify).verify_issue_id, "issue:verify:1");
  assert.throws(() => parseVerifyRequest({ ...verify, work_results: [] }), /invalid_contract_keys/u);
});

test("Work turn keeps ephemeral continuation separate from the persistable completion candidate", () => {
  const request = parseWorkRequest({
    ...common,
    cycle_revision: "symphony:v1:" + digest("a"),
    work_issue_id: "issue:work:1",
    work_issue_revision: "symphony:v1:" + digest("c"),
    cycle_specification_markdown: "# Cycle\n\nUse the sealed Work groups.",
    work_instruction_markdown: "Implement only this Work instruction.",
  });
  const envelope = {
    ...common,
    input_request_digest: canonicalPerformerRequestDigest(request),
  } as const;
  const candidate = {
    work_issue_id: request.work_issue_id,
    workspace_changed: true,
    checks: [{ check: "focused tests", status: "passed", sanitized_summary_markdown: "All passed." }],
    outcome: "completed",
  } as const;
  const turn = parseWorkTurnResult({
    ...envelope,
    completion_candidate: candidate,
    ephemeral_continuation_markdown: "Continue with the same live Work thread context.",
  }, request, true);
  assert.equal(turn.completion_candidate.outcome, "completed");
  assert.equal(turn.ephemeral_continuation_markdown?.startsWith("Continue"), true);

  const persisted = parseWorkResult({ ...envelope, ...candidate }, request);
  assert.equal("ephemeral_continuation_markdown" in persisted, false);
  assert.throws(() => parseWorkResult({
    ...persisted,
    ephemeral_continuation_markdown: turn.ephemeral_continuation_markdown,
  }, request), /invalid_contract_keys/u);
  assert.throws(() => parseWorkTurnResult({
    ...envelope,
    completion_candidate: candidate,
    ephemeral_continuation_markdown: "Continuation is not allowed after the final Work.",
  }, request, false), /ephemeral_continuation_forbidden/u);
});
