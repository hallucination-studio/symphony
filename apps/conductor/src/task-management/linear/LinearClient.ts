import { createHash } from "node:crypto";

import {
  type Comment,
  type CommentConnection,
  LinearClient,
  type Issue,
  type IssueConnection,
  type IssueHistory,
  type IssueHistoryConnection,
  type IssueLabelConnection,
  type IssueRelation,
  type IssueRelationConnection,
  IssueRelationType,
  type WorkflowStateConnection,
} from "@linear/sdk";

import type {
  LinearCommandClient,
  LinearCreateIssueInput,
  LinearCreateRelationInput,
  LinearUpdateIssueInput,
} from "./LinearCommands.js";
import type { LinearQueryClient } from "./LinearQueries.js";

const RELATION_CURSOR_PREFIX = "relation:";
type IssueCreateInput = Parameters<LinearClient["createIssue"]>[0];
type IssueUpdateInput = Parameters<LinearClient["updateIssue"]>[1];

function projectedPage<T, U>(connection: {
  readonly nodes: readonly T[];
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor?: string | null };
}, project: (node: T) => U) {
  return Object.freeze({
    nodes: Object.freeze(connection.nodes.map(project)),
    page_info: Object.freeze({
      has_next_page: connection.pageInfo.hasNextPage,
      end_cursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor ?? null : null,
    }),
  });
}

function issueRecord(issue: Issue) {
  return Object.freeze({
    id: issue.id,
    revision: issue.updatedAt.toISOString(),
    team_id: issue.teamId,
    parent_id: issue.parentId ?? null,
    status: issue.stateId,
    title: issue.title,
    description: issue.description ?? null,
    labels: Object.freeze(issue.labelIds),
    delegate_id: issue.delegateId ?? null,
    priority: issue.priority === 0 ? null : issue.priority,
    created_at: issue.createdAt.toISOString(),
    updated_at: issue.updatedAt.toISOString(),
    creator_id: issue.creatorId ?? null,
    archived: issue.archivedAt != null,
    trashed: issue.trashed === true,
  });
}

function mutationIssueRecord(issue: Issue) {
  return issueRecord(issue);
}

function issuePage(connection: IssueConnection) {
  return Object.freeze({
    nodes: Object.freeze(connection.nodes.map(issueRecord)),
    page_info: Object.freeze({
      has_next_page: connection.pageInfo.hasNextPage,
      end_cursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor ?? null : null,
    }),
  });
}

function relationRecord(relation: IssueRelation) {
  return Object.freeze({
    id: relation.id,
    revision: relation.updatedAt.toISOString(),
    type: relation.type,
    source_issue_id: relation.issueId,
    target_issue_id: relation.relatedIssueId,
    created_at: relation.createdAt.toISOString(),
    updated_at: relation.updatedAt.toISOString(),
    archived: relation.archivedAt != null,
  });
}

function changedFields(history: IssueHistory): readonly string[] {
  const fields: string[] = [];
  if (history.fromStateId != null || history.toStateId != null) fields.push("status");
  if (history.fromTitle != null || history.toTitle != null) fields.push("title");
  if (history.updatedDescription === true) fields.push("description");
  if (history.fromParentId != null || history.toParentId != null) fields.push("parent");
  if ((history.addedLabelIds?.length ?? 0) > 0 || (history.removedLabelIds?.length ?? 0) > 0) fields.push("labels");
  if (history.fromDelegate != null || history.toDelegate != null) fields.push("delegate");
  if (history.fromPriority != null || history.toPriority != null) fields.push("priority");
  if (history.archived != null) fields.push("archived");
  if (history.trashed != null) fields.push("trashed");
  if ((history.relationChanges?.length ?? 0) > 0) fields.push("relation");
  return Object.freeze(fields);
}

