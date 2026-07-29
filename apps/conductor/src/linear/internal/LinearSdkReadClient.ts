import {
  LinearClient,
  type Issue,
  type IssueConnection,
  type IssueLabelConnection,
  type IssueRelationConnection,
} from "@linear/sdk";

import type { LinearReadClient } from "./LinearReader.js";

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

export class LinearSdkReadClient implements LinearReadClient {
  constructor(private readonly client: LinearClient) {}

  static fromApiKey(apiKey: string): LinearSdkReadClient {
    return new LinearSdkReadClient(new LinearClient({ apiKey }));
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
}
