import assert from "node:assert/strict";
import test from "node:test";

import { parseRootIssueId, parseRuntimeGeneration } from "../../contracts/identity.js";
import { parseTaskMcpCall, parseTaskMcpResult, type TaskMcpMutationCall } from "../mcp/TaskMcpSchemas.js";
import { LinearCommands, type LinearCommandClient } from "./LinearCommands.js";

const TEAM_ID = "team:1";
const target = { root_id: parseRootIssueId("root-1"), runtime_generation: parseRuntimeGeneration(1) };
const ACTIVE_EXECUTION = Object.freeze({ assertActive: () => undefined });

function issue(id: string, revision: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    revision,
    team_id: TEAM_ID,
    parent_id: id === "root-1" ? null : "root-1",
    status: "state:todo",
    title: `Issue ${id}`,
    description: null,
    labels: ["label:work"],
    delegate_id: "actor:1",
    priority: 2,
    archived: false,
    ...overrides,
  };
}

function relation(id: string, revision: string) {
  return {
    id,
    revision,
    type: "blocks",
    source_issue_id: "source-1",
    target_issue_id: "target-1",
  };
}

function page(nodes: readonly unknown[], endCursor: string | null = null) {
  return { nodes, page_info: { has_next_page: endCursor !== null, end_cursor: endCursor } };
}

class FakeCommandClient implements LinearCommandClient {
  readonly issueReads = new Map<string, unknown[]>();
  readonly relationReads = new Map<string, unknown[]>();
  readonly effects: Array<{ readonly kind: string; readonly input: unknown }> = [];
  response: unknown = { success: true };
  failure: unknown = null;

  enqueueIssue(id: string, ...values: unknown[]) { this.issueReads.set(id, values); }
  enqueueRelations(id: string, ...values: unknown[]) { this.relationReads.set(id, values); }

  async readIssue(issueId: string) {
    const value = this.issueReads.get(issueId)?.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error("missing_issue_fixture");
    return value;
  }

  async listRelations(issueId: string) {
    const value = this.relationReads.get(issueId)?.shift();
    if (value instanceof Error) throw value;
    return value ?? page([]);
  }

