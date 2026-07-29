import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowMutationOutcome,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import {
  type RootDirective,
  type RootCommentDisposition,
  type RootConvergencePolicyInterface,
  type RootReconcilerFailure,
  type RootSemanticGateCommand,
  type RootReconcilerTurnResult,
  type UserCommentReply,
} from "../api/index.js";
import { LinearRootSafetyPolicyImpl } from "../internal/LinearRootSafetyPolicyImpl.js";
import { rootInputId } from "../internal/RootInputIdentity.js";
import { renderCanonicalPlanDescription } from "../internal/CanonicalPlanDescription.js";
import { immutableVerifyTargetTitle } from "../internal/VerifyTargetIdentity.js";
import { LinearHumanActionMaterializerImpl } from "../../human-actions/internal/LinearHumanActionMaterializerImpl.js";
import {
  RootReconciliationRuntime,
  type RootReconciliationRuntimeDependencies,
  validateConvergenceDirective,
  validateDirectiveInputs,
} from "../internal/RootReconciliationRuntime.js";

test("Root runtime consumes every Index page before scheduling and reads only the selected candidate Tree", async () => {
  const scheduledRoots: string[][] = [];
  const treeReads: string[] = [];
  const indexPageLimits: number[] = [];
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
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
      async readProjectRootIndexPage({ cursor, limit }) {
        indexPageLimits.push(limit);
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
    log(event, fields) { logs.push({ event, fields }); },
    git: {} as never,
    safety: {} as never,
    convergence: {} as never,
    reconciler: {} as never,
    performer: {} as never,
    delivery: {} as never,
    remoteAcceptance: {} as never,
    humanActions: { async materialize() { throw new Error("human_action_unexpected"); }, async convergeRootSummary() { return { kind: "not_applicable" }; } },
    replyWriter: {} as never,
  } satisfies RootReconciliationRuntimeDependencies);

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.deepEqual(indexPageLimits, [8, 8]);
  assert.deepEqual(scheduledRoots, [["root-normal", "root-high"]]);
  assert.deepEqual(treeReads, ["root-high"]);
  assert.deepEqual(logs.map(({ event }) => event), [
    "root_candidate_selected",
    "root_reconciliation_failed",
  ]);
  assert.deepEqual(logs[0], {
    event: "root_candidate_selected",
    fields: { root_issue_id: "root-high" },
  });
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
    delivery: {} as never,
    remoteAcceptance: {} as never,
    humanActions: { async materialize() { throw new Error("human_action_unexpected"); }, async convergeRootSummary() { return { kind: "not_applicable" }; } },
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

test("Root worktree gate derives required revisions only from active native Verify attachments", async () => {
  const tree = workflowTree();
  tree.status_catalog.push(
    { status_id: "succeeded", name: "Succeeded", category: "completed", position: 2 },
    { status_id: "done", name: "Done", category: "completed", position: 3 },
  );
  tree.issues.push(
    {
      issue_id: "cycle-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1",
      status_id: "succeeded", status_name: "Succeeded", status_category: "completed", status_position: 2,
      order: 1, depth: 1, title: "Cycle", description: "Completed cycle", labels: ["symphony:kind/cycle"], is_archived: false,
      issue_kind: "cycle", remote_version: "cycle-v1", created_at: tree.observed_at, updated_at: tree.observed_at,
    },
    {
      issue_id: "verify-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1",
      status_id: "done", status_name: "Done", status_category: "completed", status_position: 3,
      order: 1, depth: 2, title: "Verify", description: "Passed", labels: ["symphony:kind/verify", "Passed"], is_archived: false,
      issue_kind: "verify", remote_version: "verify-v1", created_at: tree.observed_at, updated_at: tree.observed_at,
    },
    {
      issue_id: "verify-archived", identifier: "SYM-4", project_id: "project-1", parent_issue_id: "cycle-1",
      status_id: "done", status_name: "Done", status_category: "completed", status_position: 3,
      order: 0, depth: 2, title: "Historical Verify", description: "Passed", labels: ["symphony:kind/verify", "Passed"], is_archived: true,
      issue_kind: "verify", remote_version: "verify-archived-v1", created_at: tree.observed_at, updated_at: tree.observed_at,
    },
  );
  tree.attachments.push(
    {
      attachment_id: "attachment-1", issue_id: "verify-1", title: immutableVerifyTargetTitle("head-1"),
      url: "https://github.com/acme/repo/commit/head-1", source_type: "github", remote_version: "attachment-v1",
      created_at: tree.observed_at, updated_at: tree.observed_at,
    },
    {
      attachment_id: "attachment-human", issue_id: "verify-1", title: immutableVerifyTargetTitle("human-head"),
      url: "https://github.com/acme/repo/commit/human-head", source_type: "github", remote_version: "attachment-human-v1",
      created_at: tree.observed_at, updated_at: tree.observed_at,
    },
    {
      attachment_id: "attachment-archived", issue_id: "verify-archived", title: immutableVerifyTargetTitle("historical-head"),
      url: "https://github.com/acme/repo/commit/historical-head", source_type: "github", remote_version: "attachment-archived-v1",
      created_at: tree.observed_at, updated_at: tree.observed_at,
    },
  );
  tree.source_manifest.push(
    {
      source_kind: "linear_attachment", source_id: "attachment-1", source_version: "attachment-v1", actor_kind: "symphony",
    },
    {
      source_kind: "linear_attachment", source_id: "attachment-human", source_version: "attachment-human-v1", actor_kind: "human",
    },
    {
      source_kind: "linear_attachment", source_id: "attachment-archived", source_version: "attachment-archived-v1", actor_kind: "symphony",
    },
  );
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
  const tree = workflowTree();
  const dependencies = failureDependencies({
    tree,
    logs: [],
    onOpen(input) { return failureFor(input); },
  });
  dependencies.convergence = {
    assess() {
      const assessed = allowingConvergence().assess({ root: { issueId: "root-1" } as never, tree });
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
    delivery: {} as never,
    remoteAcceptance: {} as never,
    humanActions: { async materialize() { throw new Error("human_action_unexpected"); }, async convergeRootSummary() { return { kind: "not_applicable" }; } },
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
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
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
          sessionId: input.reconcilerSessionId,
          bootstrapRootDigest: input.bootstrap.rootDigest,
          initialResult: semanticIntentResult(input, "request_information"),
        };
      },
      async advance(input: Parameters<RootReconciliationRuntimeDependencies["reconciler"]["advance"]>[0]) {
        advances += 1;
        assert.equal("rootSnapshot" in input.delta, false);
        assert.equal(input.delta.changes.some(({ kind }) => kind === "replacement"), true);
        return semanticIntentResult(input, "request_information");
      },
      async close() {},
    },
    performer: {} as never,
    delivery: {} as never,
    remoteAcceptance: {} as never,
    humanActions: {
      async materialize() {
        if (!tree.comments.some(({ comment_id }) => comment_id === "information-request-1")) {
          tree.comments.push(workflowComment({
            commentId: "information-request-1",
            authorKind: "symphony",
            authorId: "symphony-bot",
            body: "## 需要你补充信息\n\n请回复。",
          }));
        }
        return { kind: "materialized" as const, requestCommentId: "information-request-1" };
      },
      async convergeRootSummary() { return { kind: "not_applicable" as const }; },
    },
    replyWriter: { async write() { return { kind: "materialized" as const, replyId: "reply-1" }; } },
    profileIdFor: async () => "profile-1",
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log(event, fields) { logs.push({ event, fields }); },
  } satisfies RootReconciliationRuntimeDependencies;

  const runtime = new RootReconciliationRuntime(dependencies);
  assert.equal(await runtime.cycle(), "waiting-human", JSON.stringify(logs));
  tree.issues[0]!.description = "Changed by the user";
  tree.issues[0]!.remote_version = "root-v2";
  assert.equal(await runtime.cycle(), "waiting-human", JSON.stringify(logs));
  assert.equal(opens, 1);
  assert.equal(advances, 1);
});

