import assert from "node:assert/strict";
import test from "node:test";

import { serializeV3RootManagedComment } from "../../root-workflow/api/index.js";
import { PodiumLinearGatewayClientImpl } from "../internal/PodiumLinearGatewayClientImpl.js";

const now = "2026-07-19T00:00:00Z";

test("V3 gateway reconstructs closed Root facts and performs no discovery Tree reads", async () => {
  const requests: string[] = [];
  const discovery: unknown[] = [];
  const gateway = createGateway(async (body) => {
    requests.push(body.kind as string);
    if (body.kind === "resolve_conductor_project") return resolved();
    if (body.kind === "list_root_issues") {
      const page = body.page as { cursor?: string };
      return page.cursor ? rootsPage(1, 251) : rootsPage(250, 1, true);
    }
    return treePage();
  }, (evidence) => discovery.push(evidence));
  await gateway.resolveProject();
  const roots = await gateway.listRoots("project-1");
  assert.equal(roots.length, 251);
  assert.equal(roots[0]?.managedConductorId, "conductor-1");
  assert.deepEqual(requests, [
    "resolve_conductor_project", "list_root_issues", "list_root_issues",
  ]);
  assert.deepEqual(discovery, [{ rootHeaderCount: 251, listPageCount: 2,
    getIssueTreeCount: 0 }]);

  const view = await gateway.reconstructV3("root-1");
  assert.equal(view.managedComment?.performerId, "conversation-1");
  assert.equal(view.profile?.readiness, "ready");
  assert.equal(view.workflowTreeComplete, true);
  assert.deepEqual(requests, ["resolve_conductor_project", "list_root_issues",
    "list_root_issues", "get_issue_tree"]);
});

test("V3 gateway discovery evidence measures an actual nested Tree request", async () => {
  const discovery: unknown[] = [];
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    if (body.kind === "get_issue_tree") return treePage();
    await gateway.reconstructV3("root-1");
    return rootsPage();
  }, (evidence) => discovery.push(evidence));
  await gateway.resolveProject();
  await gateway.listRoots("project-1");
  assert.deepEqual(discovery, [{ rootHeaderCount: 1, listPageCount: 1,
    getIssueTreeCount: 1 }]);
});

test("fresh Root scope uses the compact Podium query without reconstructing a Tree", async () => {
  const requests: string[] = [];
  const gateway = createGateway(async (body) => {
    requests.push(body.kind as string);
    if (body.kind === "resolve_conductor_project") return resolved();
    if (body.kind === "get_root_scope") return scopeResult();
    throw new Error("complete Tree read forbidden");
  });
  await gateway.resolveProject();

  const scope = await gateway.readFreshRootScope("root-1");

  assert.equal(scope.performer_id, "conversation-1");
  assert.deepEqual(requests, ["resolve_conductor_project", "get_root_scope"]);
});

test("workflow tree request preserves correlation and bounded Linear facts", async () => {
  const requests: Record<string, unknown>[] = [];
  const gateway = createGateway(async (body) => {
    requests.push(body);
    if (body.kind === "resolve_conductor_project") return resolved();
    return workflowTreePage();
  });

  await gateway.resolveProject();
  const tree = await gateway.readWorkflowIssueTree("root-1");

  assert.deepEqual(requests, [
    { kind: "resolve_conductor_project", conductor_short_hash: "abc123" },
    {
      kind: "get_workflow_issue_tree",
      conductor_short_hash: "abc123",
      expected_project_id: "project-1",
      root_issue_id: "root-1",
    },
  ]);
  assert.equal(tree.root_issue_id, "root-1");
  assert.equal(tree.issues[1]?.managed_marker, "root-1:work-1");
  assert.equal(tree.comments[0]?.managed_marker, "root-1:status");
  assert.deepEqual(tree.relations[0], {
    relation_id: "relation-1",
    relation_kind: "blocks",
    source_issue_id: "work-1",
    target_issue_id: "root-1",
  });
});

