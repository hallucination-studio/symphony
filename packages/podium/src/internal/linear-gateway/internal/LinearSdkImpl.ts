import {
  LinearClient,
  type Comment,
  type Issue,
  type IssueLabel,
  type ProjectLabel,
} from "@linear/sdk";
import { randomUUID } from "node:crypto";

import type {
  LinearClientInterface,
  PageInfo,
} from "../api/LinearClientInterface.js";
import type {
  LinearIssueValue,
  LinearIssueState,
  LinearBlockerValue,
  LinearMutationCommand,
  LinearPriority,
  RootIssueValue,
  RootUsageValue,
} from "../types.js";

const PAGE_LIMIT = 250;
const MAX_TREE_NODES = 512;
const MAX_ROOT_COMMENTS = 4_096;
const ROOT_READ_CONCURRENCY = 8;
const CONDUCTOR_LABEL_PREFIX = "symphony:conductor/";
const ROOT_PHASE_PREFIX = "symphony:run/";
const ROOT_HEADER_MARKER = "<!-- symphony root\n";
const ROOT_HEADER_FACTS_QUERY = `
  query SymphonyRootHeaderFacts($rootIds: [ID!]!, $commentMarker: String!) {
    viewer { id }
    issues(first: 250, filter: { id: { in: $rootIds } }) {
      nodes {
        id identifier title description priority sortOrder updatedAt
        project { id }
        parent { id }
        delegate { id }
        state { name }
        comments(first: 2, filter: { body: { contains: $commentMarker } }) {
          nodes { id body updatedAt issue { id } }
          pageInfo { hasNextPage }
        }
        inverseRelations(first: 250) {
          nodes {
            type
            issue { id state { name } }
            relatedIssue { id }
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;
const ISSUE_TREE_ROOT_QUERY = `
  query SymphonyIssueTreeRoot($rootIssueId: ID!, $commentMarker: String!) {
    issue(id: $rootIssueId) {
      id identifier title description sortOrder updatedAt
      project { id }
      parent { id }
      state { name }
      labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
      comments(first: 2, filter: { body: { contains: $commentMarker } }) {
        nodes { id body updatedAt issue { id } }
        pageInfo { hasNextPage }
      }
      inverseRelations(first: 250) {
        nodes { type issue { id state { name } } relatedIssue { id } }
        pageInfo { hasNextPage }
      }
    }
  }
