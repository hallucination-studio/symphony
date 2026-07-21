import assert from "node:assert/strict";
import test from "node:test";

import { PodiumLinearGatewayClientImpl } from "../internal/PodiumLinearGatewayClientImpl.js";

const now = "2026-07-21T09:00:00Z";

test("gateway resolves the project and discovers delegated Roots", async () => {
  const requests: Record<string, unknown>[] = [];
  const gateway = createGateway(async (body) => {
    requests.push(body);
    if (body.kind === "resolve_conductor_project") return resolved();
    return {
      kind: "root_issues_page",
      items: [{ issue: root("root-1"), is_delegated_to_symphony: true, priority: "high", blockers: [] }],
      page_info: { has_next_page: false },
    };
  });

  assert.deepEqual(await gateway.resolveProject(), { kind: "resolved", projectId: "project-1" });
  assert.deepEqual(await gateway.listRoots("project-1"), [{
    issueId: "root-1", identifier: "SYM-1", state: "In Progress", title: "Root", description: "Build it",
    updatedAt: now, projectId: "project-1", parentIssueId: null, isDelegatedToSymphony: true,
    priority: "high", order: 0, blockers: [],
  }]);
  assert.deepEqual(requests.map(({ kind }) => kind), ["resolve_conductor_project", "list_root_issues"]);
});

test("root discovery projects the Conductor identity from a target managed record", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    return {
      kind: "root_issues_page",
      items: [{
        issue: root("root-1"), is_delegated_to_symphony: true, priority: "high", blockers: [],
        root_managed_comments: [{
          comment_id: "ownership-comment", issue_id: "root-1",
          body: "<!-- symphony managed-record\n{\"kind\":\"root_ownership\",\"version\":1,\"root_issue_id\":\"root-1\",\"conductor_id\":\"conductor-1\",\"performer_profile_id\":\"profile-1\",\"delivery_branch\":\"symphony/runs/sym-1\",\"owner_generation\":\"generation-1\"}\n-->",
          managed_marker: "root-1:managed-record:ownership-comment", updated_at: now,
        }],
      }],
      page_info: { has_next_page: false },
    };
  });
  await gateway.resolveProject();

  assert.equal((await gateway.listRoots("project-1"))[0]?.managedConductorId, "conductor-1");
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
  });

  assert.deepEqual(result, { kind: "applied", readBack: { writeId: "write-1", targetIssueId: "work-1", remoteVersion: "v2" } });
  assert.deepEqual(requests[1], {
    kind: "update_workflow_issue", write_id: "write-1", conductor_short_hash: "abc123",
    expected_project_id: "project-1", root_issue_id: "root-1", expected_root_remote_version: now,
    target: { target_issue_id: "work-1", expected_remote_version: now },
    status_id: "status-progress", title: "Updated", description: "Description",
  });
});

test("workflow tree decoder rejects a foreign issue", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    const tree = workflowTree();
    tree.issues[1]!.project_id = "project-foreign";
    return { kind: "workflow_issue_tree", tree };
  });
  await gateway.resolveProject();
  await assert.rejects(gateway.readWorkflowIssueTree("root-1"), /linear_workflow_/u);
});

function createGateway(request: (body: Record<string, unknown>) => Promise<unknown>) {
  return new PodiumLinearGatewayClientImpl("abc123", {
    async request({ body }) { return await request(body as Record<string, unknown>) as never; },
  }, { timeoutMs: 1_000 });
}

function resolved() {
  return { kind: "resolved", resolved_project: {
    conductor_short_hash: "abc123", project: { project_id: "project-1", organization_id: "org-1", name: "Symphony", updated_at: now },
  } };
}

function root(issueId: string) {
  return { issue_id: issueId, identifier: "SYM-1", project_id: "project-1", state: "In Progress", order: 0, depth: 0,
    title: "Root", description: "Build it", updated_at: now };
}

function workflowTree() {
  return {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "status-progress", name: "In Progress", category: "started", position: 2 },
      { status_id: "status-todo", name: "Todo", category: "unstarted", position: 1 },
    ],
    issues: [
      { issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "status-progress", status_name: "In Progress", status_category: "started", status_position: 2, order: 0, depth: 0, title: "Root", description: "Build it", issue_kind: "root", remote_version: now, updated_at: now },
      { issue_id: "work-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1", status_id: "status-todo", status_name: "Todo", status_category: "unstarted", status_position: 1, order: 1, depth: 1, title: "Work", description: "Implement it", managed_marker: "root-1:work-1", issue_kind: "work", remote_version: now, updated_at: now },
    ],
    comments: [], relations: [], observed_at: now,
  };
}