function historyRecord(issueId: string, history: IssueHistory) {
  return Object.freeze({
    id: history.id,
    issue_id: issueId,
    created_at: history.createdAt.toISOString(),
    updated_at: history.updatedAt.toISOString(),
    actor_id: history.actorId ?? null,
    changed_fields: changedFields(history),
    from_state_id: history.fromStateId ?? null,
    to_state_id: history.toStateId ?? null,
    from_parent_id: history.fromParentId ?? null,
    to_parent_id: history.toParentId ?? null,
    added_label_ids: Object.freeze([...(history.addedLabelIds ?? [])]),
    removed_label_ids: Object.freeze([...(history.removedLabelIds ?? [])]),
    archived: history.archived ?? null,
    trashed: history.trashed ?? null,
    relation_changes: Object.freeze((history.relationChanges ?? []).map((change) => Object.freeze({
      type: change.type,
      related_issue_identifier: change.identifier,
    }))),
  });
}

function commentRecord(issueId: string, comment: Comment) {
  return Object.freeze({
    id: comment.id,
    issue_id: comment.issueId ?? issueId,
    created_at: comment.createdAt.toISOString(),
    updated_at: comment.updatedAt.toISOString(),
    edited_at: comment.editedAt?.toISOString() ?? null,
    archived_at: comment.archivedAt?.toISOString() ?? null,
    actor_id: comment.userId ?? comment.botActor?.id ?? null,
    body_markdown: comment.body,
    body_digest: createHash("sha256").update(comment.body, "utf8").digest("hex"),
  });
}

function relationCursor(issueId: string, direction: "out" | "in", providerCursor: string | null): string {
  const encoded = Buffer.from(JSON.stringify([issueId, direction, providerCursor]), "utf8").toString("base64url");
  return `${RELATION_CURSOR_PREFIX}${encoded}`;
}

