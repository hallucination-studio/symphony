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
    labels: async () => connection([]),
  };
  return value;
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

test("physical SDK transport checks its installation permit before fetch", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    throw new Error("fetch should not run");
  });
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" }, "organization-1", undefined,
    {
      correlationId: () => "correlation-1", now: () => 0,
      permit: () => { throw new Error("linear_request_capacity_reserved"); },
      observe: () => undefined,
    },
  );

  await assert.rejects(adapter.listProjects({ limit: 1 }), /linear_request_capacity_reserved/iu);
  assert.equal(fetches, 0);
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

test("metadata lookups use exact server-side name filters", async () => {
  const observed = {};
  const phaseLabel = {
    id: "phase-label",
    name: "symphony:run/working",
    isGroup: false,
    archivedAt: undefined,
    retiredById: undefined,
    teamId: "team-1",
    organization: Promise.resolve({ id: "organization-1" }),
  };
  const root = issue({ id: "root-1" });
  root.labels = async () => connection([]);
  const sdk = {
    projectLabels: async (input) => {
      observed.projectLabels = input;
      return connection([]);
    },
    issue: async () => root,
    issueLabels: async (input) => {
      observed.issueLabels = input;
      return connection([phaseLabel]);
    },
    issueAddLabel: async () => ({ success: true }),
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  assert.deepEqual(await adapter.readProjectResolution({ conductorShortHash: "abc123" }), {
    kind: "unbound",
  });
  await adapter.executeMutation({
    kind: "replace_root_phase_label",
    project: {
      conductorShortHash: "abc123",
      expectedProjectId: "project-1",
      expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
    },
    precondition: {
      expectedIssueId: "root-1",
      expectedUpdatedAt: "2026-07-16T00:00:00Z",
    },
    phase: "working",
  });

  assert.deepEqual(observed.projectLabels, {
    first: 3,
    includeArchived: false,
    filter: { name: { eq: "symphony:conductor/abc123" }, isGroup: { eq: false } },
  });
  assert.deepEqual(observed.issueLabels, {
    first: 3,
    includeArchived: false,
    filter: { name: { eq: "symphony:run/working" }, isGroup: { eq: false } },
  });
});

test("workflow state lookup uses an exact server-side name filter", async () => {
  let stateLookup;
  const root = issue({ id: "root-1" });
  root.team = Promise.resolve({
    states: async (input) => {
      stateLookup = input;
      return connection([{ id: "state-progress", name: "In Progress" }]);
    },
  });
  const sdk = {
    issue: async () => root,
    updateIssue: async () => ({ success: true }),
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  await adapter.executeMutation({
    kind: "update_issue_state",
    project: {
      conductorShortHash: "abc123",
      expectedProjectId: "project-1",
      expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
    },
    precondition: {
      expectedIssueId: "root-1",
      expectedUpdatedAt: "2026-07-16T00:00:00Z",
    },
    state: "In Progress",
  });

  assert.deepEqual(stateLookup, {
    first: 2,
    includeArchived: false,
    filter: { name: { eq: "In Progress" } },
  });
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
  const primary = v3PrimaryComment();
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
            comments: { nodes: [{
              id: "primary-1",
              body: primary,
              updatedAt: "2026-07-16T00:00:00Z",
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

test("Root usage reuses the Primary comments fetched with Root headers", async () => {
  let commentReads = 0;
  const primaryComment = {
    id: "primary-comment",
    body: v3PrimaryComment(),
    updatedAt: new Date("2026-07-16T00:00:00Z"),
  };
  const root = issue({ id: "root-1" });
  root.comments = async () => {
    commentReads += 1;
    return connection([primaryComment]);
  };
  const sdk = {
    viewer: Promise.resolve({ id: "app-user" }),
    project: async () => ({ issues: async () => connection([root]) }),
    issue: async () => root,
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  const roots = await adapter.listRootIssues({
    projectId: "project-1",
    limit: 250,
  });
  assert.deepEqual(roots.items[0].rootManagedComments, [{
    commentId: "primary-comment",
    issueId: "root-1",
    updatedAt: "2026-07-16T00:00:00.000Z",
    managedMarker: "root-1:root-comment",
    body: primaryComment.body,
  }]);

  commentReads = 0;
  const result = await adapter.listRootUsage({
    projectId: "project-1",
    limit: 250,
  });

  assert.equal(commentReads, 1);
  assert.deepEqual(result.items, []);
});

test("Root usage fails closed when header Primary comments are ambiguous", async () => {
  const root = issue({ id: "root-1" });
  root.comments = async () => connection([
    {
      id: "primary-1",
      body: v3PrimaryComment("conversation-1"),
      updatedAt: new Date("2026-07-16T00:00:00Z"),
    },
    {
      id: "primary-2",
      body: v3PrimaryComment("conversation-2"),
      updatedAt: new Date("2026-07-16T00:00:00Z"),
    },
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

  await assert.rejects(
    adapter.listRootUsage({ projectId: "project-1", limit: 250 }),
    /linear_root_comment_ambiguous/u,
  );
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

test("complete Issue Trees batch physical reads by depth instead of node count", async () => {
  for (const childCount of [1, 100]) {
    const calls = [];
    const children = Array.from({ length: childCount }, (_, index) => ({
      id: `work-${index}`,
      identifier: `WORK-${String(index).padStart(3, "0")}`,
      title: `Work ${index}`,
      description: "",
      sortOrder: childCount - index,
      subIssueSortOrder: childCount - index,
      updatedAt: "2026-07-16T00:00:00Z",
      project: { id: "project-1" },
      parent: { id: "root-1" },
      state: { name: "Todo" },
      comments: { nodes: [], pageInfo: { hasNextPage: false } },
      inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    }));
    const root = {
      id: "root-1",
      identifier: "ROOT-1",
      title: "Root",
      description: "",
      sortOrder: 1,
      updatedAt: "2026-07-16T00:00:00Z",
      project: { id: "project-1" },
      parent: null,
      state: { name: "Todo" },
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
      comments: { nodes: [], pageInfo: { hasNextPage: false } },
      inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    };
    const sdk = {
      async issue() { throw new Error("per-node issue read forbidden"); },
      client: {
        async rawRequest(query, variables) {
          calls.push({ query, variables });
          if (variables.rootIssueId) return { data: { issue: root } };
          const nodes = variables.parentIds.includes("root-1") ? children : [];
          return { data: { issues: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          } } };
        },
      },
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

    assert.equal(calls.length, 3);
    assert.match(calls[0].query, /query SymphonyIssueTreeRoot/u);
    assert.match(calls[1].query, /query SymphonyIssueTreeChildren/u);
    assert.deepEqual(
      tree.nodes.slice(1).map(({ issueId }) => issueId),
      children.toSorted((left, right) =>
        left.subIssueSortOrder - right.subIssueSortOrder ||
          left.identifier.localeCompare(right.identifier),
      ).map(({ id }) => id),
    );
  }
});

test("complete Issue Tree batches preserve depth-first ordering and Human answers", async () => {
  const humanDescription = "Approve\n\n<!-- symphony managed marker\nmanaged_marker: root-1:human\nkind: human\nhuman_kind: plan_approval\ntarget_issue_id: none\n-->";
  const facts = {
    "root-1": [{
      id: "work-b", identifier: "WORK-B", title: "B", description: "",
      sortOrder: 2, subIssueSortOrder: 2, updatedAt: "2026-07-16T00:00:00Z",
      project: { id: "project-1" }, parent: { id: "root-1" }, state: { name: "Todo" },
      comments: { nodes: [], pageInfo: { hasNextPage: false } },
      inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    }, {
      id: "work-a", identifier: "WORK-A", title: "A", description: "",
      sortOrder: 1, subIssueSortOrder: 1, updatedAt: "2026-07-16T00:00:00Z",
      project: { id: "project-1" }, parent: { id: "root-1" }, state: { name: "Todo" },
      comments: { nodes: [], pageInfo: { hasNextPage: false } },
      inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    }],
    "work-a": [{
      id: "human-1", identifier: "HUMAN-1", title: "Approve", description: humanDescription,
      sortOrder: 1, subIssueSortOrder: 1, updatedAt: "2026-07-16T00:00:00Z",
      project: { id: "project-1" }, parent: { id: "work-a" }, state: { name: "Done" },
      comments: { nodes: [{ id: "answer-1", body: "  Approved  ", updatedAt: "2026-07-17T00:00:00Z", issue: { id: "human-1" } }], pageInfo: { hasNextPage: false } },
      inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    }],
  };
  let calls = 0;
  const sdk = { client: { async rawRequest(_query, variables) {
    calls += 1;
    if (variables.rootIssueId) return { data: { issue: {
      id: "root-1", identifier: "ROOT-1", title: "Root", description: "", sortOrder: 1,
      updatedAt: "2026-07-16T00:00:00Z", project: { id: "project-1" }, parent: null,
      state: { name: "Todo" }, labels: { nodes: [], pageInfo: { hasNextPage: false } },
      comments: { nodes: [], pageInfo: { hasNextPage: false } },
      inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    } } };
    return { data: { issues: {
      nodes: variables.parentIds.flatMap((id) => facts[id] ?? []),
      pageInfo: { hasNextPage: false, endCursor: null },
    } } };
  } } };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const tree = await adapter.getIssueTree({ projectId: "project-1", rootIssueId: "root-1", limit: 250 });

  assert.equal(calls, 4);
  assert.deepEqual(tree.nodes.map(({ issueId, depth }) => [issueId, depth]), [
    ["root-1", 0], ["work-a", 1], ["human-1", 2], ["work-b", 1],
  ]);
  assert.deepEqual(tree.humanAnswers, [{
    humanIssueId: "human-1", commentId: "answer-1", answer: "Approved",
    updatedAt: "2026-07-17T00:00:00.000Z",
  }]);
});

test("complete Issue Tree batches fail closed on incomplete nested connections", async () => {
  const sdk = { client: { async rawRequest(_query, variables) {
    if (variables.rootIssueId) return { data: { issue: {
      id: "root-1", identifier: "ROOT-1", title: "Root", description: "", sortOrder: 1,
      updatedAt: "2026-07-16T00:00:00Z", project: { id: "project-1" }, parent: null,
      state: { name: "Todo" }, labels: { nodes: [], pageInfo: { hasNextPage: true } },
      comments: { nodes: [], pageInfo: { hasNextPage: false } },
      inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    } } };
    throw new Error("unexpected child read");
  } } };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  await assert.rejects(
    adapter.getIssueTree({ projectId: "project-1", rootIssueId: "root-1", limit: 250 }),
    /linear_tree_batch_incomplete/u,
  );
});

test("complete Issue Tree breadth pagination is bounded and rejects cursor ambiguity", async () => {
  const root = {
    id: "root-1", identifier: "ROOT-1", title: "Root", description: "", sortOrder: 1,
    updatedAt: "2026-07-16T00:00:00Z", project: { id: "project-1" }, parent: null,
    state: { name: "Todo" }, labels: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
  };
  const children = Array.from({ length: 251 }, (_, index) => ({
    id: `work-${index}`, identifier: `WORK-${index}`, title: "Work", description: "",
    sortOrder: index, subIssueSortOrder: index, updatedAt: "2026-07-16T00:00:00Z",
    project: { id: "project-1" }, parent: { id: "root-1" }, state: { name: "Todo" },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
  }));
  let calls = 0;
  const sdk = { client: { async rawRequest(_query, variables) {
    calls += 1;
    if (variables.rootIssueId) return { data: { issue: root } };
    if (!variables.parentIds.includes("root-1")) {
      return { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    }
    return { data: { issues: variables.cursor
      ? { nodes: children.slice(250), pageInfo: { hasNextPage: false, endCursor: null } }
      : { nodes: children.slice(0, 250), pageInfo: { hasNextPage: true, endCursor: "page-2" } } } };
  } } };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const tree = await adapter.getIssueTree({ projectId: "project-1", rootIssueId: "root-1", limit: 250 });

  assert.equal(tree.nodes.length, 252);
  assert.equal(calls, 4);

  const ambiguousSdk = { client: { async rawRequest(_query, variables) {
    if (variables.rootIssueId) return { data: { issue: root } };
    return { data: { issues: {
      nodes: [], pageInfo: { hasNextPage: true, endCursor: "same-cursor" },
    } } };
  } } };
  const ambiguousAdapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" }, "organization-1", ambiguousSdk,
  );
  await assert.rejects(
    ambiguousAdapter.getIssueTree({ projectId: "project-1", rootIssueId: "root-1", limit: 250 }),
    /linear_tree_batch_incomplete/u,
  );
});

test("complete Issue Tree batches enforce ancestry and maximum depth", async () => {
  const root = {
    id: "root-1", identifier: "ROOT-1", title: "Root", description: "", sortOrder: 1,
    updatedAt: "2026-07-16T00:00:00Z", project: { id: "project-1" }, parent: null,
    state: { name: "Todo" }, labels: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
  };
  const adapterFor = (childFor) => new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    { client: { async rawRequest(_query, variables) {
      if (variables.rootIssueId) return { data: { issue: root } };
      const child = childFor(variables.parentIds[0]);
      return { data: { issues: {
        nodes: child ? [child] : [], pageInfo: { hasNextPage: false, endCursor: null },
      } } };
    } } },
  );
  const fact = (id, parentId) => ({
    id, identifier: id.toUpperCase(), title: id, description: "", sortOrder: 1,
    subIssueSortOrder: 1, updatedAt: "2026-07-16T00:00:00Z",
    project: { id: "project-1" }, parent: { id: parentId }, state: { name: "Todo" },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
  });

  await assert.rejects(
    adapterFor(() => fact("work-1", "wrong-parent")).getIssueTree({
      projectId: "project-1", rootIssueId: "root-1", limit: 250,
    }),
    /linear_tree_batch_invalid/u,
  );
  await assert.rejects(
    adapterFor((parentId) => {
      const depth = parentId === "root-1" ? 1 : Number(parentId.slice(5)) + 1;
      return depth <= 33 ? fact(`work-${depth}`, parentId) : undefined;
    }).getIssueTree({ projectId: "project-1", rootIssueId: "root-1", limit: 250 }),
    /linear_tree_bounds_exceeded/u,
  );
});

test("compact Root scope reads only authority and bounded Issue versions", async () => {
  const queries = [];
  const sdk = {
    async issue() { throw new Error("lazy issue read forbidden"); },
    client: { async rawRequest(query, variables) {
      queries.push(query);
      if (variables.rootIssueId) return { data: { issue: {
        id: "root-1", identifier: "SYM-1", updatedAt: "2026-07-20T00:00:00Z",
        project: { id: "project-1" }, parent: null, state: { name: "In Progress" },
        comments: { nodes: [{
          id: "primary-1", body: v3PrimaryComment("conversation-1"),
          updatedAt: "2026-07-20T00:00:00Z", issue: { id: "root-1" },
        }], pageInfo: { hasNextPage: false } },
      } } };
      const nodes = variables.parentIds.includes("root-1") ? [{
        id: "work-1", identifier: "SYM-2", updatedAt: "2026-07-20T00:00:01Z",
        project: { id: "project-1" }, parent: { id: "root-1" },
      }] : [];
      return { data: { issues: {
        nodes, pageInfo: { hasNextPage: false, endCursor: null },
      } } };
    } },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const scope = await adapter.getRootScope({ projectId: "project-1", rootIssueId: "root-1" });

  assert.equal(queries.length, 3);
  assert.match(queries[0], /query SymphonyRootScopeRoot/u);
  assert.match(queries[1], /query SymphonyRootScopeChildren/u);
  assert.doesNotMatch(queries[1], /description|labels|comments|inverseRelations|body/iu);
  assert.deepEqual(scope, {
    rootIssueId: "root-1", conductorId: "conductor-1", performerId: "conversation-1",
    terminal: false,
    issues: [
      { issueId: "root-1", identifier: "SYM-1", updatedAt: "2026-07-20T00:00:00.000Z" },
      { issueId: "work-1", identifier: "SYM-2", parentIssueId: "root-1", updatedAt: "2026-07-20T00:00:01.000Z" },
    ],
    observedAt: scope.observedAt,
  });
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

test("official SDK adapter reads back Agent assignee, label, and targeted comment writes", async () => {
  const labels = [];
  const comments = [];
  const ready = {
    id: "label-ready", name: "Ready", isGroup: false,
    archivedAt: undefined, retiredById: undefined, teamId: "team-1",
    organization: Promise.resolve({ id: "organization-1" }),
  };
  const work = issue({ id: "work-1", parentId: "root-1" });
  work.assigneeId = undefined;
  work.labels = async () => connection(labels);
  work.comments = async () => connection(comments);
  const sdk = {
    issue: async () => work,
    async updateIssue(_id, input) { Object.assign(work, input); },
    issueLabels: async () => connection([ready]),
    async issueAddLabel(_issueId, labelId) {
      if (labelId === ready.id) labels.push(ready);
    },
    async issueRemoveLabel() { labels.length = 0; },
    async createComment({ issueId, body }) {
      assert.equal(issueId, "work-1");
      comments.push({ id: "comment-1", issueId, body });
      return { success: true, commentId: "comment-1" };
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" },
    "organization-1", sdk);
  const project = { conductorShortHash: "abc123", expectedProjectId: "project-1",
    expectedProjectUpdatedAt: "2026-07-16T00:00:00Z" };
  const precondition = { expectedIssueId: "work-1",
    expectedUpdatedAt: "2026-07-16T00:00:00Z" };
  const commands = [
    { kind: "update_issue_assignee", project, precondition, assigneeId: "user-1" },
    { kind: "update_issue_label", project, precondition, label: "Ready", operation: "add" },
    { kind: "create_issue_comment", project, precondition, writeId: "write-1",
      body: "Progress\n\n<!-- symphony agent write\nwrite_id: write-1\n-->" },
  ];

  for (const command of commands) {
    await adapter.executeMutation(command);
    assert.ok(await adapter.readMutationOutcome(command));
  }
  assert.equal(work.assigneeId, "user-1");
  assert.deepEqual(labels.map(({ name }) => name), ["Ready"]);
  assert.equal(comments.length, 1);
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
    body: v3PrimaryComment("conversation-1"),
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

  assert.match(comment.body, /performer_id: conversation-2/u);
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
        body: v3PrimaryComment("conversation-1"),
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
        body: v3PrimaryComment("conversation-1"),
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
      body: v3PrimaryComment("conversation-1"),
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
      ? v3PrimaryComment("conversation-2")
      : `Provider failed.\n\n<!-- symphony turn event\nevent_key: ${identity.eventKey}\n-->`,
    ...identity,
  };
}

function v3PrimaryComment(performerId = "conversation-1") {
  return [
    "Symphony", "Conductor: conductor-1", "Performer profile: profile-1",
    "Conversation: active", "Activity: none", "Evidence: current Linear and Git read-back",
    "Observed at: none", "Branch: symphony/runs/root-1", "Pull request: none",
    "Current problem: none", "", "<!-- symphony root", "conductor_id: conductor-1",
    "performer_profile_id: profile-1", `performer_id: ${performerId}`,
    "delivery_branch: symphony/runs/root-1", "pull_request: none", "retry_blocked: false",
    "retry_expected_performer_id: none", "retry_failure_code: none",
    "retry_observed_at: none", "-->",
  ].join("\n");
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
