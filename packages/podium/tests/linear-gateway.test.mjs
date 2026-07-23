import assert from "node:assert/strict";
import test from "node:test";

import { PodiumConductorServicesImpl } from "../dist/internal/composition/PodiumConductorServicesImpl.js";
import { PodiumClientServicesImpl } from "../dist/internal/composition/PodiumClientServicesImpl.js";
import { LinearGatewayProtocolHandlerImpl } from "../dist/internal/linear-gateway/LinearGatewayProtocolHandlerImpl.js";

function project() {
  return {
    conductorShortHash: "abc123",
    expectedProjectId: "project-1",
    expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
  };
}

async function createConductorServices(
  linearSdk,
  onObservation = () => undefined,
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
      saveRuntimeObservation: onObservation,
      saveRootRuntimeObservation() {},
    },
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

test("Runtime Problem observations preserve only closed correlation fields", async () => {
  let observation;
  const services = await createConductorServices({}, (value) => { observation = value; });
  await services.handle({
    kind: "conductor_runtime_report", binding_id: "binding-1", instance_id: "instance-1",
    status: "recovering", observed_at: "2026-07-19T00:00:00Z",
    sanitized_summary: "Linear rate limited.",
    runtime_problem: {
      code: "linear_rate_limited", scope: "stage", severity: "error",
      sanitized_reason: "Linear rate limited.", action_required: "Retry later.",
      first_observed_at: "2026-07-19T00:00:00Z", last_observed_at: "2026-07-19T00:00:00Z",
      root_issue_id: "root-1", performer_profile_id: "profile-1",
    },
  });
  assert.equal(observation.problem.code, "linear_rate_limited");
  assert.equal(observation.problem.performerProfileId, "profile-1");
});

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
  }, undefined, () => { sdkCreations += 1; });
  const body = {
    kind: "get_workflow_issue_tree", conductor_short_hash: "abc123",
    expected_project_id: "project-1", root_issue_id: "root-1",
  };

  await services.handle(body);
  await services.handle(body);

  assert.equal(sdkCreations, 1);
});

test("physical rate observations do not block background reads", async () => {
  let observe;
  let usageReads = 0;
  const services = await createConductorServices({
    async getWorkflowIssueTree() { return workflowTree("project-1"); },
    async listRootUsage() { usageReads += 1; return { items: [], pageInfo: { hasNextPage: false } }; },
  }, undefined, (value) => { observe = value; });
  await services.handle({
    kind: "get_workflow_issue_tree", conductor_short_hash: "abc123",
    expected_project_id: "project-1", root_issue_id: "root-1",
  });
  observe({
    operation: "SymphonyWorkflowIssueTree", correlationId: "correlation-1", durationMs: 1,
    status: 200,
    requestWindow: { limit: 1000, remaining: 750, reset: 60 },
    complexityWindow: { limit: 250000, remaining: 187500, reset: 60 },
  });

  const result = await services.handle({
    kind: "list_root_usage", project_id: "project-1", page: { limit: 250 },
  });
  assert.equal(result.kind, "root_usage_page");
  assert.equal(usageReads, 1);
});

test("mutation conflict rereads and never executes stale state", async () => {
  let mutations = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:01Z",
        };
      },
      async readMutationTarget() {
        throw new Error("must not read target after project conflict");
      },
      async executeMutation() {
        mutations += 1;
        return {};
      },
      async readMutationOutcome() {
        throw new Error("must not read outcome after project conflict");
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const result = await handler.mutate({
    kind: "update_issue_state",
    project: project(),
    precondition: {
      expectedIssueId: "issue-1",
      expectedUpdatedAt: "2026-07-16T00:00:00Z",
      expectedState: "Todo",
    },
    state: "In Progress",
  });

  assert.deepEqual(result, { kind: "linear_precondition_conflict" });
  assert.equal(mutations, 0);
});

