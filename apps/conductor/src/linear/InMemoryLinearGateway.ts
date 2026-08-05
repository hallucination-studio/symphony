import type {
  LinearComment,
  LinearCreateIssueRequest,
  LinearCreateWorkflowStateRequest,
  LinearUploadedFile,
  LinearUploadContentType,
  LinearGateway,
  LinearIssue,
  LinearUnfinishedDescendant,
  LinearWorkflowState,
} from "./LinearGateway.js";
import { parseLinearComment, parseLinearIssue } from "../contracts/task-management.js";
import { isRootStateComment } from "./LinearMarkers.js";


export interface InMemoryLinearGatewaySeed {
  readonly issues?: readonly LinearIssue[];
  readonly states?: readonly LinearWorkflowState[];
  readonly comments?: readonly LinearComment[];
}

export interface InMemoryLinearAttachment extends LinearUploadedFile {
  readonly id: string;
  readonly filename: string;
  readonly content_type: LinearUploadContentType;
  readonly contents: Uint8Array;
}

function copyIssue(issue: LinearIssue): LinearIssue {
  return Object.freeze({ ...issue });
}

function copyState(state: LinearWorkflowState): LinearWorkflowState {
  return Object.freeze({ ...state });
}

function copyComment(comment: LinearComment): LinearComment {
  return Object.freeze({ ...comment });
}

function copyAttachment(attachment: InMemoryLinearAttachment): InMemoryLinearAttachment {
  return Object.freeze({ ...attachment, contents: attachment.contents.slice() });
}

function orderedComments(comments: Iterable<LinearComment>): readonly LinearComment[] {
  return [...comments]
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
}

export class InMemoryLinearGateway implements LinearGateway {
  readonly #issues = new Map<string, LinearIssue>();
  readonly #states = new Map<string, LinearWorkflowState>();
  readonly #comments = new Map<string, LinearComment>();
  readonly #attachments = new Map<string, InMemoryLinearAttachment>();
  #issueSequence = 0;
  #stateSequence = 0;
  #commentSequence = 0;
  #attachmentSequence = 0;

