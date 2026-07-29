import assert from "node:assert/strict";
import test from "node:test";

import { LinearSdkImpl } from "../dist/internal/linear-gateway/internal/LinearSdkImpl.js";

test("development-token organization discovery bounds the official SDK request", async (t) => {
  const timeoutSignal = AbortSignal.abort(new DOMException("request timed out", "TimeoutError"));
  let suppliedSignal;
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 30_000);
    return timeoutSignal;
  });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    suppliedSignal = init.signal;
    throw timeoutSignal.reason;
  });

  await assert.rejects(
    LinearSdkImpl.discoverDevelopmentTokenOrganizationId("development-token"),
  );

  assert.equal(suppliedSignal, timeoutSignal);
});

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
    createdAt: new Date("2026-07-15T00:00:00Z"),
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

function projectRootIndexNode(input = {}) {
  const issueId = input.issueId ?? "root-1";
  return {
    id: issueId,
    identifier: input.identifier ?? issueId.toUpperCase(),
    updatedAt: input.updatedAt ?? "2026-07-16T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    priority: input.priority ?? 2,
    project: { id: input.projectId ?? "project-1" },
    state: { name: input.state ?? "In Progress" },
    delegate: input.delegateId === null ? null : { id: input.delegateId ?? "app-user" },
    labels: {
      nodes: input.labels ?? [],
      pageInfo: { hasNextPage: input.labelsHasNextPage ?? false },
    },
    comments: {
      nodes: input.comments ?? [],
      pageInfo: { hasNextPage: input.commentsHasNextPage ?? false },
    },
    inverseRelations: {
      nodes: input.relations ?? [],
      pageInfo: { hasNextPage: input.relationsHasNextPage ?? false },
    },
  };
}

function rootIndexAdapter(nodes, requests) {
  return new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    client: {
      async rawRequest(document, variables) {
        requests.push({ document, variables });
        return { data: {
          viewer: { id: "app-user" },
          project: {
            id: "project-1",
            issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        } };
      },
    },
  });
}

test("Project Root Index reads bounded Root Headers in one project-scoped request", async () => {
  const roots = Array.from({ length: 12 }, (_, index) => projectRootIndexNode({
    issueId: `root-${index}`,
    priority: index % 5,
    archivedAt: index === 1 ? "2026-07-15T00:00:00.000Z" : null,
    delegateId: index === 2 ? "another-actor" : "app-user",
    ...(index === 0 ? {
      labels: [{ name: "symphony:conductor/abc123def456" }],
      relations: [{
        id: "relation-1",
        type: "blocks",
        issue: { id: "blocker-1", state: { name: "Todo" } },
        relatedIssue: { id: "root-0" },
      }],
    } : {}),
  }));
  const requests = [];
  const adapter = rootIndexAdapter(roots, requests);

  const page = await adapter.listProjectRootIndexPage({ projectId: "project-1", limit: 12 });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].variables, { projectId: "project-1", limit: 12 });
  assert.match(requests[0].document, /query SymphonyProjectRootIndex/u);
  assert.match(requests[0].document, /project\(id: \$projectId\)/u);
  assert.match(requests[0].document, /issues\(first: \$limit, after: \$cursor, includeArchived: true, filter: \{ parent: \{ null: true \} \}\)/u);
  assert.doesNotMatch(requests[0].document, /comments\(/u);
  assert.match(requests[0].document, /inverseRelations\(first: 250, includeArchived: true\)/u);
  for (const omittedField of ["title", "description", "sortOrder", "subIssueSortOrder"]) {
    assert.doesNotMatch(requests[0].document, new RegExp(`\\b${omittedField}\\b`, "u"));
  }
  assert.doesNotMatch(requests[0].document, /\n\s+parent\s*\{/u);
  assert.equal(page.headers.length, 12);
  assert.deepEqual(page.headers.slice(0, 3).map((header) => ({
    rootIssueId: header.rootIssueId,
    priority: header.priority,
    isArchived: header.isArchived,
    isDelegatedToSymphony: header.isDelegatedToSymphony,
  })), [
    { rootIssueId: "root-0", priority: "no_priority", isArchived: false, isDelegatedToSymphony: true },
    { rootIssueId: "root-1", priority: "urgent", isArchived: true, isDelegatedToSymphony: true },
    { rootIssueId: "root-2", priority: "high", isArchived: false, isDelegatedToSymphony: false },
  ]);
  assert.deepEqual(page.headers[0], {
    rootIssueId: "root-0",
    identifier: "ROOT-0",
    projectId: "project-1",
    state: "In Progress",
    isArchived: false,
    updatedAt: "2026-07-16T00:00:00.000Z",
    priority: "no_priority",
    blockers: [{ sourceIssueId: "root-0", targetIssueId: "blocker-1", targetState: "Todo" }],
    rootConductorLabels: [{ conductorShortHash: "abc123def456" }],
    isDelegatedToSymphony: true,
  });
  assert.deepEqual(page.pageInfo, { hasNextPage: false });
});

