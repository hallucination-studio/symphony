import assert from "node:assert/strict";
import test from "node:test";

import type { V3RootRunView } from "../../root-workflow/api/Models.js";
import { RootConversationLifecycle } from "../internal/RootConversationLifecycle.js";

test("Conversation retry replaces the exact stale pointer and preserves Root facts", async () => {
  let expectedPointer: string | undefined;
  let replacementPointer: string | undefined;
  const events: string[] = [];
  const lifecycle = retryLifecycle({
    onReplace(expected, replacement) {
      expectedPointer = expected;
      replacementPointer = replacement;
    },
    onWorkspace: () => { events.push("workspace"); },
    onBootstrap: () => { events.push("bootstrap"); },
  });

  const result = await lifecycle.retry(claimedView(), "conversation-1");

  assert.equal(expectedPointer, "conversation-1");
  assert.equal(replacementPointer, "conversation-2");
  assert.deepEqual(events, ["workspace", "bootstrap"]);
  assert.equal(result.kind, "ready");
  assert.deepEqual(claimedView().workflowNodes, []);
  assert.equal("attempt" in (result as object), false);
});

test("Conversation retry uses the newly ensured Root workspace even when read-back omits it", async () => {
  const view = claimedView();
  delete view.gitWorkspace;
  let bootstrapWorkspace: string | undefined;
  const lifecycle = retryLifecycle({
    onBootstrapWorkspace: (workspaceRoot) => { bootstrapWorkspace = workspaceRoot; },
  });

  const result = await lifecycle.retry(view, "conversation-1");

  assert.equal(result.kind, "ready");
  assert.equal(bootstrapWorkspace, "/worktrees/root-1");
  assert.deepEqual(result.permit.workspace, {
    branch: "symphony/runs/sym-1",
    worktreePath: "/worktrees/root-1",
    rootIssueId: "root-1",
  });
});

test("Conversation retry fails closed on a Root or branch-mismatched ensured workspace", async () => {
  let bootstrapCalls = 0;
  const lifecycle = retryLifecycle({
    workspace: {
      branch: "symphony/runs/other-root",
      worktreePath: "/worktrees/root-1",
      rootIssueId: "root-1",
    },
    onBootstrap: () => { bootstrapCalls += 1; },
  });

  await assert.rejects(
    lifecycle.retry(claimedView(), "conversation-1"),
    /git_workspace_identity_conflict/u,
  );
  assert.equal(bootstrapCalls, 0);
});

test("stale Conversation retry is rejected before bootstrap", async () => {
  let bootstrapCalls = 0;
  const lifecycle = retryLifecycle({
    onBootstrap: () => { bootstrapCalls += 1; },
  });

  assert.deepEqual(await lifecycle.retry(claimedView(), "conversation-old"), {
    kind: "abandoned", reason: "root_conversation_stale",
  });
  assert.equal(bootstrapCalls, 0);
});

test("Conversation retry compare-and-sets an explicitly missing pointer", async () => {
  const view = claimedView();
  delete view.managedComment!.performerId;
  let expectedWasMissing = false;
  const lifecycle = retryLifecycle({
    onReplace(expected) { expectedWasMissing = expected === undefined; },
  });

  assert.equal((await lifecycle.retry(view)).kind, "ready");
  assert.equal(expectedWasMissing, true);
});

test("failed Conversation retry writes one closed Retry Block and Timeline problem", async () => {
  let blocked = 0;
  let timeline = 0;
  const lifecycle = retryLifecycle({
    bootstrapFailure: true,
    onBlock(block) {
      blocked += 1;
      assert.deepEqual(block, {
        expectedPerformerId: "conversation-1",
        failureCode: "provider_auth_unavailable",
        observedAt: "2026-07-19T00:00:03Z",
      });
    },
    onTimeline: () => { timeline += 1; },
  });

  assert.deepEqual(await lifecycle.retry(claimedView(), "conversation-1"), {
    kind: "rejected", reason: "root_retry_blocked",
  });
  assert.equal(blocked, 1);
  assert.equal(timeline, 1);
});

test("persisted Retry Block prevents every later automatic retry", async () => {
  let bootstrapCalls = 0;
  const view = claimedView();
  view.managedComment = {
    ...view.managedComment!,
    retryBlock: {
      expectedPerformerId: "conversation-1",
      failureCode: "provider_auth_unavailable",
      observedAt: "2026-07-19T00:00:03Z",
    },
  };
  const lifecycle = retryLifecycle({ onBootstrap: () => { bootstrapCalls += 1; } });

  assert.deepEqual(await lifecycle.retry(view, "conversation-1"), {
    kind: "rejected", reason: "root_retry_blocked",
  });
  assert.equal(bootstrapCalls, 0);
});

test("acknowledge clears only the exact fresh Retry Block without starting a process", async () => {
  let bootstrapCalls = 0;
  let cleared = 0;
  const lifecycle = retryLifecycle({
    onBootstrap: () => { bootstrapCalls += 1; },
    onClear: () => { cleared += 1; },
    reconstructCleared: true,
  });

  assert.deepEqual(await lifecycle.acknowledge("root-1", "2026-07-19T00:00:03Z"), {
    kind: "acknowledged",
  });
  assert.equal(cleared, 1);
  assert.equal(bootstrapCalls, 0);
});

