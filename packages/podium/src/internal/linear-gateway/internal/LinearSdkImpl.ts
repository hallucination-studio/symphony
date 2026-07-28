import {
  LinearClient,
  type Issue,
  type IssueLabel,
  type ProjectLabel,
} from "@linear/sdk";
import { createHash, randomUUID } from "node:crypto";

import type {
  LinearClientInterface,
  PageInfo,
  LinearWorkflowStateValue,
} from "../api/LinearClientInterface.js";
import type {
  LinearIssueValue,
  LinearIssueState,
  LinearBlockerValue,
  LinearPriority,
  ConductorPoolValue,
  RootHeaderValue,
  WorkflowCommentValue,
  WorkflowCommentAuthorKind,
  WorkflowMutationCommand,
  WorkflowMutationReadBack,
  WorkflowRelationValue,
  WorkflowAttachmentValue,
  WorkflowActivityValue,
  WorkflowActivityKind,
  WorkflowSourceManifestEntryValue,
} from "../types.js";
import { planProjectConductorPoolMutation } from "../../conductor-bindings/ProjectConductorPoolPolicy.js";
import {
  inspectTargetWorkflowCatalog,
  HUMAN_ACTION_LABEL_NAMES,
  TARGET_WORKFLOW_LABEL_NAMES,
  WORKFLOW_KIND_LABEL_NAMES,
  isTargetWorkflowStatusName,
  planTargetWorkflowInitialization,
  type TargetWorkflowInitializationOperation,
} from "../../../public/TargetWorkflowCatalog.js";

const PAGE_LIMIT = 250;
const MAX_TREE_NODES = 512;
const MAX_ROOT_COMMENTS = 4_096;
const MAX_ROOT_ATTACHMENTS = 1_024;
const MAX_ROOT_ACTIVITIES = 8_192;
const CONDUCTOR_LABEL_PREFIX = "symphony:conductor/";
const DEVELOPMENT_TOKEN_ORGANIZATION_REQUEST_TIMEOUT_MS = 30_000;
const SYMPHONY_RECEIPT_EMOJI = {
  check: "✅",
  cross: "❌",
} as const;

type NativeCommentMutation = Extract<WorkflowMutationCommand, {
  kind: "create_comment_reply" | "set_comment_receipt_reaction" | "set_comment_thread_state";
}>;

function isNativeCommentMutation(command: WorkflowMutationCommand): command is NativeCommentMutation {
  return command.kind === "create_comment_reply" ||
    command.kind === "set_comment_receipt_reaction" ||
    command.kind === "set_comment_thread_state";
}

function receiptEmoji(receipt: "check" | "cross"): string {
  return SYMPHONY_RECEIPT_EMOJI[receipt];
}

function symphonyReceipt(
  comment: WorkflowCommentValue,
): { receipt: "check" | "cross" | "none"; reactionId?: string } {
  const receipts = comment.reactions.filter((reaction) =>
    reaction.actorKind === "symphony" &&
    (reaction.emoji === SYMPHONY_RECEIPT_EMOJI.check || reaction.emoji === SYMPHONY_RECEIPT_EMOJI.cross),
  );
  if (receipts.length === 0) return { receipt: "none" };
  if (receipts.length !== 1) throw new Error("linear_workflow_receipt_ambiguous");
  const reaction = receipts[0]!;
  return {
    receipt: reaction.emoji === SYMPHONY_RECEIPT_EMOJI.check ? "check" : "cross",
    reactionId: reaction.reactionId,
  };
}

type WorkflowScopeIssue = {
  id: string;
  project?: { id?: string } | null;
  parent?: WorkflowScopeIssue | null;
};

type WorkflowVersionScopeIssue = {
  id: string;
  updatedAt?: string;
  sortOrder?: number;
  subIssueSortOrder?: number | null;
  project?: { id?: string } | null;
  parent?: WorkflowVersionScopeIssue | null;
};

type WorkflowPreflightIssue = WorkflowScopeIssue & {
  updatedAt?: string;
  sortOrder?: number;
  subIssueSortOrder?: number | null;
  archivedAt?: string | null;
  title?: string;
  description?: string | null;
  labels?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } };
  state?: { id?: string } | null;
  team?: {
    id?: string;
    states?: { nodes?: Array<{ id?: string }>; pageInfo?: { hasNextPage?: boolean } };
  } | null;
  comments?: { nodes?: Array<{ id?: string; body?: string; updatedAt?: string; issue?: { id?: string } }>; pageInfo?: { hasNextPage?: boolean } };
  children?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } };
  inverseRelations?: {
    nodes?: Array<{ id?: string; type?: string; issue?: { id?: string; updatedAt?: string; project?: { id?: string } }; relatedIssue?: { id?: string; project?: { id?: string } } }>;
    pageInfo?: { hasNextPage?: boolean };
  };
};

function workflowScopeSelection(depth: number): string {
  const parent = depth === 0
    ? "id project { id }"
    : `${workflowScopeSelection(depth - 1)}`;
  return `id project { id } parent { ${parent} }`;
}

function workflowVersionScopeSelection(depth: number): string {
  const parent = depth === 0
    ? "id updatedAt project { id }"
    : workflowVersionScopeSelection(depth - 1);
  return `id updatedAt project { id } parent { ${parent} }`;
}

function workflowAncestryVersions(
  issue: WorkflowVersionScopeIssue,
  projectId: string,
  rootIssueId: string,
): Array<{ issueId: string; remoteVersion: string }> {
  const versions = [];
  const visited = new Set<string>();
  let current: WorkflowVersionScopeIssue | undefined = issue;
  for (let depth = 0; current && depth <= 32; depth += 1) {
    if (visited.has(current.id) || current.project?.id !== projectId || typeof current.updatedAt !== "string") {
      throw new Error("linear_workflow_relation_version_missing");
    }
    visited.add(current.id);
    versions.push({ issueId: current.id, remoteVersion: current.updatedAt });
    if (current.id === rootIssueId) {
      if (current.parent != null) throw new Error("linear_workflow_relation_read_back_incomplete");
      return versions;
    }
    current = current.parent ?? undefined;
  }
  throw new Error("linear_workflow_relation_read_back_incomplete");
}

function latestRemoteVersion(...versions: Array<string | undefined>): string | undefined {
  return versions.reduce<string | undefined>((latest, version) =>
    version !== undefined && (latest === undefined || version > latest) ? version : latest, undefined);
}

function workflowScopeIssueBelongsToRoot(
  issue: WorkflowScopeIssue,
  projectId: string,
  rootIssueId: string,
): boolean {
  const visited = new Set<string>();
  let current: WorkflowScopeIssue | undefined = issue;
  for (let depth = 0; current && depth <= 32; depth += 1) {
    if (visited.has(current.id) || current.project?.id !== projectId) return false;
    visited.add(current.id);
    if (current.id === rootIssueId) return current.parent === null || current.parent === undefined;
    current = current.parent ?? undefined;
  }
  return false;
}

