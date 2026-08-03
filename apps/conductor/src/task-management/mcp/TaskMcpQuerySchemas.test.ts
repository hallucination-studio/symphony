import assert from "node:assert/strict";
import test from "node:test";

import { parseRootIssueId, parseRuntimeGeneration } from "../../contracts/identity.js";
import { canonicalTaskRevision } from "../../contracts/task-management.js";
import {
  TASK_MCP_CAPABILITIES,
  parseTaskMcpCall,
  parseTaskMcpResult,
} from "./TaskMcpSchemas.js";

const target = {
  root_id: parseRootIssueId("LIN-1"),
  runtime_generation: parseRuntimeGeneration(4),
};

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

const issueFields = {
  issue_id: "LIN-2",
  provider_created_at: "2026-08-03T00:00:00.000Z",
  provider_updated_at: "2026-08-03T00:00:00.000Z",
  creation_actor_id: "actor:1",
  kind: "work",
  status_id: "state:todo",
  status: "Todo",
  title: "Implement query contracts",
  description_markdown: null,
  parent_issue_id: "LIN-1",
  label_ids: ["label:work"],
  delegate_id: "actor:1",
  priority: 2,
  archived: false,
  trashed: false,
} as const;
const issue = { ...issueFields, revision: canonicalTaskRevision(issueFields) };

test("get_issue has a closed identity-bound call and result schema", () => {
  const call = parseTaskMcpCall({
    ...envelope("get_issue"),
    input: { issue_id: "LIN-2" },
  }, target);
  if (call.function !== "get_issue") assert.fail("expected get_issue call");
  const result = parseTaskMcpResult({
    ...envelope("get_issue"),
    output: { issue },
  }, call);

  assert.equal(call.function, "get_issue");
  assert.equal(result.output.issue?.issue_id, "LIN-2");
  assert.ok(Object.isFrozen(result));
  assert.throws(() => parseTaskMcpCall({
    ...envelope("get_issue"),
    capability: "task_manage:list_issues",
    input: { issue_id: "LIN-2" },
  }, target), /capability_mismatch/u);
  assert.throws(() => parseTaskMcpResult({
    ...envelope("get_issue"),
    correlation_id: "corr:other",
    output: { issue },
  }, call), /correlation_mismatch/u);
});

test("every list query requires explicit cursor pagination and returns a bounded page", () => {
  const cases = [
    {
      function: "list_issues" as const,
      input: { cursor: null, page_size: 50 },
      output: { issues: [issue], next_cursor: "cursor:2" },
    },
    {
      function: "list_children" as const,
      input: { parent_issue_id: "LIN-1", cursor: null, page_size: 50 },
      output: { issues: [issue], next_cursor: null },
    },
    {
      function: "list_relations" as const,
      input: { issue_id: "LIN-2", cursor: null, page_size: 50 },
      output: {
        relations: [{
          relation_id: "relation:1",
          revision: canonicalTaskRevision({
            relation_id: "relation:1", provider_created_at: "2026-08-03T00:00:00.000Z",
            provider_updated_at: "2026-08-03T00:00:00.000Z", creation_actor_id: "actor:1",
            creation_evidence_id: "evidence:relation:1", type: "blocks",
            source_issue_id: "LIN-2", target_issue_id: "LIN-3",
          }),
          provider_created_at: "2026-08-03T00:00:00.000Z",
          provider_updated_at: "2026-08-03T00:00:00.000Z",
          creation_actor_id: "actor:1",
          creation_evidence_id: "evidence:relation:1",
          type: "blocks",
          source_issue_id: "LIN-2",
          target_issue_id: "LIN-3",
        }],
        next_cursor: null,
      },
    },
    {
      function: "list_states" as const,
      input: { cursor: null, page_size: 50 },
      output: {
        states: [{ state_id: "state:todo", revision: "revision:state:1", name: "Todo", archived: false }],
        next_cursor: null,
      },
    },
    {
      function: "list_labels" as const,
      input: { cursor: null, page_size: 50 },
      output: {
        labels: [{ label_id: "label:work", revision: "revision:label:1", name: "Work" }],
        next_cursor: null,
      },
    },
  ];

  for (const entry of cases) {
    const call = parseTaskMcpCall({ ...envelope(entry.function), input: entry.input }, target);
    const result = parseTaskMcpResult({ ...envelope(entry.function), output: entry.output }, call);
    assert.equal(result.function, entry.function);
    assert.ok(Object.isFrozen(result.output));
    assert.throws(() => parseTaskMcpCall({
      ...envelope(entry.function),
      input: { ...entry.input, cursor: undefined },
    }, target), /invalid_/u);
  }
});

test("query schemas reject stale generations, unknown functions, and metadata bags", () => {
  assert.throws(() => parseTaskMcpCall({
    ...envelope("list_issues"),
    runtime_generation: 3,
    input: { cursor: null, page_size: 50 },
  }, target), /stale_generation/u);
  assert.throws(() => parseTaskMcpCall({
    ...envelope("list_issues"),
    function: "linear_search_issues",
    capability: "task_manage:linear_search_issues",
    input: { cursor: null, page_size: 50 },
  }, target), /invalid_contract_variant/u);
  assert.throws(() => parseTaskMcpCall({
    ...envelope("list_issues"),
    input: { cursor: null, page_size: 50, metadata: {} },
  }, target), /invalid_contract_keys/u);
  assert.throws(() => parseTaskMcpCall({
    ...envelope("list_issues"),
    input: { cursor: null, page_size: 101 },
  }, target), /invalid_page_size/u);
});
