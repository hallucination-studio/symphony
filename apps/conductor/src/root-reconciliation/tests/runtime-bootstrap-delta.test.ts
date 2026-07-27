import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import {
  type RootDirective,
  type RootConvergencePolicyInterface,
  type RootReconcilerFailure,
  type UserCommentReply,
} from "../api/index.js";
import { LinearRootSafetyPolicyImpl } from "../internal/LinearRootSafetyPolicyImpl.js";
import { rootInputId } from "../internal/RootInputIdentity.js";
import {
  RootReconciliationRuntime,
  type RootReconciliationRuntimeDependencies,
  validateConvergenceDirective,
  validateDirectiveInputs,
} from "../internal/RootReconciliationRuntime.js";

test("Root runtime consumes every Index page before scheduling and reads only the selected candidate Tree", async () => {
  const scheduledRoots: string[][] = [];
  const treeReads: string[] = [];
  const root = (issueId: string, priority: "normal" | "high") => ({
    issueId,
    identifier: issueId === "root-high" ? "SYM-2" : "SYM-1",
    state: "Todo" as const,
    updatedAt: "2026-07-27T00:00:00.000Z",
    projectId: "project-1",
    priority,
    blockers: [],
    rootConductorLabels: [{ conductorShortHash: "abc123" }],
    isDelegatedToSymphony: true,
    isArchived: false,
  });
  const runtime = new RootReconciliationRuntime({
    conductorId: "conductor-1",
    conductorShortHash: "abc123",
    repositoryIdentity: "repository-1",
    baseBranch: "main",
    linear: {
      async resolveProject() {
        return { kind: "resolved" as const, projectId: "project-1", conductorPool: [{ conductorShortHash: "abc123" }] };
      },
      async readProjectRootIndexPage({ cursor }) {
        if (!cursor) {
          return {
            kind: "page" as const,
            page: { roots: [root("root-normal", "normal")], hasNextPage: true, endCursor: "page-2" },
          };
        }
        assert.equal(cursor, "page-2");
        return { kind: "page" as const, page: { roots: [root("root-high", "high")], hasNextPage: false } };
      },
      async readWorkflowIssueTree(rootIssueId) {
        treeReads.push(rootIssueId);
        throw new Error("tree_read_failed");
      },
      async mutateWorkflow() { return { kind: "failed" as const, code: "unused", summary: "unused" }; },
    },
    scheduling: {
      evaluate(roots) {
        scheduledRoots.push(roots.map(({ issueId }) => issueId));
        return { orderedEligible: [roots.find(({ issueId }) => issueId === "root-high")!], blocked: [] };
      },
    },
    profileIdFor: async () => "profile-1",
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log() {},
    git: {} as never,
    safety: {} as never,
    convergence: {} as never,
    reconciler: {} as never,
    performer: {} as never,
    materializer: {} as never,
    replyWriter: {} as never,
  } satisfies RootReconciliationRuntimeDependencies);

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.deepEqual(scheduledRoots, [["root-normal", "root-high"]]);
  assert.deepEqual(treeReads, ["root-high"]);
});

test("Root runtime contains a transient Index failure inside the Binding cycle", async () => {
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  const runtime = new RootReconciliationRuntime({
    conductorId: "conductor-1",
    conductorShortHash: "abc123",
    repositoryIdentity: "repository-1",
    baseBranch: "main",
    linear: {
      async resolveProject() {
        return { kind: "resolved" as const, projectId: "project-1", conductorPool: [{ conductorShortHash: "abc123" }] };
      },
      async readProjectRootIndexPage() {
        return {
          kind: "failed" as const,
          failure: { code: "linear_rate_limited", category: "linear", retryable: true },
        };
      },
      async readWorkflowIssueTree() { throw new Error("tree_should_not_be_read"); },
      async mutateWorkflow() { return { kind: "failed" as const, code: "unused", summary: "unused" }; },
    },
    log(event, fields) { logs.push({ event, fields }); },
    git: {} as never,
    scheduling: {} as never,
    safety: {} as never,
    convergence: {} as never,
    reconciler: {} as never,
    performer: {} as never,
    materializer: {} as never,
    replyWriter: {} as never,
    profileIdFor: async () => undefined,
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
  } satisfies RootReconciliationRuntimeDependencies);

  assert.equal(await runtime.cycle(), "discovery-degraded");
  assert.deepEqual(logs, [{
    event: "root_discovery_degraded",
    fields: {
      phase: "root_index",
      failure_code: "linear_rate_limited",
      category: "linear",
      retryable: "true",
    },
  }]);
});

