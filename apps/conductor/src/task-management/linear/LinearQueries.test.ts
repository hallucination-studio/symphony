import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { renderTaskIssueRecordProjectionMarkdown } from "../../contracts/cycle-record-markdown.js";
import { parseRootIssueId, parseRuntimeGeneration, parseTaskIssueId } from "../../contracts/identity.js";
import { canonicalTaskRevision } from "../../contracts/task-management.js";
import { parseTaskMcpCall } from "../mcp/TaskMcpSchemas.js";
import {
  LinearQueries,
  type LinearQueryClient,
  type LinearQueryOptions,
} from "./LinearQueries.js";

const TEAM_ID = "team:1";
const ACTOR_ID = "actor:1";
const target = {
  root_id: parseRootIssueId("root-1"),
  runtime_generation: parseRuntimeGeneration(1),
};

function page(nodes: readonly unknown[], endCursor: string | null = null) {
  return {
    nodes,
    page_info: { has_next_page: endCursor !== null, end_cursor: endCursor },
  };
}

function issue(
  id: string,
  parentId: string | null,
  status: string,
  labels: readonly string[],
  overrides: Record<string, unknown> = {},
) {
  const stateId = `state:${status.toLowerCase().replaceAll(" ", "-")}`;
  const labelIds = labels.map((label) => `label:${label.slice(label.lastIndexOf("/") + 1)}`);
  return {
    id,
    revision: `revision:${id}`,
    team_id: TEAM_ID,
    parent_id: parentId,
    status: stateId,
    title: `Issue ${id}`,
    description: null,
    labels: labelIds,
    delegate_id: ACTOR_ID,
    priority: 2,
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    creator_id: ACTOR_ID,
    archived: false,
    trashed: false,
    ...overrides,
  };
}

class FakeLinearQueryClient implements LinearQueryClient {
  readonly issues = new Map<string, unknown>();
  readonly children = new Map<string, readonly unknown[]>();
  readonly relations = new Map<string, readonly unknown[]>();
  readonly histories = new Map<string, readonly unknown[]>();
  readonly comments = new Map<string, readonly unknown[]>();
  teamIssues: readonly unknown[] = [];
  states: readonly unknown[] = [
    "Todo", "In Progress", "In Review", "Done", "Draft", "Awaiting Acceptance", "Succeeded",
    "Rejected", "Canceled", "Failed",
  ].map((name) => ({
    id: `state:${name.toLowerCase().replaceAll(" ", "-")}`,
    revision: `revision:state:${name.toLowerCase().replaceAll(" ", "-")}`,
    name,
    team_id: TEAM_ID,
    archived: false,
  }));
  labels: readonly unknown[] = ["root", "cycle", "plan", "work", "verify"].map((kind) => ({
    id: `label:${kind}`,
    revision: `revision:label:${kind}`,
    name: `symphony:kind/${kind}`,
    team_id: TEAM_ID,
  }));
  failure: unknown = null;

  async getIssue(issueId: string) { this.#fail(); return this.issues.get(issueId) ?? null; }
  async listIssues(cursor: string | null, pageSize: number) {
    this.#fail(); return this.#slice(this.teamIssues, cursor, pageSize);
  }
  async listChildren(issueId: string, cursor: string | null, pageSize: number) {
    this.#fail(); return this.#slice(this.children.get(issueId) ?? [], cursor, pageSize);
  }
  async listIssueHistory(issueId: string, cursor: string | null, pageSize: number) {
    this.#fail(); return this.#slice(this.histories.get(issueId) ?? [], cursor, pageSize);
  }
  async listIssueComments(issueId: string, cursor: string | null, pageSize: number) {
    this.#fail(); return this.#slice(this.comments.get(issueId) ?? [], cursor, pageSize);
  }
  async listRelations(issueId: string, cursor: string | null, pageSize: number) {
    this.#fail(); return this.#slice(this.relations.get(issueId) ?? [], cursor, pageSize);
  }
  async listStates(_teamId: string, cursor: string | null, pageSize: number) {
    this.#fail(); return this.#slice(this.states, cursor, pageSize);
  }
  async listLabels(_teamId: string, cursor: string | null, pageSize: number) {
    this.#fail(); return this.#slice(this.labels, cursor, pageSize);
  }
  async readViewer() { this.#fail(); return { id: ACTOR_ID, active: true, app: true }; }

  #slice(nodes: readonly unknown[], cursor: string | null, pageSize: number) {
    const start = cursor === null ? 0 : Number(cursor);
    const end = Math.min(start + pageSize, nodes.length);
    return page(nodes.slice(start, end), end < nodes.length ? String(end) : null);
  }

  #fail() {
    if (this.failure !== null) throw this.failure;
  }
}

