import assert from "node:assert/strict";
import test from "node:test";

import { parseRepositoryId, parseRootIssueId } from "../../contracts/identity.js";
import {
  LinearReader,
  type LinearReadClient,
  type LinearReaderRoute,
} from "./LinearReader.js";
import { LinearSdkReadClient } from "./LinearSdkReadClient.js";

const TEAM_ID = "team-1";
const DELEGATE_ACTOR_ID = "agent-1";

function page(nodes: readonly unknown[], endCursor: string | null = null) {
  return {
    nodes,
    page_info: {
      has_next_page: endCursor !== null,
      end_cursor: endCursor,
    },
  };
}

function issue(
  id: string,
  status: string,
  parentId: string | null = null,
  priority = 2,
  createdAt = "2026-07-29T00:00:00.000Z",
) {
  return {
    id,
    team_id: TEAM_ID,
    parent_id: parentId,
    status,
    priority,
    created_at: createdAt,
    delegate_id: DELEGATE_ACTOR_ID,
  };
}

class FakeLinearReadClient implements LinearReadClient {
  readonly issues = new Map<string, unknown>();
  readonly labels = new Map<string, unknown>();
  readonly children = new Map<string, unknown>();
  readonly inverseRelations = new Map<string, unknown>();
  readonly teamPages = new Map<string, unknown>();
  failure: Error | null = null;

  async listTeamIssues(_teamId: string, cursor: string | null) {
    if (this.failure) throw this.failure;
    return this.teamPages.get(cursor ?? "first") ?? page([]);
  }

  async getIssue(issueId: string) {
    if (this.failure) throw this.failure;
    return this.issues.get(issueId);
  }

  async listIssueLabels(issueId: string, cursor: string | null) {
    if (this.failure) throw this.failure;
    return this.labels.get(`${issueId}:${cursor ?? "first"}`) ?? page([]);
  }

  async listIssueChildren(issueId: string, cursor: string | null) {
    if (this.failure) throw this.failure;
    return this.children.get(`${issueId}:${cursor ?? "first"}`) ?? page([]);
  }

  async listIssueInverseRelations(issueId: string, cursor: string | null) {
    if (this.failure) throw this.failure;
    return this.inverseRelations.get(`${issueId}:${cursor ?? "first"}`) ?? page([]);
  }
}

function route(rootId: string, repositoryId = `repo:${rootId}`): LinearReaderRoute {
  return {
    root_id: parseRootIssueId(rootId),
    repository_id: parseRepositoryId(repositoryId),
    base_branch: "main",
  };
}

function reader(client: FakeLinearReadClient, routes = [route("root-1")]) {
  return new LinearReader(client, { team_id: TEAM_ID, delegate_actor_id: DELEGATE_ACTOR_ID, routes });
}

function setLabels(client: FakeLinearReadClient, issueId: string, ...labels: string[]) {
  client.labels.set(`${issueId}:first`, page(labels));
}

test("discovery consumes every page, validates Root kind, binds routes, and sorts stably", async () => {
  const client = new FakeLinearReadClient();
  client.teamPages.set("first", page([
    issue("root-2", "Todo", null, 2, "2026-07-29T00:00:00.000Z"),
  ], "roots:2"));
  client.teamPages.set("roots:2", page([
    issue("not-root", "Todo", null, 1),
    issue("root-1", "In Progress", null, 1, "2026-07-30T00:00:00.000Z"),
  ]));
  setLabels(client, "root-1", "symphony:kind/root", "customer:visible");
  setLabels(client, "root-2", "symphony:kind/root");
  setLabels(client, "not-root", "customer:visible");

  const roots = await reader(client, [route("root-1"), route("root-2")]).discoverRoots();

  assert.deepEqual(roots, [
    {
      root_id: "root-1",
      status: "In Progress",
      priority: 1,
      created_at: "2026-07-30T00:00:00.000Z",
      repository_id: "repo:root-1",
      base_branch: "main",
    },
    {
      root_id: "root-2",
      status: "Todo",
      priority: 2,
      created_at: "2026-07-29T00:00:00.000Z",
      repository_id: "repo:root-2",
      base_branch: "main",
    },
  ]);
});

test("discovery ignores an undelegated Root and readRoot rejects delegation drift", async () => {
  const client = new FakeLinearReadClient();
  const undelegated = { ...issue("root-1", "Todo"), delegate_id: null };
  client.teamPages.set("first", page([undelegated]));
  client.issues.set("root-1", undelegated);
  setLabels(client, "root-1", "symphony:kind/root");

  assert.deepEqual(await reader(client).discoverRoots(), []);
  await assert.rejects(reader(client).readRoot(parseRootIssueId("root-1")), /linear_root_delegate_mismatch/u);
});