const WORKFLOW_ISSUE_TREE_ROOT_QUERY = `
  query SymphonyIssueTreeRoot($rootIssueId: String!) {
    issue(id: $rootIssueId) {
      id identifier title description sortOrder createdAt updatedAt archivedAt
      project { id }
      parent { id }
      creator { id }
      assignee { id }
      state { name }
      labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
      comments(first: 8) {
        nodes {
          id body createdAt updatedAt user { id } botActor { id } externalUser { id } issue { id }
          parent { id } resolvedAt
          reactions { id emoji user { id } }
        }
        pageInfo { hasNextPage endCursor }
      }
      inverseRelations(first: 8) {
        nodes { id type issue { id state { name } project { id } } relatedIssue { id project { id } } }
        pageInfo { hasNextPage endCursor }
      }
      attachments(first: 8) {
        nodes { id title url sourceType createdAt updatedAt issue { id } }
        pageInfo { hasNextPage endCursor }
      }
      history(first: 8) {
        nodes {
          id createdAt updatedAt issue { id } actor { id } botActor { id }
          fromStateId toStateId updatedDescription archived addedLabelIds removedLabelIds
          fromParentId toParentId fromDelegate { id } toDelegate { id } attachmentId
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const WORKFLOW_ISSUE_TREE_CHILDREN_QUERY = `
  query SymphonyIssueTreeChildren($parentIds: [ID!]!, $cursor: String) {
    issues(first: 25, after: $cursor, includeArchived: true, filter: { parent: { id: { in: $parentIds } } }) {
      nodes {
        id identifier title description sortOrder subIssueSortOrder createdAt updatedAt archivedAt
        project { id }
        parent { id }
        creator { id }
        assignee { id }
        state { name }
        labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
        comments(first: 8) {
          nodes {
            id body createdAt updatedAt user { id } botActor { id } externalUser { id } issue { id }
            parent { id } resolvedAt
            reactions { id emoji user { id } }
          }
          pageInfo { hasNextPage endCursor }
        }
        inverseRelations(first: 8) {
          nodes { id type issue { id state { name } project { id } } relatedIssue { id project { id } } }
          pageInfo { hasNextPage endCursor }
        }
        attachments(first: 8) {
          nodes { id title url sourceType createdAt updatedAt issue { id } }
          pageInfo { hasNextPage endCursor }
        }
        history(first: 8) {
          nodes {
            id createdAt updatedAt issue { id } actor { id } botActor { id }
            fromStateId toStateId updatedDescription archived addedLabelIds removedLabelIds
            fromParentId toParentId fromDelegate { id } toDelegate { id } attachmentId
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const WORKFLOW_ISSUE_TREE_COMMENTS_PAGE_QUERY = `
  query SymphonyWorkflowIssueTreeComments($issueId: String!, $cursor: String!) {
    issue(id: $issueId) {
      id
      comments(first: 25, after: $cursor) {
        nodes {
          id body createdAt updatedAt user { id } botActor { id } externalUser { id } issue { id }
          parent { id } resolvedAt
          reactions { id emoji user { id } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const WORKFLOW_ISSUE_TREE_RELATIONS_PAGE_QUERY = `
  query SymphonyWorkflowIssueTreeRelations($issueId: String!, $cursor: String!) {
    issue(id: $issueId) {
      id
      inverseRelations(first: 25, after: $cursor) {
        nodes { id type issue { id state { name } project { id } } relatedIssue { id project { id } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const WORKFLOW_ISSUE_TREE_ATTACHMENTS_PAGE_QUERY = `
  query SymphonyWorkflowIssueTreeAttachments($issueId: String!, $cursor: String!) {
    issue(id: $issueId) {
      id
      attachments(first: 25, after: $cursor) {
        nodes { id title url sourceType createdAt updatedAt issue { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const WORKFLOW_ISSUE_TREE_ACTIVITIES_PAGE_QUERY = `
  query SymphonyWorkflowIssueTreeActivities($issueId: String!, $cursor: String!) {
    issue(id: $issueId) {
      id
      history(first: 25, after: $cursor) {
        nodes {
          id createdAt updatedAt issue { id } actor { id } botActor { id }
          fromStateId toStateId updatedDescription archived addedLabelIds removedLabelIds
          fromParentId toParentId fromDelegate { id } toDelegate { id } attachmentId
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const PROJECT_POOL_PREFLIGHT_QUERY = `
  query SymphonyProjectPoolPreflight($projectId: String!, $memberNames: [String!]!, $rootCursor: String) {
    organization { id }
    project(id: $projectId) {
      id updatedAt
      labels(first: 65, includeArchived: false, filter: { name: { startsWith: "symphony:conductor/" } }) {
        nodes { name isGroup archivedAt retiredBy { id } }
        pageInfo { hasNextPage }
      }
      issues(first: 250, after: $rootCursor, includeArchived: false) {
        nodes {
          id project { id } parent { id } state { name }
          labels(first: 3, includeArchived: false, filter: { name: { startsWith: "symphony:conductor/" } }) {
            nodes { name }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
    projectLabels(first: 129, includeArchived: false, filter: { name: { in: $memberNames }, isGroup: { eq: false } }) {
      nodes {
        id name isGroup archivedAt retiredBy { id }
        projects(first: 2) {
          nodes { id }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;
const PROJECT_POOL_ROOTS_QUERY = `
  query SymphonyProjectPoolRoots($projectId: String!, $rootCursor: String!) {
    project(id: $projectId) {
      id
      issues(first: 250, after: $rootCursor, includeArchived: false) {
        nodes {
          id project { id } parent { id } state { name }
          labels(first: 3, includeArchived: false, filter: { name: { startsWith: "symphony:conductor/" } }) {
            nodes { name }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const PROJECT_RESOLUTION_QUERY = `
  query SymphonyProjectResolution($labelName: String!) {
    organization { id }
    projectLabels(first: 3, includeArchived: false, filter: { name: { eq: $labelName }, isGroup: { eq: false } }) {
      nodes {
        id name isGroup archivedAt retiredBy { id }
        projects(first: 2) {
          nodes {
            id updatedAt
            labels(first: 65, includeArchived: false, filter: { name: { startsWith: "symphony:conductor/" } }) {
              nodes { name }
              pageInfo { hasNextPage }
            }
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;
const PROJECT_ROOT_INDEX_QUERY = `
  query SymphonyProjectRootIndex($projectId: String!, $cursor: String, $limit: Int!) {
    viewer { id }
    project(id: $projectId) {
      id
      issues(first: $limit, after: $cursor, includeArchived: true, filter: { parent: { null: true } }) {
        nodes {
          id identifier updatedAt archivedAt priority
          project { id }
          state { name }
          delegate { id }
          labels(first: 2, includeArchived: false, filter: { name: { startsWith: "symphony:conductor/" } }) {
            nodes { name }
            pageInfo { hasNextPage }
          }
          inverseRelations(first: 250, includeArchived: true) {
            nodes { id type issue { id state { name } } relatedIssue { id } }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

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
  installationId?: string;
  projectId?: string;
  requestClass?: "control" | "workflow" | "mutation" | "read-back" | "background";
}

export interface LinearRequestObservationOptions {
  correlationId(): string;
  now(): number;
  observe?(observation: LinearPhysicalRequestObservation): void;
  beforePhysicalRequest?(document: string): Promise<void> | void;
}

interface IssueTreePageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

interface IssueTreeComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user?: { id: string } | null;
  botActor?: { id: string } | null;
  externalUser?: { id: string } | null;
  issue: { id: string };
  parent: { id: string } | null;
  resolvedAt: string | null;
  reactions: Array<{
    id: string;
    emoji: string;
    user?: { id: string } | null;
  }>;
}

interface IssueTreeRelation {
  id?: string | null;
  type: string;
  issue?: { id: string; state: { name: string }; project?: { id: string } | null } | null;
  relatedIssue?: { id: string; project?: { id: string } | null } | null;
}

interface IssueTreeAttachment {
  id: string;
  title: string;
  url: string;
  sourceType: string;
  createdAt: string;
  updatedAt: string;
  issue: { id: string };
}

interface IssueTreeActivity {
  id: string;
  createdAt: string;
  updatedAt: string;
  issue: { id: string };
  actor?: { id: string } | null;
  botActor?: { id: string } | null;
  fromStateId?: string | null;
  toStateId?: string | null;
  updatedDescription?: string | null;
  archived?: boolean | null;
  addedLabelIds?: string[] | null;
  removedLabelIds?: string[] | null;
  fromParentId?: string | null;
  toParentId?: string | null;
  fromDelegate?: { id: string } | null;
  toDelegate?: { id: string } | null;
  attachmentId?: string | null;
}

interface IssueTreeFact {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  sortOrder: number;
  subIssueSortOrder?: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  project?: { id: string } | null;
  parent?: { id: string } | null;
  creator?: { id: string } | null;
  assignee?: { id: string } | null;
  state: { name: string };
  labels: {
    nodes: Array<{ name: string }>;
    pageInfo: { hasNextPage: boolean };
  };
  comments: {
    nodes: IssueTreeComment[];
    pageInfo: IssueTreePageInfo;
  };
  inverseRelations: {
    nodes: IssueTreeRelation[];
    pageInfo: IssueTreePageInfo;
  };
  attachments: {
    nodes: IssueTreeAttachment[];
    pageInfo: IssueTreePageInfo;
  };
  history: {
    nodes: IssueTreeActivity[];
    pageInfo: IssueTreePageInfo;
  };
}

interface IssueTreeRootFact extends IssueTreeFact {
  labels: {
    nodes: Array<{ name: string }>;
    pageInfo: { hasNextPage: boolean };
  };
}

interface IssueTreeRootData { issue?: IssueTreeRootFact | null }
interface IssueTreeNestedPageData {
  issue?: {
    id: string;
    comments?: IssueTreeFact["comments"];
    inverseRelations?: IssueTreeFact["inverseRelations"];
    attachments?: IssueTreeFact["attachments"];
    history?: IssueTreeFact["history"];
  } | null;
}
interface IssueTreeChildrenData {
  issues: {
    nodes: IssueTreeFact[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
}

interface ProjectPoolPageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

interface ProjectPoolLabel {
  id?: string;
  name?: string;
  isGroup?: boolean;
  archivedAt?: string | null;
  retiredBy?: { id?: string } | null;
}

interface ProjectPoolIssue {
  id?: string;
  project?: { id?: string } | null;
  parent?: { id?: string } | null;
  state?: { name?: string } | null;
  labels?: {
    nodes?: Array<{ name?: string }>;
    pageInfo?: ProjectPoolPageInfo;
  } | null;
}

interface ProjectPoolProject {
  id?: string;
  updatedAt?: string;
  labels?: {
    nodes?: ProjectPoolLabel[];
    pageInfo?: ProjectPoolPageInfo;
  } | null;
  issues?: {
    nodes?: ProjectPoolIssue[];
    pageInfo?: ProjectPoolPageInfo;
  } | null;
}

interface ProjectPoolPreflightData {
  organization?: { id?: string } | null;
  project?: ProjectPoolProject | null;
  projectLabels?: {
    nodes?: Array<ProjectPoolLabel & {
      projects?: { nodes?: Array<{ id?: string }>; pageInfo?: ProjectPoolPageInfo } | null;
    }>;
    pageInfo?: ProjectPoolPageInfo;
  } | null;
}

interface ProjectPoolRootsData {
  project?: Pick<ProjectPoolProject, "id" | "issues"> | null;
}

interface ProjectPoolRootInput {
  issueId: string;
  state: string;
  labels: string[];
}

interface ProjectResolutionData {
  organization?: { id?: string } | null;
  projectLabels?: {
    nodes?: Array<ProjectPoolLabel & {
      projects?: {
        nodes?: Array<{
          id?: string;
          updatedAt?: string;
          labels?: { nodes?: Array<{ name?: string }>; pageInfo?: ProjectPoolPageInfo } | null;
        }>;
        pageInfo?: ProjectPoolPageInfo;
      } | null;
    }>;
    pageInfo?: ProjectPoolPageInfo;
  } | null;
}

interface ProjectRootIndexPageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

interface ProjectRootIndexRelation {
  id?: string;
  type?: string;
  issue?: { id?: string; state?: { name?: string } | null } | null;
  relatedIssue?: { id?: string } | null;
}

interface ProjectRootIndexIssue {
  id?: string;
  identifier?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  priority?: number | null;
  project?: { id?: string } | null;
  state?: { name?: string } | null;
  delegate?: { id?: string } | null;
  labels?: {
    nodes?: Array<{ name?: string }>;
    pageInfo?: ProjectRootIndexPageInfo;
  } | null;
  inverseRelations?: {
    nodes?: ProjectRootIndexRelation[];
    pageInfo?: ProjectRootIndexPageInfo;
  } | null;
}

interface ProjectRootIndexData {
  viewer?: { id?: string } | null;
  project?: {
    id?: string;
    issues?: {
      nodes?: ProjectRootIndexIssue[];
      pageInfo?: ProjectRootIndexPageInfo;
    } | null;
  } | null;
}

type WorkflowStatusCatalogEntry = {
  statusId: string;
  name: string;
  category: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  position: number;
};

export class LinearSdkImpl implements LinearClientInterface {
  readonly #client: LinearClient;
  readonly #delegateActorId: string | undefined;
  readonly #projectResolutionCache = new Map<
    string,
    ReturnType<LinearClientInterface["readProjectResolution"]>
  >();
  readonly #workflowStatusCatalogCache = new Map<string, Promise<WorkflowStatusCatalogEntry[]>>();
  readonly #workflowStatusIdsCache = new Map<string, Promise<Set<string>>>();
  readonly #workflowPreflights = new Map<string, Map<string, WorkflowPreflightIssue>>();

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
        ? {
            correlationId: randomUUID,
            now: Date.now,
            observe,
          }
        : undefined,
      AbortSignal.timeout(DEVELOPMENT_TOKEN_ORGANIZATION_REQUEST_TIMEOUT_MS),
    );
    const organization = await client.organization;
    if (!organization.id) throw new Error("linear_organization_missing");
    return organization.id;
  }

  async readTargetProjectConfiguration(input: {
    clientId: string;
    projectSlugId: string;
  }) {
    if (!SAFE_ID.test(input.clientId) || !SAFE_ID.test(input.projectSlugId)) {
      throw new Error("linear_target_project_configuration_invalid");
    }
    const organization = await this.#client.organization;
    if (!SAFE_ID.test(organization.id) || organization.id !== this.organizationId) {
      throw new Error("linear_target_project_organization_mismatch");
    }
    const application = await this.#client.applicationInfo(input.clientId);
    if (!application || typeof application.name !== "string" || application.name.length === 0) {
      throw new Error("linear_target_project_application_invalid");
    }
    const appUsers = (await allNodes(
      this.#client.users({ first: PAGE_LIMIT, filter: { app: { eq: true } } }),
      PAGE_LIMIT,
    )).filter(({ app, name, displayName }) =>
      app === true && (name === application.name || displayName === application.name));
    if (appUsers.length !== 1 || !SAFE_ID.test(appUsers[0]!.id)) {
      throw new Error("linear_target_project_delegate_ambiguous");
    }
    const project = await this.#client.project(input.projectSlugId);
    if (!project || !SAFE_ID.test(project.id) || project.slugId !== input.projectSlugId ||
        typeof project.name !== "string" || project.name.length === 0 ||
        !(project.updatedAt instanceof Date) || Number.isNaN(project.updatedAt.getTime())) {
      throw new Error("linear_target_project_invalid");
    }
    const teams = await allNodes(project.teams({ first: 64 }), 64);
    if (teams.length !== 1 || !SAFE_ID.test(teams[0]!.id)) {
      throw new Error("linear_target_project_team_ambiguous");
    }
    const states = await allNodes(teams[0]!.states({ first: 64 }), 64);
    const todoStates = states.filter(({ id, name, type }) =>
      SAFE_ID.test(id) && name === "Todo" && type === "unstarted");
    if (todoStates.length > 1) throw new Error("linear_target_project_todo_ambiguous");
    return Object.freeze({
      organizationId: organization.id,
      delegateActorId: appUsers[0]!.id,
      project: Object.freeze({
        projectId: project.id,
        organizationId: organization.id,
        name: project.name,
        slugId: project.slugId,
        updatedAt: project.updatedAt.toISOString(),
      }),
      teamId: teams[0]!.id,
      ...(todoStates[0] ? { todoStateId: todoStates[0].id } : {}),
    });
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

  async readConductorProjectPool(input: { projectId: string }) {
    if (!SAFE_ID.test(input.projectId)) throw new Error("linear_project_pool_project_invalid");
    const organization = await this.#client.organization;
    if (organization.id !== this.organizationId) throw new Error("linear_project_pool_organization_mismatch");
    const project = await this.#client.project(input.projectId);
    if (!project || project.id !== input.projectId) throw new Error("linear_project_pool_project_invalid");
    const labels = await allNodes(project.labels({ first: PAGE_LIMIT }), 64);
    const active = labels.filter(({ isGroup, archivedAt, retiredById }) => !isGroup && !archivedAt && !retiredById);
    const members = conductorPoolFromLabels(active.map(({ name }) => name));
    return {
      projectId: input.projectId,
      updatedAt: project.updatedAt.toISOString(),
      members: members.map(({ conductorShortHash }) => conductorShortHash),
    };
  }

  async preflightConductorProjectPool(input: {
    projectId: string;
    desiredMembers: readonly string[];
  }) {
    if (!SAFE_ID.test(input.projectId)) {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "project_invalid" as const };
    }
    const desiredMembers = normalizePoolMembers(input.desiredMembers);
    if (!desiredMembers) {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "desired_members_invalid" as const };
    }
    const initial = await this.#compactRawRequest<ProjectPoolPreflightData, {
      projectId: string;
      memberNames: string[];
      rootCursor: undefined;
    }>(PROJECT_POOL_PREFLIGHT_QUERY, {
      projectId: input.projectId,
      memberNames: desiredMembers.map((member) => `${CONDUCTOR_LABEL_PREFIX}${member}`),
      rootCursor: undefined,
    });
    if (initial.organization?.id !== this.organizationId) {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "project_invalid" as const };
    }
    const project = initial.project;
    if (!project || project.id !== input.projectId || typeof project.updatedAt !== "string") {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "project_invalid" as const };
    }
    const conductorLabels = this.#activeProjectPoolLabels(project.labels);
    if (!conductorLabels) {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "project_roots_invalid" as const };
    }
    const currentMembers = normalizePoolMembers(
      conductorLabels.map(({ name }) => name!.slice(CONDUCTOR_LABEL_PREFIX.length)),
      true,
    );
    if (!currentMembers) {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "project_roots_invalid" as const };
    }
    const namedLabels = initial.projectLabels;
    if (!namedLabels || namedLabels.pageInfo?.hasNextPage !== false || !Array.isArray(namedLabels.nodes)) {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "member_label_ambiguous" as const };
    }
    for (const member of desiredMembers) {
      const name = `${CONDUCTOR_LABEL_PREFIX}${member}`;
      const matches = namedLabels.nodes.filter((label) =>
        label.name === name && !label.isGroup && !label.archivedAt && !label.retiredBy,
      );
      if (matches.length > 1) {
        return { kind: "blocked" as const, projectId: input.projectId, reason: "member_label_ambiguous" as const };
      }
      if (matches[0]) {
        const assignedProjects = matches[0].projects;
        if (
          !assignedProjects ||
          assignedProjects.pageInfo?.hasNextPage !== false ||
          !Array.isArray(assignedProjects.nodes) ||
          assignedProjects.nodes.some(({ id }) => id !== input.projectId)
        ) {
          return { kind: "blocked" as const, projectId: input.projectId, reason: "member_label_owned_by_other_project" as const };
        }
      }
    }
    const roots = this.#projectPoolRootPage(project.issues, input.projectId);
    let cursor = this.#nextProjectPoolCursor(project.issues?.pageInfo);
    if (!roots || cursor === null) {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "project_roots_invalid" as const };
    }
    while (cursor) {
      const page = await this.#compactRawRequest<ProjectPoolRootsData, {
        projectId: string;
        rootCursor: string;
      }>(PROJECT_POOL_ROOTS_QUERY, { projectId: input.projectId, rootCursor: cursor });
      if (page.project?.id !== input.projectId) {
        return { kind: "blocked" as const, projectId: input.projectId, reason: "project_roots_invalid" as const };
      }
      const nextRoots = this.#projectPoolRootPage(page.project.issues, input.projectId);
      const nextCursor = this.#nextProjectPoolCursor(page.project.issues?.pageInfo);
      if (!nextRoots || nextCursor === null || roots.length + nextRoots.length > 512) {
        return { kind: "blocked" as const, projectId: input.projectId, reason: "project_roots_invalid" as const };
      }
      roots.push(...nextRoots);
      cursor = nextCursor;
    }
    let policy;
    try {
      policy = planProjectConductorPoolMutation({
        project: { projectId: input.projectId, updatedAt: project.updatedAt },
        currentMembers,
        desiredMembers,
        roots,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      return {
        kind: "blocked" as const,
        projectId: input.projectId,
        reason: reason === "project_conductor_pool_member_in_use" ? "member_in_use" as const
          : "root_routing_conflict" as const,
      };
    }
    const plan = {
      kind: "ready" as const,
      projectId: input.projectId,
      expectedProjectUpdatedAt: policy.expectedProjectUpdatedAt,
      fingerprint: "",
      currentMembers,
      desiredMembers,
      addMembers: policy.addMembers,
      removeMembers: policy.removeMembers,
      routeRoots: policy.routeRoots,
    };
    return { ...plan, fingerprint: projectPoolFingerprint(plan) };
  }

  async reconcileConductorProjectPool(input: {
    plan: Extract<import("../api/LinearClientInterface.js").ConductorProjectPoolPlan, { kind: "ready" }>;
    authorized: boolean;
  }) {
    const plan = input.plan;
    if (plan.fingerprint !== projectPoolFingerprint(plan)) {
      throw new Error("linear_project_pool_plan_invalid");
    }
    const fresh = await this.preflightConductorProjectPool({
      projectId: plan.projectId,
      desiredMembers: plan.desiredMembers,
    });
    if (fresh.kind !== "ready" || fresh.fingerprint !== plan.fingerprint) {
      throw new Error("linear_project_pool_precondition_conflict");
    }
    if (!input.authorized) return { kind: "dry_run" as const, plan };

    let mutationError: unknown;
    try {
      for (const route of plan.routeRoots) {
        await this.#ensureRootConductorLabel({
          projectId: plan.projectId,
          rootIssueId: route.rootIssueId,
          conductorShortHash: route.conductorShortHash,
        });
      }
      for (const member of plan.addMembers) {
        const label = await this.#uniqueProjectLabel(`${CONDUCTOR_LABEL_PREFIX}${member}`);
        await this.#client.projectAddLabel(plan.projectId, label.id);
      }
      for (const member of plan.removeMembers) {
        const labels = await this.#projectLabelsNamed(`${CONDUCTOR_LABEL_PREFIX}${member}`);
        if (labels.length !== 1) throw new Error("linear_project_pool_member_label_missing");
        await this.#client.projectRemoveLabel(plan.projectId, labels[0]!.id);
      }
      for (const member of plan.desiredMembers) {
        await this.#uniqueIssueLabel(`${CONDUCTOR_LABEL_PREFIX}${member}`);
      }
    } catch (error) {
      mutationError = error;
    }
    const finalPlan = await this.preflightConductorProjectPool({
      projectId: plan.projectId,
      desiredMembers: plan.desiredMembers,
    });
    const exactMembers = finalPlan?.kind === "ready" &&
      sameMembers(finalPlan.currentMembers, plan.desiredMembers);
    const exactRoutes = finalPlan?.kind === "ready" && finalPlan.routeRoots.length === 0;
    if (!exactMembers || !exactRoutes) {
      if (mutationError) throw mutationError;
      throw ambiguousError("linear_project_pool_read_back_failed");
    }
    return {
      kind: plan.addMembers.length === 0 && plan.removeMembers.length === 0 && plan.routeRoots.length === 0
        ? "already_applied" as const : "applied" as const,
      projectId: plan.projectId,
      fingerprint: finalPlan!.fingerprint,
      members: finalPlan!.currentMembers,
    };
  }

  async #compactRawRequest<TData, TVariables extends Record<string, unknown>>(
    query: string,
    variables: TVariables,
  ): Promise<TData> {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest) throw new Error("linear_compact_query_raw_request_unavailable");
    const response = await rawRequest<TData, TVariables>(query, variables);
    if (!response.data) throw new Error("linear_compact_query_data_missing");
    return response.data;
  }

  #activeProjectPoolLabels(
    labels: ProjectPoolProject["labels"],
  ): ProjectPoolLabel[] | undefined {
    if (!labels || labels.pageInfo?.hasNextPage !== false || !Array.isArray(labels.nodes)) return undefined;
    return labels.nodes.filter((label) =>
      typeof label.name === "string" && label.name.startsWith(CONDUCTOR_LABEL_PREFIX) &&
      !label.isGroup && !label.archivedAt && !label.retiredBy,
    );
  }

  #projectPoolRootPage(
    issues: ProjectPoolProject["issues"],
    projectId: string,
  ): ProjectPoolRootInput[] | undefined {
    if (!issues || !Array.isArray(issues.nodes)) return undefined;
    const roots: ProjectPoolRootInput[] = [];
    for (const issue of issues.nodes) {
      if (issue.project?.id !== projectId || !SAFE_ID.test(issue.id ?? "")) return undefined;
      if (issue.parent) continue;
      const labels = issue.labels;
      if (
        !labels ||
        labels.pageInfo?.hasNextPage !== false ||
        !Array.isArray(labels.nodes) ||
        labels.nodes.some((label) => typeof label.name !== "string") ||
        (issue.state !== null && issue.state !== undefined && typeof issue.state.name !== "string")
      ) {
        return undefined;
      }
      roots.push({
        issueId: issue.id!,
        state: issue.state?.name ?? "Draft",
        labels: conductorPoolFromLabels(labels.nodes.map((label) => label.name!))
          .map(({ conductorShortHash }) => conductorShortHash),
      });
    }
    return roots;
  }

  #nextProjectPoolCursor(pageInfo: ProjectPoolPageInfo | undefined): string | undefined | null {
    if (!pageInfo || typeof pageInfo.hasNextPage !== "boolean") return null;
    if (!pageInfo.hasNextPage) return undefined;
    return typeof pageInfo.endCursor === "string" && pageInfo.endCursor.length > 0
      ? pageInfo.endCursor
      : null;
  }

  async #ensureRootConductorLabel(input: {
    projectId: string;
    rootIssueId: string;
    conductorShortHash: string;
  }): Promise<void> {
    const issue = await this.#client.issue(input.rootIssueId);
    if (!issue || issue.projectId !== input.projectId || issue.parentId) {
      throw new Error("linear_root_routing_scope_invalid");
    }
    const state = await issue.state;
    if (!state || state.name === "Done" || state.name === "Canceled") {
      throw new Error("linear_root_routing_terminal");
    }
    const labels = await allNodes(issue.labels({ first: PAGE_LIMIT }), 64);
    const current = labels
      .map(({ name }) => name)
      .filter((name) => name.startsWith(CONDUCTOR_LABEL_PREFIX));
    if (current.length > 1) throw new Error("linear_root_routing_conflict");
    const target = `${CONDUCTOR_LABEL_PREFIX}${input.conductorShortHash}`;
    if (current[0] === target) return;
    if (current.length !== 0) throw new Error("linear_root_routing_conflict");
    const label = await this.#uniqueIssueLabel(target, issue.teamId);
    await this.#client.issueAddLabel(issue.id, label.id);
    const readBack = await this.#client.issue(issue.id);
    const finalLabels = await allNodes(readBack.labels({ first: PAGE_LIMIT }), 64);
    const finalConductorLabels = finalLabels
      .map(({ name }) => name)
      .filter((name) => name.startsWith(CONDUCTOR_LABEL_PREFIX));
    if (finalConductorLabels.length !== 1 || finalConductorLabels[0] !== target) {
      throw ambiguousError("linear_root_routing_read_back_failed");
    }
  }

  async initializeTargetTeamWorkflow(input: {
    projectId: string;
    authorized: boolean;
  }) {
    this.#workflowStatusCatalogCache.delete(input.projectId);
    this.#workflowStatusIdsCache.delete(input.projectId);
    if (!SAFE_ID.test(input.projectId)) {
      throw new Error("linear_workflow_project_invalid");
    }

    const target = await this.#readTargetTeamWorkflow(input.projectId);
    const plan = planTargetWorkflowInitialization({
      teamId: target.teamId,
      states: target.states,
    });
    if (plan.kind !== "ready") {
      throw new Error(`linear_workflow_setup_${plan.reason}`);
    }
    const initialWorkflowLabels = input.authorized === true
      ? await this.#readTargetWorkflowLabels(target.teamId)
      : [];
    if (input.authorized !== true) {
      return {
        kind: "dry_run" as const,
        projectId: target.projectId,
        teamId: target.teamId,
        currentStatuses: target.states.map(linearWorkflowStateValueFromRaw),
        operations: plan.operations,
        workflowKindLabels: [...WORKFLOW_KIND_LABEL_NAMES],
        humanActionLabels: [...HUMAN_ACTION_LABEL_NAMES],
        nativeDuplicate: linearWorkflowStateValueFromRaw(
          target.states.find(({ type }) => type === "duplicate")!,
        ),
      };
    }
    if (plan.operations.length !== 0) {
      try {
        await this.#applyTargetWorkflowOperationsBatch(input.projectId, target, plan.operations);
      } catch (error) {
        // A lost batch response is recoverable only when the final catalog proves
        // that the complete authorized mutation was applied.
        const observed = await this.#readTargetTeamWorkflow(input.projectId).catch(() => undefined);
        if (!observed || observed.teamId !== target.teamId ||
            inspectTargetWorkflowCatalog(observed.states).kind !== "complete") {
          throw error;
        }
      }
    }
    for (const labelName of TARGET_WORKFLOW_LABEL_NAMES) {
      await this.#uniqueIssueLabel(labelName, target.teamId);
    }
    const finalTarget = await this.#readTargetTeamWorkflow(input.projectId);
    const inspection = inspectTargetWorkflowCatalog(finalTarget.states);
    if (inspection.kind !== "complete") {
      throw ambiguousError("linear_workflow_setup_read_back_failed");
    }
    const workflowLabels = await this.#readTargetWorkflowLabels(finalTarget.teamId);
    if (workflowLabels.length !== TARGET_WORKFLOW_LABEL_NAMES.length ||
        TARGET_WORKFLOW_LABEL_NAMES.some((name, index) => workflowLabels[index] !== name)) {
      throw ambiguousError("linear_workflow_labels_read_back_failed");
    }
    return {
      kind: plan.operations.length === 0 &&
        initialWorkflowLabels.length === TARGET_WORKFLOW_LABEL_NAMES.length
        ? "already_applied" as const
        : "applied" as const,
      projectId: finalTarget.projectId,
      teamId: finalTarget.teamId,
      canonicalStatuses: inspection.canonicalStatuses.map(linearWorkflowStateValue),
      workflowKindLabels: workflowLabels.slice(0, WORKFLOW_KIND_LABEL_NAMES.length),
      humanActionLabels: workflowLabels.slice(WORKFLOW_KIND_LABEL_NAMES.length),
      nativeDuplicate: linearWorkflowStateValue(inspection.nativeDuplicate),
    };
  }

  async #applyTargetWorkflowOperationsBatch(
    projectId: string,
    target: {
      projectId: string;
      teamId: string;
      states: Array<{ id: string; name: string; type: string; position: number }>;
    },
    operations: readonly TargetWorkflowInitializationOperation[],
  ): Promise<void> {
    assertTargetWorkflowPreconditions(target.states, target.states, operations);
    const client = this.#client as unknown as {
      client?: { rawRequest?: (query: string) => Promise<Record<string, unknown>> };
    };
    if (typeof client.client?.rawRequest === "function") {
      await this.#runTargetWorkflowMutationBatch(client.client.rawRequest.bind(client.client), target, operations);
      return;
    }
    throw new Error("linear_workflow_batch_unsupported");
  }

  async #runTargetWorkflowMutationBatch(
    rawRequest: (query: string) => Promise<Record<string, unknown>>,
    target: {
      teamId: string;
    },
    operations: readonly TargetWorkflowInitializationOperation[],
  ): Promise<void> {
    const fields = operations.map((operation, index) => {
      const alias = `operation${index}`;
      if (operation.kind === "rename") {
        return `${alias}: workflowStateUpdate(id: ${quoteGraphql(operation.statusId)}, input: { name: ${quoteGraphql(operation.name)} }) { success }`;
      }
      return `${alias}: workflowStateCreate(input: { teamId: ${quoteGraphql(target.teamId)}, name: ${quoteGraphql(operation.name)}, color: ${quoteGraphql(workflowStateColor(operation.category))}, type: ${operation.category} }) { success }`;
    });
    const result = await rawRequest(`mutation TargetWorkflowStatusBatch { ${fields.join(" ")} }`);
    for (const [key, value] of Object.entries(result.data ?? result)) {
      if (!value || typeof value !== "object" || (value as { success?: unknown }).success !== true) {
        throw new Error(`linear_workflow_setup_batch_failed_${key}`);
      }
    }
  }

  async #readTargetTeamWorkflow(projectId: string) {
    const organization = await this.#client.organization;
    if (organization.id !== this.organizationId) {
      throw new Error("linear_workflow_organization_mismatch");
    }
    const project = await this.#client.project(projectId);
    if (!project || project.id !== projectId) {
      throw new Error("linear_workflow_project_mismatch");
    }
    const teams = await allNodes(project.teams({ first: 64 }), 64);
    if (teams.length !== 1 || !SAFE_ID.test(teams[0]!.id)) {
      throw new Error("linear_workflow_project_team_ambiguous");
    }
    const team = teams[0]!;
    const states = await allNodes(team.states({ first: 64 }), 64);
    return {
      projectId,
      teamId: team.id,
      states: states.map((state) => {
        if (
          !SAFE_ID.test(state.id) ||
          typeof state.name !== "string" ||
          state.name.length === 0 ||
          typeof state.type !== "string" ||
          !Number.isFinite(state.position)
        ) {
          throw new Error("linear_workflow_status_catalog_invalid");
        }
        return {
          id: state.id,
          name: state.name,
          type: state.type,
          position: state.position,
        };
      }),
    };
  }

  async #applyTargetWorkflowOperation(
    projectId: string,
    teamId: string,
    initialStates: Array<{ id: string; name: string; type: string; position: number }>,
    operations: readonly TargetWorkflowInitializationOperation[],
    operation: TargetWorkflowInitializationOperation,
  ): Promise<void> {
    const current = await this.#readTargetTeamWorkflow(projectId);
    if (current.teamId !== teamId) {
      throw new Error("linear_workflow_project_team_changed");
    }
    assertTargetWorkflowPreconditions(current.states, initialStates, operations);
    if (operation.kind === "rename") {
      const source = current.states.find(({ id }) => id === operation.statusId);
      if (source?.name === operation.name && source.type === operation.category) return;
      if (
        !source ||
        source.name !== operation.expectedName ||
        source.type !== operation.category
      ) {
        throw new Error("linear_workflow_setup_precondition_conflict");
      }
      if (current.states.some(({ name }) => name === operation.name)) {
        throw new Error("linear_workflow_setup_precondition_conflict");
      }
      try {
        await this.#client.updateWorkflowState(operation.statusId, {
          name: operation.name,
        });
      } catch (error) {
        const observed = await this.#readTargetTeamWorkflow(projectId).catch(() => undefined);
        const readBack = observed?.teamId === teamId
          ? observed.states.filter(({ id, name, type }) =>
              id === operation.statusId && name === operation.name && type === operation.category)
          : [];
        if (readBack.length === 1) return;
        throw error;
      }
      await this.#assertTargetWorkflowOperation(projectId, teamId, operation);
      return;
    }

    const existing = current.states.find(({ name }) => name === operation.name);
    if (existing) {
      if (existing.type !== operation.category) {
        throw new Error("linear_workflow_setup_precondition_conflict");
      }
      return;
    }
    try {
      await this.#client.createWorkflowState({
        teamId,
        name: operation.name,
        color: workflowStateColor(operation.category),
        type: operation.category,
      });
    } catch (error) {
      const observed = await this.#readTargetTeamWorkflow(projectId).catch(() => undefined);
      const readBack = observed?.teamId === teamId
        ? observed.states.filter(({ name, type }) =>
            name === operation.name && type === operation.category)
        : [];
      if (readBack.length === 1) return;
      throw error;
    }
    await this.#assertTargetWorkflowOperation(projectId, teamId, operation);
  }

  async #assertTargetWorkflowOperation(
    projectId: string,
    teamId: string,
    operation: TargetWorkflowInitializationOperation,
  ): Promise<void> {
    const observed = await this.#readTargetTeamWorkflow(projectId);
    if (observed.teamId !== teamId) {
      throw ambiguousError("linear_workflow_setup_read_back_failed");
    }
    const matches = observed.states.filter(({ name, type, id }) =>
      operation.kind === "rename"
        ? id === operation.statusId && name === operation.name && type === operation.category
        : name === operation.name && type === operation.category,
    );
    if (matches.length !== 1) {
      throw ambiguousError("linear_workflow_setup_read_back_failed");
    }
  }

  async readProjectResolution(input: {
    conductorShortHash: string;
  }): ReturnType<LinearClientInterface["readProjectResolution"]> {
    const cached = this.#projectResolutionCache.get(input.conductorShortHash);
    if (cached) return cached;
    const pending = this.#readProjectResolution(input).catch((error) => {
      this.#projectResolutionCache.delete(input.conductorShortHash);
      throw error;
    });
    this.#projectResolutionCache.set(input.conductorShortHash, pending);
    return pending;
  }

  async #readProjectResolution(input: {
    conductorShortHash: string;
  }): ReturnType<LinearClientInterface["readProjectResolution"]> {
    const name = `${CONDUCTOR_LABEL_PREFIX}${input.conductorShortHash}`;
    const data = await this.#compactRawRequest<ProjectResolutionData, { labelName: string }>(
      PROJECT_RESOLUTION_QUERY,
      { labelName: name },
    );
    if (data.organization?.id !== this.organizationId) {
      throw new Error("linear_project_resolution_organization_mismatch");
    }
    const projectLabels = data.projectLabels;
    if (!projectLabels || !Array.isArray(projectLabels.nodes)) {
      throw new Error("linear_project_resolution_invalid");
    }
    const labels = projectLabels.nodes.filter((label) =>
      label.name === name && !label.isGroup && !label.archivedAt && !label.retiredBy,
    );
    if (labels.length === 0) return { kind: "unbound" };
    if (labels.length !== 1 || projectLabels.pageInfo?.hasNextPage !== false) return { kind: "conflict" };
    const assignments = labels[0]!.projects;
    if (!assignments || !Array.isArray(assignments.nodes)) {
      throw new Error("linear_project_resolution_invalid");
    }
    const projects = assignments.nodes;
    if (projects.length === 0) return { kind: "unbound" };
    if (projects.length !== 1 || assignments.pageInfo?.hasNextPage !== false) return { kind: "ambiguous" };
    const project = projects[0]!;
    if (!SAFE_ID.test(project.id ?? "") || typeof project.updatedAt !== "string") {
      throw new Error("linear_project_resolution_invalid");
    }
    const poolLabels = project.labels;
    if (
      !poolLabels ||
      poolLabels.pageInfo?.hasNextPage !== false ||
      !Array.isArray(poolLabels.nodes) ||
      poolLabels.nodes.some((label) => typeof label.name !== "string")
    ) {
      throw new Error("linear_project_resolution_pool_invalid");
    }
    const conductorPool = conductorPoolFromLabels(poolLabels.nodes.map((label) => label.name!));
    if (!conductorPool.some(({ conductorShortHash }) => conductorShortHash === input.conductorShortHash)) {
      return { kind: "conflict" };
    }
    return {
      kind: "resolved",
      projectId: project.id!,
      updatedAt: project.updatedAt,
      conductorPool,
    };
  }

  async listProjectRootIndexPage(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<{ headers: RootHeaderValue[]; pageInfo: PageInfo }> {
    if (!SAFE_ID.test(input.projectId) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > PAGE_LIMIT) {
      throw new Error("linear_project_root_index_request_invalid");
    }
    const data = await this.#compactRawRequest<ProjectRootIndexData, {
      projectId: string;
      cursor?: string;
      limit: number;
    }>(PROJECT_ROOT_INDEX_QUERY, input);
    const project = data.project;
    const page = project?.issues;
    const delegateActorId = this.#delegateActorId ?? data.viewer?.id;
    if (
      project?.id !== input.projectId ||
      !page ||
      !Array.isArray(page.nodes) ||
      !page.pageInfo ||
      typeof page.pageInfo.hasNextPage !== "boolean" ||
      !delegateActorId ||
      !SAFE_ID.test(delegateActorId)
    ) {
      throw new Error("linear_project_root_index_invalid");
    }
    if (page.nodes.length > input.limit) throw new Error("linear_project_root_index_page_too_large");
    const rootIds = new Set<string>();
    const headers = page.nodes.map((root) => {
      const rootIssueId = root.id;
      const identifier = root.identifier;
      const updatedAt = timestampValueOrUndefined(root.updatedAt);
      const priority = root.priority;
      if (
        typeof rootIssueId !== "string" ||
        !SAFE_ID.test(rootIssueId) ||
        typeof identifier !== "string" ||
        !shortTextValue(identifier) ||
        root.project?.id !== input.projectId ||
        !root.state?.name ||
        updatedAt === undefined ||
        typeof priority !== "number" ||
        rootIds.has(rootIssueId)
      ) {
        throw new Error("linear_project_root_index_header_invalid");
      }
      rootIds.add(rootIssueId);
      const labels = indexLabels(root.labels);
      return {
        rootIssueId,
        identifier,
        projectId: input.projectId,
        state: linearIssueState(root.state.name),
        isArchived: root.archivedAt !== null && root.archivedAt !== undefined,
        updatedAt,
        priority: linearPriority(priority),
        blockers: indexBlockers(root.inverseRelations, rootIssueId),
        rootConductorLabels: labels,
        isDelegatedToSymphony: root.delegate?.id === delegateActorId,
      };
    });
    return {
      headers,
      pageInfo: {
        hasNextPage: page.pageInfo.hasNextPage,
        ...(page.pageInfo.endCursor ? { endCursor: page.pageInfo.endCursor } : {}),
      },
    };
  }

  async #batchedIssueTree(
    projectId: string,
    rootIssueId: string,
  ) {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest) throw new Error("linear_workflow_tree_raw_request_unavailable");
    const delegateActorId = this.#delegateActorId ?? (await this.#client.viewer).id;
    const rootResponse = await rawRequest<IssueTreeRootData, {
      rootIssueId: string;
    }>(
      WORKFLOW_ISSUE_TREE_ROOT_QUERY,
      { rootIssueId },
    );
    const root = rootResponse.data?.issue;
    if (!root || root.id !== rootIssueId || root.project?.id !== projectId || root.parent !== null) {
      throw new Error("linear_tree_root_invalid");
    }
  issueLabels(root.labels);
    await completeNestedIssueTreeFact(rawRequest, root);
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
        }>(WORKFLOW_ISSUE_TREE_CHILDREN_QUERY, {
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
          issueLabels(fact.labels);
          await completeNestedIssueTreeFact(rawRequest, fact);
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

    const rootConductorLabels = conductorPoolFromLabels(root.labels.nodes.map(({ name }) => name));
    const comments = normalizeWorkflowCommentThreads([...facts.values()].flatMap(({ fact }) =>
      fact.comments.nodes.map((comment) => workflowCommentValue(comment, fact.id, delegateActorId)),
    ));
    if (comments.length > MAX_ROOT_COMMENTS) {
      throw new Error("linear_workflow_comments_too_many");
    }
    const relations = workflowRelationValues(facts, projectId);
    if (relations.length > 1_024) {
      throw new Error("linear_workflow_relations_too_many");
    }
    const attachments = [...facts.values()].flatMap(({ fact }) =>
      fact.attachments.nodes.map((attachment) => workflowAttachmentValue(attachment, fact.id)),
    );
    if (attachments.length > MAX_ROOT_ATTACHMENTS) {
      throw new Error("linear_workflow_attachments_too_many");
    }
    const attachmentIds = new Set<string>();
    for (const attachment of attachments) {
      if (attachmentIds.has(attachment.attachmentId)) throw new Error("linear_workflow_attachment_ambiguous");
      attachmentIds.add(attachment.attachmentId);
    }
    const activities = [...facts.values()].flatMap(({ fact }) =>
      fact.history.nodes.flatMap((activity) => {
        const value = workflowActivityValue(activity, fact.id, delegateActorId);
        return value ? [value] : [];
      }),
    );
    if (activities.length > MAX_ROOT_ACTIVITIES) {
      throw new Error("linear_workflow_activities_too_many");
    }
    const activityIds = new Set<string>();
    for (const activity of activities) {
      if (activityIds.has(activity.activityId)) throw new Error("linear_workflow_activity_ambiguous");
      activityIds.add(activity.activityId);
    }
    return {
      nodes,
      rootConductorLabels,
      comments,
      relations,
      attachments,
      activities,
      observedAt: new Date().toISOString(),
      pageInfo: { hasNextPage: false as const },
    };
  }

  async getWorkflowIssueTree(input: { projectId: string; rootIssueId: string }) {
    const tree = await this.#batchedIssueTree(
      input.projectId,
      input.rootIssueId,
    );
    const statusCatalog = await this.#workflowStatusCatalog(input.projectId, input.rootIssueId);
    const statusByName = new Map(statusCatalog.map((status) => [status.name, status]));
    const issues = tree.nodes.map((issue) => {
      const status = issue.state ? statusByName.get(issue.state) : undefined;
      if (!status || !issue.projectId || issue.order === undefined || issue.depth === undefined
        || !issue.title || issue.description === undefined) {
        throw new Error("linear_workflow_issue_invalid");
      }
      return {
        issueId: issue.issueId,
        identifier: issue.identifier ?? issue.issueId,
        projectId: issue.projectId,
        ...(issue.parentIssueId ? { parentIssueId: issue.parentIssueId } : {}),
        ...(issue.creatorUserId ? { creatorUserId: issue.creatorUserId } : {}),
        ...(issue.assigneeUserId ? { assigneeUserId: issue.assigneeUserId } : {}),
        statusId: status.statusId,
        statusName: status.name,
        statusCategory: status.category,
        statusPosition: status.position,
        order: issue.order,
        depth: issue.depth,
        title: issue.title,
        description: issue.description,
        labels: issue.labels,
        isArchived: issue.isArchived,
        remoteVersion: issue.updatedAt,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      };
    });
    const comments = tree.comments;
    const sourceManifest = workflowSourceManifest({
      projectId: input.projectId,
      statusCatalog,
      issues,
      comments,
      relations: tree.relations,
      attachments: tree.attachments,
      activities: tree.activities,
    });
    return {
      rootIssueId: input.rootIssueId,
      statusCatalog,
      issues,
      comments,
      relations: tree.relations,
      attachments: tree.attachments,
      activities: tree.activities,
      sourceManifest,
      coverage: { isComplete: true, omissions: [] },
      observedAt: tree.observedAt,
    };
  }

  async readWorkflowMutationTarget(issueId: string) {
    const issue = await this.#client.issue(issueId);
    return workflowMutationTargetValue(issue);
  }

  async preflightWorkflowMutation(
    command: WorkflowMutationCommand,
  ): Promise<
    | { kind: "ready" }
    | { kind: "already_applied"; readBack: WorkflowMutationReadBack }
    | { kind: "precondition_conflict" }
  > {
    if (isNativeCommentMutation(command)) {
      const outcome = await this.readWorkflowMutationOutcome(command);
      if (outcome) return { kind: "already_applied", readBack: outcome };
      return await this.#nativeCommentPreconditionsMatch(command)
        ? { kind: "ready" }
        : { kind: "precondition_conflict" };
    }
    if (command.kind === "create_workflow_attachment") {
      const outcome = await this.readWorkflowMutationOutcome(command);
      if (outcome) return { kind: "already_applied", readBack: outcome };
      const tree = await this.getWorkflowIssueTree({
        projectId: command.expectedProjectId,
        rootIssueId: command.rootIssueId,
      });
      const root = tree.issues.find((issue) => issue.issueId === command.rootIssueId);
      const target = tree.issues.find((issue) => issue.issueId === command.target.targetIssueId);
      return root?.remoteVersion === command.expectedRootRemoteVersion &&
        target?.remoteVersion === command.target.expectedRemoteVersion &&
        (command.target.expectedStatusId === undefined || target.statusId === command.target.expectedStatusId) &&
        (command.target.expectedParentIssueId === undefined || target.parentIssueId === command.target.expectedParentIssueId) &&
        (command.target.expectedIsArchived === undefined || target.isArchived === command.target.expectedIsArchived)
        ? { kind: "ready" }
        : { kind: "precondition_conflict" };
    }
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest) {
      const outcome = await this.readWorkflowMutationOutcome(command);
      if (outcome) return { kind: "already_applied", readBack: outcome };
      return { kind: "ready" };
    }
    const issueIds = [...new Set([
      command.rootIssueId,
      ...(command.kind === "create_workflow_issue" ? [command.parentIssueId]
          : command.kind === "create_workflow_relation" ? [command.sourceIssueId, command.targetIssueId]
          : [command.target.targetIssueId]),
    ])];
    const response = await rawRequest(`query WorkflowMutationPreflight {
      issues(includeArchived: true, filter: { id: { in: [${issueIds.map(quoteGraphql).join(", ")}] } }) {
        nodes {
          ${workflowScopeSelection(32)}
          updatedAt archivedAt sortOrder subIssueSortOrder title description state { id }
          labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
          team { id states(first: 64) { nodes { id } pageInfo { hasNextPage } } }
          comments(first: 64) { nodes { id body updatedAt issue { id } } pageInfo { hasNextPage } }
          children(first: 64, includeArchived: true) { nodes { id updatedAt archivedAt sortOrder subIssueSortOrder project { id } parent { id } state { id } title description labels(first: 64) { nodes { name } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }
          inverseRelations(first: 64) { nodes { id type issue { id updatedAt project { id } } relatedIssue { id project { id } } } pageInfo { hasNextPage } }
        }
      }
    }`);
    const nodes = (response as { data?: { issues?: { nodes?: unknown[] } } }).data?.issues?.nodes;
    if (!Array.isArray(nodes) || nodes.length !== issueIds.length) return { kind: "precondition_conflict" };
    const facts = new Map<string, WorkflowPreflightIssue>();
    for (const node of nodes) {
      if (!node || typeof node !== "object" || typeof (node as { id?: unknown }).id !== "string") {
        return { kind: "precondition_conflict" };
      }
      const issue = node as WorkflowPreflightIssue;
      facts.set(issue.id, issue);
    }
    if (facts.size !== issueIds.length || issueIds.some((id) => !facts.has(id))) {
      return { kind: "precondition_conflict" };
    }
    const outcome = workflowPreflightOutcome(command, facts);
    if (outcome) return { kind: "already_applied", readBack: outcome };
    const mismatch = workflowPreconditionMismatch(command, facts);
    if (mismatch) {
      console.error(JSON.stringify({
        event: "linear_workflow_precondition_conflict",
        mutation_kind: command.kind,
        mismatch,
      }));
      return { kind: "precondition_conflict" };
    }
    this.#workflowPreflights.set(command.writeId, facts);
    return { kind: "ready" };
  }

  async executeWorkflowMutation(
    command: WorkflowMutationCommand,
  ): Promise<void> {
    if (isNativeCommentMutation(command)) {
      const comments = await this.#nativeCommentPreconditions(command);
      switch (command.kind) {
        case "create_comment_reply": {
          const source = comments.get(command.sourceCommentId)!;
          await this.#client.createComment({
            issueId: source.issueId,
            parentId: command.sourceCommentId,
            body: command.body,
          });
          return;
        }
        case "set_comment_receipt_reaction": {
          const source = comments.get(command.sourceCommentId)!;
          const current = symphonyReceipt(source);
          if (command.receipt === "none") {
            if (current.reactionId) await this.#client.deleteReaction(current.reactionId);
            return;
          }
          if (current.receipt === command.receipt) return;
          if (current.reactionId) await this.#client.deleteReaction(current.reactionId);
          await this.#client.createReaction({
            commentId: command.sourceCommentId,
            emoji: receiptEmoji(command.receipt),
          });
          return;
        }
        case "set_comment_thread_state":
          if (command.threadState === "resolved") {
            await this.#client.commentResolve(command.threadRootCommentId);
          } else {
            await this.#client.commentUnresolve(command.threadRootCommentId);
          }
          return;
      }
    }
    const preflight = this.#workflowPreflights.get(command.writeId);
    this.#workflowPreflights.delete(command.writeId);
    if (!preflight) await this.#assertWorkflowMutationScope(command);
    switch (command.kind) {
      case "create_workflow_issue": {
        assertNativeWorkflowContent(command.description);
        const parentFact = preflight?.get(command.parentIssueId);
        const parent = parentFact ? undefined : await this.#client.issue(command.parentIssueId);
        const teamId = parentFact?.team?.id ?? parent?.teamId;
        if ((parentFact?.project?.id ?? parent?.projectId) !== command.expectedProjectId || !teamId) throw new Error("linear_workflow_parent_invalid");
        if (parent) await this.#workflowStatusId(parent, command.statusId);
        const payload = await this.#client.createIssue({
          teamId,
          projectId: command.expectedProjectId,
          parentId: command.parentIssueId,
          title: command.title,
          description: command.description,
          stateId: command.statusId,
          labelIds: await this.#workflowIssueLabelIds(command.labelNames, teamId),
          ...(command.order === undefined ? {} : { subIssueSortOrder: command.order }),
        });
        if (!payload.success || !payload.issueId) {
          throw new Error("linear_workflow_issue_create_failed");
        }
        return;
      }
      case "update_workflow_issue": {
        assertNativeWorkflowContent(command.description);
        const issue = await this.#client.issue(command.target.targetIssueId);
        if (issue.projectId !== command.expectedProjectId) throw new Error("linear_workflow_target_project_invalid");
        const currentArchived = issue.archivedAt !== null && issue.archivedAt !== undefined;
        if (!command.isArchived && currentArchived) {
          const restored = await issue.unarchive();
          if (!restored.success) throw new Error("linear_workflow_issue_restore_failed");
        }
        await this.#workflowStatusId(issue, command.statusId);
        const team = await issue.team;
        if (!team) throw new Error("linear_workflow_team_missing");
        await this.#client.updateIssue(command.target.targetIssueId, {
          title: command.title,
          description: command.description,
          stateId: command.statusId,
          labelIds: await this.#workflowIssueLabelIds(command.labelNames, team.id),
          ...(command.parentAssignment.mode === "set"
            ? { parentId: command.parentAssignment.parentIssueId }
            : command.parentAssignment.mode === "clear" ? { parentId: null } : {}),
          ...(command.order === undefined ? {} : { subIssueSortOrder: command.order }),
        });
        if (command.isArchived && !currentArchived) {
          const archived = await issue.archive();
          if (!archived.success) throw new Error("linear_workflow_issue_archive_failed");
        }
        return;
      }
      case "append_workflow_comment": {
        assertNativeWorkflowContent(command.body);
        await this.#client.createComment({
          issueId: command.target.targetIssueId,
          body: command.body,
        });
        return;
      }
      case "create_workflow_attachment": {
        await this.#client.createAttachment({
          issueId: command.target.targetIssueId,
          title: command.title,
          url: command.url,
        });
        return;
      }
      case "create_workflow_relation": {
        const sourceFact = preflight?.get(command.sourceIssueId);
        const targetFact = preflight?.get(command.targetIssueId);
        const sourceProjectId = sourceFact?.project?.id ??
          (await this.#client.issue(command.sourceIssueId)).projectId;
        const targetProjectId = targetFact?.project?.id ??
          (await this.#client.issue(command.targetIssueId)).projectId;
        if (sourceProjectId !== command.expectedProjectId || targetProjectId !== command.expectedProjectId) {
          throw new Error("linear_workflow_relation_project_invalid");
        }
        const issueId = command.relationKind === "blocks" || command.relationKind === "relates_to"
          ? command.sourceIssueId : command.targetIssueId;
        const relatedIssueId = command.relationKind === "blocks" || command.relationKind === "relates_to"
          ? command.targetIssueId : command.sourceIssueId;
        if (command.relationState === "present") {
          const payload = await this.#client.createIssueRelation({
            issueId,
            relatedIssueId,
            type: (command.relationKind === "relates_to" ? "related" : "blocks") as Parameters<LinearClient["createIssueRelation"]>[0]["type"],
          });
          if (!payload.success) throw new Error("linear_workflow_relation_create_failed");
          return;
        }
        const existing = preflight
          ? workflowPreflightRelation(preflight, command)
          : undefined;
        const existingRelationId = existing?.id ?? (await this.getWorkflowIssueTree({
          projectId: command.expectedProjectId,
          rootIssueId: command.rootIssueId,
        })).relations.find((candidate) =>
          candidate.relationKind === (command.relationKind === "blocked_by" ? "blocks" : command.relationKind) &&
          candidate.sourceIssueId === issueId && candidate.targetIssueId === relatedIssueId,
        )?.relationId;
        if (!existingRelationId) return;
        const relation = await this.#client.issueRelation(existingRelationId);
        if (relation.issueId !== issueId || relation.relatedIssueId !== relatedIssueId ||
            relation.type !== (command.relationKind === "relates_to" ? "related" : "blocks")) {
          throw new Error("linear_workflow_relation_invalid");
        }
        const payload = await relation.delete();
        if (!payload.success) throw new Error("linear_workflow_relation_remove_failed");
        return;
      }
    }
  }

  async #nativeCommentTree(command: NativeCommentMutation): Promise<{
    rootRemoteVersion: string;
    comments: Map<string, WorkflowCommentValue>;
  }> {
    const tree = await this.getWorkflowIssueTree({
      projectId: command.expectedProjectId,
      rootIssueId: command.rootIssueId,
    });
    const root = tree.issues.find((issue) => issue.issueId === command.rootIssueId);
    if (!root || root.projectId !== command.expectedProjectId) {
      throw new Error("linear_workflow_comment_root_missing");
    }
    const comments = new Map<string, WorkflowCommentValue>();
    for (const comment of tree.comments) {
      if (comments.has(comment.commentId)) throw new Error("linear_workflow_comment_ambiguous");
      comments.set(comment.commentId, comment);
    }
    return { rootRemoteVersion: root.remoteVersion, comments };
  }

  async #nativeCommentPreconditionsMatch(command: NativeCommentMutation): Promise<boolean> {
    return nativeCommentPreconditionsMatch(command, await this.#nativeCommentTree(command));
  }

  async #nativeCommentPreconditions(
    command: NativeCommentMutation,
  ): Promise<Map<string, WorkflowCommentValue>> {
    const tree = await this.#nativeCommentTree(command);
    if (!nativeCommentPreconditionsMatch(command, tree)) throw preconditionConflictError();
    return tree.comments;
  }

  async #readNativeCommentMutationOutcome(
    command: NativeCommentMutation,
  ): Promise<WorkflowMutationReadBack | undefined> {
    const { comments } = await this.#nativeCommentTree(command);
    switch (command.kind) {
      case "create_comment_reply": {
        const matches = [...comments.values()].filter((comment) =>
          comment.parentCommentId === command.sourceCommentId &&
          comment.threadRootCommentId === command.expectedThreadRootCommentId &&
          comment.authorKind === "symphony" &&
          comment.body === command.body,
        );
        if (matches.length > 1) throw new Error("linear_workflow_comment_ambiguous");
        const comment = matches[0];
        return comment
          ? {
              writeId: command.writeId,
              targetIssueId: comment.issueId,
              remoteVersion: comment.remoteVersion,
              comment,
            }
          : undefined;
      }
      case "set_comment_receipt_reaction": {
        const source = comments.get(command.sourceCommentId);
        if (!source || source.threadRootCommentId !== command.threadRootCommentId) return undefined;
        const current = symphonyReceipt(source);
        return current.receipt === command.receipt
          ? {
              writeId: command.writeId,
              targetIssueId: source.issueId,
              remoteVersion: source.remoteVersion,
              symphonyReceipt: {
                replyWriteId: command.replyWriteId,
                sourceCommentId: command.sourceCommentId,
                threadRootCommentId: command.threadRootCommentId,
                receipt: command.receipt,
              },
            }
          : undefined;
      }
      case "set_comment_thread_state": {
        const source = comments.get(command.sourceCommentId);
        return source &&
          source.threadRootCommentId === command.threadRootCommentId &&
          source.threadState === command.threadState
          ? {
              writeId: command.writeId,
              targetIssueId: source.issueId,
              remoteVersion: source.remoteVersion,
              comment: source,
            }
          : undefined;
      }
    }
  }

  async #assertWorkflowMutationScope(
    command: import("../types.js").WorkflowMutationCommand,
  ): Promise<void> {
    if (isNativeCommentMutation(command)) {
      throw new Error("linear_workflow_comment_scope_unavailable");
    }
    const targetIds = command.kind === "create_workflow_issue"
      ? [command.parentIssueId]
      : command.kind === "create_workflow_relation"
        ? [command.sourceIssueId, command.targetIssueId]
        : [command.target.targetIssueId];
    if (targetIds.length > 1) {
      const scoped = await this.#workflowMutationScopeBatch(
        targetIds,
        command.expectedProjectId,
        command.rootIssueId,
      );
      if (scoped !== undefined) {
        if (!scoped) throw preconditionConflictError();
        return;
      }
    }
    for (const issueId of targetIds) {
      if (!(await this.#issueBelongsToWorkflowRoot(
        issueId,
        command.expectedProjectId,
        command.rootIssueId,
      ))) {
        throw preconditionConflictError();
      }
    }
  }

  async #workflowMutationScopeBatch(
    issueIds: readonly string[],
    projectId: string,
    rootIssueId: string,
  ): Promise<boolean | undefined> {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest) return undefined;
    const ids = issueIds.map(quoteGraphql).join(", ");
    const response = await rawRequest(
      `query WorkflowMutationScopeBatch { issues(includeArchived: true, filter: { id: { in: [${ids}] } }) { nodes { ${workflowScopeSelection(32)} } } }`,
    );
    const data = (response as { data?: { issues?: { nodes?: unknown[] } } }).data;
    if (!data?.issues || !Array.isArray(data.issues.nodes) || data.issues.nodes.length !== issueIds.length) {
      return false;
    }
    const byId = new Map<string, WorkflowScopeIssue>();
    for (const value of data.issues.nodes) {
      if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
        return false;
      }
      byId.set((value as { id: string }).id, value as WorkflowScopeIssue);
    }
    return issueIds.every((issueId) => {
      const issue = byId.get(issueId);
      return issue ? workflowScopeIssueBelongsToRoot(issue, projectId, rootIssueId) : false;
    });
  }

  async #issueBelongsToWorkflowRoot(
    issueId: string,
    projectId: string,
    rootIssueId: string,
  ): Promise<boolean> {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (rawRequest) {
      const response = await rawRequest(`query WorkflowMutationScope { issue(id: ${quoteGraphql(issueId)}) { ${workflowScopeSelection(32)} } }`);
      const data = (response as { data?: { issue?: WorkflowScopeIssue } }).data;
      // Test doubles and older SDK adapters may expose rawRequest for other
      // compact queries only; retain the bounded SDK fallback in that case.
      if (data === undefined) return this.#issueBelongsToWorkflowRootViaSdk(issueId, projectId, rootIssueId);
      const issue = data.issue;
      if (!issue) return false;
      if (!Object.prototype.hasOwnProperty.call(issue, "parent")) {
        return this.#issueBelongsToWorkflowRootViaSdk(issueId, projectId, rootIssueId);
      }
      return workflowScopeIssueBelongsToRoot(issue, projectId, rootIssueId);
    }
    return this.#issueBelongsToWorkflowRootViaSdk(issueId, projectId, rootIssueId);
  }

  async #issueBelongsToWorkflowRootViaSdk(
    issueId: string,
    projectId: string,
    rootIssueId: string,
  ): Promise<boolean> {
    const visited = new Set<string>();
    let currentId: string | undefined = issueId;
    for (let depth = 0; currentId && depth <= 32; depth += 1) {
      if (visited.has(currentId)) return false;
      visited.add(currentId);
      const issue = await this.#client.issue(currentId);
      if (issue.projectId !== projectId) return false;
      if (issue.id === rootIssueId) return issue.parentId === undefined || issue.parentId === null;
      currentId = issue.parentId ?? undefined;
    }
    return false;
  }

  async readWorkflowMutationOutcome(
    command: WorkflowMutationCommand,
  ): Promise<WorkflowMutationReadBack | undefined> {
    if (isNativeCommentMutation(command)) {
      return this.#readNativeCommentMutationOutcome(command);
    }
    const outcomeTargetId = command.kind === "create_workflow_issue"
      ? command.parentIssueId
      : command.kind === "create_workflow_relation"
        ? command.sourceIssueId
        : command.target.targetIssueId;
    const hasRawRequest = Boolean(this.#client.client?.rawRequest);
    if (!hasRawRequest && !(await this.#issueBelongsToWorkflowRoot(
      outcomeTargetId, command.expectedProjectId, command.rootIssueId,
    ))) return undefined;
    if (command.kind === "create_workflow_issue") {
      const rawValues = await this.#readWorkflowMutationChildren(command.parentIssueId, command.expectedProjectId, command.rootIssueId);
      let values: Array<Awaited<ReturnType<typeof workflowMutationTargetValue>>>;
      let parentVersion: string | undefined;
      if (rawValues !== undefined) {
        values = rawValues.children;
        parentVersion = rawValues.parentVersion;
      } else {
        const parent = await this.#client.issue(command.parentIssueId);
        parentVersion = parent.updatedAt.toISOString();
        const children = await allNodes(parent.children({ first: 64 }), 64);
        values = await Promise.all(children.map((child) => workflowMutationTargetValue(child)));
      }
      const matches = values.filter((issue) =>
        issue.projectId === command.expectedProjectId &&
        issue.parentIssueId === command.parentIssueId &&
        issue.statusId === command.statusId &&
        issue.title === command.title &&
        issue.description === command.description &&
        (command.order === undefined || issue.order === command.order) &&
        workflowLabelsMatch(issue.labels, command.labelNames),
      );
      if (matches.length > 1) throw new Error("linear_workflow_issue_ambiguous");
      const issue = matches[0];
      if (!issue) return undefined;
      if (issue.projectId !== command.expectedProjectId ||
        issue.parentIssueId !== command.parentIssueId || issue.statusId !== command.statusId ||
        issue.title !== command.title || issue.description !== command.description ||
        !workflowLabelsMatch(issue.labels, command.labelNames)) {
        throw preconditionConflictError();
      }
      return {
        writeId: command.writeId, targetIssueId: issue.issueId, remoteVersion: issue.updatedAt,
        ...(parentVersion ? { issueVersions: [{ issueId: command.parentIssueId, remoteVersion: parentVersion }] } : {}),
      };
    }
    if (command.kind === "update_workflow_issue") {
      const compact = await this.#readCompactWorkflowTarget(
        command.target.targetIssueId, command.expectedProjectId, command.rootIssueId,
      );
      const issue = compact ?? await this.#client.issue(command.target.targetIssueId)
        .then((value) => workflowMutationTargetValue(value));
      return issue && issue.projectId === command.expectedProjectId &&
        issue.statusId === command.statusId && issue.title === command.title &&
        issue.description === command.description &&
        issue.isArchived === command.isArchived &&
        workflowParentAssignmentMatches(issue.parentIssueId, command.parentAssignment) &&
        (command.order === undefined || issue.order === command.order) &&
        (command.target.expectedParentIssueId === undefined || issue.parentIssueId === command.target.expectedParentIssueId)
        ? { writeId: command.writeId, targetIssueId: issue.issueId, remoteVersion: issue.updatedAt,
          issueVersions: [{ issueId: issue.issueId, remoteVersion: issue.updatedAt }] }
        : undefined;
    }
    if (command.kind === "append_workflow_comment") {
      const compact = await this.#readCompactWorkflowCommentOutcome(command);
      if (compact.available) return compact.value;
      const issue = await this.#client.issue(command.target.targetIssueId);
      const comments = await allNodes(issue.comments({ first: PAGE_LIMIT }), MAX_ROOT_COMMENTS);
      const matches = comments.filter((comment) =>
        comment.issueId === command.target.targetIssueId &&
        comment.body === command.body,
      );
      if (matches.length > 1) throw new Error("linear_workflow_comment_ambiguous");
      const comment = matches[0];
      return comment && comment.body === command.body
        ? { writeId: command.writeId, targetIssueId: command.target.targetIssueId, remoteVersion: comment.updatedAt.toISOString(),
          issueVersions: [{ issueId: command.target.targetIssueId, remoteVersion: issue.updatedAt.toISOString() }] }
        : undefined;
    }
    if (command.kind === "create_workflow_attachment") {
      const tree = await this.getWorkflowIssueTree({
        projectId: command.expectedProjectId,
        rootIssueId: command.rootIssueId,
      });
      const matches = tree.attachments.filter((attachment) =>
        attachment.issueId === command.target.targetIssueId &&
        attachment.title === command.title &&
        attachment.url === command.url,
      );
      if (matches.length > 1) throw new Error("linear_workflow_attachment_ambiguous");
      const attachment = matches[0];
      const target = tree.issues.find((issue) => issue.issueId === command.target.targetIssueId);
      return attachment && target
        ? {
          writeId: command.writeId,
          targetIssueId: target.issueId,
          remoteVersion: attachment.remoteVersion,
          issueVersions: [{ issueId: target.issueId, remoteVersion: target.remoteVersion }],
        }
        : undefined;
    }
    if (command.kind !== "create_workflow_relation") return undefined;
    const compactRelation = await this.#readCompactWorkflowRelationOutcome(command);
    if (compactRelation.available) return compactRelation.value;
    const tree = await this.getWorkflowIssueTree({
      projectId: command.expectedProjectId,
      rootIssueId: command.rootIssueId,
    });
    const sourceIssueId = command.relationKind === "blocked_by"
      ? command.targetIssueId : command.sourceIssueId;
    const targetIssueId = command.relationKind === "blocked_by"
      ? command.sourceIssueId : command.targetIssueId;
    const relation = tree.relations.find((value) =>
      value.relationKind === command.relationKind ||
      (command.relationKind === "blocked_by" && value.relationKind === "blocks")
        ? value.sourceIssueId === sourceIssueId && value.targetIssueId === targetIssueId
        : false,
    );
    if ((command.relationState === "present") !== Boolean(relation)) return undefined;
    const source = tree.issues.find((value) => value.issueId === command.sourceIssueId);
    const target = tree.issues.find((value) => value.issueId === command.targetIssueId);
    const root = tree.issues.find((value) => value.issueId === command.rootIssueId);
    return source && target && root
      ? { writeId: command.writeId, targetIssueId: command.sourceIssueId, remoteVersion: source.updatedAt,
        issueVersions: [
          { issueId: command.sourceIssueId, remoteVersion: source.updatedAt },
          { issueId: command.targetIssueId, remoteVersion: target.updatedAt },
          { issueId: command.rootIssueId, remoteVersion: root.updatedAt },
        ] }
      : undefined;
  }

  async #readWorkflowMutationChildren(
    parentIssueId: string,
    projectId: string,
    rootIssueId: string,
  ): Promise<{ children: Array<Awaited<ReturnType<typeof workflowMutationTargetValue>>>; parentVersion: string } | undefined> {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest) return undefined;
    const response = await rawRequest(
      `query WorkflowMutationChildren { issue(id: ${quoteGraphql(parentIssueId)}) { ${workflowScopeSelection(32)} updatedAt children(first: 64, includeArchived: true) { nodes { id updatedAt archivedAt sortOrder subIssueSortOrder project { id } parent { id } state { id } title description labels(first: 64) { nodes { name } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } }`,
    );
    const data = (response as {
      data?: { issue?: { updatedAt?: unknown; children?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: unknown } } | null } | null };
    }).data;
    if (!data?.issue || !workflowScopeIssueBelongsToRoot(data.issue as WorkflowScopeIssue, projectId, rootIssueId)) {
      throw new Error("linear_workflow_parent_read_back_incomplete");
    }
    const children = data.issue.children;
    if (!children || !Array.isArray(children.nodes) || children.pageInfo?.hasNextPage !== false) {
      throw new Error("linear_workflow_children_read_back_incomplete");
    }
    if (typeof data.issue.updatedAt !== "string") throw new Error("linear_workflow_parent_version_missing");
    return {
      children: children.nodes.map((value) => workflowMutationRawTargetValue(value, parentIssueId)),
      parentVersion: data.issue.updatedAt,
    };
  }

  async #readCompactWorkflowTarget(issueId: string, projectId: string, rootIssueId: string) {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest) return undefined;
    const response = await rawRequest(`query WorkflowMutationTarget { issue(id: ${quoteGraphql(issueId)}) { ${workflowScopeSelection(32)} updatedAt archivedAt sortOrder subIssueSortOrder title description state { id } labels(first: 64) { nodes { name } pageInfo { hasNextPage } } } }`);
    const issue = (response as { data?: { issue?: WorkflowPreflightIssue | null } }).data?.issue;
    if (!issue || !workflowScopeIssueBelongsToRoot(issue, projectId, rootIssueId)) return undefined;
    return workflowPreflightTargetValue(issue);
  }

  async #readCompactWorkflowCommentOutcome(
    command: Extract<import("../types.js").WorkflowMutationCommand, { kind: "append_workflow_comment" }>,
  ): Promise<{ available: boolean; value: import("../types.js").WorkflowMutationReadBack | undefined }> {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest) return { available: false, value: undefined };
    const issueId = command.target.targetIssueId;
    const response = await rawRequest(`query WorkflowMutationComment { issue(id: ${quoteGraphql(issueId)}) { ${workflowScopeSelection(32)} updatedAt comments(first: 64) { nodes { id body updatedAt issue { id } } pageInfo { hasNextPage } } } }`);
    const issue = (response as { data?: { issue?: WorkflowPreflightIssue | null } }).data?.issue;
    if (!issue || !workflowScopeIssueBelongsToRoot(issue, command.expectedProjectId, command.rootIssueId)) {
      return { available: true, value: undefined };
    }
    const comments = issue.comments;
    if (!comments || comments.pageInfo?.hasNextPage !== false || !Array.isArray(comments.nodes)) {
      throw new Error("linear_workflow_comment_read_back_incomplete");
    }
    const body = command.body;
    const matches = comments.nodes.filter((comment) => comment.issue?.id === issueId && comment.body === body);
    if (matches.length > 1) throw new Error("linear_workflow_comment_ambiguous");
    return { available: true, value: matches[0]?.updatedAt && typeof issue.updatedAt === "string"
      ? { writeId: command.writeId, targetIssueId: issueId, remoteVersion: matches[0].updatedAt,
        issueVersions: [{ issueId, remoteVersion: issue.updatedAt }] }
      : undefined };
  }

  async #readCompactWorkflowRelationOutcome(
    command: Extract<import("../types.js").WorkflowMutationCommand, { kind: "create_workflow_relation" }>,
  ): Promise<{
    available: boolean;
    value: import("../types.js").WorkflowMutationReadBack | undefined;
  }> {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest) return { available: false, value: undefined };
    const sourceIssueId = command.relationKind === "blocked_by"
      ? command.targetIssueId : command.sourceIssueId;
    const targetIssueId = command.relationKind === "blocked_by"
      ? command.sourceIssueId : command.targetIssueId;
    const response = await rawRequest(`query WorkflowMutationRelation { root: issue(id: ${quoteGraphql(command.rootIssueId)}) { id updatedAt project { id } parent { id } } source: issue(id: ${quoteGraphql(sourceIssueId)}) { ${workflowVersionScopeSelection(32)} } issue(id: ${quoteGraphql(targetIssueId)}) { ${workflowVersionScopeSelection(32)} inverseRelations(first: 64) { nodes { id type issue { id updatedAt project { id } } relatedIssue { id updatedAt project { id } } } pageInfo { hasNextPage } } } }`);
    const data = (response as {
      data?: {
        root?: { id?: string; updatedAt?: string; project?: { id?: string }; parent?: { id?: string } | null };
        source?: WorkflowVersionScopeIssue;
        issue?: WorkflowVersionScopeIssue & {
          inverseRelations?: {
            nodes?: Array<{
              id?: string;
              type?: string;
              issue?: { id?: string; updatedAt?: string; project?: { id?: string } };
              relatedIssue?: { id?: string; updatedAt?: string; project?: { id?: string } };
            }>;
            pageInfo?: { hasNextPage?: boolean };
          };
        };
      };
    }).data;
    const issue = data?.issue;
    const source = data?.source;
    const root = data?.root;
    if (!issue || !source || issue.id !== targetIssueId || source.id !== sourceIssueId ||
        !workflowScopeIssueBelongsToRoot(issue as WorkflowScopeIssue, command.expectedProjectId, command.rootIssueId) ||
        !workflowScopeIssueBelongsToRoot(source as WorkflowScopeIssue, command.expectedProjectId, command.rootIssueId) ||
        !issue.inverseRelations || issue.inverseRelations.pageInfo?.hasNextPage ||
        root?.id !== command.rootIssueId || root.project?.id !== command.expectedProjectId || root.parent != null) {
      throw new Error("linear_workflow_relation_read_back_incomplete");
    }
    const matchedRelation = issue.inverseRelations.nodes?.find((relation) =>
      relation.type === (command.relationKind === "relates_to" ? "related" : "blocks") && relation.issue?.id === sourceIssueId &&
      relation.issue.project?.id === command.expectedProjectId &&
      relation.relatedIssue?.id === targetIssueId &&
      relation.relatedIssue.project?.id === command.expectedProjectId,
    );
    const sourceVersion = latestRemoteVersion(source.updatedAt, matchedRelation?.issue?.updatedAt);
    const targetVersion = latestRemoteVersion(issue.updatedAt, matchedRelation?.relatedIssue?.updatedAt);
    const commandSourceVersion = command.relationKind === "blocked_by" ? targetVersion : sourceVersion;
    const commandTargetVersion = command.relationKind === "blocked_by" ? sourceVersion : targetVersion;
    const matchesDesiredState = (command.relationState === "present") === Boolean(matchedRelation);
    const readBack = matchesDesiredState
      ? commandSourceVersion && commandTargetVersion && root.updatedAt
        ? {
            writeId: command.writeId,
            targetIssueId: command.sourceIssueId,
            remoteVersion: commandSourceVersion,
            issueVersions: [...new Map([
              { issueId: command.sourceIssueId, remoteVersion: commandSourceVersion },
              { issueId: command.targetIssueId, remoteVersion: commandTargetVersion },
              ...workflowAncestryVersions(source, command.expectedProjectId, command.rootIssueId).slice(1),
              ...workflowAncestryVersions(issue, command.expectedProjectId, command.rootIssueId).slice(1),
              { issueId: command.rootIssueId, remoteVersion: root.updatedAt },
            ].map((version) => [version.issueId, version])).values()]
          }
        : (() => { throw new Error("linear_workflow_relation_version_missing"); })()
      : undefined;
    return {
      available: true,
      value: readBack,
    };
  }

  async #workflowStatusId(issue: Issue, statusId: string): Promise<void> {
    if (!issue.projectId) throw new Error("linear_workflow_project_missing");
    const statusIds = await this.#workflowStatusIds(issue.projectId, issue);
    if (!statusIds.has(statusId)) {
      throw new Error("linear_workflow_status_invalid");
    }
  }

  #workflowStatusIds(projectId: string, issue: Issue): Promise<Set<string>> {
    const cached = this.#workflowStatusIdsCache.get(projectId);
    if (cached) return cached;
    const pending = (async () => {
      const team = await issue.team;
      if (!team) throw new Error("linear_workflow_team_missing");
      const states = await allNodes(team.states({ first: 64 }), 64);
      const ids = states.map(({ id }) => id);
      if (ids.some((id) => !SAFE_ID.test(id)) || new Set(ids).size !== ids.length) {
        throw new Error("linear_workflow_status_invalid");
      }
      return new Set(ids);
    })().catch((error) => {
      this.#workflowStatusIdsCache.delete(projectId);
      throw error;
    });
    this.#workflowStatusIdsCache.set(projectId, pending);
    return pending;
  }

  #workflowStatusCatalog(projectId: string, issueId: string): Promise<WorkflowStatusCatalogEntry[]> {
    const cached = this.#workflowStatusCatalogCache.get(projectId);
    if (cached) return cached;
    const pending = this.#readWorkflowStatusCatalog(projectId, issueId).catch((error) => {
      this.#workflowStatusCatalogCache.delete(projectId);
      throw error;
    });
    this.#workflowStatusCatalogCache.set(projectId, pending);
    return pending;
  }

  async #readWorkflowStatusCatalog(projectId: string, issueId: string): Promise<WorkflowStatusCatalogEntry[]> {
    const issue = await this.#client.issue(issueId);
    if (issue.projectId !== projectId) throw new Error("linear_workflow_tree_project_mismatch");
    const team = await issue.team;
    if (!team) throw new Error("linear_workflow_status_catalog_missing");
    const states = await allNodes(team.states({ first: 64 }), 64);
    const catalog = states.map((state) => {
      if (typeof state.id !== "string" || typeof state.name !== "string" ||
          typeof state.type !== "string" || typeof state.position !== "number") {
        throw new Error("linear_workflow_status_catalog_invalid");
      }
      return {
        statusId: state.id,
        name: state.name,
        category: workflowStatusCategory(state.type),
        position: state.position,
      };
    });
    this.#workflowStatusIdsCache.set(projectId, Promise.resolve(new Set(catalog.map(({ statusId }) => statusId))));
    return catalog;
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
    const matches = await this.#issueLabelsNamed(name, teamId);
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

  async #workflowIssueLabelIds(labelNames: readonly string[], teamId: string): Promise<string[]> {
    const names = validateWorkflowLabelNames(labelNames);
    const ids: string[] = [];
    for (const name of names) {
      const matches = await this.#issueLabelsNamed(name, teamId);
      if (matches.length === 0) throw new Error("linear_workflow_label_missing");
      if (matches.length > 1) throw new Error("linear_workflow_label_ambiguous");
      if (!SAFE_ID.test(matches[0]!.id)) throw new Error("linear_workflow_label_id_invalid");
      ids.push(matches[0]!.id);
    }
    return ids;
  }

  async #readTargetWorkflowLabels(teamId: string): Promise<string[]> {
    const names: string[] = [];
    for (const name of TARGET_WORKFLOW_LABEL_NAMES) {
      const matches = await this.#issueLabelsNamed(name, teamId);
      if (matches.length > 1) throw new Error("linear_issue_label_ambiguous");
      if (matches.length === 1) names.push(name);
    }
    return names;
  }

  async #issueLabelsNamed(name: string, teamId?: string): Promise<IssueLabel[]> {
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
    return matches;
  }
}

