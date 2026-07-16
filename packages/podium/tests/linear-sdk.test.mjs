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
    children: async () => connection(input.children ?? []),
    comments: async () => connection([]),
    labels: async () => connection([]),
  };
  return value;
}

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
  const adapter = new LinearSdkImpl("token", "organization-1", sdk);

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

test("official SDK adapter creates a managed node and proves it by exact Marker read-back", async () => {
  const parent = issue({ id: "root-1" });
  let created;
  const sdk = {
    issue: async () => parent,
    async createIssue(input) {
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
  const adapter = new LinearSdkImpl("token", "organization-1", sdk);
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
  const adapter = new LinearSdkImpl("token", "organization-1", sdk);
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
  const adapter = new LinearSdkImpl("token", "organization-1", sdk);

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
  const adapter = new LinearSdkImpl("token", "organization-1", sdk);

  await assert.rejects(
    adapter.assignConductorProjectLabel({
      projectId: "project-1",
      labelName: "symphony:conductor/abc123",
    }),
    /linear_conductor_label_project_conflict/,
  );
  assert.equal(additions, 0);
});
