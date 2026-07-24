import assert from "node:assert/strict";
import test from "node:test";

import { PodiumConductorServicesImpl } from "../dist/internal/composition/PodiumConductorServicesImpl.js";
import { ConductorPresenceImpl } from "../dist/internal/conductor-presence/ConductorPresenceImpl.js";
import { LinearGatewayProtocolHandlerImpl } from "../dist/internal/linear-gateway/LinearGatewayProtocolHandlerImpl.js";
import { PodiumConductorProtocolHandler } from "../dist/public/PodiumConductorProtocolHandler.js";

function project() {
  return {
    conductorShortHash: "abc123",
    expectedProjectId: "project-1",
    expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
  };
}

async function createConductorServices(
  linearSdk,
  onLinearObserver = () => undefined,
) {
  const binding = {
    bindingId: "binding-1",
    conductorId: "conductor-1",
    conductorShortHash: "abc123",
    linearInstallationId: "installation-1",
    organizationId: "organization-1",
    repositoryContext: {
      repositoryHandle: "repo-1",
      repositoryIdentity: "repository-1",
      repositoryDisplayName: "symphony",
      repositoryRoot: "/repository",
      baseBranch: "main",
    },
    desiredState: "running",
  };
  const services = new PodiumConductorServicesImpl(
    {
      getConductorBinding: () => binding,
      getLinearCredential: () => ({
        kind: "development_token",
        installationId: "installation-1",
        organizationId: "organization-1",
        accessToken: "test-token",
        delegateActorId: "app-user-1",
      }),
    },
    new ConductorPresenceImpl(),
    {
      now: () => "2026-07-16T00:00:00Z",
      sleep: async () => undefined,
      createLinearSdk: (_installation, observe) => {
        onLinearObserver(observe);
        return linearSdk;
      },
    },
  );
  await services.handle({
    kind: "conductor_handshake",
    binding_id: binding.bindingId,
    instance_id: "instance-1",
    conductor_id: binding.conductorId,
    conductor_short_hash: binding.conductorShortHash,
    linear_installation_id: binding.linearInstallationId,
    organization_id: binding.organizationId,
    repository: {
      repository_handle: binding.repositoryContext.repositoryHandle,
      canonical_path: binding.repositoryContext.repositoryRoot,
      base_branch: binding.repositoryContext.baseBranch,
    },
  });
  return services;
}

test("installation broker coalesces identical concurrent Podium reads", async () => {
  let reads = 0;
  let release;
  const services = await createConductorServices({
    async getWorkflowIssueTree() {
      reads += 1;
      await new Promise((resolve) => { release = resolve; });
      return workflowTree("project-1");
    },
  });
  const body = {
    kind: "get_workflow_issue_tree", binding_id: "binding-1", conductor_short_hash: "abc123",
    expected_project_id: "project-1", root_issue_id: "root-1",
  };
  const first = services.handle(body);
  const shared = services.handle(body);
  await Promise.resolve();

  assert.equal(reads, 1);
  release();
  assert.deepEqual(await first, await shared);
});

test("Podium reuses one Linear gateway for sequential requests in the same class", async () => {
  let sdkCreations = 0;
  const services = await createConductorServices({
    async getWorkflowIssueTree() { return workflowTree("project-1"); },
  }, () => { sdkCreations += 1; });
  const body = {
    kind: "get_workflow_issue_tree", conductor_short_hash: "abc123",
    expected_project_id: "project-1", root_issue_id: "root-1",
  };

  await services.handle(body);
  await services.handle(body);

  assert.equal(sdkCreations, 1);
});

test("workflow issue creation rejects a missing label_names field before dispatch", async () => {
  const services = await createConductorServices({});
  await assert.rejects(
    services.handle({
      kind: "create_workflow_issue", binding_id: "binding-1", conductor_short_hash: "abc123",
      write_id: "write-1", expected_project_id: "project-1", root_issue_id: "root-1",
      expected_root_remote_version: "root-version", parent_expected_remote_version: "parent-version",
      parent_expected_status_id: "status-todo", parent_issue_id: "root-1", issue_kind: "work",
      title: "Work", description: "Do it", status_id: "status-todo", managed_marker: "work-marker",
    }),
    /linear_workflow_label_names_missing/u,
  );
});


