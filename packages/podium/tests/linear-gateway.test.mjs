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
  onRequestScope = () => undefined,
  bindings = [conductorBinding()],
  observeLinearRequest = () => undefined,
  observeLinearRequestCoalesced = () => undefined,
) {
  const services = new PodiumConductorServicesImpl(
    {
      getConductorBindingById: (bindingId) => bindings.find((candidate) => candidate.bindingId === bindingId),
      listConductorBindings: () => bindings,
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
      createLinearSdk: (_installation, observe, requestScope) => {
        onLinearObserver(observe);
        onRequestScope(requestScope);
        return linearSdk;
      },
      observeLinearRequest,
      observeLinearRequestCoalesced,
    },
  );
  const channels = new Map();
  await Promise.all(bindings.map(async (entry, index) => {
    const channel = services.openChannel({
      bindingId: entry.bindingId,
      conductorId: entry.conductorId,
      instanceId: `instance-${index + 1}`,
    });
    channels.set(entry.bindingId, channel);
    await channel.handle({
      kind: "conductor_handshake",
      binding_id: entry.bindingId,
      instance_id: `instance-${index + 1}`,
      conductor_id: entry.conductorId,
      conductor_short_hash: entry.conductorShortHash,
      linear_installation_id: entry.linearInstallationId,
      organization_id: entry.organizationId,
      repository: {
        repository_handle: entry.repositoryContext.repositoryHandle,
        canonical_path: entry.repositoryContext.repositoryRoot,
        base_branch: entry.repositoryContext.baseBranch,
      },
    }, undefined, { requestId: `handshake-${index + 1}` });
  }));
  return {
    handle(body, requestId = `${body.binding_id}:${body.kind}`) {
      const channel = channels.get(body.binding_id);
      if (!channel) throw new Error("test_channel_missing");
      return channel.handle(body, undefined, { requestId });
    },
    close() {
      for (const channel of channels.values()) channel.close();
    },
  };
}

function conductorBinding(overrides = {}) {
  return {
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
    ...overrides,
  };
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
    kind: "get_workflow_issue_tree", binding_id: "binding-1", instance_id: "instance-1", conductor_short_hash: "abc123",
    expected_project_id: "project-1", root_issue_id: "root-1",
  };
  const first = services.handle(body);
  const shared = services.handle(body);
  await Promise.resolve();

  assert.equal(reads, 1);
  release();
  assert.deepEqual(await first, await shared);
});

test("Project Root Index coalesces concurrent reads from three Conductors sharing an installation", async () => {
  let physicalReads = 0;
  let release;
  const coalesced = [];
  const headers = Array.from({ length: 12 }, (_unused, index) => rootHeader({
    rootIssueId: `root-${index + 1}`,
    identifier: `SYM-${index + 1}`,
  }));
  const bindings = [
    conductorBinding(),
    conductorBinding({ bindingId: "binding-2", conductorId: "conductor-2", conductorShortHash: "def456" }),
    conductorBinding({ bindingId: "binding-3", conductorId: "conductor-3", conductorShortHash: "ghi789" }),
  ];
  const services = await createConductorServices({
    async listProjectRootIndexPage() {
      physicalReads += 1;
      await new Promise((resolve) => { release = resolve; });
      return { headers, pageInfo: { hasNextPage: false } };
    },
  }, undefined, undefined, bindings, undefined, (observation) => coalesced.push(observation));

  const reads = bindings.map(({ bindingId }, index) => services.handle({
    kind: "list_project_root_index_page",
    binding_id: bindingId,
    instance_id: `instance-${index + 1}`,
    expected_project_id: "project-1",
    page: { limit: 250 },
  }, `index-request-${index + 1}`));
  await Promise.resolve();

  assert.equal(physicalReads, 1);
  release();
  const pages = await Promise.all(reads);
  assert.equal(pages.length, 3);
  assert.ok(pages.every((page) => page.kind === "project_root_index_page" && page.page.headers.length === 12));
  assert.equal(physicalReads, 1);
  assert.deepEqual(coalesced, [
    {
      requestId: "index-request-2",
      coalescedIntoRequestId: "index-request-1",
      requestClass: "workflow",
    },
    {
      requestId: "index-request-3",
      coalescedIntoRequestId: "index-request-1",
      requestClass: "workflow",
    },
  ]);
});

