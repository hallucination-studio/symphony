export interface LinearWorkflowTreeSnapshot {
  root_issue_id: string;
  status_catalog: Array<{
    status_id: string;
    name: string;
    category: "backlog" | "unstarted" | "started" | "completed" | "canceled";
    position: number;
  }>;
  issues: Array<{
    issue_id: string;
    identifier: string;
    project_id: string;
    parent_issue_id?: string;
    status_id: string;
    status_name: string;
    status_category: "backlog" | "unstarted" | "started" | "completed" | "canceled";
    status_position: number;
    order: number;
    depth: number;
    title: string;
    description: string;
    is_archived: boolean;
    managed_marker?: string;
    issue_kind?: "root" | "cycle" | "plan" | "work" | "verify" | "human";
    remote_version: string;
    updated_at: string;
  }>;
  comments: Array<{
    comment_id: string;
    issue_id: string;
    body: string;
    author_kind: "human" | "symphony" | "linear_integration" | "external_automation" | "unknown";
    author_id: string;
    author_user_id?: string;
    created_at: string;
    managed_marker?: string;
    remote_version: string;
    updated_at: string;
  }>;
  relations: Array<{
    relation_id: string;
    relation_kind: "blocks" | "blocked_by" | "triggered_by";
    source_issue_id: string;
    target_issue_id: string;
  }>;
  observed_at: string;
}

export interface ConductorPoolMember {
  conductorShortHash: string;
}

export type LinearWorkflowMutationCommand =
  | {
      kind: "create_workflow_issue";
      writeId: string;
      conductorShortHash?: string;
      expectedProjectId: string;
      rootIssueId: string;
      expectedRootRemoteVersion: string;
      parentExpectedRemoteVersion: string;
      parentExpectedStatusId: string;
      parentIssueId: string;
      issueKind: "cycle" | "plan" | "work" | "verify" | "human";
      title: string;
      description: string;
      statusId: string;
      managedMarker: string;
      order?: number;
    }
  | {
      kind: "update_workflow_issue";
      writeId: string;
      conductorShortHash?: string;
      expectedProjectId: string;
      rootIssueId: string;
      expectedRootRemoteVersion: string;
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
    }
  | {
      kind: "append_workflow_comment";
      writeId: string;
      conductorShortHash?: string;
      expectedProjectId: string;
      rootIssueId: string;
      expectedRootRemoteVersion: string;
      target: {
        targetIssueId: string;
        expectedRemoteVersion: string;
        expectedStatusId?: string;
        expectedParentIssueId?: string;
        expectedManagedMarker?: string;
        expectedIsArchived?: boolean;
      };
      body: string;
    }
  | {
      kind: "archive_workflow_issue" | "restore_workflow_issue";
      writeId: string;
      conductorShortHash?: string;
      expectedProjectId: string;
      rootIssueId: string;
      expectedRootRemoteVersion: string;
      target: {
        targetIssueId: string;
        expectedRemoteVersion: string;
        expectedStatusId?: string;
        expectedParentIssueId?: string;
        expectedManagedMarker?: string;
        expectedIsArchived?: boolean;
      };
    }
  | {
      kind: "create_workflow_relation";
      writeId: string;
      conductorShortHash?: string;
      expectedProjectId: string;
      rootIssueId: string;
      expectedRootRemoteVersion: string;
      sourceIssueId: string;
      sourceExpectedRemoteVersion: string;
      targetIssueId: string;
      targetExpectedRemoteVersion: string;
      relationKind: "blocks" | "blocked_by" | "triggered_by";
    };

export type LinearWorkflowMutationOutcome =
  | { kind: "applied"; readBack: WorkflowMutationReadBack }
  | { kind: "already_applied"; readBack: WorkflowMutationReadBack }
  | { kind: "write_unconfirmed"; readBackTarget: WorkflowMutationReadBack }
  | { kind: "precondition_conflict" }
  | { kind: "failed"; code: string; summary: string; retryable?: boolean };

export interface WorkflowMutationReadBack {
  writeId: string;
  targetIssueId: string;
  remoteVersion: string;
  issueVersions?: Array<{ issueId: string; remoteVersion: string }>;
}

export interface LinearGatewayInterface {
  readWorkflowIssueTree(rootIssueId: string): Promise<LinearWorkflowTreeSnapshot>;
  mutateWorkflow(input: LinearWorkflowMutationCommand): Promise<LinearWorkflowMutationOutcome>;
}