test("readRoot projects one complete active Cycle and incoming blocks dependencies", async () => {
  const client = new FakeLinearReadClient();
  const records = [
    issue("root-1", "In Progress"),
    issue("cycle-old", "Canceled", "root-1"),
    issue("cycle-active", "Executing", "root-1"),
    issue("plan-1", "Done", "cycle-active"),
    issue("work-1", "Done", "cycle-active"),
    issue("work-2", "Todo", "cycle-active"),
    issue("verify-1", "Todo", "cycle-active"),
  ];
  for (const record of records) client.issues.set(record.id, record);
  client.children.set("root-1:first", page([records[1]], "cycles:2"));
  client.children.set("root-1:cycles:2", page([records[2]]));
  client.children.set("cycle-active:first", page(records.slice(3, 5), "stages:2"));
  client.children.set("cycle-active:stages:2", page(records.slice(5)));
  setLabels(client, "root-1", "symphony:kind/root");
  setLabels(client, "cycle-old", "symphony:kind/cycle");
  setLabels(client, "cycle-active", "symphony:kind/cycle");
  setLabels(client, "plan-1", "symphony:kind/plan");
  setLabels(client, "work-1", "symphony:kind/work");
  setLabels(client, "work-2", "symphony:kind/work");
  setLabels(client, "verify-1", "symphony:kind/verify");
  client.inverseRelations.set("work-2:first", page([
    { type: "blocks", source_issue_id: "work-1", target_issue_id: "work-2" },
  ]));
  client.inverseRelations.set("verify-1:first", page([
    { type: "blocks", source_issue_id: "work-2", target_issue_id: "verify-1" },
  ], "relations:2"));
  client.inverseRelations.set("verify-1:relations:2", page([
    { type: "blocks", source_issue_id: "work-1", target_issue_id: "verify-1" },
  ]));

  assert.deepEqual(await reader(client).readRoot(parseRootIssueId("root-1")), {
    root_id: "root-1",
    root_status: "In Progress",
    active_cycle: {
      issue_id: "cycle-active",
      status: "Executing",
      stages: [
        { issue_id: "plan-1", kind: "plan", status: "Done", dependency_issue_ids: [] },
        { issue_id: "verify-1", kind: "verify", status: "Todo", dependency_issue_ids: ["work-1", "work-2"] },
        { issue_id: "work-1", kind: "work", status: "Done", dependency_issue_ids: [] },
        { issue_id: "work-2", kind: "work", status: "Todo", dependency_issue_ids: ["work-1"] },
      ],
    },
  });
});

test("incomplete pagination, ambiguous active Cycles, and external dependencies fail closed", async () => {
  const incomplete = new FakeLinearReadClient();
  incomplete.teamPages.set("first", {
    nodes: [issue("root-1", "Todo")],
    page_info: { has_next_page: true, end_cursor: null },
  });
  await assert.rejects(reader(incomplete).discoverRoots(), /linear_incomplete_page/u);

  const duplicate = new FakeLinearReadClient();
  duplicate.teamPages.set("first", page([
    issue("root-1", "Todo"),
    issue("root-1", "Todo"),
  ]));
  await assert.rejects(reader(duplicate).discoverRoots(), /linear_duplicate_issue_identity/u);

  const ambiguous = new FakeLinearReadClient();
  const root = issue("root-1", "In Progress");
  const cycle1 = issue("cycle-1", "Planning", "root-1");
  const cycle2 = issue("cycle-2", "Executing", "root-1");
  for (const record of [root, cycle1, cycle2]) ambiguous.issues.set(record.id, record);
  ambiguous.children.set("root-1:first", page([cycle1, cycle2]));
  setLabels(ambiguous, "root-1", "symphony:kind/root");
  setLabels(ambiguous, "cycle-1", "symphony:kind/cycle");
  setLabels(ambiguous, "cycle-2", "symphony:kind/cycle");
  await assert.rejects(reader(ambiguous).readRoot(parseRootIssueId("root-1")), /linear_multiple_active_cycles/u);

  const external = new FakeLinearReadClient();
  const cycle = issue("cycle-1", "Executing", "root-1");
  const work = issue("work-1", "Todo", "cycle-1");
  for (const record of [root, cycle, work]) external.issues.set(record.id, record);
  external.children.set("root-1:first", page([cycle]));
  external.children.set("cycle-1:first", page([work]));
  setLabels(external, "root-1", "symphony:kind/root");
  setLabels(external, "cycle-1", "symphony:kind/cycle");
  setLabels(external, "work-1", "symphony:kind/work");
  external.inverseRelations.set("work-1:first", page([
    { type: "blocks", source_issue_id: "foreign-work", target_issue_id: "work-1" },
  ]));
  await assert.rejects(reader(external).readRoot(parseRootIssueId("root-1")), /linear_external_dependency/u);
});

test("malformed provider payloads and raw provider errors never cross the boundary", async () => {
  const malformed = new FakeLinearReadClient();
  malformed.teamPages.set("first", page([{ id: "root-1", private_payload: "provider-sensitive-value" }]));
  await assert.rejects(reader(malformed).discoverRoots(), (error: Error) => {
    assert.equal(error.message, "linear_invalid_payload");
    assert.equal(error.message.includes("sensitive"), false);
    return true;
  });

  const failed = new FakeLinearReadClient();
  failed.failure = new Error("provider-sensitive-value");
  await assert.rejects(reader(failed).discoverRoots(), (error: Error) => {
    assert.equal(error.message, "linear_boundary_unavailable");
    assert.equal(error.message.includes("sensitive"), false);
    return true;
  });
});