test("Project Root Index physical observations retain the production installation and Project scope", async () => {
  let physicalReads = 0;
  let observePhysical;
  const observations = [];
  const bindings = [
    conductorBinding(),
    conductorBinding({ bindingId: "binding-2", conductorId: "conductor-2", conductorShortHash: "def456" }),
    conductorBinding({ bindingId: "binding-3", conductorId: "conductor-3", conductorShortHash: "ghi789" }),
  ];
  const services = await createConductorServices({
    async listProjectRootIndexPage() {
      physicalReads += 1;
      observePhysical({
        operation: "SymphonyProjectRootIndex",
        correlationId: "request-1",
        durationMs: 12,
        status: 200,
      });
      return {
        headers: Array.from({ length: 12 }, (_unused, index) => rootHeader({
          rootIssueId: `root-${index + 1}`,
          identifier: `SYM-${index + 1}`,
        })),
        pageInfo: { hasNextPage: false },
      };
    },
  }, (observe) => { observePhysical = observe; }, undefined, bindings, (observation) => observations.push(observation));

  await Promise.all(bindings.map(({ bindingId }, index) => services.handle({
    kind: "list_project_root_index_page",
    binding_id: bindingId,
    instance_id: `instance-${index + 1}`,
    expected_project_id: "project-1",
    page: { limit: 250 },
  }, `index-request-${index + 1}`)));

  assert.equal(physicalReads, 1);
  assert.deepEqual(observations, [{
    operation: "SymphonyProjectRootIndex",
    correlationId: "request-1",
    durationMs: 12,
    status: 200,
    installationId: "installation-1",
    projectId: "project-1",
    requestClass: "workflow",
    logicalRequestId: "index-request-1",
  }]);
});

test("Podium reuses one Linear gateway for sequential requests in the same class", async () => {
  let sdkCreations = 0;
  const services = await createConductorServices({
    async getWorkflowIssueTree() { return workflowTree("project-1"); },
  }, () => { sdkCreations += 1; });
  const body = {
    kind: "get_workflow_issue_tree", binding_id: "binding-1", instance_id: "instance-1", conductor_short_hash: "abc123",
    expected_project_id: "project-1", root_issue_id: "root-1",
  };

  await services.handle(body);
  await services.handle(body);

  assert.equal(sdkCreations, 1);
});

test("Podium scopes an appended human-readable workflow comment at the physical Linear request boundary", async () => {
  let requestScope;
  let physicalScope;
  const services = await createConductorServices({
    async preflightWorkflowMutation() { return { kind: "ready" }; },
    async executeWorkflowMutation() {
      physicalScope = requestScope();
    },
    async readWorkflowMutationOutcome() {
      return { writeId: "write-1", targetIssueId: "cycle-1", remoteVersion: "cycle-version-next" };
    },
  }, undefined, (scope) => { requestScope = scope; });

  await services.handle({
    kind: "append_workflow_comment", binding_id: "binding-1", instance_id: "instance-1", conductor_short_hash: "abc123",
    write_id: "write-1", expected_project_id: "project-1", root_issue_id: "root-1",
    expected_root_remote_version: "root-version",
    target: { target_issue_id: "cycle-1", expected_remote_version: "cycle-version" },
    body: "The requested verification has completed.",
  });

  assert.deepEqual(physicalScope, {
    root_issue_id: "root-1",
    mutation: {
      command_kind: "append_workflow_comment",
      write_id: "write-1",
      target_issue_id: "cycle-1",
      body: "The requested verification has completed.",
    },
  });
  assert.equal(requestScope(), undefined);
});

