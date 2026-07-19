import assert from "node:assert/strict";
import test from "node:test";

import { PodiumConductorServicesImpl } from "../dist/internal/composition/PodiumConductorServicesImpl.js";
import { LinearGatewayProtocolHandlerImpl } from "../dist/internal/linear-gateway/LinearGatewayProtocolHandlerImpl.js";

function project() {
  return {
    conductorShortHash: "abc123",
    expectedProjectId: "project-1",
    expectedProjectUpdatedAt: "2026-07-16T00:00:00Z",
  };
}

async function createConductorServices(linearSdk) {
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
      getLinearCredential: () => ({}),
      saveRuntimeObservation() {},
    },
    {
      now: () => "2026-07-16T00:00:00Z",
      sleep: async () => undefined,
      createLinearSdk: () => linearSdk,
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
              }],
              pageInfo: { hasNextPage: false },
            }
          : {
              items: [{
                issue: issue("root-1", "project-1"),
                isDelegatedToSymphony: true,
                priority: "urgent",
                blockers: [],
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
          }],
          pageInfo: { hasNextPage: false },
        };
      },
    },
    { sleep: async () => undefined, maxAttempts: 1, baseDelayMs: 10 },
  );
  await assert.rejects(invalid.listAllRootIssues("project-1"), /linear_project_mismatch/);
});

test("Root scheduling gateway maps every SDK page without making eligibility decisions", async () => {
  const services = await createConductorServices({
    async listRootIssues({ cursor }) {
      return cursor
        ? {
            items: [{
              issue: issue("root-2", "project-1"),
              isDelegatedToSymphony: false,
              priority: "low",
              blockers: [],
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
            }],
            pageInfo: { hasNextPage: true, endCursor: "next" },
          };
    },
  });

  const result = await services.handle({
    kind: "list_root_issues",
    project_id: "project-1",
    page: { limit: 250 },
  });

  assert.deepEqual(result, {
    kind: "root_issues_page",
    items: [
      {
        issue: {
          issue_id: "root-1",
          identifier: "ROOT-1",
          project_id: "project-1",
          state: "Todo",
          order: 12.5,
          depth: 0,
          title: "Title",
          description: "",
          updated_at: "2026-07-16T00:00:00Z",
        },
        is_delegated_to_symphony: true,
        priority: "urgent",
        blockers: [
          {
            source_issue_id: "root-1",
            target_issue_id: "blocker-done",
            target_state: "Done",
          },
          {
            source_issue_id: "root-1",
            target_issue_id: "blocker-active",
            target_state: "In Progress",
          },
        ],
      },
      {
        issue: {
          issue_id: "root-2",
          identifier: "ROOT-2",
          project_id: "project-1",
          state: "Todo",
          order: 1,
          depth: 0,
          title: "Title",
          description: "",
          updated_at: "2026-07-16T00:00:00Z",
        },
        is_delegated_to_symphony: false,
        priority: "low",
        blockers: [],
      },
    ],
    page_info: { has_next_page: false },
  });
});

test("Root scheduling gateway rejects malformed closed values", async () => {
  const valid = {
    issue: issue("root-1", "project-1"),
    isDelegatedToSymphony: true,
    priority: "normal",
    blockers: [],
  };
  const invalidRoots = [
    { ...valid, priority: undefined },
    { ...valid, blockers: undefined },
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
              rootManagedComments: [],
              humanAnswers: [],
              observedAt: "2026-07-16T00:00:01Z",
              pageInfo: { hasNextPage: false },
            }
          : {
              nodes: [issue("root-1", "project-1")],
              rootPhaseLabels: ["planning"],
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

  assert.equal(result.kind, "failed");
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
    body: "Symphony Root Run\n<!-- symphony root marker -->",
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
    body: "Symphony Root Run\n<!-- symphony root marker -->",
  });

  assert.equal(result.kind, "already_applied");
  assert.equal(attempts, 1);
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