test("Root worktree gate derives required revisions only from native Verify attachments", async () => {
  const tree = workflowTree();
  tree.status_catalog.push(
    { status_id: "succeeded", name: "Succeeded", category: "completed", position: 2 },
    { status_id: "done", name: "Done", category: "completed", position: 3 },
  );
  tree.issues.push(
    {
      issue_id: "cycle-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1",
      status_id: "succeeded", status_name: "Succeeded", status_category: "completed", status_position: 2,
      order: 1, depth: 1, title: "Cycle", description: "Completed cycle", labels: ["Cycle"], is_archived: false,
      issue_kind: "cycle", remote_version: "cycle-v1", created_at: tree.observed_at, updated_at: tree.observed_at,
    },
    {
      issue_id: "verify-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1",
      status_id: "done", status_name: "Done", status_category: "completed", status_position: 3,
      order: 1, depth: 2, title: "Verify", description: "Passed", labels: ["Verify", "Passed"], is_archived: false,
      issue_kind: "verify", remote_version: "verify-v1", created_at: tree.observed_at, updated_at: tree.observed_at,
    },
  );
  tree.attachments.push({
    attachment_id: "attachment-1", issue_id: "verify-1", title: "Verified Git revision",
    url: "https://github.com/acme/repo/commit/head-1", source_type: "github", remote_version: "attachment-v1",
    created_at: tree.observed_at, updated_at: tree.observed_at,
  });
  const dependencies = failureDependencies({ tree, logs: [], onOpen: failureFor });
  let requiredRevisions: string[] | undefined;
  dependencies.git.inspectRootWorktreeGate = async (input) => {
    requiredRevisions = input.requiredRevisions;
    return validWorktreeGateInspection();
  };

  await new RootReconciliationRuntime(dependencies).cycle();
  assert.deepEqual(requiredRevisions, ["head-1"]);
});

test("Root runtime exposes the configured native convergence deadline to the wake scheduler", async () => {
  const dependencies = failureDependencies({
    tree: workflowTree(),
    logs: [],
    onOpen(input) { return failureFor(input); },
  });
  dependencies.convergence = {
    assess() {
      const assessed = allowingConvergence().assess({} as never);
      assessed.snapshot.policy.deadlineAt = "2099-07-27T00:01:00.000Z";
      return assessed;
    },
  };
  const runtime = new RootReconciliationRuntime(dependencies);

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(runtime.nextWakeAt(), Date.parse("2099-07-27T00:01:00.000Z"));
});

test("Root runtime fails closed for a non-retryable Index failure without escaping its cycle", async () => {
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  const runtime = new RootReconciliationRuntime({
    conductorId: "conductor-1",
    conductorShortHash: "abc123",
    repositoryIdentity: "repository-1",
    baseBranch: "main",
    linear: {
      async resolveProject() {
        return { kind: "resolved" as const, projectId: "project-1", conductorPool: [{ conductorShortHash: "abc123" }] };
      },
      async readProjectRootIndexPage() {
        return {
          kind: "failed" as const,
          failure: { code: "linear_root_header_invalid", category: "schema", retryable: false },
        };
      },
      async readWorkflowIssueTree() { throw new Error("tree_should_not_be_read"); },
      async mutateWorkflow() { return { kind: "failed" as const, code: "unused", summary: "unused" }; },
    },
    log(event, fields) { logs.push({ event, fields }); },
    git: {} as never,
    scheduling: {} as never,
    safety: {} as never,
    convergence: {} as never,
    reconciler: {} as never,
    performer: {} as never,
    materializer: {} as never,
    replyWriter: {} as never,
    profileIdFor: async () => undefined,
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
  } satisfies RootReconciliationRuntimeDependencies);

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(logs[0]?.event, "root_discovery_blocked");
  assert.equal(logs[0]?.fields.failure_code, "linear_root_header_invalid");
});