test("gateway reads fully paginate and reject cross-project issue data", async () => {
  const cursors = [];
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async listRootIssues({ cursor }) {
        cursors.push(cursor);
        return cursor
          ? {
              items: [{
                issue: issue("root-2", "project-1"),
                isDelegatedToSymphony: true,
                priority: "high",
                blockers: [],
                rootConductorLabels: [],
                rootManagedComments: [],
              }],
              pageInfo: { hasNextPage: false },
            }
          : {
              items: [{
                issue: issue("root-1", "project-1"),
                isDelegatedToSymphony: true,
                priority: "urgent",
                blockers: [],
                rootConductorLabels: [],
                rootManagedComments: [],
              }],
              pageInfo: { hasNextPage: true, endCursor: "next" },
            };
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const roots = await handler.listAllRootIssues("project-1");
  assert.deepEqual(roots.map(({ issue }) => issue.issueId), ["root-1", "root-2"]);
  assert.deepEqual(cursors, [undefined, "next"]);

  const invalid = new LinearGatewayProtocolHandlerImpl(
    {
      async listRootIssues() {
        return {
          items: [{
            issue: issue("root-x", "project-other"),
            isDelegatedToSymphony: true,
            priority: "normal",
            blockers: [],
            rootConductorLabels: [],
            rootManagedComments: [],
          }],
          pageInfo: { hasNextPage: false },
        };
      },
    },
    { sleep: async () => undefined, maxAttempts: 1, baseDelayMs: 10 },
  );
  await assert.rejects(invalid.listAllRootIssues("project-1"), /linear_project_mismatch/);
});

test("Root scheduling gateway preserves each bounded SDK page without making eligibility decisions", async () => {
  const services = await createConductorServices({
    async listRootIssues({ cursor }) {
      return cursor
        ? {
            items: [{
              issue: issue("root-2", "project-1"),
              isDelegatedToSymphony: false,
              priority: "low",
              blockers: [],
              rootConductorLabels: [],
              rootManagedComments: [],
            }],
            pageInfo: { hasNextPage: false },
          }
        : {
            items: [{
              issue: { ...issue("root-1", "project-1"), order: 12.5 },
              isDelegatedToSymphony: true,
              priority: "urgent",
              blockers: [
                {
                  sourceIssueId: "root-1",
                  targetIssueId: "blocker-done",
                  targetState: "Done",
                },
                {
                  sourceIssueId: "root-1",
                  targetIssueId: "blocker-active",
                  targetState: "In Progress",
                },
              ],
              rootConductorLabels: [],
              rootManagedComments: [{
                commentId: "comment-1",
                issueId: "root-1",
                authorKind: "symphony",
                authorId: "symphony-bot",
                createdAt: "2026-07-16T00:00:00Z",
                updatedAt: "2026-07-16T00:00:00Z",
                managedMarker: "root-1:root-comment",
                body: v3PrimaryComment(),
              }],
            }],
            pageInfo: { hasNextPage: true, endCursor: "next" },
          };
    },
  });

  const first = await services.handle({
    kind: "list_root_issues",
    project_id: "project-1",
    page: { limit: 250 },
  });
  const second = await services.handle({
    kind: "list_root_issues",
    project_id: "project-1",
    page: { limit: 250, cursor: "next" },
  });

  assert.equal(first.kind, "root_issues_page");
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].priority, "urgent");
  assert.equal(first.items[0].issue.order, 12.5);
  assert.deepEqual(first.items[0].blockers.map(({ target_state }) => target_state), [
    "Done",
    "In Progress",
  ]);
  assert.equal(first.items[0].root_managed_comments[0].comment_id, "comment-1");
  assert.deepEqual(first.page_info, { has_next_page: true, end_cursor: "next" });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].issue.issue_id, "root-2");
  assert.equal(second.items[0].priority, "low");
  assert.deepEqual(second.page_info, { has_next_page: false });
});