test("acknowledge rejects stale observation and terminal Root without mutation", async () => {
  let cleared = 0;
  const lifecycle = retryLifecycle({ bootstrapFailure: true, onClear: () => { cleared += 1; } });
  assert.deepEqual(await lifecycle.acknowledge("root-1", "2026-07-19T00:00:02Z"), {
    kind: "rejected", reason: "root_retry_acknowledgement_stale",
  });
  const terminalLifecycle = retryLifecycle({ terminalBlocked: true, onClear: () => { cleared += 1; } });
  assert.equal((await terminalLifecycle.acknowledge("root-1", "2026-07-19T00:00:03Z")).kind, "rejected");
  assert.equal(cleared, 0);
});

function retryLifecycle(options: {
  bootstrapFailure?: boolean;
  onBootstrap?(): void;
  onBootstrapWorkspace?(workspaceRoot: string): void;
  onWorkspace?(): void;
  onReplace?(expected: string | undefined, replacement: string): void;
  onBlock?(block: object): void;
  onTimeline?(): void;
  onClear?(): void;
  reconstructCleared?: boolean;
  terminalBlocked?: boolean;
  workspace?: { branch: string; worktreePath: string; rootIssueId?: string };
} = {}) {
  let reconstructCalls = 0;
  return new RootConversationLifecycle({
    conductorId: "conductor-1", baseBranch: "main",
    now: () => "2026-07-19T00:00:03Z", requestId: () => "retry-1",
    bootstrapDeadlineMs: 60_000,
    profiles: {
      async activeReadyProfile() { return profile(); },
      async fixedReadyProfile() { return profile(); },
    },
    workspaces: { async ensureWorkspace() {
      options.onWorkspace?.();
      return options.workspace ?? {
        branch: "symphony/runs/sym-1", worktreePath: "/worktrees/root-1", rootIssueId: "root-1",
      };
    } },
    performer: { async openRootConversation(input) {
      options.onBootstrap?.();
      options.onBootstrapWorkspace?.(input.workspaceRoot);
      return { result: options.bootstrapFailure ? {
        protocol_version: "1", request_id: "retry-1", performer_profile_id: "profile-1",
        error_code: "provider_auth_unavailable", sanitized_reason: "Profile authentication unavailable.",
        retryable: false, completed_at: "2026-07-19T00:00:03Z",
      } : {
        protocol_version: "1", request_id: "retry-1", performer_profile_id: "profile-1",
        performer_id: "conversation-2", completed_at: "2026-07-19T00:00:03Z",
      } };
    } },
    claims: {
      async compareAndSetClaim() { return "applied"; },
      async compareAndSetConversation(input) {
        options.onReplace?.(input.expectedPerformerId, input.performerId);
        return "applied";
      },
      async writeRetryBlock(input) { options.onBlock?.(input.retryBlock); return "applied"; },
      async appendRetryProblem() { options.onTimeline?.(); },
      async clearRetryBlock() { options.onClear?.(); return "applied"; },
      async reconstruct() {
        reconstructCalls += 1;
        if (options.reconstructCleared) {
          return reconstructCalls === 1 ? blockedView() : claimedView();
        }
        if (options.terminalBlocked) {
          const view = blockedView();
          view.root = { ...view.root, state: "Done" };
          return view;
        }
        const view = claimedView();
        if (options.bootstrapFailure) {
          view.managedComment = { ...view.managedComment!, retryBlock: {
            expectedPerformerId: "conversation-1", failureCode: "provider_auth_unavailable",
            observedAt: "2026-07-19T00:00:03Z",
          } };
        } else {
          view.managedComment = { ...view.managedComment!, performerId: "conversation-2" };
        }
        return view;
      },
    },
  });
}

function blockedView(): V3RootRunView {
  const view = claimedView();
  view.managedComment = { ...view.managedComment!, retryBlock: {
    expectedPerformerId: "conversation-1", failureCode: "provider_auth_unavailable",
    observedAt: "2026-07-19T00:00:03Z",
  } };
  return view;
}

function profile() {
  return {
    profileId: "profile-1", readiness: "ready" as const,
    codexTurnSettings: {
      model: "gpt-5.2-codex", reasoningEffort: "high" as const,
      isFastModeEnabled: false,
    },
  };
}

function claimedView(): V3RootRunView {
  return {
    root: { issueId: "root-1", identifier: "SYM-1", state: "In Progress", title: "Root", description: "Build", updatedAt: "2026-07-19T00:00:02Z" },
    conductorId: "conductor-1", resolvedProjectId: "project-1",
    managedComment: { conductorId: "conductor-1", performerProfileId: "profile-1", performerId: "conversation-1", deliveryBranch: "symphony/runs/sym-1" },
    managedCommentRemote: { commentId: "comment-1", updatedAt: "2026-07-19T00:00:02Z" },
    profile: { profileId: "profile-1", readiness: "ready" }, workflowNodes: [],
    workflowTreeComplete: true, blockerRelations: [],
    gitWorkspace: { branch: "symphony/runs/sym-1", worktreePath: "/worktrees/root-1", head: "abc", status: [] },
    attentionProblems: [],
  };
}