test("Root runtime opens with bootstrap and advances with only a delta", async () => {
  const root = {
    issueId: "root-1", identifier: "SYM-1", state: "Todo" as const, title: "Root",
    description: "Build it", updatedAt: "2026-07-23T00:00:00Z", projectId: "project-1",
    parentIssueId: null, priority: "normal" as const, order: 0,
    blockers: [], rootConductorLabels: [], isDelegatedToSymphony: true, isArchived: false,
  };
  const tree = workflowTree();
  let opens = 0;
  let advances = 0;
  const dependencies = {
    conductorId: "conductor-1", conductorShortHash: "abc123", repositoryIdentity: "repository-1", baseBranch: "main",
    linear: {
      async resolveProject() { return { kind: "resolved" as const, projectId: "project-1", conductorPool: [] }; },
      async readProjectRootIndexPage() {
        return { kind: "page" as const, page: { roots: [root], hasNextPage: false } };
      },
      async readWorkflowIssueTree() { return tree; },
      async mutateWorkflow() { return { kind: "failed" as const, code: "unused", summary: "unused" }; },
    },
    git: {
      async inspectRootWorktreeGate() { return validWorktreeGateInspection(); },
      async readCommitUrl() { return "https://github.com/acme/repo/commit/head-1"; },
      async materializeRootWorkspace() { throw new Error("workspace_materialization_unexpected"); },
    },
    scheduling: { evaluate() { return { orderedEligible: [root], blocked: [] }; } },
    safety: new LinearRootSafetyPolicyImpl(),
    convergence: allowingConvergence(),
    reconciler: {
      async open(input: Parameters<RootReconciliationRuntimeDependencies["reconciler"]["open"]>[0]) {
        opens += 1;
        assert.ok(input.bootstrap.rootSnapshot);
        return {
          kind: "opened" as const,
          sessionId: `session-${opens}`,
          bootstrapRootDigest: input.bootstrap.rootDigest,
          initialResult: { kind: "directive" as const, directive: humanActionDirective(input.bootstrap.rootDigest, input.bootstrap.pendingInputIds) },
        };
      },
      async advance(input: Parameters<RootReconciliationRuntimeDependencies["reconciler"]["advance"]>[0]) {
        advances += 1;
        assert.equal("rootSnapshot" in input.delta, false);
        assert.equal(input.delta.changes[0]?.kind, "issue_current_value");
        return { kind: "directive" as const, directive: humanActionDirective(input.delta.targetRootDigest, input.delta.pendingInputIds) };
      },
      async close() {},
    },
    performer: {} as never,
    materializer: { async materialize() { return { kind: "materialized" as const, rootDirectiveId: "directive-1", sourceIssueIds: [] }; } },
    replyWriter: { async write() { return { kind: "materialized" as const, replyId: "reply-1" }; } },
    profileIdFor: async () => "profile-1",
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log() {},
  } satisfies RootReconciliationRuntimeDependencies;

  const runtime = new RootReconciliationRuntime(dependencies);
  assert.equal(await runtime.cycle(), "waiting-human");
  tree.issues[0]!.description = "Changed by the user";
  tree.issues[0]!.remote_version = "root-v2";
  assert.equal(await runtime.cycle(), "waiting-human");
  assert.equal(opens, 1);
  assert.equal(advances, 1);
});