test("project resolution cache recovers after a failed read", async () => {
  let reads = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        reads += 1;
        if (reads === 1) throw new Error("temporary_failure");
        return { kind: "resolved", projectId: "project-1", updatedAt: "2026-07-16T00:00:00Z" };
      },
    },
    { maxAttempts: 1, baseDelayMs: 1, sleep: async () => undefined },
  );

  await assert.rejects(handler.resolveProject("abc123"), /temporary_failure/u);
  assert.equal((await handler.resolveProject("abc123")).kind, "resolved");
  assert.equal(reads, 2);
});

test("ambiguous create reads back Managed Marker before retry", async () => {
  let mutationAttempts = 0;
  let markerReads = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readMutationTarget() {
        return undefined;
      },
      async readManagedMarkerTarget() {
        return undefined;
      },
      async executeMutation() {
        mutationAttempts += 1;
        const error = new Error("connection lost after create");
        error.retryable = true;
        error.ambiguous = true;
        throw error;
      },
      async readMutationOutcome() {
        markerReads += 1;
        return mutationAttempts > 0
          ? {
              issue: {
                issueId: "issue-created",
                updatedAt: "2026-07-16T00:00:01Z",
              },
            }
          : undefined;
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const result = await handler.mutate({
    kind: "create_managed_node",
    nodeKind: "work",
    project: project(),
    parentIssueId: "root-1",
    managedMarker: "root:plan:node",
    order: 1,
    title: "Work",
    description: "Do the work",
  });

  assert.equal(result.kind, "already_applied");
  assert.equal(result.issue?.issueId, "issue-created");
  assert.equal(mutationAttempts, 1);
  assert.equal(markerReads, 1);
});

test("retry exhaustion returns concrete sanitized blocking failure", async () => {
  const delays = [];
  let attempts = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readMutationTarget() {
        return {
          issueId: "issue-1",
          updatedAt: "2026-07-16T00:00:00Z",
          state: "Todo",
        };
      },
      async executeMutation() {
        attempts += 1;
        const error = new Error("Authorization: Bearer secret-token upstream unavailable");
        error.retryable = true;
        error.code = "linear_unavailable";
        throw error;
      },
      async readManagedMarkerTarget() {
        return {
          issueId: "work-1",
          updatedAt: "2026-07-16T00:00:01Z",
        };
      },
      async readMutationOutcome() {
        return undefined;
      },
    },
    {
      sleep: async (delay) => delays.push(delay),
      maxAttempts: 3,
      baseDelayMs: 10,
    },
  );

  const result = await handler.mutate({
    kind: "update_issue_state",
    project: project(),
    precondition: {
      expectedIssueId: "issue-1",
      expectedUpdatedAt: "2026-07-16T00:00:00Z",
      expectedState: "Todo",
    },
    state: "In Progress",
  });

  assert.equal(result.kind, "failed");
  assert.equal(result.error.code, "linear_request_failed");
  assert.equal(result.error.actionRequired, "block_root");
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.sanitizedReason, "Linear request failed.");
  assert.deepEqual(delays, [10, 20]);
  assert.equal(attempts, 3);
});

