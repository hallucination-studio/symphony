export type CanonicalActorKind =
  | "human"
  | "symphony"
  | "linear_integration"
  | "external_automation"
  | "unknown";

export type CanonicalLinearStatusCategory = "backlog" | "unstarted" | "started" | "completed" | "canceled";

export interface CanonicalObservedProvenance {
  actorKind: CanonicalActorKind;
  observedAt: string;
}

export interface CanonicalCommentReaction {
  reactionId: string;
  emoji: string;
  actorKind: CanonicalActorKind;
  actorId: string;
}

export type CanonicalFactValue =
  | {
      kind: "linear_status";
      statusId: string;
      name: string;
      category: CanonicalLinearStatusCategory;
      position: number;
    }
  | {
      kind: "linear_issue";
      issueId: string;
      identifier: string;
      projectId: string;
      parentIssueId?: string;
      creatorUserId?: string;
      assigneeUserId?: string;
      statusId: string;
      statusName: string;
      statusCategory: CanonicalLinearStatusCategory;
      statusPosition: number;
      order: number;
      depth: number;
      title: string;
      description: string;
      labels: readonly string[];
      isArchived: boolean;
      issueKind?: "root" | "cycle" | "plan" | "work" | "verify" | "finding";
      createdAt: string;
      updatedAt: string;
    }
  | {
      kind: "linear_comment";
      commentId: string;
      issueId: string;
      body: string;
      authorKind: CanonicalActorKind;
      authorId: string;
      authorUserId?: string;
      parentCommentId?: string;
      threadRootCommentId: string;
      threadState: "resolved" | "unresolved";
      reactions: readonly CanonicalCommentReaction[];
      createdAt: string;
      updatedAt: string;
    }
  | {
      kind: "linear_relation";
      relationId: string;
      relationKind: "blocks" | "blocked_by" | "relates_to" | "triggered_by";
      sourceIssueId: string;
      targetIssueId: string;
    }
  | {
      kind: "linear_attachment";
      attachmentId: string;
      issueId: string;
      title: string;
      url: string;
      sourceType: string;
      createdAt: string;
      updatedAt: string;
    }
  | {
      kind: "linear_activity";
      activityId: string;
      issueId: string;
      activityKinds: readonly (
        | "status_changed"
        | "description_changed"
        | "archive_changed"
        | "labels_changed"
        | "parent_changed"
        | "delegation_changed"
        | "attachment_changed"
      )[];
      actorKind: CanonicalActorKind;
      actorId?: string;
      fromStateId?: string;
      toStateId?: string;
      updatedDescription?: string;
      archived?: boolean;
      addedLabelIds?: readonly string[];
      removedLabelIds?: readonly string[];
      fromParentId?: string;
      toParentId?: string;
      fromDelegateId?: string;
      toDelegateId?: string;
      attachmentId?: string;
      createdAt: string;
    }
  | {
      kind: "git_worktree";
      rootIssueId: string;
      repositoryId: string;
      branch: string;
      headRevision: string;
      baseRevision: string;
      isClean: boolean;
      changedPaths: readonly string[];
    };

export type CanonicalFactSourceKind = CanonicalFactValue["kind"];

export interface CanonicalFactIdentity {
  sourceKind: CanonicalFactSourceKind;
  sourceId: string;
}

export interface CanonicalFactInput {
  value: CanonicalFactValue;
  provenance: CanonicalObservedProvenance;
}

export interface CanonicalFact {
  identity: CanonicalFactIdentity;
  value: CanonicalFactValue;
  provenance: CanonicalObservedProvenance;
}

export interface CanonicalObservation {
  facts: readonly CanonicalFact[];
}
