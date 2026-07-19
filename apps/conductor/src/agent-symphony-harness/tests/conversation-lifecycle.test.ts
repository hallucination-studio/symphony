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
  const lifecycle = createLifecycle({
    onClaim: (performerId) => { persistedPerformerId = performerId; },
  });

  const result = await lifecycle.claim(unclaimedView());

  assert.equal(persistedPerformerId, "conversation-1");
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
    },
    performer: {
      async openRootConversation() {
        options.onBootstrap?.();
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