test("Root runtime compiles an initial requirement intent into one native Root effect", async () => {
  const tree = workflowTree();
  tree.status_catalog.push({ status_id: "progress", name: "In Progress", category: "started", position: 2 });
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  const dependencies = failureDependencies({ tree, logs, onOpen: failureFor });
  let opens = 0;
  dependencies.reconciler = {
    async open(input) {
      opens += 1;
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: semanticIntentResult(input, "define_requirement"),
      };
    },
    async advance() { throw new Error("advance_unexpected"); },
    async close() { throw new Error("close_unexpected"); },
  };
  dependencies.linear.mutateWorkflow = async (command) => {
    if (command.kind !== "update_workflow_issue" || command.target.targetIssueId !== "root-1") {
      throw new Error("root_requirement_update_expected");
    }
    Object.assign(tree.issues[0]!, {
      status_id: command.statusId,
      status_name: "In Progress",
      status_category: "started",
      description: command.description,
      remote_version: "root-v2",
    });
    return { kind: "applied", readBack: { writeId: command.writeId, targetIssueId: "root-1", remoteVersion: "root-v2" } };
  };

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "progress", JSON.stringify(logs));
  assert.equal(opens, 1);
  assert.equal(tree.issues[0]!.status_name, "In Progress");
  assert.match(tree.issues[0]!.description, /# Objective[\s\S]*Build it[\s\S]*## Acceptance Criteria/u);
  assert.equal(logs.some(({ event }) => event === "root_requirement_intent_confirmed"), true);
});

test("Root runtime validates a delta directive against only the inputs attempted in that turn", async () => {
  const tree = workflowTree();
  const historicalComment = workflowComment({
    commentId: "historical-comment",
    authorKind: "human",
    authorId: "user-1",
    authorUserId: "user-1",
    body: "Please keep the existing deployment constraint.",
  });
  tree.comments.push(historicalComment);
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  const dependencies = failureDependencies({ tree, logs, onOpen: failureFor });
  let advances = 0;
  let deltaReply: UserCommentReply | undefined;
  dependencies.reconciler = {
    async open(input) {
      return {
        kind: "opened",
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: semanticIntentResult(input, "answer_comments", [commentDisposition(historicalComment)]),
      };
    },
    async advance(input) {
      advances += 1;
      const currentComment = tree.comments.find(({ comment_id }) => comment_id === "current-comment");
      assert.ok(currentComment);
      deltaReply = { ...commentBodyReply(currentComment), replyId: "reply-body-2" };
      assert.deepEqual(input.delta.pendingInputIds, [deltaReply.sourceInputId]);
      return semanticIntentResult(input, "answer_comments", [commentDisposition(currentComment)]);
    },
    async close() { throw new Error("close_unexpected"); },
  };
  dependencies.replyWriter = {
    async write({ disposition }) {
      resolveDispositionInTree(tree, disposition);
      return { kind: "materialized" };
    },
  };

  const runtime = new RootReconciliationRuntime(dependencies);
  assert.equal(await runtime.cycle(), "progress");
  tree.comments.push(workflowComment({
    commentId: "current-comment",
    authorKind: "human",
    authorId: "user-1",
    authorUserId: "user-1",
    body: "Also deploy this Root to staging.",
  }));

  assert.equal(await runtime.cycle(), "progress", JSON.stringify(logs));
  assert.equal(advances, 1);
  assert.ok(deltaReply);
  assert.equal(logs.some(({ event }) => event === "root_directive_materialization_failed"), false);
});

test("Root runtime materializes a fresh missing workspace mechanically without calling the Reconciler", async () => {
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
        generationOrdinal: 1,
        branch: "symphony/runs/sym-1",
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
          generationOrdinal: 1,
          branch: "symphony/runs/sym-1",
          baseBranch: "main",
          baseRevision: "base-1",
        },
      };
    },
    async materializeRootWorkspace(input) {
      materializations += 1;
      assert.deepEqual(input, {
        repositoryIdentity: "repository-1",
        rootIssueId: "root-1",
        rootIdentifier: "SYM-1",
        baseBranch: "main",
        generationOrdinal: 1,
        expectedGate: {
          kind: "fresh_missing",
          repositoryIdentity: "repository-1",
          generationOrdinal: 1,
          branch: "symphony/runs/sym-1",
          baseBranch: "main",
          baseRevision: "base-1",
        },
      });
      return validWorktreeGateInspection();
    },
  };

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "progress");
  assert.equal(gateReads, 1);
  assert.equal(materializations, 1);
  assert.equal(opens, 0);
});

