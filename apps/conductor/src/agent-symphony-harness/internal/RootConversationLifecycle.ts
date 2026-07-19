import type { JsonValue } from "@symphony/contracts";

import type { GitWorkspace } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { PerformerProcessInterface } from "../../performer-turns/api/PerformerProcessInterface.js";
import type {
  RootRetryBlock,
  V3RootManagedComment,
  V3RootRunView,
} from "../../root-workflow/api/Models.js";

interface ClaimProfile {
  profileId: string;
  readiness: "login-required" | "ready" | "invalid";
  codexTurnSettings: {
    model: string;
    reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    isFastModeEnabled: boolean;
  };
}

interface ClaimDependencies {
  conductorId: string;
  baseBranch: string;
  now(): string;
  requestId(): string;
  bootstrapDeadlineMs: number;
  profiles: {
    activeReadyProfile(): Promise<ClaimProfile | undefined>;
    fixedReadyProfile?(profileId: string): Promise<ClaimProfile | undefined>;
  };
  workspaces: {
    ensureWorkspace(input: {
      rootIssueId: string;
      rootIdentifier: string;
      baseBranch: string;
    }): Promise<GitWorkspace>;
  };
  performer: Pick<PerformerProcessInterface, "openRootConversation">
    & Partial<Pick<PerformerProcessInterface, "abandonRootConversation">>;
  claims: {
    compareAndSetClaim(input: {
      rootIssueId: string;
      resolvedProjectId: string;
      expectedRootUpdatedAt: string;
      expectedRootState: "Todo";
      expectedManagedComment: "none";
      managedComment: V3RootManagedComment;
    }): Promise<"applied" | "conflict">;
    compareAndSetConversation?(input: {
      rootIssueId: string;
      resolvedProjectId: string;
      expectedRootUpdatedAt: string;
      expectedCommentUpdatedAt: string;
      expectedPerformerId?: string;
      performerId: string;
    }): Promise<"applied" | "conflict">;
    writeRetryBlock?(input: {
      rootIssueId: string;
      resolvedProjectId: string;
      expectedRootUpdatedAt: string;
      expectedCommentUpdatedAt: string;
      expectedPerformerId?: string;
      retryBlock: RootRetryBlock;
    }): Promise<"applied" | "conflict">;
    appendRetryProblem?(input: {
      rootIssueId: string;
      writeId: string;
      failureCode: string;
      observedAt: string;
    }): Promise<void>;
    clearRetryBlock?(input: {
      rootIssueId: string;
      resolvedProjectId: string;
      expectedRootUpdatedAt: string;
      expectedCommentUpdatedAt: string;
      expectedPerformerId?: string;
      expectedFailureCode: string;
      expectedObservedAt: string;
    }): Promise<"applied" | "conflict">;
    reconstruct(rootIssueId: string): Promise<V3RootRunView>;
  };
}

export interface RootTurnPermit {
  rootIssueId: string;
  performerProfileId: string;
  performerId: string;
  workspace: GitWorkspace;
}

export type RootClaimResult =
  | { kind: "ready"; permit: RootTurnPermit }
  | { kind: "rejected" | "abandoned"; reason: string };

export class RootConversationLifecycle {
  constructor(private readonly dependencies: ClaimDependencies) {}