  createIssue(input: unknown) { return this.#effect("create_issue", input); }
  updateIssue(issueId: string, input: unknown) { return this.#effect("update_issue", { issue_id: issueId, input }); }
  archiveIssue(issueId: string) { return this.#effect("archive_issue", { issue_id: issueId }); }
  createRelation(input: unknown) { return this.#effect("create_relation", input); }
  deleteRelation(relationId: string) { return this.#effect("delete_relation", { relation_id: relationId }); }

  async #effect(kind: string, input: unknown) {
    this.effects.push({ kind, input });
    if (this.failure !== null) throw this.failure;
    return this.response;
  }
}

function mutationCall(functionName: TaskMcpMutationCall["function"], input: unknown): TaskMcpMutationCall {
  const parsed = parseTaskMcpCall({
    schema_version: 1,
    function: functionName,
    root_id: "root-1",
    runtime_generation: 1,
    correlation_id: `corr:${functionName}`,
    capability: `task_manage:${functionName}`,
    input,
  }, target);
  if (
    parsed.function === "get_issue" || parsed.function === "list_issues" || parsed.function === "list_children"
    || parsed.function === "list_relations" || parsed.function === "list_states" || parsed.function === "list_labels"
  ) assert.fail("expected mutation call");
  return parsed;
}

const calls = {
  createIssue: mutationCall("create_issue", {
    parent_issue_id: "root-1",
    expected_parent_revision: "revision:parent:1",
    desired: {
      title: "New issue",
      description: "Body",
      state_id: "state:todo",
      label_ids: ["label:work"],
      delegate_id: "actor:1",
      priority: 2,
    },
  }),
  updateIssue: mutationCall("update_issue", {
    issue_id: "issue-1",
    expected_revision: "revision:issue:1",
    desired: {
      title: "Updated",
      description: "New body",
      state_id: "state:doing",
      parent_id: "parent-2",
      label_ids: ["label:work", "label:urgent"],
      delegate_id: null,
      priority: 1,
    },
  }),
  archiveIssue: mutationCall("archive_issue", {
    issue_id: "issue-1",
    expected_revision: "revision:issue:1",
  }),
  createRelation: mutationCall("create_relation", {
    relation_type: "blocks",
    source_issue_id: "source-1",
    expected_source_revision: "revision:source:1",
    target_issue_id: "target-1",
    expected_target_revision: "revision:target:1",
  }),
  deleteRelation: mutationCall("delete_relation", {
    relation_id: "relation-1",
    expected_relation_revision: "revision:relation:1",
    source_issue_id: "source-1",
    expected_source_revision: "revision:source:1",
    target_issue_id: "target-1",
    expected_target_revision: "revision:target:1",
  }),
} as const;

function commands(client: FakeCommandClient, identities: string[] = []) {
  return new LinearCommands(client, { team_id: TEAM_ID }, () => identities.shift() ?? "identity-missing");
}

test("all five generic mutations apply one exact effect after fresh preconditions and exact read-back", async () => {
  const cases: Array<{
    call: TaskMcpMutationCall;
    ids?: string[];
    arrange(client: FakeCommandClient): void;
    expectedEffect: unknown;
    expectedTarget: unknown;
  }> = [
    {
      call: calls.createIssue,
      ids: ["new-issue-1"],
      arrange(client) {
        client.enqueueIssue("root-1", issue("root-1", "revision:parent:1"));
        client.enqueueIssue("new-issue-1", issue("new-issue-1", "revision:new:1", {
          title: "New issue", description: "Body", status: "state:todo", parent_id: "root-1",
        }));
      },
      expectedEffect: {
        id: "new-issue-1", team_id: TEAM_ID, parent_issue_id: "root-1", title: "New issue",
        description: "Body", state_id: "state:todo", label_ids: ["label:work"], delegate_id: "actor:1", priority: 2,
      },
      expectedTarget: { kind: "issue", issue_id: "new-issue-1" },
    },
    {
      call: calls.updateIssue,
      arrange(client) {
        client.enqueueIssue("issue-1",
          issue("issue-1", "revision:issue:1"),
          issue("issue-1", "revision:issue:2", {
            title: "Updated", description: "New body", status: "state:doing", parent_id: "parent-2",
            labels: ["label:work", "label:urgent"], delegate_id: null, priority: 1,
          }));
      },
      expectedEffect: {
        issue_id: "issue-1",
        input: {
          title: "Updated", description: "New body", state_id: "state:doing", parent_issue_id: "parent-2",
          label_ids: ["label:work", "label:urgent"], delegate_id: null, priority: 1,
        },
      },
      expectedTarget: { kind: "issue", issue_id: "issue-1" },
    },
    {
      call: calls.archiveIssue,
      arrange(client) {
        client.enqueueIssue("issue-1",
          issue("issue-1", "revision:issue:1"),
          issue("issue-1", "revision:issue:2", { archived: true }));
      },
      expectedEffect: { issue_id: "issue-1" },
      expectedTarget: { kind: "issue", issue_id: "issue-1" },
    },
    {
      call: calls.createRelation,
      ids: ["new-relation-1"],
      arrange(client) {
        client.enqueueIssue("source-1", issue("source-1", "revision:source:1"));
        client.enqueueIssue("target-1", issue("target-1", "revision:target:1"));
        client.enqueueRelations("source-1", page([{
          ...relation("new-relation-1", "revision:new-relation:1"), id: "new-relation-1",
        }]));
      },
      expectedEffect: {
        id: "new-relation-1", type: "blocks", source_issue_id: "source-1", target_issue_id: "target-1",
      },
      expectedTarget: {
        kind: "relation", relation_id: "new-relation-1", source_issue_id: "source-1", target_issue_id: "target-1",
      },
    },
    {
      call: calls.deleteRelation,
      arrange(client) {
        client.enqueueIssue("source-1", issue("source-1", "revision:source:1"));
        client.enqueueIssue("target-1", issue("target-1", "revision:target:1"));
        client.enqueueRelations("source-1", page([relation("relation-1", "revision:relation:1")]), page([]));
      },
      expectedEffect: { relation_id: "relation-1" },
      expectedTarget: {
        kind: "relation", relation_id: "relation-1", source_issue_id: "source-1", target_issue_id: "target-1",
      },
    },
  ];

  for (const entry of cases) {
    const client = new FakeCommandClient();
    entry.arrange(client);
    const result = await commands(client, entry.ids).execute(entry.call, ACTIVE_EXECUTION);
    assert.equal(result.output.outcome, "applied", entry.call.function);
    assert.deepEqual(result.output.target, entry.expectedTarget);
    assert.equal(result.output.concrete_diff.length > 0, true);
    assert.equal(result.output.sanitized_reason, null);
    assert.deepEqual(client.effects, [{ kind: entry.call.function, input: entry.expectedEffect }]);
    assert.deepEqual(parseTaskMcpResult(result, entry.call), result);
  }
});

test("fresh revision mismatches return ordinary precondition_failed results before every effect", async () => {
  for (const call of Object.values(calls)) {
    const client = new FakeCommandClient();
    if (call.function === "create_issue") {
      client.enqueueIssue("root-1", issue("root-1", "revision:stale"));
    } else if (call.function === "update_issue" || call.function === "archive_issue") {
      client.enqueueIssue("issue-1", issue("issue-1", "revision:stale"));
    } else {
      client.enqueueIssue("source-1", issue("source-1", "revision:stale"));
      client.enqueueIssue("target-1", issue("target-1", "revision:target:1"));
    }
    const result = await commands(client, ["unused-id"]).execute(call, ACTIVE_EXECUTION);
    assert.equal(result.output.outcome, "precondition_failed", call.function);
    assert.equal(result.output.sanitized_reason, "fresh_precondition_mismatch");
    assert.deepEqual(client.effects, []);
  }
});

test("provider acknowledgement and exact read-back produce all five closed outcomes without retry", async () => {
  const cases: Array<{
    name: string;
    beforeRevision: string;
    response?: unknown;
    failure?: unknown;
    after?: unknown;
    outcome: "applied" | "not_applied" | "precondition_failed" | "acceptance_unknown" | "readback_mismatch";
  }> = [
    { name: "applied", beforeRevision: "revision:issue:1", after: issue("issue-1", "revision:2", {
      title: "Updated", description: "New body", status: "state:doing", parent_id: "parent-2",
      labels: ["label:work", "label:urgent"], delegate_id: null, priority: 1,
    }), outcome: "applied" },
    { name: "not applied", beforeRevision: "revision:issue:1", response: { success: false },
      after: issue("issue-1", "revision:issue:1"), outcome: "not_applied" },
    { name: "precondition", beforeRevision: "revision:stale", outcome: "precondition_failed" },
    { name: "unknown", beforeRevision: "revision:issue:1", failure: new Error("provider-secret"),
      after: issue("issue-1", "revision:issue:1"), outcome: "acceptance_unknown" },
    { name: "mismatch", beforeRevision: "revision:issue:1", response: { success: true },
      after: issue("issue-1", "revision:issue:1"), outcome: "readback_mismatch" },
  ];

  for (const entry of cases) {
    const client = new FakeCommandClient();
    client.enqueueIssue("issue-1", issue("issue-1", entry.beforeRevision), ...(entry.after === undefined ? [] : [entry.after]));
    if (entry.response !== undefined) client.response = entry.response;
    if (entry.failure !== undefined) client.failure = entry.failure;
    const result = await commands(client).execute(calls.updateIssue, ACTIVE_EXECUTION);
    assert.equal(result.output.outcome, entry.outcome, entry.name);
    assert.equal(client.effects.length, entry.outcome === "precondition_failed" ? 0 : 1);
    assert.equal(JSON.stringify(result).includes("provider-secret"), false);
  }
});

test("an uncertain provider call is accepted only from same-identity read-back and is never retried", async () => {
  const client = new FakeCommandClient();
  client.enqueueIssue("issue-1",
    issue("issue-1", "revision:issue:1"),
    issue("issue-1", "revision:2", {
      title: "Updated", description: "New body", status: "state:doing", parent_id: "parent-2",
      labels: ["label:work", "label:urgent"], delegate_id: null, priority: 1,
    }));
  client.failure = new Error("Authorization provider-secret");

  const result = await commands(client).execute(calls.updateIssue, ACTIVE_EXECUTION);

  assert.equal(result.output.outcome, "applied");
  assert.equal(client.effects.length, 1);
  assert.equal(JSON.stringify(result).includes("provider-secret"), false);

  const unavailable = new FakeCommandClient();
  unavailable.enqueueIssue("issue-1", issue("issue-1", "revision:issue:1"), new Error("readback-secret"));
  const unknown = await commands(unavailable).execute(calls.updateIssue, ACTIVE_EXECUTION);
  assert.equal(unknown.output.outcome, "acceptance_unknown");
  assert.equal(unavailable.effects.length, 1);
  assert.equal(JSON.stringify(unknown).includes("readback-secret"), false);
});

test("revocation after fresh preconditions fences the provider effect", async () => {
  const client = new FakeCommandClient();
  let resolvePrecondition: ((value: unknown) => void) | null = null;
  client.enqueueIssue("issue-1", new Promise((resolve) => { resolvePrecondition = resolve; }));
  let active = true;
  const pending = commands(client).execute(calls.updateIssue, {
    assertActive: () => {
      if (!active) throw new Error("canceled");
    },
  });

  active = false;
  (resolvePrecondition as ((value: unknown) => void) | null)?.(issue("issue-1", "revision:issue:1"));

  await assert.rejects(pending, /canceled/u);
  assert.deepEqual(client.effects, []);
});

test("relation preconditions scan every bounded page and reject duplicate or foreign identities before effect", async () => {
  for (const pages of [
    [page([relation("relation-1", "revision:relation:1")], "next"), page([relation("relation-1", "revision:relation:1")])],
    [page([{
      ...relation("relation-1", "revision:relation:1"),
      source_issue_id: "foreign-1",
      target_issue_id: "foreign-2",
    }])],
  ]) {
    const client = new FakeCommandClient();
    client.enqueueIssue("source-1", issue("source-1", "revision:source:1"));
    client.enqueueIssue("target-1", issue("target-1", "revision:target:1"));
    client.enqueueRelations("source-1", ...pages);

    const result = await commands(client).execute(calls.deleteRelation, ACTIVE_EXECUTION);

    assert.equal(result.output.outcome, "not_applied");
    assert.equal(result.output.sanitized_reason, "fresh_precondition_unavailable");
    assert.deepEqual(client.effects, []);
  }
});

test("update read-back reports concurrent non-desired field changes in the concrete diff", async () => {
  const call = mutationCall("update_issue", {
    issue_id: "issue-1",
    expected_revision: "revision:issue:1",
    desired: { title: "Updated" },
  });
  const client = new FakeCommandClient();
  client.enqueueIssue("issue-1",
    issue("issue-1", "revision:issue:1"),
    issue("issue-1", "revision:issue:2", { title: "Updated", delegate_id: "actor:other" }));

  const result = await commands(client).execute(call, ACTIVE_EXECUTION);

  assert.equal(result.output.outcome, "applied");
  assert.deepEqual(result.output.concrete_diff.map((change) => "field" in change ? change.field : change.kind), [
    "title",
    "delegate",
  ]);
});

test("Linear no-priority normalization and malformed receipts remain closed", async () => {
  const noPriorityCall = mutationCall("update_issue", {
    issue_id: "issue-1",
    expected_revision: "revision:issue:1",
    desired: { priority: 0 },
  });
  const noPriority = new FakeCommandClient();
  noPriority.enqueueIssue("issue-1",
    issue("issue-1", "revision:issue:1"),
    issue("issue-1", "revision:issue:2", { priority: null }));
  assert.equal(
    (await commands(noPriority).execute(noPriorityCall, ACTIVE_EXECUTION)).output.outcome,
    "applied",
  );

  const malformed = new FakeCommandClient();
  malformed.response = { success: "yes", provider_secret: "do-not-return" };
  malformed.enqueueIssue("issue-1",
    issue("issue-1", "revision:issue:1"),
    issue("issue-1", "revision:issue:1"));
  const result = await commands(malformed).execute(calls.updateIssue, ACTIVE_EXECUTION);
  assert.equal(result.output.outcome, "readback_mismatch");
  assert.equal(JSON.stringify(result).includes("do-not-return"), false);
  assert.equal(malformed.effects.length, 1);
});