function clientOptions(credential: LinearSdkCredential):
  | { accessToken: string }
  | { apiKey: string } {
  return credential.kind === "oauth"
    ? { accessToken: credential.token }
    : { apiKey: credential.token };
}

function quoteGraphql(value: string): string {
  return JSON.stringify(value);
}

function observedClient(
  credential: LinearSdkCredential,
  observation: LinearRequestObservationOptions | undefined,
  signal?: AbortSignal,
): LinearClient {
  const client = new LinearClient({
    ...clientOptions(credential),
    ...(signal ? { signal } : {}),
  });
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
  const startedAt = observation.now();
  const correlationId = observation.correlationId();
  try {
    await observation.beforePhysicalRequest?.(document);
    const result = await request();
    const response = responseMetadata(result);
    observation.observe?.(requestObservation(
      document,
      correlationId,
      observation.now() - startedAt,
      response.status,
      response.headers,
    ));
    return result;
  } catch (error) {
    const response = errorResponseMetadata(error);
    observation.observe?.(requestObservation(
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

function workflowCommentValue(
  comment: IssueTreeComment,
  issueId: string,
  delegateActorId: string,
): WorkflowCommentValue {
  const commentIssue = comment.issue as { id?: unknown } | undefined;
  if (
    commentIssue === undefined || commentIssue.id !== issueId
  ) {
    throw new Error("linear_workflow_comment_identity_mismatch");
  }
  const actor = workflowCommentActor(comment, delegateActorId);
  const parentCommentId = commentParentId(comment);
  return {
    commentId: comment.id,
    issueId,
    authorKind: actor.kind,
    authorId: actor.id,
    ...(actor.userId ? { authorUserId: actor.userId } : {}),
    ...(parentCommentId ? { parentCommentId } : {}),
    threadRootCommentId: parentCommentId ?? comment.id,
    threadState: comment.resolvedAt === null
      ? "unresolved"
      : (timestampValue(comment.resolvedAt), "resolved"),
    reactions: workflowCommentReactions(comment.reactions, delegateActorId),
    body: comment.body,
    createdAt: timestampValue(comment.createdAt),
    remoteVersion: timestampValue(comment.updatedAt),
    updatedAt: timestampValue(comment.updatedAt),
  };
}

function normalizeWorkflowCommentThreads(
  comments: WorkflowCommentValue[],
): WorkflowCommentValue[] {
  const byId = new Map(comments.map((comment) => [comment.commentId, comment]));
  if (byId.size !== comments.length) throw new Error("linear_workflow_comment_ambiguous");
  return comments.map((comment) => {
    const visited = new Set<string>();
    let root = comment;
    while (root.parentCommentId !== undefined) {
      if (visited.has(root.commentId)) throw new Error("linear_workflow_comment_thread_invalid");
      visited.add(root.commentId);
      const parent = byId.get(root.parentCommentId);
      if (!parent) throw new Error("linear_workflow_comment_thread_incomplete");
      root = parent;
    }
    return {
      ...comment,
      threadRootCommentId: root.commentId,
      threadState: root.threadState,
    };
  });
}

type WorkflowCommentSource = {
  id: string;
  issue?: unknown;
  issueId?: string | null;
  body: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  user?: unknown;
  userId?: string | null | undefined;
  botActor?: unknown;
  externalUser?: unknown;
  externalUserId?: string | null | undefined;
};

function commentParentId(comment: IssueTreeComment): string | undefined {
  if (comment.parent === null) return undefined;
  if (typeof comment.parent.id !== "string" || !SAFE_ID.test(comment.parent.id)) {
    throw new Error("linear_workflow_comment_parent_invalid");
  }
  if (comment.parent.id === comment.id) throw new Error("linear_workflow_comment_parent_invalid");
  return comment.parent.id;
}

function workflowCommentReactions(
  reactions: IssueTreeComment["reactions"],
  delegateActorId: string,
): import("../types.js").WorkflowCommentReactionValue[] {
  if (!Array.isArray(reactions) || reactions.length > 256) {
    throw new Error("linear_workflow_comment_reactions_incomplete");
  }
  const reactionIds = new Set<string>();
  return reactions.map((reaction) => {
    if (!reaction || typeof reaction !== "object") throw new Error("linear_workflow_comment_reaction_invalid");
    const value = reaction as {
      id?: unknown;
      emoji?: unknown;
      user?: unknown;
    };
    if (typeof value.id !== "string" || !SAFE_ID.test(value.id) ||
        typeof value.emoji !== "string" || value.emoji.length === 0 || value.emoji.length > 256 ||
        reactionIds.has(value.id)) {
      throw new Error("linear_workflow_comment_reaction_invalid");
    }
    reactionIds.add(value.id);
    const actor = workflowCommentActor({
      id: value.id,
      body: "",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      user: value.user,
    }, delegateActorId);
    return {
      reactionId: value.id,
      emoji: value.emoji,
      actorKind: actor.kind,
      actorId: actor.id,
    };
  });
}

function indexLabels(value: ProjectRootIndexIssue["labels"]): ConductorPoolValue[] {
  if (
    !value ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > 1 ||
    value.pageInfo?.hasNextPage !== false ||
    value.nodes.some((label) => typeof label.name !== "string" || !label.name.startsWith(CONDUCTOR_LABEL_PREFIX))
  ) {
    throw new Error("linear_project_root_index_routing_invalid");
  }
  return conductorPoolFromLabels(value.nodes.map((label) => label.name!));
}

function indexBlockers(
  value: ProjectRootIndexIssue["inverseRelations"],
  rootIssueId: string,
): LinearBlockerValue[] {
  if (
    !value ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > 250 ||
    value.pageInfo?.hasNextPage !== false
  ) {
    throw new Error("linear_project_root_index_blockers_incomplete");
  }
  const relationIds = new Set<string>();
  const blockers: LinearBlockerValue[] = [];
  for (const relation of value.nodes) {
    if (relation.type !== "blocks") continue;
    const relationId = relation.id;
    const sourceIssueId = relation.issue?.id;
    const targetIssueId = relation.relatedIssue?.id;
    const targetState = relation.issue?.state?.name;
    if (
      typeof relationId !== "string" ||
      !SAFE_ID.test(relationId) ||
      typeof sourceIssueId !== "string" ||
      !SAFE_ID.test(sourceIssueId) ||
      typeof targetIssueId !== "string" ||
      !SAFE_ID.test(targetIssueId) ||
      sourceIssueId === rootIssueId ||
      targetIssueId !== rootIssueId ||
      !targetState ||
      relationIds.has(relationId)
    ) {
      throw new Error("linear_project_root_index_blocker_invalid");
    }
    relationIds.add(relationId);
    blockers.push({
      sourceIssueId: rootIssueId,
      targetIssueId: sourceIssueId,
      targetState: linearIssueState(targetState),
    });
  }
  return blockers;
}

function boundedTextValue(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length <= 16_384 && !value.includes("\0");
}

function shortTextValue(value: string): boolean {
  return Array.from(value).length >= 1 && Array.from(value).length <= 256 && !value.includes("\0");
}

function timestampValueOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return timestampValue(value);
  } catch {
    return undefined;
  }
}

function workflowCommentActor(
  comment: WorkflowCommentSource,
  delegateActorId: string,
): { kind: WorkflowCommentAuthorKind; id: string; userId?: string } {
  const userId: string | undefined = comment.userId ?? readActorId(comment.user);
  const botId: string | undefined = readActorId(comment.botActor);
  const externalUserId: string | undefined = comment.externalUserId ?? readActorId(comment.externalUser);
  const selectedActorId = [userId, botId, externalUserId].find((value) => value === delegateActorId)
    ?? botId
    ?? externalUserId
    ?? userId;
  if (!selectedActorId || !SAFE_ID.test(selectedActorId)) throw new Error("linear_workflow_comment_actor_missing");
  if (selectedActorId === delegateActorId) {
    return { kind: "symphony", id: selectedActorId, ...(userId ? { userId } : {}) };
  }
  if (botId) return { kind: "external_automation", id: botId };
  if (externalUserId) return { kind: "linear_integration", id: externalUserId };
  return { kind: "human", id: userId!, userId: userId! };
}

function readActorId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || !("id" in value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function workflowRelationValues(
  facts: Map<string, { fact: IssueTreeFact; depth: number }>,
  projectId: string,
): WorkflowRelationValue[] {
  const issueIds = new Set(facts.keys());
  const relations: WorkflowRelationValue[] = [];
  const relationIds = new Set<string>();
  for (const { fact } of facts.values()) {
    for (const relation of fact.inverseRelations.nodes) {
      const relationKind = workflowRelationKindValue(relation.type);
      if (!relationKind) continue;
      if (
        !relation.id ||
        !relation.issue ||
        !relation.relatedIssue ||
        relation.relatedIssue.id !== fact.id ||
        relation.issue.id === fact.id ||
        relation.issue.project?.id !== projectId ||
        relation.relatedIssue.project?.id !== projectId ||
        relationIds.has(relation.id)
      ) {
        throw new Error("linear_workflow_relation_invalid");
      }
      if (!issueIds.has(relation.issue.id)) continue;
      relationIds.add(relation.id);
      relations.push({
        relationId: relation.id,
        relationKind,
        sourceIssueId: relation.issue.id,
        targetIssueId: relation.relatedIssue.id,
      });
    }
  }
  return relations;
}

function workflowAttachmentValue(
  attachment: IssueTreeAttachment,
  issueId: string,
): WorkflowAttachmentValue {
  if (
    !SAFE_ID.test(attachment.id) ||
    attachment.issue?.id !== issueId ||
    !boundedTextValue(attachment.title) ||
    !boundedTextValue(attachment.url) ||
    !shortTextValue(attachment.sourceType)
  ) {
    throw new Error("linear_workflow_attachment_invalid");
  }
  const createdAt = timestampValue(attachment.createdAt);
  const updatedAt = timestampValue(attachment.updatedAt);
  return {
    attachmentId: attachment.id,
    issueId,
    title: attachment.title,
    url: attachment.url,
    sourceType: attachment.sourceType,
    remoteVersion: updatedAt,
    createdAt,
    updatedAt,
  };
}

function workflowActivityValue(
  activity: IssueTreeActivity,
  issueId: string,
  delegateActorId: string,
): WorkflowActivityValue | undefined {
  if (!SAFE_ID.test(activity.id) || activity.issue?.id !== issueId) {
    throw new Error("linear_workflow_activity_invalid");
  }
  const actorId = activity.actor?.id;
  const botActorId = activity.botActor?.id;
  if ((actorId && !SAFE_ID.test(actorId)) || (botActorId && !SAFE_ID.test(botActorId)) ||
      (actorId !== undefined && botActorId !== undefined)) {
    throw new Error("linear_workflow_activity_actor_invalid");
  }
  const activityKinds: WorkflowActivityKind[] = [];
  if (activity.fromStateId != null || activity.toStateId != null) activityKinds.push("status_changed");
  if (activity.updatedDescription != null) activityKinds.push("description_changed");
  if (activity.archived != null) activityKinds.push("archive_changed");
  if ((activity.addedLabelIds?.length ?? 0) > 0 || (activity.removedLabelIds?.length ?? 0) > 0) {
    activityKinds.push("labels_changed");
  }
  if (activity.fromParentId != null || activity.toParentId != null) activityKinds.push("parent_changed");
  if (activity.fromDelegate != null || activity.toDelegate != null) activityKinds.push("delegation_changed");
  if (activity.attachmentId != null) activityKinds.push("attachment_changed");
  if (activityKinds.length === 0) return undefined;

  const addedLabelIds = workflowActivityIds(activity.addedLabelIds);
  const removedLabelIds = workflowActivityIds(activity.removedLabelIds);
  const fromStateId = workflowOptionalId(activity.fromStateId);
  const toStateId = workflowOptionalId(activity.toStateId);
  const fromParentId = workflowOptionalId(activity.fromParentId);
  const toParentId = workflowOptionalId(activity.toParentId);
  const fromDelegateId = workflowOptionalId(activity.fromDelegate?.id);
  const toDelegateId = workflowOptionalId(activity.toDelegate?.id);
  const attachmentId = workflowOptionalId(activity.attachmentId);
  if (activity.updatedDescription !== undefined && activity.updatedDescription !== null &&
      !boundedTextValue(activity.updatedDescription)) {
    throw new Error("linear_workflow_activity_description_invalid");
  }
  const selectedActorId = actorId ?? botActorId;
  const actorKind: WorkflowCommentAuthorKind = selectedActorId === undefined
    ? "unknown"
    : selectedActorId === delegateActorId
      ? "symphony"
      : botActorId
        ? "external_automation"
        : "human";
  return {
    activityId: activity.id,
    issueId,
    activityKinds,
    actorKind,
    ...(selectedActorId ? { actorId: selectedActorId } : {}),
    ...(fromStateId ? { fromStateId } : {}),
    ...(toStateId ? { toStateId } : {}),
    ...(activity.updatedDescription !== undefined && activity.updatedDescription !== null
      ? { updatedDescription: activity.updatedDescription } : {}),
    ...(activity.archived !== undefined && activity.archived !== null ? { archived: activity.archived } : {}),
    ...(addedLabelIds !== undefined ? { addedLabelIds } : {}),
    ...(removedLabelIds !== undefined ? { removedLabelIds } : {}),
    ...(fromParentId ? { fromParentId } : {}),
    ...(toParentId ? { toParentId } : {}),
    ...(fromDelegateId ? { fromDelegateId } : {}),
    ...(toDelegateId ? { toDelegateId } : {}),
    ...(attachmentId ? { attachmentId } : {}),
    remoteVersion: timestampValue(activity.updatedAt),
    createdAt: timestampValue(activity.createdAt),
  };
}

function workflowOptionalId(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!SAFE_ID.test(value)) throw new Error("linear_workflow_activity_reference_invalid");
  return value;
}

function workflowActivityIds(value: string[] | null | undefined): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64 || value.some((id) => !SAFE_ID.test(id)) ||
      new Set(value).size !== value.length) {
    throw new Error("linear_workflow_activity_references_invalid");
  }
  return value;
}