test("Linear retry honors bounded upstream retry time and jitter", async () => {
  const delays = [];
  let attempts = 0;
  const handler = new LinearGatewayProtocolHandlerImpl({
    async readProjectResolution() {
      return { kind: "resolved", projectId: "project-1", updatedAt: "2026-07-16T00:00:00Z" };
    },
    async readMutationTarget() {
      return { issueId: "issue-1", updatedAt: "2026-07-16T00:00:00Z", state: "Todo" };
    },
    async executeMutation() {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("rate limited");
        error.retryable = true;
        error.retryAfterMs = 120;
        throw error;
      }
    },
    async readMutationOutcome() {
      return attempts > 1 ? { issue: { issueId: "issue-1", updatedAt: "2026-07-16T00:00:01Z" } } : undefined;
    },
  }, {
    sleep: async (delay) => delays.push(delay), maxAttempts: 2, baseDelayMs: 100,
    maxDelayMs: 125, random: () => 1,
  });
  const result = await handler.mutate({
    kind: "update_issue_state", project: project(),
    precondition: { expectedIssueId: "issue-1", expectedUpdatedAt: "2026-07-16T00:00:00Z" },
    state: "In Progress",
  });
  assert.equal(result.kind, "applied");
  assert.deepEqual(delays, [125]);
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

test("issue tree reads all pages and validates root parent depth and order", async () => {
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async getIssueTree({ cursor }) {
        return cursor
          ? {
              nodes: [{ ...issue("child-1", "project-1"), parentIssueId: "root-1", depth: 1, order: 2 }],
              rootPhaseLabels: ["planning"],
              rootConductorLabels: [],
              rootManagedComments: [],
              humanAnswers: [],
              observedAt: "2026-07-16T00:00:01Z",
              pageInfo: { hasNextPage: false },
            }
          : {
              nodes: [issue("root-1", "project-1")],
              rootPhaseLabels: ["planning"],
              rootConductorLabels: [],
              rootManagedComments: [],
              humanAnswers: [],
              observedAt: "2026-07-16T00:00:00Z",
              pageInfo: { hasNextPage: true, endCursor: "tree-next" },
            };
      },
    },
    { sleep: async () => undefined, maxAttempts: 1, baseDelayMs: 10 },
  );

  const tree = await handler.getCompleteIssueTree("project-1", "root-1");
  assert.equal(tree.nodes.length, 2);
  assert.equal(tree.observedAt, "2026-07-16T00:00:01Z");
});

test("issue tree rejects invalid Root managed-state facts", async () => {
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async getIssueTree() {
        return {
          nodes: [issue("root-1", "project-1")],
          rootPhaseLabels: ["invented-phase"],
          rootConductorLabels: [],
          rootManagedComments: [],
          humanAnswers: [],
          observedAt: "2026-07-16T00:00:00Z",
          pageInfo: { hasNextPage: false },
        };
      },
    },
    { sleep: async () => undefined, maxAttempts: 1, baseDelayMs: 10 },
  );

  await assert.rejects(
    handler.getCompleteIssueTree("project-1", "root-1"),
    /linear_root_phase_labels_invalid/,
  );
});