test("SDK adapter applies the exact team page request and returns data-only snapshots", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const sdkIssue = {
    id: "root-1",
    teamId: TEAM_ID,
    parentId: undefined,
    priority: 1,
    createdAt: new Date("2026-07-29T00:00:00.000Z"),
    delegateId: DELEGATE_ACTOR_ID,
    state: Promise.resolve({ name: "Todo" }),
    labels: async (variables: unknown) => {
      calls.push({ labels: variables });
      return { nodes: [{ name: "symphony:kind/root", sdk_private: "not-projected" }], pageInfo: { hasNextPage: false } };
    },
    children: async (variables: unknown) => {
      calls.push({ children: variables });
      return { nodes: [], pageInfo: { hasNextPage: false } };
    },
    inverseRelations: async (variables: unknown) => {
      calls.push({ inverseRelations: variables });
      return { nodes: [{ type: "blocks", issueId: "work-1", relatedIssueId: "root-1" }], pageInfo: { hasNextPage: false } };
    },
  };
  const sdk = {
    issues: async (variables: unknown) => {
      calls.push({ issues: variables });
      return { nodes: [sdkIssue], pageInfo: { hasNextPage: true, endCursor: "next:1" } };
    },
    issue: async (id: string) => {
      calls.push({ issue: id });
      return sdkIssue;
    },
    workflowStates: async (variables: unknown) => {
      calls.push({ workflowStates: variables });
      return {
        nodes: [{ id: "state:Planning", name: "Planning", teamId: TEAM_ID }],
        pageInfo: { hasNextPage: false },
      };
    },
    issueLabels: async (variables: unknown) => {
      calls.push({ issueLabels: variables });
      return {
        nodes: [{ id: "label:cycle", name: "symphony:kind/cycle", teamId: undefined, isGroup: false }],
        pageInfo: { hasNextPage: false },
      };
    },
    createIssue: async (input: unknown) => {
      calls.push({ createIssue: input });
      return { success: true, issueId: "cycle-1", sdk_private: "not-projected" };
    },
    updateIssue: async (id: string, input: unknown) => {
      calls.push({ updateIssue: { id, input } });
      return { success: false, issueId: id, sdk_private: "not-projected" };
    },
  };
  const adapter = new LinearSdkReadClient(sdk as never);

  assert.deepEqual(await adapter.listTeamIssues(TEAM_ID, "after:1", 50), page([
    issue("root-1", "Todo", null, 1),
  ], "next:1"));
  assert.deepEqual(await adapter.listIssueLabels("root-1", "labels:1", 50), page(["symphony:kind/root"]));
  assert.deepEqual(await adapter.listIssueChildren("root-1", "children:1", 50), page([]));
  assert.deepEqual(await adapter.listIssueInverseRelations("root-1", "relations:1", 50), page([
    { type: "blocks", source_issue_id: "work-1", target_issue_id: "root-1" },
  ]));
  assert.deepEqual(calls[0], {
    issues: { after: "after:1", first: 50, filter: { team: { id: { eq: TEAM_ID } } } },
  });
  assert.equal(JSON.stringify(await adapter.getIssue("root-1")).includes("sdk_private"), false);

  assert.deepEqual(await adapter.listWorkflowStates(TEAM_ID, "Planning", "states:1", 50), page([
    { id: "state:Planning", name: "Planning", team_id: TEAM_ID },
  ]));
  assert.deepEqual(await adapter.listNamedIssueLabels("symphony:kind/cycle", "labels:2", 50), page([
    { id: "label:cycle", name: "symphony:kind/cycle", team_id: null, is_group: false },
  ]));
  assert.deepEqual(await adapter.createCycle({
    team_id: TEAM_ID,
    parent_issue_id: "root-1",
    title: "Symphony Cycle",
    state_id: "state:Planning",
    label_id: "label:cycle",
  }), { success: true, issue_id: "cycle-1" });
  assert.deepEqual(await adapter.updateIssueStatus("root-1", "state:In Progress"), {
    success: false,
    issue_id: "root-1",
  });
  assert.deepEqual(calls.find((entry) => "workflowStates" in entry), {
    workflowStates: {
      after: "states:1", first: 50,
      filter: { team: { id: { eq: TEAM_ID } }, name: { eq: "Planning" } },
    },
  });
  assert.deepEqual(calls.find((entry) => "issueLabels" in entry), {
    issueLabels: { after: "labels:2", first: 50, filter: { name: { eq: "symphony:kind/cycle" } } },
  });
  assert.deepEqual(calls.find((entry) => "createIssue" in entry), {
    createIssue: {
      teamId: TEAM_ID, parentId: "root-1", title: "Symphony Cycle",
      stateId: "state:Planning", labelIds: ["label:cycle"],
    },
  });
  assert.deepEqual(calls.find((entry) => "updateIssue" in entry), {
    updateIssue: { id: "root-1", input: { stateId: "state:In Progress" } },
  });
});
