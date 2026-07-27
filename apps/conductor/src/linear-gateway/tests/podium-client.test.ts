import assert from "node:assert/strict";
import test from "node:test";

import { PodiumLinearGatewayClientImpl } from "../internal/PodiumLinearGatewayClientImpl.js";

const now = "2026-07-21T09:00:00Z";

test("gateway resolves the project and discovers routed Roots", async () => {
  const requests: Record<string, unknown>[] = [];
  const gateway = createGateway(async (body) => {
    requests.push(body);
    if (body.kind === "resolve_conductor_project") return resolved();
    return {
      kind: "project_root_index_page",
      page: {
        headers: [rootHeader({ priority: "high", root_conductor_labels: [{ conductor_short_hash: "abc123" }] })],
        page_info: { has_next_page: false },
      },
    };
  });

  assert.deepEqual(await gateway.resolveProject(), {
    kind: "resolved", projectId: "project-1",
    conductorPool: [{ conductorShortHash: "abc123" }, { conductorShortHash: "def456" }],
  });
  assert.deepEqual(await gateway.listRoots("project-1"), [{
    issueId: "root-1", identifier: "SYM-1", state: "In Progress",
    updatedAt: now, projectId: "project-1",
    isDelegatedToSymphony: true, isArchived: false,
    priority: "high", blockers: [],
    rootConductorLabels: [{ conductorShortHash: "abc123" }],
  }]);
  assert.deepEqual(requests.map(({ kind }) => kind), ["resolve_conductor_project", "list_project_root_index_page"]);
  assert.deepEqual(requests[1], {
    kind: "list_project_root_index_page",
    binding_id: "binding-1",
    expected_project_id: "project-1",
    page: { limit: 250 },
  });
});

test("root discovery projects the Conductor identity from a target managed record", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    return {
      kind: "project_root_index_page",
      page: {
        headers: [rootHeader({
          root_ownership: {
            conductor_id: "conductor-1",
            source_comment_id: "ownership-comment",
            source_comment_remote_version: now,
          },
        })],
        page_info: { has_next_page: false },
      },
    };
  });
  await gateway.resolveProject();

  assert.equal((await gateway.listRoots("project-1"))[0]?.managedConductorId, "conductor-1");
});

test("gateway evaluates the IPC timeout for each request", async () => {
  const timeouts: number[] = [];
  let remaining = 2_000;
  const gateway = new PodiumLinearGatewayClientImpl("abc123", {
    async request({ body, timeoutMs }) {
      timeouts.push(timeoutMs);
      if ((body as { kind: string }).kind === "resolve_conductor_project") return resolved();
      return {
        kind: "project_root_index_page", page: { headers: [], page_info: { has_next_page: false } },
      };
    },
  }, { timeoutMs: () => remaining });

  await gateway.resolveProject();
  remaining = 1_000;
  await gateway.listRoots("project-1");

  assert.deepEqual(timeouts, [2_000, 1_000]);
});

test("workflow gateway serializes a closed mutation and validates its read-back", async () => {
  const requests: Record<string, unknown>[] = [];
  const gateway = createGateway(async (body) => {
    requests.push(body);
    if (body.kind === "resolve_conductor_project") return resolved();
    return { kind: "applied", read_back: { write_id: "write-1", target_issue_id: "work-1", remote_version: "v2" } };
  });
  await gateway.resolveProject();

  const result = await gateway.mutateWorkflow({
    kind: "update_workflow_issue", writeId: "write-1", expectedProjectId: "project-1", rootIssueId: "root-1",
    expectedRootRemoteVersion: now, target: { targetIssueId: "work-1", expectedRemoteVersion: now },
    statusId: "status-progress", title: "Updated", description: "Description",
    isArchived: false, parentAssignment: { mode: "retain" },
  });

  assert.deepEqual(result, { kind: "applied", readBack: { writeId: "write-1", targetIssueId: "work-1", remoteVersion: "v2" } });
  assert.deepEqual(requests[1], {
    kind: "update_workflow_issue", binding_id: "binding-1", write_id: "write-1", conductor_short_hash: "abc123",
    expected_project_id: "project-1", root_issue_id: "root-1", expected_root_remote_version: now,
    target: { target_issue_id: "work-1", expected_remote_version: now },
    status_id: "status-progress", title: "Updated", description: "Description",
    is_archived: false, parent_assignment: { mode: "retain" },
  });
});

test("workflow tree decoder rejects a foreign issue", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    const tree = workflowTree();
    tree.issues.forEach((issue) => { issue.is_archived = false; });
    tree.issues[1]!.project_id = "project-foreign";
    return { kind: "workflow_issue_tree", tree };
  });
  await gateway.resolveProject();
  await assert.rejects(gateway.readWorkflowIssueTree("root-1"), /linear_workflow_/u);
});

test("workflow tree derives descendant kind only from a strict WorkflowIssueRecord description", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    const tree = workflowTree();
    tree.issues.forEach((issue) => { issue.is_archived = false; });
    const work = tree.issues[1]!;
    work.description = [
      "Implement it",
      "",
      "```json",
      "{\"kind\":\"workflow_issue\",\"version\":1,\"issue_key\":\"directive-1:work\",\"root_issue_id\":\"root-1\",\"parent_issue_id\":\"root-1\",\"issue_kind\":\"work\"}",
      "```",
    ].join("\n");
    return { kind: "workflow_issue_tree", tree };
  });
  await gateway.resolveProject();

  const tree = await gateway.readWorkflowIssueTree("root-1");
  assert.equal(tree.issues.find(({ issue_id }) => issue_id === "work-1")?.issue_kind, "work");
});

function createGateway(request: (body: Record<string, unknown>) => Promise<unknown>) {
  return new PodiumLinearGatewayClientImpl("abc123", {
    async request({ body }) { return await request(body as Record<string, unknown>) as never; },
  }, { timeoutMs: 1_000 });
}

function resolved() {
  return { kind: "resolved", resolved_project: {
    conductor_short_hash: "abc123", project: { project_id: "project-1", organization_id: "org-1", name: "Symphony", updated_at: now },
    conductor_pool: [{ conductor_short_hash: "abc123" }, { conductor_short_hash: "def456" }],
  } };
}

function rootHeader(overrides: Record<string, unknown> = {}) {
  return {
    root_issue_id: "root-1",
    identifier: "SYM-1",
    project_id: "project-1",
    state: "In Progress",
    is_archived: false,
    updated_at: now,
    priority: "normal",
    blockers: [],
    root_conductor_labels: [],
    is_delegated_to_symphony: true,
    ...overrides,
  };
}

function workflowTree() {
  return {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "status-progress", name: "In Progress", category: "started", position: 2 },
      { status_id: "status-todo", name: "Todo", category: "unstarted", position: 1 },
    ],
    issues: [
      { issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "status-progress", status_name: "In Progress", status_category: "started", status_position: 2, order: 0, depth: 0, title: "Root", description: "Build it", labels: [], is_archived: false, remote_version: now, updated_at: now },
      { issue_id: "work-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1", status_id: "status-todo", status_name: "Todo", status_category: "unstarted", status_position: 1, order: 1, depth: 1, title: "Work", description: "Implement it", labels: [], is_archived: false, remote_version: now, updated_at: now },
    ],
    comments: [], relations: [], source_manifest: [], coverage: { is_complete: true, omissions: [] }, observed_at: now,
  };
}