test("Root runtime sends a fresh missing worktree gate to the Reconciler without materializing a workspace", async () => {
  const tree = workflowTree();
  let gateReads = 0;
  let materializations = 0;
  let opens = 0;
  const dependencies = failureDependencies({
    tree,
    logs: [],
    onOpen(input) {
      opens += 1;
      assert.deepEqual(input.bootstrap.rootSnapshot.worktreeGate, {
        kind: "fresh_missing",
        repositoryIdentity: "repository-1",
        baseBranch: "main",
        baseRevision: "base-1",
      });
      return failureFor(input);
    },
  });
  dependencies.git = {
    async readCommitUrl() { return "https://github.com/acme/repo/commit/head-1"; },
    async inspectRootWorktreeGate() {
      gateReads += 1;
      return {
        result: {
          kind: "fresh_missing" as const,
          repositoryIdentity: "repository-1",
          baseBranch: "main",
          baseRevision: "base-1",
        },
      };
    },
    async materializeRootWorkspace() {
      materializations += 1;
      throw new Error("workspace_materialization_unexpected");
    },
  };

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "needs-attention");
  assert.equal(gateReads, 1);
  assert.equal(materializations, 0);
  assert.equal(opens, 1);
});

test("Root runtime sends an invalid execution generation to the Reconciler and materializes its closed action", async () => {
  const tree = workflowTree();
  tree.issues.push({
    issue_id: "cycle-1", identifier: "SYM-2", project_id: "project-1", status_id: "todo", status_name: "Todo",
    status_category: "unstarted", status_position: 1, order: 0, depth: 1, title: "Cycle",
    description: "Execute the approved objective.", labels: [], is_archived: false, issue_kind: "cycle",
    parent_issue_id: "root-1", remote_version: "cycle-v1", created_at: "2026-07-23T00:00:00Z",
    updated_at: "2026-07-23T00:00:00Z",
  });
  const expectedGate = {
    kind: "execution_generation_invalid" as const,
    repositoryIdentity: "repository-1",
    expectedBranch: "symphony/runs/sym-1",
    reason: "branch_missing" as const,
  };
  let materializedAction: RootDirective["action"] | undefined;
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  const dependencies = failureDependencies({ tree, logs, onOpen: failureFor });
  dependencies.git = {
    async inspectRootWorktreeGate() { return { result: expectedGate }; },
    async readCommitUrl() { return "https://github.com/acme/repo/commit/head-1"; },
    async materializeRootWorkspace() { throw new Error("workspace_materialization_unexpected"); },
  };
  dependencies.reconciler = {
    async open(input) {
      assert.deepEqual(input.bootstrap.rootSnapshot.worktreeGate, expectedGate);
      return {
        kind: "opened" as const,
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: {
          kind: "directive" as const,
          directive: {
            ...directive(input.bootstrap.rootDigest, input.bootstrap.pendingInputIds),
            reconcilerSessionId: input.reconcilerSessionId,
            reconcilerTurnId: input.reconcilerTurnId,
            modelTurn: {
              ...rootModelTurn(),
              reconcilerSessionId: input.reconcilerSessionId,
              reconcilerTurnId: input.reconcilerTurnId,
            },
            action: {
              kind: "invalidate_execution_generation" as const,
              rootIssueId: "root-1",
              cycleIssueId: "cycle-1",
              expectedRootRemoteVersion: "root-v1",
              expectedWorktreeGate: expectedGate,
            },
          },
        },
      };
    },
    async advance() { throw new Error("advance_unexpected"); },
    async close() { throw new Error("close_unexpected"); },
  };
  dependencies.materializer = {
    async materialize({ directive: candidate }) {
      materializedAction = candidate.action;
      return { kind: "materialized", rootDirectiveId: candidate.rootDirectiveId, sourceIssueIds: ["cycle-1"] };
    },
  };
  dependencies.replyWriter = { async write() { throw new Error("reply_writer_unexpected"); } };

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "progress", JSON.stringify(logs));
  assert.deepEqual(materializedAction, {
    kind: "invalidate_execution_generation",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    expectedRootRemoteVersion: "root-v1",
    expectedWorktreeGate: expectedGate,
  });
});