function workflowSourceManifest(input: {
  projectId: string;
  statusCatalog: readonly WorkflowStatusCatalogEntry[];
  issues: readonly LinearIssueValue[];
  comments: readonly WorkflowCommentValue[];
  relations: readonly WorkflowRelationValue[];
  attachments: readonly WorkflowAttachmentValue[];
  activities: readonly WorkflowActivityValue[];
}): WorkflowSourceManifestEntryValue[] {
  const statusVersion = createHash("sha256")
    .update(JSON.stringify(input.statusCatalog.map((status) => ({
      statusId: status.statusId,
      name: status.name,
      category: status.category,
      position: status.position,
    }))))
    .digest("hex");
  return [
    ...input.issues.map((issue) => ({
      sourceKind: "linear_issue" as const,
      sourceId: issue.issueId,
      sourceVersion: issue.updatedAt,
      actorKind: "unknown" as const,
    })),
    ...input.comments.map((comment) => ({
      sourceKind: "linear_comment" as const,
      sourceId: comment.commentId,
      sourceVersion: comment.updatedAt,
      actorKind: comment.authorKind,
    })),
    ...input.relations.map((relation) => ({
      sourceKind: "linear_relation" as const,
      sourceId: relation.relationId,
      sourceVersion: relation.relationId,
      actorKind: "unknown" as const,
    })),
    ...input.attachments.map((attachment) => ({
      sourceKind: "linear_attachment" as const,
      sourceId: attachment.attachmentId,
      sourceVersion: attachment.remoteVersion,
      actorKind: "unknown" as const,
    })),
    ...input.activities.map((activity) => ({
      sourceKind: "linear_activity" as const,
      sourceId: activity.activityId,
      sourceVersion: activity.remoteVersion,
      actorKind: activity.actorKind,
    })),
    {
      sourceKind: "linear_status_catalog" as const,
      sourceId: `${input.projectId}:status-catalog`,
      sourceVersion: statusVersion,
      actorKind: "unknown" as const,
    },
  ];
}