test("Podium translates a closed native attachment command without metadata", async () => {
  let observed;
  const services = await createConductorServices({
    async preflightWorkflowMutation(command) {
      observed = command;
      return { kind: "already_applied", readBack: { writeId: command.writeId, targetIssueId: "verify-1", remoteVersion: "attachment-v1" } };
    },
  });

  const result = await services.handle({
    kind: "create_workflow_attachment", binding_id: "binding-1", instance_id: "instance-1",
    conductor_short_hash: "abc123", write_id: "attachment-write", expected_project_id: "project-1",
    root_issue_id: "root-1", expected_root_remote_version: "root-version",
    target: { target_issue_id: "verify-1", expected_remote_version: "verify-version", expected_status_id: "status-verifying" },
    title: "Verified Git revision", url: "https://github.com/acme/repo/commit/abc123",
  });

  assert.deepEqual(observed, {
    kind: "create_workflow_attachment", writeId: "attachment-write", conductorShortHash: "abc123",
    expectedProjectId: "project-1", rootIssueId: "root-1", expectedRootRemoteVersion: "root-version",
    target: { targetIssueId: "verify-1", expectedRemoteVersion: "verify-version", expectedStatusId: "status-verifying" },
    title: "Verified Git revision", url: "https://github.com/acme/repo/commit/abc123",
  });
  assert.equal(result.kind, "already_applied");
});

test("workflow issue creation rejects a missing label_names field before dispatch", async () => {
  const services = await createConductorServices({});
  await assert.rejects(
    services.handle({
      kind: "create_workflow_issue", binding_id: "binding-1", instance_id: "instance-1", conductor_short_hash: "abc123",
      write_id: "write-1", expected_project_id: "project-1", root_issue_id: "root-1",
      expected_root_remote_version: "root-version", parent_expected_remote_version: "parent-version",
      parent_expected_status_id: "status-todo", parent_issue_id: "root-1", issue_kind: "work",
      title: "Work", description: "Do it", status_id: "status-todo",
    }),
    /linear_workflow_label_names_missing/u,
  );
});


function rootHeader(input = {}) {
  return {
    rootIssueId: input.rootIssueId ?? "root-1",
    identifier: input.identifier ?? "SYM-1",
    projectId: input.projectId ?? "project-1",
    state: input.state ?? "In Progress",
    isArchived: input.isArchived ?? false,
    updatedAt: input.updatedAt ?? "2026-07-16T00:00:00.000Z",
    priority: input.priority ?? "normal",
    blockers: input.blockers ?? [],
    rootConductorLabels: input.rootConductorLabels ?? [],
    isDelegatedToSymphony: input.isDelegatedToSymphony ?? true,
  };
}

test("Project Root Index gateway validates one bounded Header page without aggregating it", async () => {
  const requests = [];
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async listProjectRootIndexPage(input) {
        requests.push(input);
        return {
          headers: [rootHeader({
            priority: "urgent",
            blockers: [{ sourceIssueId: "root-1", targetIssueId: "blocker-1", targetState: "Done" }],
          })],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        };
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const page = await handler.listProjectRootIndexPage({ projectId: "project-1", cursor: "cursor-1", limit: 1 });

  assert.deepEqual(requests, [{ projectId: "project-1", cursor: "cursor-1", limit: 1 }]);
  assert.equal(page.headers[0].priority, "urgent");
  assert.deepEqual(page.pageInfo, { hasNextPage: true, endCursor: "next" });
});

test("Project Root Index gateway retries an official retryable Linear failure within the bounded policy", async () => {
  class RatelimitedLinearError extends Error {}
  let attempts = 0;
  const sleeps = [];
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async listProjectRootIndexPage() {
        attempts += 1;
        if (attempts === 1) throw new RatelimitedLinearError("private rate limit detail");
        return { headers: [rootHeader()], pageInfo: { hasNextPage: false } };
      },
    },
    { sleep: async (delayMs) => { sleeps.push(delayMs); }, maxAttempts: 3, baseDelayMs: 10, random: () => 0 },
  );

  const page = await handler.listProjectRootIndexPage({ projectId: "project-1", limit: 1 });

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [10]);
  assert.equal(page.headers.length, 1);
});

test("Project Root Index preserves an exhausted official Linear failure across the Conductor boundary", async () => {
  class RatelimitedLinearError extends Error {}
  let attempts = 0;
  const services = await createConductorServices({
    async listProjectRootIndexPage() {
      attempts += 1;
      throw new RatelimitedLinearError("private rate limit detail");
    },
  });
  const handler = new PodiumConductorProtocolHandler(services);

  const response = await handler.handle({
    protocol_version: "1",
    request_id: "request-1",
    body: {
      kind: "list_project_root_index_page",
      binding_id: "binding-1",
      instance_id: "instance-1",
      expected_project_id: "project-1",
      page: { limit: 1 },
    },
  });

  assert.equal(attempts, 4);
  assert.deepEqual(response.body, {
    code: "linear_rate_limited",
    category: "linear",
    sanitized_reason: "Linear rate limit exceeded.",
    retryable: true,
    action_required: "block_root",
    next_action: "Resolve the Linear error, then retry the Root.",
  });
  assert.doesNotMatch(JSON.stringify(response), /private rate limit detail/u);
});

