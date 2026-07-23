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
  body: string;
  createdAt: string;
  managedMarker?: string;
  remoteVersion: string;
  updatedAt: string;
}

export type WorkflowCommentAuthorKind =
  | "human"
  | "symphony"
  | "linear_integration"
  | "external_automation"
  | "unknown";

export interface WorkflowRelationValue {
  relationId: string;
  relationKind: "blocks" | "blocked_by" | "triggered_by";
  sourceIssueId: string;
  targetIssueId: string;
}

export interface WorkflowRootTreeValue {
  rootIssueId: string;
  statusCatalog: WorkflowStatusValue[];
  issues: WorkflowIssueValue[];
  comments: WorkflowCommentValue[];
  relations: WorkflowRelationValue[];
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
      relationKind: "blocks" | "blocked_by" | "triggered_by";
    });

export interface WorkflowMutationReadBack {
  writeId: string;
  targetIssueId: string;
  remoteVersion: string;
  issueVersions?: Array<{ issueId: string; remoteVersion: string }>;
}

export type WorkflowMutationResult =
  | { kind: "applied"; readBack: WorkflowMutationReadBack }
  | { kind: "already_applied"; readBack: WorkflowMutationReadBack }
  | { kind: "write_unconfirmed"; readBackTarget: WorkflowMutationReadBack }
  | { kind: "precondition_conflict" }
  | { kind: "failed"; error: ProtocolError };