test("Root runtime compiles an invalid execution generation recovery intent into one native Cycle effect", async () => {
  const tree = workflowTree();
  tree.status_catalog.push({ status_id: "progress", name: "In Progress", category: "started", position: 2 });
  tree.status_catalog.push({ status_id: "planning", name: "Planning", category: "started", position: 3 });
  tree.status_catalog.push({ status_id: "canceled", name: "Canceled", category: "canceled", position: 2 });
  Object.assign(tree.issues[0]!, { status_id: "progress", status_name: "In Progress", status_category: "started" });
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
  const recoveryMutations: LinearWorkflowMutationCommand[] = [];
  let reconcilerOpens = 0;
  let workspaceMaterializations = 0;
  let successorWorkspaceValid = false;
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  const dependencies = failureDependencies({ tree, logs, onOpen: failureFor, rootState: "In Progress" });
  dependencies.git = {
    async inspectRootWorktreeGate(input) {
      const cycle = tree.issues.find(({ issue_id }) => issue_id === "cycle-1");
      if (!cycle?.is_archived) return { result: expectedGate };
      assert.equal(input.generationOrdinal, 2);
      if (successorWorkspaceValid) {
        return {
          result: {
            kind: "valid" as const, repositoryIdentity: "repository-1", branch: "symphony/runs/sym-1-g2",
            headRevision: "base-2", isClean: true, changedPaths: [],
          },
          workspace: { branch: "symphony/runs/sym-1-g2", worktreePath: "/tmp/root-1-g2", rootIssueId: "root-1" },
          snapshot: {
            head: "base-2", branch: "symphony/runs/sym-1-g2",
            status: { items: [], returned: 0, cap: 512, has_more: false, partial: false },
          },
        };
      }
      assert.equal(input.executionKind, "fresh");
      return { result: {
        kind: "fresh_missing" as const,
        repositoryIdentity: "repository-1",
        generationOrdinal: 2,
        branch: "symphony/runs/sym-1-g2",
        baseBranch: "main",
        baseRevision: "base-2",
      } };
    },
    async readCommitUrl() { return "https://github.com/acme/repo/commit/head-1"; },
    async materializeRootWorkspace(input) {
      workspaceMaterializations += 1;
      successorWorkspaceValid = true;
      assert.equal(input.generationOrdinal, 2);
      assert.equal(input.expectedGate.kind, "fresh_missing");
      return {
        result: {
          kind: "valid" as const,
          repositoryIdentity: "repository-1",
          branch: "symphony/runs/sym-1-g2",
          headRevision: "base-2",
          isClean: true,
          changedPaths: [],
        },
        workspace: {
          branch: "symphony/runs/sym-1-g2",
          worktreePath: "/tmp/root-1-g2",
          rootIssueId: "root-1",
        },
        snapshot: {
          head: "base-2",
          branch: "symphony/runs/sym-1-g2",
          status: { items: [], returned: 0, cap: 512, has_more: false, partial: false },
        },
      };
    },
  };
  dependencies.reconciler = {
    async open(input) {
      reconcilerOpens += 1;
      assert.deepEqual(input.bootstrap.rootSnapshot.worktreeGate, expectedGate);
      return {
        kind: "opened" as const,
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: semanticIntentResult(input, "continue_with_successor_attempt"),
      };
    },
    async advance(input) { return semanticIntentResult(input, "continue_with_successor_attempt"); },
    async close() { throw new Error("close_unexpected"); },
  };
  dependencies.linear.mutateWorkflow = async (command) => {
    recoveryMutations.push(command);
    const cycle = tree.issues.find(({ issue_id }) => issue_id === "cycle-1");
    assert.ok(cycle);
    if (command.kind === "update_workflow_issue") {
      Object.assign(cycle, {
        status_id: command.statusId,
        status_name: "Canceled",
        status_category: "canceled",
        labels: command.labelNames,
        remote_version: "cycle-v2",
      });
    } else if (command.kind === "set_workflow_issue_archive_state") {
      cycle.is_archived = command.isArchived;
      cycle.remote_version = "cycle-v3";
    } else if (command.kind === "create_workflow_issue") {
      const isCycle = command.parentIssueId === "root-1";
      const created = {
        issue_id: isCycle ? "cycle-2" : "plan-2",
        identifier: isCycle ? "SYM-3" : "SYM-4",
        project_id: "project-1",
        status_id: command.statusId,
        status_name: isCycle ? "Planning" : "Todo",
        status_category: isCycle ? "started" as const : "unstarted" as const,
        status_position: isCycle ? 3 : 1,
        order: isCycle ? 1 : 0,
        depth: isCycle ? 1 : 2,
        title: command.title,
        description: command.description,
        labels: command.labelNames,
        is_archived: false,
        issue_kind: isCycle ? "cycle" as const : "plan" as const,
        parent_issue_id: command.parentIssueId,
        remote_version: isCycle ? "cycle-2-v1" : "plan-2-v1",
        created_at: isCycle ? "2026-07-29T01:00:00Z" : "2026-07-29T01:01:00Z",
        updated_at: isCycle ? "2026-07-29T01:00:00Z" : "2026-07-29T01:01:00Z",
      };
      tree.issues.push(created);
      tree.source_manifest.push({
        source_kind: "linear_issue", source_id: created.issue_id, source_version: created.remote_version, actor_kind: "symphony",
      });
      return { kind: "applied", readBack: { writeId: command.writeId, targetIssueId: created.issue_id, remoteVersion: created.remote_version } };
    } else {
      throw new Error("recovery_effect_unexpected");
    }
    return { kind: "applied", readBack: { writeId: command.writeId, targetIssueId: cycle.issue_id, remoteVersion: cycle.remote_version } };
  };
  dependencies.replyWriter = { async write() { throw new Error("reply_writer_unexpected"); } };

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "progress", JSON.stringify(logs));
  assert.equal(recoveryMutations[0]?.kind, "update_workflow_issue");
  assert.equal(tree.issues.find(({ issue_id }) => issue_id === "cycle-1")?.status_name, "Canceled");
  assert.deepEqual(tree.issues.find(({ issue_id }) => issue_id === "cycle-1")?.labels, ["Execution Invalidated"]);
  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "progress", JSON.stringify(logs));
  assert.deepEqual(recoveryMutations.map(({ kind }) => kind), [
    "update_workflow_issue",
    "set_workflow_issue_archive_state",
  ]);
  assert.equal(tree.issues.find(({ issue_id }) => issue_id === "cycle-1")?.is_archived, true);
  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "progress", JSON.stringify(logs));
  assert.equal(workspaceMaterializations, 1);
  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "progress", JSON.stringify(logs));
  assert.equal(tree.issues.some(({ issue_id }) => issue_id === "cycle-2"), true);
  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "progress", JSON.stringify(logs));
  assert.equal(tree.issues.some(({ issue_id }) => issue_id === "plan-2"), true);
  assert.equal(reconcilerOpens, 1);
});

