import assert from "node:assert/strict";
import test from "node:test";

import { LinearSdkQueryClient } from "./LinearClient.js";

function connection(nodes: readonly unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function sdkIssue(id: string, parentId: string | null = null) {
  return {
    id,
    updatedAt: new Date(`2026-07-${id === "root-1" ? "30" : "29"}T00:00:00.000Z`),
    teamId: "team:1",
    parentId,
    title: `Issue ${id}`,
    description: null,
    archivedAt: null,
    delegateId: "actor:1",
    priority: 2,
    createdAt: new Date("2026-07-28T00:00:00.000Z"),
    creatorId: "actor:creator",
    trashed: false,
    stateId: parentId === null ? "state:todo" : "state:planning",
    labelIds: [parentId === null ? "label:root" : "label:cycle", "label:queued"],
    children: async () => connection([]),
    history: async (variables?: unknown) => {
      void variables;
      return connection([]);
    },
    comments: async (variables?: unknown) => {
      void variables;
      return connection([]);
    },
    relations: async () => connection([]),
    inverseRelations: async () => connection([]),
  };
}

test("Linear SDK adapter projects query objects into data-only closed pages", async () => {
  const calls: unknown[] = [];
  const root = sdkIssue("root-1");
  const noPriority = { ...sdkIssue("no-priority"), priority: 0 };
  const child = sdkIssue("cycle-1", "root-1");
  root.children = async () => connection([child]);
  root.relations = async () => connection([{
    id: "relation:1",
    updatedAt: new Date("2026-07-30T00:00:00.000Z"),
    type: "blocks",
    issueId: "root-1",
    relatedIssueId: "cycle-1",
    createdAt: new Date("2026-07-28T00:00:00.000Z"),
    archivedAt: null,
  }]);
  root.inverseRelations = async () => connection([{
    id: "relation:2",
    updatedAt: new Date("2026-07-30T01:00:00.000Z"),
    type: "related",
    issueId: "cycle-1",
    relatedIssueId: "root-1",
    createdAt: new Date("2026-07-28T00:00:00.000Z"),
    archivedAt: null,
  }]);
  const sdk = {
    issue: async (id: string) => { calls.push({ issue: id }); return id === "no-priority" ? noPriority : root; },
    issues: async (variables: unknown) => {
      calls.push({ issues: variables });
      const issueId = (variables as { filter?: { id?: { eq?: unknown } } }).filter?.id?.eq;
      return connection([issueId === "no-priority" ? noPriority : root]);
    },
    workflowStates: async (variables: unknown) => {
      calls.push({ workflowStates: variables });
      return connection([{
        id: "state:todo",
        updatedAt: new Date("2026-07-30T00:00:00.000Z"),
        name: "Todo",
        teamId: "team:1",
      }]);
    },
    issueLabels: async (variables: unknown) => {
      calls.push({ issueLabels: variables });
      return connection([{
        id: "label:root",
        updatedAt: new Date("2026-07-30T00:00:00.000Z"),
        name: "symphony:kind/root",
        teamId: null,
      }]);
    },
    createIssue: async (input: unknown) => {
      calls.push({ createIssue: input });
      return { success: true, issue: { sdk_private: true } };
    },
    createComment: async (input: unknown) => {
      calls.push({ createComment: input });
      return { success: true, comment: { sdk_private: true } };
    },
    updateIssue: async (id: string, input: unknown) => {
      calls.push({ updateIssue: { id, input } });
      return { success: true, issue: { sdk_private: true } };
    },
    archiveIssue: async (id: string) => {
      calls.push({ archiveIssue: id });
      return { success: true, entity: { sdk_private: true } };
    },
    createIssueRelation: async (input: unknown) => {
      calls.push({ createIssueRelation: input });
      return { success: true, issueRelation: { sdk_private: true } };
    },
    deleteIssueRelation: async (id: string) => {
      calls.push({ deleteIssueRelation: id });
      return { success: true, entity: { sdk_private: true } };
    },
  };
  const client = new LinearSdkQueryClient(sdk as never);

  assert.deepEqual(await client.getIssue("root-1"), {
    id: "root-1",
    revision: "2026-07-30T00:00:00.000Z",
    team_id: "team:1",
    parent_id: null,
    status: "state:todo",
    title: "Issue root-1",
    description: null,
    labels: ["label:root", "label:queued"],
    delegate_id: "actor:1",
    priority: 2,
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    creator_id: "actor:creator",
    archived: false,
    trashed: false,
  });
  assert.equal((await client.getIssue("no-priority") as { priority: number | null }).priority, null);
  assert.deepEqual(await client.listIssues("issues:1", 20), {
    nodes: [await client.getIssue("root-1")],
    page_info: { has_next_page: false, end_cursor: null },
  });
  assert.deepEqual(await client.listChildren("root-1", null, 20), {
    nodes: [{
      id: "cycle-1",
      revision: "2026-07-29T00:00:00.000Z",
      team_id: "team:1",
      parent_id: "root-1",
      status: "state:planning",
      title: "Issue cycle-1",
      description: null,
      labels: ["label:cycle", "label:queued"],
      delegate_id: "actor:1",
      priority: 2,
      created_at: "2026-07-28T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
      creator_id: "actor:creator",
      archived: false,
      trashed: false,
    }],
    page_info: { has_next_page: false, end_cursor: null },
  });

  const outgoing = await client.listRelations("root-1", null, 20) as {
    nodes: readonly unknown[];
    page_info: { end_cursor: string | null };
  };
  assert.deepEqual(outgoing.nodes, [{
    id: "relation:1",
    revision: "2026-07-30T00:00:00.000Z",
    type: "blocks",
    source_issue_id: "root-1",
    target_issue_id: "cycle-1",
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    archived: false,
  }]);
  assert.match(outgoing.page_info.end_cursor ?? "", /^relation:/u);
  assert.deepEqual((await client.listRelations("root-1", outgoing.page_info.end_cursor, 20) as { nodes: unknown }).nodes, [{
    id: "relation:2",
    revision: "2026-07-30T01:00:00.000Z",
    type: "related",
    source_issue_id: "cycle-1",
    target_issue_id: "root-1",
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-30T01:00:00.000Z",
    archived: false,
  }]);
  await assert.rejects(
    client.listRelations("cycle-1", outgoing.page_info.end_cursor, 20),
    /linear_relation_cursor_invalid/u,
  );

  assert.deepEqual(await client.listStates("team:1", "states:1", 20), {
    nodes: [{
      id: "state:todo", revision: "2026-07-30T00:00:00.000Z", name: "Todo", team_id: "team:1", archived: false,
    }],
    page_info: { has_next_page: false, end_cursor: null },
  });
  assert.deepEqual(await client.listLabels("team:1", "labels:1", 20), {
    nodes: [{ id: "label:root", revision: "2026-07-30T00:00:00.000Z", name: "symphony:kind/root", team_id: null }],
    page_info: { has_next_page: false, end_cursor: null },
  });
  assert.deepEqual(calls.find((entry) => (
    (entry as { issues?: { after?: unknown } }).issues?.after === "issues:1"
  )), { issues: { after: "issues:1", first: 20, includeArchived: true } });
  assert.deepEqual(calls.find((entry) => "workflowStates" in (entry as object)), {
    workflowStates: { after: "states:1", first: 20, filter: { team: { id: { eq: "team:1" } } } },
  });
  assert.deepEqual(calls.find((entry) => "issueLabels" in (entry as object)), {
    issueLabels: {
      after: "labels:1",
      first: 20,
      filter: { or: [{ team: { id: { eq: "team:1" } } }, { team: { null: true } }] },
    },
  });
  assert.deepEqual(await client.readIssue("root-1"), {
    ...(await client.getIssue("root-1") as object),
    archived: false,
  });
  assert.deepEqual(await client.createIssue({
    id: "new-issue-1",
    team_id: "team:1",
    parent_issue_id: "root-1",
    title: "New issue",
    description: null,
    state_id: "state:todo",
    label_ids: ["label:work"],
    delegate_id: null,
    priority: 2,
  }), { success: true });
  assert.deepEqual(await client.createIssueComment({
    id: "33333333-3333-4333-8333-333333333333",
    issue_id: "root-1",
    body_markdown: "record body",
  }), { success: true });
  assert.deepEqual(await client.updateIssue("root-1", {
    title: "Updated",
    parent_issue_id: null,
    delegate_id: null,
  }), { success: true });
  assert.deepEqual(await client.archiveIssue("root-1"), { success: true });
  assert.deepEqual(await client.createRelation({
    id: "relation:new",
    type: "blocks",
    source_issue_id: "root-1",
    target_issue_id: "cycle-1",
  }), { success: true });
  assert.deepEqual(await client.deleteRelation("relation:new"), { success: true });
  assert.deepEqual(calls.find((entry) => "createIssue" in (entry as object)), { createIssue: {
    id: "new-issue-1",
    teamId: "team:1",
    parentId: "root-1",
    title: "New issue",
    description: null,
    stateId: "state:todo",
    labelIds: ["label:work"],
    delegateId: null,
    priority: 2,
  } });
  assert.deepEqual(calls.find((entry) => "updateIssue" in (entry as object)), { updateIssue: {
    id: "root-1",
    input: { title: "Updated", parentId: null, delegateId: null },
  } });
  assert.deepEqual(calls.find((entry) => "archiveIssue" in (entry as object)), { archiveIssue: "root-1" });
  assert.deepEqual(calls.find((entry) => "createIssueRelation" in (entry as object)), { createIssueRelation: {
    id: "relation:new", type: "blocks", issueId: "root-1", relatedIssueId: "cycle-1",
  } });
  assert.deepEqual(calls.find((entry) => "deleteIssueRelation" in (entry as object)), {
    deleteIssueRelation: "relation:new",
  });
  assert.equal(JSON.stringify(await client.getIssue("root-1")).includes("sdk_private"), false);
});

test("exact getIssue includes archived issues and returns null when the identity is absent", async () => {
  const calls: unknown[] = [];
  const client = new LinearSdkQueryClient({
    issues: async (variables: unknown) => {
      calls.push(variables);
      return connection([]);
    },
  } as never);

  assert.equal(await client.getIssue("missing-1"), null);
  assert.deepEqual(calls, [{
    first: 2,
    includeArchived: true,
    filter: { id: { eq: "missing-1" } },
  }]);
});

test("exact getIssue preserves an archived exact identity as a current fact", async () => {
  const calls: unknown[] = [];
  const archived = {
    ...sdkIssue("archived-1"),
    archivedAt: new Date("2026-07-30T00:00:00.000Z"),
  };
  const client = new LinearSdkQueryClient({
    issues: async (variables: unknown) => {
      calls.push(variables);
      return connection([archived]);
    },
  } as never);

  assert.equal((await client.getIssue("archived-1") as { archived: boolean }).archived, true);
  assert.deepEqual(calls, [{
    first: 2,
    includeArchived: true,
    filter: { id: { eq: "archived-1" } },
  }]);
});

test("exact getIssue does not infer absence from an incomplete provider page", async () => {
  const client = new LinearSdkQueryClient({
    issues: async () => connection([], true, "cursor:next"),
  } as never);

  await assert.rejects(
    client.getIssue("missing-1"),
    /linear_issue_lookup_incomplete/u,
  );
});

test("SDK history, comments, and viewer projections remain bounded and data-only", async () => {
  const calls: unknown[] = [];
  const issue = sdkIssue("root-1");
  issue.history = async (variables: unknown) => {
    calls.push({ history: variables });
    return connection([{
      id: "history-1",
      createdAt: new Date("2026-07-30T00:00:00.000Z"),
      updatedAt: new Date("2026-07-30T01:00:00.000Z"),
      actorId: "actor:creator",
      fromStateId: "state:todo",
      toStateId: "state:doing",
      fromTitle: null,
      toTitle: null,
      updatedDescription: false,
      fromParentId: null,
      toParentId: null,
      addedLabelIds: [],
      removedLabelIds: [],
      fromDelegate: undefined,
      toDelegate: undefined,
      fromPriority: null,
      toPriority: null,
      archived: null,
      trashed: null,
      relationChanges: [],
    }], true, "history:next");
  };
  issue.comments = async (variables: unknown) => {
    calls.push({ comments: variables });
    return connection([{
      id: "comment-1",
      issueId: "root-1",
      createdAt: new Date("2026-07-30T00:00:00.000Z"),
      updatedAt: new Date("2026-07-30T01:00:00.000Z"),
      editedAt: new Date("2026-07-30T01:00:00.000Z"),
      archivedAt: null,
      userId: "actor:creator",
      botActor: null,
      body: "record body",
    }]);
  };
  const client = new LinearSdkQueryClient({
    issue: async () => issue,
    viewer: Promise.resolve({ id: "actor:creator", active: true, app: true, credential: "secret" }),
  } as never);

  assert.equal((await client.listIssueHistory("root-1", null, 20) as {
    page_info: { end_cursor: string | null };
  }).page_info.end_cursor, "history:next");
  const comments = await client.listIssueComments("root-1", null, 20) as { nodes: readonly unknown[] };
  assert.equal(JSON.stringify(comments).includes("credential"), false);
  assert.equal((comments.nodes[0] as { body_digest: string }).body_digest.length, 64);
  assert.deepEqual(await client.readViewer(), { id: "actor:creator", active: true, app: true });
  assert.deepEqual(calls, [
    { history: { after: null, first: 20 } },
    { comments: { after: null, first: 20 } },
  ]);
});
