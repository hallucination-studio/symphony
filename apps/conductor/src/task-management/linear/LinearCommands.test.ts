import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseRootIssueId, parseRuntimeGeneration } from "../../contracts/identity.js";
import {
  canonicalTaskRevision,
  parseTaskIssueSnapshotChange,
  type TaskIssueSnapshot,
} from "../../contracts/task-management.js";
import {
  parseTaskMcpCall,
  parseTaskMcpResult,
  type CreateIssueCommentCall,
  type TaskMcpMutationCall,
} from "../mcp/TaskMcpSchemas.js";
import { LinearCommands, type LinearCommandClient } from "./LinearCommands.js";
import type {
  LinearIssueCommentEvidence,
  LinearIssueHistoryEvidence,
} from "./LinearQueries.js";

const TEAM_ID = "team:1";
const ISSUE_UUID = "11111111-1111-4111-8111-111111111111";
const RELATION_UUID = "22222222-2222-4222-8222-222222222222";
const target = { root_id: parseRootIssueId("root-1"), runtime_generation: parseRuntimeGeneration(1) };
const ACTIVE_EXECUTION = Object.freeze({ assertActive: () => undefined });

function issueTimestamp(token: string): string {
  const offset = Number.parseInt(createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8), 16);
  return new Date(Date.parse("2026-07-30T00:00:00.000Z") + (offset % 86_400_000)).toISOString();
}

function issue(id: string, revisionToken: string, overrides: Record<string, unknown> = {}): TaskIssueSnapshot {
  const kind = (overrides.kind ?? (id === "root-1" ? "root" : "work")) as TaskIssueSnapshot["kind"];
  const statusId = String(overrides.status_id ?? overrides.status ?? "state:todo");
  const statusById: Record<string, TaskIssueSnapshot["status"]> = {
    "state:todo": "Todo",
    "state:done": "Done",
    "state:in-progress": "In Progress",
  };
  const fields = {
    issue_id: id,
    provider_created_at: "2026-07-30T00:00:00.000Z",
    provider_updated_at: String(overrides.provider_updated_at ?? issueTimestamp(revisionToken)),
    creation_actor_id: String(overrides.creator_id ?? "actor:1"),
    kind,
    status_id: statusId,
    status: statusById[statusId] ?? "Todo",
    title: String(overrides.title ?? `Issue ${id}`),
    description_markdown: overrides.description === null || overrides.description === undefined
      ? "# Empty"
      : String(overrides.description),
    parent_issue_id: (overrides.parent_id === undefined
      ? (id === "root-1" ? null : "root-1")
      : overrides.parent_id) as string | null,
    label_ids: (overrides.labels ?? [`label:${kind}`]) as readonly string[],
    delegate_id: (overrides.delegate_id === undefined ? "actor:1" : overrides.delegate_id) as string | null,
    priority: (overrides.priority === undefined ? 2 : overrides.priority) as number | null,
    archived: Boolean(overrides.archived ?? false),
    trashed: Boolean(overrides.trashed ?? false),
  };
  return parseTaskIssueSnapshotChange({ ...fields, revision: canonicalTaskRevision(fields) });
}

function relation(id: string, _revisionToken: string) {
  return {
    id,
    revision: _revisionToken,
    type: "blocks",
    source_issue_id: "source-1",
    target_issue_id: "target-1",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    archived: false,
  };
}

