import assert from "node:assert/strict";
import test from "node:test";

import { LinearSdkImpl } from "../dist/internal/linear-gateway/internal/LinearSdkImpl.js";

function connection(nodes) {
  return {
    nodes,
    pageInfo: { hasNextPage: false, endCursor: undefined },
    async fetchNext() {
      return this;
    },
  };
}

function paginatedConnection(pages) {
  let page = 0;
  return {
    nodes: [...pages[0]],
    pageInfo: { hasNextPage: pages.length > 1, endCursor: undefined },
    async fetchNext() {
      page += 1;
      this.nodes.push(...pages[page]);
      this.pageInfo.hasNextPage = page < pages.length - 1;
      return this;
    },
  };
}

function commentPages(comments) {
  const pages = [];
  for (let index = 0; index < comments.length; index += 64) {
    pages.push(comments.slice(index, index + 64));
  }
  return pages.length > 0 ? pages : [[]];
}

function issue(input) {
  const value = {
    id: input.id,
    identifier: input.identifier ?? input.id.toUpperCase(),
    projectId: "project-1",
    parentId: input.parentId,
    teamId: "team-1",
    delegateId: input.delegateId,
    title: input.title ?? "Title",
    description: input.description ?? "",
    sortOrder: input.order ?? 1,
    subIssueSortOrder: input.parentId ? (input.order ?? 1) : undefined,
    updatedAt: new Date("2026-07-16T00:00:00Z"),
    state: Promise.resolve({ id: "state-todo", name: "Todo" }),
    team: Promise.resolve({
      states: async () => connection([{ id: "state-todo", name: "Todo" }]),
    }),
    children: async () => connection(input.children ?? []),
    comments: async () => connection([]),
    labels: async () => connection([]),
  };
  return value;
}

test("official SDK adapter maps each Podium credential kind to the correct Authorization scheme", async (t) => {
  const observed = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    observed.push(new Headers(init.headers).get("authorization"));
    return new Response(JSON.stringify({ errors: [{ message: "stop after observing auth" }] }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });

  for (const credential of [
    { kind: "oauth", token: "oauth-canary" },
    { kind: "development_token", token: "development-canary", delegateActorId: "app-user" },
  ]) {
    const adapter = new LinearSdkImpl(credential, "organization-1");
    await assert.rejects(adapter.listProjects({ limit: 1 }));
  }

  assert.deepEqual(observed, ["Bearer oauth-canary", "development-canary"]);
});

test("development-token SDK uses the persisted app user for Root delegation", async () => {
  const root = issue({ id: "root-1", delegateId: "app-user" });
  const sdk = {
    viewer: Promise.resolve({ id: "human-viewer" }),
    project: async () => ({
      issues: async () => connection([root]),
    }),
  };
  const adapter = new LinearSdkImpl({
    kind: "development_token",
    token: "token",
    delegateActorId: "app-user",
  }, "organization-1", sdk);

  const roots = await adapter.listRootIssues({ projectId: "project-1", limit: 250 });
  assert.equal(roots.items[0].isDelegatedToSymphony, true);
});