test("workflow tree decoder rejects duplicate, foreign, and dangling facts", async () => {
  const malformed = [
    ["duplicate issue IDs", (tree: ReturnType<typeof workflowTree>) => {
      tree.issues.push({ ...tree.issues[0]! });
    }],
    ["cross-project issues", (tree: ReturnType<typeof workflowTree>) => {
      tree.issues[1]!.project_id = "project-foreign";
    }],
    ["dangling comments", (tree: ReturnType<typeof workflowTree>) => {
      tree.comments[0]!.issue_id = "missing-issue";
    }],
    ["dangling relations", (tree: ReturnType<typeof workflowTree>) => {
      tree.relations[0]!.target_issue_id = "missing-issue";
    }],
  ] as const;

  for (const [label, mutate] of malformed) {
    const gateway = createGateway(async (body) => {
      if (body.kind === "resolve_conductor_project") return resolved();
      const tree = workflowTree();
      mutate(tree);
      return workflowTreePage(tree);
    });
    await gateway.resolveProject();
    await assert.rejects(
      gateway.readWorkflowIssueTree("root-1"),
      (error: unknown) => error instanceof Error && error.message.startsWith("linear_workflow_"),
      label,
    );
  }
});

test("Agent Linear read returns requested direct children from the fresh Root scope", async () => {
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    if (body.kind === "get_root_scope") return scopeResult();
    throw new Error("complete Tree read forbidden");
  });
  await gateway.resolveProject();
  const scope = await gateway.readFreshRootScope("root-1");

  assert.deepEqual(await gateway.read({
    rootIssueId: "root-1",
    issueId: "root-1",
    include: ["issue", "children"],
    scope,
  }), {
    issue: { issue_id: "root-1", identifier: "SYM-1", updated_at: now },
    children: [{ issue_id: "work-1", identifier: "SYM-2",
      parent_issue_id: "root-1", state: "Todo", node_kind: "work",
      updated_at: now }, { issue_id: "human-1", identifier: "SYM-3",
      parent_issue_id: "root-1", state: "Todo", node_kind: "human",
      human_kind: "plan_approval", updated_at: now }],
  });
});

test("V3 gateway claim uses exact Root CAS and closed Primary Comment", async () => {
  let mutation: Record<string, unknown> | undefined;
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    mutation = body;
    return { kind: "applied" };
  });
  await gateway.resolveProject();
  assert.equal(await gateway.compareAndSetClaim({ rootIssueId: "root-1",
    resolvedProjectId: "project-1", expectedRootUpdatedAt: now,
    expectedRootState: "Todo", expectedManagedComment: "none",
    managedComment: managed() }), "applied");
  assert.equal(mutation?.kind, "upsert_root_managed_comment");
  assert.deepEqual(mutation?.root_precondition, { expected_issue_id: "root-1",
    expected_updated_at: now, expected_state: "Todo" });
  assert.match(String(mutation?.body), /<!-- symphony root\n/u);
  assert.doesNotMatch(String(mutation?.body), /usage_|turn_kind/u);
});

test("V3 gateway rejects ambiguous Primary Comments", async () => {
  const gateway = createGateway(async (body) => body.kind === "resolve_conductor_project"
    ? resolved() : treePage([comment(), comment("comment-2")]));
  await gateway.resolveProject();
  await assert.rejects(gateway.reconstructV3("root-1"), /root_managed_comment_ambiguous/u);
});