test("Root runtime passes a non-allowing transient convergence snapshot to the Reconciler", async () => {
  const tree = workflowTree();
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  let opens = 0;
  const dependencies = failureDependencies({
    tree,
    logs,
    onOpen(input) {
      opens += 1;
      assert.equal(input.bootstrap.rootSnapshot.root.convergence.view.activeCycleRepairAttempts, 1);
      return failureFor(input);
    },
  });
  dependencies.convergence = repairLimitConvergence();

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "needs-attention");
  assert.equal(opens, 1);
});

test("convergence gates leave business choice to the Reconciler within their closed bounds", () => {
  const rootLevel = rootLevelConvergence();
  const repairLimit = repairLimitConvergence();

  assert.equal(
    validateConvergenceDirective({
      ...directive("tree-v1"),
      action: {
        kind: "execute_plan", cycleIssueId: "cycle-1", planIssueId: "plan-1", planGoal: "Plan",
        requiredOutputs: [], priorPlanResultIds: [], humanResolutionIds: [],
      },
    }, rootLevel.assess({} as never)),
    "root_convergence_max_cycles_per_root_execute_plan_blocked",
  );
  assert.equal(
    validateConvergenceDirective({
      ...directive("tree-v1"),
      action: {
        kind: "create_cycle", predecessorCycleIssueId: "cycle-1", reason: "exhausted", planTrigger: "retry",
        inheritedFactRefs: [], invalidatedDeliveryRefs: [],
      },
    }, rootLevel.assess({} as never)),
    "root_convergence_max_cycles_per_root_create_cycle_blocked",
  );
  assert.equal(
    validateConvergenceDirective({
      ...directive("tree-v1"),
      action: {
        kind: "conclude_cycle", cycleIssueId: "cycle-1", conclusion: "repair_required", completedWorkIds: [],
        unresolvedFindingIds: [], attemptedApproachRefs: [], verificationEvidenceRefs: [],
      },
    }, repairLimit.assess({} as never)),
    "root_convergence_max_cycle_repair_attempts_requires_exhausted_cycle",
  );
  assert.equal(
    validateConvergenceDirective({
      ...directive("tree-v1"),
      action: {
        kind: "conclude_cycle", cycleIssueId: "cycle-1", conclusion: "exhausted", completedWorkIds: [],
        unresolvedFindingIds: [], attemptedApproachRefs: [], verificationEvidenceRefs: [],
      },
    }, repairLimit.assess({} as never)),
    undefined,
  );
});

test("Root runtime reports each fresh Reconciler failure without writing machine state to Linear", async () => {
  const tree = workflowTree();
  const commentsBefore = structuredClone(tree.comments);
  let opens = 0;
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  const dependencies = failureDependencies({ tree, onOpen: (input) => {
    opens += 1;
    return failureFor(input);
  }, logs });

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "needs-attention");
  assert.equal(opens, 1);
  assert.deepEqual(tree.comments, commentsBefore);
  assert.equal(logs.at(-1)?.event, "root_reconciler_failed");

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "needs-attention");
  assert.equal(opens, 2);
  assert.deepEqual(tree.comments, commentsBefore);
});

