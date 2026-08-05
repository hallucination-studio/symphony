import type { IssueStatus } from "../contracts/identity.js";
import type { LinearComment, LinearIssue } from "../contracts/task-management.js";

export type { LinearComment, LinearIssue } from "../contracts/task-management.js";

export interface LinearWorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly team_id: string;
}

export interface LinearCreateWorkflowStateRequest {
  readonly team_id: string;
  readonly name: string;
  readonly type: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  readonly color: string;
}

export interface LinearUnfinishedDescendant {
  readonly id: string;
  readonly status: IssueStatus;
}

export interface LinearCreateIssueRequest {
  readonly team_id: string;
  readonly parent_id: string | null;
  readonly title: string;
  readonly description: string;
  readonly status_id: string;
}

export type LinearUploadContentType = "application/json";

export interface LinearUploadedFile {
  readonly url: string;
}

export interface LinearGateway {
  get_issue(issue_ref: string): Promise<LinearIssue>;
  list_team_states(team_id: string): Promise<readonly LinearWorkflowState[]>;
  create_workflow_state(request: LinearCreateWorkflowStateRequest): Promise<LinearWorkflowState>;
  list_root_comments_after(root_id: string, cursor?: string): Promise<readonly LinearComment[]>;
  list_unfinished_descendants(root_id: string): Promise<readonly LinearUnfinishedDescendant[]>;
  create_issue(request: LinearCreateIssueRequest): Promise<LinearIssue>;
  update_issue_status(issue_id: string, status_id: string): Promise<void>;
  update_issue_description(issue_id: string, description: string): Promise<void>;
  create_comment(issue_id: string, body: string): Promise<LinearComment>;
  upload_file(
    filename: string,
    content_type: LinearUploadContentType,
    contents: Uint8Array,
  ): Promise<LinearUploadedFile>;
}