test("V3 gateway maps every public Agent Linear write to a closed Podium mutation", async () => {
  const mutations: Record<string, unknown>[] = [];
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    mutations.push(body);
    return { kind: "applied" };
  });
  await gateway.resolveProject();
  const common = { expected_remote_version: now, expected_git_head: "abc" };
  for (const [command, args] of [
    ["linear.issue.create_child", { ...common, parent_issue_id: "root-1", kind: "work",
      title: "Work", description: "Build it", write_id: "write-1" }],
    ["linear.issue.create_child", { ...common, parent_issue_id: "root-1", kind: "rework",
      title: "[Rework] Root Gate Findings", description: "Fix findings",
      write_id: "write-rework" }],
    ["linear.assignee.set", { ...common, issue_id: "work-1", assignee_id: "user-1" }],
    ["linear.label.set", { ...common, issue_id: "work-1", label: "Ready",
      operation: "add" }],
    ["linear.comment.create", { ...common, issue_id: "work-1", body: "Progress",
      write_id: "write-2" }],
  ] as const) {
    assert.equal((await gateway.mutate({ rootIssueId: "root-1", command, args })).kind,
      "applied");
  }
  assert.deepEqual(mutations.map(({ kind }) => kind), [
    "create_managed_node", "create_managed_node", "update_issue_assignee", "update_issue_label",
    "create_issue_comment",
  ]);
  assert.equal(mutations[0]?.managed_marker, "write-1");
  assert.equal(mutations[1]?.node_kind, "work");
  assert.equal(mutations[1]?.title, "[Rework] Root Gate Findings");
  assert.deepEqual(mutations[2]?.precondition, {
    expected_issue_id: "work-1", expected_updated_at: now,
  });
  assert.equal(mutations[3]?.operation, "add");
  assert.deepEqual(mutations[4]?.precondition, {
    expected_issue_id: "work-1", expected_updated_at: now,
  });
  assert.equal(mutations[4]?.write_id, "write-2");
});

test("workflow gateway serializes a closed mutation and validates its read-back result", async () => {
  const requests: Record<string, unknown>[] = [];
  const gateway = createGateway(async (body) => {
    if (body.kind === "resolve_conductor_project") return resolved();
    requests.push(body);
    return {
      kind: "applied",
      read_back: { write_id: "write-1", target_issue_id: "work-1", remote_version: now },
    };
  });
  await gateway.resolveProject();

  const result = await gateway.mutateWorkflow({
    kind: "update_workflow_issue", writeId: "write-1", expectedProjectId: "project-1",
    rootIssueId: "root-1", expectedRootRemoteVersion: now,
    target: { targetIssueId: "work-1", expectedRemoteVersion: now },
    statusId: "status-progress", title: "Updated", description: "Description",
  });

  assert.deepEqual(result, { kind: "applied", readBack: {
    writeId: "write-1", targetIssueId: "work-1", remoteVersion: now,
  } });
  assert.deepEqual(requests[0], {
    kind: "update_workflow_issue", write_id: "write-1", conductor_short_hash: "abc123",
    expected_project_id: "project-1", root_issue_id: "root-1", expected_root_remote_version: now,
    target: { target_issue_id: "work-1", expected_remote_version: now },
    status_id: "status-progress", title: "Updated", description: "Description",
  });
});

function createGateway(
  request: (body: Record<string, unknown>) => Promise<unknown>,
  observeDiscovery?: (evidence: {
    rootHeaderCount: number; listPageCount: number; getIssueTreeCount: number;
  }) => void,
) {
  return new PodiumLinearGatewayClientImpl("abc123", {
    async request({ body }) { return await request(body as Record<string, unknown>) as never; },
  }, {
    async list() { return { profiles: [{ profileId: "profile-1", displayName: "Codex",
      backendKind: "codex" as const, authenticationMethod: "chatgpt" as const,
      codexTurnSettings: { model: "gpt-5", reasoningEffort: "high" as const,
        isFastModeEnabled: false }, executionPolicy: { sandboxMode: "workspace_write" as const,
        commandAllowlist: [], commandDenylist: [] }, createdAt: now, updatedAt: now }],
      activeProfileId: "profile-1" }; },
    create() { throw new Error("unused"); }, update() { throw new Error("unused"); },
    activate() { throw new Error("unused"); }, codexHome() { return "/profiles/1"; },
  }, { timeoutMs: 1_000, conductorId: "conductor-1",
    ...(observeDiscovery ? { observeDiscovery } : {}),
    async profileReadiness() { return "ready"; },
    async gitWorkspaceFacts() { return { branch: "symphony/runs/root-1",
      worktreePath: "/work/root-1", head: "abc", status: [] }; } });
}