  async claim(view: V3RootRunView): Promise<RootClaimResult> {
    if (view.root.state !== "Todo" || view.managedComment) {
      return { kind: "rejected", reason: "root_not_unclaimed" };
    }
    const profile = await this.dependencies.profiles.activeReadyProfile();
    if (!profile || profile.readiness !== "ready") {
      return { kind: "rejected", reason: "performer_profile_not_ready" };
    }
    const workspace = await this.dependencies.workspaces.ensureWorkspace({
      rootIssueId: view.root.issueId,
      rootIdentifier: view.root.identifier,
      baseBranch: this.dependencies.baseBranch,
    });
    const requestId = this.dependencies.requestId();
    const startedAt = this.dependencies.now();
    const bootstrap = await this.dependencies.performer.openRootConversation({
      profileId: profile.profileId,
      command: {
        protocol_version: "1",
        request_id: requestId,
        performer_profile_id: profile.profileId,
        codex_turn_settings: {
          model: profile.codexTurnSettings.model,
          reasoning_effort: profile.codexTurnSettings.reasoningEffort,
          is_fast_mode_enabled: profile.codexTurnSettings.isFastModeEnabled,
        },
        hard_deadline_at: new Date(
          Date.parse(startedAt) + this.dependencies.bootstrapDeadlineMs,
        ).toISOString(),
      },
    });
    const performerId = openedPerformerId(bootstrap.result, requestId, profile.profileId);
    if (!performerId) {
      return { kind: "rejected", reason: "root_conversation_open_failed" };
    }
    const managedComment: V3RootManagedComment = {
      conductorId: this.dependencies.conductorId,
      performerProfileId: profile.profileId,
      performerId,
      deliveryBranch: workspace.branch,
    };
    const claim = await this.dependencies.claims.compareAndSetClaim({
      rootIssueId: view.root.issueId,
      resolvedProjectId: view.resolvedProjectId,
      expectedRootUpdatedAt: view.root.updatedAt,
      expectedRootState: "Todo",
      expectedManagedComment: "none",
      managedComment,
    });
    if (claim !== "applied") {
      await this.dependencies.performer.abandonRootConversation?.(performerId);
      return { kind: "abandoned", reason: "root_claim_conflict" };
    }
    const fresh = await this.dependencies.claims.reconstruct(view.root.issueId);
    if (!claimReadBackMatches(fresh, view, managedComment, workspace)) {
      await this.dependencies.performer.abandonRootConversation?.(performerId);
      return { kind: "abandoned", reason: "root_claim_read_back_mismatch" };
    }
    return {
      kind: "ready",
      permit: {
        rootIssueId: view.root.issueId,
        performerProfileId: profile.profileId,
        performerId,
        workspace,
      },
    };
  }

