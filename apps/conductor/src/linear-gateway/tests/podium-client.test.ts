import assert from "node:assert/strict";
import test from "node:test";

import {
  type LinearLogicalRequestObservation,
  PodiumLinearGatewayClientImpl,
} from "../internal/PodiumLinearGatewayClientImpl.js";

const now = "2026-07-21T09:00:00Z";

test("gateway resolves the project and reads one closed Root Index page", async () => {
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
  assert.deepEqual(await gateway.readProjectRootIndexPage({
    projectId: "project-1",
    limit: 250,
  }), {
    kind: "page",
    page: {
      roots: [{
        issueId: "root-1", identifier: "SYM-1", state: "In Progress",
        updatedAt: now, projectId: "project-1",
        isDelegatedToSymphony: true, isArchived: false,
        priority: "high", blockers: [],
        rootConductorLabels: [{ conductorShortHash: "abc123" }],
      }],
      hasNextPage: false,
    },
  });
  assert.deepEqual(requests.map(({ kind }) => kind), ["resolve_conductor_project", "list_project_root_index_page"]);
  assert.deepEqual(requests[1], {
    kind: "list_project_root_index_page",
    binding_id: "binding-1",
    instance_id: "instance-1",
    expected_project_id: "project-1",
    page: { limit: 250 },
  });
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
  }, { bindingId: "binding-1", instanceId: "instance-1", timeoutMs: () => remaining });

  await gateway.resolveProject();
  remaining = 1_000;
  await gateway.readProjectRootIndexPage({ projectId: "project-1", limit: 250 });

  assert.deepEqual(timeouts, [2_000, 1_000]);
});

test("gateway returns a closed retryable failure for a rejected Root Index page", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    return {
      code: "linear_rate_limited",
      category: "linear",
      sanitized_reason: "Linear request was rate limited.",
      retryable: true,
      action_required: "retry",
      next_action: "Retry the request later.",
    };
  });
  await gateway.resolveProject();

  assert.deepEqual(await gateway.readProjectRootIndexPage({ projectId: "project-1", limit: 250 }), {
    kind: "failed",
    failure: { code: "linear_rate_limited", category: "linear", retryable: true },
  });
});

test("gateway treats an unknown Root Index failure category as a non-retryable protocol failure", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    return {
      code: "linear_rate_limited",
      category: "unexpected_category",
      sanitized_reason: "Linear request was rate limited.",
      retryable: true,
      action_required: "retry",
      next_action: "Retry the request later.",
    };
  });
  await gateway.resolveProject();

  assert.deepEqual(await gateway.readProjectRootIndexPage({ projectId: "project-1", limit: 250 }), {
    kind: "failed",
    failure: { code: "linear_rate_limited", category: "protocol", retryable: false },
  });
});