function options(): LinearQueryOptions {
  return { team_id: TEAM_ID, service_actor_id: ACTOR_ID };
}

function call(functionName: "get_issue" | "list_issues" | "list_children" | "list_relations" | "list_states" | "list_labels", input: unknown) {
  return parseTaskMcpCall({
    schema_version: 1,
    function: functionName,
    root_id: "root-1",
    runtime_generation: 1,
    correlation_id: `corr:${functionName}`,
    capability: `task_manage:${functionName}`,
    input,
  }, target);
}

test("generic query functions return only normalized closed resources with stable pagination", async () => {
  const client = new FakeLinearQueryClient();
  client.issues.set("root-1", issue("root-1", null, "Todo", ["symphony:kind/root"]));
  client.teamIssues = [
    issue("root-1", null, "Todo", ["symphony:kind/root"]),
    issue("cycle-1", "root-1", "Draft", ["symphony:kind/cycle"]),
  ];
  client.children.set("root-1", [issue("cycle-1", "root-1", "Draft", ["symphony:kind/cycle"])]);
  client.relations.set("cycle-1", [{
    id: "relation:1",
    revision: "revision:relation:1",
    type: "blocks",
    source_issue_id: "cycle-1",
    target_issue_id: "root-1",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    archived: false,
  }]);
  client.states = ["Todo", "Draft"].map((name) => ({
    id: `state:${name.toLowerCase()}`, revision: `revision:state:${name.toLowerCase()}`,
    name, team_id: TEAM_ID, archived: false,
  }));
  client.labels = [
    { id: "label:root", revision: "revision:label:root", name: "symphony:kind/root", team_id: TEAM_ID },
    { id: "label:cycle", revision: "revision:label:cycle", name: "symphony:kind/cycle", team_id: TEAM_ID },
    { id: "label:shared", revision: "revision:label:shared", name: "shared", team_id: null },
  ];
  const queries = new LinearQueries(client, options());

  const getCall = call("get_issue", { issue_id: "root-1" });
  if (getCall.function !== "get_issue") assert.fail("expected get_issue");
  assert.match((await queries.get_issue(getCall)).output.issue?.revision ?? "", /^symphony:v1:[0-9a-f]{64}$/u);

  const listCall = call("list_issues", { cursor: null, page_size: 1 });
  if (listCall.function !== "list_issues") assert.fail("expected list_issues");
  const listed = (await queries.list_issues(listCall)).output;
  assert.equal(listed.next_cursor, "1");
  assert.deepEqual({ ...listed.issues[0], revision: "canonical" }, {
    issue_id: "root-1",
    revision: "canonical",
    provider_created_at: "2026-07-30T00:00:00.000Z",
    provider_updated_at: "2026-07-30T00:00:00.000Z",
    creation_actor_id: ACTOR_ID,
    kind: "root",
    status_id: "state:todo",
    status: "Todo",
    title: "Issue root-1",
    description_markdown: "# Empty",
    parent_issue_id: null,
    label_ids: ["label:root"],
    delegate_id: ACTOR_ID,
    priority: 2,
    archived: false,
    trashed: false,
  });

  const childrenCall = call("list_children", { parent_issue_id: "root-1", cursor: null, page_size: 10 });
  if (childrenCall.function !== "list_children") assert.fail("expected list_children");
  assert.equal((await queries.list_children(childrenCall)).output.issues[0]?.parent_issue_id, "root-1");

  const relationsCall = call("list_relations", { issue_id: "cycle-1", cursor: null, page_size: 10 });
  if (relationsCall.function !== "list_relations") assert.fail("expected list_relations");
  assert.equal((await queries.list_relations(relationsCall)).output.relations[0]?.relation_id, "relation:1");

  const statesCall = call("list_states", { cursor: null, page_size: 10 });
  if (statesCall.function !== "list_states") assert.fail("expected list_states");
  assert.equal((await queries.list_states(statesCall)).output.states[0]?.state_id, "state:todo");

  const labelsCall = call("list_labels", { cursor: null, page_size: 10 });
  if (labelsCall.function !== "list_labels") assert.fail("expected list_labels");
  assert.deepEqual((await queries.list_labels(labelsCall)).output.labels.map(({ label_id }) => label_id), [
    "label:root",
    "label:cycle",
    "label:shared",
  ]);
});

