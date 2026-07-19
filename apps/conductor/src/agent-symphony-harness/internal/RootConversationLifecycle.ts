import type { JsonValue } from "@symphony/contracts";

import type { GitWorkspace } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { PerformerProcessInterface } from "../../performer-turns/api/PerformerProcessInterface.js";
import type {
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
  profiles: { activeReadyProfile(): Promise<ClaimProfile | undefined> };
  workspaces: {
    ensureWorkspace(input: {
      rootIssueId: string;
      rootIdentifier: string;
      baseBranch: string;
    }): Promise<GitWorkspace>;
  };
  performer: Pick<PerformerProcessInterface, "openRootConversation">;
  claims: {
    compareAndSetClaim(input: {
      rootIssueId: string;
      resolvedProjectId: string;
      expectedRootUpdatedAt: string;
      expectedRootState: "Todo";
      expectedManagedComment: "none";
      managedComment: V3RootManagedComment;
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
      return { kind: "abandoned", reason: "root_claim_conflict" };
    }
    const fresh = await this.dependencies.claims.reconstruct(view.root.issueId);
    if (!claimReadBackMatches(fresh, view, managedComment, workspace)) {
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