test("Root scheduling service emits the complete issue snapshot required by the protocol", async () => {
  const services = await createConductorServices({
    async listRootIssues() {
      return {
        items: [{
          issue: { ...issue("root-1", "project-1"), labels: ["symphony:conductor/abc123"], isArchived: false },
          isDelegatedToSymphony: true,
          priority: "normal",
          blockers: [],
          rootConductorLabels: [{ conductorShortHash: "abc123" }],
          rootManagedComments: [],
        }],
        pageInfo: { hasNextPage: false },
      };
    },
  });

  const result = await services.handle({
    kind: "list_root_issues",
    project_id: "project-1",
    page: { limit: 250 },
  });

  assert.deepEqual(result.items[0].issue.labels, ["symphony:conductor/abc123"]);
  assert.equal(result.items[0].issue.is_archived, false);
});

test("Root scheduling gateway rejects malformed closed values", async () => {
  const valid = {
    issue: issue("root-1", "project-1"),
    isDelegatedToSymphony: true,
    priority: "normal",
    blockers: [],
    rootConductorLabels: [],
    rootManagedComments: [],
  };
  const invalidRoots = [
    { ...valid, priority: undefined },
    { ...valid, blockers: undefined },
    { ...valid, rootManagedComments: undefined },
    {
      ...valid,
      rootManagedComments: [{
        commentId: "comment-1",
        issueId: "root-other",
        updatedAt: "2026-07-16T00:00:00Z",
        managedMarker: "root-other:root-comment",
        body: v3PrimaryComment(),
      }],
    },
    {
      ...valid,
      blockers: [{
        sourceIssueId: "wrong-root",
        targetIssueId: "blocker-1",
        targetState: "Done",
      }],
    },
    {
      ...valid,
      blockers: [{
        sourceIssueId: "root-1",
        targetIssueId: "blocker-1",
        targetState: "Unknown",
      }],
    },
  ];

  for (const root of invalidRoots) {
    const handler = new LinearGatewayProtocolHandlerImpl(
      {
        async listRootIssues() {
          return {
            items: [root],
            pageInfo: { hasNextPage: false },
          };
        },
      },
      { sleep: async () => undefined, maxAttempts: 1, baseDelayMs: 10 },
    );
    await assert.rejects(
      handler.listAllRootIssues("project-1"),
      /linear_root_scheduling_invalid/u,
    );
  }
});

test("workflow Issue Tree validates status identity, comments, relations, and scope", async () => {
  const valid = workflowTree("project-1");
  const invalid = [
    { ...valid, statusCatalog: [...valid.statusCatalog, { ...valid.statusCatalog[0] }] },
    { ...valid, issues: [...valid.issues, { ...valid.issues[0] }] },
    { ...valid, issues: [{ ...valid.issues[0], projectId: "project-foreign" }, valid.issues[1]] },
    { ...valid, comments: [{ ...valid.comments[0], issueId: "missing-issue" }] },
    { ...valid, relations: [{ ...valid.relations[0], targetIssueId: "missing-issue" }] },
    { ...valid, sourceManifest: [] },
    { ...valid, coverage: { isComplete: false, omissions: [{ sourceId: "root-1", reason: "incomplete" }] } },
  ];
  for (const tree of invalid) {
    const handler = new LinearGatewayProtocolHandlerImpl(
      { async getWorkflowIssueTree() { return tree; } },
      { sleep: async () => undefined, maxAttempts: 1, baseDelayMs: 10 },
    );
    await assert.rejects(
      handler.getWorkflowIssueTree("project-1", "root-1"),
      /linear_workflow_/u,
    );
  }
});

test("workflow Issue Tree preserves the bounded read-back projection", async () => {
  const tree = workflowTree("project-1");
  const handler = new LinearGatewayProtocolHandlerImpl(
    { async getWorkflowIssueTree() { return tree; } },
    { sleep: async () => undefined, maxAttempts: 1, baseDelayMs: 10 },
  );
  assert.deepEqual(
    await handler.getWorkflowIssueTree("project-1", "root-1"),
    tree,
  );
});