test("get_issue returns typed null for exact absence and sanitizes provider failures", async () => {
  const client = new FakeLinearQueryClient();
  const getCall = call("get_issue", { issue_id: "missing-1" });
  if (getCall.function !== "get_issue") assert.fail("expected get_issue");
  const queries = new LinearQueries(client, options());

  assert.deepEqual((await queries.get_issue(getCall)).output, { issue: null });

  client.failure = new Error("Authorization bearer-secret provider-stack");
  await assert.rejects(
    queries.get_issue(getCall),
    (error: Error) => error.message === "linear_boundary_unavailable",
  );
});

test("startup inventory paginates every Root without delegate filtering in stable order", async () => {
  const client = new FakeLinearQueryClient();
  client.teamIssues = [
    issue("root-2", null, "In Progress", ["symphony:kind/root"], { priority: 2 }),
    issue("other", null, "Todo", ["symphony:kind/root"], { delegate_id: "actor:other" }),
    issue("root-1", null, "Todo", ["symphony:kind/root"], { priority: 1 }),
    issue("cycle-1", "root-1", "Draft", ["symphony:kind/cycle"]),
    ...Array.from({ length: 50 }, (_, index) => issue(
      `other-${index}`,
      null,
      "Todo",
      [],
      { delegate_id: null },
    )),
  ];

  const inventory = await new LinearQueries(client, options()).inventoryRoots();
  assert.ok(inventory.every(({ revision }) => /^symphony:v1:[0-9a-f]{64}$/u.test(revision)));
  assert.deepEqual(inventory.map(({ revision: _revision, ...root }) => {
    void _revision;
    return root;
  }), [
    {
      root_id: "root-1",
      status: "Todo",
      priority: 1,
      created_at: "2026-07-30T00:00:00.000Z",
    },
    {
      root_id: "other",
      status: "Todo",
      priority: 2,
      created_at: "2026-07-30T00:00:00.000Z",
    },
    {
      root_id: "root-2",
      status: "In Progress",
      priority: 2,
      created_at: "2026-07-30T00:00:00.000Z",
    },
  ]);
});

test("inventory accepts provider Markdown descriptions with line breaks", async () => {
  const client = new FakeLinearQueryClient();
  client.teamIssues = [issue("root-1", null, "Todo", ["symphony:kind/root"], {
    description: "# Requirement\n\nPreserve the provider Markdown document.",
  })];

  const roots = await new LinearQueries(client, options()).inventoryRoots();
  assert.deepEqual(roots.map(({ root_id }) => root_id), ["root-1"]);
});

test("inventory ignores unmanaged historical HTML documents when selecting Roots", async () => {
  const client = new FakeLinearQueryClient();
  client.teamIssues = [
    issue("unmanaged", null, "Todo", [], {
      description: "<details>\n<summary>Historical template</summary>\n\nLegacy body\n</details>",
    }),
    issue("root-1", null, "Todo", ["symphony:kind/root"]),
  ];

  const roots = await new LinearQueries(client, options()).inventoryRoots();
  assert.deepEqual(roots.map(({ root_id }) => root_id), ["root-1"]);
});

test("complete Root reads preserve delegation changes for admission consumers", async () => {
  const client = new FakeLinearQueryClient();
  client.issues.set("root-1", issue("root-1", null, "Todo", ["symphony:kind/root"], {
    delegate_id: null,
  }));

  const snapshot = await new LinearQueries(client, options()).readRootSnapshot(parseRootIssueId("root-1"));
  assert.equal(snapshot.issues[0]?.delegate_id, null);
});