test("Project Root Index gateway rejects malformed Header authority facts", async () => {
  const invalidHeaders = [
    rootHeader({ projectId: "project-other" }),
    rootHeader({ blockers: [{ sourceIssueId: "wrong-root", targetIssueId: "blocker-1", targetState: "Done" }] }),
    rootHeader({ rootConductorLabels: [{ conductorShortHash: "abc123" }, { conductorShortHash: "def456" }] }),
  ];

  for (const header of invalidHeaders) {
    const handler = new LinearGatewayProtocolHandlerImpl(
      {
        async listProjectRootIndexPage() {
          return { headers: [header], pageInfo: { hasNextPage: false } };
        },
      },
      { sleep: async () => undefined, maxAttempts: 1, baseDelayMs: 10 },
    );
    await assert.rejects(
      handler.listProjectRootIndexPage({ projectId: "project-1", limit: 1 }),
      /linear_project_root_index_invalid/u,
    );
  }
});

test("Project Root Index service emits a closed Header page", async () => {
  const services = await createConductorServices({
    async listProjectRootIndexPage() {
      return {
        headers: [rootHeader({
          rootConductorLabels: [{ conductorShortHash: "abc123def456" }],
        })],
        pageInfo: { hasNextPage: false },
      };
    },
  });

  const result = await services.handle({
    kind: "list_project_root_index_page",
    binding_id: "binding-1",
    instance_id: "instance-1",
    expected_project_id: "project-1",
    page: { limit: 250 },
  });

  assert.deepEqual(result, {
    kind: "project_root_index_page",
    page: {
      headers: [{
        root_issue_id: "root-1",
        identifier: "SYM-1",
        project_id: "project-1",
        state: "In Progress",
        is_archived: false,
        updated_at: "2026-07-16T00:00:00.000Z",
        priority: "normal",
        blockers: [],
        root_conductor_labels: [{ conductor_short_hash: "abc123def456" }],
        is_delegated_to_symphony: true,
      }],
      page_info: { has_next_page: false },
    },
  });
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
    instance_id: "instance-1",
    conductor_short_hash: "abc123",
    expected_project_id: "project-1",
    root_issue_id: "root-1",
  });

  assert.equal(result.kind, "workflow_issue_tree");
  assert.equal(result.tree.issues.length, 2);
  assert.equal(result.tree.issues[0].is_archived, false);
  assert.equal(result.tree.issues[0].created_at, "2026-07-16T00:00:00Z");
  assert.equal(result.tree.relations[0].relation_id, "relation-1");
  assert.deepEqual(result.tree.comments[0].reactions, []);
  assert.equal(result.tree.comments[0].thread_root_comment_id, "comment-1");
  assert.equal(result.tree.comments[0].thread_state, "unresolved");
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
      instance_id: "instance-1",
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
      instance_id: "instance-1",
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
    target: { targetIssueId: "work-1", expectedRemoteVersion: "target-version", expectedStatusId: "status-todo", expectedIsArchived: false },
    statusId: "status-progress", title: "Updated", description: "Description",
    labelNames: [], parentAssignment: { mode: "retain" },
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
    instance_id: "instance-1",
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
    target: { targetIssueId: "work-1", expectedRemoteVersion: "target-version", expectedIsArchived: false },
    statusId: "status-progress", title: "Updated", description: "Description",
    labelNames: [], parentAssignment: { mode: "retain" },
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
    target: { targetIssueId: "work-1", expectedRemoteVersion: "target-version", expectedIsArchived: false },
    statusId: "status-progress", title: "Updated", description: "Description",
    labelNames: [], parentAssignment: { mode: "retain" },
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
    createdAt: "2026-07-16T00:00:00Z",
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
    relations: [{ relationId: "relation-1", relationKind: "blocks", sourceIssueId: "work-1", targetIssueId: "root-1" }],
    attachments: [],
    activities: [],
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