test("native thread-state inputs require their matching reply without relying on a legacy comment version", () => {
  const source = workflowComment({
    commentId: "comment-1",
    authorKind: "symphony",
    authorId: "symphony-bot",
    body: "Symphony processed this native thread state.",
    threadState: "resolved",
  });
  const sourceInputId = rootInputId(
    `comment_thread_state:${source.comment_id}:${source.thread_root_comment_id}:${source.thread_state}`,
    source.remote_version,
  );
  const candidate: UserCommentReply = {
    replyId: "reply-state-1",
    sourceInputId,
    source: {
      kind: "comment_thread_state",
      commentId: source.comment_id,
      commentRemoteVersion: source.remote_version,
      threadRootCommentId: source.thread_root_comment_id,
      threadState: source.thread_state,
    },
    acknowledgement: "We received the thread update.",
    interpretedRequest: "The thread is resolved.",
    decidedAction: "The thread needs to stay open.",
    nextStep: "Provide more information.",
    disposition: "follow_up_required",
    reaction: "none",
    threadAction: "reopen",
  };
  const tree = workflowTree();
  tree.comments = [source];

  assert.equal(
    validateDirectiveInputs(
      directive("tree-v1", [sourceInputId], [candidate]),
      tree,
      [sourceInputId],
    ),
    undefined,
  );
});

test("comment body inputs use the canonical hashed identity in directive validation", () => {
  const source = workflowComment({
    commentId: "comment-1",
    authorKind: "human",
    authorId: "user-1",
    authorUserId: "user-1",
    body: "Please rerun this check.",
  });
  const candidate = commentBodyReply(source);
  const tree = workflowTree();
  tree.comments = [source];

  assert.equal(
    validateDirectiveInputs(
      directive("tree-v1", [candidate.sourceInputId], [candidate]),
      tree,
      [candidate.sourceInputId],
    ),
    undefined,
  );
});

function directive(
  digest: string,
  consumedInputIds: string[] = [],
  commentReplies: UserCommentReply[] = [],
): RootDirective {
  return {
    protocolVersion: 1, requestId: "request-1", rootDirectiveId: "directive-1",
    reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", modelTurn: rootModelTurn(), basedOnTargetRootDigest: digest,
    rationale: "Wait for the next fact.", evidenceRefs: [], consumedInputIds, commentReplies,
    action: { kind: "wait", reasonCode: "test", blockingFactRefs: [{ referenceId: "root-1", sourceKind: "linear_issue" }] },
  };
}

function humanActionDirective(digest: string, consumedInputIds: string[]): RootDirective {
  return {
    ...directive(digest, consumedInputIds),
    action: {
      kind: "create_human_action",
      rootIssueId: "root-1",
      actionKind: "information",
      targetIssueIds: ["root-1"],
      expectedRootRemoteVersion: "root-v1",
      question: "Which deployment target should Symphony use?",
      context: "The current Root facts do not identify one.",
      options: [],
      evidenceRefs: [{ referenceId: "root-1", sourceKind: "linear_issue" }],
    },
  };
}

function validWorktreeGateInspection() {
  const workspace = { branch: "symphony/runs/sym-1", worktreePath: "/tmp/symphony-root-1" };
  const snapshot = {
    head: "head-1",
    branch: workspace.branch,
    status: { items: [], returned: 0, cap: 32, has_more: false, partial: false },
  };
  return {
    result: {
      kind: "valid" as const,
      repositoryIdentity: "repository-1",
      branch: workspace.branch,
      headRevision: snapshot.head,
      isClean: true,
      changedPaths: [],
    },
    workspace,
    snapshot,
  };
}