function workflowRelationKindValue(
  value: string,
): WorkflowRelationValue["relationKind"] | undefined {
  if (value === "blocks" || value === "blocked_by" || value === "relates_to" || value === "triggered_by") {
    if (value === "relates_to") return value;
    return value;
  }
  if (value === "related") return "relates_to";
  return undefined;
}

async function workflowMutationTargetValue(issue: Issue) {
  const state = await issue.state;
  if (!state || !issue.projectId) throw new Error("linear_workflow_target_invalid");
  const labels = workflowIssueLabelNames(await allNodes(issue.labels({ first: 64 }), 64));
  return {
    issueId: issue.id,
    projectId: issue.projectId,
    updatedAt: timestampValue(issue.updatedAt),
    order: issue.subIssueSortOrder ?? issue.sortOrder,
    labels,
    isArchived: issue.archivedAt !== null && issue.archivedAt !== undefined,
    ...(issue.parentId ? { parentIssueId: issue.parentId } : {}),
    statusId: state.id,
    title: issue.title,
    description: issue.description ?? "",
  };
}

function workflowPreflightTargetValue(issue: WorkflowPreflightIssue) {
  if (typeof issue.updatedAt !== "string" || typeof issue.project?.id !== "string" ||
      typeof issue.sortOrder !== "number" ||
      (issue.subIssueSortOrder !== null && issue.subIssueSortOrder !== undefined && typeof issue.subIssueSortOrder !== "number") ||
      typeof issue.state?.id !== "string" || typeof issue.title !== "string" ||
      typeof issue.description !== "string") throw new Error("linear_workflow_target_invalid");
  return {
    issueId: issue.id,
    projectId: issue.project.id,
    updatedAt: issue.updatedAt,
    order: issue.subIssueSortOrder ?? issue.sortOrder,
    labels: workflowRawLabelNames(issue.labels),
    isArchived: issue.archivedAt !== null && issue.archivedAt !== undefined,
    ...(issue.parent?.id ? { parentIssueId: issue.parent.id } : {}),
    statusId: issue.state.id,
    title: issue.title,
    description: issue.description,
  };
}

