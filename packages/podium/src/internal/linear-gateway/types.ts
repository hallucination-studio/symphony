import type { ProtocolError } from "../errors.js";

export type LinearIssueState = import("../../public/TargetWorkflowCatalog.js").TargetWorkflowStatusName;

export type LinearPriority =
  | "urgent"
  | "high"
  | "normal"
  | "low"
  | "no_priority";

export interface LinearBlockerValue {
  sourceIssueId: string;
  targetIssueId: string;
  targetState: LinearIssueState;
}

export interface LinearIssueValue {
  issueId: string;
  identifier?: string;
  projectId?: string;
  parentIssueId?: string;
  creatorUserId?: string;
  assigneeUserId?: string;
  state?: LinearIssueState;
  order?: number;
  depth?: number;
  title?: string;
  description?: string;
  labels: string[];
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RootHeaderValue {
  rootIssueId: string;
  identifier: string;
  projectId: string;
  state: LinearIssueState;
  isArchived: boolean;
  updatedAt: string;
  isDelegatedToSymphony: boolean;
  priority: LinearPriority;
  blockers: LinearBlockerValue[];
  rootConductorLabels: ConductorPoolValue[];
}

export interface ConductorPoolValue {
  conductorShortHash: string;
}

export type WorkflowStatusCategory =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export interface WorkflowStatusValue {
  statusId: string;
  name: string;
  category: WorkflowStatusCategory;
  position: number;
}

export interface WorkflowIssueValue {
  issueId: string;
  identifier: string;
  projectId: string;
  parentIssueId?: string;
  creatorUserId?: string;
  assigneeUserId?: string;
  statusId: string;
  statusName: string;
  statusCategory: WorkflowStatusCategory;
  statusPosition: number;
  order: number;
  depth: number;
  title: string;
  description: string;
  labels: string[];
  isArchived: boolean;
  remoteVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowCommentValue {
  commentId: string;
  issueId: string;
  authorKind: WorkflowCommentAuthorKind;
  authorId: string;
  authorUserId?: string;
  parentCommentId?: string;
  threadRootCommentId: string;
  threadState: "resolved" | "unresolved";
  reactions: WorkflowCommentReactionValue[];
  body: string;
  createdAt: string;
  remoteVersion: string;
  updatedAt: string;
}

export interface WorkflowCommentReactionValue {
  reactionId: string;
  emoji: string;
  actorKind: WorkflowCommentAuthorKind;
  actorId: string;
}

export type WorkflowCommentAuthorKind =
  | "human"
  | "symphony"
  | "linear_integration"
  | "external_automation"
  | "unknown";

export interface WorkflowRelationValue {
  relationId: string;
  relationKind: "blocks" | "blocked_by" | "relates_to" | "triggered_by";
  sourceIssueId: string;
  targetIssueId: string;
}

export interface WorkflowAttachmentValue {
  attachmentId: string;
  issueId: string;
  title: string;
  url: string;
  sourceType: string;
  remoteVersion: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowActivityKind =
  | "status_changed"
  | "description_changed"
  | "archive_changed"
  | "labels_changed"
  | "parent_changed"
  | "delegation_changed"
  | "attachment_changed";

export interface WorkflowActivityValue {
  activityId: string;
  issueId: string;
  activityKinds: WorkflowActivityKind[];
  actorKind: WorkflowCommentAuthorKind;
  actorId?: string;
  fromStateId?: string;
  toStateId?: string;
  updatedDescription?: string;
  archived?: boolean;
  addedLabelIds?: string[];
  removedLabelIds?: string[];
  fromParentId?: string;
  toParentId?: string;
  fromDelegateId?: string;
  toDelegateId?: string;
  attachmentId?: string;
  remoteVersion: string;
  createdAt: string;
}

export type WorkflowSourceKind =
  | "linear_issue"
  | "linear_comment"
  | "linear_relation"
  | "linear_attachment"
  | "linear_activity"
  | "linear_status_catalog";

export interface WorkflowSourceManifestEntryValue {
  sourceKind: WorkflowSourceKind;
  sourceId: string;
  sourceVersion: string;
  actorKind: WorkflowCommentAuthorKind;
  stableWriteId?: string;
}

export interface WorkflowSourceCoverageOmissionValue {
  sourceId: string;
  reason: string;
}

export interface WorkflowSourceCoverageValue {
  isComplete: boolean;
  omissions: WorkflowSourceCoverageOmissionValue[];
}

export interface WorkflowRootTreeValue {
  rootIssueId: string;
  statusCatalog: WorkflowStatusValue[];
  issues: WorkflowIssueValue[];
  comments: WorkflowCommentValue[];
  relations: WorkflowRelationValue[];
  attachments: WorkflowAttachmentValue[];
  activities: WorkflowActivityValue[];
  sourceManifest: WorkflowSourceManifestEntryValue[];
  coverage: WorkflowSourceCoverageValue;
  observedAt: string;
}

export interface WorkflowMutationTargetValue {
  issueId: string;
  projectId: string;
  updatedAt: string;
  labels: string[];
  parentIssueId?: string;
  statusId: string;
  title: string;
  description: string;
  isArchived: boolean;
}

interface WorkflowMutationBase {
  writeId: string;
  conductorShortHash: string;
  expectedProjectId: string;
  rootIssueId: string;
  expectedRootRemoteVersion: string;
}

export type WorkflowMutationCommand =
  | (WorkflowMutationBase & {
      kind: "create_workflow_issue";
      parentExpectedRemoteVersion: string;
      parentExpectedStatusId: string;
      parentIssueId: string;
      title: string;
      description: string;
      statusId: string;
      labelNames: string[];
      order?: number;
    })
  | (WorkflowMutationBase & {
      kind: "update_workflow_issue";
      target: {
        targetIssueId: string;
        expectedRemoteVersion: string;
        expectedStatusId?: string;
        expectedParentIssueId?: string;
        expectedIsArchived: false;
      };
      statusId: string;
      title: string;
      description: string;
      labelNames: string[];
      parentAssignment:
        | { mode: "retain" }
        | { mode: "set"; parentIssueId: string }
        | { mode: "clear" };
      order?: number;
    })
  | (WorkflowMutationBase & {
      kind: "set_workflow_issue_archive_state";
      target: {
        targetIssueId: string;
        expectedRemoteVersion: string;
        expectedIsArchived: boolean;
      };
      isArchived: boolean;
    })
  | (WorkflowMutationBase & {
      kind: "append_workflow_comment";
      target: {
        targetIssueId: string;
        expectedRemoteVersion: string;
        expectedStatusId?: string;
        expectedParentIssueId?: string;
        expectedIsArchived?: boolean;
      };
      body: string;
    })
  | (WorkflowMutationBase & {
      kind: "create_workflow_attachment";
      target: {
        targetIssueId: string;
        expectedRemoteVersion: string;
        expectedStatusId?: string;
        expectedParentIssueId?: string;
        expectedIsArchived?: boolean;
      };
      title: string;
      url: string;
    })
  | (WorkflowMutationBase & {
      kind: "create_comment_reply";
      sourceCommentId: string;
      expectedSourceCommentRemoteVersion: string;
      expectedThreadRootCommentId: string;
      expectedThreadState: "resolved" | "unresolved";
      body: string;
    })
  | (WorkflowMutationBase & {
      kind: "remove_comment_receipt_reaction";
      replyWriteId: string;
      sourceCommentId: string;
      expectedSourceCommentRemoteVersion: string;
      threadRootCommentId: string;
      expectedReceipt: "check" | "cross";
    })
  | (WorkflowMutationBase & {
      kind: "create_comment_receipt_reaction";
      replyWriteId: string;
      sourceCommentId: string;
      expectedSourceCommentRemoteVersion: string;
      threadRootCommentId: string;
      receipt: "check" | "cross";
    })
  | (WorkflowMutationBase & {
      kind: "set_comment_thread_state";
      replyWriteId: string;
      sourceCommentId: string;
      expectedSourceCommentRemoteVersion: string;
      threadRootCommentId: string;
      expectedThreadState: "resolved" | "unresolved";
      threadState: "resolved" | "unresolved";
    })
  | (WorkflowMutationBase & {
      kind: "create_workflow_relation";
      sourceIssueId: string;
      sourceExpectedRemoteVersion: string;
      targetIssueId: string;
      targetExpectedRemoteVersion: string;
      relationKind: "blocks" | "blocked_by" | "relates_to";
      relationState: "present" | "absent";
    });

export interface WorkflowMutationReadBack {
  writeId: string;
  targetIssueId: string;
  remoteVersion: string;
  issueVersions?: Array<{ issueId: string; remoteVersion: string }>;
  comment?: WorkflowCommentValue;
  symphonyReceipt?: {
    replyWriteId: string;
    sourceCommentId: string;
    threadRootCommentId: string;
    receipt: "check" | "cross" | "none";
  };
}

export type WorkflowMutationResult =
  | { kind: "applied"; readBack: WorkflowMutationReadBack }
  | { kind: "already_applied"; readBack: WorkflowMutationReadBack }
  | { kind: "write_unconfirmed"; readBackTarget: WorkflowMutationReadBack }
  | { kind: "precondition_conflict" }
  | { kind: "failed"; error: ProtocolError };