const ISSUE_REVISION_1 = issue("issue-1", "revision:issue:1").revision;
const ISSUE_REVISION_2 = issue("issue-1", "revision:issue:2", { title: "Updated" }).revision;
const ROOT_REVISION = issue("root-1", "revision:parent:1").revision;
const SOURCE_REVISION = issue("source-1", "revision:source:1").revision;
const TARGET_REVISION = issue("target-1", "revision:target:1").revision;
const RELATION_REVISION = canonicalTaskRevision({
  relation_id: "relation-1",
  provider_created_at: "2026-07-30T00:00:00.000Z",
  provider_updated_at: "2026-07-30T00:00:00.000Z",
  creation_actor_id: "actor:1",
  creation_evidence_id: "linear:relation:relation-1",
  type: "blocks",
  source_issue_id: "source-1",
  target_issue_id: "target-1",
});

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

  async readIssueSnapshot(issueId: string): Promise<TaskIssueSnapshot | null> {
    const value = this.issueReads.get(issueId)?.shift();
    const resolved = await value;
    if (resolved instanceof Error) throw resolved;
    if (resolved === undefined) throw new Error("missing_issue_fixture");
    return resolved === null ? null : resolved as TaskIssueSnapshot;
  }

  async getIssue(issueId: string) {
    const value = this.issueReads.get(issueId)?.shift();
    if (value instanceof Error) throw value;
    return value ?? null;
  }

  async listRelations(issueId: string) {
    const value = this.relationReads.get(issueId)?.shift();
    if (value instanceof Error) throw value;
    return value ?? page([]);
  }

  createIssue(input: unknown) { return this.#effect("create_issue", input); }
  createIssueComment(input: unknown) { return this.#effect("create_issue_comment", input); }
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

class FakeEvidenceReader {
  #issueSource: ((issueId: string) => Promise<TaskIssueSnapshot | null>) | null = null;
  readonly historyReads = new Map<string, Array<readonly LinearIssueHistoryEvidence[]>>();
  readonly commentReads = new Map<string, Array<readonly LinearIssueCommentEvidence[]>>();

  enqueueHistory(issueId: string, ...values: Array<readonly LinearIssueHistoryEvidence[]>) {
    this.historyReads.set(issueId, values);
  }

  enqueueComments(issueId: string, ...values: Array<readonly LinearIssueCommentEvidence[]>) {
    this.commentReads.set(issueId, values);
  }

  attachIssueSource(source: (issueId: string) => Promise<TaskIssueSnapshot | null>) {
    this.#issueSource = source;
  }

  readIssueSnapshot(issueId: string): Promise<TaskIssueSnapshot | null> {
    if (this.#issueSource === null) throw new Error("missing_issue_reader");
    return this.#issueSource(issueId);
  }

  async readIssueHistory(issueId: string) {
    return this.historyReads.get(issueId)?.shift() ?? [];
  }

  async readIssueComments(issueId: string) {
    return this.commentReads.get(issueId)?.shift() ?? [];
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
    || parsed.function === "create_issue_comment"
  ) assert.fail("expected mutation call");
  return parsed;
}

const calls = {
  createIssue: mutationCall("create_issue", {
    issue_id: ISSUE_UUID,
    parent_issue_id: "root-1",
    expected_parent_revision: ROOT_REVISION,
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
    expected_revision: ISSUE_REVISION_1,
    desired: { title: "Updated" },
  }),
  archiveIssue: mutationCall("archive_issue", {
    issue_id: "issue-1",
    expected_revision: ISSUE_REVISION_1,
  }),
  createRelation: mutationCall("create_relation", {
    relation_id: RELATION_UUID,
    relation_type: "blocks",
    source_issue_id: "source-1",
    expected_source_revision: SOURCE_REVISION,
    target_issue_id: "target-1",
    expected_target_revision: TARGET_REVISION,
  }),
  deleteRelation: mutationCall("delete_relation", {
    relation_id: "relation-1",
    expected_relation_revision: RELATION_REVISION,
    source_issue_id: "source-1",
    expected_source_revision: SOURCE_REVISION,
    target_issue_id: "target-1",
    expected_target_revision: TARGET_REVISION,
  }),
} as const;

const COMMENT_BODY = "<!-- symphony:record -->\n{\"record_kind\":\"stage_completion\"}";
const COMMENT_DIGEST = createHash("sha256").update(COMMENT_BODY, "utf8").digest("hex");

const createCommentCall = parseTaskMcpCall({
  schema_version: 1,
  function: "create_issue_comment",
  root_id: "root-1",
  runtime_generation: 1,
  correlation_id: "corr:create-comment",
  capability: "task_manage:create_issue_comment",
  input: {
    comment_id: "33333333-3333-4333-8333-333333333333",
    issue_id: "issue-1",
    expected_issue_revision: ISSUE_REVISION_1,
    body_markdown: COMMENT_BODY,
  },
}, target) as CreateIssueCommentCall;

function commands(client: FakeCommandClient, evidence = new FakeEvidenceReader()) {
  evidence.attachIssueSource((issueId) => client.readIssueSnapshot(issueId));
  return new LinearCommands(client, evidence, { team_id: TEAM_ID, service_actor_id: "actor:1" });
}

test("all five generic mutations apply one exact effect after fresh preconditions and exact read-back", async () => {
  const cases: Array<{
    call: TaskMcpMutationCall;
    arrange(client: FakeCommandClient): void;
    expectedEffect: unknown;
    expectedTarget: unknown;
  }> = [
    {
      call: calls.createIssue,
      arrange(client) {
        client.enqueueIssue("root-1", issue("root-1", "revision:parent:1"));
        client.enqueueIssue(ISSUE_UUID, null, issue(ISSUE_UUID, "revision:new:1", {
          title: "New issue", description: "Body", status: "state:todo", parent_id: "root-1",
        }));
      },
      expectedEffect: {
        id: ISSUE_UUID, team_id: TEAM_ID, parent_issue_id: "root-1", title: "New issue",
        description: "Body", state_id: "state:todo", label_ids: ["label:work"], delegate_id: "actor:1", priority: 2,
      },
      expectedTarget: { kind: "issue", issue_id: ISSUE_UUID },
    },
    {
      call: calls.updateIssue,
      arrange(client) {
        client.enqueueIssue("issue-1",
          issue("issue-1", "revision:issue:1"),
          issue("issue-1", "revision:issue:2", { title: "Updated" }));
      },
      expectedEffect: {
        issue_id: "issue-1",
        input: { title: "Updated" },
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
      arrange(client) {
        client.enqueueIssue("source-1", issue("source-1", "revision:source:1"));
        client.enqueueIssue("target-1", issue("target-1", "revision:target:1"));
        client.enqueueRelations("source-1", page([]), page([{
          ...relation(RELATION_UUID, "revision:new-relation:1"), id: RELATION_UUID,
        }]));
      },
      expectedEffect: {
        id: RELATION_UUID, type: "blocks", source_issue_id: "source-1", target_issue_id: "target-1",
      },
      expectedTarget: {
        kind: "relation", relation_id: RELATION_UUID, source_issue_id: "source-1", target_issue_id: "target-1",
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
    const result = await commands(client).execute(entry.call, ACTIVE_EXECUTION);
    assert.equal(result.output.outcome, "applied", entry.call.function);
    assert.deepEqual(result.output.target, entry.expectedTarget);
    assert.equal(result.output.concrete_diff.length > 0, true);
    assert.equal(result.output.sanitized_reason, null);
    assert.deepEqual(client.effects, [{ kind: entry.call.function, input: entry.expectedEffect }]);
    assert.deepEqual(parseTaskMcpResult(result, entry.call), result);
  }
});

test("comment creation proves exact absence then fresh-reads one immutable service-actor record", async () => {
  const client = new FakeCommandClient();
  client.enqueueIssue("issue-1", issue("issue-1", "revision:issue:1"));
  const evidence = new FakeEvidenceReader();
  evidence.enqueueComments("issue-1", [], [{
    comment_id: createCommentCall.input.comment_id,
    issue_id: "issue-1",
    provider_created_at: "2026-07-30T00:00:01.000Z",
    provider_updated_at: "2026-07-30T00:00:01.000Z",
    provider_edited_at: null,
    provider_archived_at: null,
    actor_id: "actor:1",
    body_digest: COMMENT_DIGEST,
  }]);

  const result = await commands(client, evidence).execute(createCommentCall, ACTIVE_EXECUTION);

  assert.equal(result.output.outcome, "applied");
  assert.deepEqual(result.output.fresh_comment, {
    comment_id: createCommentCall.input.comment_id,
    issue_id: "issue-1",
    provider_created_at: "2026-07-30T00:00:01.000Z",
    provider_updated_at: "2026-07-30T00:00:01.000Z",
    provider_edited_at: null,
    provider_archived_at: null,
    actor_id: "actor:1",
    body_digest: COMMENT_DIGEST,
  });
  assert.deepEqual(client.effects, [{
    kind: "create_issue_comment",
    input: {
      id: createCommentCall.input.comment_id,
      issue_id: "issue-1",
      body_markdown: COMMENT_BODY,
    },
  }]);
});

test("comment creation closes stale, uncertain, and mismatched read-back without retry", async () => {
  const exactComment: LinearIssueCommentEvidence = {
    comment_id: createCommentCall.input.comment_id,
    issue_id: "issue-1",
    provider_created_at: "2026-07-30T00:00:01.000Z",
    provider_updated_at: "2026-07-30T00:00:01.000Z",
    provider_edited_at: null,
    provider_archived_at: null,
    actor_id: "actor:1",
    body_digest: COMMENT_DIGEST,
  };
  const cases = [
    { name: "stale issue", revision: ISSUE_REVISION_2, revisionToken: "revision:issue:2", before: [], after: [], outcome: "stale_before_effect", effects: 0 },
    { name: "identity present", revision: ISSUE_REVISION_1, revisionToken: "revision:issue:1", before: [exactComment], after: [], outcome: "stale_before_effect", effects: 0 },
    { name: "external actor", revision: ISSUE_REVISION_1, revisionToken: "revision:issue:1", before: [], after: [{ ...exactComment, actor_id: "actor:other" }], outcome: "conflict_observed", effects: 1 },
    { name: "edited timestamp", revision: ISSUE_REVISION_1, revisionToken: "revision:issue:1", before: [], after: [{ ...exactComment, provider_updated_at: "2026-07-30T00:00:02.000Z" }], outcome: "conflict_observed", effects: 1 },
  ] as const;
  for (const entry of cases) {
    const client = new FakeCommandClient();
    client.failure = entry.effects === 1 ? new Error("provider_timeout") : null;
    client.enqueueIssue("issue-1", issue("issue-1", entry.revisionToken));
    const evidence = new FakeEvidenceReader();
    evidence.enqueueComments("issue-1", entry.before, entry.after);

    const result = await commands(client, evidence).execute(createCommentCall, ACTIVE_EXECUTION);

    assert.equal(result.output.outcome, entry.outcome, entry.name);
    assert.equal(client.effects.length, entry.effects, entry.name);
  }
});

test("create mutations prove the caller-owned identity absent before provider effects", async () => {
  const existingIssue = new FakeCommandClient();
  existingIssue.enqueueIssue("root-1", issue("root-1", "revision:parent:1"));
  existingIssue.enqueueIssue(ISSUE_UUID, issue(ISSUE_UUID, "revision:existing", {
    title: "New issue", description: "Body", status: "state:todo", parent_id: "root-1",
  }));

  const issueResult = await commands(existingIssue).execute(calls.createIssue, ACTIVE_EXECUTION);
  assert.equal(issueResult.output.outcome, "stale_before_effect");
  assert.equal(issueResult.output.effect_may_have_occurred, false);
  assert.deepEqual(existingIssue.effects, []);

  const existingRelation = new FakeCommandClient();
  existingRelation.enqueueIssue("source-1", issue("source-1", "revision:source:1"));
  existingRelation.enqueueIssue("target-1", issue("target-1", "revision:target:1"));
  existingRelation.enqueueRelations("source-1", page([relation(RELATION_UUID, "revision:existing")]));

  const relationResult = await commands(existingRelation).execute(calls.createRelation, ACTIVE_EXECUTION);
  assert.equal(relationResult.output.outcome, "stale_before_effect");
  assert.equal(relationResult.output.effect_may_have_occurred, false);
  assert.deepEqual(existingRelation.effects, []);
});

test("provider rejection cannot adopt a concurrent matching mutation as applied", async () => {
  const client = new FakeCommandClient();
  client.response = { success: false };
  client.enqueueIssue("issue-1",
    issue("issue-1", "revision:issue:1"),
    issue("issue-1", "revision:issue:2", { title: "Updated" }));

  const result = await commands(client).execute(calls.updateIssue, ACTIVE_EXECUTION);

  assert.equal(result.output.outcome, "conflict_observed");
  assert.equal(result.output.effect_may_have_occurred, true);
  assert.equal(result.output.sanitized_reason, "provider_rejected_with_unexpected_readback");
  assert.equal(client.effects.length, 1);
});

test("Issue creation requires exact provider time and dedicated service-actor provenance", async () => {
  const client = new FakeCommandClient();
  client.enqueueIssue("root-1", issue("root-1", "revision:parent:1"));
  client.enqueueIssue(ISSUE_UUID, null, issue(ISSUE_UUID, "revision:new:1", {
    title: "New issue",
    description: "Body",
    status: "state:todo",
    parent_id: "root-1",
    creator_id: "actor:external",
  }));

  const result = await commands(client).execute(calls.createIssue, ACTIVE_EXECUTION);

  assert.equal(result.output.outcome, "conflict_observed");
  assert.equal(result.output.effect_may_have_occurred, true);
  assert.equal(result.output.sanitized_reason, "fresh_postcondition_mismatch");
  assert.equal(client.effects.length, 1);
});

test("fresh revision mismatches return stale_before_effect before every provider call", async () => {
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
    const result = await commands(client).execute(call, ACTIVE_EXECUTION);
    assert.equal(result.output.outcome, "stale_before_effect", call.function);
    assert.equal(result.output.effect_may_have_occurred, false);
    assert.equal(result.output.sanitized_reason, "fresh_precondition_mismatch");
    assert.deepEqual(client.effects, []);
  }
});

test("provider acknowledgement and exact read-back produce closed no-CAS outcomes without retry", async () => {
  const cases: Array<{
    name: string;
    beforeRevision: string;
    response?: unknown;
    failure?: unknown;
    after?: unknown;
    outcome: "applied" | "not_applied" | "stale_before_effect" | "conflict_observed";
  }> = [
    { name: "applied", beforeRevision: "revision:issue:1",
      after: issue("issue-1", "revision:2", { title: "Updated" }), outcome: "applied" },
    { name: "not applied", beforeRevision: "revision:issue:1", response: { success: false },
      after: issue("issue-1", "revision:issue:1"), outcome: "not_applied" },
    { name: "precondition", beforeRevision: "revision:stale", outcome: "stale_before_effect" },
    { name: "unknown", beforeRevision: "revision:issue:1", failure: new Error("provider-secret"),
      after: issue("issue-1", "revision:issue:1"), outcome: "conflict_observed" },
    { name: "mismatch", beforeRevision: "revision:issue:1", response: { success: true },
      after: issue("issue-1", "revision:issue:1"), outcome: "conflict_observed" },
  ];

  for (const entry of cases) {
    const client = new FakeCommandClient();
    client.enqueueIssue("issue-1", issue("issue-1", entry.beforeRevision), ...(entry.after === undefined ? [] : [entry.after]));
    if (entry.response !== undefined) client.response = entry.response;
    if (entry.failure !== undefined) client.failure = entry.failure;
    const result = await commands(client).execute(calls.updateIssue, ACTIVE_EXECUTION);
    assert.equal(result.output.outcome, entry.outcome, entry.name);
    assert.equal(client.effects.length, entry.outcome === "stale_before_effect" ? 0 : 1);
    assert.equal(JSON.stringify(result).includes("provider-secret"), false);
  }
});

test("an uncertain provider call is accepted only from same-identity read-back and is never retried", async () => {
  const client = new FakeCommandClient();
  client.enqueueIssue("issue-1",
    issue("issue-1", "revision:issue:1"),
    issue("issue-1", "revision:2", { title: "Updated" }));
  client.failure = new Error("Authorization provider-secret");

  const result = await commands(client).execute(calls.updateIssue, ACTIVE_EXECUTION);

  assert.equal(result.output.outcome, "applied");
  assert.equal(client.effects.length, 1);
  assert.equal(JSON.stringify(result).includes("provider-secret"), false);

  const unavailable = new FakeCommandClient();
  unavailable.enqueueIssue("issue-1", issue("issue-1", "revision:issue:1"), new Error("readback-secret"));
  const unknown = await commands(unavailable).execute(calls.updateIssue, ACTIVE_EXECUTION);
  assert.equal(unknown.output.outcome, "conflict_observed");
  assert.equal(unknown.output.effect_may_have_occurred, true);
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
    expected_revision: ISSUE_REVISION_1,
    desired: { title: "Updated" },
  });
  const client = new FakeCommandClient();
  client.enqueueIssue("issue-1",
    issue("issue-1", "revision:issue:1"),
    issue("issue-1", "revision:issue:2", { title: "Updated", delegate_id: "actor:other" }));

  const result = await commands(client).execute(call, ACTIVE_EXECUTION);

  assert.equal(result.output.outcome, "conflict_observed");
  assert.equal(result.output.effect_may_have_occurred, true);
  assert.deepEqual(result.output.concrete_diff.map((change) => "field" in change ? change.field : change.kind), [
    "title",
    "delegate",
  ]);
});

test("update read-back rejects external history and concurrent attached-record evidence", async () => {
  for (const kind of ["history", "comment"] as const) {
    const client = new FakeCommandClient();
    client.enqueueIssue("issue-1",
      issue("issue-1", "revision:issue:1"),
      issue("issue-1", "revision:issue:2", { title: "Updated" }));
    const evidence = new FakeEvidenceReader();
    if (kind === "history") {
      evidence.enqueueHistory("issue-1", [], [{
        history_id: "history:external",
        issue_id: "issue-1",
        provider_created_at: "2026-07-30T00:00:01.000Z",
        provider_updated_at: "2026-07-30T00:00:01.000Z",
        actor_id: "actor:external",
        change_origin: "external",
        changed_fields: ["title"],
        from_state_id: null,
        to_state_id: null,
        from_parent_id: null,
        to_parent_id: null,
        added_label_ids: [],
        removed_label_ids: [],
        archived: null,
        trashed: null,
        relation_changes: [],
      }]);
    } else {
      evidence.enqueueComments("issue-1", [], [{
        comment_id: "comment:concurrent",
        issue_id: "issue-1",
        provider_created_at: "2026-07-30T00:00:01.000Z",
        provider_updated_at: "2026-07-30T00:00:01.000Z",
        provider_edited_at: null,
        provider_archived_at: null,
        actor_id: "actor:1",
        body_digest: "a".repeat(64),
      }]);
    }

    const result = await commands(client, evidence).execute(calls.updateIssue, ACTIVE_EXECUTION);

    assert.equal(result.output.outcome, "conflict_observed", kind);
    assert.equal(result.output.sanitized_reason, "unexpected_post_effect_evidence", kind);
  }
});

test("Linear no-priority normalization and malformed receipts remain closed", async () => {
  const noPriorityCall = mutationCall("update_issue", {
    issue_id: "issue-1",
    expected_revision: ISSUE_REVISION_1,
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
  assert.equal(result.output.outcome, "conflict_observed");
  assert.equal(JSON.stringify(result).includes("do-not-return"), false);
  assert.equal(malformed.effects.length, 1);
});
