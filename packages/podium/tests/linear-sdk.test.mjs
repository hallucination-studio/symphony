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
    priority: input.priority ?? 0,
    sortOrder: input.order ?? 1,
    subIssueSortOrder: input.parentId ? (input.order ?? 1) : undefined,
    updatedAt: new Date("2026-07-16T00:00:00Z"),
    state: Promise.resolve({ id: "state-todo", name: "Todo" }),
    team: Promise.resolve({
      states: async () => connection([{ id: "state-todo", name: "Todo" }]),
    }),
    children: async () => connection(input.children ?? []),
    inverseRelations: async () => input.inverseRelations ?? connection([]),
    comments: async () => connection([]),
    labels: async () => connection((input.labels ?? []).map((name, index) => workflowIssueLabel(name, index))),
  };
  return value;
}

function workflowIssueLabel(name, index) {
  return {
    id: `issue-label-${index + 1}`,
    name,
    isGroup: false,
    archivedAt: null,
    retiredById: null,
    teamId: "team-1",
    organization: Promise.resolve({ id: "organization-1" }),
  };
}

function blocks(source, target) {
  return {
    id: `${source.id}-blocks-${target.id}`,
    type: "blocks",
    issueId: source.id,
    relatedIssueId: target.id,
    issue: Promise.resolve(source),
    relatedIssue: Promise.resolve(target),
  };
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

test("physical SDK requests report sanitized request and complexity windows", async (t) => {
  const observations = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const { query } = JSON.parse(init.body);
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-requests-limit": "1000",
      "x-ratelimit-requests-remaining": "998",
      "x-ratelimit-requests-reset": "60",
      "x-ratelimit-complexity-limit": "250000",
      "x-ratelimit-complexity-remaining": "249950",
      "x-ratelimit-complexity-reset": "60",
    };
    if (query.includes("Organization")) {
      return new Response(JSON.stringify({ data: {
        organization: { id: "organization-1", projectStatuses: [] },
      } }), {
        status: 200,
        headers,
      });
    }
    return new Response(JSON.stringify({ data: {
      projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } }), { status: 200, headers });
  });

  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "secret-canary" },
    "organization-1",
    undefined,
    {
      correlationId: () => "correlation-1",
      now: (() => {
        let now = 100;
        return () => now++;
      })(),
      observe: (observation) => observations.push(observation),
    },
  );
  await adapter.listProjects({ limit: 1 });

  assert.equal(observations.length, 2);
  for (const observation of observations) {
    assert.equal(observation.correlationId, "correlation-1");
    assert.equal(observation.status, 200);
    assert.equal(observation.durationMs, 1);
    assert.deepEqual(observation.requestWindow, { limit: 1000, remaining: 998, reset: 60 });
    assert.deepEqual(observation.complexityWindow, { limit: 250000, remaining: 249950, reset: 60 });
    assert.deepEqual(Object.keys(observation).sort(), [
      "complexityWindow", "correlationId", "durationMs", "operation", "requestWindow", "status",
    ]);
    assert.doesNotMatch(JSON.stringify(observation), /secret-canary|authorization|variables|query|Issue content/iu);
  }
});

test("physical SDK requests report sanitized 429 metadata", async (t) => {
  const observations = [];
  t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ errors: [{ message: "private upstream detail", extensions: { type: "Ratelimited" } }] }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-requests-limit": "1000",
        "x-ratelimit-requests-remaining": "0",
        "x-ratelimit-requests-reset": "42",
      },
    },
  ));
  const adapter = new LinearSdkImpl(
    { kind: "development_token", token: "secret-canary", delegateActorId: "app-user" },
    "organization-1",
    undefined,
    {
      correlationId: () => "correlation-429",
      now: () => 100,
      observe: (observation) => observations.push(observation),
    },
  );

  await assert.rejects(adapter.listProjects({ limit: 1 }));

  assert.deepEqual(observations, [{
    operation: "organization",
    correlationId: "correlation-429",
    durationMs: 0,
    status: 429,
    requestWindow: { limit: 1000, remaining: 0, reset: 42 },
  }]);
  assert.doesNotMatch(JSON.stringify(observations), /secret-canary|private upstream detail|authorization/iu);
});