test("Podium-Conductor exposes the correlated workflow Tree route and rejects hash drift", async () => {
  let reads = 0;
  const services = await createConductorServices({
    async getWorkflowIssueTree(input) {
      reads += 1;
      assert.deepEqual(input, { projectId: "project-1", rootIssueId: "root-1" });
      return workflowTree("project-1");
    },
  });

  const result = await services.handle({
    kind: "get_workflow_issue_tree",
    binding_id: "binding-1",
    conductor_short_hash: "abc123",
    expected_project_id: "project-1",
    root_issue_id: "root-1",
  });

  assert.equal(result.kind, "workflow_issue_tree");
  assert.equal(result.tree.issues.length, 2);
  assert.equal(result.tree.issues[0].is_archived, false);
  assert.equal(result.tree.relations[0].relation_id, "relation-1");
  assert.deepEqual(result.tree.comments[0].reactions, []);
  assert.equal(result.tree.comments[0].thread_root_comment_id, "comment-1");
  assert.equal(result.tree.comments[0].thread_state, "unresolved");
  assert.deepEqual(result.tree.comment_thread_changes, []);
  assert.equal(result.tree.coverage.is_complete, true);
  assert.ok(result.tree.source_manifest.some(({ source_kind, source_id }) =>
    source_kind === "linear_comment" && source_id === "comment-1"));
  assert.equal(reads, 1);
  const protocol = new PodiumConductorProtocolHandler(services);
  const closed = await protocol.handle({
    protocol_version: "1",
    request_id: "tree-request-1",
    body: {
      kind: "get_workflow_issue_tree",
      binding_id: "binding-1",
      conductor_short_hash: "abc123",
      expected_project_id: "project-1",
      root_issue_id: "root-1",
    },
  });
  assert.equal(closed.body.kind, "workflow_issue_tree");
  await assert.rejects(
    services.handle({
      kind: "get_workflow_issue_tree",
      binding_id: "binding-1",
      conductor_short_hash: "wrong-hash",
      expected_project_id: "project-1",
      root_issue_id: "root-1",
    }),
    /linear_conductor_short_hash_mismatch/u,
  );
  assert.equal(reads, 2);
});

test("workflow mutation rejects stale Root and target versions before Linear write", async () => {
  let writes = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return { kind: "resolved", projectId: "project-1", updatedAt: "project-version" };
      },
      async readWorkflowMutationTarget(issueId) {
        return issueId === "root-1"
          ? { issueId, projectId: "project-1", updatedAt: "root-new" }
          : { issueId, projectId: "project-1", updatedAt: "target-version", statusId: "status-todo" };
      },
      async readWorkflowMutationOutcome() { return undefined; },
      async executeWorkflowMutation() { writes += 1; },
    },
    { sleep: async () => undefined, maxAttempts: 2, baseDelayMs: 10 },
  );

  const result = await handler.mutateWorkflow({
    kind: "update_workflow_issue", writeId: "write-1", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-old",
    target: { targetIssueId: "work-1", expectedRemoteVersion: "target-version", expectedStatusId: "status-todo" },
    statusId: "status-progress", title: "Updated", description: "Description",
  });

  assert.deepEqual(result, { kind: "precondition_conflict" });
  assert.equal(writes, 0);
});

