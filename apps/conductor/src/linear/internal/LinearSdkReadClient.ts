import {
  LinearClient,
  type Issue,
  type IssueConnection,
  type IssueLabelConnection,
  type IssueRelationConnection,
  type WorkflowStateConnection,
} from "@linear/sdk";

import type { LinearReadClient } from "./LinearReader.js";
import type { LinearMutationClient } from "./LinearMutations.js";

function page<T, U>(connection: { readonly nodes: readonly T[]; readonly pageInfo: {
  readonly hasNextPage: boolean;
  readonly endCursor?: string | null;
} }, project: (node: T) => U) {
  return Object.freeze({
    nodes: Object.freeze(connection.nodes.map(project)),
    page_info: Object.freeze({
      has_next_page: connection.pageInfo.hasNextPage,
      end_cursor: connection.pageInfo.endCursor ?? null,
    }),
  });
}

async function issueRecord(issue: Issue) {
  const state = await issue.state;
  if (!state) throw new Error("linear_issue_state_missing");
  return Object.freeze({
    id: issue.id,
    team_id: issue.teamId,
    parent_id: issue.parentId ?? null,
    status: state.name,
    priority: issue.priority,
    created_at: issue.createdAt.toISOString(),
    delegate_id: issue.delegateId ?? null,
  });
}

async function issuePage(connection: IssueConnection) {
  return Object.freeze({
    nodes: Object.freeze(await Promise.all(connection.nodes.map(issueRecord))),
    page_info: Object.freeze({
      has_next_page: connection.pageInfo.hasNextPage,
      end_cursor: connection.pageInfo.endCursor ?? null,
    }),
  });
}

export class LinearSdkReadClient implements LinearReadClient, LinearMutationClient {
  constructor(private readonly client: LinearClient) {}

  static fromAccessToken(accessToken: string): LinearSdkReadClient {
    return new LinearSdkReadClient(new LinearClient({ accessToken }));
  }

  async listTeamIssues(teamId: string, cursor: string | null, pageSize: number): Promise<unknown> {
    return issuePage(await this.client.issues({
      after: cursor,
      first: pageSize,
      filter: { team: { id: { eq: teamId } } },
    }));
  }

  async getIssue(issueId: string): Promise<unknown> {
    return issueRecord(await this.client.issue(issueId));
  }

  async listIssueLabels(issueId: string, cursor: string | null, pageSize: number): Promise<unknown> {
    const issue = await this.client.issue(issueId);
    const labels: IssueLabelConnection = await issue.labels({ after: cursor, first: pageSize });
    return page(labels, ({ name }) => name);
  }

  async listIssueChildren(issueId: string, cursor: string | null, pageSize: number): Promise<unknown> {
    const issue = await this.client.issue(issueId);
    return issuePage(await issue.children({ after: cursor, first: pageSize }));
  }

  async listIssueInverseRelations(issueId: string, cursor: string | null, pageSize: number): Promise<unknown> {
    const issue = await this.client.issue(issueId);
    const relations: IssueRelationConnection = await issue.inverseRelations({ after: cursor, first: pageSize });
    return page(relations, (relation) => ({
      type: relation.type,
      source_issue_id: relation.issueId,
      target_issue_id: relation.relatedIssueId,
    }));
  }

  async listWorkflowStates(teamId: string, name: string, cursor: string | null, pageSize: number): Promise<unknown> {
    const states: WorkflowStateConnection = await this.client.workflowStates({
      after: cursor,
      first: pageSize,
      filter: { team: { id: { eq: teamId } }, name: { eq: name } },
    });
    return page(states, (state) => ({ id: state.id, name: state.name, team_id: state.teamId }));
  }

  async listNamedIssueLabels(name: string, cursor: string | null, pageSize: number): Promise<unknown> {
    const labels: IssueLabelConnection = await this.client.issueLabels({
      after: cursor,
      first: pageSize,
      filter: { name: { eq: name } },
    });
    return page(labels, (label) => ({
      id: label.id,
      name: label.name,
      team_id: label.teamId ?? null,
      is_group: label.isGroup,
    }));
  }

  async createCycle(input: {
    readonly team_id: string;
    readonly parent_issue_id: string;
    readonly title: string;
    readonly state_id: string;
    readonly label_id: string;
  }): Promise<unknown> {
    const payload = await this.client.createIssue({
      teamId: input.team_id,
      parentId: input.parent_issue_id,
      title: input.title,
      stateId: input.state_id,
      labelIds: [input.label_id],
    });
    return Object.freeze({ success: payload.success, issue_id: payload.issueId ?? null });
  }

  async updateIssueStatus(issueId: string, stateId: string): Promise<unknown> {
    const payload = await this.client.updateIssue(issueId, { stateId });
    return Object.freeze({ success: payload.success, issue_id: payload.issueId ?? null });
  }
}