function workflowPreflightOutcome(
  command: import("../types.js").WorkflowMutationCommand,
  facts: ReadonlyMap<string, WorkflowPreflightIssue>,
): import("../types.js").WorkflowMutationReadBack | undefined {
  if (isNativeCommentMutation(command)) return undefined;
  if (command.kind === "create_workflow_issue") {
    const children = facts.get(command.parentIssueId)?.children;
    if (!children || children.pageInfo?.hasNextPage !== false || !Array.isArray(children.nodes)) {
      throw new Error("linear_workflow_children_read_back_incomplete");
    }
    const matches = children.nodes.map((value) => workflowMutationRawTargetValue(value, command.parentIssueId))
      .filter((value) =>
        value.projectId === command.expectedProjectId &&
        value.statusId === command.statusId &&
        value.title === command.title &&
        value.description === command.description &&
        (command.order === undefined || value.order === command.order) &&
        workflowLabelsMatch(value.labels, command.labelNames),
      );
    if (matches.length > 1) throw new Error("linear_workflow_issue_ambiguous");
    const issue = matches[0];
    if (!issue) return undefined;
    if (issue.projectId !== command.expectedProjectId || issue.statusId !== command.statusId ||
        issue.title !== command.title || issue.description !== command.description ||
        !workflowLabelsMatch(issue.labels, command.labelNames)) throw preconditionConflictError();
    return { writeId: command.writeId, targetIssueId: issue.issueId, remoteVersion: issue.updatedAt };
  }
  if (command.kind === "update_workflow_issue") {
    const target = workflowPreflightTargetValue(facts.get(command.target.targetIssueId)!);
    return target.statusId === command.statusId && target.title === command.title &&
      target.description === command.description &&
      workflowLabelsMatch(target.labels, command.labelNames) &&
      target.isArchived === command.isArchived &&
      workflowParentAssignmentMatches(target.parentIssueId, command.parentAssignment) &&
      (command.order === undefined || target.order === command.order) &&
      (command.target.expectedParentIssueId === undefined || target.parentIssueId === command.target.expectedParentIssueId)
      ? { writeId: command.writeId, targetIssueId: target.issueId, remoteVersion: target.updatedAt } : undefined;
  }
  if (command.kind === "append_workflow_comment") {
    const comments = facts.get(command.target.targetIssueId)?.comments;
    if (!comments || comments.pageInfo?.hasNextPage !== false || !Array.isArray(comments.nodes)) {
      throw new Error("linear_workflow_comment_read_back_incomplete");
    }
    const body = command.body;
    const matches = comments.nodes.filter((comment) => comment.issue?.id === command.target.targetIssueId && comment.body === body);
    if (matches.length > 1) throw new Error("linear_workflow_comment_ambiguous");
    return matches[0]?.updatedAt
      ? { writeId: command.writeId, targetIssueId: command.target.targetIssueId, remoteVersion: matches[0].updatedAt }
      : undefined;
  }
  if (command.kind !== "create_workflow_relation") return undefined;
  const sourceIssueId = command.relationKind === "blocked_by" ? command.targetIssueId : command.sourceIssueId;
  const targetIssueId = command.relationKind === "blocked_by" ? command.sourceIssueId : command.targetIssueId;
  const relations = facts.get(targetIssueId)?.inverseRelations;
  if (!relations || relations.pageInfo?.hasNextPage !== false || !Array.isArray(relations.nodes)) {
    throw new Error("linear_workflow_relation_read_back_incomplete");
  }
  const relation = relations.nodes.find((value) =>
    value.type === (command.relationKind === "relates_to" ? "related" : "blocks") &&
    value.issue?.id === sourceIssueId && value.relatedIssue?.id === targetIssueId);
  if ((command.relationState === "present") !== Boolean(relation)) return undefined;
  const source = facts.get(command.sourceIssueId);
  const target = facts.get(command.targetIssueId);
  const root = facts.get(command.rootIssueId);
  return source && target && root && typeof source.updatedAt === "string" && typeof target.updatedAt === "string" && typeof root.updatedAt === "string"
    ? {
        writeId: command.writeId,
        targetIssueId: command.sourceIssueId,
        remoteVersion: source.updatedAt,
        issueVersions: [
          { issueId: command.sourceIssueId, remoteVersion: source.updatedAt },
          { issueId: command.targetIssueId, remoteVersion: target.updatedAt },
          { issueId: command.rootIssueId, remoteVersion: root.updatedAt },
        ],
      }
    : undefined;
}