function failureDependencies(input: {
  tree: LinearWorkflowTreeSnapshot;
  onOpen(input: Parameters<RootReconciliationRuntimeDependencies["reconciler"]["open"]>[0]): RootReconcilerFailure;
  logs: Array<{ event: string; fields: Record<string, string> }>;
}): RootReconciliationRuntimeDependencies {
  const root = {
    issueId: "root-1", identifier: "SYM-1", state: "Todo" as const, title: "Root",
    description: "Build it", updatedAt: "2026-07-23T00:00:00Z", projectId: "project-1",
    parentIssueId: null, priority: "normal" as const, order: 0,
    blockers: [], rootConductorLabels: [], isDelegatedToSymphony: true, isArchived: false,
  };
  return {
    conductorId: "conductor-1", conductorShortHash: "abc123", repositoryIdentity: "repository-1", baseBranch: "main",
    linear: {
      async resolveProject() { return { kind: "resolved" as const, projectId: "project-1", conductorPool: [] }; },
      async readProjectRootIndexPage() {
        return { kind: "page" as const, page: { roots: [root], hasNextPage: false } };
      },
      async readWorkflowIssueTree() { return input.tree; },
      async mutateWorkflow() { return { kind: "failed" as const, code: "unused", summary: "unused" }; },
    },
    git: {
      async inspectRootWorktreeGate() { return validWorktreeGateInspection(); },
      async readCommitUrl() { return "https://github.com/acme/repo/commit/head-1"; },
      async materializeRootWorkspace() { throw new Error("workspace_materialization_unexpected"); },
    },
    scheduling: { evaluate() { return { orderedEligible: [root], blocked: [] }; } },
    safety: new LinearRootSafetyPolicyImpl(),
    convergence: allowingConvergence(),
    reconciler: {
      async open(openInput) {
        return {
          kind: "opened" as const,
          sessionId: openInput.reconcilerSessionId,
          bootstrapRootDigest: openInput.bootstrap.rootDigest,
          initialResult: { kind: "failed" as const, failure: input.onOpen(openInput) },
        };
      },
      async advance() { throw new Error("advance_unexpected"); },
      async close() { throw new Error("close_unexpected"); },
    },
    performer: {} as never,
    materializer: { async materialize() { throw new Error("materializer_unexpected"); } },
    replyWriter: { async write() { throw new Error("reply_writer_unexpected"); } },
    profileIdFor: async () => "profile-1",
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log(event, fields) { input.logs.push({ event, fields }); },
  };
}

function failureFor(input: Parameters<RootReconciliationRuntimeDependencies["reconciler"]["open"]>[0]): RootReconcilerFailure {
  return {
    failureId: `root-1:${input.reconcilerTurnId}:failure`,
    reconcilerSessionId: input.reconcilerSessionId,
    reconcilerTurnId: input.reconcilerTurnId,
    targetRootDigest: input.bootstrap.rootDigest,
    attemptedInputIds: input.bootstrap.pendingInputIds,
    modelTurn: {
      turnRecordId: `root-1:${input.reconcilerTurnId}`,
      role: "root_reconciler",
      rootIssueId: "root-1",
      reconcilerSessionId: input.reconcilerSessionId,
      reconcilerTurnId: input.reconcilerTurnId,
      invocationState: "confirmed",
      model: "gpt",
      outcome: "schema_invalid",
      usage: { status: "unavailable", reason: "provider_omitted" },
      terminalAt: "2026-07-23T00:00:01Z",
    },
    category: "schema_invalid",
    sanitizedReason: "The Root Reconciler output was invalid.",
    failedAt: "2026-07-23T00:00:01Z",
  };
}

function rootModelTurn(): RootDirective["modelTurn"] {
  return {
    turnRecordId: "root-1:turn-1", role: "root_reconciler", rootIssueId: "root-1",
    reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", invocationState: "confirmed",
    model: "gpt", outcome: "directive_accepted", usage: { status: "unavailable", reason: "provider_omitted" },
    terminalAt: "2026-07-23T00:00:00Z",
  };
}

function allowingConvergence(): RootConvergencePolicyInterface {
  return {
    assess() {
      return {
        trigger: "none",
        snapshot: {
          policy: {
            maxCyclesPerRoot: 3,
            maxSameOpenFindingCycles: 2,
            maxConsecutiveNoProgress: 2,
            maxCycleRepairAttempts: 0,
            deadlineAt: "2026-07-26T00:00:00.000Z",
          },
          view: {
            cycleCount: 0,
            openFindingPersistence: [],
            consecutiveNoProgress: 0,
            activeCycleRepairAttempts: 0,
            isDeadlineExceeded: false,
            rootIsCanceled: false,
          },
        },
      };
    },
  };
}

