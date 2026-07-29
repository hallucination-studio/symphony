import type { CanonicalActorKind, CanonicalFactSourceKind, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";

export type RootStateIssue = Extract<CanonicalFactValue, { kind: "linear_issue" }>;
export type RootStateStatus = Extract<CanonicalFactValue, { kind: "linear_status" }>;
export type RootStateWorktree = Extract<CanonicalFactValue, { kind: "git_worktree" }>;
export type RootStateRelation = Extract<CanonicalFactValue, { kind: "linear_relation" }>;
export type RootStateComment = Extract<CanonicalFactValue, { kind: "linear_comment" }>;
export type RootStateActivity = Extract<CanonicalFactValue, { kind: "linear_activity" }>;

export interface RootStateFactProvenance {
  sourceKind: CanonicalFactSourceKind;
  sourceId: string;
  actorKind: CanonicalActorKind;
}

export interface RootStateView {
  rootIssueId: string;
  contentDigest: string;
  root: RootStateIssue;
  activities: readonly RootStateActivity[];
  comments: readonly RootStateComment[];
  issues: readonly RootStateIssue[];
  provenance: readonly RootStateFactProvenance[];
  relations: readonly RootStateRelation[];
  statuses: readonly RootStateStatus[];
  worktree: RootStateWorktree;
}

export interface RootStateViewPolicyInterface {
  derive(state: RecoveredRootState): RootStateView;
}