test("complete Root snapshot includes every descendant and internal relation without workflow derivation", async () => {
  const client = new FakeLinearQueryClient();
  const root = issue("root-1", null, "In Progress", ["symphony:kind/root"]);
  const cycle = issue("cycle-1", "root-1", "In Progress", ["symphony:kind/cycle"]);
  const work = issue("work-1", "cycle-1", "Todo", ["symphony:kind/work"]);
  const verify = issue("verify-1", "cycle-1", "Todo", ["symphony:kind/verify"]);
  client.issues.set("root-1", root);
  client.children.set("root-1", [cycle]);
  client.children.set("cycle-1", [work, verify]);
  client.children.set("work-1", []);
  client.children.set("verify-1", []);
  const relation = {
    id: "relation:1",
    revision: "revision:relation:1",
    type: "blocks",
    source_issue_id: "work-1",
    target_issue_id: "verify-1",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    archived: false,
  };
  client.relations.set("work-1", [relation]);
  client.relations.set("verify-1", [relation]);

  const snapshot = await new LinearQueries(client, options()).readRootSnapshot(parseRootIssueId("root-1"));
  assert.deepEqual(snapshot.issues.map(({ issue_id }) => issue_id), ["cycle-1", "root-1", "verify-1", "work-1"]);
  assert.deepEqual(snapshot.relations.map(({ relation_id }) => relation_id), ["relation:1"]);
  assert.equal("active_cycle" in snapshot, false);
});