function workflowPreflightRelation(
  facts: ReadonlyMap<string, WorkflowPreflightIssue>,
  command: Extract<import("../types.js").WorkflowMutationCommand, { kind: "create_workflow_relation" }>,
) {
  const sourceIssueId = command.relationKind === "blocked_by" ? command.targetIssueId : command.sourceIssueId;
  const targetIssueId = command.relationKind === "blocked_by" ? command.sourceIssueId : command.targetIssueId;
  const expectedType = command.relationKind === "relates_to" ? "related" : "blocks";
  return [...facts.values()].flatMap((fact) => fact.inverseRelations?.nodes ?? []).find((relation) =>
    relation.type === expectedType && relation.issue?.id === sourceIssueId &&
    relation.relatedIssue?.id === targetIssueId);
}

function assertNativeWorkflowContent(value: string): void {
  if (/```json|<!--|\0/u.test(value)) {
    throw new Error("linear_workflow_machine_content_rejected");
  }
}

function workflowPreconditionMismatch(
  command: import("../types.js").WorkflowMutationCommand,
  facts: ReadonlyMap<string, WorkflowPreflightIssue>,
): string | undefined {
  if (isNativeCommentMutation(command)) return "native_comment_command";
  const targets = command.kind === "create_workflow_issue" ? [command.parentIssueId]
    : command.kind === "create_workflow_relation" ? [command.sourceIssueId, command.targetIssueId]
      : [command.target.targetIssueId];
  if ([command.rootIssueId, ...targets].some((id) => {
    const issue = facts.get(id);
    return !issue || !workflowScopeIssueBelongsToRoot(issue, command.expectedProjectId, command.rootIssueId);
  })) return "scope";
  const root = facts.get(command.rootIssueId)!;
  if (root.updatedAt !== command.expectedRootRemoteVersion) return "root_remote_version";
  if (command.kind === "create_workflow_issue") {
    const parent = workflowPreflightTargetValue(facts.get(command.parentIssueId)!);
    if (parent.updatedAt !== command.parentExpectedRemoteVersion) return "parent_remote_version";
    if (parent.statusId !== command.parentExpectedStatusId) return "parent_status";
    return workflowPreflightHasStatus(facts.get(command.parentIssueId)!, command.statusId)
      ? undefined : "target_status_catalog";
  }
  if (command.kind === "create_workflow_relation") {
    if (facts.get(command.sourceIssueId)?.updatedAt !== command.sourceExpectedRemoteVersion) return "relation_source_remote_version";
    return facts.get(command.targetIssueId)?.updatedAt === command.targetExpectedRemoteVersion
      ? undefined : "relation_target_remote_version";
  }
  const target = workflowPreflightTargetValue(facts.get(command.target.targetIssueId)!);
  if (target.updatedAt !== command.target.expectedRemoteVersion) return "target_remote_version";
  if (command.target.expectedStatusId !== undefined && target.statusId !== command.target.expectedStatusId) return "target_status";
  if (command.target.expectedParentIssueId !== undefined && target.parentIssueId !== command.target.expectedParentIssueId) return "target_parent";
  if (command.target.expectedIsArchived !== undefined && target.isArchived !== command.target.expectedIsArchived) return "target_archive";
  return command.kind !== "update_workflow_issue" || workflowPreflightHasStatus(facts.get(command.target.targetIssueId)!, command.statusId)
    ? undefined : "target_status_catalog";
}

function nativeCommentPreconditionsMatch(
  command: NativeCommentMutation,
  tree: {
    rootRemoteVersion: string;
    comments: ReadonlyMap<string, WorkflowCommentValue>;
  },
): boolean {
  if (tree.rootRemoteVersion !== command.expectedRootRemoteVersion) return false;
  switch (command.kind) {
    case "create_comment_reply": {
      const source = tree.comments.get(command.sourceCommentId);
      return source?.remoteVersion === command.expectedSourceCommentRemoteVersion &&
        source.threadRootCommentId === command.expectedThreadRootCommentId &&
        source.threadState === command.expectedThreadState;
    }
    case "set_comment_receipt_reaction": {
      const source = tree.comments.get(command.sourceCommentId);
      return source?.remoteVersion === command.expectedSourceCommentRemoteVersion &&
        source.threadRootCommentId === command.threadRootCommentId &&
        symphonyReceipt(source).receipt === command.expectedReceipt;
    }
    case "set_comment_thread_state": {
      const source = tree.comments.get(command.sourceCommentId);
      return source?.remoteVersion === command.expectedSourceCommentRemoteVersion &&
        source.threadRootCommentId === command.threadRootCommentId &&
        source.threadState === command.expectedThreadState;
    }
  }
}

function workflowPreflightHasStatus(issue: WorkflowPreflightIssue, statusId: string): boolean {
  const states = issue.team?.states;
  return Boolean(issue.team?.id && states && states.pageInfo?.hasNextPage === false &&
    Array.isArray(states.nodes) && states.nodes.some((state) => state.id === statusId));
}

function workflowMutationRawTargetValue(value: unknown, expectedParentIssueId: string) {
  if (!value || typeof value !== "object") throw new Error("linear_workflow_target_invalid");
  const raw = value as {
    id?: unknown;
    updatedAt?: unknown;
    sortOrder?: unknown;
    subIssueSortOrder?: unknown;
    archivedAt?: unknown;
    project?: { id?: unknown } | null;
    parent?: { id?: unknown } | null;
    state?: { id?: unknown } | null;
    title?: unknown;
    description?: unknown;
    labels?: unknown;
  };
  if (typeof raw.id !== "string" || typeof raw.updatedAt !== "string" ||
      typeof raw.project?.id !== "string" || raw.parent?.id !== expectedParentIssueId ||
      typeof raw.state?.id !== "string" || typeof raw.title !== "string" ||
      typeof raw.description !== "string" ||
      typeof raw.sortOrder !== "number" ||
      (raw.subIssueSortOrder !== null && raw.subIssueSortOrder !== undefined && typeof raw.subIssueSortOrder !== "number") ||
      (raw.archivedAt !== null && raw.archivedAt !== undefined && typeof raw.archivedAt !== "string")) {
    throw new Error("linear_workflow_target_invalid");
  }
  return {
    issueId: raw.id,
    projectId: raw.project.id,
    updatedAt: raw.updatedAt,
    order: raw.subIssueSortOrder ?? raw.sortOrder,
    labels: workflowRawLabelNames(raw.labels, true),
    isArchived: raw.archivedAt !== null && raw.archivedAt !== undefined,
    parentIssueId: expectedParentIssueId,
    statusId: raw.state.id,
    title: raw.title,
    description: raw.description,
  };
}

function validateWorkflowLabelNames(labelNames: readonly string[]): string[] {
  if (!Array.isArray(labelNames) || labelNames.length > 64 ||
      labelNames.some((name) => !shortText(name))) {
    throw new Error("linear_workflow_label_names_invalid");
  }
  const names = [...labelNames];
  if (new Set(names).size !== names.length) throw new Error("linear_workflow_label_duplicate");
  return names;
}

function workflowIssueLabelNames(labels: Array<{ name?: unknown }>): string[] {
  if (!Array.isArray(labels) || labels.length > 64 ||
      labels.some((label) => !label || !shortText(label.name as string | undefined))) {
    throw new Error("linear_workflow_labels_invalid");
  }
  const names = labels.map(({ name }) => name as string);
  if (new Set(names).size !== names.length) throw new Error("linear_workflow_labels_ambiguous");
  return names;
}

function workflowRawLabelNames(value: unknown, required = false): string[] {
  if (value === undefined) {
    if (required) throw new Error("linear_workflow_labels_incomplete");
    return [];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("linear_workflow_labels_invalid");
  }
  const raw = value as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } };
  if (!Array.isArray(raw.nodes) || raw.nodes.length > 64 || raw.pageInfo?.hasNextPage !== false) {
    throw new Error("linear_workflow_labels_incomplete");
  }
  return workflowIssueLabelNames(raw.nodes.map((label) => {
    if (!label || typeof label !== "object" || Array.isArray(label)) return { name: undefined };
    return { name: (label as { name?: unknown }).name };
  }));
}

function workflowLabelsMatch(observed: string[], expected: readonly string[]): boolean {
  const expectedNames = validateWorkflowLabelNames(expected).sort();
  const observedNames = workflowIssueLabelNames(observed.map((name) => ({ name }))).sort();
  return expectedNames.length === observedNames.length &&
    expectedNames.every((name, index) => observedNames[index] === name);
}

function workflowParentAssignmentMatches(
  parentIssueId: string | undefined,
  assignment: Extract<WorkflowMutationCommand, { kind: "update_workflow_issue" }>["parentAssignment"],
): boolean {
  if (assignment.mode === "retain") return true;
  if (assignment.mode === "clear") return parentIssueId === undefined;
  return parentIssueId === assignment.parentIssueId;
}

function compareTreeFacts(left: IssueTreeFact, right: IssueTreeFact): number {
  return (left.subIssueSortOrder ?? left.sortOrder) -
      (right.subIssueSortOrder ?? right.sortOrder) ||
    left.identifier.localeCompare(right.identifier);
}

async function completeNestedIssueTreeFact(
  rawRequest: <Data, Variables extends Record<string, unknown>>(
    query: string,
    variables: Variables,
  ) => Promise<{ data?: Data }>,
  fact: IssueTreeFact,
): Promise<void> {
  if (fact.comments.pageInfo.hasNextPage) {
    let cursor = fact.comments.pageInfo.endCursor;
    const seenCursors = new Set<string>();
    while (fact.comments.pageInfo.hasNextPage) {
      if (!cursor || seenCursors.has(cursor)) throw new Error("linear_tree_batch_incomplete");
      seenCursors.add(cursor);
      const response = await rawRequest<IssueTreeNestedPageData, {
        issueId: string;
        cursor: string;
      }>(WORKFLOW_ISSUE_TREE_COMMENTS_PAGE_QUERY, { issueId: fact.id, cursor });
      const page = response.data?.issue;
      if (!page || page.id !== fact.id || !page.comments) {
        throw new Error("linear_tree_batch_incomplete");
      }
      if (page.comments.nodes.some((comment) => comment.issue.id !== fact.id)) {
        throw new Error("linear_tree_batch_invalid");
      }
      fact.comments.nodes.push(...page.comments.nodes);
      fact.comments.pageInfo = page.comments.pageInfo;
      cursor = page.comments.pageInfo.endCursor;
    }
  }

  if (fact.inverseRelations.pageInfo.hasNextPage) {
    let cursor = fact.inverseRelations.pageInfo.endCursor;
    const seenCursors = new Set<string>();
    while (fact.inverseRelations.pageInfo.hasNextPage) {
      if (!cursor || seenCursors.has(cursor)) throw new Error("linear_tree_batch_incomplete");
      seenCursors.add(cursor);
      const response = await rawRequest<IssueTreeNestedPageData, {
        issueId: string;
        cursor: string;
      }>(WORKFLOW_ISSUE_TREE_RELATIONS_PAGE_QUERY, { issueId: fact.id, cursor });
      const page = response.data?.issue;
      if (!page || page.id !== fact.id || !page.inverseRelations) {
        throw new Error("linear_tree_batch_incomplete");
      }
      fact.inverseRelations.nodes.push(...page.inverseRelations.nodes);
      fact.inverseRelations.pageInfo = page.inverseRelations.pageInfo;
      cursor = page.inverseRelations.pageInfo.endCursor;
    }
  }

  if (fact.attachments.pageInfo.hasNextPage) {
    let cursor = fact.attachments.pageInfo.endCursor;
    const seenCursors = new Set<string>();
    while (fact.attachments.pageInfo.hasNextPage) {
      if (!cursor || seenCursors.has(cursor)) throw new Error("linear_tree_batch_incomplete");
      seenCursors.add(cursor);
      const response = await rawRequest<IssueTreeNestedPageData, { issueId: string; cursor: string }>(
        WORKFLOW_ISSUE_TREE_ATTACHMENTS_PAGE_QUERY,
        { issueId: fact.id, cursor },
      );
      const page = response.data?.issue;
      if (!page || page.id !== fact.id || !page.attachments) {
        throw new Error("linear_tree_batch_incomplete");
      }
      if (page.attachments.nodes.some((attachment) => attachment.issue.id !== fact.id)) {
        throw new Error("linear_tree_batch_invalid");
      }
      fact.attachments.nodes.push(...page.attachments.nodes);
      fact.attachments.pageInfo = page.attachments.pageInfo;
      cursor = page.attachments.pageInfo.endCursor;
    }
  }

  if (fact.history.pageInfo.hasNextPage) {
    let cursor = fact.history.pageInfo.endCursor;
    const seenCursors = new Set<string>();
    while (fact.history.pageInfo.hasNextPage) {
      if (!cursor || seenCursors.has(cursor)) throw new Error("linear_tree_batch_incomplete");
      seenCursors.add(cursor);
      const response = await rawRequest<IssueTreeNestedPageData, { issueId: string; cursor: string }>(
        WORKFLOW_ISSUE_TREE_ACTIVITIES_PAGE_QUERY,
        { issueId: fact.id, cursor },
      );
      const page = response.data?.issue;
      if (!page || page.id !== fact.id || !page.history) {
        throw new Error("linear_tree_batch_incomplete");
      }
      if (page.history.nodes.some((activity) => activity.issue.id !== fact.id)) {
        throw new Error("linear_tree_batch_invalid");
      }
      fact.history.nodes.push(...page.history.nodes);
      fact.history.pageInfo = page.history.pageInfo;
      cursor = page.history.pageInfo.endCursor;
    }
  }
}

function treeFactValue(fact: IssueTreeFact, depth: number): LinearIssueValue {
  return {
    issueId: fact.id,
    identifier: fact.identifier,
    ...(fact.project ? { projectId: fact.project.id } : {}),
    ...(fact.parent ? { parentIssueId: fact.parent.id } : {}),
    ...(fact.creator ? { creatorUserId: workflowIssueUserId(fact.creator.id) } : {}),
    ...(fact.assignee ? { assigneeUserId: workflowIssueUserId(fact.assignee.id) } : {}),
    state: linearIssueState(fact.state.name),
    order: fact.subIssueSortOrder ?? fact.sortOrder,
    depth,
    title: fact.title,
    description: fact.description ?? "",
    labels: issueLabels(fact.labels),
    isArchived: fact.archivedAt !== null && fact.archivedAt !== undefined,
    createdAt: timestampValue(fact.createdAt),
    updatedAt: timestampValue(fact.updatedAt),
  };
}

function workflowIssueUserId(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error("linear_workflow_issue_actor_invalid");
  return value;
}

function issueLabels(value: IssueTreeFact["labels"] | undefined): string[] {
  if (
    !value ||
    !Array.isArray(value.nodes) ||
    !value.pageInfo ||
    typeof value.pageInfo.hasNextPage !== "boolean" ||
    value.pageInfo.hasNextPage ||
    value.nodes.length > 64 ||
    value.nodes.some((label) => !label || !shortText(label.name))
  ) {
    throw new Error("linear_tree_labels_incomplete");
  }
  const labels = value.nodes.map(({ name }) => name);
  if (new Set(labels).size !== labels.length) {
    throw new Error("linear_tree_labels_ambiguous");
  }
  return labels;
}

function shortText(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
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

function linearIssueState(value: string): LinearIssueState {
  if (isTargetWorkflowStatusName(value)) return value;
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

function conductorPoolFromLabels(labels: readonly string[]): ConductorPoolValue[] {
  const pool: ConductorPoolValue[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    if (!label.startsWith(CONDUCTOR_LABEL_PREFIX)) continue;
    const conductorShortHash = label.slice(CONDUCTOR_LABEL_PREFIX.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conductorShortHash)) {
      throw new Error("linear_conductor_label_invalid");
    }
    if (seen.has(conductorShortHash)) {
      throw new Error("linear_conductor_label_duplicate");
    }
    seen.add(conductorShortHash);
    pool.push({ conductorShortHash });
    if (pool.length > 64) throw new Error("linear_conductor_pool_too_large");
  }
  return pool;
}

function normalizePoolMembers(values: readonly string[], allowEmpty = false): string[] | undefined {
  if ((values.length === 0 && !allowEmpty) || values.length > 64) return undefined;
  const result = [...values];
  if (result.some((value) => !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value))) return undefined;
  if (new Set(result).size !== result.length) return undefined;
  return result;
}

function projectPoolFingerprint(input: {
  projectId: string;
  expectedProjectUpdatedAt: string;
  currentMembers: readonly string[];
  desiredMembers: readonly string[];
  addMembers: readonly string[];
  removeMembers: readonly string[];
  routeRoots: readonly { rootIssueId: string; conductorShortHash: string }[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      projectId: input.projectId,
      expectedProjectUpdatedAt: input.expectedProjectUpdatedAt,
      currentMembers: [...input.currentMembers].sort(),
      desiredMembers: [...input.desiredMembers].sort(),
      addMembers: [...input.addMembers].sort(),
      removeMembers: [...input.removeMembers].sort(),
      routeRoots: [...input.routeRoots].sort((left, right) => left.rootIssueId.localeCompare(right.rootIssueId)),
    }))
    .digest("hex");
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    [...left].sort().every((member, index) => member === [...right].sort()[index]);
}

function workflowStatusCategory(value: string):
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled" {
  if (
    value === "backlog" ||
    value === "unstarted" ||
    value === "started" ||
    value === "completed" ||
    value === "canceled"
  ) return value;
  if (value === "duplicate") return "canceled";
  throw new Error("linear_workflow_status_category_invalid");
}

function workflowStateColor(category: "backlog" | "unstarted" | "started" | "completed" | "canceled") {
  switch (category) {
    case "backlog": return "#95A2B3";
    case "unstarted": return "#E2E2E2";
    case "started": return "#F2C94C";
    case "completed": return "#5E6AD2";
    case "canceled": return "#EB5757";
  }
}

function linearWorkflowStateValue(value: {
  statusId: string;
  name: string;
  category: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  position?: number;
}): LinearWorkflowStateValue {
  if (value.position === undefined) {
    throw new Error("linear_workflow_status_catalog_invalid");
  }
  return { ...value, position: value.position };
}

function linearWorkflowStateValueFromRaw(value: {
  id: string;
  name: string;
  type: string;
  position: number;
}): LinearWorkflowStateValue {
  return {
    statusId: value.id,
    name: value.name,
    category: value.type === "duplicate"
      ? "duplicate"
      : workflowStatusCategory(value.type),
    position: value.position,
  };
}

function assertTargetWorkflowPreconditions(
  currentStates: Array<{ id: string; name: string; type: string; position: number }>,
  initialStates: Array<{ id: string; name: string; type: string; position: number }>,
  operations: readonly TargetWorkflowInitializationOperation[],
): void {
  const expectedTypes = new Map<string, string>();
  const expectedIds = new Map<string, string>();
  const expectedNameIds = new Map<string, string>();
  for (const state of initialStates) {
    expectedTypes.set(state.name, state.type);
    expectedIds.set(state.id, state.name);
    expectedNameIds.set(state.name, state.id);
    if (state.name === "Backlog") {
      expectedTypes.set("Draft", state.type);
      expectedNameIds.set("Draft", state.id);
    }
  }
  for (const operation of operations) {
    if (operation.kind === "create") expectedTypes.set(operation.name, operation.category);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const state of currentStates) {
    const expectedType = expectedTypes.get(state.name);
    const expectedName = expectedIds.get(state.id);
    if (
      ids.has(state.id) ||
      names.has(state.name) ||
      expectedType === undefined ||
      expectedType !== state.type ||
      (expectedName !== undefined &&
        state.name !== expectedName &&
        !(expectedName === "Backlog" && state.name === "Draft"))
    ) {
      throw new Error("linear_workflow_setup_precondition_conflict");
    }
    const expectedId = expectedNameIds.get(state.name);
    if (expectedId !== undefined && expectedId !== state.id) {
      throw new Error("linear_workflow_setup_precondition_conflict");
    }
    ids.add(state.id);
    names.add(state.name);
  }
  for (const state of initialStates) {
    const current = currentStates.find(({ id }) => id === state.id);
    if (
      !current ||
      current.type !== state.type ||
      (current.name !== state.name &&
        !(state.name === "Backlog" && current.name === "Draft"))
    ) {
      throw new Error("linear_workflow_setup_precondition_conflict");
    }
  }
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

function pageInfo(value: {
  hasNextPage: boolean;
  endCursor?: string | null;
}): PageInfo {
  return {
    hasNextPage: value.hasNextPage,
    ...(value.endCursor ? { endCursor: value.endCursor } : {}),
  };
}

function timestampValue(value: string | Date): string {
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