test("Root runtime materializes exact Plan approval as one durable Approved effect", async () => {
  const tree = workflowTree();
  tree.status_catalog.push(
    { status_id: "planning", name: "Planning", category: "started", position: 2 },
    { status_id: "in-review", name: "In Review", category: "started", position: 3 },
    { status_id: "approved", name: "Approved", category: "started", position: 4 },
  );
  Object.assign(tree.issues[0]!, {
    status_id: "needs-approval", status_name: "Needs Approval", status_category: "started",
    creator_user_id: "user-1", assignee_user_id: "user-1",
  });
  tree.issues.push(
    {
      issue_id: "cycle-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1",
      status_id: "planning", status_name: "Planning", status_category: "started", status_position: 2,
      order: 0, depth: 1, title: "Cycle", description: "Planning", labels: ["symphony:kind/cycle"],
      is_archived: false, issue_kind: "cycle", remote_version: "cycle-v1",
      created_at: tree.observed_at, updated_at: tree.observed_at,
    },
    {
      issue_id: "plan-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1",
      status_id: "in-review", status_name: "In Review", status_category: "started", status_position: 3,
      order: 0, depth: 2, title: "Plan", description: "# Plan Result\n\nApproved content",
      labels: ["symphony:kind/plan"], is_archived: false, issue_kind: "plan", remote_version: "plan-v1",
      created_at: tree.observed_at, updated_at: tree.observed_at,
    },
  );
  tree.comments.push(
    {
      comment_id: "approval-request", issue_id: "root-1", author_id: "symphony-1", author_kind: "symphony",
      thread_root_comment_id: "approval-request", thread_state: "unresolved", reactions: [],
      body: "## 需要你审批\n\n### 相关对象\n- SYM-3", remote_version: "request-v1",
      created_at: tree.observed_at, updated_at: tree.observed_at,
    },
    {
      comment_id: "approval-reply", issue_id: "root-1", author_id: "user-1", author_user_id: "user-1",
      author_kind: "human", parent_comment_id: "approval-request", thread_root_comment_id: "approval-request",
      thread_state: "unresolved", reactions: [], body: "I approve this exact plan.", remote_version: "reply-v1",
      created_at: tree.observed_at, updated_at: tree.observed_at,
    },
  );
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  const dependencies = failureDependencies({
    tree, logs, rootState: "Needs Approval", onOpen(input) { return failureFor(input); },
  });
  dependencies.reconciler = {
    async open(input) {
      const reply = tree.comments.find(({ comment_id }) => comment_id === "approval-reply")!;
      const replyDigest = createHash("sha256").update(reply.body, "utf8").digest("hex");
      return {
        kind: "opened", sessionId: input.reconcilerSessionId, bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: semanticIntentResult(input, "answer_comments", [{
          kind: "applied",
          sourceInputId: rootInputId(`comment_body:${reply.comment_id}`, replyDigest),
          source: { kind: "comment_body", commentId: reply.comment_id, commentBodyDigest: replyDigest },
          summary: "Approved Plan accepted.",
        }]),
      };
    },
    async advance() { throw new Error("advance_unexpected"); },
    async close() { throw new Error("close_unexpected"); },
  };
  const mutations: LinearWorkflowMutationCommand[] = [];
  dependencies.linear.mutateWorkflow = async (command) => {
    mutations.push(command);
    assert.equal(command.kind, "update_workflow_issue");
    if (command.kind !== "update_workflow_issue") throw new Error("approval_update_expected");
    const plan = tree.issues.find(({ issue_id }) => issue_id === command.target.targetIssueId)!;
    Object.assign(plan, { status_id: command.statusId, status_name: "Approved", remote_version: "plan-v2" });
    return { kind: "applied", readBack: { writeId: command.writeId, targetIssueId: plan.issue_id, remoteVersion: plan.remote_version } };
  };
  let dispositions = 0;
  dependencies.replyWriter = {
    async write() { dispositions += 1; return { kind: "materialized" }; },
  };

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "progress");
  assert.equal(mutations.length, 1);
  assert.equal(tree.issues.find(({ issue_id }) => issue_id === "plan-1")!.status_name, "Approved");
  assert.equal(dispositions, 1);
});

test("Root runtime converges initial Cycle and Plan as two restart-derived effects without calling the Reconciler", async () => {
  const { runtime, logs, tree, reconcilerOpens } = initialConvergenceRuntime();

  assert.equal(await runtime.cycle(), "progress", JSON.stringify(logs));
  assert.deepEqual(tree.issues.filter(({ issue_kind }) => issue_kind === "cycle").map(({ issue_id }) => issue_id), ["cycle-initial"]);
  assert.equal(tree.issues.some(({ issue_kind }) => issue_kind === "plan"), false);

  assert.equal(await runtime.cycle(), "progress", JSON.stringify(logs));
  assert.deepEqual(tree.issues.filter(({ issue_kind }) => issue_kind === "plan").map(({ issue_id }) => issue_id), ["plan-initial"]);
  assert.equal(reconcilerOpens(), 0);
  assert.deepEqual(logs.filter(({ event }) => event === "root_initial_cycle_plan_effect_confirmed").map(({ fields }) => fields.effect_kind), [
    "create_workflow_issue",
    "create_workflow_issue",
  ]);
});

