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
    creator_user_id?: string;
    assignee_user_id?: string;
    status_id: string;
    status_name: string;
    status_category: "backlog" | "unstarted" | "started" | "completed" | "canceled";
    status_position: number;
    order: number;
    depth: number;
    title: string;
    description: string;
    labels: string[];
    is_archived: boolean;
    issue_kind?: "root" | "cycle" | "plan" | "work" | "verify" | "finding";
    remote_version: string;
    created_at: string;
    updated_at: string;
  }>;
  comments: Array<{
    comment_id: string;
    issue_id: string;
    body: string;
    author_kind: "human" | "symphony" | "linear_integration" | "external_automation" | "unknown";
    author_id: string;
    author_user_id?: string;
    parent_comment_id?: string;
    thread_root_comment_id: string;
    thread_state: "resolved" | "unresolved";
    reactions: Array<{
      reaction_id: string;
      emoji: string;
      actor_kind: "human" | "symphony" | "linear_integration" | "external_automation" | "unknown";
      actor_id: string;
    }>;
    created_at: string;
    remote_version: string;
    updated_at: string;
  }>;
  relations: Array<{
    relation_id: string;
    relation_kind: "blocks" | "blocked_by" | "relates_to" | "triggered_by";
    source_issue_id: string;
    target_issue_id: string;
  }>;
  attachments: Array<{
    attachment_id: string;
    issue_id: string;
    title: string;
    url: string;
    source_type: string;
    remote_version: string;
    created_at: string;
    updated_at: string;
  }>;
  activities: Array<{
    activity_id: string;
    issue_id: string;
    activity_kinds: Array<
      "status_changed" | "description_changed" | "archive_changed" | "labels_changed"
      | "parent_changed" | "delegation_changed" | "attachment_changed"
    >;
    actor_kind: "human" | "symphony" | "linear_integration" | "external_automation" | "unknown";
    actor_id?: string;
    from_state_id?: string;
    to_state_id?: string;
    updated_description?: string;
    archived?: boolean;
    added_label_ids?: string[];
    removed_label_ids?: string[];
    from_parent_id?: string;
    to_parent_id?: string;
    from_delegate_id?: string;
    to_delegate_id?: string;
    attachment_id?: string;
    remote_version: string;
    created_at: string;
  }>;
  source_manifest: Array<{
    source_kind: "linear_issue" | "linear_comment" | "linear_relation" | "linear_attachment" | "linear_activity" | "linear_status_catalog";
    source_id: string;
    source_version: string;
    actor_kind: "human" | "symphony" | "linear_integration" | "external_automation" | "unknown";
    stable_write_id?: string;
  }>;
  coverage: {
    is_complete: boolean;
    omissions: Array<{ source_id: string; reason: string }>;
  };
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
      title: string;
      description: string;
      statusId: string;
      labelNames: string[];
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
        expectedIsArchived?: boolean;
      };
      statusId: string;
      title: string;
      description: string;
      labelNames: string[];
      isArchived: boolean;
      parentAssignment:
        | { mode: "retain" }
        | { mode: "set"; parentIssueId: string }
        | { mode: "clear" };
      order?: number;
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
        expectedIsArchived?: boolean;
      };
      body: string;
    }
  | {
      kind: "create_workflow_attachment";
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
        expectedIsArchived?: boolean;
      };
      title: string;
      url: string;
    }
  | {
      kind: "create_comment_reply";
      writeId: string;
      conductorShortHash?: string;
      expectedProjectId: string;
      rootIssueId: string;
      expectedRootRemoteVersion: string;
      sourceCommentId: string;
      expectedSourceCommentRemoteVersion: string;
      expectedThreadRootCommentId: string;
      expectedThreadState: "resolved" | "unresolved";
      body: string;
    }
  | {
      kind: "set_comment_receipt_reaction";
      writeId: string;
      conductorShortHash?: string;
      expectedProjectId: string;
      rootIssueId: string;
      expectedRootRemoteVersion: string;
      replyWriteId: string;
      sourceCommentId: string;
      expectedSourceCommentRemoteVersion: string;
      threadRootCommentId: string;
      expectedReceipt: "check" | "cross" | "none";
      receipt: "check" | "cross" | "none";
    }
  | {
      kind: "set_comment_thread_state";
      writeId: string;
      conductorShortHash?: string;
      expectedProjectId: string;
      rootIssueId: string;
      expectedRootRemoteVersion: string;
      replyWriteId: string;
      sourceCommentId: string;
      expectedSourceCommentRemoteVersion: string;
      threadRootCommentId: string;
      expectedThreadState: "resolved" | "unresolved";
      threadState: "resolved" | "unresolved";
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
      relationKind: "blocks" | "blocked_by" | "relates_to";
      relationState: "present" | "absent";
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
  comment?: LinearWorkflowTreeSnapshot["comments"][number];
  symphonyReceipt?: {
    replyWriteId: string;
    sourceCommentId: string;
    threadRootCommentId: string;
    receipt: "check" | "cross" | "none";
  };
}

export interface LinearGatewayInterface {
  readWorkflowIssueTree(rootIssueId: string): Promise<LinearWorkflowTreeSnapshot>;
  mutateWorkflow(input: LinearWorkflowMutationCommand): Promise<LinearWorkflowMutationOutcome>;
}
