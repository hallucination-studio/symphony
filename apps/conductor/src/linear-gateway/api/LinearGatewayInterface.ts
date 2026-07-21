import type { JsonValue } from "@symphony/contracts";

export interface LinearRootScopeSnapshot {
  root_issue_id: string;
  conductor_id: string;
  performer_id?: string;
  terminal: boolean;
  issues: Array<{
    issue_id: string;
    identifier?: string;
    updated_at: string;
    parent_issue_id?: string;
    state?: "Todo" | "In Progress" | "In Review" | "Done" | "Canceled";
    node_kind?: "work" | "human";
    human_kind?: "plan_approval" | "planned_input" | "runtime_input";
  }>;
}

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
    managed_marker?: string;
    issue_kind?: "root" | "cycle" | "plan" | "work" | "verify" | "human";
    remote_version: string;
    updated_at: string;
  }>;
  comments: Array<{
    comment_id: string;
    issue_id: string;
    body: string;
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
      };
      body: string;
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
  | { kind: "applied"; readBack: { writeId: string; targetIssueId: string; remoteVersion: string } }
  | { kind: "already_applied"; readBack: { writeId: string; targetIssueId: string; remoteVersion: string } }
  | { kind: "write_unconfirmed"; readBackTarget: { writeId: string; targetIssueId: string; remoteVersion: string } }
  | { kind: "precondition_conflict" }
  | { kind: "failed"; code: string; summary: string; retryable?: boolean };

export type LinearAgentMutationOutcome =
  | { kind: "applied"; summary: string }
  | { kind: "already_applied"; summary: string }
  | { kind: "conflict"; summary: string }
  | {
      kind: "unconfirmed";
      summary: string;
      read_back_target: { kind: "issue" | "comment_write"; issue_id: string; write_id?: string };
    }
  | { kind: "rejected" | "failed"; code: string; summary: string; retryable?: boolean };

export interface LinearGatewayInterface {
  readFreshRootScope(rootIssueId: string): Promise<LinearRootScopeSnapshot>;
  readWorkflowIssueTree(rootIssueId: string): Promise<LinearWorkflowTreeSnapshot>;
  mutateWorkflow(input: LinearWorkflowMutationCommand): Promise<LinearWorkflowMutationOutcome>;
  read(input: {
    rootIssueId: string;
    issueId: string;
    include: string[];
    scope: LinearRootScopeSnapshot;
    cursor?: string;
    limit?: number;
  }): Promise<JsonValue>;
  mutate(input: {
    rootIssueId: string;
    command: string;
    args: Record<string, JsonValue>;
  }): Promise<LinearAgentMutationOutcome>;
}