  constructor(seed: InMemoryLinearGatewaySeed = {}) {
    for (const issue of seed.issues ?? []) {
      if (this.#issues.has(issue.id)) throw new Error("linear_issue_duplicated");
      this.#issues.set(issue.id, copyIssue(issue));
    }
    for (const state of seed.states ?? []) {
      if (this.#states.has(state.id)) throw new Error("linear_workflow_state_duplicated");
      this.#states.set(state.id, copyState(state));
    }
    for (const comment of seed.comments ?? []) {
      if (this.#comments.has(comment.id)) throw new Error("linear_comment_duplicated");
      this.#comments.set(comment.id, copyComment(comment));
    }
  }

  async get_issue(issueRef: string): Promise<LinearIssue> {
    const matches = [...this.#issues.values()].filter((issue) => (
      issue.id === issueRef || issue.identifier === issueRef
    ));
    if (matches.length === 0) throw new Error(`linear_issue_not_found:${issueRef}`);
    if (matches.length !== 1) throw new Error(`linear_issue_ambiguous:${issueRef}`);
    return copyIssue(matches[0] as LinearIssue);
  }

  async list_team_states(teamId: string): Promise<readonly LinearWorkflowState[]> {
    return Object.freeze([...this.#states.values()]
      .filter((state) => state.team_id === teamId)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map(copyState));
  }

  async create_workflow_state(request: LinearCreateWorkflowStateRequest): Promise<LinearWorkflowState> {
    if ([...this.#states.values()].some((state) => (
      state.team_id === request.team_id && state.name === request.name
    ))) throw new Error("linear_workflow_state_name_duplicated");
    this.#stateSequence += 1;
    const state = Object.freeze({
      id: `fake-state-${this.#stateSequence}`,
      name: request.name,
      type: request.type,
      team_id: request.team_id,
    });
    this.#states.set(state.id, state);
    return copyState(state);
  }

  async list_root_comments_after(rootId: string, cursor?: string): Promise<readonly LinearComment[]> {
    const comments = orderedComments(
      [...this.#comments.values()].filter((comment) => comment.issue_id === rootId),
    );
    if (cursor === undefined) return Object.freeze(comments.map(copyComment));
    const cursorIndex = comments.findIndex((comment) => comment.id === cursor);
    if (cursorIndex < 0) throw new Error("linear_comment_cursor_not_found");
    return Object.freeze(comments.slice(cursorIndex + 1).map(copyComment));
  }

  async find_root_state_comment(rootId: string): Promise<LinearComment | null> {
    const matches = [...this.#comments.values()].filter((comment) => (
      comment.issue_id === rootId && isRootStateComment(comment.body)
    ));
    if (matches.length > 1) throw new Error("linear_root_state_comment_duplicated");
    return matches[0] === undefined ? null : copyComment(matches[0]);
  }

  async list_unfinished_descendants(rootId: string): Promise<readonly LinearUnfinishedDescendant[]> {
    const descendants: LinearIssue[] = [];
    const pending = [rootId];
    while (pending.length > 0) {
      const parentId = pending.shift();
      const children = [...this.#issues.values()]
        .filter((issue) => issue.parent_id === parentId)
        .sort((left, right) => left.id.localeCompare(right.id));
      descendants.push(...children);
      pending.push(...children.map((issue) => issue.id));
    }
    return Object.freeze(descendants.flatMap((issue) => {
      return issue.status === "completed" || issue.status === "canceled"
        ? []
        : [Object.freeze({ id: issue.id, status: issue.status })];
    }));
  }

  async create_issue(request: LinearCreateIssueRequest): Promise<LinearIssue> {
    if (!this.#states.has(request.status_id)) throw new Error(`linear_workflow_state_not_found:${request.status_id}`);
    if (request.parent_id !== null && !this.#issues.has(request.parent_id)) {
      throw new Error(`linear_parent_issue_not_found:${request.parent_id}`);
    }
    this.#issueSequence += 1;
    const id = `fake-issue-${this.#issueSequence}`;
    const state = this.#states.get(request.status_id);
    if (state === undefined) throw new Error(`linear_workflow_state_not_found:${request.status_id}`);
    const issue = parseLinearIssue({
      id,
      identifier: `FAKE-${this.#issueSequence}`,
      title: request.title,
      description: request.description,
      url: `https://linear.invalid/issue/FAKE-${this.#issueSequence}`,
      status: normalizedStatus(state.type),
      status_id: state.id,
      parent_id: request.parent_id,
      team_id: request.team_id,
      creator_id: "in-memory-linear-gateway",
    });
    this.#issues.set(id, issue);
    return copyIssue(issue);
  }

  async update_issue_status(issueId: string, statusId: string): Promise<void> {
    const issue = this.#issues.get(issueId);
    if (issue === undefined) throw new Error(`linear_issue_not_found:${issueId}`);
    const state = this.#states.get(statusId);
    if (state === undefined) throw new Error(`linear_workflow_state_not_found:${statusId}`);
    this.#issues.set(issueId, Object.freeze({
      ...issue, status: normalizedStatus(state.type), status_id: state.id,
    }));
  }

  async create_comment(issueId: string, body: string): Promise<LinearComment> {
    if (!this.#issues.has(issueId)) throw new Error(`linear_issue_not_found:${issueId}`);
    this.#commentSequence += 1;
    const id = `fake-comment-${this.#commentSequence}`;
    const comment = parseLinearComment({
      id,
      issue_id: issueId,
      body,
      creator_id: "in-memory-linear-gateway",
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, this.#commentSequence)).toISOString(),
    });
    this.#comments.set(id, comment);
    return copyComment(comment);
  }

  async update_comment(commentId: string, body: string): Promise<void> {
    const comment = this.#comments.get(commentId);
    if (comment === undefined) throw new Error(`linear_comment_not_found:${commentId}`);
    this.#comments.set(commentId, parseLinearComment({ ...comment, body }));
  }

  get attachments(): readonly InMemoryLinearAttachment[] {
    return Object.freeze([...this.#attachments.values()].map(copyAttachment));
  }

  async upload_file(
    filename: string,
    contentType: LinearUploadContentType,
    contents: Uint8Array,
  ): Promise<LinearUploadedFile> {
    if (contentType !== "application/json") throw new Error("linear_upload_content_type_invalid");
    if (!(contents instanceof Uint8Array)) throw new Error("linear_upload_contents_invalid");
    this.#attachmentSequence += 1;
    const id = `fake-upload-${this.#attachmentSequence}`;
    const attachment = Object.freeze({
      id,
      url: `https://linear.invalid/upload/${id}`,
      filename,
      content_type: contentType,
      contents: contents.slice(),
    });
    this.#attachments.set(id, attachment);
    return Object.freeze({ url: attachment.url });
  }
}

function normalizedStatus(type: LinearWorkflowState["type"]): LinearIssue["status"] {
  switch (type) {
    case "backlog":
    case "unstarted":
      return "todo";
    case "started":
      return "active";
    case "completed":
      return "completed";
    case "canceled":
      return "canceled";
    default:
      throw new Error("linear_workflow_state_type_unsupported");
  }
}