  async retry(
    view: V3RootRunView,
    unavailablePerformerId?: string,
  ): Promise<RootClaimResult> {
    const managed = view.managedComment;
    const remote = view.managedCommentRemote;
    if (!managed || !remote || managed.conductorId !== this.dependencies.conductorId
      || view.root.state === "Done" || view.root.state === "Canceled") {
      return { kind: "abandoned", reason: "root_retry_precondition_changed" };
    }
    if (managed.retryBlock) {
      return { kind: "rejected", reason: "root_retry_blocked" };
    }
    if (unavailablePerformerId !== undefined
      && managed.performerId !== unavailablePerformerId) {
      return { kind: "abandoned", reason: "root_conversation_stale" };
    }
    const profile = await this.dependencies.profiles.fixedReadyProfile?.(
      managed.performerProfileId,
    );
    if (!profile || profile.readiness !== "ready"
      || profile.profileId !== managed.performerProfileId) {
      return { kind: "rejected", reason: "performer_profile_not_ready" };
    }
    const requestId = this.dependencies.requestId();
    const observedAt = this.dependencies.now();
    const bootstrap = await this.dependencies.performer.openRootConversation({
      profileId: profile.profileId,
      command: openCommand(
        profile,
        requestId,
        observedAt,
        this.dependencies.bootstrapDeadlineMs,
      ),
    });
    const performerId = openedPerformerId(bootstrap.result, requestId, profile.profileId);
    if (!performerId) {
      const failureCode = openFailureCode(bootstrap.result, requestId, profile.profileId);
      const retryBlock: RootRetryBlock = {
        ...(managed.performerId ? { expectedPerformerId: managed.performerId } : {}),
        failureCode,
        observedAt,
      };
      const outcome = await this.dependencies.claims.writeRetryBlock?.({
        rootIssueId: view.root.issueId,
        resolvedProjectId: view.resolvedProjectId,
        expectedRootUpdatedAt: view.root.updatedAt,
        expectedCommentUpdatedAt: remote.updatedAt,
        ...(managed.performerId
          ? { expectedPerformerId: managed.performerId }
          : {}),
        retryBlock,
      });
      if (outcome !== "applied") {
        return { kind: "abandoned", reason: "root_retry_block_conflict" };
      }
      await this.dependencies.claims.appendRetryProblem?.({
        rootIssueId: view.root.issueId,
        writeId: `root-retry:${view.root.issueId}:${observedAt}`,
        failureCode,
        observedAt,
      });
      const blocked = await this.dependencies.claims.reconstruct(view.root.issueId);
      if (!retryBlockMatches(blocked, retryBlock)) {
        return { kind: "abandoned", reason: "root_retry_block_read_back_mismatch" };
      }
      return { kind: "rejected", reason: "root_retry_blocked" };
    }
    const outcome = await this.dependencies.claims.compareAndSetConversation?.({
      rootIssueId: view.root.issueId,
      resolvedProjectId: view.resolvedProjectId,
      expectedRootUpdatedAt: view.root.updatedAt,
      expectedCommentUpdatedAt: remote.updatedAt,
      ...(managed.performerId
        ? { expectedPerformerId: managed.performerId }
        : {}),
      performerId,
    });
    if (outcome !== "applied") {
      await this.dependencies.performer.abandonRootConversation?.(performerId);
      return { kind: "abandoned", reason: "root_conversation_replace_conflict" };
    }
    const fresh = await this.dependencies.claims.reconstruct(view.root.issueId);
    if (!replacementReadBackMatches(fresh, view, profile.profileId, performerId)) {
      await this.dependencies.performer.abandonRootConversation?.(performerId);
      return { kind: "abandoned", reason: "root_conversation_read_back_mismatch" };
    }
    return {
      kind: "ready",
      permit: {
        rootIssueId: view.root.issueId,
        performerProfileId: profile.profileId,
        performerId,
        workspace: {
          branch: fresh.gitWorkspace!.branch,
          worktreePath: fresh.gitWorkspace!.worktreePath,
          rootIssueId: view.root.issueId,
        },
      },
    };
  }

  async acknowledge(
    rootIssueId: string,
    retryObservedAt: string,
  ): Promise<{ kind: "acknowledged" } | { kind: "rejected"; reason: string }> {
    const fresh = await this.dependencies.claims.reconstruct(rootIssueId);
    const managed = fresh.managedComment;
    const remote = fresh.managedCommentRemote;
    const block = managed?.retryBlock;
    if (fresh.root.issueId !== rootIssueId
      || fresh.root.state === "Done" || fresh.root.state === "Canceled"
      || !managed || managed.conductorId !== this.dependencies.conductorId
      || !remote || !block) {
      return { kind: "rejected", reason: "root_retry_acknowledgement_invalid" };
    }
    if (block.observedAt !== retryObservedAt) {
      return { kind: "rejected", reason: "root_retry_acknowledgement_stale" };
    }
    if (block.expectedPerformerId !== managed.performerId) {
      return { kind: "rejected", reason: "root_retry_pointer_conflict" };
    }
    const outcome = await this.dependencies.claims.clearRetryBlock?.({
      rootIssueId,
      resolvedProjectId: fresh.resolvedProjectId,
      expectedRootUpdatedAt: fresh.root.updatedAt,
      expectedCommentUpdatedAt: remote.updatedAt,
      ...(managed.performerId ? { expectedPerformerId: managed.performerId } : {}),
      expectedFailureCode: block.failureCode,
      expectedObservedAt: block.observedAt,
    });
    if (outcome !== "applied") {
      return { kind: "rejected", reason: "root_retry_acknowledgement_conflict" };
    }
    const readBack = await this.dependencies.claims.reconstruct(rootIssueId);
    if (readBack.root.state === "Done" || readBack.root.state === "Canceled"
      || readBack.managedComment?.conductorId !== managed.conductorId
      || readBack.managedComment?.performerProfileId !== managed.performerProfileId
      || readBack.managedComment?.performerId !== managed.performerId
      || readBack.managedComment.retryBlock !== undefined) {
      return { kind: "rejected", reason: "root_retry_acknowledgement_read_back_mismatch" };
    }
    return { kind: "acknowledged" };
  }
}