test("complete Root snapshots preserve normalized history, creation evidence, and sanitized record observations", async () => {
  const client = new FakeLinearQueryClient();
  const root = issue("root-1", null, "In Progress", ["symphony:kind/root"]);
  const cycle = issue("cycle-1", "root-1", "In Progress", ["symphony:kind/cycle"]);
  const work = issue("work-1", "cycle-1", "Done", ["symphony:kind/work"]);
  const verify = issue("verify-1", "cycle-1", "Todo", ["symphony:kind/verify"]);
  client.issues.set("root-1", root);
  client.children.set("root-1", [cycle]);
  client.children.set("cycle-1", [work, verify]);
  client.children.set("work-1", []);
  client.children.set("verify-1", []);

  const relation = {
    id: "relation:1",
    revision: "revision:relation:1",
    type: "blocks",
    source_issue_id: "work-1",
    target_issue_id: "verify-1",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    archived: false,
  };
  client.relations.set("work-1", [relation]);
  client.relations.set("verify-1", [relation]);
  client.histories.set("work-1", [{
    id: "history:work:1",
    issue_id: "work-1",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:01.000Z",
    actor_id: ACTOR_ID,
    changed_fields: ["status"],
    from_state_id: "state:todo",
    to_state_id: "state:done",
    from_parent_id: "cycle-1",
    to_parent_id: "cycle-1",
    added_label_ids: [],
    removed_label_ids: [],
    archived: null,
    trashed: null,
    relation_changes: [],
  }]);

  const projection = renderTaskIssueRecordProjectionMarkdown({
    issue_id: "work-1",
    cycle_id: "cycle-1",
    basis_issue_revision: `symphony:v1:${"a".repeat(64)}`,
    basis_status: "In Progress",
    basis_document_digest: "b".repeat(64),
    record_kind: "stage_invalidation",
    stage_id: "work-1",
    observed_status: "Done",
    observed_instruction_digest: "c".repeat(64),
    observed_completion_record_digest: null,
    observed_history_digest: "d".repeat(64),
    reason_code: "terminal_without_record",
    reason_markdown: "The terminal projection lacks a valid record.",
    invalidation_kind: "invalid_terminal",
    terminal_status: "Done",
  });
  const recordBodyDigest = createHash("sha256").update(projection, "utf8").digest("hex");
  client.comments.set("work-1", [{
    id: "record:work:invalidation:1",
    issue_id: "work-1",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    edited_at: null,
    archived_at: null,
    actor_id: ACTOR_ID,
    body_markdown: projection,
    body_digest: recordBodyDigest,
  }]);
  client.comments.set("verify-1", [{
    id: "record:verify:invalidation:edited",
    issue_id: "verify-1",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:01.000Z",
    edited_at: "2026-07-30T00:00:01.000Z",
    archived_at: null,
    actor_id: ACTOR_ID,
    body_markdown: renderTaskIssueRecordProjectionMarkdown({
      issue_id: "verify-1",
      cycle_id: "cycle-1",
      basis_issue_revision: `symphony:v1:${"e".repeat(64)}`,
      basis_status: "Todo",
      basis_document_digest: "f".repeat(64),
      record_kind: "stage_invalidation",
      stage_id: "verify-1",
      observed_status: "Canceled",
      observed_instruction_digest: "1".repeat(64),
      observed_completion_record_digest: null,
      observed_history_digest: "2".repeat(64),
      reason_code: "terminal_without_record",
      reason_markdown: "The terminal projection lacks a valid record.",
      invalidation_kind: "invalid_terminal",
      terminal_status: "Canceled",
    }),
    body_digest: "3".repeat(64),
  }]);
  client.comments.set("root-1", [{
    id: "comment:ordinary",
    issue_id: "root-1",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    edited_at: null,
    archived_at: null,
    actor_id: "actor:human",
    body_markdown: "private ordinary body",
    body_digest: "4".repeat(64),
  }]);

  const snapshot = await new LinearQueries(client, options()).readRootSnapshot(parseRootIssueId("root-1"));
  const history = snapshot.issue_history.find(({ history_id }) => history_id === "history:work:1");
  assert.deepEqual(history && {
    issue_id: history.issue_id,
    from_status: history.from_status,
    to_status: history.to_status,
    from_parent_issue_id: history.from_parent_issue_id,
    to_parent_issue_id: history.to_parent_issue_id,
  }, {
    issue_id: "work-1",
    from_status: "Todo",
    to_status: "Done",
    from_parent_issue_id: "cycle-1",
    to_parent_issue_id: "cycle-1",
  });

  const issueEvidence = snapshot.resource_creation_evidence.find(({ resource_id }) => resource_id === "work-1");
  assert.ok(issueEvidence);
  assert.equal(issueEvidence?.resource_kind, "issue");
  assert.equal(issueEvidence?.canonical_evidence_digest, canonicalTaskRevision({
    evidence_id: "linear:issue:work-1",
    resource_kind: "issue",
    resource_id: "work-1",
    creation_actor_id: ACTOR_ID,
    provider_created_at: "2026-07-30T00:00:00.000Z",
    evidence_source: "current_resource",
  }));
  assert.ok(snapshot.resource_creation_evidence.some(({ resource_id }) => resource_id === "relation:1"));

  assert.equal(snapshot.issue_record_observations.length, 2);
  assert.equal(snapshot.issue_record_observations.some((record) => record.record_id === "record:work:invalidation:1"), true);
  const edited = snapshot.issue_record_observations.find(({ record_id }) => record_id === "record:verify:invalidation:edited");
  assert.ok(edited !== undefined && "observation_kind" in edited);
  if (edited === undefined || !("observation_kind" in edited)) return;
  assert.deepEqual({
    observation_kind: edited.observation_kind,
    expected_record_kind: edited.expected_record_kind,
    observed_body_digest: edited.observed_body_digest,
  }, {
    observation_kind: "updated",
    expected_record_kind: "stage_invalidation",
    observed_body_digest: "3".repeat(64),
  });
  assert.equal(JSON.stringify(snapshot).includes("private ordinary body"), false);
});

test("complete Root snapshots require service-actor creation evidence for every Stage", async () => {
  const client = new FakeLinearQueryClient();
  client.issues.set("root-1", issue("root-1", null, "In Progress", ["symphony:kind/root"]));
  client.children.set("root-1", [
    issue("cycle-1", "root-1", "In Progress", ["symphony:kind/cycle"]),
  ]);
  client.children.set("cycle-1", [
    issue("work-1", "cycle-1", "Todo", ["symphony:kind/work"], { creator_id: "actor:foreign" }),
  ]);

  await assert.rejects(
    new LinearQueries(client, options()).readRootSnapshot(parseRootIssueId("root-1")),
    /linear_stage_creator_mismatch/u,
  );
});