test("workflow gateway serializes a closed mutation and validates its read-back", async () => {
  const requests: Record<string, unknown>[] = [];
  const requestIds: string[] = [];
  const logicalRequests: LinearLogicalRequestObservation[] = [];
  const gateway = createGateway(async (body, requestId) => {
    requests.push(body);
    requestIds.push(requestId);
    if (body.kind === "resolve_conductor_project") return resolved();
    return { kind: "applied", read_back: { write_id: "write-1", target_issue_id: "work-1", remote_version: "v2" } };
  }, (observation) => logicalRequests.push(observation));
  await gateway.resolveProject();

  const result = await gateway.mutateWorkflow({
    kind: "update_workflow_issue", writeId: "write-1", expectedProjectId: "project-1", rootIssueId: "root-1",
    expectedRootRemoteVersion: now, target: { targetIssueId: "work-1", expectedRemoteVersion: now, expectedIsArchived: false },
    statusId: "status-progress", title: "Updated", description: "Description", labelNames: ["symphony:kind/work", "Changes Required"],
    parentAssignment: { mode: "retain" },
  });

  assert.deepEqual(result, { kind: "applied", readBack: { writeId: "write-1", targetIssueId: "work-1", remoteVersion: "v2" } });
  assert.deepEqual(logicalRequests[1], {
    requestId: requestIds[1],
    operationKind: "update_workflow_issue",
    rootIssueId: "root-1",
    writeId: "write-1",
  });
  assert.match(requestIds[1] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.deepEqual(requests[1], {
    kind: "update_workflow_issue", binding_id: "binding-1", instance_id: "instance-1", write_id: "write-1", conductor_short_hash: "abc123",
    expected_project_id: "project-1", root_issue_id: "root-1", expected_root_remote_version: now,
    target: { target_issue_id: "work-1", expected_remote_version: now, expected_is_archived: false },
    status_id: "status-progress", title: "Updated", description: "Description", label_names: ["symphony:kind/work", "Changes Required"],
    parent_assignment: { mode: "retain" },
  });
});

test("workflow gateway serializes archive state as one closed mutation", async () => {
  const requests: Record<string, unknown>[] = [];
  const gateway = createGateway(async (body) => {
    requests.push(body);
    if (body.kind === "resolve_conductor_project") return resolved();
    return { kind: "applied", read_back: { write_id: "archive-write", target_issue_id: "work-1", remote_version: "v2" } };
  });
  await gateway.resolveProject();

  await gateway.mutateWorkflow({
    kind: "set_workflow_issue_archive_state", writeId: "archive-write", expectedProjectId: "project-1",
    rootIssueId: "root-1", expectedRootRemoteVersion: now,
    target: { targetIssueId: "work-1", expectedRemoteVersion: now, expectedIsArchived: false },
    isArchived: true,
  });

  assert.deepEqual(requests[1], {
    kind: "set_workflow_issue_archive_state", binding_id: "binding-1", instance_id: "instance-1",
    write_id: "archive-write", conductor_short_hash: "abc123", expected_project_id: "project-1",
    root_issue_id: "root-1", expected_root_remote_version: now,
    target: { target_issue_id: "work-1", expected_remote_version: now, expected_is_archived: false },
    is_archived: true,
  });
});

test("workflow gateway serializes a native attachment mutation", async () => {
  const requests: Record<string, unknown>[] = [];
  const gateway = createGateway(async (body) => {
    requests.push(body);
    if (body.kind === "resolve_conductor_project") return resolved();
    return { kind: "applied", read_back: { write_id: "attachment-write", target_issue_id: "work-1", remote_version: "attachment-v1" } };
  });
  await gateway.resolveProject();

  await gateway.mutateWorkflow({
    kind: "create_workflow_attachment", writeId: "attachment-write", expectedProjectId: "project-1",
    rootIssueId: "root-1", expectedRootRemoteVersion: now,
    target: { targetIssueId: "work-1", expectedRemoteVersion: now, expectedStatusId: "status-todo" },
    title: "Verified Git revision", url: "https://github.com/acme/repo/commit/abc123",
  });

  assert.deepEqual(requests[1], {
    kind: "create_workflow_attachment", binding_id: "binding-1", instance_id: "instance-1",
    write_id: "attachment-write", conductor_short_hash: "abc123", expected_project_id: "project-1",
    root_issue_id: "root-1", expected_root_remote_version: now,
    target: { target_issue_id: "work-1", expected_remote_version: now, expected_status_id: "status-todo" },
    title: "Verified Git revision", url: "https://github.com/acme/repo/commit/abc123",
  });
});

test("workflow gateway serializes receipt removal and creation as distinct commands", async () => {
  const requests: Record<string, unknown>[] = [];
  const gateway = createGateway(async (body) => {
    requests.push(body);
    if (body.kind === "resolve_conductor_project") return resolved();
    return { kind: "applied", read_back: {
      write_id: body.write_id, target_issue_id: "root-1", remote_version: "comment-v2",
      symphony_receipt: {
        reply_write_id: "reply-write-1", source_comment_id: "comment-1",
        thread_root_comment_id: "comment-1",
        receipt: body.kind === "remove_comment_receipt_reaction" ? "none" : "check",
      },
    } };
  });
  await gateway.resolveProject();
  const common = {
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: now,
    replyWriteId: "reply-write-1", sourceCommentId: "comment-1",
    expectedSourceCommentRemoteVersion: "comment-v1", threadRootCommentId: "comment-1",
  };

  await gateway.mutateWorkflow({
    ...common, kind: "remove_comment_receipt_reaction", writeId: "receipt-remove-1", expectedReceipt: "cross",
  });
  await gateway.mutateWorkflow({
    ...common, kind: "create_comment_receipt_reaction", writeId: "receipt-create-1", receipt: "check",
  });

  assert.deepEqual(requests.slice(1), [{
    kind: "remove_comment_receipt_reaction", binding_id: "binding-1", instance_id: "instance-1",
    write_id: "receipt-remove-1", conductor_short_hash: "abc123", expected_project_id: "project-1",
    root_issue_id: "root-1", expected_root_remote_version: now, reply_write_id: "reply-write-1",
    source_comment_id: "comment-1", expected_source_comment_remote_version: "comment-v1",
    thread_root_comment_id: "comment-1", expected_receipt: "cross",
  }, {
    kind: "create_comment_receipt_reaction", binding_id: "binding-1", instance_id: "instance-1",
    write_id: "receipt-create-1", conductor_short_hash: "abc123", expected_project_id: "project-1",
    root_issue_id: "root-1", expected_root_remote_version: now, reply_write_id: "reply-write-1",
    source_comment_id: "comment-1", expected_source_comment_remote_version: "comment-v1",
    thread_root_comment_id: "comment-1", receipt: "check",
  }]);
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

test("workflow tree derives every descendant kind from exactly one primary kind label", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    const tree = workflowTree();
    tree.issues.forEach((issue) => { issue.is_archived = false; });
    return { kind: "workflow_issue_tree", tree };
  });
  await gateway.resolveProject();

  const tree = await gateway.readWorkflowIssueTree("root-1");
  assert.equal(tree.issues.find(({ issue_id }) => issue_id === "work-1")?.issue_kind, "work");
  assert.equal(tree.issues.find(({ issue_id }) => issue_id === "finding-1")?.issue_kind, "finding");
  assert.equal(tree.attachments[0]?.url, "https://github.com/acme/repo/commit/abc123");
  assert.deepEqual(tree.activities[0], {
    activity_id: "activity-1",
    issue_id: "work-1",
    activity_kinds: ["status_changed", "description_changed"],
    actor_kind: "human",
    actor_id: "user-1",
    from_state_id: "status-todo",
    to_state_id: "status-progress",
    updated_description: "Implement the accepted contract",
    added_label_ids: ["label-ready"],
    removed_label_ids: ["label-draft"],
    from_parent_id: "root-1",
    to_parent_id: "root-1",
    from_delegate_id: "delegate-old",
    to_delegate_id: "delegate-new",
    attachment_id: "attachment-1",
    archived: false,
    remote_version: now,
    created_at: now,
  });
});

