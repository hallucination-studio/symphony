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
  state?: LinearIssueState;
  order?: number;
  depth?: number;
  title?: string;
  description?: string;
  labels: string[];
  isArchived: boolean;
  managedMarker?: string;
  workflowKind?: "cycle" | "plan" | "work" | "verify" | "human";
  nodeKind?: "work" | "human";
  humanKind?: "plan_approval" | "planned_input" | "runtime_input";
  origin?: "user" | "symphony";
  completedInputHash?: string;
  targetIssueId?: string;
  updatedAt: string;
}

export interface RootIssueValue {
  issue: LinearIssueValue;
  isDelegatedToSymphony: boolean;
  priority: LinearPriority;
  blockers: LinearBlockerValue[];
  rootConductorLabels: ConductorPoolValue[];
  rootManagedComments: RootManagedCommentValue[];
}

export interface ConductorPoolValue {
  conductorShortHash: string;
}

export interface RootManagedCommentValue {
  commentId: string;
  issueId: string;
  authorKind: WorkflowCommentAuthorKind;
  authorId: string;
  authorUserId?: string;
  createdAt: string;
  updatedAt: string;
  managedMarker: string;
  body: string;
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
  managedMarker?: string;
  issueKind?: "root" | "cycle" | "plan" | "work" | "verify" | "human";
  remoteVersion: string;
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
  managedMarker?: string;
  remoteVersion: string;
  updatedAt: string;
}

export interface WorkflowCommentReactionValue {
  reactionId: string;
  emoji: string;
  actorKind: WorkflowCommentAuthorKind;
  actorId: string;
}

export interface WorkflowCommentThreadChangeValue {
  threadChangeId: string;
  sourceCommentId: string;
  threadRootCommentId: string;
  action: "resolved" | "reopened";
  actorKind: WorkflowCommentAuthorKind;
  actorId: string;
  actorUserId?: string;
  occurredAt: string;
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

export type WorkflowSourceKind =
  | "linear_issue"
  | "linear_comment"
  | "linear_comment_thread_change"
  | "linear_relation"
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
  commentThreadChanges: WorkflowCommentThreadChangeValue[];
  relations: WorkflowRelationValue[];
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
  managedMarker?: string;
  workflowKind?: "cycle" | "plan" | "work" | "verify" | "human";
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
      issueKind: "cycle" | "plan" | "work" | "verify" | "human";
      title: string;
      description: string;
      statusId: string;
      managedMarker: string;
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
        expectedManagedMarker?: string;
        expectedIsArchived?: boolean;
      };
      statusId: string;
      title: string;
      description: string;
      order?: number;
    })
  | (WorkflowMutationBase & {
      kind: "append_workflow_comment";
      target: {
        targetIssueId: string;
        expectedRemoteVersion: string;
        expectedStatusId?: string;
        expectedParentIssueId?: string;
        expectedManagedMarker?: string;
        expectedIsArchived?: boolean;
      };
      body: string;
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
      kind: "set_comment_receipt_reaction";
      replyWriteId: string;
      replyCommentId: string;
      expectedReplyCommentRemoteVersion: string;
      threadRootCommentId: string;
      expectedReceipt: "check" | "cross" | "none";
      receipt: "check" | "cross" | "none";
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
      kind: "archive_workflow_issue" | "restore_workflow_issue";
      target: {
        targetIssueId: string;
        expectedRemoteVersion: string;
        expectedStatusId?: string;
        expectedParentIssueId?: string;
        expectedManagedMarker?: string;
        expectedIsArchived?: boolean;
      };
    })
  | (WorkflowMutationBase & {
      kind: "create_workflow_relation";
      sourceIssueId: string;
      sourceExpectedRemoteVersion: string;
      targetIssueId: string;
      targetExpectedRemoteVersion: string;
      relationKind: "blocks" | "blocked_by" | "relates_to" | "triggered_by";
    })
  | (WorkflowMutationBase & {
      kind: "remove_workflow_relation";
      relationId: string;
      sourceIssueId: string;
      sourceExpectedRemoteVersion: string;
      targetIssueId: string;
      targetExpectedRemoteVersion: string;
      relationKind: "blocks" | "blocked_by" | "relates_to" | "triggered_by";
    });

export interface WorkflowMutationReadBack {
  writeId: string;
  targetIssueId: string;
  remoteVersion: string;
  issueVersions?: Array<{ issueId: string; remoteVersion: string }>;
  comment?: WorkflowCommentValue;
  symphonyReceipt?: {
    replyWriteId: string;
    replyCommentId: string;
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