test("inventory and snapshot fail closed on malformed facts, ambiguity, and raw provider errors", async () => {
  const malformed = new FakeLinearQueryClient();
  malformed.teamIssues = [{ ...issue("root-1", null, "Todo", ["symphony:kind/root"]), sdk_private: true }];
  await assert.rejects(new LinearQueries(malformed, options()).inventoryRoots(), /linear_invalid_payload/u);

  const ambiguous = new FakeLinearQueryClient();
  ambiguous.issues.set("root-1", issue("root-1", null, "In Progress", ["symphony:kind/root"]));
  ambiguous.children.set("root-1", [
    issue("cycle-1", "root-1", "Draft", ["symphony:kind/cycle"]),
    issue("cycle-2", "root-1", "In Progress", ["symphony:kind/cycle"]),
  ]);
  const overlap = await new LinearQueries(ambiguous, options()).readRootSnapshot(parseRootIssueId("root-1"));
  assert.deepEqual(
    overlap.issues.filter(({ parent_issue_id }) => parent_issue_id === "root-1").map(({ issue_id }) => issue_id),
    ["cycle-1", "cycle-2"],
  );

  const providerFailure = new FakeLinearQueryClient();
  providerFailure.failure = new Error("Authorization bearer-secret provider-stack");
  await assert.rejects(
    new LinearQueries(providerFailure, options()).inventoryRoots(),
    (error: Error) => error.message === "linear_boundary_unavailable",
  );
});

test("Root reads reject wrong team, revision, ancestry, and kind facts", async () => {
  const cases = [
    {
      code: /linear_team_mismatch/u,
      root: issue("root-1", null, "Todo", ["symphony:kind/root"], { team_id: "team:other" }),
      children: [],
    },
    {
      code: /linear_root_has_parent/u,
      root: issue("root-1", "parent-1", "Todo", ["symphony:kind/root"]),
      children: [],
    },
    {
      code: /linear_root_kind_mismatch/u,
      root: issue("root-1", null, "Todo", ["symphony:kind/cycle"]),
      children: [],
    },
    {
      code: /linear_cycle_parent_mismatch/u,
      root: issue("root-1", null, "Todo", ["symphony:kind/root"]),
      children: [issue("cycle-1", "root-2", "Draft", ["symphony:kind/cycle"])],
    },
    {
      code: /linear_cycle_kind_mismatch/u,
      root: issue("root-1", null, "Todo", ["symphony:kind/root"]),
      children: [issue("cycle-1", "root-1", "Draft", ["symphony:kind/work"])],
    },
  ];

  for (const entry of cases) {
    const client = new FakeLinearQueryClient();
    client.issues.set("root-1", entry.root);
    client.children.set("root-1", entry.children);
    await assert.rejects(
      new LinearQueries(client, options()).readRootSnapshot(parseRootIssueId("root-1")),
      entry.code,
    );
  }

  const wrongTeam = new FakeLinearQueryClient();
  wrongTeam.issues.set("root-1", issue("root-1", null, "Todo", ["symphony:kind/root"], { team_id: "team:other" }));
  const getCall = call("get_issue", { issue_id: "root-1" });
  if (getCall.function !== "get_issue") assert.fail("expected get_issue");
  await assert.rejects(new LinearQueries(wrongTeam, options()).get_issue(getCall), /linear_team_mismatch/u);
});

test("internal pagination rejects incomplete pages and cursor cycles", async () => {
  const incomplete = new FakeLinearQueryClient();
  incomplete.listIssues = async () => ({
    nodes: [],
    page_info: { has_next_page: true, end_cursor: null },
  });
  await assert.rejects(new LinearQueries(incomplete, options()).inventoryRoots(), /linear_incomplete_page/u);

  const cycling = new FakeLinearQueryClient();
  cycling.listIssues = async () => ({
    nodes: [],
    page_info: { has_next_page: true, end_cursor: "same" },
  });
  await assert.rejects(new LinearQueries(cycling, options()).inventoryRoots(), /linear_cursor_cycle/u);
});