test("workflow Issue Tree validates status identity, comments, relations, and scope", async () => {
  const valid = workflowTree("project-1");
  const invalid = [
    { ...valid, statusCatalog: [...valid.statusCatalog, { ...valid.statusCatalog[0] }] },
    { ...valid, issues: [...valid.issues, { ...valid.issues[0] }] },
    { ...valid, issues: [{ ...valid.issues[0], projectId: "project-foreign" }, valid.issues[1]] },
    { ...valid, comments: [{ ...valid.comments[0], issueId: "missing-issue" }] },
    { ...valid, relations: [{ ...valid.relations[0], targetIssueId: "missing-issue" }] },
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
  assert.equal(result.tree.relations[0].relation_id, "relation-1");
  assert.equal(reads, 1);
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
  assert.equal(reads, 1);
});

test("affected Root detail projects its sanitized scheduling observation", async () => {
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
  const services = new PodiumClientServicesImpl(
    {
      getOnlyLinearCredential: () => ({
        kind: "development_token",
        installationId: "installation-1",
        organizationId: "organization-1",
        delegateActorId: "app-user",
        accessToken: "not-observed",
      }),
      getConductorBinding: () => binding,
      getRuntimeObservation: () => ({
        bindingId: "binding-1",
        status: "ready",
        observedAt: "2026-07-19T00:00:00Z",
        sanitizedSummary: "conductor_ready",
        lastResolvedProjectId: "project-1",
      }),
      getRootRuntimeObservation: (_bindingId, rootIssueId) =>
        rootIssueId === "root-1"
          ? {
              bindingId: "binding-1",
              rootIssueId,
              observedAt: "2026-07-19T00:00:01Z",
              sanitizedSummary: "root_dependency_cycle",
            }
          : undefined,
    },
    {},
    {},
    {},
    () => "2026-07-19T00:00:02Z",
    () => ({
      async getIssueTree() {
        return {
          nodes: [issue("root-1", "project-1")],
          rootPhaseLabels: ["blocked"],
          rootConductorLabels: [],
          rootManagedComments: [{
            commentId: "comment-1", issueId: "root-1", updatedAt: "2026-07-19T00:00:01Z",
            managedMarker: "root-1:root-comment", body: [
              "Symphony", "Conductor: conductor-1", "Performer profile: profile-1",
              "Conversation: active", "Activity: none", "Evidence: current Linear and Git read-back",
              "Observed at: none", "Branch: symphony/runs/root-1", "Pull request: none",
              "Current problem: none", "", "<!-- symphony root", "conductor_id: conductor-1",
              "performer_profile_id: profile-1", "delivery_branch: symphony/runs/root-1",
              "pull_request: none", "retry_blocked: true", "retry_failure_code: none",
              "retry_observed_at: 2026-07-19T00:00:01Z", "-->",
            ].join("\n"),
          }],
          humanAnswers: [],
          observedAt: "2026-07-19T00:00:01Z",
          pageInfo: { hasNextPage: false },
        };
      },
      async listRootUsage() {
        return { items: [], pageInfo: { hasNextPage: false } };
      },
    }),
  );

  const detail = await services.query({
    kind: "get_root_detail",
    root_issue_id: "root-1",
  });

  assert.deepEqual(detail.events, [{
    event_kind: "root_scheduling_observation",
    summary: "root_dependency_cycle",
    occurred_at: "2026-07-19T00:00:01Z",
  }]);
  assert.equal(detail.retry_observed_at, "2026-07-19T00:00:01Z");
});

test("ambiguous update reads back desired remote state before retry", async () => {
  let reads = 0;
  let attempts = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return { kind: "resolved", projectId: "project-1", updatedAt: "2026-07-16T00:00:00Z" };
      },
      async readMutationTarget() {
        reads += 1;
        return reads === 1
          ? { issueId: "issue-1", updatedAt: "2026-07-16T00:00:00Z", state: "Todo" }
          : { issueId: "issue-1", updatedAt: "2026-07-16T00:00:01Z", state: "In Progress" };
      },
      async executeMutation() {
        attempts += 1;
        const error = new Error("timeout");
        error.retryable = true;
        error.ambiguous = true;
        throw error;
      },
      async readMutationOutcome() {
        return {
          issue: {
            issueId: "issue-1",
            updatedAt: "2026-07-16T00:00:01Z",
            state: "In Progress",
          },
        };
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const result = await handler.mutate({
    kind: "update_issue_state",
    project: project(),
    precondition: { expectedIssueId: "issue-1", expectedUpdatedAt: "2026-07-16T00:00:00Z", expectedState: "Todo" },
    state: "In Progress",
  });
  assert.equal(result.kind, "already_applied");
  assert.equal(attempts, 1);
});

test("successful SDK mutation is not applied until read-back proves the outcome", async () => {
  let attempts = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readMutationTarget() {
        return {
          issueId: "issue-1",
          updatedAt: "2026-07-16T00:00:00Z",
          state: "Todo",
        };
      },
      async executeMutation() {
        attempts += 1;
        return {};
      },
      async readMutationOutcome() {
        return undefined;
      },
    },
    { sleep: async () => undefined, maxAttempts: 2, baseDelayMs: 10 },
  );

  const result = await handler.mutate({
    kind: "update_issue_state",
    project: project(),
    precondition: {
      expectedIssueId: "issue-1",
      expectedUpdatedAt: "2026-07-16T00:00:00Z",
      expectedState: "Todo",
    },
    state: "In Progress",
  });

  assert.deepEqual(result, {
    kind: "write_unconfirmed",
    readBackTarget: { kind: "issue", targetId: "issue-1" },
  });
  assert.equal(attempts, 2);
});

