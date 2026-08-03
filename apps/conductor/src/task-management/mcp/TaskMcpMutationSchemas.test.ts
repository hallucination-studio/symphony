import assert from "node:assert/strict";
import test from "node:test";

import { parseRootIssueId, parseRuntimeGeneration } from "../../contracts/identity.js";
import {
  TASK_MCP_CAPABILITIES,
  parseTaskMcpCall,
  parseTaskMcpResult,
} from "./TaskMcpSchemas.js";

const target = {
  root_id: parseRootIssueId("LIN-1"),
  runtime_generation: parseRuntimeGeneration(4),
};
const ISSUE_UUID = "11111111-1111-4111-8111-111111111111";
const RELATION_UUID = "22222222-2222-4222-8222-222222222222";
const COMMENT_UUID = "33333333-3333-4333-8333-333333333333";

function envelope(functionName: keyof typeof TASK_MCP_CAPABILITIES) {
  return {
    schema_version: 1,
    function: functionName,
    root_id: "LIN-1",
    runtime_generation: 4,
    correlation_id: `corr:${functionName}`,
    capability: TASK_MCP_CAPABILITIES[functionName],
  };
}

const issue = {
  issue_id: "LIN-2",
  revision: "revision:2",
  status: "state:todo",
  title: "Implement mutation contracts",
  description: null,
  parent_id: "LIN-1",
  labels: ["label:work"],
  delegate_id: "actor:1",
  priority: 2,
};

const relation = {
  relation_id: RELATION_UUID,
  revision: "revision:relation:1",
  type: "blocks",
  source_issue_id: "LIN-2",
  target_issue_id: "LIN-3",
};

test("all five mutation calls require exact fresh preconditions", () => {
  const cases = [
    {
      function: "create_issue" as const,
      requiredPreconditions: ["expected_parent_revision"],
      input: {
        issue_id: ISSUE_UUID,
        parent_issue_id: "LIN-1",
        expected_parent_revision: "revision:root:1",
        desired: {
          title: "New issue",
          description: null,
          state_id: "state:todo",
          label_ids: ["label:work"],
          delegate_id: "actor:1",
          priority: 2,
        },
      },
    },
    {
      function: "update_issue" as const,
      requiredPreconditions: ["expected_revision"],
      input: {
        issue_id: "LIN-2",
        expected_revision: "revision:2",
        desired: { title: "Updated title" },
      },
    },
    {
      function: "archive_issue" as const,
      requiredPreconditions: ["expected_revision"],
      input: { issue_id: "LIN-2", expected_revision: "revision:2" },
    },
    {
      function: "create_relation" as const,
      requiredPreconditions: ["expected_source_revision", "expected_target_revision"],
      input: {
        relation_id: RELATION_UUID,
        relation_type: "blocks",
        source_issue_id: "LIN-2",
        expected_source_revision: "revision:2",
        target_issue_id: "LIN-3",
        expected_target_revision: "revision:3",
      },
    },
    {
      function: "delete_relation" as const,
      requiredPreconditions: [
        "expected_relation_revision",
        "expected_source_revision",
        "expected_target_revision",
      ],
      input: {
        relation_id: "relation:1",
        expected_relation_revision: "revision:relation:1",
        source_issue_id: "LIN-2",
        expected_source_revision: "revision:2",
        target_issue_id: "LIN-3",
        expected_target_revision: "revision:3",
      },
    },
  ];

  for (const entry of cases) {
    const call = parseTaskMcpCall({ ...envelope(entry.function), input: entry.input }, target);
    assert.equal(call.function, entry.function);

    for (const precondition of entry.requiredPreconditions) {
      const withoutPrecondition = { ...entry.input } as Record<string, unknown>;
      delete withoutPrecondition[precondition];
      assert.throws(
        () => parseTaskMcpCall({ ...envelope(entry.function), input: withoutPrecondition }, target),
        /invalid_contract_keys/u,
      );
    }
  }
});

test("create_issue_comment binds an exact absent record to one fresh issue basis", () => {
  const input = {
    comment_id: COMMENT_UUID,
    issue_id: "LIN-2",
    expected_issue_revision: "revision:2",
    body_markdown: "<!-- symphony:record -->\n{\"record_kind\":\"stage_completion\"}",
  };
  const call = parseTaskMcpCall({
    schema_version: 1,
    function: "create_issue_comment",
    root_id: "LIN-1",
    runtime_generation: 4,
    correlation_id: "corr:create-comment",
    capability: "task_manage:create_issue_comment",
    input,
  }, target);

  assert.deepEqual(call.input, input);
  for (const forbidden of [
    { ...input, created_at: "2026-07-30T00:00:00.000Z" },
    { ...input, comment_id: "comment:generated-by-provider" },
    { ...input, expected_comment_revision: "revision:comment:0" },
  ]) {
    assert.throws(() => parseTaskMcpCall({
      schema_version: 1,
      function: "create_issue_comment",
      root_id: "LIN-1",
      runtime_generation: 4,
      correlation_id: "corr:create-comment",
      capability: "task_manage:create_issue_comment",
      input: forbidden,
    }, target));
  }
});