test("workflow tree rejects a descendant without a primary kind label", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    const tree = workflowTree();
    tree.issues[1]!.labels = ["Changes Required"];
    return { kind: "workflow_issue_tree", tree };
  });
  await gateway.resolveProject();

  await assert.rejects(gateway.readWorkflowIssueTree("root-1"), /linear_workflow_issue_kind_invalid/u);
});

test("workflow tree rejects a bare business kind label", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    const tree = workflowTree();
    tree.issues[1]!.labels = ["Work"];
    return { kind: "workflow_issue_tree", tree };
  });
  await gateway.resolveProject();

  await assert.rejects(gateway.readWorkflowIssueTree("root-1"), /linear_workflow_issue_kind_invalid/u);
});

test("workflow tree rejects a descendant with multiple primary kind labels", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    const tree = workflowTree();
    tree.issues[1]!.labels = ["symphony:kind/work", "symphony:kind/verify"];
    return { kind: "workflow_issue_tree", tree };
  });
  await gateway.resolveProject();

  await assert.rejects(gateway.readWorkflowIssueTree("root-1"), /linear_workflow_issue_kind_invalid/u);
});

function createGateway(
  request: (body: Record<string, unknown>, requestId: string) => Promise<unknown>,
  observeLogicalRequest?: (observation: LinearLogicalRequestObservation) => void,
) {
  return new PodiumLinearGatewayClientImpl("abc123", {
    async request({ body, requestId }) {
      return await request(body as Record<string, unknown>, requestId) as never;
    },
  }, {
    bindingId: "binding-1",
    instanceId: "instance-1",
    timeoutMs: 1_000,
    ...(observeLogicalRequest ? { observeLogicalRequest } : {}),
  });
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
      { issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "status-progress", status_name: "In Progress", status_category: "started", status_position: 2, order: 0, depth: 0, title: "Root", description: "Build it", labels: [], is_archived: false, remote_version: now, created_at: now, updated_at: now },
      { issue_id: "work-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1", status_id: "status-todo", status_name: "Todo", status_category: "unstarted", status_position: 1, order: 1, depth: 1, title: "Work", description: "Implement it", labels: ["symphony:kind/work"], is_archived: false, remote_version: now, created_at: now, updated_at: now },
      { issue_id: "finding-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "root-1", status_id: "status-todo", status_name: "Todo", status_category: "unstarted", status_position: 1, order: 2, depth: 1, title: "Finding", description: "Investigate it", labels: ["symphony:kind/finding", "High"], is_archived: false, remote_version: now, created_at: now, updated_at: now },
    ],
    comments: [], relations: [],
    attachments: [{ attachment_id: "attachment-1", issue_id: "work-1", title: "Verified Git revision", url: "https://github.com/acme/repo/commit/abc123", source_type: "github", remote_version: now, created_at: now, updated_at: now }],
    activities: [{
      activity_id: "activity-1", issue_id: "work-1",
      activity_kinds: ["status_changed", "description_changed"],
      actor_kind: "human", actor_id: "user-1",
      from_state_id: "status-todo", to_state_id: "status-progress",
      updated_description: "Implement the accepted contract",
      added_label_ids: ["label-ready"], removed_label_ids: ["label-draft"],
      from_parent_id: "root-1", to_parent_id: "root-1",
      from_delegate_id: "delegate-old", to_delegate_id: "delegate-new",
      attachment_id: "attachment-1", archived: false,
      remote_version: now, created_at: now,
    }], source_manifest: [], coverage: { is_complete: true, omissions: [] }, observed_at: now,
  };
}