test("a repeated create reads back its stable Marker before executing again", async () => {
  let attempts = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readManagedMarkerTarget() {
        return {
          issueId: "work-1",
          updatedAt: "2026-07-16T00:00:01Z",
        };
      },
      async readMutationOutcome() {
        return {
          issue: {
            issueId: "work-1",
            updatedAt: "2026-07-16T00:00:01Z",
          },
        };
      },
      async executeMutation() {
        attempts += 1;
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const result = await handler.mutate({
    kind: "create_managed_node",
    nodeKind: "work",
    project: project(),
    parentIssueId: "root-1",
    managedMarker: "root-1:plan:work-1",
    order: 1,
    title: "Work",
    description: "Implement it",
  });

  assert.equal(result.kind, "already_applied");
  assert.equal(attempts, 0);
});

test("a repeated create conflicts when the stable Marker points to different content", async () => {
  let attempts = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readManagedMarkerTarget() {
        return {
          issueId: "work-other",
          updatedAt: "2026-07-16T00:00:01Z",
        };
      },
      async readMutationOutcome() {
        return undefined;
      },
      async executeMutation() {
        attempts += 1;
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const result = await handler.mutate({
    kind: "create_managed_node",
    nodeKind: "work",
    project: project(),
    parentIssueId: "root-1",
    managedMarker: "root-1:plan:work-1",
    order: 1,
    title: "Work",
    description: "Implement it",
  });

  assert.equal(result.kind, "linear_precondition_conflict");
  assert.equal(attempts, 0);
});

test("initial create read failures use bounded retry before read-back", async () => {
  class NetworkLinearError extends Error {}
  let projectReads = 0;
  const delays = [];
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        projectReads += 1;
        if (projectReads === 1) {
          throw new NetworkLinearError("raw request details");
        }
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readManagedMarkerTarget() {
        return {
          issueId: "work-1",
          updatedAt: "2026-07-16T00:00:01Z",
        };
      },
      async readMutationOutcome() {
        return {
          issue: {
            issueId: "work-1",
            updatedAt: "2026-07-16T00:00:01Z",
          },
        };
      },
      async executeMutation() {
        throw new Error("must not execute an existing create");
      },
    },
    {
      sleep: async (delay) => delays.push(delay),
      maxAttempts: 3,
      baseDelayMs: 10,
    },
  );

  const result = await handler.mutate({
    kind: "create_managed_node",
    nodeKind: "work",
    project: project(),
    parentIssueId: "root-1",
    managedMarker: "root-1:plan:work-1",
    order: 1,
    title: "Work",
    description: "Implement it",
  });

  assert.equal(result.kind, "already_applied");
  assert.deepEqual(delays, [10]);
  assert.equal(projectReads, 2);
});