function resolved() { return { kind: "resolved", resolved_project: {
  conductor_short_hash: "abc123", project: { project_id: "project-1",
    organization_id: "org-1", name: "Symphony", updated_at: now } } }; }

function rootsPage(count = 1, start = 1, hasNextPage = false) {
  return { kind: "root_issues_page", items: Array.from(
  { length: count }, (_, index) => { const issueId = `root-${index + start}`; return {
    issue: root(issueId), is_delegated_to_symphony: true, priority: "normal", blockers: [],
    root_managed_comments: [comment(`comment-${index + 1}`, issueId)],
  }; }), page_info: { has_next_page: hasNextPage,
    ...(hasNextPage ? { end_cursor: "page-2" } : {}) } }; }

function treePage(comments = [comment()]) { return { kind: "issue_tree_page", tree: {
  root_issue_id: "root-1", nodes: [root(), { ...root("work-1"), identifier: "SYM-2",
    parent_issue_id: "root-1", depth: 1, node_kind: "work", origin: "symphony",
    managed_marker: "root-1:work-1" }], root_phase_labels: [],
  root_managed_comments: comments, human_answers: [], observed_at: now },
  page_info: { has_next_page: false } }; }

function workflowTreePage(tree = workflowTree()) {
  return { kind: "workflow_issue_tree", tree };
}

function workflowTree() {
  return {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "status-progress", name: "In Progress", category: "started" as const, position: 2 },
      { status_id: "status-todo", name: "Todo", category: "unstarted" as const, position: 1 },
    ],
    issues: [
      {
        issue_id: "root-1", identifier: "SYM-1", project_id: "project-1",
        status_id: "status-progress", status_name: "In Progress", status_category: "started" as const,
        status_position: 2, order: 0, depth: 0, title: "Root", description: "Build it",
        issue_kind: "root" as const, remote_version: now, updated_at: now,
      },
      {
        issue_id: "work-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1",
        status_id: "status-todo", status_name: "Todo", status_category: "unstarted" as const,
        status_position: 1, order: 1, depth: 1, title: "Work", description: "Implement it",
        managed_marker: "root-1:work-1", issue_kind: "work" as const,
        remote_version: now, updated_at: now,
      },
    ],
    comments: [{
      comment_id: "comment-1", issue_id: "root-1", body: "Root status.",
      managed_marker: "root-1:status", remote_version: now, updated_at: now,
    }],
    relations: [{
      relation_id: "relation-1", relation_kind: "blocks" as const,
      source_issue_id: "work-1", target_issue_id: "root-1",
    }],
    observed_at: now,
  };
}

function scopeResult() { return { kind: "root_scope", root_issue_id: "root-1",
  conductor_id: "conductor-1", performer_id: "conversation-1", terminal: false,
  issues: [{ issue_id: "root-1", identifier: "SYM-1", updated_at: now },
    { issue_id: "work-1", identifier: "SYM-2", parent_issue_id: "root-1",
      state: "Todo", node_kind: "work", updated_at: now },
    { issue_id: "human-1", identifier: "SYM-3", parent_issue_id: "root-1",
      state: "Todo", node_kind: "human", human_kind: "plan_approval",
      updated_at: now }], observed_at: now }; }

function root(issueId = "root-1") { return { issue_id: issueId,
  identifier: issueId.toUpperCase(), project_id: "project-1", state: "In Progress",
  order: 0, depth: 0, title: issueId, description: "Build V3", updated_at: now }; }

function managed() { return { conductorId: "conductor-1", performerProfileId: "profile-1",
  performerId: "conversation-1", deliveryBranch: "symphony/runs/root-1" }; }

function comment(commentId = "comment-1", issueId = "root-1") { return { comment_id: commentId,
  issue_id: issueId, managed_marker: `${issueId}:root-comment`, updated_at: now,
  body: serializeV3RootManagedComment(managed()) }; }