function openCommand(
  profile: ClaimProfile,
  requestId: string,
  startedAt: string,
  deadlineMs: number,
): JsonValue {
  return {
    protocol_version: "1",
    request_id: requestId,
    performer_profile_id: profile.profileId,
    codex_turn_settings: {
      model: profile.codexTurnSettings.model,
      reasoning_effort: profile.codexTurnSettings.reasoningEffort,
      is_fast_mode_enabled: profile.codexTurnSettings.isFastModeEnabled,
    },
    hard_deadline_at: new Date(Date.parse(startedAt) + deadlineMs).toISOString(),
  };
}

function openedPerformerId(
  value: JsonValue,
  requestId: string,
  profileId: string,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = value as Record<string, JsonValue>;
  return result.request_id === requestId
      && result.performer_profile_id === profileId
      && typeof result.performer_id === "string"
    ? result.performer_id
    : undefined;
}

function openFailureCode(value: JsonValue, requestId: string, profileId: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "conversation_open_result_invalid";
  }
  const result = value as Record<string, JsonValue>;
  return result.request_id === requestId
      && result.performer_profile_id === profileId
      && typeof result.error_code === "string"
    ? result.error_code
    : "conversation_open_result_invalid";
}

function retryBlockMatches(view: V3RootRunView, expected: RootRetryBlock): boolean {
  const actual = view.managedComment?.retryBlock;
  return actual?.expectedPerformerId === expected.expectedPerformerId
    && actual?.failureCode === expected.failureCode
    && actual?.observedAt === expected.observedAt;
}

function replacementReadBackMatches(
  fresh: V3RootRunView,
  original: V3RootRunView,
  profileId: string,
  performerId: string,
): boolean {
  return fresh.root.issueId === original.root.issueId
    && fresh.root.state !== "Done"
    && fresh.root.state !== "Canceled"
    && fresh.resolvedProjectId === original.resolvedProjectId
    && fresh.managedComment?.conductorId === original.managedComment?.conductorId
    && fresh.managedComment?.performerProfileId === profileId
    && fresh.managedComment?.performerId === performerId
    && fresh.managedComment.retryBlock === undefined
    && fresh.profile?.profileId === profileId
    && fresh.profile.readiness === "ready"
    && fresh.gitWorkspace?.branch === original.gitWorkspace?.branch
    && fresh.gitWorkspace?.worktreePath === original.gitWorkspace?.worktreePath;
}

function claimReadBackMatches(
  fresh: V3RootRunView,
  original: V3RootRunView,
  managed: V3RootManagedComment,
  workspace: GitWorkspace,
): boolean {
  const readBack = fresh.managedComment;
  return fresh.root.issueId === original.root.issueId
    && fresh.root.state !== "Done"
    && fresh.root.state !== "Canceled"
    && fresh.resolvedProjectId === original.resolvedProjectId
    && readBack?.conductorId === managed.conductorId
    && readBack.performerProfileId === managed.performerProfileId
    && readBack.performerId === managed.performerId
    && readBack.deliveryBranch === workspace.branch
    && fresh.profile?.profileId === managed.performerProfileId
    && fresh.profile.readiness === "ready"
    && fresh.gitWorkspace?.branch === workspace.branch
    && fresh.gitWorkspace.worktreePath === workspace.worktreePath;
}
