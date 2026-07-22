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

export interface ProjectPrecondition {
  conductorShortHash: string;
  expectedProjectId: string;
  expectedProjectUpdatedAt: string;
}

export interface RemotePrecondition {
  expectedIssueId: string;
  expectedUpdatedAt: string;
  expectedState?: LinearIssueState;
  expectedParentIssueId?: string;
  expectedManagedMarker?: string;
}

interface MutationBase {
  project: ProjectPrecondition;
}

type ManagedNodeDescriptor =
  | {
      nodeKind: "work";
      humanKind?: never;
      targetIssueId?: never;
    }
  | {
      nodeKind: "human";
      humanKind: "plan_approval";
      targetIssueId?: never;
    }
  | {
      nodeKind: "human";
      humanKind: "planned_input" | "runtime_input";
      targetIssueId: string;
    };

export type LinearMutationCommand =
  | (MutationBase & ManagedNodeDescriptor & {
      kind: "create_managed_node";
      parentIssueId: string;
      managedMarker: string;
      order: number;
      title: string;
      description: string;
    })
  | (MutationBase & ManagedNodeDescriptor & {
      kind: "update_managed_node";
      precondition: RemotePrecondition;
      title: string;
      description: string;
      completedInputHash?: string;
    })
  | (MutationBase & {
      kind: "update_issue_state";
      precondition: RemotePrecondition;
      state: LinearIssueState;
    })
  | (MutationBase & {
      kind: "update_issue_assignee";
      precondition: RemotePrecondition;
      assigneeId: string;
    })
  | (MutationBase & {
      kind: "update_issue_label";
      precondition: RemotePrecondition;
      label: string;
      operation: "add" | "remove";
    })
  | (MutationBase & {
      kind: "create_issue_comment";
      precondition: RemotePrecondition;
      writeId: string;
      body: string;
    })
  | (MutationBase & {
      kind: "reorder_issue_node";
      precondition: RemotePrecondition;
      parentIssueId: string;
      order: number;
    })
  | (MutationBase & {
      kind: "replace_root_phase_label";
      precondition: RemotePrecondition;
      phase:
        | "planning"
        | "awaiting-human"
        | "working"
        | "gating"
        | "delivering"
        | "in-review"
        | "blocked"
        | "failed";
    })
  | (MutationBase & {
      kind: "upsert_root_managed_comment";
      rootPrecondition: RemotePrecondition;
      commentPrecondition?: RemotePrecondition;
      managedMarker: string;
      body: string;
    })
  | (MutationBase & {
      kind: "project_root_comment";
      rootIssueId: string;
      body: string;
    } & (
      | { commentId: string; eventKey?: never }
      | { eventKey: string; commentId?: never }
    ));

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
  rootManagedComments: RootManagedCommentValue[];
}

export interface RootManagedCommentValue {
  commentId: string;
  issueId: string;
  updatedAt: string;
  managedMarker: string;
  body: string;
}

export interface RootUsageValue {
  rootIssueId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  observedAt: string;
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
  managedMarker?: string;
  issueKind?: "root" | "cycle" | "plan" | "work" | "verify" | "human";
  remoteVersion: string;
  updatedAt: string;
}

export interface WorkflowCommentValue {
  commentId: string;
  issueId: string;
  body: string;
  managedMarker?: string;
  remoteVersion: string;
  updatedAt: string;
}

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
  parentIssueId?: string;
  statusId: string;
  title: string;
  description: string;
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
      };
      body: string;
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

export type LinearMutationResult =
  | { kind: "applied"; issue?: LinearIssueValue }
  | { kind: "already_applied"; issue?: LinearIssueValue }
  | { kind: "linear_precondition_conflict" }
  | { kind: "conductor_project_resolution_changed" }
  | {
      kind: "write_unconfirmed";
      readBackTarget: {
        kind: "issue" | "managed_marker" | "comment_write";
        targetId: string;
      };
    }
  | { kind: "failed"; error: ProtocolError };
