import assert from "node:assert/strict";
import test from "node:test";

import type { V3RootRunView } from "../../root-workflow/api/Models.js";
import { RootConversationLifecycle } from "../internal/RootConversationLifecycle.js";

test("claim requires the active Profile to be ready before workspace or bootstrap", async () => {
  let workspaceCalls = 0;
  let bootstrapCalls = 0;
  const lifecycle = createLifecycle({
    profileReadiness: "login-required",
    onWorkspace: () => { workspaceCalls += 1; },
    onBootstrap: () => { bootstrapCalls += 1; },
  });

  const result = await lifecycle.claim(unclaimedView());

  assert.deepEqual(result, {
    kind: "rejected",
    reason: "performer_profile_not_ready",
  });
  assert.equal(workspaceCalls, 0);
  assert.equal(bootstrapCalls, 0);
});

test("Conversation pointer CAS conflict reaps the orphan bootstrap", async () => {
  let reconstructCalls = 0;
  let abandoned: string | undefined;
  const lifecycle = createLifecycle({
    claimOutcome: "conflict",
    onReconstruct: () => { reconstructCalls += 1; },
    onAbandon: (performerId) => { abandoned = performerId; },
  });

  const result = await lifecycle.claim(unclaimedView());

  assert.deepEqual(result, { kind: "abandoned", reason: "root_claim_conflict" });
  assert.equal(reconstructCalls, 0);
  assert.equal(abandoned, "conversation-1");
});

test("claim persists and reads back the exact Conversation pointer before a Turn permit", async () => {
  let persistedPerformerId: string | undefined;
  let bootstrapWorkspace: string | undefined;
  const events: string[] = [];
  let workspaceEvidence: unknown;
  const lifecycle = createLifecycle({
    onClaim: (performerId) => { persistedPerformerId = performerId; },
    onBootstrapWorkspace: (workspaceRoot) => { bootstrapWorkspace = workspaceRoot; },
    onWorkspaceReady: (value) => { events.push("workspace-ready"); workspaceEvidence = value; },
    onBootstrap: () => { events.push("bootstrap"); },
  });

  const result = await lifecycle.claim(unclaimedView());

  assert.equal(persistedPerformerId, "conversation-1");
  assert.equal(bootstrapWorkspace, "/worktrees/root-1");
  assert.deepEqual(events, ["workspace-ready", "bootstrap"]);
  assert.deepEqual(workspaceEvidence, {
    rootIssueId: "root-1",
    rootIdentifier: "SYM-1",
    branch: "symphony/runs/sym-1",
    workspaceId: "root-1",
    baselineHead: "abc123",
  });
  assert.deepEqual(result, {
    kind: "ready",
    permit: {
      rootIssueId: "root-1",
      performerProfileId: "profile-1",
      performerId: "conversation-1",
      workspace: {
        branch: "symphony/runs/sym-1",
        worktreePath: "/worktrees/root-1",
        rootIssueId: "root-1",
      },
    },
  });
});

test("claim reports Root selection before workspace creation", async () => {
  const events: string[] = [];
  const lifecycle = createLifecycle({
    onRootSelected: () => { events.push("root-selected"); },
    onWorkspace: () => { events.push("workspace"); },
  });

  assert.equal((await lifecycle.claim(unclaimedView())).kind, "ready");
  assert.deepEqual(events, ["root-selected", "workspace"]);
});

test("claim abandons a permit when fresh ownership or pointer facts changed", async () => {
  const lifecycle = createLifecycle({
    freshView: {
      ...claimedView(),
      managedComment: {
        ...claimedView().managedComment!,
        performerId: "conversation-other",
      },
    },
  });

  assert.deepEqual(await lifecycle.claim(unclaimedView()), {
    kind: "abandoned",
    reason: "root_claim_read_back_mismatch",
  });
});

function createLifecycle(options: {
  profileReadiness?: "login-required" | "ready" | "invalid";
  claimOutcome?: "applied" | "conflict";
  freshView?: V3RootRunView;
  onWorkspace?(): void;
  onBootstrap?(): void;
  onBootstrapWorkspace?(workspaceRoot: string): void;
  onWorkspaceReady?(value: {
    rootIssueId: string;
    rootIdentifier: string;
    branch: string;
    workspaceId: string;
    baselineHead: string;
  }): void;
  onRootSelected?(value: { rootIssueId: string; rootIdentifier: string }): void;
  onClaim?(performerId: string): void;
  onReconstruct?(): void;
  onAbandon?(performerId: string): void;
} = {}) {
  return new RootConversationLifecycle({
    conductorId: "conductor-1",
    baseBranch: "main",
    now: () => "2026-07-19T00:00:00Z",
    requestId: () => "bootstrap-1",
    bootstrapDeadlineMs: 60_000,
    ...(options.onWorkspaceReady ? { onWorkspaceReady: options.onWorkspaceReady } : {}),
    ...(options.onRootSelected ? { onRootSelected: options.onRootSelected } : {}),
    profiles: {
      async activeReadyProfile() {
        return options.profileReadiness === "login-required"
          ? undefined
          : {
              profileId: "profile-1",
              readiness: options.profileReadiness ?? "ready",
              codexTurnSettings: {
                model: "gpt-5.2-codex", reasoningEffort: "high",
                isFastModeEnabled: false,
              },
            };
      },
    },
    workspaces: {
      async ensureWorkspace(input) {
        options.onWorkspace?.();
        return {
          branch: `symphony/runs/${input.rootIdentifier.toLowerCase()}`,
          worktreePath: `/worktrees/${input.rootIssueId}`,
          rootIssueId: input.rootIssueId,
        };
      },
      async inspect() {
        return { head: "abc123", branch: "symphony/runs/sym-1", status: {
          items: [], returned: 0, cap: 512, has_more: false, partial: false,
        } };
      },
    },
    performer: {
      async openRootConversation(input) {
        options.onBootstrap?.();
        options.onBootstrapWorkspace?.(input.workspaceRoot);
        return { result: {
          protocol_version: "1", request_id: "bootstrap-1",
          performer_profile_id: "profile-1", performer_id: "conversation-1",
          completed_at: "2026-07-19T00:00:01Z",
        } };
      },
      async abandonRootConversation(performerId) {
        options.onAbandon?.(performerId);
      },
    },
    claims: {
      async compareAndSetClaim(input) {
        options.onClaim?.(input.managedComment.performerId!);
        return options.claimOutcome ?? "applied";
      },
      async reconstruct() {
        options.onReconstruct?.();
        return options.freshView ?? claimedView();
      },
    },
  });
}

function unclaimedView(): V3RootRunView {
  const view = claimedView();
  view.root = { ...view.root, state: "Todo" };
  delete view.managedComment;
  delete view.managedCommentRemote;
  return view;
}

function claimedView(): V3RootRunView {
  return {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress",
      title: "Root", description: "Build V3", updatedAt: "2026-07-19T00:00:02Z",
    },
    conductorId: "conductor-1",
    resolvedProjectId: "project-1",
    managedComment: {
      conductorId: "conductor-1", performerProfileId: "profile-1",
      performerId: "conversation-1", deliveryBranch: "symphony/runs/sym-1",
    },
    managedCommentRemote: {
      commentId: "comment-1", updatedAt: "2026-07-19T00:00:02Z",
    },
    profile: { profileId: "profile-1", readiness: "ready" },
    workflowNodes: [], workflowTreeComplete: true, blockerRelations: [],
    gitWorkspace: {
      branch: "symphony/runs/sym-1", worktreePath: "/worktrees/root-1",
      head: "0123456789abcdef", status: [],
    },
    attentionProblems: [],
  };
}