test("official SDK adapter resolves the unique Project label and reads complete Root trees", async () => {
  const child = issue({ id: "work-1", parentId: "root-1", order: 2 });
  const root = issue({
    id: "root-1",
    delegateId: "app-user",
    children: [child],
  });
  const project = {
    id: "project-1",
    name: "Project",
    updatedAt: new Date("2026-07-16T00:00:00Z"),
    labels: async () => connection([projectLabel]),
    issues: async () => connection([root]),
  };
  const projectLabel = {
    id: "label-1",
    name: "symphony:conductor/abc123",
    isGroup: false,
    archivedAt: null,
    retiredById: undefined,
    organization: Promise.resolve({ id: "organization-1" }),
    projects: async () => connection([project]),
  };
  const sdk = {
    viewer: Promise.resolve({ id: "app-user" }),
    projectLabels: async () => connection([projectLabel]),
    project: async () => project,
    issue: async (id) => (id === "root-1" ? root : child),
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  assert.deepEqual(await adapter.readProjectResolution({
    conductorShortHash: "abc123",
  }), {
    kind: "resolved",
    projectId: "project-1",
    updatedAt: "2026-07-16T00:00:00.000Z",
  });
  const roots = await adapter.listRootIssues({
    projectId: "project-1",
    limit: 250,
  });
  assert.equal(roots.items[0].isDelegatedToSymphony, true);
  const tree = await adapter.getIssueTree({
    projectId: "project-1",
    rootIssueId: "root-1",
    limit: 250,
  });
  assert.deepEqual(tree.nodes.map(({ issueId, depth }) => [issueId, depth]), [
    ["root-1", 0],
    ["work-1", 1],
  ]);
});

test("official SDK adapter reads each lazy issue state exactly once", async () => {
  const root = issue({ id: "root-1" });
  let stateReads = 0;
  Object.defineProperty(root, "state", {
    get() {
      stateReads += 1;
      if (stateReads > 1) throw new Error("issue_state_read_twice");
      return Promise.resolve({ id: "state-todo", name: "Todo" });
    },
  });
  const sdk = {
    issue: async () => root,
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  const tree = await adapter.getIssueTree({
    projectId: "project-1",
    rootIssueId: "root-1",
    limit: 250,
  });

  assert.equal(tree.nodes[0].state, "Todo");
  assert.equal(stateReads, 1);
});

test("official SDK adapter creates a managed node and proves it by exact Marker read-back", async () => {
  const parent = issue({ id: "root-1" });
  let created;
  let createdInput;
  const sdk = {
    issue: async () => parent,
    async createIssue(input) {
      createdInput = input;
      created = issue({
        id: "work-1",
        parentId: "root-1",
        title: input.title,
        description: input.description,
        order: input.subIssueSortOrder,
      });
      return { success: true, issueId: "work-1" };
    },
    async issues() {
      return connection(created ? [created] : []);
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);
  const command = {
    kind: "create_managed_node",
    nodeKind: "work",
    project: {
      conductorShortHash: "abc123",
      expectedProjectId: "project-1",
      expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
    },
    parentIssueId: "root-1",
    managedMarker: "root-1:hash:work",
    order: 2,
    title: "Work",
    description: "Implement it",
  };

  await adapter.executeMutation(command);
  const outcome = await adapter.readMutationOutcome(command);

  assert.equal(outcome.issue.issueId, "work-1");
  assert.equal(outcome.issue.managedMarker, "root-1:hash:work");
  assert.equal(outcome.issue.description, "Implement it");
  assert.equal(outcome.issue.nodeKind, "work");
  assert.equal(outcome.issue.origin, "symphony");
  assert.equal(createdInput.stateId, "state-todo");
});

test("official SDK adapter serializes Human kind and target without title inference", async () => {
  const parent = issue({ id: "root-1" });
  let created;
  const sdk = {
    issue: async () => parent,
    async createIssue(input) {
      created = issue({
        id: "human-1",
        parentId: "root-1",
        title: input.title,
        description: input.description,
        order: input.subIssueSortOrder,
      });
      return { success: true, issueId: "human-1" };
    },
    async issues() {
      return connection(created ? [created] : []);
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);
  const command = {
    kind: "create_managed_node",
    nodeKind: "human",
    humanKind: "runtime_input",
    targetIssueId: "work-1",
    project: {
      conductorShortHash: "abc123",
      expectedProjectId: "project-1",
      expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
    },
    parentIssueId: "root-1",
    managedMarker: "root-1:runtime:human-1",
    order: 1,
    title: "[Human Action] Confirm",
    description: "Confirm the input",
  };

  await adapter.executeMutation(command);
  const outcome = await adapter.readMutationOutcome(command);

  assert.equal(outcome.issue.nodeKind, "human");
  assert.equal(outcome.issue.humanKind, "runtime_input");
  assert.equal(outcome.issue.targetIssueId, "work-1");
  assert.equal(outcome.issue.description, "Confirm the input");
});

test("official SDK adapter appends and reads back a Root event after 65 comments", async () => {
  const comments = Array.from({ length: 65 }, (_, index) => ({
    id: `user-comment-${index}`,
    body: `User comment ${index}`,
  }));
  const root = issue({ id: "root-1" });
  root.comments = async () => paginatedConnection(commentPages(comments));
  const sdk = {
    issue: async () => root,
    async createComment({ issueId, body }) {
      assert.equal(issueId, "root-1");
      comments.push({ id: "comment-1", body });
      return { success: true, commentId: "comment-1" };
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);
  const eventKey = `${"turn".repeat(32)}:9007199254740991`;
  const command = rootCommentCommand({ eventKey });

  await adapter.executeMutation(command);

  assert.equal(comments.length, 66);
  assert.ok(await adapter.readMutationOutcome(command));
  await assert.rejects(adapter.executeMutation(command), /precondition/u);
});

test("official SDK adapter upserts the Primary comment by direct id lookup", async () => {
  const comment = {
    id: "comment-1",
    issueId: "root-1",
    body: "Symphony Root Run\nturn_status: planning\n<!-- symphony root marker -->",
    updatedAt: new Date("2026-07-16T00:00:00Z"),
  };
  const root = issue({ id: "root-1" });
  root.comments = async () => {
    throw new Error("Primary ID-upsert must not scan Root comments");
  };
  let lookups = 0;
  const sdk = {
    issue: async () => root,
    async comment({ id }) {
      assert.equal(id, "comment-1");
      lookups += 1;
      return comment;
    },
    async updateComment(commentId, { body }) {
      assert.equal(commentId, "comment-1");
      comment.body = body;
      return { success: true };
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);
  const command = rootCommentCommand({ commentId: "comment-1" });

  await adapter.executeMutation(command);

  assert.match(comment.body, /turn_status: working/u);
  assert.ok(await adapter.readMutationOutcome(command));
  assert.equal(lookups, 2);
});

test("official SDK adapter rejects an invalid Primary comment identity", async () => {
  const root = issue({ id: "root-1" });
  const command = rootCommentCommand({ commentId: "comment-1" });
  const cases = [
    { comment: undefined, command },
    {
      comment: {
        issueId: "root-other",
        body: "Symphony Root Run\n<!-- symphony root marker -->",
      },
      command,
    },
    {
      comment: { issueId: "root-1", body: "A user comment" },
      command,
    },
    {
      comment: {
        issueId: "root-1",
        body: "Symphony Root Run\n<!-- symphony root marker -->",
      },
      command: {
        ...command,
        body: "Timeline\n\n<!-- symphony turn event\nevent_key: turn-1:1\n-->",
      },
    },
  ];

  for (const testCase of cases) {
    const sdk = {
      issue: async () => root,
      comment: async () => testCase.comment && ({
        id: "comment-1",
        updatedAt: new Date("2026-07-16T00:00:00Z"),
        ...testCase.comment,
      }),
      updateComment: async () => assert.fail("invalid comment was updated"),
    };
    const adapter = new LinearSdkImpl(
      { kind: "oauth", token: "token" },
      "organization-1",
      sdk,
    );

    await assert.rejects(
      adapter.executeMutation(testCase.command),
      /linear_root_comment_identity_mismatch/u,
    );
  }
});

test("official SDK adapter rejects mismatched and ambiguous Timeline markers", async () => {
  const command = rootCommentCommand({ eventKey: "turn-1:1" });
  const mismatched = {
    id: "comment-1",
    body: "Different body\n\n<!-- symphony turn event\nevent_key: turn-1:1\n-->",
  };

  for (const comments of [[mismatched], [mismatched, { ...mismatched, id: "comment-2" }]]) {
    const root = issue({ id: "root-1" });
    root.comments = async () => paginatedConnection(commentPages(comments));
    const sdk = {
      issue: async () => root,
      createComment: async () => assert.fail("duplicate Timeline comment was created"),
    };
    const adapter = new LinearSdkImpl(
      { kind: "oauth", token: "token" },
      "organization-1",
      sdk,
    );

    await assert.rejects(
      adapter.executeMutation(command),
      comments.length === 1
        ? /linear_turn_event_comment_mismatch/u
        : /linear_turn_event_comment_ambiguous/u,
    );
  }
});

test("official SDK adapter discovers the Primary comment after 65 user comments", async () => {
  const comments = [
    ...Array.from({ length: 65 }, (_, index) => ({
      id: `user-comment-${index}`,
      body: `User comment ${index}`,
      updatedAt: new Date("2026-07-16T00:00:00Z"),
    })),
    {
      id: "primary-comment",
      body: "Symphony Root Run\n<!-- symphony root marker -->",
      updatedAt: new Date("2026-07-16T00:00:00Z"),
    },
  ];
  const root = issue({ id: "root-1" });
  root.comments = async () => paginatedConnection(commentPages(comments));
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    { issue: async () => root },
  );

  assert.equal(
    (await adapter.readRootManagedComment("root-1")).commentId,
    "primary-comment",
  );
});

function rootCommentCommand(identity) {
  return {
    kind: "project_root_comment",
    project: {
      conductorShortHash: "abc123",
      expectedProjectId: "project-1",
      expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
    },
    rootIssueId: "root-1",
    body: identity.commentId
      ? "Symphony Root Run\nturn_status: working\n<!-- symphony root marker -->"
      : `Provider failed.\n\n<!-- symphony turn event\nevent_key: ${identity.eventKey}\n-->`,
    ...identity,
  };
}

test("Project label assignment rejects a conflicting Conductor label introduced before read-back", async () => {
  let added = false;
  const desiredLabel = {
    id: "label-desired",
    name: "symphony:conductor/abc123",
    isGroup: false,
    archivedAt: null,
    retiredById: undefined,
    organization: Promise.resolve({ id: "organization-1" }),
    projects: async () => connection(added ? [project] : []),
  };
  const conflictingLabel = {
    ...desiredLabel,
    id: "label-conflict",
    name: "symphony:conductor/other",
  };
  let labelReads = 0;
  const project = {
    id: "project-1",
    async labels() {
      labelReads += 1;
      return connection(
        labelReads === 1 ? [] : [desiredLabel, conflictingLabel],
      );
    },
  };
  const sdk = {
    project: async () => project,
    projectLabels: async () => connection([desiredLabel]),
    projectAddLabel: async () => {
      added = true;
      return { success: true };
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  await assert.rejects(
    adapter.assignConductorProjectLabel({
      projectId: "project-1",
      labelName: "symphony:conductor/abc123",
    }),
    /linear_project_label_read_back_failed/,
  );
});

test("Project label assignment rejects a Conductor label already attached elsewhere", async () => {
  const otherProject = { id: "project-other" };
  const desiredLabel = {
    id: "label-desired",
    name: "symphony:conductor/abc123",
    isGroup: false,
    archivedAt: null,
    retiredById: undefined,
    organization: Promise.resolve({ id: "organization-1" }),
    projects: async () => connection([otherProject]),
  };
  let additions = 0;
  const project = {
    id: "project-1",
    labels: async () => connection([]),
  };
  const sdk = {
    project: async () => project,
    projectLabels: async () => connection([desiredLabel]),
    projectAddLabel: async () => {
      additions += 1;
      return { success: true };
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  await assert.rejects(
    adapter.assignConductorProjectLabel({
      projectId: "project-1",
      labelName: "symphony:conductor/abc123",
    }),
    /linear_conductor_label_project_conflict/,
  );
  assert.equal(additions, 0);
});