`;
const ISSUE_TREE_CHILDREN_QUERY = `
  query SymphonyIssueTreeChildren($parentIds: [ID!]!, $cursor: String) {
    issues(first: 250, after: $cursor, filter: { parent: { id: { in: $parentIds } } }) {
      nodes {
        id identifier title description sortOrder subIssueSortOrder updatedAt
        project { id }
        parent { id }
        state { name }
        comments(first: 64) {
          nodes { id body updatedAt issue { id } }
          pageInfo { hasNextPage }
        }
        inverseRelations(first: 250) {
          nodes { type issue { id state { name } } relatedIssue { id } }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const ROOT_SCOPE_ROOT_QUERY = `
  query SymphonyRootScopeRoot($rootIssueId: ID!, $commentMarker: String!) {
    issue(id: $rootIssueId) {
      id identifier updatedAt
      project { id }
      parent { id }
      state { name }
      comments(first: 2, filter: { body: { contains: $commentMarker } }) {
        nodes { id body updatedAt issue { id } }
        pageInfo { hasNextPage }
      }
    }
  }
`;
const ROOT_SCOPE_CHILDREN_QUERY = `
  query SymphonyRootScopeChildren($parentIds: [ID!]!, $cursor: String) {
    issues(first: 250, after: $cursor, filter: { parent: { id: { in: $parentIds } } }) {
      nodes { id identifier updatedAt project { id } parent { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const ROOT_MARKER_START = "<!-- symphony root\n";
const TURN_EVENT_MARKER =
  /\n*<!-- symphony turn event\nevent_key: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}:(?:0|[1-9][0-9]{0,15}))\n-->\s*$/;
const AGENT_WRITE_MARKER =
  /\n*<!-- symphony agent write\nwrite_id: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\n-->\s*$/;
const MANAGED_IDENTITY_MARKER =
  /\n*<!-- symphony managed marker\nmanaged_marker: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\n-->\s*$/;
const HUMAN_MARKER =
  /\n*<!-- symphony managed marker\nmanaged_marker: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\nkind: human\nhuman_kind: (plan_approval|planned_input|runtime_input)\ntarget_issue_id: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}|none)\n-->\s*$/;
const WORK_METADATA =
  /\n*<!-- symphony work metadata\nkind: work\norigin: (user|symphony)\ncompleted_input_hash: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}|none)\n-->\s*$/;

export type LinearSdkCredential =
  | { kind: "oauth"; token: string }
  | { kind: "development_token"; token: string; delegateActorId: string };

export interface LinearRequestWindowObservation {
  limit?: number;
  remaining?: number;
  reset?: number;
}

export interface LinearPhysicalRequestObservation {
  operation: string;
  correlationId: string;
  durationMs: number;
  status?: number;
  requestWindow?: LinearRequestWindowObservation;
  complexityWindow?: LinearRequestWindowObservation;
}

export interface LinearRequestObservationOptions {
  correlationId(): string;
  now(): number;
  permit?(): void;
  observe(observation: LinearPhysicalRequestObservation): void;
}

interface RootHeaderFactsData {
  viewer: { id: string };
  issues: {
    nodes: RootHeaderFact[];
    pageInfo: { hasNextPage: boolean };
  };
}

interface RootHeaderFact {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority: number;
  sortOrder: number;
  updatedAt: string;
  project?: { id: string } | null;
  parent?: { id: string } | null;
  delegate?: { id: string } | null;
  state: { name: string };
  comments: {
    nodes: Array<{
      id: string;
      body: string;
      updatedAt: string;
      issue: { id: string };
    }>;
    pageInfo: { hasNextPage: boolean };
  };
  inverseRelations: {
    nodes: Array<{
      type: string;
      issue?: { id: string; state: { name: string } } | null;
      relatedIssue?: { id: string } | null;
    }>;
    pageInfo: { hasNextPage: boolean };
  };
}

interface IssueTreeFact {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  sortOrder: number;
  subIssueSortOrder?: number | null;
  updatedAt: string;
  project?: { id: string } | null;
  parent?: { id: string } | null;
  state: { name: string };
  comments: {
    nodes: Array<{
      id: string;
      body: string;
      updatedAt: string;
      issue: { id: string };
    }>;
    pageInfo: { hasNextPage: boolean };
  };
  inverseRelations: RootHeaderFact["inverseRelations"];
}

interface IssueTreeRootFact extends IssueTreeFact {
  labels: {
    nodes: Array<{ name: string }>;
    pageInfo: { hasNextPage: boolean };
  };
}

interface IssueTreeRootData { issue?: IssueTreeRootFact | null }
interface IssueTreeChildrenData {
  issues: {
    nodes: IssueTreeFact[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
}

interface RootScopeIssueFact {
  id: string;
  identifier: string;
  updatedAt: string;
  project?: { id: string } | null;
  parent?: { id: string } | null;
}
interface RootScopeRootFact extends RootScopeIssueFact {
  state: { name: string };
  comments: IssueTreeFact["comments"];
}
interface RootScopeRootData { issue?: RootScopeRootFact | null }
interface RootScopeChildrenData {
  issues: {
    nodes: RootScopeIssueFact[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
}

export class LinearSdkImpl implements LinearClientInterface {
  readonly #client: LinearClient;
  readonly #delegateActorId: string | undefined;

  constructor(
    credential: LinearSdkCredential,
    private readonly organizationId: string,
    client?: LinearClient,
    observation?: LinearRequestObservationOptions,
  ) {
    this.#client = client ?? observedClient(credential, observation);
    this.#delegateActorId = credential.kind === "development_token"
      ? credential.delegateActorId
      : undefined;
  }

  static async discoverOrganizationId(accessToken: string): Promise<string> {
    const client = new LinearClient({ accessToken });
    const organization = await client.organization;
    if (!organization.id) throw new Error("linear_organization_missing");
    return organization.id;
  }

  static async discoverDevelopmentTokenOrganizationId(
    developmentToken: string,
    observe?: (observation: LinearPhysicalRequestObservation) => void,
  ): Promise<string> {
    const client = observedClient(
      { kind: "development_token", token: developmentToken, delegateActorId: "bootstrap" },
      observe
        ? { correlationId: randomUUID, now: Date.now, observe }
        : undefined,
    );
    const organization = await client.organization;
    if (!organization.id) throw new Error("linear_organization_missing");
    return organization.id;
  }

  async listProjects(input: {
    cursor?: string;
    limit: number;
  }): Promise<{
    items: Array<{
      projectId: string;
      organizationId: string;
      name: string;
      updatedAt: string;
    }>;
    pageInfo: PageInfo;
  }> {
    const organization = await this.#client.organization;
    if (organization.id !== this.organizationId) {
      throw new Error("linear_project_organization_mismatch");
    }
    const page = await this.#client.projects({
      first: input.limit,
      ...(input.cursor ? { after: input.cursor } : {}),
    });
    return {
      items: page.nodes.map((project) => ({
        projectId: project.id,
        organizationId: this.organizationId,
        name: project.name,
        slugId: project.slugId,
        updatedAt: project.updatedAt.toISOString(),
      })),
      pageInfo: pageInfo(page.pageInfo),
    };
  }

  async assignConductorProjectLabel(input: {
    projectId: string;
    labelName: string;
  }): Promise<void> {
    if (!input.labelName.startsWith(CONDUCTOR_LABEL_PREFIX)) {
      throw new Error("linear_conductor_label_invalid");
    }
    const project = await this.#client.project(input.projectId);
    const currentLabels = await allNodes(
      project.labels({ first: PAGE_LIMIT }),
      64,
    );
    const conductorLabels = currentLabels.filter(({ name }) =>
      name.startsWith(CONDUCTOR_LABEL_PREFIX),
    );
    if (
      conductorLabels.length > 1 ||
      (conductorLabels[0] && conductorLabels[0].name !== input.labelName)
    ) {
      throw new Error("linear_conductor_project_label_conflict");
    }
    const label = await this.#uniqueProjectLabel(input.labelName);
    const assignedProjects = await allNodes(
      label.projects({ first: PAGE_LIMIT }),
      2,
    );
    if (
      assignedProjects.length > 1 ||
      (assignedProjects[0] && assignedProjects[0].id !== input.projectId)
    ) {
      throw new Error("linear_conductor_label_project_conflict");
    }
    if (conductorLabels.length === 0) {
      await this.#client.projectAddLabel(input.projectId, label.id);
    }
    const labels = await allNodes(
      (await this.#client.project(input.projectId)).labels({
        first: PAGE_LIMIT,
      }),
      64,
    );
    const finalConductorLabels = labels.filter(({ name }) =>
      name.startsWith(CONDUCTOR_LABEL_PREFIX),
    );
    if (
      finalConductorLabels.length !== 1 ||
      finalConductorLabels[0]!.name !== input.labelName
    ) {
      throw ambiguousError("linear_project_label_read_back_failed");
    }
    const finalLabels = await this.#projectLabelsNamed(input.labelName);
    if (finalLabels.length !== 1) {
      throw ambiguousError("linear_project_label_read_back_failed");
    }
    const finalProjects = await allNodes(
      finalLabels[0]!.projects({ first: PAGE_LIMIT }),
      2,
    );
    if (
      finalProjects.length !== 1 ||
      finalProjects[0]!.id !== input.projectId
    ) {
      throw ambiguousError("linear_project_label_read_back_failed");
    }
  }

  async readProjectResolution(input: {
    conductorShortHash: string;
  }): ReturnType<LinearClientInterface["readProjectResolution"]> {
    const name = `${CONDUCTOR_LABEL_PREFIX}${input.conductorShortHash}`;
    const labels = await this.#projectLabelsNamed(name);
    if (labels.length === 0) return { kind: "unbound" };
    if (labels.length !== 1) return { kind: "conflict" };
    const projects = await allNodes(
      labels[0]!.projects({ first: PAGE_LIMIT }),
      2,
    );
    if (projects.length === 0) return { kind: "unbound" };
    if (projects.length !== 1) return { kind: "ambiguous" };
    const project = projects[0]!;
    const projectLabels = await allNodes(
      project.labels({ first: PAGE_LIMIT }),
      64,
    );
    if (
      projectLabels.filter(({ name: labelName }) =>
        labelName.startsWith(CONDUCTOR_LABEL_PREFIX),
      ).length !== 1
    ) {
      return { kind: "conflict" };
    }
    return {
      kind: "resolved",
      projectId: project.id,
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  async readMutationTarget(issueId: string) {
    const issue = await this.#client.issue(issueId);
    return mutationTarget(issue);
  }

  async readCommentTarget(commentId: string) {
    const comment = await this.#client.comment({ id: commentId });
    if (!comment.issueId) return undefined;
    return {
      issueId: comment.issueId,
      updatedAt: comment.updatedAt.toISOString(),
      ...(isRootManagedComment(comment.body)
        ? { managedMarker: rootCommentMarker(comment.issueId) }
        : {}),
    };
  }

  async readRootManagedComment(rootIssueId: string) {
    const comments = await this.#rootManagedComments(rootIssueId);
    if (comments.length > 1) throw new Error("linear_root_comment_ambiguous");
    const comment = comments[0];
    return comment
      ? {
          commentId: comment.id,
          issueId: rootIssueId,
          updatedAt: comment.updatedAt.toISOString(),
          managedMarker: rootCommentMarker(rootIssueId),
          body: comment.body,
        }
      : undefined;
  }

  async readManagedMarkerTarget(
    managedMarker: string,
  ): Promise<LinearIssueValue | undefined> {
    const page = await this.#client.issues({
      first: PAGE_LIMIT,
      filter: { description: { contains: managedMarker } },
    });
    const matches: Issue[] = [];
    for (const issue of page.nodes) {
      if (parseManagedDescription(issue.description ?? "").managedMarker === managedMarker) {
        matches.push(issue);
      }
    }
    if (page.pageInfo.hasNextPage) {
      throw new Error("linear_managed_marker_lookup_unbounded");
    }
    if (matches.length > 1) {
      throw new Error("linear_managed_marker_ambiguous");
    }
    return matches[0] ? issueValue(matches[0]) : undefined;
  }

  async executeMutation(
    command: LinearMutationCommand,
  ): Promise<void> {
    switch (command.kind) {
      case "create_managed_node": {
        const parent = await this.#client.issue(command.parentIssueId);
        if (!parent.teamId || parent.projectId !== command.project.expectedProjectId) {
          throw new Error("linear_managed_parent_invalid");
        }
        const payload = await this.#client.createIssue({
          teamId: parent.teamId,
          projectId: command.project.expectedProjectId,
          parentId: parent.id,
          title: command.title,
          description: serializeManagedDescription(
            command.description,
            command,
          ),
          stateId: await this.#stateId(parent, "Todo"),
          subIssueSortOrder: command.order,
        });
        if (!payload.success || !payload.issueId) {
          throw new Error("linear_create_managed_node_failed");
        }
        return;
      }
      case "update_managed_node": {
        const managedMarker = requiredMarker(command.precondition);
        const current = await this.#client.issue(
          command.precondition.expectedIssueId,
        );
        const parsed = parseManagedDescription(current.description ?? "");
        if (
          parsed.managedMarker !== managedMarker ||
          parsed.nodeKind !== command.nodeKind
        ) {
          throw preconditionConflictError();
        }
        await this.#client.updateIssue(command.precondition.expectedIssueId, {
          title: command.title,
          description: serializeManagedDescription(
            command.description,
            {
              ...command,
              managedMarker,
            },
            command.completedInputHash ?? parsed.completedInputHash,
          ),
        });
        return;
      }
      case "update_issue_state": {
        const issue = await this.#client.issue(command.precondition.expectedIssueId);
        await this.#client.updateIssue(issue.id, {
          stateId: await this.#stateId(issue, command.state),
        });
        return;
      }
      case "update_issue_assignee":
        await this.#client.updateIssue(command.precondition.expectedIssueId, {
          assigneeId: command.assigneeId,
        });
        return;
      case "update_issue_label": {
        const issueId = command.precondition.expectedIssueId;
        const issue = await this.#client.issue(issueId);
        const labels = await allNodes(issue.labels({ first: PAGE_LIMIT }), 64);
        const matches = labels.filter(({ name }) => name === command.label);
        if (matches.length > 1) throw new Error("linear_issue_label_ambiguous");
        if (command.operation === "remove") {
          if (matches[0]) await this.#client.issueRemoveLabel(issueId, matches[0].id);
          return;
        }
        const label = await this.#uniqueIssueLabel(command.label, issue.teamId);
        if (!labels.some(({ id }) => id === label.id)) {
          await this.#client.issueAddLabel(issueId, label.id);
        }
        return;
      }
      case "create_issue_comment": {
        if (command.body.match(AGENT_WRITE_MARKER)?.[1] !== command.writeId) {
          throw new Error("linear_agent_comment_marker_invalid");
        }
        await this.#client.createComment({
          issueId: command.precondition.expectedIssueId,
          body: command.body,
        });
        return;
      }
      case "reorder_issue_node":
        await this.#client.updateIssue(command.precondition.expectedIssueId, {
          parentId: command.parentIssueId,
          subIssueSortOrder: command.order,
        });
        return;
      case "replace_root_phase_label":
        await this.#replaceRootPhase(command);
        return;
      case "upsert_root_managed_comment":
        await this.#upsertRootComment(command);
        return;
      case "project_root_comment":
        await this.#projectRootComment(command);
        return;
    }
  }

  async #stateId(issue: Issue, state: LinearIssueState): Promise<string> {
    if (!issue.team) throw new Error("linear_issue_team_missing");
    const team = await issue.team;
    const states = await allNodes(team.states({
      first: 2,
      includeArchived: false,
      filter: { name: { eq: state } },
    }), 2);
    const matches = states.filter(({ name }) => name === state);
    if (matches.length !== 1) throw new Error("linear_state_ambiguous");
    return matches[0]!.id;
  }

  async readMutationOutcome(
    command: LinearMutationCommand,
  ): Promise<{ issue?: LinearIssueValue } | undefined> {
    switch (command.kind) {
      case "create_managed_node": {
        const issue = await this.readManagedMarkerTarget(command.managedMarker);
        return issue &&
          issue.projectId === command.project.expectedProjectId &&
          issue.parentIssueId === command.parentIssueId &&
          issue.title === command.title &&
          issue.description === command.description &&
          issue.order === command.order &&
          managedNodeMatches(issue, command)
          ? { issue }
          : undefined;
      }
      case "update_managed_node": {
        const issue = await this.#client.issue(command.precondition.expectedIssueId);
        const value = await issueValue(issue);
        return value.title === command.title &&
          value.description === command.description &&
          value.managedMarker === command.precondition.expectedManagedMarker &&
          (command.completedInputHash === undefined ||
            value.completedInputHash === command.completedInputHash) &&
          managedNodeMatches(value, command)
          ? { issue: value }
          : undefined;
      }
      case "update_issue_state": {
        const issue = await issueValue(
          await this.#client.issue(command.precondition.expectedIssueId),
        );
        return issue.state === command.state
          ? { issue }
          : undefined;
      }
      case "update_issue_assignee": {
        const issue = await this.#client.issue(command.precondition.expectedIssueId);
        return issue.assigneeId === command.assigneeId
          ? { issue: await issueValue(issue) }
          : undefined;
      }
      case "update_issue_label": {
        const issue = await this.#client.issue(command.precondition.expectedIssueId);
        const labels = await allNodes(issue.labels({ first: PAGE_LIMIT }), 64);
        const present = labels.some(({ name }) => name === command.label);
        return present === (command.operation === "add")
          ? { issue: await issueValue(issue) }
          : undefined;
      }
      case "create_issue_comment": {
        if (command.body.match(AGENT_WRITE_MARKER)?.[1] !== command.writeId) {
          return undefined;
        }
        const issue = await this.#client.issue(command.precondition.expectedIssueId);
        const comments = await this.#rootComments(issue);
        const matches = comments.filter(({ body }) =>
          body.match(AGENT_WRITE_MARKER)?.[1] === command.writeId);
        if (matches.length > 1) throw new Error("linear_agent_comment_ambiguous");
        if (matches[0] && matches[0].body !== command.body) {
          throw new Error("linear_agent_comment_mismatch");
        }
        return matches.length === 1 ? { issue: await issueValue(issue) } : undefined;
      }
      case "reorder_issue_node": {
        const issue = await issueValue(
          await this.#client.issue(command.precondition.expectedIssueId),
        );
        return issue.parentIssueId === command.parentIssueId &&
          issue.order === command.order
          ? { issue }
          : undefined;
      }
      case "replace_root_phase_label": {
        const issue = await this.#client.issue(command.precondition.expectedIssueId);
        const labels = await allNodes(issue.labels({ first: PAGE_LIMIT }), 64);
        const phases = labels.filter(({ name }) =>
          name.startsWith(ROOT_PHASE_PREFIX),
        );
        return phases.length === 1 &&
          phases[0]!.name === `${ROOT_PHASE_PREFIX}${command.phase}`
          ? { issue: await issueValue(issue) }
          : undefined;
      }
      case "upsert_root_managed_comment": {
        if (
          command.managedMarker !==
          rootCommentMarker(command.rootPrecondition.expectedIssueId)
        ) {
          return undefined;
        }
        const comments = await this.#rootManagedComments(
          command.rootPrecondition.expectedIssueId,
        );
        return comments.length === 1 && comments[0]!.body === command.body
          ? {
              issue: await issueValue(
                await this.#client.issue(
                  command.rootPrecondition.expectedIssueId,
                ),
              ),
            }
          : undefined;
      }
      case "project_root_comment": {
        const issue = await this.#client.issue(command.rootIssueId);
        const value = await issueValue(issue);
        if (value.projectId !== command.project.expectedProjectId) return undefined;
        if (command.commentId) {
          const comment = await this.#client.comment({ id: command.commentId });
          return isPrimaryCommentForRoot(
            comment,
            command.rootIssueId,
            command.body,
          ) &&
            comment.body === command.body
            ? { issue: value }
            : undefined;
        }
        if (command.eventKey === undefined) return undefined;
        const comments = await this.#rootComments(issue);
        const matches = timelineComments(comments, command.eventKey);
        if (matches.length > 1) {
          throw new Error("linear_turn_event_comment_ambiguous");
        }
        if (matches[0] && matches[0].body !== command.body) {
          throw new Error("linear_turn_event_comment_mismatch");
        }
        if (matches.length !== 1) return undefined;
        return { issue: value };
      }
    }
  }

  async listRootIssues(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: RootIssueValue[]; pageInfo: PageInfo }> {
    const project = await this.#client.project(input.projectId);
    const page = await project.issues({
      first: input.limit,
      ...(input.cursor ? { after: input.cursor } : {}),
    });
    const roots = page.nodes.flatMap((issue) => {
      if (issue.projectId !== input.projectId) {
        throw new Error("linear_root_project_mismatch");
      }
      return issue.parentId
        ? []
        : [{ issue, priority: linearPriority(issue.priority) }];
    });
    const batched = await this.#batchedRootHeaders(input.projectId, roots);
    if (batched) return { items: batched, pageInfo: pageInfo(page.pageInfo) };
    const delegateActorId = this.#delegateActorId ?? (await this.#client.viewer).id;
    const items = await mapConcurrent(
      roots,
      ROOT_READ_CONCURRENCY,
      async ({ issue, priority }) => {
        const [value, blockers, rootManagedComments] = await Promise.all([
          issueValue(issue, 0),
          blockerValues(issue),
          this.#rootManagedCommentValues(issue),
        ]);
        return {
          issue: value,
          isDelegatedToSymphony: issue.delegateId === delegateActorId,
          priority,
          blockers,
          rootManagedComments,
        };
      },
    );
    return { items, pageInfo: pageInfo(page.pageInfo) };
  }

  async #batchedRootHeaders(
    projectId: string,
    roots: Array<{ issue: Issue; priority: LinearPriority }>,
  ): Promise<RootIssueValue[] | undefined> {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest || roots.length === 0) return roots.length === 0 ? [] : undefined;
    const response = await rawRequest<RootHeaderFactsData, {
      rootIds: string[];
      commentMarker: string;
    }>(ROOT_HEADER_FACTS_QUERY, {
      rootIds: roots.map(({ issue }) => issue.id),
      commentMarker: ROOT_HEADER_MARKER,
    });
    const data = response.data;
    if (!data || data.issues.pageInfo.hasNextPage) {
      throw new Error("linear_root_header_batch_incomplete");
    }
    const factsById = new Map(data.issues.nodes.map((fact) => [fact.id, fact]));
    if (factsById.size !== roots.length) {
      throw new Error("linear_root_header_batch_incomplete");
    }
    const delegateActorId = this.#delegateActorId ?? data.viewer.id;
    return roots.map(({ issue }) => {
      const fact = factsById.get(issue.id);
      if (!fact || fact.project?.id !== projectId || fact.parent !== null) {
        throw new Error("linear_root_header_batch_invalid");
      }
      if (fact.comments.pageInfo.hasNextPage || fact.comments.nodes.length > 2) {
        throw new Error("linear_root_comments_too_many");
      }
      if (fact.inverseRelations.pageInfo.hasNextPage) {
        throw new Error("linear_root_relations_too_many");
      }
      const rootManagedComments = fact.comments.nodes.flatMap((comment) => {
        if (comment.issue.id !== fact.id) {
          throw new Error("linear_root_comment_identity_mismatch");
        }
        if (!isRootManagedComment(comment.body)) return [];
        return [{
          commentId: comment.id,
          issueId: fact.id,
          updatedAt: timestampValue(comment.updatedAt),
          managedMarker: rootCommentMarker(fact.id),
          body: comment.body,
        }];
      });
      const blockers = fact.inverseRelations.nodes.flatMap((relation) => {
        if (relation.type !== "blocks") return [];
        if (!relation.issue || relation.relatedIssue?.id !== fact.id || relation.issue.id === fact.id) {
          throw new Error("linear_blocker_relation_invalid");
        }
        return [{
          sourceIssueId: fact.id,
          targetIssueId: relation.issue.id,
          targetState: linearIssueState(relation.issue.state.name),
        }];
      });
      return {
        issue: {
          issueId: fact.id,
          identifier: fact.identifier,
          projectId,
          state: linearIssueState(fact.state.name),
          order: fact.sortOrder,
          depth: 0,
          title: fact.title,
          description: parseManagedDescription(fact.description ?? "").businessDescription,
          updatedAt: timestampValue(fact.updatedAt),
        },
        isDelegatedToSymphony: fact.delegate?.id === delegateActorId,
        priority: linearPriority(fact.priority),
        blockers,
        rootManagedComments,
      };
    });
  }

  async getIssueTree(input: {
    projectId: string;
    rootIssueId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    nodes: LinearIssueValue[];
    rootPhaseLabels: string[];
    rootManagedComments: Array<{
      commentId: string;
      issueId: string;
      updatedAt: string;
      managedMarker: string;
      body: string;
    }>;
    humanAnswers: Array<{
      humanIssueId: string;
      commentId: string;
      answer: string;
      updatedAt: string;
    }>;
    observedAt: string;
    pageInfo: PageInfo;
  }> {
    if (input.cursor) throw new Error("linear_tree_cursor_invalid");
    const batched = await this.#batchedIssueTree(input.projectId, input.rootIssueId);
    if (batched) return batched;
    const root = await this.#client.issue(input.rootIssueId);
    if (root.projectId !== input.projectId || root.parentId) {
      throw new Error("linear_tree_root_invalid");
    }
    const nodes: LinearIssueValue[] = [];
    await collectTree(root, input.projectId, 0, nodes);
    const labels = await allNodes(root.labels({ first: PAGE_LIMIT }), 64);
    const rootPhaseLabels = labels
      .filter(({ name }) => name.startsWith(ROOT_PHASE_PREFIX))
      .map(({ name }) => name.slice(ROOT_PHASE_PREFIX.length));
    if (rootPhaseLabels.length > 2) {
      throw new Error("linear_root_phase_labels_too_many");
    }
    const rootManagedComments = await this.#rootManagedCommentValues(root);
    return {
      nodes,
      rootPhaseLabels,
      rootManagedComments,
      humanAnswers: await this.#humanAnswers(nodes),
      observedAt: new Date().toISOString(),
      pageInfo: { hasNextPage: false },
    };
  }

  async #batchedIssueTree(projectId: string, rootIssueId: string) {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest) return undefined;
    const rootResponse = await rawRequest<IssueTreeRootData, {
      rootIssueId: string;
      commentMarker: string;
    }>(ISSUE_TREE_ROOT_QUERY, { rootIssueId, commentMarker: ROOT_HEADER_MARKER });
    const root = rootResponse.data?.issue;
    if (!root || root.id !== rootIssueId || root.project?.id !== projectId || root.parent !== null) {
      throw new Error("linear_tree_root_invalid");
    }
    if (
      root.labels.pageInfo.hasNextPage ||
      root.comments.pageInfo.hasNextPage ||
      root.inverseRelations.pageInfo.hasNextPage
    ) {
      throw new Error("linear_tree_batch_incomplete");
    }
    validateTreeRelations(root);

    const facts = new Map<string, { fact: IssueTreeFact; depth: number }>([
      [root.id, { fact: root, depth: 0 }],
    ]);
    const childrenByParent = new Map<string, IssueTreeFact[]>();
    let parentIds = [root.id];
    let childDepth = 1;
    while (parentIds.length > 0) {
      const parentSet = new Set(parentIds);
      const depthFacts: IssueTreeFact[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const response = await rawRequest<IssueTreeChildrenData, {
          parentIds: string[];
          cursor?: string;
        }>(ISSUE_TREE_CHILDREN_QUERY, {
          parentIds,
          ...(cursor ? { cursor } : {}),
        });
        const page = response.data?.issues;
        if (!page) throw new Error("linear_tree_batch_incomplete");
        for (const fact of page.nodes) {
          if (
            fact.project?.id !== projectId ||
            !fact.parent ||
            !parentSet.has(fact.parent.id)
          ) {
            throw new Error("linear_tree_batch_invalid");
          }
          if (
            fact.comments.pageInfo.hasNextPage ||
            fact.inverseRelations.pageInfo.hasNextPage
          ) {
            throw new Error("linear_tree_batch_incomplete");
          }
          if (facts.has(fact.id)) throw new Error("linear_tree_batch_ambiguous");
          if (childDepth > 32 || facts.size >= MAX_TREE_NODES) {
            throw new Error("linear_tree_bounds_exceeded");
          }
          validateTreeRelations(fact);
          facts.set(fact.id, { fact, depth: childDepth });
          depthFacts.push(fact);
          const siblings = childrenByParent.get(fact.parent.id) ?? [];
          siblings.push(fact);
          childrenByParent.set(fact.parent.id, siblings);
        }
        if (!page.pageInfo.hasNextPage) {
          cursor = undefined;
          break;
        }
        const nextCursor = page.pageInfo.endCursor;
        if (!nextCursor || seenCursors.has(nextCursor)) {
          throw new Error("linear_tree_batch_incomplete");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
      parentIds = depthFacts.map(({ id }) => id);
      childDepth += 1;
    }

    for (const siblings of childrenByParent.values()) siblings.sort(compareTreeFacts);
    const nodes: LinearIssueValue[] = [];
    const append = (id: string) => {
      const entry = facts.get(id);
      if (!entry) throw new Error("linear_tree_batch_incomplete");
      nodes.push(treeFactValue(entry.fact, entry.depth));
      for (const child of childrenByParent.get(id) ?? []) append(child.id);
    };
    append(root.id);

    const rootPhaseLabels = root.labels.nodes
      .filter(({ name }) => name.startsWith(ROOT_PHASE_PREFIX))
      .map(({ name }) => name.slice(ROOT_PHASE_PREFIX.length));
    if (rootPhaseLabels.length > 2) throw new Error("linear_root_phase_labels_too_many");
    const rootManagedComments = root.comments.nodes.flatMap((comment) => {
      if (comment.issue.id !== root.id) throw new Error("linear_root_comment_identity_mismatch");
      if (!isRootManagedComment(comment.body)) return [];
      return [{
        commentId: comment.id,
        issueId: root.id,
        updatedAt: timestampValue(comment.updatedAt),
        managedMarker: rootCommentMarker(root.id),
        body: comment.body,
      }];
    });
    const humanAnswers = nodes.flatMap((node) => {
      if (node.nodeKind !== "human" || node.state !== "Done") return [];
      const fact = facts.get(node.issueId)!.fact;
      return fact.comments.nodes.flatMap((comment) => {
        if (comment.issue.id !== node.issueId) {
          throw new Error("linear_human_answer_identity_mismatch");
        }
        const answer = comment.body.trim();
        return answer ? [{
          humanIssueId: node.issueId,
          commentId: comment.id,
          answer,
          updatedAt: timestampValue(comment.updatedAt),
        }] : [];
      });
    });
    return {
      nodes,
      rootPhaseLabels,
      rootManagedComments,
      humanAnswers,
      observedAt: new Date().toISOString(),
      pageInfo: { hasNextPage: false as const },
    };
  }

  async getRootScope(input: { projectId: string; rootIssueId: string }) {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest) throw new Error("linear_root_scope_transport_unavailable");
    const rootResponse = await rawRequest<RootScopeRootData, {
      rootIssueId: string;
      commentMarker: string;
    }>(ROOT_SCOPE_ROOT_QUERY, {
      rootIssueId: input.rootIssueId,
      commentMarker: ROOT_HEADER_MARKER,
    });
    const root = rootResponse.data?.issue;
    if (
      !root || root.id !== input.rootIssueId ||
      root.project?.id !== input.projectId || root.parent !== null
    ) {
      throw new Error("linear_root_scope_root_invalid");
    }
    if (root.comments.pageInfo.hasNextPage || root.comments.nodes.length > 1) {
      throw new Error("linear_root_scope_authority_ambiguous");
    }
    const comment = root.comments.nodes[0];
    if (comment && comment.issue.id !== root.id) {
      throw new Error("linear_root_comment_identity_mismatch");
    }
    const authority = comment
      ? parseRootScopeAuthority(comment.body)
      : { conductorId: "unclaimed" };
    const issues: Array<{
      issueId: string;
      identifier: string;
      parentIssueId?: string;
      updatedAt: string;
    }> = [{
      issueId: root.id,
      identifier: root.identifier,
      updatedAt: timestampValue(root.updatedAt),
    }];
    const seenIds = new Set([root.id]);
    let parentIds = [root.id];
    while (parentIds.length > 0) {
      const parentSet = new Set(parentIds);
      const nextParentIds: string[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await rawRequest<RootScopeChildrenData, {
          parentIds: string[];
          cursor?: string;
        }>(ROOT_SCOPE_CHILDREN_QUERY, {
          parentIds,
          ...(cursor ? { cursor } : {}),
        });
        const page = response.data?.issues;
        if (!page) throw new Error("linear_root_scope_incomplete");
        for (const fact of page.nodes) {
          if (
            fact.project?.id !== input.projectId || !fact.parent ||
            !parentSet.has(fact.parent.id)
          ) {
            throw new Error("linear_root_scope_issue_invalid");
          }
          if (seenIds.has(fact.id)) throw new Error("linear_root_scope_ambiguous");
          if (issues.length >= MAX_TREE_NODES) throw new Error("linear_tree_bounds_exceeded");
          seenIds.add(fact.id);
          nextParentIds.push(fact.id);
          issues.push({
            issueId: fact.id,
            identifier: fact.identifier,
            parentIssueId: fact.parent.id,
            updatedAt: timestampValue(fact.updatedAt),
          });
        }
        if (!page.pageInfo.hasNextPage) {
          cursor = undefined;
          break;
        }
        const nextCursor = page.pageInfo.endCursor;
        if (!nextCursor || seenCursors.has(nextCursor)) {
          throw new Error("linear_root_scope_incomplete");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
      parentIds = nextParentIds;
    }
    const state = linearIssueState(root.state.name);
    return {
      rootIssueId: root.id,
      ...authority,
      terminal: state === "Done" || state === "Canceled",
      issues,
      observedAt: new Date().toISOString(),
    };
  }

  async #humanAnswers(nodes: LinearIssueValue[]) {
    const answers = [];
    for (const node of nodes) {
      if (node.nodeKind !== "human" || node.state !== "Done") continue;
      const issue = await this.#client.issue(node.issueId);
      const comments = await allNodes(issue.comments({ first: PAGE_LIMIT }), 64);
      for (const comment of comments) {
        const answer = comment.body.trim();
        if (!answer) continue;
        answers.push({
          humanIssueId: node.issueId,
          commentId: comment.id,
          answer,
          updatedAt: comment.updatedAt.toISOString(),
        });
      }
    }
    return answers;
  }

  async listRootUsage(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: RootUsageValue[]; pageInfo: PageInfo }> {
    const roots = await this.listRootIssues(input);
    for (const root of roots.items) {
      const comments = root.rootManagedComments;
      if (comments.length > 1) throw new Error("linear_root_comment_ambiguous");
    }
    return { items: [], pageInfo: roots.pageInfo };
  }

  async #replaceRootPhase(
    command: Extract<LinearMutationCommand, { kind: "replace_root_phase_label" }>,
  ) {
    const issueId = command.precondition.expectedIssueId;
    const issue = await this.#client.issue(issueId);
    const desired = await this.#uniqueIssueLabel(
      `${ROOT_PHASE_PREFIX}${command.phase}`,
      issue.teamId,
    );
    const labels = await allNodes(issue.labels({ first: PAGE_LIMIT }), 64);
    for (const label of labels) {
      if (label.name.startsWith(ROOT_PHASE_PREFIX) && label.id !== desired.id) {
        await this.#client.issueRemoveLabel(issueId, label.id);
      }
    }
    if (!labels.some(({ id }) => id === desired.id)) {
      await this.#client.issueAddLabel(issueId, desired.id);
    }
  }

  async #upsertRootComment(
    command: Extract<LinearMutationCommand, { kind: "upsert_root_managed_comment" }>,
  ) {
    if (
      command.managedMarker !==
      rootCommentMarker(command.rootPrecondition.expectedIssueId)
    ) {
      throw new Error("linear_root_comment_marker_invalid");
    }
    if (!isRootManagedComment(command.body)) {
      throw new Error("linear_root_comment_marker_invalid");
    }
    if (command.commentPrecondition) {
      await this.#client.updateComment(
        command.commentPrecondition.expectedIssueId,
        { body: command.body },
      );
      return;
    }
    const existing = await this.#rootManagedComments(
      command.rootPrecondition.expectedIssueId,
    );
    if (existing.length > 1) throw new Error("linear_root_comment_ambiguous");
    if (existing[0]) {
      throw preconditionConflictError();
    }
    await this.#client.createComment({
      issueId: command.rootPrecondition.expectedIssueId,
      body: command.body,
    });
  }

  async #projectRootComment(
    command: Extract<LinearMutationCommand, { kind: "project_root_comment" }>,
  ) {
    const issue = await this.#client.issue(command.rootIssueId);
    const value = await issueValue(issue);
    if (value.projectId !== command.project.expectedProjectId) {
      throw new Error("linear_project_mismatch");
    }
    if (command.commentId) {
      const comment = await this.#client.comment({ id: command.commentId });
      if (!isPrimaryCommentForRoot(comment, command.rootIssueId, command.body)) {
        throw new Error("linear_root_comment_identity_mismatch");
      }
      await this.#client.updateComment(command.commentId, { body: command.body });
      return;
    }
    if (command.eventKey === undefined) {
      throw new Error("linear_root_comment_identity_missing");
    }
    if (command.body.match(TURN_EVENT_MARKER)?.[1] !== command.eventKey) {
      throw new Error("linear_turn_event_marker_invalid");
    }
    const comments = await this.#rootComments(issue);
    const matches = timelineComments(comments, command.eventKey);
    if (matches.length > 1) throw new Error("linear_turn_event_comment_ambiguous");
    if (matches[0]) {
      if (matches[0].body !== command.body) {
        throw new Error("linear_turn_event_comment_mismatch");
      }
      throw preconditionConflictError();
    }
    await this.#client.createComment({ issueId: command.rootIssueId, body: command.body });
  }

  async #rootComments(issue: Issue): Promise<Comment[]> {
    return allNodes(
      issue.comments({ first: PAGE_LIMIT }),
      MAX_ROOT_COMMENTS,
    );
  }

  async #rootManagedComments(issueId: string): Promise<Comment[]> {
    const issue = await this.#client.issue(issueId);
    const comments = await this.#rootComments(issue);
    return comments.filter(({ body }) => isRootManagedComment(body));
  }

  async #rootManagedCommentValues(issue: Issue) {
    const comments = (await this.#rootComments(issue))
      .filter(({ body }) => isRootManagedComment(body));
    if (comments.length > 2) {
      throw new Error("linear_root_comments_too_many");
    }
    return comments.map((comment) => ({
      commentId: comment.id,
      issueId: issue.id,
      updatedAt: comment.updatedAt.toISOString(),
      managedMarker: rootCommentMarker(issue.id),
      body: comment.body,
    }));
  }

  async #projectLabelsNamed(name: string): Promise<ProjectLabel[]> {
    const labels = await allNodes(
      this.#client.projectLabels({
        first: 3,
        includeArchived: false,
        filter: { name: { eq: name }, isGroup: { eq: false } },
      }),
      3,
    );
    const matches = labels.filter(
      (label) =>
        label.name === name &&
        !label.isGroup &&
        !label.archivedAt &&
        !label.retiredById,
    );
    for (const label of matches) {
      const organization = await label.organization;
      if (organization.id !== this.organizationId) {
        throw new Error("linear_label_organization_mismatch");
      }
    }
    return matches;
  }

  async #uniqueProjectLabel(name: string): Promise<ProjectLabel> {
    const matches = await this.#projectLabelsNamed(name);
    if (matches.length > 1) throw new Error("linear_project_label_ambiguous");
    if (matches[0]) return matches[0];
    const payload = await this.#client.createProjectLabel({
      name,
      color: "#5E6AD2",
      isGroup: false,
    });
    const label = payload.projectLabel ? await payload.projectLabel : undefined;
    if (!payload.success || !label) throw new Error("linear_project_label_create_failed");
    const organization = await label.organization;
    if (organization.id !== this.organizationId) {
      throw new Error("linear_label_organization_mismatch");
    }
    return label;
  }

  async #uniqueIssueLabel(
    name: string,
    teamId?: string,
  ): Promise<IssueLabel> {
    const labels = await allNodes(
      this.#client.issueLabels({
        first: 3,
        includeArchived: false,
        filter: { name: { eq: name }, isGroup: { eq: false } },
      }),
      3,
    );
    const matches = labels.filter(
      (label) =>
        label.name === name &&
        !label.isGroup &&
        !label.archivedAt &&
        !label.retiredById &&
        (label.teamId === undefined || label.teamId === teamId),
    );
    for (const label of matches) {
      const organization = await label.organization;
      if (organization.id !== this.organizationId) {
        throw new Error("linear_label_organization_mismatch");
      }
    }
    if (matches.length > 1) throw new Error("linear_issue_label_ambiguous");
    if (matches[0]) return matches[0];
    const payload = await this.#client.createIssueLabel({
      name,
      color: "#5E6AD2",
      isGroup: false,
      ...(teamId ? { teamId } : {}),
    });
    const label = payload.issueLabel ? await payload.issueLabel : undefined;
    if (!payload.success || !label) throw new Error("linear_issue_label_create_failed");
    const organization = await label.organization;
    if (organization.id !== this.organizationId) {
      throw new Error("linear_label_organization_mismatch");
    }
    return label;
  }
}

function isPrimaryCommentForRoot(
  comment: Comment | undefined,
  rootIssueId: string,
  nextBody: string,
): comment is Comment {
  return comment?.issueId === rootIssueId &&
    isRootManagedComment(comment.body) &&
    isRootManagedComment(nextBody);
}

function timelineComments(comments: Comment[], eventKey: string): Comment[] {
  return comments.filter(({ body }) =>
    body.match(TURN_EVENT_MARKER)?.[1] === eventKey
  );
}

function clientOptions(credential: LinearSdkCredential):
  | { accessToken: string }
  | { apiKey: string } {
  return credential.kind === "oauth"
    ? { accessToken: credential.token }
    : { apiKey: credential.token };
}

function observedClient(
  credential: LinearSdkCredential,
  observation: LinearRequestObservationOptions | undefined,
): LinearClient {
  const client = new LinearClient(clientOptions(credential));
  if (!observation) return client;
  const graphQLClient = client.client;
  const rawRequest = graphQLClient.rawRequest.bind(graphQLClient);
  graphQLClient.request = async function requestWithObservation<
    Data,
    Variables extends Record<string, unknown>,
  >(
    document: string,
    variables?: Variables,
    headers?: RequestInit["headers"],
  ): Promise<Data> {
    const response = await observeRequest(
      document,
      observation,
      () => rawRequest<Data, Variables>(document, variables, headers),
    );
    if (response.data === undefined) throw new Error("linear_response_data_missing");
    return response.data;
  };
  graphQLClient.rawRequest = async (query, variables, headers) => observeRequest(
    query,
    observation,
    () => rawRequest(query, variables, headers),
  );
  return client;
}

async function observeRequest<Result>(
  document: string,
  observation: LinearRequestObservationOptions,
  request: () => Promise<Result>,
): Promise<Result> {
  observation.permit?.();
  const startedAt = observation.now();
  const correlationId = observation.correlationId();
  try {
    const result = await request();
    const response = responseMetadata(result);
    observation.observe(requestObservation(
      document,
      correlationId,
      observation.now() - startedAt,
      response.status,
      response.headers,
    ));
    return result;
  } catch (error) {
    const response = errorResponseMetadata(error);
    observation.observe(requestObservation(
      document,
      correlationId,
      observation.now() - startedAt,
      response.status,
      response.headers,
    ));
    throw error;
  }
}

function requestObservation(
  document: string,
  correlationId: string,
  durationMs: number,
  status: number | undefined,
  headers: Headers | undefined,
): LinearPhysicalRequestObservation {
  const requestWindow = rateWindow(headers, "x-ratelimit-requests");
  const complexityWindow = rateWindow(headers, "x-ratelimit-complexity");
  return {
    operation: operationName(document),
    correlationId,
    durationMs: Math.max(0, durationMs),
    ...(status === undefined ? {} : { status }),
    ...(requestWindow ? { requestWindow } : {}),
    ...(complexityWindow ? { complexityWindow } : {}),
  };
}

function responseMetadata(value: unknown): {
  status?: number;
  headers?: Headers;
} {
  if (value === null || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.status === "number" ? { status: record.status } : {}),
    ...(record.headers instanceof Headers ? { headers: record.headers } : {}),
  };
}

function errorResponseMetadata(error: unknown): {
  status?: number;
  headers?: Headers;
} {
  const record = errorRecord(error);
  const direct = responseMetadata(error);
  const response = responseMetadata(record.response);
  const rawResponse = responseMetadata(errorRecord(record.raw).response);
  return {
    ...(direct.status ?? response.status ?? rawResponse.status) === undefined
      ? {}
      : { status: direct.status ?? response.status ?? rawResponse.status },
    ...(direct.headers ?? response.headers ?? rawResponse.headers) === undefined
      ? {}
      : { headers: direct.headers ?? response.headers ?? rawResponse.headers },
  };
}

function rateWindow(
  headers: Headers | undefined,
  prefix: string,
): LinearRequestWindowObservation | undefined {
  if (!headers) return undefined;
  const limit = nonnegativeHeader(headers, `${prefix}-limit`);
  const remaining = nonnegativeHeader(headers, `${prefix}-remaining`);
  const reset = nonnegativeHeader(headers, `${prefix}-reset`);
  if (limit === undefined && remaining === undefined && reset === undefined) {
    return undefined;
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(reset === undefined ? {} : { reset }),
  };
}

function nonnegativeHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function operationName(document: string): string {
  return document.match(/\b(?:query|mutation)\s+([A-Za-z][A-Za-z0-9_]{0,127})\b/u)?.[1]
    ?? "unknown";
}

function errorRecord(error: unknown): Record<string, unknown> {
  return error !== null && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
}

async function collectTree(
  issue: Issue,
  projectId: string,
  depth: number,
  output: LinearIssueValue[],
): Promise<void> {
  if (depth > 32 || output.length >= MAX_TREE_NODES) {
    throw new Error("linear_tree_bounds_exceeded");
  }
  if (issue.projectId !== projectId) throw new Error("linear_project_mismatch");
  output.push(await issueValue(issue, depth));
  const children = await allNodes(issue.children({ first: PAGE_LIMIT }), MAX_TREE_NODES);
  children.sort(
    (left, right) =>
      (left.subIssueSortOrder ?? left.sortOrder) -
        (right.subIssueSortOrder ?? right.sortOrder) ||
      left.identifier.localeCompare(right.identifier),
  );
  for (const child of children) {
    if (child.parentId !== issue.id) throw new Error("linear_parent_mismatch");
    await collectTree(child, projectId, depth + 1, output);
  }
}

function compareTreeFacts(left: IssueTreeFact, right: IssueTreeFact): number {
  return (left.subIssueSortOrder ?? left.sortOrder) -
      (right.subIssueSortOrder ?? right.sortOrder) ||
    left.identifier.localeCompare(right.identifier);
}

function treeFactValue(fact: IssueTreeFact, depth: number): LinearIssueValue {
  const managed = parseManagedDescription(fact.description ?? "");
  return {
    issueId: fact.id,
    identifier: fact.identifier,
    ...(fact.project ? { projectId: fact.project.id } : {}),
    ...(fact.parent ? { parentIssueId: fact.parent.id } : {}),
    state: linearIssueState(fact.state.name),
    order: fact.subIssueSortOrder ?? fact.sortOrder,
    depth,
    title: fact.title,
    description: managed.businessDescription,
    ...(managed.managedMarker ? { managedMarker: managed.managedMarker } : {}),
    ...(managed.nodeKind ? { nodeKind: managed.nodeKind } : {}),
    ...(managed.humanKind ? { humanKind: managed.humanKind } : {}),
    ...(managed.origin ? { origin: managed.origin } : {}),
    ...(managed.completedInputHash ? { completedInputHash: managed.completedInputHash } : {}),
    ...(managed.targetIssueId ? { targetIssueId: managed.targetIssueId } : {}),
    updatedAt: timestampValue(fact.updatedAt),
  };
}

function validateTreeRelations(fact: IssueTreeFact): void {
  for (const relation of fact.inverseRelations.nodes) {
    if (relation.type !== "blocks") continue;
    if (!relation.issue || relation.relatedIssue?.id !== fact.id || relation.issue.id === fact.id) {
      throw new Error("linear_blocker_relation_invalid");
    }
    linearIssueState(relation.issue.state.name);
  }
}

async function mutationTarget(issue: Issue) {
  const value = await issueValue(issue);
  return {
    issueId: value.issueId,
    updatedAt: value.updatedAt,
    ...(value.state ? { state: value.state } : {}),
    ...(value.parentIssueId ? { parentIssueId: value.parentIssueId } : {}),
    ...(value.managedMarker ? { managedMarker: value.managedMarker } : {}),
  };
}

async function issueValue(issue: Issue, depth = 0): Promise<LinearIssueValue> {
  const statePromise = issue.state;
  const state = statePromise ? await statePromise : undefined;
  const managed = parseManagedDescription(issue.description ?? "");
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    ...(issue.projectId ? { projectId: issue.projectId } : {}),
    ...(issue.parentId ? { parentIssueId: issue.parentId } : {}),
    ...(state ? { state: linearIssueState(state.name) } : {}),
    order: issue.subIssueSortOrder ?? issue.sortOrder,
    depth,
    title: issue.title,
    description: managed.businessDescription,
    ...(managed.managedMarker
      ? { managedMarker: managed.managedMarker }
      : {}),
    ...(managed.nodeKind ? { nodeKind: managed.nodeKind } : {}),
    ...(managed.humanKind ? { humanKind: managed.humanKind } : {}),
    ...(managed.origin ? { origin: managed.origin } : {}),
    ...(managed.completedInputHash
      ? { completedInputHash: managed.completedInputHash }
      : {}),
    ...(managed.targetIssueId
      ? { targetIssueId: managed.targetIssueId }
      : {}),
    updatedAt: issue.updatedAt.toISOString(),
  };
}

function serializeManagedDescription(
  description: string,
  command: Extract<
    LinearMutationCommand,
    { kind: "create_managed_node" | "update_managed_node" }
  > & { managedMarker: string },
  completedInputHash?: string,
) {
  if (command.nodeKind === "work") {
    return `${description.trim()}\n\n<!-- symphony managed marker\nmanaged_marker: ${command.managedMarker}\n-->\n\n<!-- symphony work metadata\nkind: work\norigin: symphony\ncompleted_input_hash: ${completedInputHash ?? "none"}\n-->`;
  }
  return `${description.trim()}\n\n<!-- symphony managed marker\nmanaged_marker: ${command.managedMarker}\nkind: human\nhuman_kind: ${command.humanKind}\ntarget_issue_id: ${command.targetIssueId ?? "none"}\n-->`;
}

function parseManagedDescription(description: string): {
  businessDescription: string;
  managedMarker?: string;
  nodeKind?: "work" | "human";
  humanKind?: "plan_approval" | "planned_input" | "runtime_input";
  origin?: "user" | "symphony";
  completedInputHash?: string;
  targetIssueId?: string;
} {
  const work = description.match(WORK_METADATA);
  if (work?.index !== undefined) {
    const beforeWork = description.slice(0, work.index);
    const identity = beforeWork.match(MANAGED_IDENTITY_MARKER);
    if (work[1] === "symphony" && !identity) {
      throw new Error("linear_work_managed_marker_missing");
    }
    return {
      businessDescription: identity?.index === undefined
        ? beforeWork.trim()
        : beforeWork.slice(0, identity.index).trim(),
      ...(identity ? { managedMarker: identity[1]! } : {}),
      nodeKind: "work",
      origin: work[1] as "user" | "symphony",
      ...(work[2] !== "none" ? { completedInputHash: work[2]! } : {}),
    };
  }
  const human = description.match(HUMAN_MARKER);
  if (human?.index !== undefined) {
    const humanKind = human[2] as
      | "plan_approval"
      | "planned_input"
      | "runtime_input";
    const targetIssueId = human[3]!;
    if (
      (humanKind === "plan_approval" && targetIssueId !== "none") ||
      (humanKind !== "plan_approval" && targetIssueId === "none")
    ) {
      throw new Error("linear_human_managed_marker_invalid");
    }
    return {
      businessDescription: description.slice(0, human.index).trim(),
      managedMarker: human[1]!,
      nodeKind: "human",
      humanKind,
      ...(targetIssueId !== "none" ? { targetIssueId } : {}),
    };
  }
  if (
    description.includes("symphony managed marker") ||
    description.includes("symphony work metadata")
  ) {
    throw new Error("linear_managed_metadata_invalid");
  }
  return { businessDescription: description };
}

function requiredMarker(precondition: { expectedManagedMarker?: string }) {
  if (!precondition.expectedManagedMarker) {
    throw new Error("linear_managed_marker_missing");
  }
  return precondition.expectedManagedMarker;
}

function managedNodeMatches(
  issue: LinearIssueValue,
  command: Extract<
    LinearMutationCommand,
    { kind: "create_managed_node" | "update_managed_node" }
  >,
): boolean {
  return (
    issue.nodeKind === command.nodeKind &&
    (command.nodeKind === "work"
      ? issue.origin === "symphony"
      : issue.humanKind === command.humanKind &&
        issue.targetIssueId === command.targetIssueId)
  );
}

function rootCommentMarker(issueId: string) {
  return `${issueId}:root-comment`;
}

function isRootManagedComment(body: string): boolean {
  const marker = body.lastIndexOf(ROOT_MARKER_START);
  return body.startsWith("Symphony\n") && marker > 0 && body.endsWith("\n-->");
}

function parseRootScopeAuthority(body: string): {
  conductorId: string;
  performerId?: string;
} {
  if (!isRootManagedComment(body)) throw new Error("linear_root_scope_authority_invalid");
  const markerStart = body.lastIndexOf(ROOT_MARKER_START);
  const fields = new Map<string, string>();
  const allowed = new Set([
    "conductor_id", "performer_profile_id", "performer_id", "delivery_branch",
    "pull_request", "retry_blocked", "retry_expected_performer_id",
    "retry_failure_code", "retry_observed_at",
  ]);
  for (const line of body.slice(markerStart + ROOT_MARKER_START.length, -4).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error("linear_root_scope_authority_invalid");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!allowed.has(key) || fields.has(key) || value.length > 1_024) {
      throw new Error("linear_root_scope_authority_invalid");
    }
    fields.set(key, value);
  }
  if (fields.size !== allowed.size) throw new Error("linear_root_scope_authority_invalid");
  const conductorId = fields.get("conductor_id")!;
  const performerId = fields.get("performer_id")!;
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
  if (!identifier.test(conductorId) || (performerId !== "none" && !identifier.test(performerId))) {
    throw new Error("linear_root_scope_authority_invalid");
  }
  return {
    conductorId,
    ...(performerId === "none" ? {} : { performerId }),
  };
}

function linearIssueState(value: string): LinearIssueState {
  if (
    value === "Todo" ||
    value === "In Progress" ||
    value === "In Review" ||
    value === "Done" ||
    value === "Canceled"
  ) {
    return value;
  }
  throw new Error("linear_issue_state_invalid");
}

function linearPriority(value: number): LinearPriority {
  switch (value) {
    case 0:
      return "no_priority";
    case 1:
      return "urgent";
    case 2:
      return "high";
    case 3:
      return "normal";
    case 4:
      return "low";
    default:
      throw new Error("linear_issue_priority_invalid");
  }
}

async function blockerValues(issue: Issue): Promise<LinearBlockerValue[]> {
  const relations = await allNodes(
    issue.inverseRelations({ first: PAGE_LIMIT }),
    MAX_TREE_NODES,
  );
  const blockers: LinearBlockerValue[] = [];
  for (const relation of relations) {
    if (relation.type !== "blocks") continue;
    if (
      !relation.issueId ||
      relation.relatedIssueId !== issue.id ||
      relation.issueId === issue.id
    ) {
      throw new Error("linear_blocker_relation_invalid");
    }
    const target = await relation.issue;
    if (!target || target.id !== relation.issueId) {
      throw new Error("linear_blocker_relation_invalid");
    }
    const statePromise = target.state;
    const state = statePromise ? await statePromise : undefined;
    if (!state) throw new Error("linear_blocker_target_state_missing");
    blockers.push({
      sourceIssueId: issue.id,
      targetIssueId: target.id,
      targetState: linearIssueState(state.name),
    });
  }
  return blockers;
}

async function allNodes<Node>(
  connectionPromise: Promise<{ nodes: Node[]; pageInfo: { hasNextPage: boolean }; fetchNext(): Promise<unknown> }>,
  maximum: number,
): Promise<Node[]> {
  const connection = await connectionPromise;
  while (connection.pageInfo.hasNextPage) {
    if (connection.nodes.length >= maximum) throw new Error("linear_collection_too_large");
    await connection.fetchNext();
  }
  if (connection.nodes.length > maximum) throw new Error("linear_collection_too_large");
  return connection.nodes;
}

async function mapConcurrent<Input, Output>(
  values: Input[],
  concurrency: number,
  map: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await map(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function pageInfo(value: {
  hasNextPage: boolean;
  endCursor?: string | null;
}): PageInfo {
  return {
    hasNextPage: value.hasNextPage,
    ...(value.endCursor ? { endCursor: value.endCursor } : {}),
  };
}

function timestampValue(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("linear_timestamp_invalid");
  return parsed.toISOString();
}

function ambiguousError(message: string) {
  const error = new Error(message) as Error & {
    retryable: boolean;
    ambiguous: boolean;
  };
  error.retryable = true;
  error.ambiguous = true;
  return error;
}

function preconditionConflictError() {
  const error = new Error("linear_precondition_conflict") as Error & {
    preconditionConflict: boolean;
  };
  error.preconditionConflict = true;
  return error;
}