test("complete history and comment reads paginate, classify origin, and never expose comment bodies", async () => {
  const client = new FakeLinearQueryClient();
  client.histories.set("root-1", Array.from({ length: 51 }, (_, index) => ({
    id: `history-${index}`,
    issue_id: "root-1",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    actor_id: index === 0 ? ACTOR_ID : index === 1 ? "actor:external" : null,
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
  })));
  client.comments.set("root-1", Array.from({ length: 51 }, (_, index) => ({
    id: `comment-${index}`,
    issue_id: "root-1",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: index === 0 ? "2026-07-30T01:00:00.000Z" : "2026-07-30T00:00:00.000Z",
    edited_at: index === 0 ? "2026-07-30T01:00:00.000Z" : null,
    archived_at: index === 1 ? "2026-07-30T02:00:00.000Z" : null,
    actor_id: ACTOR_ID,
    body_markdown: `private body ${index}`,
    body_digest: "a".repeat(64),
  })));
  const queries = new LinearQueries(client, options());

  const history = await queries.readIssueHistory(parseTaskIssueId("root-1"));
  assert.deepEqual(history.slice(0, 3).map(({ change_origin }) => change_origin), [
    "symphony", "external", "unknown",
  ]);
  assert.deepEqual(await queries.readLatestIssueChangeOrigin(parseTaskIssueId("root-1")), {
    issue_id: "root-1",
    change_origin: "symphony",
    changed_fields: ["title"],
  });
  const comments = await queries.readIssueComments(parseTaskIssueId("root-1"));
  assert.equal(comments.length, 51);
  assert.equal(comments[0]?.provider_edited_at, "2026-07-30T01:00:00.000Z");
  assert.equal(comments[1]?.provider_archived_at, "2026-07-30T02:00:00.000Z");
  assert.equal(JSON.stringify(comments).includes("private body"), false);
  const records = await queries.readIssueRecordComments(parseTaskIssueId("root-1"));
  assert.equal(records.length, 51);
  assert.equal(records[0]?.body_markdown, "private body 0");
  assert.equal(records[0]?.body_digest, "a".repeat(64));
});

test("history, comments, and service actor validation fail closed on incomplete identity evidence", async () => {
  for (const kind of ["history", "comment"] as const) {
    const client = new FakeLinearQueryClient();
    const duplicate = kind === "history" ? {
      id: "duplicate", issue_id: "root-1", created_at: "2026-07-30T00:00:00.000Z",
      updated_at: "2026-07-30T00:00:00.000Z", actor_id: ACTOR_ID, changed_fields: ["title"],
      from_state_id: null, to_state_id: null, from_parent_id: null, to_parent_id: null,
      added_label_ids: [], removed_label_ids: [], archived: null, trashed: null, relation_changes: [],
    } : {
      id: "duplicate", issue_id: "root-1", created_at: "2026-07-30T00:00:00.000Z",
      updated_at: "2026-07-30T00:00:00.000Z", edited_at: null, archived_at: null,
      actor_id: ACTOR_ID, body_markdown: "body", body_digest: "a".repeat(64),
    };
    (kind === "history" ? client.histories : client.comments).set("root-1", [duplicate, duplicate]);
    const queries = new LinearQueries(client, options());
    await assert.rejects(
      kind === "history"
        ? queries.readIssueHistory(parseTaskIssueId("root-1"))
        : queries.readIssueComments(parseTaskIssueId("root-1")),
      new RegExp(`linear_duplicate_${kind}_identity`, "u"),
    );
  }

  const wrongActor = new FakeLinearQueryClient();
  wrongActor.readViewer = async () => ({ id: "actor:human", active: true, app: false });
  await assert.rejects(
    new LinearQueries(wrongActor, options()).readServiceActor(),
    /linear_service_actor_unsupported/u,
  );
  assert.deepEqual(await new LinearQueries(new FakeLinearQueryClient(), options()).readServiceActor(), {
    actor_id: ACTOR_ID,
    active: true,
    app: true,
  });

  const evidenceClient = new FakeLinearQueryClient();
  evidenceClient.issues.set("work-1", issue("work-1", "cycle-1", "Todo", ["symphony:kind/work"]));
  assert.deepEqual(
    await new LinearQueries(evidenceClient, options()).readIssueCreationEvidence(parseTaskIssueId("work-1")),
    {
      issue_id: "work-1",
      provider_created_at: "2026-07-30T00:00:00.000Z",
      actor_id: ACTOR_ID,
    },
  );
});