test("Podium-Conductor serializes native comment mutation commands and semantic read-back", async () => {
  const received = [];
  const services = await createConductorServices({
    async preflightWorkflowMutation(command) {
      received.push(command);
      return {
        kind: "already_applied",
        readBack: {
          writeId: command.writeId,
          targetIssueId: "root-1",
          remoteVersion: "2026-07-16T00:00:02Z",
          comment: {
            commentId: "reply-comment",
            issueId: "root-1",
            body: "Acknowledged.",
            authorKind: "symphony",
            authorId: "app-user-1",
            parentCommentId: "comment-1",
            threadRootCommentId: "comment-1",
            threadState: "unresolved",
            reactions: [],
            createdAt: "2026-07-16T00:00:02Z",
            remoteVersion: "2026-07-16T00:00:02Z",
            updatedAt: "2026-07-16T00:00:02Z",
          },
        },
      };
    },
  });

  const result = await services.handle({
    kind: "create_comment_reply",
    binding_id: "binding-1",
    write_id: "reply-write-1",
    conductor_short_hash: "abc123",
    expected_project_id: "project-1",
    root_issue_id: "root-1",
    expected_root_remote_version: "root-version",
    source_comment_id: "comment-1",
    expected_source_comment_remote_version: "comment-version",
    expected_thread_root_comment_id: "comment-1",
    expected_thread_state: "unresolved",
    body: "Acknowledged.",
  });

  assert.deepEqual(received, [{
    kind: "create_comment_reply",
    writeId: "reply-write-1",
    conductorShortHash: "abc123",
    expectedProjectId: "project-1",
    rootIssueId: "root-1",
    expectedRootRemoteVersion: "root-version",
    sourceCommentId: "comment-1",
    expectedSourceCommentRemoteVersion: "comment-version",
    expectedThreadRootCommentId: "comment-1",
    expectedThreadState: "unresolved",
    body: "Acknowledged.",
  }]);
  assert.deepEqual(result, {
    kind: "already_applied",
    read_back: {
      write_id: "reply-write-1",
      target_issue_id: "root-1",
      remote_version: "2026-07-16T00:00:02Z",
      comment: {
        comment_id: "reply-comment",
        issue_id: "root-1",
        body: "Acknowledged.",
        author_kind: "symphony",
        author_id: "app-user-1",
        parent_comment_id: "comment-1",
        thread_root_comment_id: "comment-1",
        thread_state: "unresolved",
        reactions: [],
        created_at: "2026-07-16T00:00:02Z",
        remote_version: "2026-07-16T00:00:02Z",
        updated_at: "2026-07-16T00:00:02Z",
      },
    },
  });
});

test("workflow mutation proves stable write idempotency with semantic read-back", async () => {
  let writes = 0;
  const readBack = { writeId: "write-1", targetIssueId: "work-1", remoteVersion: "target-new" };
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return { kind: "resolved", projectId: "project-1", updatedAt: "project-version" };
      },
      async readWorkflowMutationTarget(issueId) {
        return { issueId, projectId: "project-1", updatedAt: issueId === "root-1" ? "root-version" : "target-version", statusId: "status-todo" };
      },
      async readWorkflowMutationOutcome() { return readBack; },
      async executeWorkflowMutation() { writes += 1; },
    },
    { sleep: async () => undefined, maxAttempts: 2, baseDelayMs: 10 },
  );

  const result = await handler.mutateWorkflow({
    kind: "update_workflow_issue", writeId: "write-1", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "work-1", expectedRemoteVersion: "target-version" },
    statusId: "status-progress", title: "Updated", description: "Description",
  });

  assert.deepEqual(result, { kind: "already_applied", readBack });
  assert.equal(writes, 0);
});

test("workflow mutation uses one compact preflight instead of rereading Root and target", async () => {
  let preflights = 0;
  let targetReads = 0;
  let writes = 0;
  const readBack = { writeId: "write-compact", targetIssueId: "work-1", remoteVersion: "target-new" };
  const handler = new LinearGatewayProtocolHandlerImpl({
    async readProjectResolution() {
      return { kind: "resolved", projectId: "project-1", updatedAt: "project-version" };
    },
    async preflightWorkflowMutation() {
      preflights += 1;
      return { kind: "ready" };
    },
    async readWorkflowMutationTarget() { targetReads += 1; throw new Error("compact preflight should own target reads"); },
    async executeWorkflowMutation() { writes += 1; },
    async readWorkflowMutationOutcome() { return writes ? readBack : undefined; },
  }, { sleep: async () => undefined, maxAttempts: 2, baseDelayMs: 10 });

  const result = await handler.mutateWorkflow({
    kind: "update_workflow_issue", writeId: "write-compact", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "work-1", expectedRemoteVersion: "target-version" },
    statusId: "status-progress", title: "Updated", description: "Description",
  });

  assert.deepEqual(result, { kind: "applied", readBack });
  assert.equal(preflights, 1);
  assert.equal(targetReads, 0);
  assert.equal(writes, 1);
});