function repairLimitConvergence(): RootConvergencePolicyInterface {
  const policy = {
    maxCyclesPerRoot: 3,
    maxSameOpenFindingCycles: 2,
    maxConsecutiveNoProgress: 2,
    maxCycleRepairAttempts: 0,
    deadlineAt: "2026-07-26T00:00:00.000Z",
  };
  const view = {
    cycleCount: 1,
    openFindingPersistence: [],
    consecutiveNoProgress: 0,
    activeCycleIssueId: "cycle-1",
    activeCycleRepairAttempts: 1,
    isDeadlineExceeded: false,
    rootIsCanceled: false,
  };
  return {
    assess() {
      return {
        trigger: "max_cycle_repair_attempts" as const,
        snapshot: { policy, view },
      };
    },
  };
}

function rootLevelConvergence(): RootConvergencePolicyInterface {
  return {
    assess() {
      return {
        trigger: "max_cycles_per_root" as const,
        snapshot: {
          policy: {
            maxCyclesPerRoot: 1,
            maxSameOpenFindingCycles: 2,
            maxConsecutiveNoProgress: 2,
            maxCycleRepairAttempts: 0,
            deadlineAt: "2026-07-26T00:00:00.000Z",
          },
          view: {
            cycleCount: 1,
            openFindingPersistence: [],
            consecutiveNoProgress: 0,
            activeCycleRepairAttempts: 0,
            isDeadlineExceeded: false,
            rootIsCanceled: false,
          },
        },
      };
    },
  };
}

function workflowTree(): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "todo", name: "Todo", category: "unstarted" as const, position: 1 }],
    issues: [{
      issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "todo", status_name: "Todo",
      status_category: "unstarted" as const, status_position: 1, order: 0, depth: 0, title: "Root",
      description: "Build it", labels: [], is_archived: false, issue_kind: "root" as const,
      remote_version: "root-v1", created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
    }],
    comments: [workflowComment({
      commentId: "ownership-comment",
      authorKind: "symphony",
      authorId: "symphony-bot",
      body: "Symphony is observing this Root.",
    })],
    relations: [], attachments: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-23T00:00:00Z",
  };
}

function commentBodyReply(source: LinearWorkflowTreeSnapshot["comments"][number]): UserCommentReply {
  const commentBodyDigest = createHash("sha256").update(source.body, "utf8").digest("hex");
  const sourceInputId = rootInputId(`comment_body:${source.comment_id}`, commentBodyDigest);
  return {
    replyId: "reply-body-1",
    sourceInputId,
    source: { kind: "comment_body", commentId: source.comment_id, commentBodyDigest },
    acknowledgement: "We received your request.",
    interpretedRequest: "Rerun the check.",
    decidedAction: "The check will be rerun.",
    nextStep: "Wait for the result.",
    disposition: "accepted",
    reaction: "check",
    threadAction: "resolve",
  };
}

function workflowComment(input: {
  commentId: string;
  authorKind: "human" | "symphony";
  authorId: string;
  body: string;
  authorUserId?: string;
  parentCommentId?: string;
  threadRootCommentId?: string;
  threadState?: "resolved" | "unresolved";
}): LinearWorkflowTreeSnapshot["comments"][number] {
  return {
    comment_id: input.commentId,
    issue_id: "root-1",
    body: input.body,
    author_kind: input.authorKind,
    author_id: input.authorId,
    ...(input.authorUserId ? { author_user_id: input.authorUserId } : {}),
    ...(input.parentCommentId ? { parent_comment_id: input.parentCommentId } : {}),
    thread_root_comment_id: input.threadRootCommentId ?? input.commentId,
    thread_state: input.threadState ?? "unresolved",
    reactions: [],
    created_at: "2026-07-23T00:00:00Z",
    remote_version: `${input.commentId}-v1`,
    updated_at: "2026-07-23T00:00:00Z",
  };
}