test("Root runtime converges an Approved Plan DAG one confirmed effect per fresh cycle without calling the Reconciler", async () => {
  const state = approvedPlanDagRuntime();

  for (let cycle = 0; cycle < 7; cycle += 1) {
    const mutationsBefore = state.mutationKinds.length;
    assert.equal(await state.newRuntime().cycle(), "progress");
    assert.equal(state.mutationKinds.length, mutationsBefore + 1);
  }

  assert.deepEqual(state.mutationKinds, [
    "update:root:In Progress",
    "create:work",
    "create:work",
    "create:verify",
    "relation:blocks",
    "update:plan:Done",
    "update:cycle:Sealed",
  ]);
  assert.equal(state.reconcilerOpens(), 0);
  assert.equal(state.tree.issues.filter(({ issue_kind }) => issue_kind === "work").length, 2);
  assert.equal(state.tree.issues.filter(({ issue_kind }) => issue_kind === "verify").length, 1);
  assert.equal(state.tree.relations.length, 1);
  assert.equal(state.tree.issues.find(({ issue_id }) => issue_id === "plan-1")?.status_name, "Done");
  assert.equal(state.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")?.status_name, "Sealed");
  assert.equal(state.treeReads(), 14);
  const seal = state.logs.filter(({ event }) => event === "plan_dag_seal_read_back");
  assert.equal(seal.length, 1);
  assert.deepEqual(seal[0]?.fields, {
    root_issue_id: "root-1",
    cycle_issue_id: "cycle-1",
    plan_issue_id: "plan-1",
    seal_digest: seal[0]?.fields.seal_digest,
  });
  assert.match(seal[0]?.fields.seal_digest ?? "", /^[a-f0-9]{64}$/u);
});

test("Root runtime rejects a convergence snapshot inconsistent with the native Tree before the Reconciler", async () => {
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
  assert.equal(opens, 0);
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

test("Root runtime reports each fresh schema failure and writes one deduplicated explanation comment", async () => {
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
  assert.equal(tree.comments.length, commentsBefore.length + 1);
  const explanation = tree.comments.at(-1);
  assert.equal(explanation?.issue_id, "root-1");
  assert.equal(explanation?.author_kind, "symphony");
  assert.match(explanation?.body ?? "", /The Root Reconciler output was invalid\./u);
  assert.doesNotMatch(explanation?.body ?? "", /failure_id|```json|<!--/u);
  const failureLog = logs.find(({ event }) => event === "root_reconciler_failed")?.fields ?? {};
  const failureId = failureLog.failure_id;
  assert.equal(failureLog.root_issue_id, "root-1");
  assert.equal(failureLog.failure_code, "root_directive_contract_invalid");
  assert.equal(failureLog.sanitized_reason, "The Root Reconciler output was invalid.");
  assert.ok(typeof failureId === "string");
  assert.match(failureId, /^root-1:.+:failure$/u);
  assert.equal("category" in failureLog, false);
  assert.deepEqual(logs.at(-1), {
    event: "root_failure_visibility_confirmed",
    fields: {
      root_issue_id: "root-1",
      outcome: "applied",
      via: "applied",
    },
  });

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "needs-attention");
  assert.equal(opens, 2);
  assert.equal(tree.comments.length, commentsBefore.length + 1);
});

test("Root runtime preserves the original failure when its visibility write is rejected", async () => {
  const tree = workflowTree();
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  let treeReads = 0;
  const dependencies = failureDependencies({
    tree,
    logs,
    onOpen: failureFor,
    failureCommentOutcome: {
      kind: "failed",
      code: "linear_comment_write_failed",
      summary: "The failure explanation could not be written.",
      retryable: true,
    },
  });
  const readTree = dependencies.linear.readWorkflowIssueTree;
  dependencies.linear.readWorkflowIssueTree = async (rootIssueId) => {
    treeReads += 1;
    return readTree(rootIssueId);
  };

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "needs-attention");
  assert.equal(treeReads, 1);
  assert.equal(logs.filter(({ event }) => event === "root_reconciler_failed").length, 1);
  assert.equal(logs.some(({ event }) => event === "root_reconciliation_failed"), false);
  assert.deepEqual(logs.at(-1), {
    event: "root_failure_visibility_failed",
    fields: {
      root_issue_id: "root-1",
      outcome: "not_applied",
      failure_code: "linear_comment_write_failed",
    },
  });
});

test("Root runtime confirms an applied failure comment after its write response is lost", async () => {
  const tree = workflowTree();
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  let treeReads = 0;
  const failureCommentWriteIds: string[] = [];
  const dependencies = failureDependencies({
    tree,
    logs,
    onOpen: failureFor,
    onFailureCommentCommand(command) {
      failureCommentWriteIds.push(command.writeId);
      tree.comments.push({
        comment_id: "failure-comment-unconfirmed", issue_id: "root-1", body: command.body,
        author_kind: "symphony", author_id: "symphony", thread_root_comment_id: "failure-comment-unconfirmed",
        thread_state: "unresolved", reactions: [], created_at: "2026-07-23T00:00:02Z",
        remote_version: "comment-v1", updated_at: "2026-07-23T00:00:02Z",
      });
    },
    failureCommentOutcome: {
      kind: "write_unconfirmed",
      readBackTarget: {
        writeId: "unconfirmed-write",
        targetIssueId: "root-1",
        remoteVersion: "root-v1",
      },
    },
  });
  const readTree = dependencies.linear.readWorkflowIssueTree;
  dependencies.linear.readWorkflowIssueTree = async (rootIssueId) => {
    treeReads += 1;
    return readTree(rootIssueId);
  };

  const runtime = new RootReconciliationRuntime(dependencies);
  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(treeReads, 2);
  assert.equal(tree.comments.filter(({ comment_id }) => comment_id === "failure-comment-unconfirmed").length, 1);
  assert.equal(tree.issues[0]?.status_name, "Todo");
  assert.equal(logs.filter(({ event }) => event === "root_reconciler_failed").length, 1);
  assert.equal(logs.some(({ event }) => event === "root_reconciliation_failed"), false);
  assert.equal(failureCommentWriteIds.length, 1);
  assert.match(failureCommentWriteIds[0] ?? "", /^root-1:root-failure:[a-f0-9]{16}$/u);
  assert.deepEqual(logs.at(-1), {
    event: "root_failure_visibility_confirmed",
    fields: {
      root_issue_id: "root-1",
      outcome: "applied",
      via: "read_back",
    },
  });
});

test("Root runtime retains unknown failure-comment acceptance when semantic read-back finds no comment", async () => {
  const tree = workflowTree();
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  let treeReads = 0;
  const dependencies = failureDependencies({
    tree,
    logs,
    onOpen: failureFor,
    failureCommentOutcome: {
      kind: "write_unconfirmed",
      readBackTarget: { writeId: "unconfirmed-write", targetIssueId: "root-1", remoteVersion: "root-v1" },
    },
  });
  const readTree = dependencies.linear.readWorkflowIssueTree;
  dependencies.linear.readWorkflowIssueTree = async (rootIssueId) => {
    treeReads += 1;
    return readTree(rootIssueId);
  };

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "needs-attention");
  assert.equal(treeReads, 2);
  assert.deepEqual(logs.at(-1), {
    event: "root_failure_visibility_failed",
    fields: { root_issue_id: "root-1", outcome: "acceptance_unknown" },
  });
});

test("Root runtime rejects ambiguous failure comments discovered after an unconfirmed write", async () => {
  const tree = workflowTree();
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  const dependencies = failureDependencies({
    tree,
    logs,
    onOpen: failureFor,
    onFailureCommentCommand(command) {
      for (const suffix of ["a", "b"]) {
        tree.comments.push({
          comment_id: `failure-comment-${suffix}`, issue_id: "root-1", body: command.body,
          author_kind: "symphony", author_id: "symphony", thread_root_comment_id: `failure-comment-${suffix}`,
          thread_state: "unresolved", reactions: [], created_at: "2026-07-23T00:00:02Z",
          remote_version: `comment-${suffix}-v1`, updated_at: "2026-07-23T00:00:02Z",
        });
      }
    },
    failureCommentOutcome: {
      kind: "write_unconfirmed",
      readBackTarget: { writeId: "unconfirmed-write", targetIssueId: "root-1", remoteVersion: "root-v1" },
    },
  });

  assert.equal(await new RootReconciliationRuntime(dependencies).cycle(), "needs-attention");
  assert.deepEqual(logs.at(-1), {
    event: "root_failure_visibility_failed",
    fields: {
      root_issue_id: "root-1", outcome: "readback_mismatch", failure_code: "root_failure_comment_ambiguous",
    },
  });
});

test("Root runtime closes retained failed opens before starting a fresh session", async () => {
  const tree = workflowTree();
  let opens = 0;
  let closes = 0;
  const dependencies = failureDependencies({
    tree,
    onOpen: (input) => {
      opens += 1;
      return {
        ...failureFor(input),
        continuity: {
          kind: "retained",
          appendOutcome: "accepted",
          providerVisibleContextDigest: input.bootstrap.rootDigest,
        },
      };
    },
    onClose: (reason) => {
      assert.equal(reason, "turn_failed");
      closes += 1;
    },
    logs: [],
  });
  const runtime = new RootReconciliationRuntime(dependencies);

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(opens, 1);
  assert.equal(closes, 1);

  assert.equal(await runtime.cycle(), "needs-attention");
  assert.equal(opens, 2);
  assert.equal(closes, 2);
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

test("a Human Action cannot resolve through a no-op wait directive", () => {
  const request = workflowComment({
    commentId: "human-request",
    authorKind: "symphony",
    authorId: "symphony-bot",
    body: "## 需要你审批\n\n请审批 Root。",
  });
  const source = workflowComment({
    commentId: "human-reply",
    authorKind: "human",
    authorId: "user-1",
    authorUserId: "user-1",
    parentCommentId: request.comment_id,
    threadRootCommentId: request.comment_id,
    body: "批准。",
  });
  const candidate = commentBodyReply(source);
  const tree = workflowTree();
  tree.comments = [request, source];

  assert.equal(
    validateDirectiveInputs(
      directive("tree-v1", [candidate.sourceInputId], [candidate]),
      tree,
      [candidate.sourceInputId],
    ),
    "root_directive_human_action_resolution_without_consequence",
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

function semanticIntentResult(
  input: {
    requestId: string;
    reconcilerTurnId: string;
    command: RootSemanticGateCommand;
    reconcilerSessionId?: string;
    sessionId?: string;
    bootstrap?: { rootDigest: string };
    delta?: { targetRootDigest: string };
  },
  requirementIntent: "answer_comments" | "request_information" | "define_requirement" | "continue_with_successor_attempt" = "answer_comments",
  commentDispositions: RootCommentDisposition[] = [],
): RootReconcilerTurnResult {
  const reconcilerSessionId = input.reconcilerSessionId ?? input.sessionId;
  const basedOnTargetRootDigest = input.bootstrap?.rootDigest ?? input.delta?.targetRootDigest;
  assert.ok(reconcilerSessionId);
  assert.ok(basedOnTargetRootDigest);
  const base = {
    protocolVersion: 1 as const,
    requestId: input.requestId,
    intentId: `intent-${input.reconcilerTurnId}`,
    rootIssueId: "root-1",
    reconcilerSessionId,
    reconcilerTurnId: input.reconcilerTurnId,
    modelTurn: {
      ...rootModelTurn(),
      reconcilerSessionId,
      reconcilerTurnId: input.reconcilerTurnId,
      outcome: "intent_accepted" as const,
    },
    basedOnTargetRootDigest,
    rationale: "Test semantic intent.",
    evidenceRefs: [],
    consumedInputIds: input.command.pendingInputRefs.map(({ inputId }) => inputId),
    commentDispositions,
  };
  switch (input.command.semanticGate) {
    case "requirement_and_comment":
      return {
        kind: "intent",
        intent: {
          ...base,
          kind: "requirement_and_comment_intent",
          semanticGate: "requirement_and_comment",
          intent: requirementIntent === "request_information"
            ? { kind: "request_information", question: "Which target?", context: "Missing target.", options: [] }
            : requirementIntent === "define_requirement"
              ? {
                kind: "define_requirement",
                requirement: { objective: "Build it", requestedScope: "Root", constraints: [], acceptanceCriteria: ["Implementation is verified."] },
                activeCycleImpact: "initial",
              }
              : { kind: "answer_comments", reason: "no_requirement_change" },
        },
      };
    case "plan_human_decision":
      return { kind: "intent", intent: { ...base, kind: "plan_human_decision_intent", semanticGate: "plan_human_decision", intent: { kind: "approve_plan" } } };
    case "recovery_strategy":
      return {
        kind: "intent",
        intent: {
          ...base,
          kind: "recovery_strategy_intent",
          semanticGate: "recovery_strategy",
          intent: requirementIntent === "continue_with_successor_attempt"
            ? { kind: "continue_with_successor_attempt", attemptGoal: "Rebuild execution.", successEvidenceRequirements: ["Fresh Plan is confirmed."] }
            : { kind: "repair_current_cycle", repairObjective: "Repair", acceptanceFocus: [] },
        },
      };
    case "terminal_review":
      return { kind: "intent", intent: { ...base, kind: "terminal_review_intent", semanticGate: "terminal_review", intent: { kind: "halt_root", disposition: "abandoned", explanation: "Test." } } };
  }
}

function commentDisposition(source: LinearWorkflowTreeSnapshot["comments"][number]): RootCommentDisposition {
  const commentBodyDigest = createHash("sha256").update(source.body, "utf8").digest("hex");
  return {
    kind: "answer_only",
    sourceInputId: rootInputId(`comment_body:${source.comment_id}`, commentBodyDigest),
    source: { kind: "comment_body", commentId: source.comment_id, commentBodyDigest },
    answer: "The request has been reviewed.",
  };
}

function resolveDispositionInTree(tree: LinearWorkflowTreeSnapshot, disposition: RootCommentDisposition): void {
  const source = tree.comments.find(({ comment_id }) => comment_id === disposition.source.commentId);
  assert.ok(source);
  source.reactions = [{
    reaction_id: `receipt-${source.comment_id}`,
    emoji: disposition.kind === "not_applied" ? "❌" : "✅",
    actor_kind: "symphony",
    actor_id: "symphony-bot",
  }];
  source.thread_state = "resolved";
  tree.comments.push(workflowComment({
    commentId: `reply-${source.comment_id}`,
    authorKind: "symphony",
    authorId: "symphony-bot",
    parentCommentId: source.comment_id,
    threadRootCommentId: source.thread_root_comment_id,
    threadState: "resolved",
    body: "The request has been reviewed.",
  }));
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
  onClose?(reason: "root_terminal" | "turn_failed"): void;
  logs: Array<{ event: string; fields: Record<string, string> }>;
  failureCommentOutcome?: LinearWorkflowMutationOutcome;
  onFailureCommentCommand?(command: Extract<
    Parameters<RootReconciliationRuntimeDependencies["linear"]["mutateWorkflow"]>[0],
    { kind: "append_workflow_comment" }
  >): void;
  rootState?: "Todo" | "In Progress" | "Needs Approval";
}): RootReconciliationRuntimeDependencies {
  const rootState = input.rootState ?? "Todo";
  const root = {
    issueId: "root-1", identifier: "SYM-1", state: rootState, title: "Root",
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
      async mutateWorkflow(command) {
        if (command.kind !== "append_workflow_comment") {
          return { kind: "failed" as const, code: "unused", summary: "unused" };
        }
        input.onFailureCommentCommand?.(command);
        if (input.failureCommentOutcome) return input.failureCommentOutcome;
        const comment = {
          comment_id: `failure-comment-${input.tree.comments.length + 1}`,
          issue_id: command.target.targetIssueId,
          body: command.body,
          author_kind: "symphony" as const,
          author_id: "symphony",
          thread_root_comment_id: `failure-comment-${input.tree.comments.length + 1}`,
          thread_state: "unresolved" as const,
          reactions: [],
          created_at: "2026-07-23T00:00:02Z",
          remote_version: "comment-v1",
          updated_at: "2026-07-23T00:00:02Z",
        };
        input.tree.comments.push(comment);
        return {
          kind: "applied" as const,
          readBack: { writeId: command.writeId, targetIssueId: command.target.targetIssueId, remoteVersion: "root-v2", comment },
        };
      },
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
      async close(closeInput) {
        if (!input.onClose) throw new Error("close_unexpected");
        input.onClose(closeInput.reason);
      },
    },
    performer: {} as never,
    delivery: {} as never,
    remoteAcceptance: {} as never,
    humanActions: { async materialize() { throw new Error("human_action_unexpected"); }, async convergeRootSummary() { return { kind: "not_applicable" }; } },
    replyWriter: { async write() { throw new Error("reply_writer_unexpected"); } },
    profileIdFor: async () => "profile-1",
    modelSettingsFor: async () => ({ model: "gpt", reasoningEffort: "medium" as const, isFastModeEnabled: false }),
    log(event, fields) { input.logs.push({ event, fields }); },
  };
}

function initialConvergenceRuntime() {
  const tree = workflowTree();
  tree.status_catalog = [
    { status_id: "progress", name: "In Progress", category: "started", position: 1 },
    { status_id: "planning", name: "Planning", category: "started", position: 2 },
    { status_id: "todo", name: "Todo", category: "unstarted", position: 3 },
  ];
  tree.issues[0]!.status_id = "progress";
  tree.issues[0]!.status_name = "In Progress";
  tree.issues[0]!.status_category = "started";
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  let opens = 0;
  const dependencies = failureDependencies({ tree, logs, onOpen(input) { opens += 1; return failureFor(input); }, rootState: "In Progress" });
  dependencies.reconciler = {
    async open(input) {
      return {
        kind: "opened" as const,
        sessionId: input.reconcilerSessionId,
        bootstrapRootDigest: input.bootstrap.rootDigest,
        initialResult: semanticIntentResult(input),
      };
    },
    async advance() { throw new Error("advance_unexpected"); },
    async close() { throw new Error("close_unexpected"); },
  };
  dependencies.linear.mutateWorkflow = async (command) => {
    if (command.kind !== "create_workflow_issue") throw new Error("initial_create_issue_expected");
    const isCycle = command.labelNames.includes("symphony:kind/cycle");
    const issueId = isCycle ? "cycle-initial" : "plan-initial";
    tree.issues.push({
      issue_id: issueId,
      identifier: isCycle ? "SYM-2" : "SYM-3",
      project_id: command.expectedProjectId,
      status_id: command.statusId,
      status_name: isCycle ? "Planning" : "Todo",
      status_category: isCycle ? "started" : "unstarted",
      status_position: isCycle ? 2 : 3,
      order: command.order ?? 0,
      depth: isCycle ? 1 : 2,
      title: command.title,
      description: command.description,
      labels: command.labelNames,
      is_archived: false,
      issue_kind: isCycle ? "cycle" : "plan",
      parent_issue_id: command.parentIssueId,
      remote_version: `${issueId}-v1`,
      created_at: "2026-07-23T00:00:03Z",
      updated_at: "2026-07-23T00:00:03Z",
    });
    return { kind: "applied", readBack: { writeId: command.writeId, targetIssueId: issueId, remoteVersion: `${issueId}-v1` } };
  };
  return { runtime: new RootReconciliationRuntime(dependencies), logs, tree, reconcilerOpens: () => opens };
}

function approvedPlanDagRuntime() {
  const observedAt = "2026-07-29T00:00:00Z";
  const criterion = {
    criterionKey: "criterion-1",
    statement: "The native DAG is complete.",
    verificationMethod: "Inspect the fresh Root Tree.",
  };
  const tree = workflowTree();
  tree.observed_at = observedAt;
  tree.status_catalog = [
    { status_id: "progress", name: "In Progress", category: "started", position: 1 },
    { status_id: "needs-approval", name: "Needs Approval", category: "started", position: 2 },
    { status_id: "planning", name: "Planning", category: "started", position: 3 },
    { status_id: "approved", name: "Approved", category: "started", position: 4 },
    { status_id: "todo", name: "Todo", category: "unstarted", position: 5 },
    { status_id: "done", name: "Done", category: "completed", position: 6 },
    { status_id: "sealed", name: "Sealed", category: "started", position: 7 },
  ];
  Object.assign(tree.issues[0]!, {
    status_id: "needs-approval", status_name: "Needs Approval", status_category: "started", labels: ["symphony:kind/root"],
  });
  tree.comments.push(
    workflowComment({
      commentId: "approval-request", authorKind: "symphony", authorId: "symphony-bot",
      body: "## 需要你审批\n\n请审批 SYM-3。", threadState: "resolved",
    }),
    workflowComment({
      commentId: "approval-reply", authorKind: "human", authorId: "user-1", authorUserId: "user-1",
      parentCommentId: "approval-request", threadRootCommentId: "approval-request", threadState: "resolved", body: "批准。",
      reactions: [{ reaction_id: "approval-receipt", emoji: "✅", actor_kind: "symphony", actor_id: "symphony-bot" }],
    }),
    workflowComment({
      commentId: "approval-confirmation", authorKind: "symphony", authorId: "symphony-bot",
      parentCommentId: "approval-reply", threadRootCommentId: "approval-request", threadState: "resolved", body: "## 已应用\n\nPlan 已批准。",
    }),
  );
  tree.issues.push(
    {
      issue_id: "cycle-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1",
      status_id: "planning", status_name: "Planning", status_category: "started", status_position: 2,
      order: 1, depth: 1, title: "Cycle", description: "Approved execution.", labels: ["symphony:kind/cycle"],
      is_archived: false, issue_kind: "cycle", remote_version: "cycle-v1", created_at: observedAt, updated_at: observedAt,
    },
    {
      issue_id: "plan-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1",
      status_id: "approved", status_name: "Approved", status_category: "started", status_position: 3,
      order: 1, depth: 2, title: "Plan", description: renderCanonicalPlanDescription({
        summary: "Approved DAG.",
        planContract: {
          objective: "Build it.", includedScope: ["runtime"], excludedScope: [], assumptions: [], constraints: [],
          acceptanceCriteria: [criterion], verificationRequirements: ["Run focused tests."],
        },
        proposedWorkDag: {
          workNodes: [
            { proposalKey: "contract", title: "Contract", description: "Define it.", expectedOutcome: "Defined.", requiredChecks: ["contract test"], dependencyProposalKeys: [] },
            { proposalKey: "runtime", title: "Runtime", description: "Use it.", expectedOutcome: "Composed.", requiredChecks: ["runtime test"], dependencyProposalKeys: ["contract"] },
          ],
          dependencyEdges: [],
          verifyNode: { title: "Verify", acceptanceCriteria: [criterion], requiredChecks: ["contract test", "runtime test"] },
        },
        risks: [], requiredPermissions: [],
      }),
      labels: ["symphony:kind/plan"], is_archived: false, issue_kind: "plan", remote_version: "plan-v1",
      created_at: observedAt, updated_at: observedAt,
    },
  );
  const mutationKinds: string[] = [];
  const logs: Array<{ event: string; fields: Record<string, string> }> = [];
  let opens = 0;
  let reads = 0;
  let created = 0;
  const dependencies = failureDependencies({
    tree, logs, rootState: "Needs Approval",
    onOpen(input) { opens += 1; return failureFor(input); },
  });
  dependencies.linear.readWorkflowIssueTree = async () => {
    reads += 1;
    return tree;
  };
  dependencies.linear.mutateWorkflow = async (command) => {
    if (command.kind === "create_workflow_issue") {
      created += 1;
      const kind = command.labelNames.includes("symphony:kind/verify") ? "verify" : "work";
      mutationKinds.push(`create:${kind}`);
      const status = tree.status_catalog.find(({ status_id }) => status_id === command.statusId)!;
      tree.issues.push({
        issue_id: `${kind}-${created}`, identifier: `SYM-${created + 3}`, project_id: command.expectedProjectId,
        parent_issue_id: command.parentIssueId, status_id: status.status_id, status_name: status.name,
        status_category: status.category, status_position: status.position, order: command.order ?? 0, depth: 2,
        title: command.title, description: command.description, labels: command.labelNames, is_archived: false,
        issue_kind: kind, remote_version: `${kind}-${created}-v1`, created_at: observedAt, updated_at: observedAt,
      });
      return { kind: "applied", readBack: { writeId: command.writeId, targetIssueId: `${kind}-${created}`, remoteVersion: `${kind}-${created}-v1` } };
    }
    if (command.kind === "create_workflow_relation") {
      mutationKinds.push(`relation:${command.relationKind}`);
      tree.relations.push({ relation_id: "relation-1", relation_kind: command.relationKind, source_issue_id: command.sourceIssueId, target_issue_id: command.targetIssueId });
      return { kind: "applied", readBack: { writeId: command.writeId, targetIssueId: command.targetIssueId, remoteVersion: "relation-v1" } };
    }
    if (command.kind === "update_workflow_issue") {
      const target = tree.issues.find(({ issue_id }) => issue_id === command.target.targetIssueId)!;
      const status = tree.status_catalog.find(({ status_id }) => status_id === command.statusId)!;
      mutationKinds.push(`update:${target.issue_kind}:${status.name}`);
      Object.assign(target, { status_id: status.status_id, status_name: status.name, status_category: status.category, remote_version: `${target.remote_version}-next` });
      return { kind: "applied", readBack: { writeId: command.writeId, targetIssueId: target.issue_id, remoteVersion: target.remote_version } };
    }
    throw new Error(`approved_dag_mutation_unexpected:${command.kind}`);
  };
  dependencies.humanActions = new LinearHumanActionMaterializerImpl(dependencies.linear as never);
  dependencies.reconciler.open = async (input) => {
    opens += 1;
    return { kind: "opened", sessionId: input.reconcilerSessionId, bootstrapRootDigest: input.bootstrap.rootDigest, initialResult: { kind: "failed", failure: failureFor(input) } };
  };
  return {
    newRuntime: () => new RootReconciliationRuntime(dependencies), tree, mutationKinds, logs,
    reconcilerOpens: () => opens, treeReads: () => reads,
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
    code: "root_directive_contract_invalid",
    category: "schema_invalid",
    sanitizedReason: "The Root Reconciler output was invalid.",
    continuity: { kind: "closed", appendOutcome: "session_lost" },
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
    assess({ root, tree }) {
      const cycles = tree.issues.filter(({ issue_kind, parent_issue_id }) =>
        issue_kind === "cycle" && parent_issue_id === root.issueId);
      const activeCycle = cycles.find(({ is_archived, status_category }) =>
        !is_archived && status_category !== "completed" && status_category !== "canceled");
      return {
        trigger: "none",
        snapshot: {
          policy: {
            maxCyclesPerRoot: 3,
            maxSameOpenFindingCycles: 2,
            maxCycleRepairAttempts: 0,
            deadlineAt: "2026-07-26T00:00:00.000Z",
          },
          view: {
            cycleCount: cycles.length,
            openFindingPersistence: [],
            ...(activeCycle ? { activeCycleIssueId: activeCycle.issue_id } : {}),
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
    maxCycleRepairAttempts: 0,
    deadlineAt: "2026-07-26T00:00:00.000Z",
  };
  const view = {
    cycleCount: 1,
    openFindingPersistence: [],
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
            maxCycleRepairAttempts: 0,
            deadlineAt: "2026-07-26T00:00:00.000Z",
          },
          view: {
            cycleCount: 1,
            openFindingPersistence: [],
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
      creator_user_id: "user-1",
      remote_version: "root-v1", created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
    }],
    comments: [workflowComment({
      commentId: "ownership-comment",
      authorKind: "symphony",
      authorId: "symphony-bot",
      body: "Symphony is observing this Root.",
    })],
    relations: [], attachments: [], activities: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
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
  reactions?: LinearWorkflowTreeSnapshot["comments"][number]["reactions"];
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
    reactions: input.reactions ?? [],
    created_at: "2026-07-23T00:00:00Z",
    remote_version: `${input.commentId}-v1`,
    updated_at: "2026-07-23T00:00:00Z",
  };
}