test("ambiguous workflow writes return a closed read-back target", async () => {
  let writes = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return { kind: "resolved", projectId: "project-1", updatedAt: "project-version" };
      },
      async readWorkflowMutationTarget(issueId) {
        return { issueId, projectId: "project-1", updatedAt: issueId === "root-1" ? "root-version" : "target-version", statusId: "status-todo" };
      },
      async readWorkflowMutationOutcome() { return undefined; },
      async executeWorkflowMutation() {
        writes += 1;
        const error = new Error("connection lost after workflow write");
        error.retryable = true;
        error.ambiguous = true;
        throw error;
      },
    },
    { sleep: async () => undefined, maxAttempts: 1, baseDelayMs: 10 },
  );

  const result = await handler.mutateWorkflow({
    kind: "append_workflow_comment", writeId: "write-1", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "work-1", expectedRemoteVersion: "target-version" }, body: "Progress",
  });

  assert.deepEqual(result, { kind: "write_unconfirmed", readBackTarget: {
    writeId: "write-1", targetIssueId: "work-1", remoteVersion: "target-version",
  } });
  assert.equal(writes, 1);
});

function issue(issueId, projectId) {
  return {
    issueId,
    identifier: issueId.toUpperCase(),
    projectId,
    state: "Todo",
    order: 1,
    depth: 0,
    title: "Title",
    description: "",
    labels: [],
    isArchived: false,
    updatedAt: "2026-07-16T00:00:00Z",
  };
}

function workflowTree(projectId) {
  return {
    rootIssueId: "root-1",
    statusCatalog: [
      { statusId: "status-progress", name: "In Progress", category: "started", position: 2 },
      { statusId: "status-todo", name: "Todo", category: "unstarted", position: 1 },
    ],
    issues: [
      { ...issue("root-1", projectId), statusId: "status-progress", statusName: "In Progress", statusCategory: "started", statusPosition: 2, depth: 0, remoteVersion: "2026-07-16T00:00:00Z" },
      { ...issue("work-1", projectId), parentIssueId: "root-1", statusId: "status-todo", statusName: "Todo", statusCategory: "unstarted", statusPosition: 1, depth: 1, remoteVersion: "2026-07-16T00:00:00Z" },
    ],
    comments: [{ commentId: "comment-1", issueId: "root-1", body: "status", authorKind: "human", authorId: "human-1", authorUserId: "human-1", threadRootCommentId: "comment-1", threadState: "unresolved", reactions: [], createdAt: "2026-07-16T00:00:00Z", remoteVersion: "2026-07-16T00:00:01Z", updatedAt: "2026-07-16T00:00:01Z" }],
    commentThreadChanges: [],
    relations: [{ relationId: "relation-1", relationKind: "blocks", sourceIssueId: "work-1", targetIssueId: "root-1" }],
    sourceManifest: [
      { sourceKind: "linear_issue", sourceId: "root-1", sourceVersion: "2026-07-16T00:00:00Z", actorKind: "unknown" },
      { sourceKind: "linear_issue", sourceId: "work-1", sourceVersion: "2026-07-16T00:00:00Z", actorKind: "unknown", stableWriteId: "root-1:work-1" },
      { sourceKind: "linear_comment", sourceId: "comment-1", sourceVersion: "2026-07-16T00:00:01Z", actorKind: "human" },
      { sourceKind: "linear_relation", sourceId: "relation-1", sourceVersion: "relation-1", actorKind: "unknown" },
      { sourceKind: "linear_status_catalog", sourceId: "project-1:status-catalog", sourceVersion: "status-catalog-v1", actorKind: "unknown" },
    ],
    coverage: { isComplete: true, omissions: [] },
    observedAt: "2026-07-16T00:00:02Z",
  };
}

function v3PrimaryComment() {
  return ["Symphony", "Conductor: conductor-1", "Performer profile: profile-1",
    "Conversation: active", "Activity: none", "Evidence: current Linear and Git read-back",
    "Observed at: none", "Branch: symphony/runs/root-1", "Pull request: none",
    "Current problem: none", "", "<!-- symphony root", "conductor_id: conductor-1",
    "performer_profile_id: profile-1",
    "delivery_branch: symphony/runs/root-1", "pull_request: none", "retry_blocked: false",
    "retry_failure_code: none",
    "retry_observed_at: none", "-->"].join("\n");
}