test("Root Managed Comment create conflicts instead of overwriting an existing comment", async () => {
  let attempts = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readMutationOutcome() {
        return undefined;
      },
      async readProjectResolution() {
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readMutationTarget() {
        return {
          issueId: "root-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readRootManagedComment() {
        return {
          commentId: "comment-1",
          issueId: "root-1",
          updatedAt: "2026-07-16T00:00:01Z",
          managedMarker: "root-1:root-comment",
          body: "Different managed state",
        };
      },
      async executeMutation() {
        attempts += 1;
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const result = await handler.mutate({
    kind: "upsert_root_managed_comment",
    project: project(),
    rootPrecondition: {
      expectedIssueId: "root-1",
      expectedUpdatedAt: "2026-07-16T00:00:00Z",
    },
    managedMarker: "root-1:root-comment",
    body: v3PrimaryComment(),
  });

  assert.equal(result.kind, "linear_precondition_conflict");
  assert.equal(attempts, 0);
});

test("ambiguous Root comment mutation uses exact outcome read-back", async () => {
  let attempts = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readMutationTarget() {
        return {
          issueId: "root-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readRootManagedComment() {
        return undefined;
      },
      async executeMutation() {
        attempts += 1;
        const error = new Error("timeout");
        error.retryable = true;
        error.ambiguous = true;
        throw error;
      },
      async readMutationOutcome() {
        return attempts > 0
          ? {
              issue: {
                issueId: "root-1",
                updatedAt: "2026-07-16T00:00:01Z",
              },
            }
          : undefined;
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const result = await handler.mutate({
    kind: "upsert_root_managed_comment",
    project: project(),
    rootPrecondition: {
      expectedIssueId: "root-1",
      expectedUpdatedAt: "2026-07-16T00:00:00Z",
    },
    managedMarker: "root-1:root-comment",
    body: v3PrimaryComment(),
  });

  assert.equal(result.kind, "already_applied");
  assert.equal(attempts, 1);
});

test("ambiguous mutation returns a closed read-back target when confirmation is exhausted", async () => {
  let attempts = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return { kind: "resolved", projectId: "project-1", updatedAt: "2026-07-16T00:00:00Z" };
      },
      async readMutationTarget() {
        return { issueId: "root-1", updatedAt: "2026-07-16T00:00:00Z" };
      },
      async readRootManagedComment() { return undefined; },
      async executeMutation() {
        attempts += 1;
        const error = new Error("timeout");
        error.retryable = true;
        error.ambiguous = true;
        throw error;
      },
      async readMutationOutcome() { return undefined; },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 1 },
  );

  const result = await handler.mutate({
    kind: "upsert_root_managed_comment",
    project: project(),
    rootPrecondition: { expectedIssueId: "root-1", expectedUpdatedAt: "2026-07-16T00:00:00Z" },
    managedMarker: "root-1:root-comment",
    body: "bounded",
  });

  assert.deepEqual(result, {
    kind: "write_unconfirmed",
    readBackTarget: { kind: "managed_marker", targetId: "root-1:root-comment" },
  });
  assert.equal(attempts, 3);
});

test("Podium-Conductor maps only the selected Root comment identity", async () => {
  const observed = [];
  const services = await createConductorServices({
    async readProjectResolution() {
      return {
        kind: "resolved",
        projectId: "project-1",
        updatedAt: "2026-07-16T00:00:00Z",
      };
    },
    async readMutationOutcome(command) {
      observed.push(command);
      return {};
    },
  });
  const common = {
    kind: "project_root_comment",
    project: {
      conductor_short_hash: "abc123",
      expected_project_id: "project-1",
      expected_project_updated_at: "2026-07-16T00:00:00Z",
    },
    root_issue_id: "root-1",
  };

  await services.handle({
    ...common,
    comment_id: "comment-1",
    body: "Primary status",
  });
  await services.handle({
    ...common,
    event_key: "turn-1:2",
    body: "Completed.\n\n<!-- symphony turn event\nevent_key: turn-1:2\n-->",
  });

  assert.deepEqual(observed, [
    {
      kind: "project_root_comment",
      project: project(),
      rootIssueId: "root-1",
      commentId: "comment-1",
      body: "Primary status",
    },
    {
      kind: "project_root_comment",
      project: project(),
      rootIssueId: "root-1",
      eventKey: "turn-1:2",
      body: "Completed.\n\n<!-- symphony turn event\nevent_key: turn-1:2\n-->",
    },
  ]);
});

test("Podium-Conductor routes every workflow mutation through the closed service boundary", async () => {
  const executed = [];
  const outcomes = new Map();
  const services = await createConductorServices({
    async readProjectResolution() {
      return { kind: "resolved", projectId: "project-1", updatedAt: "project-version" };
    },
    async readWorkflowMutationTarget(issueId) {
      return {
        issueId,
        projectId: "project-1",
        updatedAt: issueId === "root-1" ? "root-version" : "target-version",
        parentIssueId: issueId === "root-1" ? undefined : "root-1",
        statusId: "status-todo",
        title: "Existing",
        description: "Existing description",
        managedMarker: issueId === "root-1" ? undefined : "target-marker",
      };
    },
    async readWorkflowMutationOutcome(command) {
      return outcomes.get(command.writeId);
    },
    async executeWorkflowMutation(command) {
      executed.push(command);
      outcomes.set(command.writeId, {
        writeId: command.writeId,
        targetIssueId: command.kind === "create_workflow_issue"
          ? "cycle-1"
          : command.kind === "create_workflow_relation"
            ? command.sourceIssueId
            : command.target.targetIssueId,
        remoteVersion: "written-version",
      });
    },
  });

  const common = {
    conductor_short_hash: "abc123",
    expected_project_id: "project-1",
    root_issue_id: "root-1",
    expected_root_remote_version: "root-version",
  };
  const results = await Promise.all([
    services.handle({
      ...common, kind: "create_workflow_issue", write_id: "write-create",
      parent_expected_remote_version: "root-version", parent_expected_status_id: "status-todo",
      parent_issue_id: "root-1", issue_kind: "cycle", title: "Cycle", description: "Plan it",
      status_id: "status-todo", managed_marker: "cycle-marker",
    }),
    services.handle({
      ...common, kind: "update_workflow_issue", write_id: "write-update",
      target: {
        target_issue_id: "work-1", expected_remote_version: "target-version",
        expected_status_id: "status-todo", expected_parent_issue_id: "root-1",
        expected_managed_marker: "target-marker",
      },
      status_id: "status-progress", title: "Updated", description: "Updated description",
    }),
    services.handle({
      ...common, kind: "append_workflow_comment", write_id: "write-comment",
      target: { target_issue_id: "work-1", expected_remote_version: "target-version" },
      body: "Progress",
    }),
    services.handle({
      ...common, kind: "create_workflow_relation", write_id: "write-relation",
      source_issue_id: "work-1", source_expected_remote_version: "target-version",
      target_issue_id: "root-1", target_expected_remote_version: "root-version",
      relation_kind: "blocked_by",
    }),
  ]);

  assert.deepEqual(results.map((result) => result.kind), ["applied", "applied", "applied", "applied"]);
  assert.deepEqual(executed.map((command) => command.kind).sort(), [
    "append_workflow_comment", "create_workflow_issue", "create_workflow_relation", "update_workflow_issue",
  ]);
  assert.deepEqual(results.map((result) => result.read_back.target_issue_id).sort(), [
    "cycle-1", "work-1", "work-1", "work-1",
  ]);
});

test("Podium-Conductor rejects mixed Root comment identities", async () => {
  const services = await createConductorServices({});

  await assert.rejects(
    services.handle({
      kind: "project_root_comment",
      project: {
        conductor_short_hash: "abc123",
        expected_project_id: "project-1",
        expected_project_updated_at: "2026-07-16T00:00:00Z",
      },
      root_issue_id: "root-1",
      comment_id: "comment-1",
      event_key: "turn-1:2",
      body: "Completed.",
    }),
    /linear_root_comment_identity_invalid/u,
  );
});

test("ambiguous Root event append reads back the exact event before retry", async () => {
  let attempts = 0;
  let outcomeReads = 0;
  const command = {
    kind: "project_root_comment",
    project: project(),
    rootIssueId: "root-1",
    eventKey: "turn-1:7",
    body: "Provider failed.\n\n<!-- symphony turn event\nevent_key: turn-1:7\n-->",
  };
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readMutationOutcome(candidate) {
        outcomeReads += 1;
        assert.deepEqual(candidate, command);
        return attempts === 0
          ? undefined
          : {
              issue: {
                issueId: "root-1",
                updatedAt: "2026-07-16T00:00:01Z",
              },
            };
      },
      async executeMutation() {
        attempts += 1;
        const error = new Error("connection lost after append");
        error.retryable = true;
        error.ambiguous = true;
        throw error;
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const result = await handler.mutate(command);

  assert.equal(result.kind, "already_applied");
  assert.equal(attempts, 1);
  assert.equal(outcomeReads, 2);
});

test("a repeated Root event append is deduplicated before mutation", async () => {
  let attempts = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readMutationOutcome() {
        return {
          issue: {
            issueId: "root-1",
            updatedAt: "2026-07-16T00:00:00Z",
          },
        };
      },
      async executeMutation() {
        attempts += 1;
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const result = await handler.mutate({
    kind: "project_root_comment",
    project: project(),
    rootIssueId: "root-1",
    eventKey: "turn-1:1",
    body: "Provider failed.\n\n<!-- symphony turn event\nevent_key: turn-1:1\n-->",
  });

  assert.equal(result.kind, "already_applied");
  assert.equal(attempts, 0);
});

test("official SDK network errors trigger bounded retry and precondition reread", async () => {
  class NetworkLinearError extends Error {}
  let attempts = 0;
  let projectReads = 0;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        projectReads += 1;
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readMutationTarget() {
        return {
          issueId: "issue-1",
          updatedAt: "2026-07-16T00:00:00Z",
          state: "Todo",
        };
      },
      async executeMutation() {
        attempts += 1;
        if (attempts === 1) throw new NetworkLinearError("connection reset");
        return {};
      },
      async readMutationOutcome() {
        return attempts > 1
          ? {
              issue: {
                issueId: "issue-1",
                updatedAt: "2026-07-16T00:00:01Z",
                state: "In Progress",
              },
            }
          : undefined;
      },
    },
    { sleep: async () => undefined, maxAttempts: 3, baseDelayMs: 10 },
  );

  const result = await handler.mutate({
    kind: "update_issue_state",
    project: project(),
    precondition: {
      expectedIssueId: "issue-1",
      expectedUpdatedAt: "2026-07-16T00:00:00Z",
      expectedState: "Todo",
    },
    state: "In Progress",
  });

  assert.equal(result.kind, "applied");
  assert.equal(attempts, 2);
  assert.equal(projectReads, 2);
});

test("ambiguous mutation reads back again after backoff before stale preconditions", async () => {
  let mutationAttempts = 0;
  let outcomeReads = 0;
  let remoteApplied = false;
  const handler = new LinearGatewayProtocolHandlerImpl(
    {
      async readProjectResolution() {
        return {
          kind: "resolved",
          projectId: "project-1",
          updatedAt: "2026-07-16T00:00:00Z",
        };
      },
      async readMutationTarget() {
        return remoteApplied
          ? {
              issueId: "issue-1",
              updatedAt: "2026-07-16T00:00:01Z",
              state: "In Progress",
            }
          : {
              issueId: "issue-1",
              updatedAt: "2026-07-16T00:00:00Z",
              state: "Todo",
            };
      },
      async executeMutation() {
        mutationAttempts += 1;
        const error = new Error("delayed Linear response");
        error.retryable = true;
        error.ambiguous = true;
        throw error;
      },
      async readMutationOutcome() {
        outcomeReads += 1;
        return remoteApplied
          ? {
              issue: {
                issueId: "issue-1",
                updatedAt: "2026-07-16T00:00:01Z",
                state: "In Progress",
              },
            }
          : undefined;
      },
    },
    {
      sleep: async () => {
        remoteApplied = true;
      },
      maxAttempts: 3,
      baseDelayMs: 10,
    },
  );

  const result = await handler.mutate({
    kind: "update_issue_state",
    project: project(),
    precondition: {
      expectedIssueId: "issue-1",
      expectedUpdatedAt: "2026-07-16T00:00:00Z",
      expectedState: "Todo",
    },
    state: "In Progress",
  });

  assert.equal(result.kind, "already_applied");
  assert.equal(mutationAttempts, 1);
  assert.equal(outcomeReads, 2);
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
      async readMutationTarget() { throw new Error("legacy path should not be used"); },
      async executeMutation() { throw new Error("legacy path should not be used"); },
      async readMutationOutcome() { throw new Error("legacy path should not be used"); },
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
      async readMutationTarget() { throw new Error("legacy path should not be used"); },
      async executeMutation() { throw new Error("legacy path should not be used"); },
      async readMutationOutcome() { throw new Error("legacy path should not be used"); },
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
      async readMutationTarget() { throw new Error("legacy path should not be used"); },
      async executeMutation() { throw new Error("legacy path should not be used"); },
      async readMutationOutcome() { throw new Error("legacy path should not be used"); },
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
    comments: [{ commentId: "comment-1", issueId: "root-1", body: "status", remoteVersion: "2026-07-16T00:00:01Z", updatedAt: "2026-07-16T00:00:01Z" }],
    relations: [{ relationId: "relation-1", relationKind: "blocks", sourceIssueId: "work-1", targetIssueId: "root-1" }],
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