test("physical SDK transport sends requests without an installation permit", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return new Response(JSON.stringify({
      data: {
        organization: { id: "organization-1", projectStatuses: [] },
        projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" }, "organization-1", undefined,
    {
      correlationId: () => "correlation-1", now: () => 0,
      observe: () => undefined,
    },
  );

  await adapter.listProjects({ limit: 1 });
  assert.equal(fetches, 2);
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


test("Root scheduling maps every Linear priority and preserves Root sort order", async () => {
  const roots = [0, 1, 2, 3, 4].map((priority) => issue({
    id: `root-${priority}`,
    priority,
    order: 10.5 + priority,
  }));
  const sdk = {
    viewer: Promise.resolve({ id: "app-user" }),
    project: async () => ({ issues: async () => connection(roots) }),
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  const result = await adapter.listRootIssues({
    projectId: "project-1",
    limit: 250,
  });

  assert.deepEqual(
    result.items.map(({ issue: root, priority, blockers }) => ({
      order: root.order,
      priority,
      blockers,
    })),
    [
      { order: 10.5, priority: "no_priority", blockers: [] },
      { order: 11.5, priority: "urgent", blockers: [] },
      { order: 12.5, priority: "high", blockers: [] },
      { order: 13.5, priority: "normal", blockers: [] },
      { order: 14.5, priority: "low", blockers: [] },
    ],
  );
});

test("Root scheduling batches one and 250 Root headers with one physical fact query per page", async () => {
  for (const rootCount of [1, 250]) {
    const roots = Array.from({ length: rootCount }, (_, index) => {
      const root = issue({ id: `root-${index}`, priority: index % 5, order: index });
      Object.defineProperties(root, {
        state: { get() { throw new Error("per-Root state read forbidden"); } },
      });
      root.comments = async () => { throw new Error("per-Root comment read forbidden"); };
      root.inverseRelations = async () => { throw new Error("per-Root relation read forbidden"); };
      return root;
    });
    let batchReads = 0;
    const sdk = {
      project: async () => ({ issues: async () => connection(roots) }),
      client: {
        async rawRequest(_query, variables) {
          batchReads += 1;
          assert.equal(variables.rootIds.length, rootCount);
          return { data: {
            viewer: { id: "app-user" },
            issues: {
              nodes: roots.map((root) => ({
                id: root.id,
                identifier: root.identifier,
                title: root.title,
                description: root.description,
                priority: root.priority,
                sortOrder: root.sortOrder,
                updatedAt: root.updatedAt.toISOString(),
                project: { id: root.projectId },
                parent: null,
                delegate: { id: "app-user" },
                state: { name: "Todo" },
                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                comments: { nodes: [], pageInfo: { hasNextPage: false } },
                inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
              })),
              pageInfo: { hasNextPage: false },
            },
          } };
        },
      },
    };
    const adapter = new LinearSdkImpl(
      { kind: "oauth", token: "token" },
      "organization-1",
      sdk,
    );

    const result = await adapter.listRootIssues({ projectId: "project-1", limit: 250 });

    assert.equal(result.items.length, rootCount);
    assert.equal(batchReads, 1);
  }
});

test("Root scheduling batch preserves managed comments and blocker facts", async () => {
  const primary = "Symphony\n\n<!-- symphony root\nversion: 3\n-->";
  const root = issue({ id: "root-1", priority: 2, order: 3 });
  const sdk = {
    project: async () => ({ issues: async () => connection([root]) }),
    client: {
      async rawRequest(query, variables) {
        assert.match(query, /comments\(first: 2, filter:/u);
        assert.equal(variables.commentMarker, "<!-- symphony root\n");
        return { data: {
          viewer: { id: "app-user" },
          issues: { nodes: [{
            id: "root-1",
            identifier: "ROOT-1",
            title: "Title",
            description: "Description",
            priority: 2,
            sortOrder: 3,
            updatedAt: "2026-07-16T00:00:00Z",
            project: { id: "project-1" },
            parent: null,
            delegate: { id: "app-user" },
            state: { name: "In Progress" },
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            comments: { nodes: [{
              id: "primary-1",
              body: primary,
              createdAt: "2026-07-16T00:00:00Z",
              updatedAt: "2026-07-16T00:00:00Z",
              user: { id: "app-user" },
              issue: { id: "root-1" },
            }], pageInfo: { hasNextPage: false } },
            inverseRelations: { nodes: [{
              type: "blocks",
              issue: { id: "blocker-1", state: { name: "Todo" } },
              relatedIssue: { id: "root-1" },
            }], pageInfo: { hasNextPage: false } },
          }], pageInfo: { hasNextPage: false } },
        } };
      },
    },
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  const result = await adapter.listRootIssues({ projectId: "project-1", limit: 250 });

  assert.equal(result.items[0].isDelegatedToSymphony, true);
  assert.equal(result.items[0].issue.state, "In Progress");
  assert.equal(result.items[0].rootManagedComments[0].body, primary);
  assert.deepEqual(result.items[0].blockers, [{
    sourceIssueId: "root-1",
    targetIssueId: "blocker-1",
    targetState: "Todo",
  }]);
});

test("Root scheduling batch exposes new workflow ownership records", async () => {
  const ownership = '<!-- symphony managed-record\n{"kind":"root_ownership"}\n-->';
  const root = issue({ id: "root-1", priority: 2, order: 3 });
  const sdk = {
    project: async () => ({ issues: async () => connection([root]) }),
    client: {
      async rawRequest(query, variables) {
        assert.match(query, /workflowManagedComments: comments\(first: 25, filter:/u);
        assert.equal(variables.workflowCommentMarker, "<!-- symphony managed-record\n");
        return { data: {
          viewer: { id: "app-user" },
          issues: { nodes: [{
            id: "root-1", identifier: "ROOT-1", title: "Title", description: "Description",
            priority: 2, sortOrder: 3, updatedAt: "2026-07-16T00:00:00Z",
            project: { id: "project-1" }, parent: null, delegate: { id: "app-user" },
            state: { name: "In Progress" },
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            comments: { nodes: [], pageInfo: { hasNextPage: false } },
            workflowManagedComments: { nodes: [{
              id: "ownership-1", body: ownership, createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:00Z", user: { id: "app-user" }, issue: { id: "root-1" },
            }], pageInfo: { hasNextPage: false } },
            inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
          }], pageInfo: { hasNextPage: false } },
        } };
      },
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const result = await adapter.listRootIssues({ projectId: "project-1", limit: 250 });

  assert.equal(result.items[0].rootManagedComments[0].body, ownership);
});

test("Root scheduling reads candidate facts with bounded concurrency", async () => {
  let releaseReads;
  const readsReleased = new Promise((resolve) => { releaseReads = resolve; });
  let activeReads = 0;
  let maxActiveReads = 0;
  const roots = Array.from({ length: 12 }, (_, index) => {
    const root = issue({ id: `root-${index}` });
    root.inverseRelations = async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await readsReleased;
      activeReads -= 1;
      return connection([]);
    };
    return root;
  });
  const sdk = {
    viewer: Promise.resolve({ id: "app-user" }),
    project: async () => ({ issues: async () => connection(roots) }),
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  const pending = adapter.listRootIssues({ projectId: "project-1", limit: 250 });
  await new Promise((resolve) => setImmediate(resolve));
  const observedConcurrency = maxActiveReads;
  releaseReads();
  await pending;

  assert.ok(observedConcurrency > 1);
  assert.ok(observedConcurrency <= 8);
});


test("Root scheduling reads every blocker page and target state outside the candidate set", async () => {
  const doneBlocker = issue({ id: "external-done" });
  doneBlocker.state = Promise.resolve({ id: "state-done", name: "Done" });
  const activeBlocker = issue({ id: "external-active" });
  activeBlocker.state = Promise.resolve({ id: "state-progress", name: "In Progress" });
  const root = issue({ id: "root-1" });
  root.inverseRelations = async () => paginatedConnection([
    [blocks(doneBlocker, root)],
    [blocks(activeBlocker, root)],
  ]);
  const sdk = {
    viewer: Promise.resolve({ id: "app-user" }),
    project: async () => ({ issues: async () => connection([root]) }),
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  const result = await adapter.listRootIssues({
    projectId: "project-1",
    limit: 250,
  });

  assert.deepEqual(result.items[0].blockers, [
    {
      sourceIssueId: "root-1",
      targetIssueId: "external-done",
      targetState: "Done",
    },
    {
      sourceIssueId: "root-1",
      targetIssueId: "external-active",
      targetState: "In Progress",
    },
  ]);
});

test("Root scheduling fails closed when a blocker relation has inconsistent endpoints", async () => {
  const blocker = issue({ id: "blocker-1" });
  const root = issue({ id: "root-1" });
  const wrongTarget = issue({ id: "root-2" });
  root.inverseRelations = async () => connection([blocks(blocker, wrongTarget)]);
  const sdk = {
    viewer: Promise.resolve({ id: "app-user" }),
    project: async () => ({ issues: async () => connection([root]) }),
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  await assert.rejects(
    adapter.listRootIssues({ projectId: "project-1", limit: 250 }),
    /linear_blocker_relation_invalid/u,
  );
});

test("Root scheduling fails closed for an unknown Linear priority", async () => {
  const root = issue({ id: "root-1", priority: 5 });
  const sdk = {
    viewer: Promise.resolve({ id: "app-user" }),
    project: async () => ({ issues: async () => connection([root]) }),
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  await assert.rejects(
    adapter.listRootIssues({ projectId: "project-1", limit: 250 }),
    /linear_issue_priority_invalid/u,
  );
});

test("Root scheduling fails closed for a cross-project Root", async () => {
  const root = issue({ id: "root-1" });
  root.projectId = "project-2";
  const sdk = {
    viewer: Promise.resolve({ id: "app-user" }),
    project: async () => ({ issues: async () => connection([root]) }),
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  await assert.rejects(
    adapter.listRootIssues({ projectId: "project-1", limit: 250 }),
    /linear_root_project_mismatch/u,
  );
});

test("workflow Issue Tree maps every bounded comment, relation, and Team status", async () => {
  const queries = [];
  const root = {
    id: "root-1", identifier: "ROOT-1", title: "Root", description: "Root description",
    sortOrder: 1, updatedAt: "2026-07-16T00:00:00Z", project: { id: "project-1" }, parent: null,
    state: { name: "In Progress" },
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [{ id: "comment-root", body: "Root status", createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:01Z", user: { id: "human-1" }, issue: { id: "root-1" } }], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [{ id: "relation-1", type: "blocks", issue: { id: "work-1", state: { name: "Todo" }, project: { id: "project-1" } }, relatedIssue: { id: "root-1", project: { id: "project-1" } } }], pageInfo: { hasNextPage: false } },
  };
  const child = {
    id: "work-1", identifier: "WORK-1", title: "Work", description: "Work description",
    sortOrder: 2, subIssueSortOrder: 2, updatedAt: "2026-07-16T00:00:02Z",
    project: { id: "project-1" }, parent: { id: "root-1" }, state: { name: "Todo" },
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [{ id: "comment-work", body: "Progress\n\n<!-- symphony workflow write\nwrite_id: write-1\n-->", createdAt: "2026-07-16T00:00:02Z", updatedAt: "2026-07-16T00:00:03Z", user: { id: "symphony-bot" }, issue: { id: "work-1" } }], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
  };
  const sdk = {
    async issue() {
      return {
        projectId: "project-1",
        team: Promise.resolve({ states: async () => connection([
          { id: "state-progress", name: "In Progress", type: "started", position: 2 },
          { id: "state-todo", name: "Todo", type: "unstarted", position: 1 },
          { id: "state-duplicate", name: "Duplicate", type: "duplicate", position: 3 },
        ]) }),
      };
    },
    client: { async rawRequest(query, variables) {
      queries.push(query);
      if (variables.rootIssueId) return { data: { issue: root } };
      return { data: { issues: {
        nodes: variables.parentIds.includes("root-1") ? [child] : [],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } };
    } },
  };
  const adapter = new LinearSdkImpl({ kind: "development_token", token: "token", delegateActorId: "symphony-bot" }, "organization-1", sdk);

  const tree = await adapter.getWorkflowIssueTree({ projectId: "project-1", rootIssueId: "root-1" });

  assert.ok(queries.some((query) => query.includes("comments(first: 8)")));
  assert.ok(queries.some((query) => query.includes("inverseRelations(first: 8)")));
  assert.ok(queries.some((query) => query.includes("includeArchived: true")));

  assert.deepEqual(tree.statusCatalog, [
    { statusId: "state-progress", name: "In Progress", category: "started", position: 2 },
    { statusId: "state-todo", name: "Todo", category: "unstarted", position: 1 },
    { statusId: "state-duplicate", name: "Duplicate", category: "canceled", position: 3 },
  ]);
  assert.deepEqual(tree.comments.map(({ commentId, issueId, managedMarker }) => ({ commentId, issueId, managedMarker })), [
    { commentId: "comment-root", issueId: "root-1", managedMarker: undefined },
    { commentId: "comment-work", issueId: "work-1", managedMarker: "write-1" },
  ]);
  assert.deepEqual(tree.comments.map(({ commentId, authorKind, authorId, authorUserId, createdAt }) => ({ commentId, authorKind, authorId, authorUserId, createdAt })), [
    { commentId: "comment-root", authorKind: "human", authorId: "human-1", authorUserId: "human-1", createdAt: "2026-07-16T00:00:00.000Z" },
    { commentId: "comment-work", authorKind: "symphony", authorId: "symphony-bot", authorUserId: "symphony-bot", createdAt: "2026-07-16T00:00:02.000Z" },
  ]);
  assert.deepEqual(tree.relations, [{
    relationId: "relation-1", relationKind: "blocks", sourceIssueId: "work-1", targetIssueId: "root-1",
  }]);
});

test("complete Workflow Issue Tree batches paginate nested comments and relations by issue", async () => {
  const calls = [];
  const root = {
    id: "root-1", identifier: "ROOT-1", title: "Root", description: "", sortOrder: 1,
    updatedAt: "2026-07-16T00:00:00Z", project: { id: "project-1" }, parent: null,
    state: { name: "Todo" }, labels: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: {
      nodes: [{ id: "comment-1", body: "first", createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:01Z", user: { id: "human-1" }, issue: { id: "root-1" } }],
      pageInfo: { hasNextPage: true, endCursor: "comments-2" },
    },
    inverseRelations: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "relations-2" },
    },
  };
  const child = {
    id: "work-1", identifier: "WORK-1", title: "Work", description: "", sortOrder: 1,
    subIssueSortOrder: 1, updatedAt: "2026-07-16T00:00:03Z",
    project: { id: "project-1" }, parent: { id: "root-1" }, state: { name: "Todo" },
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
  };
  const sdk = {
    viewer: Promise.resolve({ id: "viewer-1" }),
    async issue() {
      return {
        projectId: "project-1",
        team: Promise.resolve({
          states: async () => connection([{ id: "state-todo", name: "Todo", type: "unstarted", position: 1 }]),
        }),
      };
    },
    client: { async rawRequest(query, variables) {
    calls.push({ query, variables });
    if (variables.rootIssueId) return { data: { issue: root } };
    if (query.includes("IssueTreeComments")) return { data: { issue: {
      id: "root-1",
      comments: {
        nodes: [{ id: "comment-2", body: "second", createdAt: "2026-07-16T00:00:01Z", updatedAt: "2026-07-16T00:00:02Z", user: { id: "human-2" }, issue: { id: "root-1" } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    } } };
    if (query.includes("IssueTreeRelations")) return { data: { issue: {
      id: "root-1",
      inverseRelations: {
        nodes: [{ id: "relation-1", type: "blocks", issue: { id: "work-1", state: { name: "Todo" }, project: { id: "project-1" } }, relatedIssue: { id: "root-1", project: { id: "project-1" } } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    } } };
    return { data: { issues: {
      nodes: variables.parentIds?.includes("root-1") ? [child] : [],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } };
    } },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const tree = await adapter.getWorkflowIssueTree({ projectId: "project-1", rootIssueId: "root-1" });

  assert.equal(tree.comments.length, 2);
  assert.deepEqual(tree.relations, [{
    relationId: "relation-1", relationKind: "blocks", sourceIssueId: "work-1", targetIssueId: "root-1",
  }]);
  assert.deepEqual(calls.slice(1, 3).map(({ variables }) => variables), [
    { issueId: "root-1", cursor: "comments-2" },
    { issueId: "root-1", cursor: "relations-2" },
  ]);
});


test("target project configuration is read as a closed Podium value", async () => {
  const states = [
    { id: "todo-1", name: "Todo", type: "unstarted", position: 1 },
  ];
  const sdk = {
    organization: Promise.resolve({ id: "organization-1" }),
    async applicationInfo() { return { name: "Symphony" }; },
    async users() {
      return {
        nodes: [{ id: "actor-1", name: "Symphony", displayName: "Symphony", app: true }],
        pageInfo: { hasNextPage: false },
      };
    },
    async project() {
      return {
        id: "project-1", name: "Target", slugId: "project-slug-1",
        updatedAt: new Date("2026-07-22T00:00:00Z"),
        async teams() {
          return { nodes: [{
            id: "team-1",
            async states() { return { nodes: states, pageInfo: { hasNextPage: false } }; },
          }], pageInfo: { hasNextPage: false } };
        },
      };
    },
  };
  const adapter = new LinearSdkImpl({ kind: "development_token", token: "token", delegateActorId: "actor-1" }, "organization-1", sdk);

  const result = await adapter.readTargetProjectConfiguration({
    clientId: "client-1", projectSlugId: "project-slug-1",
  });

  assert.deepEqual(result, {
    organizationId: "organization-1",
    delegateActorId: "actor-1",
    project: {
      projectId: "project-1", organizationId: "organization-1", name: "Target",
      slugId: "project-slug-1", updatedAt: "2026-07-22T00:00:00.000Z",
    },
    teamId: "team-1",
    todoStateId: "todo-1",
  });
  assert.equal(JSON.stringify(result).includes("token"), false);
});

test("official SDK adapter creates a routed top-level Root and proves its label read-back", async () => {
  let createdInput;
  let created;
  const issueLabel = {
    id: "issue-label-1",
    name: "symphony:conductor/abc123def456",
    isGroup: false,
    archivedAt: null,
    retiredById: null,
    teamId: "team-1",
    organization: Promise.resolve({ id: "organization-1" }),
  };
  const project = {
    id: "project-1",
    updatedAt: new Date("2026-07-22T00:00:00Z"),
    async labels() {
      return connection([{ name: "symphony:conductor/abc123def456", isGroup: false, archivedAt: null, retiredById: null }]);
    },
    async teams() {
      return connection([{ id: "team-1" }]);
    },
  };
  const sdk = {
    organization: Promise.resolve({ id: "organization-1" }),
    async project() { return project; },
    async issueLabels() { return connection([issueLabel]); },
    async createIssue(input) {
      createdInput = input;
      created = issue({ id: "root-1", identifier: "SYM-1", title: input.title, description: input.description });
      created.labels = async () => connection([issueLabel]);
      return { success: true, issueId: "root-1" };
    },
    async issue() { return created; },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const result = await adapter.createRootIssue({
    projectId: "project-1",
    conductorShortHash: "abc123def456",
    title: "Routed Root",
    description: "A user-owned Root.",
  });

  assert.deepEqual(result, { rootIssueId: "root-1", identifier: "SYM-1", projectId: "project-1" });
  assert.deepEqual(createdInput.labelIds, ["issue-label-1"]);
  assert.equal(createdInput.parentId, undefined);
  assert.equal(createdInput.stateId, undefined);
});

test("Root creation rejects an out-of-pool member before issueCreate", async () => {
  let createCalls = 0;
  const sdk = {
    organization: Promise.resolve({ id: "organization-1" }),
    async project() {
      return {
        id: "project-1",
        updatedAt: new Date("2026-07-22T00:00:00Z"),
        async labels() { return connection([{ name: "symphony:conductor/abc123def456", isGroup: false, archivedAt: null, retiredById: null }]); },
        async teams() { return connection([{ id: "team-1" }]); },
      };
    },
    async createIssue() { createCalls += 1; return { success: true, issueId: "never" }; },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  await assert.rejects(
    adapter.createRootIssue({
      projectId: "project-1",
      conductorShortHash: "def456abc123",
      title: "Rejected",
      description: "Must fail closed.",
    }),
    /linear_root_creation_conductor_not_in_pool/u,
  );
  assert.equal(createCalls, 0);
});

test("Project label rebind rejects a conflicting label introduced after preflight", async () => {
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
    organization: Promise.resolve({ id: "organization-1" }),
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
    /linear_project_label_precondition_conflict/,
  );
});

test("Project label rebind moves a desired Conductor label from another Project", async () => {
  const otherProject = { id: "project-other" };
  const desiredLabel = {
    id: "label-desired",
    name: "symphony:conductor/abc123",
    isGroup: false,
    archivedAt: null,
    retiredById: undefined,
    organization: Promise.resolve({ id: "organization-1" }),
    projects: async () => connection(
      [...labelProjects].map(([id]) => id === "project-1" ? project : otherProject),
    ),
  };
  let additions = 0;
  let removals = 0;
  const labelProjects = new Map([["project-other", desiredLabel]]);
  const project = {
    id: "project-1",
    labels: async () => connection(labelProjects.has("project-1") ? [desiredLabel] : []),
  };
  otherProject.labels = async () => connection(labelProjects.has("project-other") ? [desiredLabel] : []);
  const sdk = {
    organization: Promise.resolve({ id: "organization-1" }),
    project: async (projectId) => projectId === "project-other" ? otherProject : project,
    projectLabels: async () => connection([desiredLabel]),
    projectAddLabel: async () => {
      additions += 1;
      labelProjects.set("project-1", desiredLabel);
      return { success: true };
    },
    projectRemoveLabel: async (projectId) => {
      removals += 1;
      labelProjects.delete(projectId);
      return { success: true };
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  await adapter.assignConductorProjectLabel({
    projectId: "project-1",
    labelName: "symphony:conductor/abc123",
  });
  assert.equal(additions, 1);
  assert.equal(removals, 1);
  assert.deepEqual([...labelProjects.keys()], ["project-1"]);
});

test("Project label rebind creates a missing desired label and proves attachment", async () => {
  let created = false;
  let attached = false;
  let projectLabelReads = 0;
  const project = {
    id: "project-1",
    labels: async () => {
      projectLabelReads += 1;
      return connection(attached ? [label] : []);
    },
  };
  const label = {
    id: "label-created",
    name: "symphony:conductor/abc123",
    isGroup: false,
    archivedAt: null,
    retiredById: undefined,
    organization: Promise.resolve({ id: "organization-1" }),
    projects: async () => connection(attached ? [project] : []),
  };
  const sdk = {
    organization: Promise.resolve({ id: "organization-1" }),
    project: async () => project,
    projectLabels: async () => connection(created ? [label] : []),
    createProjectLabel: async () => {
      created = true;
      return { success: true, projectLabel: Promise.resolve(label) };
    },
    projectAddLabel: async () => {
      attached = true;
      return { success: true };
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const plan = await adapter.preflightConductorProjectLabel({
    projectId: "project-1",
    labelName: "symphony:conductor/abc123",
  });
  assert.equal(plan.kind, "ready");
  assert.equal(plan.desiredLabel, undefined);
  const result = await adapter.rebindConductorProjectLabel({ plan, authorized: true });

  assert.equal(result.kind, "applied");
  assert.equal(created, true);
  assert.equal(attached, true);
  assert.equal(projectLabelReads, 3);
});

test("workflow SDK mutations keep managed markers and use the explicit status and relation inputs", async () => {
  const parent = issue({ id: "root-1" });
  let createdInput;
  let updatedInput;
  let commentInput;
  let relationInput;
  parent.team = Promise.resolve({
    states: async () => connection([{ id: "state-todo", name: "Todo", type: "unstarted", position: 1 }]),
  });
  const work = issue({ id: "work-1", parentId: "root-1" });
  parent.children = async () => connection([work]);
  const sdk = {
    issue: async (issueId) => issueId === "root-1" ? parent : work,
    async createIssue(input) {
      createdInput = input;
      return { success: true, issueId: "cycle-1" };
    },
    async issueLabels({ filter }) {
      return connection(["Human Action", "Plan Review"]
        .filter((name) => name === filter?.name?.eq)
        .map((name) => workflowIssueLabel(name, name === "Human Action" ? 0 : 1)));
    },
    async updateIssue(_issueId, input) { updatedInput = input; },
    async createComment(input) { commentInput = input; },
    async createIssueRelation(input) { relationInput = input; return { success: true }; },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  await adapter.executeWorkflowMutation({
    kind: "create_workflow_issue", writeId: "write-1", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    parentExpectedRemoteVersion: "parent-version", parentExpectedStatusId: "state-todo",
    parentIssueId: "root-1", issueKind: "cycle", title: "Cycle", description: "Plan it",
    statusId: "state-todo", managedMarker: "cycle-marker", labelNames: ["Human Action", "Plan Review"], order: 3,
  });
  assert.equal(createdInput.stateId, "state-todo");
  assert.deepEqual(createdInput.labelIds, ["issue-label-1", "issue-label-2"]);
  assert.equal(createdInput.subIssueSortOrder, 3);
  assert.match(createdInput.description, /managed_marker: cycle-marker/u);
  assert.match(createdInput.description, /issue_kind: cycle/u);

  await adapter.executeWorkflowMutation({
    kind: "append_workflow_comment", writeId: "write-2", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "root-1", expectedRemoteVersion: "root-version" }, body: "Progress",
  });
  assert.equal(commentInput.issueId, "root-1");
  assert.match(commentInput.body, /symphony workflow write/u);

  const managedRecord = "<!-- symphony managed-record\n{\"kind\":\"root_ownership\"}\n-->";
  await adapter.executeWorkflowMutation({
    kind: "append_workflow_comment", writeId: "write-record", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "root-1", expectedRemoteVersion: "root-version" }, body: managedRecord,
  });
  assert.equal(commentInput.body, managedRecord);

  await adapter.executeWorkflowMutation({
    kind: "create_workflow_relation", writeId: "write-3", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    sourceIssueId: "work-1", sourceExpectedRemoteVersion: "work-version",
    targetIssueId: "root-1", targetExpectedRemoteVersion: "root-version", relationKind: "blocks",
  });
  assert.deepEqual(relationInput, { issueId: "work-1", relatedIssueId: "root-1", type: "blocks" });

  const targetIssue = issue({
    id: "work-1", parentId: "root-1", title: "Work",
    description: "Work description\n\n<!-- symphony workflow issue\nmanaged_marker: work-marker\nissue_kind: work\n-->",
  });
  const targetRootIssue = issue({ id: "root-1" });
  targetRootIssue.team = Promise.resolve({
    states: async () => connection([{ id: "state-todo", name: "Todo", type: "unstarted", position: 1 }]),
  });
  targetRootIssue.children = async () => connection([targetIssue]);
  const targetAdapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    issue: async (issueId) => issueId === "root-1" ? targetRootIssue : targetIssue,
    async updateIssue(_issueId, input) { updatedInput = input; },
  });
  const target = await targetAdapter.readWorkflowMutationTarget("work-1");
  assert.deepEqual(target, {
    issueId: "work-1", projectId: "project-1", updatedAt: "2026-07-16T00:00:00.000Z",
    labels: [],
    isArchived: false,
    parentIssueId: "root-1", statusId: "state-todo", title: "Work",
    description: "Work description", managedMarker: "work-marker", workflowKind: "work",
  });
  await targetAdapter.executeWorkflowMutation({
    kind: "update_workflow_issue", writeId: "write-4", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "work-1", expectedRemoteVersion: target.updatedAt, expectedManagedMarker: "work-marker" },
    statusId: "state-todo", title: "Updated work", description: "Updated description",
  });
  assert.equal(updatedInput.title, "Updated work");
  assert.match(updatedInput.description, /managed_marker: work-marker/u);
});

test("workflow issue creation rejects unknown and duplicate label names", async () => {
  const parent = issue({ id: "root-1" });
  parent.team = Promise.resolve({
    states: async () => connection([{ id: "state-todo", name: "Todo", type: "unstarted", position: 1 }]),
  });
  const sdk = {
    issue: async () => parent,
    async issueLabels({ filter }) {
      return connection(filter?.name?.eq === "Human Action"
        ? [workflowIssueLabel("Human Action", 0)] : []);
    },
    async createIssue() { throw new Error("issueCreate should not run"); },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);
  const command = {
    kind: "create_workflow_issue", writeId: "write-label", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    parentExpectedRemoteVersion: "parent-version", parentExpectedStatusId: "state-todo",
    parentIssueId: "root-1", issueKind: "human", title: "Human Action", description: "Decide",
    statusId: "state-todo", managedMarker: "action-marker", labelNames: ["Unknown label"],
  };
  await assert.rejects(adapter.executeWorkflowMutation(command), /linear_workflow_label_missing/u);
  await assert.rejects(
    adapter.executeWorkflowMutation({ ...command, writeId: "write-duplicate", labelNames: ["Human Action", "Human Action"] }),
    /linear_workflow_label_duplicate/u,
  );
});

test("workflow SDK archive mutations use native Linear calls and preserve archive preconditions", async () => {
  const root = issue({ id: "root-1" });
  const target = issue({ id: "work-1", parentId: "root-1" });
  let archiveCalls = 0;
  let restoreCalls = 0;
  target.archive = async () => {
    archiveCalls += 1;
    target.archivedAt = new Date("2026-07-16T00:00:01Z");
    return { success: true };
  };
  target.unarchive = async () => {
    restoreCalls += 1;
    target.archivedAt = null;
    return { success: true };
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    issue: async (issueId) => issueId === "root-1" ? root : target,
  });
  const command = {
    kind: "archive_workflow_issue", writeId: "write-archive", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: root.updatedAt.toISOString(),
    target: { targetIssueId: "work-1", expectedRemoteVersion: target.updatedAt.toISOString(), expectedIsArchived: false },
  };

  await adapter.executeWorkflowMutation(command);
  assert.equal(archiveCalls, 1);
  assert.equal(restoreCalls, 0);
  assert.deepEqual(await adapter.readWorkflowMutationOutcome(command), {
    writeId: "write-archive", targetIssueId: "work-1", remoteVersion: target.updatedAt.toISOString(),
    issueVersions: [{ issueId: "work-1", remoteVersion: target.updatedAt.toISOString() }],
  });

  await assert.rejects(
    adapter.executeWorkflowMutation(command),
    /linear_precondition_conflict/u,
  );
  assert.equal(archiveCalls, 1);

  await adapter.executeWorkflowMutation({
    ...command,
    kind: "restore_workflow_issue",
    writeId: "write-restore",
    target: { ...command.target, expectedRemoteVersion: target.updatedAt.toISOString(), expectedIsArchived: true },
  });
  assert.equal(restoreCalls, 1);
  assert.equal(target.archivedAt, null);
});

test("workflow relation compact read-back returns the source Issue updatedAt", async () => {
  const root = issue({ id: "root-1" });
  const source = issue({ id: "source-1", parentId: "root-1" });
  const target = issue({ id: "target-1", parentId: "root-1" });
  const command = {
    kind: "create_workflow_relation", writeId: "write-relation", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: root.updatedAt,
    sourceIssueId: "source-1", sourceExpectedRemoteVersion: source.updatedAt,
    targetIssueId: "target-1", targetExpectedRemoteVersion: target.updatedAt, relationKind: "blocks",
  };
  const rawOperations = [];
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    issue: async (id) => id === "root-1" ? root : id === "source-1" ? source : target,
    client: {
      async rawRequest() {
        rawOperations.push(arguments[0]);
        if (rawOperations.at(-1).includes("WorkflowMutationScope")) {
          return { data: { issue: {
            id: "source-1", project: { id: "project-1" },
            parent: { id: "root-1", project: { id: "project-1" }, parent: null },
          } } };
        }
        return { data: { root: {
          id: "root-1", updatedAt: "2026-07-16T00:00:06Z", project: { id: "project-1" }, parent: null,
        }, source: {
          id: "source-1", updatedAt: "2026-07-16T00:00:04Z", project: { id: "project-1" },
          parent: { id: "cycle-1", updatedAt: "2026-07-16T00:00:06Z", project: { id: "project-1" },
            parent: { id: "root-1", updatedAt: "2026-07-16T00:00:06Z", project: { id: "project-1" }, parent: null } },
        }, issue: {
          id: "target-1", updatedAt: "2026-07-16T00:00:05Z", project: { id: "project-1" },
          parent: { id: "cycle-1", updatedAt: "2026-07-16T00:00:06Z", project: { id: "project-1" },
            parent: { id: "root-1", updatedAt: "2026-07-16T00:00:06Z", project: { id: "project-1" }, parent: null } },
          inverseRelations: {
            nodes: [{
              type: "blocks",
              issue: { id: "source-1", updatedAt: "2026-07-16T00:00:03Z", project: { id: "project-1" } },
              relatedIssue: { id: "target-1", updatedAt: "2026-07-16T00:00:07Z", project: { id: "project-1" } },
            }],
            pageInfo: { hasNextPage: false },
          },
        } } };
      },
    },
  });

  assert.deepEqual(await adapter.readWorkflowMutationOutcome(command), {
    writeId: "write-relation", targetIssueId: "source-1", remoteVersion: "2026-07-16T00:00:04Z",
    issueVersions: [
      { issueId: "source-1", remoteVersion: "2026-07-16T00:00:04Z" },
      { issueId: "target-1", remoteVersion: "2026-07-16T00:00:07Z" },
      { issueId: "cycle-1", remoteVersion: "2026-07-16T00:00:06Z" },
      { issueId: "root-1", remoteVersion: "2026-07-16T00:00:06Z" },
    ],
  });
  assert.equal(rawOperations.length, 1);
});

test("workflow blocked_by read-back maps Linear relation versions to command endpoints", async () => {
  const root = issue({ id: "root-1" });
  const blocked = issue({ id: "blocked-1", parentId: "root-1" });
  const dependency = issue({ id: "dependency-1", parentId: "root-1" });
  const command = {
    kind: "create_workflow_relation", writeId: "write-blocked-by", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: root.updatedAt,
    sourceIssueId: "blocked-1", sourceExpectedRemoteVersion: blocked.updatedAt,
    targetIssueId: "dependency-1", targetExpectedRemoteVersion: dependency.updatedAt, relationKind: "blocked_by",
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    issue: async (id) => id === "root-1" ? root : id === "blocked-1" ? blocked : dependency,
    client: {
      async rawRequest() {
        return { data: { root: {
          id: "root-1", updatedAt: "2026-07-16T00:00:06Z", project: { id: "project-1" }, parent: null,
        }, source: {
          id: "dependency-1", updatedAt: "2026-07-16T00:00:05Z", project: { id: "project-1" },
          parent: { id: "root-1", updatedAt: "2026-07-16T00:00:06Z", project: { id: "project-1" }, parent: null },
        }, issue: {
          id: "blocked-1", updatedAt: "2026-07-16T00:00:04Z", project: { id: "project-1" },
          parent: { id: "root-1", updatedAt: "2026-07-16T00:00:06Z", project: { id: "project-1" }, parent: null },
          inverseRelations: {
            nodes: [{
              type: "blocks",
              issue: { id: "dependency-1", updatedAt: "2026-07-16T00:00:07Z", project: { id: "project-1" } },
              relatedIssue: { id: "blocked-1", updatedAt: "2026-07-16T00:00:03Z", project: { id: "project-1" } },
            }],
            pageInfo: { hasNextPage: false },
          },
        } } };
      },
    },
  });

  assert.deepEqual(await adapter.readWorkflowMutationOutcome(command), {
    writeId: "write-blocked-by", targetIssueId: "blocked-1", remoteVersion: "2026-07-16T00:00:04Z",
    issueVersions: [
      { issueId: "blocked-1", remoteVersion: "2026-07-16T00:00:04Z" },
      { issueId: "dependency-1", remoteVersion: "2026-07-16T00:00:07Z" },
      { issueId: "root-1", remoteVersion: "2026-07-16T00:00:06Z" },
    ],
  });
});

test("workflow relation mutation batches source and target scope ancestry", async () => {
  const root = issue({ id: "root-1" });
  const source = issue({ id: "source-1", parentId: "root-1" });
  const target = issue({ id: "target-1", parentId: "root-1" });
  const rawQueries = [];
  let writes = 0;
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    issue: async (id) => id === "source-1" ? source : target,
    async createIssueRelation() { writes += 1; return { success: true }; },
    client: {
      async rawRequest(query) {
        rawQueries.push(query);
        assert.match(query, /WorkflowMutationScopeBatch/u);
        return { data: { issues: { nodes: [
          { id: "source-1", project: { id: "project-1" }, parent: { id: "root-1", project: { id: "project-1" }, parent: null } },
          { id: "target-1", project: { id: "project-1" }, parent: { id: "root-1", project: { id: "project-1" }, parent: null } },
        ] } } };
      },
    },
  });

  await adapter.executeWorkflowMutation({
    kind: "create_workflow_relation", writeId: "write-batch", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: root.updatedAt,
    sourceIssueId: "source-1", sourceExpectedRemoteVersion: source.updatedAt,
    targetIssueId: "target-1", targetExpectedRemoteVersion: target.updatedAt, relationKind: "blocks",
  });
  assert.equal(rawQueries.length, 1);
  assert.equal(writes, 1);
});

test("workflow issue read-back batches child status facts", async () => {
  const parent = issue({ id: "root-1" });
  const childDescription = "Implement\n\n<!-- symphony workflow issue\nmanaged_marker: work-marker\nissue_kind: work\n-->";
  const rawQueries = [];
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    issue: async () => parent,
    client: {
      async rawRequest(query) {
        rawQueries.push(query);
        if (query.includes("WorkflowMutationScope")) {
          return { data: { issue: {
            id: "root-1", project: { id: "project-1" }, parent: null,
          } } };
        }
        assert.match(query, /WorkflowMutationChildren/u);
        return { data: { issue: {
          id: "root-1", updatedAt: "2026-07-22T00:00:01Z", project: { id: "project-1" }, parent: null,
          children: {
          nodes: [{
            id: "work-1", updatedAt: "2026-07-22T00:00:00Z", project: { id: "project-1" },
            parent: { id: "root-1" }, state: { id: "state-todo" }, title: "Implement",
            description: childDescription,
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
          }],
          pageInfo: { hasNextPage: false },
        } } } };
      },
    },
  });
  const command = {
    kind: "create_workflow_issue", writeId: "write-child-read", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: parent.updatedAt,
    parentExpectedRemoteVersion: parent.updatedAt, parentExpectedStatusId: "state-todo",
    parentIssueId: "root-1", issueKind: "work", title: "Implement", description: "Implement",
    statusId: "state-todo", managedMarker: "work-marker", labelNames: [],
  };
  assert.deepEqual(await adapter.readWorkflowMutationOutcome(command), {
    writeId: "write-child-read", targetIssueId: "work-1", remoteVersion: "2026-07-22T00:00:00Z",
    issueVersions: [{ issueId: "root-1", remoteVersion: "2026-07-22T00:00:01Z" }],
  });
  assert.equal(rawQueries.filter((query) => query.includes("WorkflowMutationChildren")).length, 1);
  assert.equal(rawQueries.length, 1);
  await assert.rejects(
    adapter.readWorkflowMutationOutcome({ ...command, writeId: "write-child-label-mismatch", labelNames: ["Human Action"] }),
    /linear_precondition_conflict/u,
  );
});

test("workflow SDK compact preflight validates all update facts in one physical request", async () => {
  const rawQueries = [];
  const description = "Existing\n\n<!-- symphony workflow issue\nmanaged_marker: work-marker\nissue_kind: work\n-->";
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    client: { async rawRequest(query) {
      rawQueries.push(query);
      return { data: { issues: { nodes: [
        {
          id: "root-1", updatedAt: "root-version", project: { id: "project-1" }, parent: null,
          state: { id: "status-progress" }, title: "Root", description: "Root",
          team: { id: "team-1", states: { nodes: [{ id: "status-progress" }], pageInfo: { hasNextPage: false } } },
          comments: { nodes: [], pageInfo: { hasNextPage: false } },
          children: { nodes: [], pageInfo: { hasNextPage: false } },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
        },
        {
          id: "work-1", updatedAt: "work-version", project: { id: "project-1" },
          parent: { id: "root-1", project: { id: "project-1" }, parent: null },
          state: { id: "status-todo" }, title: "Existing", description,
          team: { id: "team-1", states: { nodes: [{ id: "status-progress" }], pageInfo: { hasNextPage: false } } },
          comments: { nodes: [], pageInfo: { hasNextPage: false } },
          children: { nodes: [], pageInfo: { hasNextPage: false } },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      ] } } };
    } },
  });
  const result = await adapter.preflightWorkflowMutation({
    kind: "update_workflow_issue", writeId: "write-preflight", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "work-1", expectedRemoteVersion: "work-version", expectedStatusId: "status-todo", expectedParentIssueId: "root-1", expectedManagedMarker: "work-marker" },
    statusId: "status-progress", title: "Updated", description: "Updated description",
  });

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(rawQueries.length, 1);
  assert.match(rawQueries[0], /WorkflowMutationPreflight/u);
});

test("workflow SDK mutations reject targets outside the requested Root tree", async () => {
  let writes = 0;
  const root = issue({ id: "root-1" });
  const foreign = issue({ id: "foreign-1", title: "Updated", description: "Description" });
  root.team = Promise.resolve({
    states: async () => connection([{ id: "state-todo", name: "Todo", type: "unstarted", position: 1 }]),
  });
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    issue: async (issueId) => issueId === "root-1" ? root : foreign,
    async updateIssue() { writes += 1; },
  });

  const command = {
    kind: "update_workflow_issue", writeId: "write-foreign", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "foreign-1", expectedRemoteVersion: "foreign-version" },
    statusId: "state-todo", title: "Updated", description: "Description",
  };
  await assert.rejects(
    adapter.executeWorkflowMutation(command),
    /linear_precondition_conflict/u,
  );
  assert.equal(await adapter.readWorkflowMutationOutcome(command), undefined);
  assert.equal(writes, 0);
});

function retainedWorkflowStates() {
  return [
    ["backlog-1", "Backlog", "backlog"],
    ["todo-1", "Todo", "unstarted"],
    ["progress-1", "In Progress", "started"],
    ["review-1", "In Review", "started"],
    ["done-1", "Done", "completed"],
    ["canceled-1", "Canceled", "canceled"],
    ["duplicate-1", "Duplicate", "duplicate"],
  ].map(([id, name, type], position) => ({ id, name, type, position }));
}

function workflowSetupSdk(states, { failAfterCreate, issueLabelNames = [] } = {}) {
  const observations = { projects: 0, teams: 0, states: 0, batches: 0, updates: [], creates: [], labelCreates: [] };
  const labels = issueLabelNames.map((name, index) => issueLabel(name, index));
  const team = {
    id: "team-1",
    states: async () => {
      observations.states += 1;
      return connection(states);
    },
  };
  return {
    observations,
    sdk: {
      client: {
        async rawRequest() {
          observations.batches += 1;
          const canonical = [
            ["Draft", "backlog"], ["Todo", "unstarted"], ["Planning", "started"],
            ["Sealed", "started"], ["Executing", "started"], ["Verifying", "started"],
            ["In Progress", "started"], ["In Review", "started"], ["Needs Approval", "started"],
            ["Needs Info", "started"], ["Inconclusive", "started"], ["Escalated", "started"],
            ["Succeeded", "completed"], ["Changes Required", "completed"], ["Done", "completed"],
            ["Canceled", "canceled"], ["Failed", "canceled"], ["Duplicate", "duplicate"],
          ];
          const backlog = states.find((value) => value.id === "backlog-1");
          if (backlog && backlog.name === "Backlog") {
            backlog.name = "Draft";
            observations.updates.push({ id: backlog.id, input: { name: "Draft" } });
          }
          for (const [name, type] of canonical) {
            if (states.some((value) => value.name === name && value.type === type)) continue;
            observations.creates.push({ teamId: "team-1", name, type });
            states.push({ id: `created-${states.length}`, name, type, position: states.length });
          }
          if (failAfterCreate?.has("Planning")) throw new Error("network_write_lost");
          return { operation0: { success: true } };
        },
      },
      issueLabels: async ({ filter }) => connection(labels.filter(({ name }) => name === filter?.name?.eq)),
      async createIssueLabel(input) {
        observations.labelCreates.push(input.name);
        const label = issueLabel(input.name, labels.length);
        labels.push(label);
        return { success: true, issueLabel: Promise.resolve(label) };
      },
      organization: Promise.resolve({ id: "organization-1" }),
      project: async (projectId) => {
        observations.projects += 1;
        return {
          id: projectId,
          teams: async () => {
            observations.teams += 1;
            return connection([team]);
          },
        };
      },
      async updateWorkflowState(id, input) {
        observations.updates.push({ id, input });
        const state = states.find((value) => value.id === id);
        state.name = input.name;
      },
      async createWorkflowState(input) {
        observations.creates.push(input);
        states.push({
          id: `created-${states.length}`,
          name: input.name,
          type: input.type,
          position: states.length,
        });
        if (failAfterCreate?.has(input.name)) throw new Error("network_write_lost");
      },
    },
  };
}

function issueLabel(name, index) {
  return {
    id: `label-${index + 1}`,
    name,
    isGroup: false,
    archivedAt: null,
    retiredById: null,
    teamId: "team-1",
    organization: Promise.resolve({ id: "organization-1" }),
  };
}

test("Team workflow setup returns a bounded dry-run without explicit authorization", async () => {
  const { sdk } = workflowSetupSdk(retainedWorkflowStates());
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const result = await adapter.initializeTargetTeamWorkflow({ projectId: "project-1", authorized: false });

  assert.equal(result.kind, "dry_run");
  assert.equal(result.currentStatuses.length, 7);
  assert.equal(result.nativeDuplicate.category, "duplicate");
  assert.equal(result.operations.length, 12);
  assert.equal(result.operations.at(-1)?.name, "Failed");
  assert.deepEqual(result.humanActionLabels, [
    "Human Action", "Plan Review", "Clarification", "Permission", "Finding Waiver", "Convergence Override",
  ]);
});

test("Team workflow setup renames Backlog, creates missing states, and reads back each write", async () => {
  const { sdk, observations } = workflowSetupSdk(retainedWorkflowStates());
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const result = await adapter.initializeTargetTeamWorkflow({
    projectId: "project-1",
    authorized: true,
  });

  assert.equal(result.kind, "applied");
  assert.equal(result.projectId, "project-1");
  assert.equal(result.teamId, "team-1");
  assert.equal(result.canonicalStatuses.length, 17);
  assert.equal(result.nativeDuplicate.name, "Duplicate");
  assert.deepEqual(observations.updates, [
    { id: "backlog-1", input: { name: "Draft" } },
  ]);
  assert.deepEqual(observations.creates.map(({ name, type }) => ({ name, type })), [
    ["Planning", "started"], ["Sealed", "started"], ["Executing", "started"],
    ["Verifying", "started"], ["Needs Approval", "started"], ["Needs Info", "started"],
    ["Inconclusive", "started"], ["Escalated", "started"], ["Succeeded", "completed"],
    ["Changes Required", "completed"], ["Failed", "canceled"],
  ].map(([name, type]) => ({ name, type })));
  assert.deepEqual(observations.labelCreates, [
    "Human Action", "Plan Review", "Clarification", "Permission", "Finding Waiver", "Convergence Override",
  ]);
  assert.equal(observations.states, 2);
});

test("Team workflow setup batches real GraphQL status mutations and reads the catalog back once", async () => {
  const states = retainedWorkflowStates();
  const { sdk, observations } = workflowSetupSdk(states);
  observations.batches = 0;
  sdk.client = {
    rawRequest: async (query) => {
      observations.batches += 1;
      states.splice(0, states.length, ...[
        ["draft-1", "Draft", "backlog"], ["todo-1", "Todo", "unstarted"],
        ["planning-1", "Planning", "started"], ["sealed-1", "Sealed", "started"],
        ["executing-1", "Executing", "started"], ["verifying-1", "Verifying", "started"],
        ["progress-1", "In Progress", "started"], ["review-1", "In Review", "started"],
        ["approval-1", "Needs Approval", "started"], ["info-1", "Needs Info", "started"],
        ["inconclusive-1", "Inconclusive", "started"], ["escalated-1", "Escalated", "started"],
        ["succeeded-1", "Succeeded", "completed"], ["changes-1", "Changes Required", "completed"],
        ["done-1", "Done", "completed"], ["canceled-1", "Canceled", "canceled"],
        ["failed-1", "Failed", "canceled"], ["duplicate-1", "Duplicate", "duplicate"],
      ].map(([id, name, type], position) => ({ id, name, type, position })));
      return Object.fromEntries([...query.matchAll(/operation[0-9]+/gu)].map(([alias]) => [alias, { success: true }]));
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const result = await adapter.initializeTargetTeamWorkflow({ projectId: "project-1", authorized: true });

  assert.equal(result.kind, "applied");
  assert.equal(observations.batches, 1);
  assert.equal(observations.states, 2);
});

test("Team workflow setup fails closed when the SDK cannot submit a mutation batch", async () => {
  const { sdk } = workflowSetupSdk(retainedWorkflowStates());
  delete sdk.client;
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  await assert.rejects(
    adapter.initializeTargetTeamWorkflow({ projectId: "project-1", authorized: true }),
    /linear_workflow_batch_unsupported/u,
  );
});

test("Team workflow setup treats a lost create response as applied when read-back finds the state", async () => {
  const { sdk } = workflowSetupSdk(retainedWorkflowStates(), {
    failAfterCreate: new Set(["Planning"]),
  });
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const result = await adapter.initializeTargetTeamWorkflow({
    projectId: "project-1",
    authorized: true,
  });

  assert.equal(result.kind, "applied");
  assert.equal(result.canonicalStatuses.find(({ name }) => name === "Planning")?.category, "started");
});

test("Team workflow setup is a no-op after the canonical catalog and labels are complete", async () => {
  const states = [
    ["draft-1", "Draft", "backlog"], ["todo-1", "Todo", "unstarted"],
    ["planning-1", "Planning", "started"], ["sealed-1", "Sealed", "started"],
    ["executing-1", "Executing", "started"], ["verifying-1", "Verifying", "started"],
    ["progress-1", "In Progress", "started"], ["review-1", "In Review", "started"],
    ["approval-1", "Needs Approval", "started"], ["info-1", "Needs Info", "started"],
    ["inconclusive-1", "Inconclusive", "started"], ["escalated-1", "Escalated", "started"],
    ["succeeded-1", "Succeeded", "completed"], ["changes-1", "Changes Required", "completed"],
    ["done-1", "Done", "completed"], ["canceled-1", "Canceled", "canceled"],
    ["failed-1", "Failed", "canceled"], ["duplicate-1", "Duplicate", "duplicate"],
  ].map(([id, name, type], position) => ({ id, name, type, position }));
  const { sdk, observations } = workflowSetupSdk(states, {
    issueLabelNames: [
      "Human Action", "Plan Review", "Clarification", "Permission", "Finding Waiver", "Convergence Override",
    ],
  });
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const result = await adapter.initializeTargetTeamWorkflow({ projectId: "project-1", authorized: true });

  assert.equal(result.kind, "already_applied");
  assert.deepEqual(result.humanActionLabels, [
    "Human Action", "Plan Review", "Clarification", "Permission", "Finding Waiver", "Convergence Override",
  ]);
  assert.equal(observations.updates.length, 0);
  assert.equal(observations.creates.length, 0);
  assert.equal(observations.labelCreates.length, 0);
});