test("Project Pool preflight uses one compact query for an empty Project", async () => {
  const requests = [];
  const sdk = {
    client: {
      async rawRequest(document, variables) {
        requests.push({ document, variables });
        return {
          data: {
            organization: { id: "organization-1" },
            project: {
              id: "project-1",
              updatedAt: "2026-07-16T00:00:00.000Z",
              labels: connection([]),
              issues: connection([]),
            },
            projectLabels: connection([]),
          },
        };
      },
    },
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  const plan = await adapter.preflightConductorProjectPool({
    projectId: "project-1",
    desiredMembers: ["abc123def456"],
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].variables, {
    projectId: "project-1",
    memberNames: ["symphony:conductor/abc123def456"],
    rootCursor: undefined,
  });
  assert.match(requests[0].document, /query SymphonyProjectPoolPreflight/u);
  assert.match(requests[0].document, /projectLabels\(first: 129/u);
  assert.match(requests[0].document, /projects\(first: 2\)/u);
  assert.match(requests[0].document, /issues\(first: 250/u);
  assert.doesNotMatch(requests[0].document, /fragment Project/u);
  assert.doesNotMatch(requests[0].document, /description/u);
  assert.deepEqual(plan, {
    kind: "ready",
    projectId: "project-1",
    expectedProjectUpdatedAt: "2026-07-16T00:00:00.000Z",
    fingerprint: plan.fingerprint,
    currentMembers: [],
    desiredMembers: ["abc123def456"],
    addMembers: ["abc123def456"],
    removeMembers: [],
    routeRoots: [],
  });
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/u);
});

test("Project resolution uses one compact query without SDK relation fragments", async () => {
  const requests = [];
  const sdk = {
    client: {
      async rawRequest(document, variables) {
        requests.push({ document, variables });
        return {
          data: {
            organization: { id: "organization-1" },
            projectLabels: {
              nodes: [{
                id: "project-label-1",
                name: "symphony:conductor/abc123def456",
                isGroup: false,
                archivedAt: null,
                retiredBy: null,
                projects: {
                  nodes: [{
                    id: "project-1",
                    updatedAt: "2026-07-16T00:00:00.000Z",
                    labels: connection([
                      { name: "symphony:conductor/abc123def456" },
                      { name: "symphony:conductor/def456abc123" },
                    ]),
                  }],
                  pageInfo: { hasNextPage: false },
                },
              }],
              pageInfo: { hasNextPage: false },
            },
          },
        };
      },
    },
  };
  const adapter = new LinearSdkImpl(
    { kind: "oauth", token: "token" },
    "organization-1",
    sdk,
  );

  const resolution = await adapter.readProjectResolution({
    conductorShortHash: "abc123def456",
  });

  assert.deepEqual(resolution, {
    kind: "resolved",
    projectId: "project-1",
    updatedAt: "2026-07-16T00:00:00.000Z",
    conductorPool: [
      { conductorShortHash: "abc123def456" },
      { conductorShortHash: "def456abc123" },
    ],
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].variables, {
    labelName: "symphony:conductor/abc123def456",
  });
  assert.match(requests[0].document, /query SymphonyProjectResolution/u);
  assert.match(requests[0].document, /projects\(first: 2\)/u);
  assert.match(requests[0].document, /labels\(first: 65/u);
  assert.doesNotMatch(requests[0].document, /fragment Project/u);
  assert.doesNotMatch(requests[0].document, /description/u);
});

test("Project Root Index fails closed for incomplete nested relations", async () => {
  const cases = [
    {
      root: projectRootIndexNode({ relationsHasNextPage: true }),
      error: /linear_project_root_index_blockers_incomplete/u,
    },
  ];

  for (const { root, error } of cases) {
    const adapter = rootIndexAdapter([root], []);
    await assert.rejects(
      adapter.listProjectRootIndexPage({ projectId: "project-1", limit: 1 }),
      error,
    );
  }
});

test("Project Root Index rejects malformed Header authority facts", async () => {
  const cases = [
    { root: projectRootIndexNode({ priority: 5 }), error: /linear_issue_priority_invalid/u },
    { root: projectRootIndexNode({ projectId: "project-2" }), error: /linear_project_root_index_header_invalid/u },
    {
      root: projectRootIndexNode({
        relations: [{
          id: "relation-1",
          type: "blocks",
          issue: { id: "blocker-1", state: { name: "Todo" } },
          relatedIssue: { id: "root-2" },
        }],
      }),
      error: /linear_project_root_index_blocker_invalid/u,
    },
  ];

  for (const { root, error } of cases) {
    const adapter = rootIndexAdapter([root], []);
    await assert.rejects(
      adapter.listProjectRootIndexPage({ projectId: "project-1", limit: 1 }),
      error,
    );
  }
});

test("workflow Issue Tree maps every bounded comment, native thread, reaction, relation, and Team status", async () => {
  const queries = [];
  const root = {
    id: "root-1", identifier: "ROOT-1", title: "Root", description: "Root description",
    sortOrder: 1, createdAt: "2026-07-15T00:00:00Z", updatedAt: "2026-07-16T00:00:00Z", project: { id: "project-1" }, parent: null,
    creator: { id: "human-1" }, assignee: { id: "human-2" },
    state: { name: "In Progress" },
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [{
      id: "comment-root", body: "Root status", createdAt: "2026-07-16T00:00:00Z",
      updatedAt: "2026-07-16T00:00:01Z", user: { id: "human-1" }, issue: { id: "root-1" },
      parent: null, resolvedAt: null,
      reactions: [{ id: "reaction-human", emoji: "eyes", user: { id: "human-2" } }],
    }], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [{ id: "relation-1", type: "blocks", issue: { id: "work-1", state: { name: "Todo" }, project: { id: "project-1" } }, relatedIssue: { id: "root-1", project: { id: "project-1" } } }], pageInfo: { hasNextPage: false } },
    attachments: { nodes: [{
      id: "attachment-1", title: "Pull request", url: "https://example.test/pr/1", sourceType: "github",
      createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:01Z", issue: { id: "root-1" },
    }], pageInfo: { hasNextPage: false } },
    history: { nodes: [{
      id: "activity-1", createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:01Z",
      issue: { id: "root-1" }, actor: { id: "human-1" }, toStateId: "state-progress",
    }, {
      id: "history-outside-projection", createdAt: "2026-07-16T00:00:00Z",
      updatedAt: "2026-07-16T00:00:01Z", issue: { id: "root-1" }, actor: { id: "human-1" },
      fromStateId: null, toStateId: null, updatedDescription: null, archived: null,
      addedLabelIds: [], removedLabelIds: [], fromParentId: null, toParentId: null,
      fromDelegate: null, toDelegate: null, attachmentId: null,
    }], pageInfo: { hasNextPage: false } },
  };
  const child = {
    id: "work-1", identifier: "WORK-1", title: "Work", description: "Work description",
    sortOrder: 2, subIssueSortOrder: 2, createdAt: "2026-07-15T00:00:02Z", updatedAt: "2026-07-16T00:00:02Z",
    project: { id: "project-1" }, parent: { id: "root-1" }, state: { name: "Todo" },
    creator: { id: "symphony-bot" }, assignee: null,
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [{
      id: "comment-work", body: "Progress update.",
      createdAt: "2026-07-16T00:00:02Z", updatedAt: "2026-07-16T00:00:03Z",
      user: { id: "symphony-bot" }, issue: { id: "work-1" }, parent: { id: "comment-root" },
      resolvedAt: "2026-07-16T00:00:04Z",
      reactions: [{ id: "reaction-symphony", emoji: "white_check_mark", user: { id: "symphony-bot" } }],
    }], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    attachments: { nodes: [], pageInfo: { hasNextPage: false } },
    history: { nodes: [{
      id: "activity-work-result", createdAt: "2026-07-16T00:00:01Z", updatedAt: "2026-07-16T00:00:02Z",
      issue: { id: "work-1" }, botActor: { id: "symphony-bot" },
      toStateId: "state-todo", updatedDescription: "Work description",
    }], pageInfo: { hasNextPage: false } },
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
  assert.ok(queries.some((query) => query.includes("parent { id }")));
  assert.ok(queries.some((query) => query.includes("resolvedAt")));
  assert.ok(queries.some((query) => /reactions\s*\{\s*id emoji/u.test(query)));
  assert.ok(queries.some((query) => query.includes("reactions { id emoji user { id } }")));
  assert.ok(queries.every((query) => !query.includes("reactions(first:")));
  assert.ok(queries.every((query) => !/reactions\s*\{\s*nodes\b/u.test(query)));
  assert.ok(queries.some((query) => query.includes("inverseRelations(first: 8)")));
  assert.ok(queries.some((query) => query.includes("attachments(first: 8)")));
  assert.ok(queries.some((query) => query.includes("history(first: 8)")));
  assert.ok(queries.some((query) => query.includes("includeArchived: true")));

  assert.deepEqual(tree.statusCatalog, [
    { statusId: "state-progress", name: "In Progress", category: "started", position: 2 },
    { statusId: "state-todo", name: "Todo", category: "unstarted", position: 1 },
    { statusId: "state-duplicate", name: "Duplicate", category: "canceled", position: 3 },
  ]);
  assert.deepEqual(tree.issues.map(({ issueId, creatorUserId, assigneeUserId }) => ({
    issueId, creatorUserId, assigneeUserId,
  })), [
    { issueId: "root-1", creatorUserId: "human-1", assigneeUserId: "human-2" },
    { issueId: "work-1", creatorUserId: "symphony-bot", assigneeUserId: undefined },
  ]);
  assert.deepEqual(tree.comments.map(({ commentId, issueId }) => ({ commentId, issueId })), [
    { commentId: "comment-root", issueId: "root-1" },
    { commentId: "comment-work", issueId: "work-1" },
  ]);
  assert.deepEqual(tree.comments.map(({ commentId, authorKind, authorId, authorUserId, createdAt }) => ({ commentId, authorKind, authorId, authorUserId, createdAt })), [
    { commentId: "comment-root", authorKind: "human", authorId: "human-1", authorUserId: "human-1", createdAt: "2026-07-16T00:00:00.000Z" },
    { commentId: "comment-work", authorKind: "symphony", authorId: "symphony-bot", authorUserId: "symphony-bot", createdAt: "2026-07-16T00:00:02.000Z" },
  ]);
  assert.deepEqual(tree.comments.map(({
    commentId, parentCommentId, threadRootCommentId, threadState, reactions,
  }) => ({ commentId, parentCommentId, threadRootCommentId, threadState, reactions })), [
    {
      commentId: "comment-root", parentCommentId: undefined, threadRootCommentId: "comment-root",
      threadState: "unresolved",
      reactions: [{ reactionId: "reaction-human", emoji: "eyes", actorKind: "human", actorId: "human-2" }],
    },
    {
      commentId: "comment-work", parentCommentId: "comment-root", threadRootCommentId: "comment-root",
      threadState: "unresolved",
      reactions: [{ reactionId: "reaction-symphony", emoji: "white_check_mark", actorKind: "symphony", actorId: "symphony-bot" }],
    },
  ]);
  assert.deepEqual(tree.relations, [{
    relationId: "relation-1", relationKind: "blocks", sourceIssueId: "work-1", targetIssueId: "root-1",
  }]);
  assert.deepEqual(tree.attachments, [{
    attachmentId: "attachment-1", issueId: "root-1", title: "Pull request",
    url: "https://example.test/pr/1", sourceType: "github",
    remoteVersion: "2026-07-16T00:00:01.000Z", createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:01.000Z",
  }]);
  assert.deepEqual(tree.activities, [
    {
      activityId: "activity-1", issueId: "root-1", activityKinds: ["status_changed"],
      actorKind: "human", actorId: "human-1", toStateId: "state-progress",
      remoteVersion: "2026-07-16T00:00:01.000Z", createdAt: "2026-07-16T00:00:00.000Z",
    },
    {
      activityId: "activity-work-result", issueId: "work-1",
      activityKinds: ["status_changed", "description_changed"],
      actorKind: "symphony", actorId: "symphony-bot", toStateId: "state-todo",
      updatedDescription: "Work description", remoteVersion: "2026-07-16T00:00:02.000Z",
      createdAt: "2026-07-16T00:00:01.000Z",
    },
  ]);
  assert.deepEqual(tree.sourceManifest, [
    { sourceKind: "linear_issue", sourceId: "root-1", sourceVersion: "2026-07-16T00:00:00.000Z", actorKind: "unknown" },
    { sourceKind: "linear_issue", sourceId: "work-1", sourceVersion: "2026-07-16T00:00:02.000Z", actorKind: "unknown" },
    { sourceKind: "linear_comment", sourceId: "comment-root", sourceVersion: "2026-07-16T00:00:01.000Z", actorKind: "human" },
    { sourceKind: "linear_comment", sourceId: "comment-work", sourceVersion: "2026-07-16T00:00:03.000Z", actorKind: "symphony" },
    { sourceKind: "linear_relation", sourceId: "relation-1", sourceVersion: "relation-1", actorKind: "unknown" },
    { sourceKind: "linear_attachment", sourceId: "attachment-1", sourceVersion: "2026-07-16T00:00:01.000Z", actorKind: "unknown" },
    { sourceKind: "linear_activity", sourceId: "activity-1", sourceVersion: "2026-07-16T00:00:01.000Z", actorKind: "human" },
    { sourceKind: "linear_activity", sourceId: "activity-work-result", sourceVersion: "2026-07-16T00:00:02.000Z", actorKind: "symphony" },
    { sourceKind: "linear_status_catalog", sourceId: "project-1:status-catalog", sourceVersion: "f241b6b4887e72321a11ea914516224280ff68d55aa6709c0113557f6409e874", actorKind: "unknown" },
  ]);
  assert.deepEqual(tree.coverage, { isComplete: true, omissions: [] });
});

test("complete Workflow Issue Tree batches paginate every nested native fact by issue", async () => {
  const calls = [];
  const root = {
    id: "root-1", identifier: "ROOT-1", title: "Root", description: "", sortOrder: 1,
    createdAt: "2026-07-15T00:00:00Z", updatedAt: "2026-07-16T00:00:00Z", project: { id: "project-1" }, parent: null,
    state: { name: "Todo" }, labels: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: {
      nodes: [{
        id: "comment-1", body: "first", createdAt: "2026-07-16T00:00:00Z",
        updatedAt: "2026-07-16T00:00:01Z", user: { id: "human-1" }, issue: { id: "root-1" },
        parent: null, resolvedAt: null, reactions: [],
      }],
      pageInfo: { hasNextPage: true, endCursor: "comments-2" },
    },
    inverseRelations: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "relations-2" },
    },
    attachments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "attachments-2" } },
    history: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "activities-2" } },
  };
  const child = {
    id: "work-1", identifier: "WORK-1", title: "Work", description: "", sortOrder: 1,
    subIssueSortOrder: 1, createdAt: "2026-07-15T00:00:03Z", updatedAt: "2026-07-16T00:00:03Z",
    project: { id: "project-1" }, parent: { id: "root-1" }, state: { name: "Todo" },
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    attachments: { nodes: [], pageInfo: { hasNextPage: false } },
    history: { nodes: [], pageInfo: { hasNextPage: false } },
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
        nodes: [{
          id: "comment-2", body: "second", createdAt: "2026-07-16T00:00:01Z",
          updatedAt: "2026-07-16T00:00:02Z", user: { id: "human-2" }, issue: { id: "root-1" },
          parent: null, resolvedAt: null, reactions: [],
        }],
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
    if (query.includes("IssueTreeAttachments")) return { data: { issue: {
      id: "root-1",
      attachments: {
        nodes: [{ id: "attachment-2", title: "Build", url: "https://example.test/build/2",
          sourceType: "github", createdAt: "2026-07-16T00:00:02Z",
          updatedAt: "2026-07-16T00:00:03Z", issue: { id: "root-1" } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    } } };
    if (query.includes("IssueTreeActivities")) return { data: { issue: {
      id: "root-1",
      history: {
        nodes: [{ id: "activity-2", createdAt: "2026-07-16T00:00:02Z",
          updatedAt: "2026-07-16T00:00:03Z", issue: { id: "root-1" },
          botActor: { id: "automation-1" }, addedLabelIds: ["label-1"] }],
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
  assert.equal(tree.attachments[0].attachmentId, "attachment-2");
  assert.deepEqual(tree.activities[0].activityKinds, ["labels_changed"]);
  assert.deepEqual(calls.slice(1, 5).map(({ variables }) => variables), [
    { issueId: "root-1", cursor: "comments-2" },
    { issueId: "root-1", cursor: "relations-2" },
    { issueId: "root-1", cursor: "attachments-2" },
    { issueId: "root-1", cursor: "activities-2" },
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

test("workflow SDK mutations preserve the supplied description and use explicit status and relation inputs", async () => {
  const parent = issue({ id: "root-1" });
  let createdInput;
  let updatedInput;
  let commentInput;
  let relationInput;
  let attachmentInput;
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
    async createAttachment(input) { attachmentInput = input; },
    async createIssueRelation(input) { relationInput = input; return { success: true }; },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  await adapter.executeWorkflowMutation({
    kind: "create_workflow_issue", writeId: "write-1", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    parentExpectedRemoteVersion: "parent-version", parentExpectedStatusId: "state-todo",
    parentIssueId: "root-1", title: "Cycle", description: "Plan it",
    statusId: "state-todo", labelNames: ["Human Action", "Plan Review"], order: 3,
  });
  assert.equal(createdInput.stateId, "state-todo");
  assert.deepEqual(createdInput.labelIds, ["issue-label-1", "issue-label-2"]);
  assert.equal(createdInput.subIssueSortOrder, 3);
  assert.equal(createdInput.description, "Plan it");

  await adapter.executeWorkflowMutation({
    kind: "append_workflow_comment", writeId: "write-2", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "root-1", expectedRemoteVersion: "root-version" }, body: "Progress",
  });
  assert.equal(commentInput.issueId, "root-1");
  assert.equal(commentInput.body, "Progress");

  await assert.rejects(adapter.executeWorkflowMutation({
    kind: "append_workflow_comment", writeId: "write-machine-content", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "root-1", expectedRemoteVersion: "root-version" },
    body: "Machine payload follows.\n\n```json\n{}\n```",
  }), /linear_workflow_machine_content_rejected/u);

  await adapter.executeWorkflowMutation({
    kind: "create_workflow_attachment", writeId: "attachment-write", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "work-1", expectedRemoteVersion: "work-version" },
    title: "Verified Git revision", url: "https://github.com/acme/repo/commit/abc123",
  });
  assert.deepEqual(attachmentInput, {
    issueId: "work-1", title: "Verified Git revision", url: "https://github.com/acme/repo/commit/abc123",
  });

  await adapter.executeWorkflowMutation({
    kind: "create_workflow_relation", writeId: "write-3", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    sourceIssueId: "work-1", sourceExpectedRemoteVersion: "work-version",
    targetIssueId: "root-1", targetExpectedRemoteVersion: "root-version", relationKind: "blocks", relationState: "present",
  });
  assert.deepEqual(relationInput, { issueId: "work-1", relatedIssueId: "root-1", type: "blocks" });

  await adapter.executeWorkflowMutation({
    kind: "create_workflow_relation", writeId: "write-3-blocked-by", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    sourceIssueId: "work-1", sourceExpectedRemoteVersion: "work-version",
    targetIssueId: "root-1", targetExpectedRemoteVersion: "root-version", relationKind: "blocked_by", relationState: "present",
  });
  assert.deepEqual(relationInput, { issueId: "root-1", relatedIssueId: "work-1", type: "blocks" });

  const targetIssue = issue({
    id: "work-1", parentId: "root-1", title: "Work",
    description: "Work description",
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
    order: 1,
    labels: [],
    isArchived: false,
    parentIssueId: "root-1", statusId: "state-todo", title: "Work",
    description: targetIssue.description,
  });
  await targetAdapter.executeWorkflowMutation({
    kind: "update_workflow_issue", writeId: "write-4", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "work-1", expectedRemoteVersion: target.updatedAt, expectedIsArchived: false },
    statusId: "state-todo", title: "Updated work", description: "Updated description",
    labelNames: [],
    parentAssignment: { mode: "retain" },
  });
  assert.equal(updatedInput.title, "Updated work");
  assert.equal(updatedInput.description, "Updated description");
  assert.deepEqual(updatedInput.labelIds, []);
});

test("workflow attachment read-back requires one exact native attachment", async () => {
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    async issue(issueId) {
      return issueId === "root-1"
        ? { id: "root-1", projectId: "project-1", parentId: undefined }
        : { id: "verify-1", projectId: "project-1", parentId: "root-1" };
    },
  });
  const command = {
    kind: "create_workflow_attachment", writeId: "attachment-write", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-v1",
    target: { targetIssueId: "verify-1", expectedRemoteVersion: "verify-v1" },
    title: "Verified Git revision", url: "https://github.com/acme/repo/commit/abc123",
  };
  const attachment = {
    attachmentId: "attachment-1", issueId: "verify-1", title: command.title, url: command.url,
    sourceType: "github", remoteVersion: "attachment-v1", createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:00Z",
  };
  adapter.getWorkflowIssueTree = async () => ({
    issues: [{ issueId: "verify-1", remoteVersion: "verify-v2" }], attachments: [attachment],
  });

  assert.deepEqual(await adapter.readWorkflowMutationOutcome(command), {
    writeId: "attachment-write", targetIssueId: "verify-1", remoteVersion: "attachment-v1",
    issueVersions: [{ issueId: "verify-1", remoteVersion: "verify-v2" }],
  });

  adapter.getWorkflowIssueTree = async () => ({
    issues: [{ issueId: "verify-1", remoteVersion: "verify-v2" }], attachments: [attachment, { ...attachment, attachmentId: "attachment-2" }],
  });
  await assert.rejects(
    adapter.readWorkflowMutationOutcome(command),
    /linear_workflow_attachment_ambiguous/u,
  );
});

test("workflow SDK materializes native comment replies, receipts, and thread state with semantic read-back", async () => {
  const request = {
    id: "request-comment", body: "## 需要你审批\n\n请审批 Plan。", createdAt: "2026-07-16T00:00:00Z",
    updatedAt: "2026-07-16T00:00:00Z", user: { id: "symphony-bot" }, issue: { id: "root-1" },
    parent: null, resolvedAt: null, reactions: [],
  };
  const source = {
    id: "source-comment", body: "Please review the plan", createdAt: "2026-07-16T00:00:00Z",
    updatedAt: "2026-07-16T00:00:01Z", user: { id: "human-1" }, issue: { id: "root-1" },
    parent: { id: "request-comment" }, resolvedAt: null, reactions: [],
  };
  const root = {
    id: "root-1", identifier: "ROOT-1", title: "Root", description: "", sortOrder: 1,
    createdAt: "2026-07-15T00:00:00Z", updatedAt: "2026-07-16T00:00:00Z", project: { id: "project-1" }, parent: null,
    state: { name: "Todo" }, labels: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [request, source], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    attachments: { nodes: [], pageInfo: { hasNextPage: false } },
    history: { nodes: [], pageInfo: { hasNextPage: false } },
  };
  const calls = [];
  const sdk = {
    viewer: Promise.resolve({ id: "symphony-bot" }),
    async issue() {
      return {
        projectId: "project-1",
        team: Promise.resolve({ states: async () => connection([
          { id: "state-todo", name: "Todo", type: "unstarted", position: 1 },
        ]) }),
      };
    },
    async createComment(input) {
      calls.push({ kind: "create_comment", input });
      root.comments.nodes.push({
        id: "reply-comment", body: input.body, createdAt: "2026-07-16T00:00:02Z",
        updatedAt: "2026-07-16T00:00:02Z", user: { id: "symphony-bot" }, issue: { id: input.issueId },
        parent: { id: input.parentId }, resolvedAt: null,
        reactions: [],
      });
    },
    async createReaction(input) {
      calls.push({ kind: "create_reaction", input });
      const comment = root.comments.nodes.find(({ id }) => id === input.commentId);
      comment.reactions.push({ id: "receipt-check", emoji: input.emoji, user: { id: "symphony-bot" } });
    },
    async deleteReaction(reactionId) {
      calls.push({ kind: "delete_reaction", reactionId });
      source.reactions = source.reactions.filter(({ id }) => id !== reactionId);
    },
    async commentResolve(commentId) {
      calls.push({ kind: "resolve", commentId });
      request.resolvedAt = "2026-07-16T00:00:03Z";
    },
    async commentUnresolve(commentId) {
      calls.push({ kind: "unresolve", commentId });
      request.resolvedAt = null;
    },
    client: { async rawRequest(_query, variables) {
      if (variables.rootIssueId) return { data: { issue: root } };
      return { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    } },
  };
  const adapter = new LinearSdkImpl(
    { kind: "development_token", token: "token", delegateActorId: "symphony-bot" },
    "organization-1",
    sdk,
  );
  const common = {
    conductorShortHash: "abc123", expectedProjectId: "project-1", rootIssueId: "root-1",
    expectedRootRemoteVersion: "2026-07-16T00:00:00.000Z",
  };
  const reply = {
    ...common,
    kind: "create_comment_reply",
    writeId: "reply-write-1",
    sourceCommentId: "source-comment",
    expectedSourceCommentRemoteVersion: "2026-07-16T00:00:01.000Z",
    expectedThreadRootCommentId: "request-comment",
    expectedThreadState: "unresolved",
    body: "Plan review is waiting for your decision.",
  };

  await adapter.executeWorkflowMutation(reply);
  assert.deepEqual(calls.shift(), {
    kind: "create_comment",
    input: {
      issueId: "root-1",
      parentId: "source-comment",
      body: "Plan review is waiting for your decision.",
    },
  });
  assert.deepEqual(await adapter.readWorkflowMutationOutcome(reply), {
    writeId: "reply-write-1",
    targetIssueId: "root-1",
    remoteVersion: "2026-07-16T00:00:02.000Z",
    comment: {
      commentId: "reply-comment", issueId: "root-1", body: "Plan review is waiting for your decision.",
      authorKind: "symphony", authorId: "symphony-bot", authorUserId: "symphony-bot",
      parentCommentId: "source-comment", threadRootCommentId: "request-comment", threadState: "unresolved",
      reactions: [], createdAt: "2026-07-16T00:00:02.000Z",
      remoteVersion: "2026-07-16T00:00:02.000Z", updatedAt: "2026-07-16T00:00:02.000Z",
    },
  });

  const createReceipt = {
    ...common,
    kind: "create_comment_receipt_reaction",
    writeId: "receipt-create-1",
    replyWriteId: "reply-write-1",
    sourceCommentId: "source-comment",
    expectedSourceCommentRemoteVersion: "2026-07-16T00:00:01.000Z",
    threadRootCommentId: "request-comment",
    receipt: "check",
  };
  await adapter.executeWorkflowMutation(createReceipt);
  assert.deepEqual(calls.shift(), {
    kind: "create_reaction",
    input: { commentId: "source-comment", emoji: "✅" },
  });
  assert.deepEqual(await adapter.readWorkflowMutationOutcome(createReceipt), {
    writeId: "receipt-create-1",
    targetIssueId: "root-1",
    remoteVersion: "2026-07-16T00:00:01.000Z",
    symphonyReceipt: {
      replyWriteId: "reply-write-1", sourceCommentId: "source-comment",
      threadRootCommentId: "request-comment", receipt: "check",
    },
  });

  const resolve = {
    ...common,
    kind: "set_comment_thread_state",
    writeId: "thread-write-1",
    replyWriteId: "reply-write-1",
    sourceCommentId: "source-comment",
    expectedSourceCommentRemoteVersion: "2026-07-16T00:00:01.000Z",
    threadRootCommentId: "request-comment",
    expectedThreadState: "unresolved",
    threadState: "resolved",
  };
  await adapter.executeWorkflowMutation(resolve);
  assert.deepEqual(calls.shift(), { kind: "resolve", commentId: "request-comment" });
  assert.deepEqual((await adapter.readWorkflowMutationOutcome(resolve)).comment.threadState, "resolved");

  const removeReceipt = {
    ...common,
    kind: "remove_comment_receipt_reaction",
    writeId: "receipt-remove-1",
    replyWriteId: "reply-write-1",
    sourceCommentId: "source-comment",
    expectedSourceCommentRemoteVersion: "2026-07-16T00:00:01.000Z",
    threadRootCommentId: "request-comment",
    expectedReceipt: "check",
  };
  await adapter.executeWorkflowMutation(removeReceipt);
  assert.deepEqual(calls.shift(), { kind: "delete_reaction", reactionId: "receipt-check" });
  assert.deepEqual(await adapter.readWorkflowMutationOutcome(removeReceipt), {
    writeId: "receipt-remove-1",
    targetIssueId: "root-1",
    remoteVersion: "2026-07-16T00:00:01.000Z",
    symphonyReceipt: {
      replyWriteId: "reply-write-1", sourceCommentId: "source-comment",
      threadRootCommentId: "request-comment", receipt: "none",
    },
  });

  const unresolve = {
    ...resolve,
    writeId: "thread-write-2",
    expectedThreadState: "resolved",
    threadState: "unresolved",
  };
  await adapter.executeWorkflowMutation(unresolve);
  assert.deepEqual(calls.shift(), { kind: "unresolve", commentId: "request-comment" });
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
    parentIssueId: "root-1", title: "Human Action", description: "Decide",
    statusId: "state-todo", labelNames: ["Unknown label"],
  };
  await assert.rejects(adapter.executeWorkflowMutation(command), /linear_workflow_label_missing/u);
  await assert.rejects(
    adapter.executeWorkflowMutation({ ...command, writeId: "write-duplicate", labelNames: ["Human Action", "Human Action"] }),
    /linear_workflow_label_duplicate/u,
  );
});

test("workflow SDK issue update and archive-state mutations each execute one native effect", async () => {
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
  let updateInput;
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    issue: async (issueId) => issueId === "root-1" ? root : target,
    async updateIssue(_issueId, input) {
      updateInput = input;
      target.title = input.title;
      target.description = input.description;
    },
  });
  const command = {
    kind: "update_workflow_issue", writeId: "write-update", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: root.updatedAt.toISOString(),
    target: { targetIssueId: "work-1", expectedRemoteVersion: target.updatedAt.toISOString(), expectedIsArchived: false },
    statusId: "state-todo", title: "Archived work", description: "Archived description",
    labelNames: [], parentAssignment: { mode: "retain" },
  };

  await adapter.executeWorkflowMutation(command);
  assert.equal(archiveCalls, 0);
  assert.equal(restoreCalls, 0);
  assert.deepEqual(updateInput, {
    title: "Archived work", description: "Archived description", stateId: "state-todo", labelIds: [],
  });
  assert.equal(await adapter.readWorkflowMutationOutcome({
    ...command,
    labelNames: ["Changes Required"],
  }), undefined);
  assert.deepEqual(await adapter.readWorkflowMutationOutcome(command), {
    writeId: "write-update", targetIssueId: "work-1", remoteVersion: target.updatedAt.toISOString(),
    issueVersions: [{ issueId: "work-1", remoteVersion: target.updatedAt.toISOString() }],
  });

  const archive = {
    kind: "set_workflow_issue_archive_state", writeId: "write-archive", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: root.updatedAt.toISOString(),
    target: { targetIssueId: "work-1", expectedRemoteVersion: target.updatedAt.toISOString(), expectedIsArchived: false },
    isArchived: true,
  };
  await adapter.executeWorkflowMutation(archive);
  assert.equal(archiveCalls, 1);
  assert.equal(restoreCalls, 0);
  assert.deepEqual(await adapter.readWorkflowMutationOutcome(archive), {
    writeId: "write-archive", targetIssueId: "work-1", remoteVersion: target.updatedAt.toISOString(),
    issueVersions: [{ issueId: "work-1", remoteVersion: target.updatedAt.toISOString() }],
  });

  await adapter.executeWorkflowMutation({
    ...archive, writeId: "write-restore",
    target: { ...archive.target, expectedRemoteVersion: target.updatedAt.toISOString(), expectedIsArchived: true },
    isArchived: false,
  });
  assert.equal(archiveCalls, 1);
  assert.equal(restoreCalls, 1);
  assert.equal(target.archivedAt, null);
});

test("workflow relation state absent deletes the matching native Linear relation", async () => {
  let deletes = 0;
  const command = {
    kind: "create_workflow_relation", writeId: "remove-relation", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    sourceIssueId: "source-1", sourceExpectedRemoteVersion: "source-version",
    targetIssueId: "target-1", targetExpectedRemoteVersion: "target-version",
    relationKind: "blocks", relationState: "absent",
  };
  const root = {
    id: "root-1", updatedAt: "root-version", project: { id: "project-1" }, parent: null,
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
  };
  const source = {
    id: "source-1", updatedAt: "source-version", project: { id: "project-1" },
    parent: { id: "root-1", project: { id: "project-1" }, parent: null },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
  };
  const target = {
    id: "target-1", updatedAt: "target-version", project: { id: "project-1" },
    parent: { id: "root-1", project: { id: "project-1" }, parent: null },
    inverseRelations: {
      nodes: [{
        id: "relation-1", type: "blocks",
        issue: { id: "source-1", updatedAt: "source-version", project: { id: "project-1" } },
        relatedIssue: { id: "target-1", updatedAt: "target-version", project: { id: "project-1" } },
      }],
      pageInfo: { hasNextPage: false },
    },
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    client: {
      async rawRequest(query) {
        assert.match(query, /WorkflowMutationPreflight/u);
        return { data: { issues: { nodes: [root, source, target] } } };
      },
    },
    async issueRelation(id) {
      assert.equal(id, "relation-1");
      return {
        issueId: "source-1", relatedIssueId: "target-1", type: "blocks",
        async delete() { deletes += 1; return { success: true }; },
      };
    },
  });

  assert.deepEqual(await adapter.preflightWorkflowMutation(command), { kind: "ready" });
  await adapter.executeWorkflowMutation(command);

  assert.equal(deletes, 1);
});

test("workflow relation compact read-back returns the source Issue updatedAt", async () => {
  const root = issue({ id: "root-1" });
  const source = issue({ id: "source-1", parentId: "root-1" });
  const target = issue({ id: "target-1", parentId: "root-1" });
  const command = {
    kind: "create_workflow_relation", writeId: "write-relation", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: root.updatedAt,
    sourceIssueId: "source-1", sourceExpectedRemoteVersion: source.updatedAt,
    targetIssueId: "target-1", targetExpectedRemoteVersion: target.updatedAt, relationKind: "blocks", relationState: "present",
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

test("workflow relation removal read-back confirms the relation is absent", async () => {
  const command = {
    kind: "create_workflow_relation", writeId: "remove-relation", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "2026-07-16T00:00:06Z",
    sourceIssueId: "source-1", sourceExpectedRemoteVersion: "2026-07-16T00:00:04Z",
    targetIssueId: "target-1", targetExpectedRemoteVersion: "2026-07-16T00:00:05Z", relationKind: "blocks", relationState: "absent",
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    client: {
      async rawRequest() {
        return { data: { root: {
          id: "root-1", updatedAt: "2026-07-16T00:00:06Z", project: { id: "project-1" }, parent: null,
        }, source: {
          id: "source-1", updatedAt: "2026-07-16T00:00:04Z", project: { id: "project-1" },
          parent: { id: "root-1", updatedAt: "2026-07-16T00:00:06Z", project: { id: "project-1" }, parent: null },
        }, issue: {
          id: "target-1", updatedAt: "2026-07-16T00:00:05Z", project: { id: "project-1" },
          parent: { id: "root-1", updatedAt: "2026-07-16T00:00:06Z", project: { id: "project-1" }, parent: null },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
        } } };
      },
    },
  });

  assert.deepEqual(await adapter.readWorkflowMutationOutcome(command), {
    writeId: "remove-relation", targetIssueId: "source-1", remoteVersion: "2026-07-16T00:00:04Z",
    issueVersions: [
      { issueId: "source-1", remoteVersion: "2026-07-16T00:00:04Z" },
      { issueId: "target-1", remoteVersion: "2026-07-16T00:00:05Z" },
      { issueId: "root-1", remoteVersion: "2026-07-16T00:00:06Z" },
    ],
  });
});

test("workflow blocked_by read-back maps Linear relation versions to command endpoints", async () => {
  const root = issue({ id: "root-1" });
  const blocked = issue({ id: "blocked-1", parentId: "root-1" });
  const dependency = issue({ id: "dependency-1", parentId: "root-1" });
  const command = {
    kind: "create_workflow_relation", writeId: "write-blocked-by", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: root.updatedAt,
    sourceIssueId: "blocked-1", sourceExpectedRemoteVersion: blocked.updatedAt,
    targetIssueId: "dependency-1", targetExpectedRemoteVersion: dependency.updatedAt, relationKind: "blocked_by", relationState: "present",
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

test("workflow blocked_by absent read-back checks the reversed canonical blocks endpoints", async () => {
  const command = {
    kind: "create_workflow_relation", writeId: "remove-blocked-by", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    sourceIssueId: "blocked-1", sourceExpectedRemoteVersion: "blocked-version",
    targetIssueId: "dependency-1", targetExpectedRemoteVersion: "dependency-version",
    relationKind: "blocked_by", relationState: "absent",
  };
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    client: {
      async rawRequest(query) {
        assert.match(query, /source: issue\(id: "dependency-1"\)/u);
        assert.match(query, /issue\(id: "blocked-1"\)/u);
        return { data: {
          root: { id: "root-1", updatedAt: "root-version", project: { id: "project-1" }, parent: null },
          source: {
            id: "dependency-1", updatedAt: "dependency-version", project: { id: "project-1" },
            parent: { id: "root-1", updatedAt: "root-version", project: { id: "project-1" }, parent: null },
          },
          issue: {
            id: "blocked-1", updatedAt: "blocked-version", project: { id: "project-1" },
            parent: { id: "root-1", updatedAt: "root-version", project: { id: "project-1" }, parent: null },
            inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        } };
      },
    },
  });

  assert.deepEqual(await adapter.readWorkflowMutationOutcome(command), {
    writeId: "remove-blocked-by", targetIssueId: "blocked-1", remoteVersion: "blocked-version",
    issueVersions: [
      { issueId: "blocked-1", remoteVersion: "blocked-version" },
      { issueId: "dependency-1", remoteVersion: "dependency-version" },
      { issueId: "root-1", remoteVersion: "root-version" },
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
    targetIssueId: "target-1", targetExpectedRemoteVersion: target.updatedAt, relationKind: "blocks", relationState: "present",
  });
  assert.equal(rawQueries.length, 1);
  assert.equal(writes, 1);
});

test("workflow issue read-back batches child status facts", async () => {
  const parent = issue({ id: "root-1" });
  const childDescription = "Implement the scoped work.";
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
        assert.match(query, /sortOrder\s+subIssueSortOrder/u);
        return { data: { issue: {
          id: "root-1", updatedAt: "2026-07-22T00:00:01Z", project: { id: "project-1" }, parent: null,
          children: {
          nodes: [{
            id: "work-1", updatedAt: "2026-07-22T00:00:00Z", sortOrder: 1, subIssueSortOrder: 1, project: { id: "project-1" },
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
    parentIssueId: "root-1", title: "Implement", description: childDescription,
    statusId: "state-todo", labelNames: [],
  };
  assert.deepEqual(await adapter.readWorkflowMutationOutcome(command), {
    writeId: "write-child-read", targetIssueId: "work-1", remoteVersion: "2026-07-22T00:00:00Z",
    issueVersions: [{ issueId: "root-1", remoteVersion: "2026-07-22T00:00:01Z" }],
  });
  assert.equal(rawQueries.filter((query) => query.includes("WorkflowMutationChildren")).length, 1);
  assert.equal(rawQueries.length, 1);
  assert.equal(
    await adapter.readWorkflowMutationOutcome({ ...command, writeId: "write-child-label-mismatch", labelNames: ["Human Action"] }),
    undefined,
  );
});

test("workflow SDK compact preflight validates all update facts in one physical request", async () => {
  const rawQueries = [];
  const description = "Existing scoped work.";
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", {
    client: { async rawRequest(query) {
      rawQueries.push(query);
      return { data: { issues: { nodes: [
        {
          id: "root-1", updatedAt: "root-version", sortOrder: 1, subIssueSortOrder: null, project: { id: "project-1" }, parent: null,
          state: { id: "status-progress" }, title: "Root", description: "Root",
          team: { id: "team-1", states: { nodes: [{ id: "status-progress" }], pageInfo: { hasNextPage: false } } },
          comments: { nodes: [], pageInfo: { hasNextPage: false } },
          children: { nodes: [], pageInfo: { hasNextPage: false } },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
        },
        {
          id: "work-1", updatedAt: "work-version", sortOrder: 1, subIssueSortOrder: 1, project: { id: "project-1" },
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
    target: { targetIssueId: "work-1", expectedRemoteVersion: "work-version", expectedStatusId: "status-todo", expectedParentIssueId: "root-1", expectedIsArchived: false },
    statusId: "status-progress", title: "Updated", description: "Updated description",
    parentAssignment: { mode: "retain" },
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
    target: { targetIssueId: "foreign-1", expectedRemoteVersion: "foreign-version", expectedIsArchived: false },
    statusId: "state-todo", title: "Updated", description: "Description",
    parentAssignment: { mode: "retain" },
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

function workflowSetupSdk(states, { failAfterCreate, issueLabelNames = [], omitCreatedIssueLabelNames = new Set() } = {}) {
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
        if (!omitCreatedIssueLabelNames.has(input.name)) labels.push(label);
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
  assert.deepEqual(result.workflowKindLabels, [
    "symphony:kind/root", "symphony:kind/cycle", "symphony:kind/plan",
    "symphony:kind/work", "symphony:kind/verify", "symphony:kind/finding",
  ]);
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
    "symphony:kind/root", "symphony:kind/cycle", "symphony:kind/plan",
    "symphony:kind/work", "symphony:kind/verify", "symphony:kind/finding",
    "Human Action", "Plan Review", "Clarification", "Permission", "Finding Waiver", "Convergence Override",
  ]);
  assert.deepEqual(result.workflowKindLabels, [
    "symphony:kind/root", "symphony:kind/cycle", "symphony:kind/plan",
    "symphony:kind/work", "symphony:kind/verify", "symphony:kind/finding",
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
      "symphony:kind/root", "symphony:kind/cycle", "symphony:kind/plan",
      "symphony:kind/work", "symphony:kind/verify", "symphony:kind/finding",
      "Human Action", "Plan Review", "Clarification", "Permission", "Finding Waiver", "Convergence Override",
    ],
  });
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  const result = await adapter.initializeTargetTeamWorkflow({ projectId: "project-1", authorized: true });

  assert.equal(result.kind, "already_applied");
  assert.deepEqual(result.workflowKindLabels, [
    "symphony:kind/root", "symphony:kind/cycle", "symphony:kind/plan",
    "symphony:kind/work", "symphony:kind/verify", "symphony:kind/finding",
  ]);
  assert.deepEqual(result.humanActionLabels, [
    "Human Action", "Plan Review", "Clarification", "Permission", "Finding Waiver", "Convergence Override",
  ]);
  assert.equal(observations.updates.length, 0);
  assert.equal(observations.creates.length, 0);
  assert.equal(observations.labelCreates.length, 0);
});

test("Team workflow setup rejects duplicate primary kind labels", async () => {
  const { sdk } = workflowSetupSdk(retainedWorkflowStates(), {
    issueLabelNames: ["symphony:kind/root", "symphony:kind/root"],
  });
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  await assert.rejects(
    adapter.initializeTargetTeamWorkflow({ projectId: "project-1", authorized: true }),
    /linear_issue_label_ambiguous/u,
  );
});

test("Team workflow setup rejects an incomplete primary kind label read-back", async () => {
  const { sdk } = workflowSetupSdk(retainedWorkflowStates(), {
    omitCreatedIssueLabelNames: new Set(["symphony:kind/root"]),
  });
  const adapter = new LinearSdkImpl({ kind: "oauth", token: "token" }, "organization-1", sdk);

  await assert.rejects(
    adapter.initializeTargetTeamWorkflow({ projectId: "project-1", authorized: true }),
    /linear_workflow_labels_read_back_failed/u,
  );
});