test("update_issue is a strict non-empty partial update", () => {
  const base = {
    ...envelope("update_issue"),
    input: { issue_id: "LIN-2", expected_revision: "revision:2", desired: { title: "Updated" } },
  };
  assert.equal(parseTaskMcpCall(base, target).function, "update_issue");
  assert.throws(
    () => parseTaskMcpCall({ ...base, input: { ...base.input, desired: {} } }, target),
    /empty_issue_update/u,
  );
  assert.throws(
    () => parseTaskMcpCall({ ...base, input: { ...base.input, desired: { title: "A", priority: 2 } } }, target),
    /compound_issue_update/u,
  );
  assert.throws(
    () => parseTaskMcpCall({ ...base, input: { ...base.input, desired: { lifecycle: "Done" } } }, target),
    /invalid_contract_keys/u,
  );
  assert.throws(
    () => parseTaskMcpCall({ ...base, input: { ...base.input, desired: { title: "A", metadata: {} } } }, target),
    /invalid_contract_keys/u,
  );
});

test("mutation results expose exact no-CAS outcomes with effect ambiguity", () => {
  const call = parseTaskMcpCall({
    ...envelope("update_issue"),
    input: { issue_id: "LIN-2", expected_revision: "revision:2", desired: { title: "Updated" } },
  }, target);
  if (call.function !== "update_issue") assert.fail("expected update_issue call");

  const applied = {
    ...envelope("update_issue"),
    output: {
      outcome: "applied",
      effect_may_have_occurred: true,
      target: { kind: "issue", issue_id: "LIN-2" },
      fresh_resource: { ...issue, title: "Updated", revision: "revision:3" },
      concrete_diff: [{ kind: "field_changed", issue_id: "LIN-2", field: "title", before: issue.title, after: "Updated" }],
      sanitized_reason: null,
    },
  };
  assert.equal(parseTaskMcpResult(applied, call).output.outcome, "applied");

  for (const outcome of ["not_applied", "stale_before_effect", "conflict_observed"] as const) {
    assert.equal(parseTaskMcpResult({
      ...envelope("update_issue"),
      output: {
        outcome,
        effect_may_have_occurred: outcome === "conflict_observed",
        target: { kind: "issue", issue_id: "LIN-2" },
        fresh_resource: outcome === "stale_before_effect" ? issue : null,
        concrete_diff: [],
        sanitized_reason: "fresh read did not confirm the requested effect",
      },
    }, call).output.outcome, outcome);
  }

  assert.throws(() => parseTaskMcpResult({
    ...applied,
    output: { ...applied.output, provider_receipt: { id: "raw" } },
  }, call), /invalid_contract_keys/u);
  assert.throws(() => parseTaskMcpResult({
    ...applied,
    output: { ...applied.output, concrete_diff: [] },
  }, call), /applied_without_concrete_diff/u);
});

test("relation mutation results bind relation identity and endpoint identities", () => {
  const call = parseTaskMcpCall({
    ...envelope("create_relation"),
    input: {
      relation_id: RELATION_UUID,
      relation_type: "blocks",
      source_issue_id: "LIN-2",
      expected_source_revision: "revision:2",
      target_issue_id: "LIN-3",
      expected_target_revision: "revision:3",
    },
  }, target);
  if (call.function !== "create_relation") assert.fail("expected create_relation call");
  const result = parseTaskMcpResult({
    ...envelope("create_relation"),
    output: {
      outcome: "applied",
      effect_may_have_occurred: true,
      target: {
        kind: "relation",
        relation_id: RELATION_UUID,
        source_issue_id: "LIN-2",
        target_issue_id: "LIN-3",
      },
      fresh_resource: relation,
      concrete_diff: [{ kind: "relation_added", relation }],
      sanitized_reason: null,
    },
  }, call);
  assert.equal(result.output.target.kind, "relation");
  assert.throws(() => parseTaskMcpCall({
    ...envelope("create_relation"),
    input: { ...call.input, target_issue_id: "LIN-2" },
  }, target), /self_task_relation/u);
});