function parseRelationCursor(
  issueId: string,
  cursor: string | null,
): { direction: "out" | "in"; providerCursor: string | null } {
  if (cursor === null) return { direction: "out", providerCursor: null };
  try {
    if (!cursor.startsWith(RELATION_CURSOR_PREFIX)) throw new Error("invalid_cursor");
    const decoded = JSON.parse(Buffer.from(cursor.slice(RELATION_CURSOR_PREFIX.length), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 3) throw new Error("invalid_cursor");
    const [cursorIssueId, direction, providerCursor] = decoded;
    if (
      cursorIssueId !== issueId
      || (direction !== "out" && direction !== "in")
      || (providerCursor !== null && typeof providerCursor !== "string")
    ) throw new Error("invalid_cursor");
    return { direction, providerCursor };
  } catch {
    throw new Error("linear_relation_cursor_invalid");
  }
}

function relationPage(issueId: string, connection: IssueRelationConnection, direction: "out" | "in") {
  const providerNext = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor ?? null : null;
  const hasNextPage = connection.pageInfo.hasNextPage || direction === "out";
  const nextCursor = connection.pageInfo.hasNextPage
    ? relationCursor(issueId, direction, providerNext)
    : direction === "out"
      ? relationCursor(issueId, "in", null)
      : null;
  return Object.freeze({
    nodes: Object.freeze(connection.nodes.map(relationRecord)),
    page_info: Object.freeze({ has_next_page: hasNextPage, end_cursor: nextCursor }),
  });
}

function mutationReceipt(receipt: { readonly success: boolean }) {
  return Object.freeze({ success: receipt.success });
}

export class LinearSdkQueryClient implements LinearQueryClient, LinearCommandClient {
  constructor(private readonly client: LinearClient) {}

  static fromAccessToken(accessToken: string): LinearSdkQueryClient {
    return new LinearSdkQueryClient(new LinearClient({ accessToken }));
  }

  async getIssue(issueId: string): Promise<unknown> {
    const issues = await this.client.issues({
      first: 2,
      includeArchived: true,
      filter: { id: { eq: issueId } },
    });
    if (issues.pageInfo.hasNextPage) throw new Error("linear_issue_lookup_incomplete");
    if (issues.nodes.length === 0) return null;
    if (issues.nodes.length !== 1 || issues.nodes[0]?.id !== issueId) {
      throw new Error("linear_issue_identity_mismatch");
    }
    return issueRecord(issues.nodes[0]);
  }

  async readIssue(issueId: string): Promise<unknown> {
    return mutationIssueRecord(await this.client.issue(issueId));
  }

  async listIssues(cursor: string | null, pageSize: number): Promise<unknown> {
    return issuePage(await this.client.issues({
      after: cursor,
      first: pageSize,
      includeArchived: true,
    }));
  }

  async listChildren(issueId: string, cursor: string | null, pageSize: number): Promise<unknown> {
    const issue = await this.client.issue(issueId);
    return issuePage(await issue.children({ after: cursor, first: pageSize }));
  }

  async listIssueHistory(issueId: string, cursor: string | null, pageSize: number): Promise<unknown> {
    const issue = await this.client.issue(issueId);
    const history: IssueHistoryConnection = await issue.history({ after: cursor, first: pageSize });
    return projectedPage(history, (entry) => historyRecord(issueId, entry));
  }

  async listIssueComments(issueId: string, cursor: string | null, pageSize: number): Promise<unknown> {
    const issue = await this.client.issue(issueId);
    const comments: CommentConnection = await issue.comments({ after: cursor, first: pageSize });
    return projectedPage(comments, (entry) => commentRecord(issueId, entry));
  }

  async readViewer(): Promise<unknown> {
    const viewer = await this.client.viewer;
    return Object.freeze({ id: viewer.id, active: viewer.active, app: viewer.app });
  }

  async listRelations(issueId: string, cursor: string | null, pageSize: number): Promise<unknown> {
    const issue = await this.client.issue(issueId);
    const parsed = parseRelationCursor(issueId, cursor);
    const connection = parsed.direction === "out"
      ? await issue.relations({ after: parsed.providerCursor, first: pageSize })
      : await issue.inverseRelations({ after: parsed.providerCursor, first: pageSize });
    return relationPage(issueId, connection, parsed.direction);
  }

  async listStates(teamId: string, cursor: string | null, pageSize: number): Promise<unknown> {
    const states: WorkflowStateConnection = await this.client.workflowStates({
      after: cursor,
      first: pageSize,
      filter: { team: { id: { eq: teamId } } },
    });
    return projectedPage(states, (state) => ({
      id: state.id,
      revision: state.updatedAt.toISOString(),
      name: state.name,
      team_id: state.teamId,
      archived: state.archivedAt != null,
    }));
  }

  async listLabels(teamId: string, cursor: string | null, pageSize: number): Promise<unknown> {
    const labels: IssueLabelConnection = await this.client.issueLabels({
      after: cursor,
      first: pageSize,
      filter: { or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] },
    });
    return projectedPage(labels, (label) => ({
      id: label.id,
      revision: label.updatedAt.toISOString(),
      name: label.name,
      team_id: label.teamId ?? null,
    }));
  }

  async createIssue(input: LinearCreateIssueInput): Promise<unknown> {
    const sdkInput: IssueCreateInput = {
      id: input.id,
      teamId: input.team_id,
      parentId: input.parent_issue_id,
      title: input.title,
      description: input.description,
      stateId: input.state_id,
      labelIds: [...input.label_ids],
      delegateId: input.delegate_id,
      priority: input.priority,
    };
    return mutationReceipt(await this.client.createIssue(sdkInput));
  }

  async updateIssue(issueId: string, input: LinearUpdateIssueInput): Promise<unknown> {
    const sdkInput: IssueUpdateInput = {};
    if (input.title !== undefined) sdkInput.title = input.title;
    if (input.description !== undefined) sdkInput.description = input.description;
    if (input.state_id !== undefined) sdkInput.stateId = input.state_id;
    if (input.parent_issue_id !== undefined) sdkInput.parentId = input.parent_issue_id;
    if (input.label_ids !== undefined) sdkInput.labelIds = [...input.label_ids];
    if (input.delegate_id !== undefined) sdkInput.delegateId = input.delegate_id;
    if (input.priority !== undefined) sdkInput.priority = input.priority;
    return mutationReceipt(await this.client.updateIssue(issueId, sdkInput));
  }

  async archiveIssue(issueId: string): Promise<unknown> {
    return mutationReceipt(await this.client.archiveIssue(issueId));
  }

  async createRelation(input: LinearCreateRelationInput): Promise<unknown> {
    return mutationReceipt(await this.client.createIssueRelation({
      id: input.id,
      type: input.type as IssueRelationType,
      issueId: input.source_issue_id,
      relatedIssueId: input.target_issue_id,
    }));
  }

  async deleteRelation(relationId: string): Promise<unknown> {
    return mutationReceipt(await this.client.deleteIssueRelation(relationId));
  }
}
