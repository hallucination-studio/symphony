import {
  LinearClient,
  type Comment,
  type Issue,
  type IssueLabel,
  type ProjectLabel,
} from "@linear/sdk";
import { createHash, randomUUID } from "node:crypto";

import type {
  ConductorProjectLabelRebindPlan,
  ConductorProjectLabelRebindResult,
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
  RootIssueValue,
  WorkflowCommentValue,
  WorkflowCommentAuthorKind,
  WorkflowRelationValue,
} from "../types.js";
import { planProjectConductorPoolMutation } from "../../conductor-bindings/ProjectConductorPoolPolicy.js";
import {
  inspectTargetWorkflowCatalog,
  isTargetWorkflowStatusName,
  planTargetWorkflowInitialization,
  type TargetWorkflowInitializationOperation,
} from "../../../public/TargetWorkflowCatalog.js";

const PAGE_LIMIT = 250;
const MAX_TREE_NODES = 512;
const MAX_ROOT_COMMENTS = 4_096;
const ROOT_READ_CONCURRENCY = 8;
const CONDUCTOR_LABEL_PREFIX = "symphony:conductor/";
const ROOT_HEADER_MARKER = "<!-- symphony root\n";
const MAX_ROOT_TITLE_LENGTH = 256;
const MAX_ROOT_DESCRIPTION_LENGTH = 16_384;

type WorkflowScopeIssue = {
  id: string;
  project?: { id?: string } | null;
  parent?: WorkflowScopeIssue | null;
};

type WorkflowVersionScopeIssue = {
  id: string;
  updatedAt?: string;
  project?: { id?: string } | null;
  parent?: WorkflowVersionScopeIssue | null;
};

type WorkflowPreflightIssue = WorkflowScopeIssue & {
  updatedAt?: string;
  archivedAt?: string | null;
  title?: string;
  description?: string | null;
  state?: { id?: string } | null;
  team?: {
    id?: string;
    states?: { nodes?: Array<{ id?: string }>; pageInfo?: { hasNextPage?: boolean } };
  } | null;
  comments?: { nodes?: Array<{ id?: string; body?: string; updatedAt?: string; issue?: { id?: string } }>; pageInfo?: { hasNextPage?: boolean } };
  children?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } };
  inverseRelations?: {
    nodes?: Array<{ type?: string; issue?: { id?: string; updatedAt?: string; project?: { id?: string } }; relatedIssue?: { id?: string; project?: { id?: string } } }>;
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

const ROOT_HEADER_FACTS_QUERY = `
  query SymphonyRootHeaderFacts($rootIds: [ID!]!, $commentMarker: String!, $workflowCommentMarker: String!) {
    viewer { id }
    issues(first: 250, filter: { id: { in: $rootIds } }) {
      nodes {
        id identifier title description priority sortOrder updatedAt archivedAt
        project { id }
        parent { id }
        delegate { id }
        state { name }
        labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
        comments(first: 2, filter: { body: { contains: $commentMarker } }) {
          nodes { id body createdAt updatedAt user { id } botActor { id } externalUser { id } issue { id } }
          pageInfo { hasNextPage }
        }
        workflowManagedComments: comments(first: 25, filter: { body: { contains: $workflowCommentMarker } }) {
          nodes { id body createdAt updatedAt user { id } botActor { id } externalUser { id } issue { id } }
          pageInfo { hasNextPage }
        }
        inverseRelations(first: 25) {
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
const WORKFLOW_ISSUE_TREE_ROOT_QUERY = `
  query SymphonyIssueTreeRoot($rootIssueId: String!) {
    issue(id: $rootIssueId) {
      id identifier title description sortOrder updatedAt archivedAt
      project { id }
      parent { id }
      state { name }
      labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
      comments(first: 8) {
        nodes { id body createdAt updatedAt user { id } botActor { id } externalUser { id } issue { id } }
        pageInfo { hasNextPage endCursor }
      }
      inverseRelations(first: 8) {
        nodes { id type issue { id state { name } project { id } } relatedIssue { id project { id } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const WORKFLOW_ISSUE_TREE_CHILDREN_QUERY = `
  query SymphonyIssueTreeChildren($parentIds: [ID!]!, $cursor: String) {
    issues(first: 25, after: $cursor, filter: { parent: { id: { in: $parentIds } } }) {
      nodes {
        id identifier title description sortOrder subIssueSortOrder updatedAt archivedAt
        project { id }
        parent { id }
        state { name }
        labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
        comments(first: 8) {
          nodes { id body createdAt updatedAt user { id } botActor { id } externalUser { id } issue { id } }
          pageInfo { hasNextPage endCursor }
        }
        inverseRelations(first: 8) {
          nodes { id type issue { id state { name } project { id } } relatedIssue { id project { id } } }
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
        nodes { id body createdAt updatedAt user { id } botActor { id } externalUser { id } issue { id } }
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
const ROOT_MARKER_START = "<!-- symphony root\n";
const WORKFLOW_ISSUE_MARKER =
  /\n*<!-- symphony workflow issue\nmanaged_marker: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\nissue_kind: (cycle|plan|work|verify|human)\n-->\s*$/;
const WORKFLOW_WRITE_MARKER =
  /\n*<!-- symphony workflow write\nwrite_id: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\n-->\s*$/;
const MANAGED_RECORD_MARKER = "<!-- symphony managed-record\n";
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
}

export interface LinearRequestObservationOptions {
  correlationId(): string;
  now(): number;
  observe?(observation: LinearPhysicalRequestObservation): void;
}

interface RootHeaderFactsData {
  viewer: { id: string };
  issues: {
    nodes: RootHeaderFact[];
    pageInfo: { hasNextPage: boolean };
  };
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
}

interface IssueTreeRelation {
  id?: string | null;
  type: string;
  issue?: { id: string; state: { name: string }; project?: { id: string } | null } | null;
  relatedIssue?: { id: string; project?: { id: string } | null } | null;
}

interface RootHeaderFact {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  archivedAt?: string | null;
  priority: number;
  sortOrder: number;
  updatedAt: string;
  project?: { id: string } | null;
  parent?: { id: string } | null;
  delegate?: { id: string } | null;
  state: { name: string };
  labels: {
    nodes: Array<{ name: string }>;
    pageInfo: { hasNextPage: boolean };
  };
  comments: {
    nodes: Array<{
      id: string;
      body: string;
      createdAt: string;
      updatedAt: string;
      user?: { id: string } | null;
      botActor?: { id: string } | null;
      externalUser?: { id: string } | null;
      issue: { id: string };
    }>;
    pageInfo: { hasNextPage: boolean };
  };
  workflowManagedComments?: {
    nodes: Array<{
      id: string;
      body: string;
      createdAt: string;
      updatedAt: string;
      user?: { id: string } | null;
      botActor?: { id: string } | null;
      externalUser?: { id: string } | null;
      issue: { id: string };
    }>;
    pageInfo: { hasNextPage: boolean };
  };
  inverseRelations: {
    nodes: Array<{
      id?: string | null;
      type: string;
      issue?: { id: string; state: { name: string }; project?: { id: string } | null } | null;
      relatedIssue?: { id: string; project?: { id: string } | null } | null;
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
  archivedAt?: string | null;
  project?: { id: string } | null;
  parent?: { id: string } | null;
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
  } | null;
}
interface IssueTreeChildrenData {
  issues: {
    nodes: IssueTreeFact[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
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

  async assignConductorProjectLabel(input: {
    projectId: string;
    labelName: string;
  }): Promise<void> {
    const plan = await this.preflightConductorProjectLabel(input);
    if (plan.kind !== "ready") throw new Error(`linear_${plan.reason}`);
    await this.rebindConductorProjectLabel({ plan, authorized: true });
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

  async createRootIssue(input: {
    projectId: string;
    conductorShortHash: string;
    title: string;
    description: string;
  }) {
    const plan = await this.#preflightRootCreation(input);
    const fresh = await this.#preflightRootCreation(input);
    if (fresh.fingerprint !== plan.fingerprint) {
      throw new Error("linear_root_creation_precondition_conflict");
    }
    const payload = await this.#client.createIssue({
      teamId: plan.teamId,
      projectId: plan.projectId,
      labelIds: [plan.issueLabelId],
      title: input.title,
      description: input.description,
    });
    if (!payload.success || !payload.issueId) {
      throw new Error("linear_root_issue_create_failed");
    }
    const issue = await this.#client.issue(payload.issueId);
    const labels = await allNodes(issue.labels({ first: PAGE_LIMIT }), 64);
    const routeLabels = labels.filter(({ name }) => name.startsWith(CONDUCTOR_LABEL_PREFIX));
    if (
      issue.id !== payload.issueId ||
      issue.projectId !== plan.projectId ||
      issue.parentId !== undefined && issue.parentId !== null ||
      issue.title !== input.title ||
      issue.description !== input.description ||
      routeLabels.length !== 1 ||
      routeLabels[0]?.id !== plan.issueLabelId ||
      routeLabels[0]?.name !== plan.issueLabelName
    ) {
      throw ambiguousError("linear_root_issue_read_back_failed");
    }
    if (!SAFE_ID.test(issue.identifier)) {
      throw new Error("linear_root_identifier_invalid");
    }
    return {
      rootIssueId: issue.id,
      identifier: issue.identifier,
      projectId: issue.projectId,
    };
  }

  async #preflightRootCreation(input: {
    projectId: string;
    conductorShortHash: string;
    title: string;
    description: string;
  }) {
    if (
      !SAFE_ID.test(input.projectId) ||
      !/^[a-f0-9]{12}$/u.test(input.conductorShortHash) ||
      !boundedRootText(input.title, MAX_ROOT_TITLE_LENGTH) ||
      !boundedRootText(input.description, MAX_ROOT_DESCRIPTION_LENGTH)
    ) {
      throw new Error("linear_root_creation_input_invalid");
    }
    const organization = await this.#client.organization;
    if (organization.id !== this.organizationId) {
      throw new Error("linear_root_creation_organization_mismatch");
    }
    const project = await this.#client.project(input.projectId);
    if (!project || project.id !== input.projectId || !(project.updatedAt instanceof Date)) {
      throw new Error("linear_root_creation_project_invalid");
    }
    const projectLabels = await allNodes(project.labels({ first: PAGE_LIMIT }), 64);
    const pool = conductorPoolFromLabels(projectLabels
      .filter(({ isGroup, archivedAt, retiredById }) => !isGroup && !archivedAt && !retiredById)
      .map(({ name }) => name));
    if (!pool.some(({ conductorShortHash }) => conductorShortHash === input.conductorShortHash)) {
      throw new Error("linear_root_creation_conductor_not_in_pool");
    }
    const teams = await allNodes(project.teams({ first: 64 }), 64);
    if (teams.length !== 1 || !SAFE_ID.test(teams[0]!.id)) {
      throw new Error("linear_root_creation_team_ambiguous");
    }
    const labelName = `${CONDUCTOR_LABEL_PREFIX}${input.conductorShortHash}`;
    const labels = await allNodes(this.#client.issueLabels({
      first: 3,
      includeArchived: false,
      filter: { name: { eq: labelName }, isGroup: { eq: false } },
    }), 3);
    const matches = labels.filter(({ id, name, isGroup, archivedAt, retiredById, teamId }) =>
      SAFE_ID.test(id) && name === labelName && !isGroup && !archivedAt && !retiredById &&
      (teamId === undefined || teamId === teams[0]!.id));
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? "linear_root_creation_issue_label_missing"
        : "linear_root_creation_issue_label_ambiguous");
    }
    const labelOrganization = await matches[0]!.organization;
    if (labelOrganization.id !== this.organizationId) {
      throw new Error("linear_root_creation_label_organization_mismatch");
    }
    const plan = {
      projectId: input.projectId,
      expectedProjectUpdatedAt: project.updatedAt.toISOString(),
      teamId: teams[0]!.id,
      issueLabelId: matches[0]!.id,
      issueLabelName: labelName,
      conductorShortHash: input.conductorShortHash,
      fingerprint: "",
    };
    return {
      ...plan,
      fingerprint: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    };
  }

  async preflightConductorProjectLabel(input: {
    projectId: string;
    labelName: string;
  }): Promise<ConductorProjectLabelRebindPlan> {
    if (!SAFE_ID.test(input.projectId)) {
      return { kind: "blocked", ...input, reason: "project_invalid" };
    }
    if (
      !input.labelName.startsWith(CONDUCTOR_LABEL_PREFIX) ||
      !SAFE_ID.test(input.labelName.slice(CONDUCTOR_LABEL_PREFIX.length))
    ) {
      return { kind: "blocked", ...input, reason: "label_invalid" };
    }
    const organization = await this.#client.organization;
    if (organization.id !== this.organizationId) {
      return { kind: "blocked", ...input, reason: "project_invalid" };
    }
    const project = await this.#client.project(input.projectId);
    if (!project || project.id !== input.projectId) {
      return { kind: "blocked", ...input, reason: "project_invalid" };
    }
    const currentLabels = await allNodes(project.labels({ first: PAGE_LIMIT }), 64);
    const conductorLabels = currentLabels.filter(({ name, isGroup, archivedAt, retiredById }) =>
      typeof name === "string" &&
      name.startsWith(CONDUCTOR_LABEL_PREFIX) &&
      !isGroup &&
      !archivedAt &&
      !retiredById,
    );
    if (conductorLabels.some(({ id, name }) => !SAFE_ID.test(id) || !SAFE_ID.test(name))) {
      return { kind: "blocked", ...input, reason: "project_labels_invalid" };
    }
    const desiredLabels = await this.#projectLabelsNamed(input.labelName);
    if (desiredLabels.length > 1) {
      return { kind: "blocked", ...input, reason: "label_ambiguous" };
    }
    const desiredLabel = desiredLabels[0];
    const assignedProjects = desiredLabel
      ? await allNodes(desiredLabel.projects({ first: PAGE_LIMIT }), 64)
      : [];
    if (assignedProjects.some(({ id }) => !SAFE_ID.test(id))) {
      return { kind: "blocked", ...input, reason: "label_ownership_invalid" };
    }
    const detachAssignments = [
      ...conductorLabels
        .filter(({ id }) => id !== desiredLabel?.id)
        .map(({ id }) => ({ projectId: input.projectId, labelId: id })),
      ...(desiredLabel
        ? assignedProjects
            .filter(({ id }) => id !== input.projectId)
            .map(({ id }) => ({ projectId: id, labelId: desiredLabel.id }))
        : []),
    ];
    const plan = {
      kind: "ready" as const,
      projectId: input.projectId,
      labelName: input.labelName,
      fingerprint: "",
      currentConductorLabels: conductorLabels.map(({ id, name }) => ({
        labelId: id,
        name,
      })),
      ...(desiredLabel
        ? {
            desiredLabel: {
              labelId: desiredLabel.id,
              name: desiredLabel.name,
              assignedProjectIds: assignedProjects.map(({ id }) => id),
            },
          }
        : {}),
      detachAssignments,
    } satisfies Extract<ConductorProjectLabelRebindPlan, { kind: "ready" }>;
    return { ...plan, fingerprint: projectLabelRebindFingerprint(plan) };
  }

  async rebindConductorProjectLabel(input: {
    plan: Extract<ConductorProjectLabelRebindPlan, { kind: "ready" }>;
    authorized: boolean;
  }): Promise<ConductorProjectLabelRebindResult> {
    this.#projectResolutionCache.clear();
    const plan = input.plan;
    if (plan.fingerprint !== projectLabelRebindFingerprint(plan)) {
      throw new Error("linear_project_label_plan_invalid");
    }
    if (input.authorized !== true) return { kind: "dry_run", plan };
    const freshPlan = await this.preflightConductorProjectLabel(plan);
    if (freshPlan.kind !== "ready" || freshPlan.fingerprint !== plan.fingerprint) {
      throw new Error("linear_project_label_precondition_conflict");
    }
    let desiredLabelId = plan.desiredLabel?.labelId;
    let targetAlreadyAttached = freshPlan.desiredLabel?.assignedProjectIds.includes(plan.projectId) === true;
    let mutationError: unknown;
    try {
      if (!desiredLabelId) {
        const label = await this.#createProjectLabelWithReadBack(plan.labelName);
        desiredLabelId = label.id;
      }
      for (const assignment of plan.detachAssignments) {
        await this.#client.projectRemoveLabel(assignment.projectId, assignment.labelId);
      }
      // The compact final preflight is the single semantic read-back for the
      // complete detach/create/attach delta.
      if (!targetAlreadyAttached) {
        await this.#client.projectAddLabel(plan.projectId, desiredLabelId);
        targetAlreadyAttached = true;
      }
    } catch (error) {
      mutationError = error;
    }
    const finalPlan = await this.preflightConductorProjectLabel(plan).catch(() => undefined);
    if (
      finalPlan?.kind !== "ready" ||
      finalPlan.currentConductorLabels.length !== 1 ||
      finalPlan.currentConductorLabels[0]!.labelId !== desiredLabelId ||
      finalPlan.desiredLabel?.assignedProjectIds.length !== 1 ||
      finalPlan.desiredLabel.assignedProjectIds[0] !== plan.projectId
    ) {
      if (mutationError) throw mutationError;
      throw ambiguousError("linear_project_label_read_back_failed");
    }
    return {
      kind: plan.detachAssignments.length === 0 && plan.desiredLabel?.labelId === desiredLabelId
        ? "already_applied"
        : "applied",
      projectId: plan.projectId,
      labelName: plan.labelName,
      fingerprint: finalPlan.fingerprint,
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
    const organization = await this.#client.organization;
    if (organization.id !== this.organizationId) {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "project_invalid" as const };
    }
    const project = await this.#client.project(input.projectId);
    if (!project || project.id !== input.projectId || !(project.updatedAt instanceof Date)) {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "project_invalid" as const };
    }
    const projectLabels = await allNodes(project.labels({ first: PAGE_LIMIT }), 64);
    const conductorLabels = projectLabels.filter(({ name, isGroup, archivedAt, retiredById }) =>
      typeof name === "string" && name.startsWith(CONDUCTOR_LABEL_PREFIX) &&
      !isGroup && !archivedAt && !retiredById,
    );
    const currentMembers = normalizePoolMembers(
      conductorLabels.map(({ name }) => name.slice(CONDUCTOR_LABEL_PREFIX.length)),
    );
    if (!currentMembers) {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "project_roots_invalid" as const };
    }
    for (const member of desiredMembers) {
      const matches = await this.#projectLabelsNamed(`${CONDUCTOR_LABEL_PREFIX}${member}`);
      if (matches.length > 1) {
        return { kind: "blocked" as const, projectId: input.projectId, reason: "member_label_ambiguous" as const };
      }
      if (matches[0]) {
        const assignedProjects = await allNodes(matches[0].projects({ first: PAGE_LIMIT }), 64);
        if (assignedProjects.some(({ id }) => id !== input.projectId)) {
          return { kind: "blocked" as const, projectId: input.projectId, reason: "member_label_owned_by_other_project" as const };
        }
      }
    }
    let roots: RootIssueValue[];
    try {
      roots = await this.#allRootIssuesForPool(input.projectId);
    } catch {
      return { kind: "blocked" as const, projectId: input.projectId, reason: "project_roots_invalid" as const };
    }
    let policy;
    try {
      policy = planProjectConductorPoolMutation({
        project: { projectId: input.projectId, updatedAt: project.updatedAt.toISOString() },
        currentMembers,
        desiredMembers,
        roots: roots.map((root) => {
          const ownershipConductorId = rootOwnershipConductorId(root.rootManagedComments);
          const base = {
            issueId: root.issue.issueId,
            state: root.issue.state ?? "Draft",
            labels: root.rootConductorLabels.map(({ conductorShortHash }) => conductorShortHash),
          };
          return ownershipConductorId === undefined
            ? base
            : { ...base, ownershipConductorId };
        }),
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
    } catch (error) {
      mutationError = error;
    }
    const finalPlan = await this.preflightConductorProjectPool({
      projectId: plan.projectId,
      desiredMembers: plan.desiredMembers,
    }).catch(() => undefined);
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

  async #allRootIssuesForPool(projectId: string): Promise<RootIssueValue[]> {
    const roots: RootIssueValue[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listRootIssues({ projectId, ...(cursor ? { cursor } : {}), limit: PAGE_LIMIT });
      roots.push(...page.items);
      if (roots.length > 512) throw new Error("linear_root_collection_too_large");
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
      if (page.pageInfo.hasNextPage && !cursor) throw new Error("linear_pagination_cursor_missing");
    } while (cursor);
    return roots;
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
    if (input.authorized !== true) {
      return {
        kind: "dry_run" as const,
        projectId: target.projectId,
        teamId: target.teamId,
        currentStatuses: target.states.map(linearWorkflowStateValueFromRaw),
        operations: plan.operations,
        nativeDuplicate: linearWorkflowStateValueFromRaw(
          target.states.find(({ type }) => type === "duplicate")!,
        ),
      };
    }
    if (plan.operations.length === 0) {
      return this.#targetWorkflowResult("already_applied", target);
    }

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
    const finalTarget = await this.#readTargetTeamWorkflow(input.projectId);
    const inspection = inspectTargetWorkflowCatalog(finalTarget.states);
    if (inspection.kind !== "complete") {
      throw ambiguousError("linear_workflow_setup_read_back_failed");
    }
    return {
      kind: "applied" as const,
      projectId: finalTarget.projectId,
      teamId: finalTarget.teamId,
      canonicalStatuses: inspection.canonicalStatuses.map(linearWorkflowStateValue),
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

  #targetWorkflowResult(
    kind: "already_applied",
    target: {
      projectId: string;
      teamId: string;
      states: Array<{ id: string; name: string; type: string; position: number }>;
    },
  ) {
    const inspection = inspectTargetWorkflowCatalog(target.states);
    if (inspection.kind !== "complete") {
      throw ambiguousError("linear_workflow_setup_read_back_failed");
    }
    return {
      kind,
      projectId: target.projectId,
      teamId: target.teamId,
      canonicalStatuses: inspection.canonicalStatuses.map(linearWorkflowStateValue),
      nativeDuplicate: linearWorkflowStateValue(inspection.nativeDuplicate),
    };
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
    const conductorPool = conductorPoolFromLabels(projectLabels.map(({ name }) => name));
    if (!conductorPool.some(({ conductorShortHash }) => conductorShortHash === input.conductorShortHash)) {
      return { kind: "conflict" };
    }
    return {
      kind: "resolved",
      projectId: project.id,
      updatedAt: project.updatedAt.toISOString(),
      conductorPool,
    };
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
        const [value, blockers, rootManagedComments, labels] = await Promise.all([
          issueValue(issue, 0),
          blockerValues(issue),
          this.#rootManagedCommentValues(issue),
          allNodes(issue.labels({ first: 64 }), 64),
        ]);
        return {
          issue: { ...value, labels: labels.map(({ name }) => name) },
          isDelegatedToSymphony: issue.delegateId === delegateActorId,
          priority,
          blockers,
          rootConductorLabels: conductorPoolFromLabels(labels.map(({ name }) => name)),
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
      workflowCommentMarker: string;
    }>(ROOT_HEADER_FACTS_QUERY, {
      rootIds: roots.map(({ issue }) => issue.id),
      commentMarker: ROOT_HEADER_MARKER,
      workflowCommentMarker: MANAGED_RECORD_MARKER,
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
      if (fact.comments.pageInfo.hasNextPage || fact.comments.nodes.length > 2 ||
          fact.workflowManagedComments?.pageInfo.hasNextPage) {
        throw new Error("linear_root_comments_too_many");
      }
      if (fact.inverseRelations.pageInfo.hasNextPage) {
        throw new Error("linear_root_relations_too_many");
      }
      if (fact.labels.pageInfo.hasNextPage) {
        throw new Error("linear_root_labels_too_many");
      }
      const rootManagedComments = [
        ...fact.comments.nodes,
        ...(fact.workflowManagedComments?.nodes ?? []),
      ].flatMap((comment) => {
        if (comment.issue.id !== fact.id) {
          throw new Error("linear_root_comment_identity_mismatch");
        }
        if (!isRootManagedComment(comment.body) && !isRootOwnershipComment(comment.body)) return [];
        return [rootManagedCommentValue(comment, fact.id, delegateActorId, isRootManagedComment(comment.body)
          ? rootCommentMarker(fact.id)
          : `${fact.id}:managed-record:${comment.id}`)];
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
          labels: fact.labels.nodes.map(({ name }) => name),
          isArchived: fact.archivedAt !== null && fact.archivedAt !== undefined,
          updatedAt: timestampValue(fact.updatedAt),
        },
        isDelegatedToSymphony: fact.delegate?.id === delegateActorId,
        priority: linearPriority(fact.priority),
        blockers,
        rootConductorLabels: conductorPoolFromLabels(fact.labels.nodes.map(({ name }) => name)),
        rootManagedComments,
      };
    });
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
      commentMarker?: string;
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
    const comments = [...facts.values()].flatMap(({ fact }) =>
      fact.comments.nodes.map((comment) => workflowCommentValue(comment, fact.id, delegateActorId)),
    );
    if (comments.length > MAX_ROOT_COMMENTS) {
      throw new Error("linear_workflow_comments_too_many");
    }
    const relations = workflowRelationValues(facts, projectId);
    if (relations.length > 1_024) {
      throw new Error("linear_workflow_relations_too_many");
    }
    return {
      nodes,
      rootConductorLabels,
      rootManagedComments,
      humanAnswers,
      comments,
      relations,
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
        ...(issue.managedMarker ? { managedMarker: issue.managedMarker } : {}),
        ...(issue.issueId === input.rootIssueId
          ? { issueKind: "root" as const }
          : issue.workflowKind
            ? { issueKind: issue.workflowKind }
          : issue.nodeKind === "work"
            ? { issueKind: "work" as const }
            : issue.nodeKind === "human"
              ? { issueKind: "human" as const }
              : {}),
        remoteVersion: issue.updatedAt,
        updatedAt: issue.updatedAt,
      };
    });
    const comments = tree.comments.map((comment) => ({
      commentId: comment.commentId,
      issueId: comment.issueId,
      body: comment.body,
      authorKind: comment.authorKind,
      authorId: comment.authorId,
      ...(comment.authorUserId ? { authorUserId: comment.authorUserId } : {}),
      createdAt: comment.createdAt,
      ...(comment.managedMarker ? { managedMarker: comment.managedMarker } : {}),
      remoteVersion: comment.updatedAt,
      updatedAt: comment.updatedAt,
    }));
    return {
      rootIssueId: input.rootIssueId,
      statusCatalog,
      issues,
      comments,
      relations: tree.relations,
      observedAt: tree.observedAt,
    };
  }

  async readWorkflowMutationTarget(issueId: string) {
    const issue = await this.#client.issue(issueId);
    return workflowMutationTargetValue(issue);
  }

  async preflightWorkflowMutation(
    command: import("../types.js").WorkflowMutationCommand,
  ): Promise<
    | { kind: "ready" }
    | { kind: "already_applied"; readBack: import("../types.js").WorkflowMutationReadBack }
    | { kind: "precondition_conflict" }
  > {
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
      issues(filter: { id: { in: [${issueIds.map(quoteGraphql).join(", ")}] } }) {
        nodes {
          ${workflowScopeSelection(32)}
          updatedAt archivedAt title description state { id }
          team { id states(first: 64) { nodes { id } pageInfo { hasNextPage } } }
          comments(first: 64) { nodes { id body updatedAt issue { id } } pageInfo { hasNextPage } }
          children(first: 64) { nodes { id updatedAt archivedAt project { id } parent { id } state { id } title description } pageInfo { hasNextPage } }
          inverseRelations(first: 64) { nodes { type issue { id updatedAt project { id } } relatedIssue { id project { id } } } pageInfo { hasNextPage } }
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
    command: import("../types.js").WorkflowMutationCommand,
  ): Promise<void> {
    const preflight = this.#workflowPreflights.get(command.writeId);
    this.#workflowPreflights.delete(command.writeId);
    if (!preflight) await this.#assertWorkflowMutationScope(command);
    switch (command.kind) {
      case "create_workflow_issue": {
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
          description: serializeWorkflowIssueDescription(
            command.description,
            command.managedMarker,
            command.issueKind,
          ),
          stateId: command.statusId,
          ...(command.order === undefined ? {} : { subIssueSortOrder: command.order }),
        });
        if (!payload.success || !payload.issueId) {
          throw new Error("linear_workflow_issue_create_failed");
        }
        return;
      }
      case "update_workflow_issue": {
        const fact = preflight?.get(command.target.targetIssueId);
        const issue = fact ? undefined : await this.#client.issue(command.target.targetIssueId);
        if ((fact?.project?.id ?? issue?.projectId) !== command.expectedProjectId) throw new Error("linear_workflow_target_project_invalid");
        const current = fact ? workflowPreflightTargetValue(fact) : await workflowMutationTargetValue(issue!);
        if (command.target.expectedManagedMarker !== undefined &&
          current.managedMarker !== command.target.expectedManagedMarker) {
          throw preconditionConflictError();
        }
        if (issue) await this.#workflowStatusId(issue, command.statusId);
        await this.#client.updateIssue(command.target.targetIssueId, {
          title: command.title,
          description: serializeWorkflowIssueDescription(
            command.description,
            current.managedMarker,
            workflowIssueKindForUpdate(current),
          ),
          stateId: command.statusId,
        });
        return;
      }
      case "append_workflow_comment": {
        await this.#client.createComment({
          issueId: command.target.targetIssueId,
          body: serializeWorkflowComment(command.body, command.writeId),
        });
        return;
      }
      case "archive_workflow_issue":
      case "restore_workflow_issue": {
        const issue = await this.#client.issue(command.target.targetIssueId);
        if (issue.projectId !== command.expectedProjectId) {
          throw new Error("linear_workflow_target_project_invalid");
        }
        const expectedArchived = command.kind === "archive_workflow_issue";
        const currentArchived = issue.archivedAt !== null && issue.archivedAt !== undefined;
        if (command.target.expectedIsArchived !== undefined &&
            currentArchived !== command.target.expectedIsArchived) {
          throw preconditionConflictError();
        }
        const payload = expectedArchived
          ? await issue.archive()
          : await issue.unarchive();
        if (!payload.success) {
          throw new Error(expectedArchived
            ? "linear_workflow_issue_archive_failed"
            : "linear_workflow_issue_restore_failed");
        }
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
        if (command.relationKind === "triggered_by") {
          throw new Error("linear_workflow_relation_kind_unsupported");
        }
        const issueId = command.relationKind === "blocks" ? command.sourceIssueId : command.targetIssueId;
        const relatedIssueId = command.relationKind === "blocks" ? command.targetIssueId : command.sourceIssueId;
        const payload = await this.#client.createIssueRelation({
          issueId,
          relatedIssueId,
          type: "blocks" as Parameters<LinearClient["createIssueRelation"]>[0]["type"],
        });
        if (!payload.success) throw new Error("linear_workflow_relation_create_failed");
        return;
      }
    }
  }

  async #assertWorkflowMutationScope(
    command: import("../types.js").WorkflowMutationCommand,
  ): Promise<void> {
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
      `query WorkflowMutationScopeBatch { issues(filter: { id: { in: [${ids}] } }) { nodes { ${workflowScopeSelection(32)} } } }`,
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
    command: import("../types.js").WorkflowMutationCommand,
  ): Promise<import("../types.js").WorkflowMutationReadBack | undefined> {
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
      const matches = values.filter((issue) => issue.managedMarker === command.managedMarker);
      if (matches.length > 1) throw new Error("linear_workflow_marker_ambiguous");
      const issue = matches[0];
      if (!issue) return undefined;
      if (issue.projectId !== command.expectedProjectId ||
        issue.parentIssueId !== command.parentIssueId || issue.statusId !== command.statusId ||
        issue.title !== command.title || issue.description !== command.description) {
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
        (command.target.expectedParentIssueId === undefined || issue.parentIssueId === command.target.expectedParentIssueId) &&
        (command.target.expectedManagedMarker === undefined ||
          issue.managedMarker === command.target.expectedManagedMarker)
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
        comment.body === serializeWorkflowComment(command.body, command.writeId),
      );
      if (matches.length > 1) throw new Error("linear_workflow_comment_ambiguous");
      const comment = matches[0];
      return comment && comment.body === serializeWorkflowComment(command.body, command.writeId)
        ? { writeId: command.writeId, targetIssueId: command.target.targetIssueId, remoteVersion: comment.updatedAt.toISOString(),
          issueVersions: [{ issueId: command.target.targetIssueId, remoteVersion: issue.updatedAt.toISOString() }] }
        : undefined;
    }
    if (command.kind === "archive_workflow_issue" || command.kind === "restore_workflow_issue") {
      const compact = await this.#readCompactWorkflowTarget(
        command.target.targetIssueId, command.expectedProjectId, command.rootIssueId,
      );
      const issue = compact ?? await this.#client.issue(command.target.targetIssueId)
        .then((value) => workflowMutationTargetValue(value));
      const desiredArchived = command.kind === "archive_workflow_issue";
      return issue && issue.projectId === command.expectedProjectId &&
        issue.isArchived === desiredArchived &&
        (command.target.expectedParentIssueId === undefined || issue.parentIssueId === command.target.expectedParentIssueId) &&
        (command.target.expectedManagedMarker === undefined ||
          issue.managedMarker === command.target.expectedManagedMarker)
        ? { writeId: command.writeId, targetIssueId: issue.issueId, remoteVersion: issue.updatedAt,
          issueVersions: [{ issueId: issue.issueId, remoteVersion: issue.updatedAt }] }
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
    if (!relation) return undefined;
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
      `query WorkflowMutationChildren { issue(id: ${quoteGraphql(parentIssueId)}) { ${workflowScopeSelection(32)} updatedAt children(first: 64) { nodes { id updatedAt archivedAt project { id } parent { id } state { id } title description } pageInfo { hasNextPage } } } }`,
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
    const response = await rawRequest(`query WorkflowMutationTarget { issue(id: ${quoteGraphql(issueId)}) { ${workflowScopeSelection(32)} updatedAt archivedAt title description state { id } } }`);
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
    const body = serializeWorkflowComment(command.body, command.writeId);
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
    const response = await rawRequest(`query WorkflowMutationRelation { root: issue(id: ${quoteGraphql(command.rootIssueId)}) { id updatedAt project { id } parent { id } } source: issue(id: ${quoteGraphql(sourceIssueId)}) { ${workflowVersionScopeSelection(32)} } issue(id: ${quoteGraphql(targetIssueId)}) { ${workflowVersionScopeSelection(32)} inverseRelations(first: 64) { nodes { type issue { id updatedAt project { id } } relatedIssue { id updatedAt project { id } } } pageInfo { hasNextPage } } } }`);
    const data = (response as {
      data?: {
        root?: { id?: string; updatedAt?: string; project?: { id?: string }; parent?: { id?: string } | null };
        source?: WorkflowVersionScopeIssue;
        issue?: WorkflowVersionScopeIssue & {
          inverseRelations?: {
            nodes?: Array<{
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
      relation.type === "blocks" && relation.issue?.id === sourceIssueId &&
      relation.issue.project?.id === command.expectedProjectId &&
      relation.relatedIssue?.id === targetIssueId &&
      relation.relatedIssue.project?.id === command.expectedProjectId,
    );
    const sourceVersion = latestRemoteVersion(source.updatedAt, matchedRelation?.issue?.updatedAt);
    const targetVersion = latestRemoteVersion(issue.updatedAt, matchedRelation?.relatedIssue?.updatedAt);
    const commandSourceVersion = command.relationKind === "blocked_by" ? targetVersion : sourceVersion;
    const commandTargetVersion = command.relationKind === "blocked_by" ? sourceVersion : targetVersion;
    return {
      available: true,
      value: matchedRelation
        ? commandSourceVersion && commandTargetVersion && root.updatedAt
          ? { writeId: command.writeId, targetIssueId: command.sourceIssueId, remoteVersion: commandSourceVersion,
            issueVersions: [...new Map([
              { issueId: command.sourceIssueId, remoteVersion: commandSourceVersion },
              { issueId: command.targetIssueId, remoteVersion: commandTargetVersion },
              ...workflowAncestryVersions(source, command.expectedProjectId, command.rootIssueId).slice(1),
              ...workflowAncestryVersions(issue, command.expectedProjectId, command.rootIssueId).slice(1),
              { issueId: command.rootIssueId, remoteVersion: root.updatedAt },
            ].map((version) => [version.issueId, version])).values()] }
          : (() => { throw new Error("linear_workflow_relation_version_missing"); })()
        : undefined,
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
      .filter(({ body }) => isRootManagedComment(body) || isRootOwnershipComment(body));
    if (comments.length > 2) {
      throw new Error("linear_root_comments_too_many");
    }
    const delegateActorId = this.#delegateActorId ?? (await this.#client.viewer).id;
    return comments.map((comment) => rootManagedCommentValue(
      comment,
      issue.id,
      delegateActorId,
      isRootManagedComment(comment.body)
        ? rootCommentMarker(issue.id)
        : `${issue.id}:managed-record:${comment.id}`,
    ));
  }

  async #createProjectLabelWithReadBack(labelName: string): Promise<ProjectLabel> {
    try {
      const payload = await this.#client.createProjectLabel({
        name: labelName,
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
    } catch (error) {
      const matches = await this.#projectLabelsNamed(labelName).catch(() => []);
      if (matches.length === 1) return matches[0]!;
      throw error;
    }
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
  const startedAt = observation.now();
  const correlationId = observation.correlationId();
  try {
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
  comment: WorkflowCommentSource,
  issueId: string,
  delegateActorId: string,
): WorkflowCommentValue {
  const commentIssue = comment.issue as { id?: unknown } | undefined;
  if (
    (comment.issueId !== undefined && comment.issueId !== issueId) ||
    (commentIssue !== undefined && commentIssue.id !== issueId)
  ) {
    throw new Error("linear_workflow_comment_identity_mismatch");
  }
  const actor = workflowCommentActor(comment, delegateActorId);
  const managedMarker = commentManagedMarker(comment.body, issueId, comment.id);
  return {
    commentId: comment.id,
    issueId,
    authorKind: actor.kind,
    authorId: actor.id,
    ...(actor.userId ? { authorUserId: actor.userId } : {}),
    body: comment.body,
    createdAt: timestampValue(comment.createdAt),
    ...(managedMarker ? { managedMarker } : {}),
    remoteVersion: timestampValue(comment.updatedAt),
    updatedAt: timestampValue(comment.updatedAt),
  };
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

function rootManagedCommentValue(
  comment: WorkflowCommentSource,
  issueId: string,
  delegateActorId: string,
  managedMarker: string,
) {
  const value = workflowCommentValue(comment, issueId, delegateActorId);
  return {
    commentId: value.commentId,
    issueId: value.issueId,
    authorKind: value.authorKind,
    authorId: value.authorId,
    ...(value.authorUserId ? { authorUserId: value.authorUserId } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    managedMarker,
    body: value.body,
  };
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

function workflowRelationKindValue(
  value: string,
): WorkflowRelationValue["relationKind"] | undefined {
  if (value === "blocks" || value === "blocked_by" || value === "triggered_by") {
    return value;
  }
  return undefined;
}

function commentManagedMarker(body: string, issueId: string, commentId: string): string | undefined {
  if (isRootManagedComment(body)) return rootCommentMarker(issueId);
  if (body.startsWith(MANAGED_RECORD_MARKER)) return `${issueId}:managed-record:${commentId}`;
  return body.match(WORKFLOW_WRITE_MARKER)?.[1];
}

async function workflowMutationTargetValue(issue: Issue) {
  const state = await issue.state;
  if (!state || !issue.projectId) throw new Error("linear_workflow_target_invalid");
  const managed = parseManagedDescription(issue.description ?? "");
  return {
    issueId: issue.id,
    projectId: issue.projectId,
    updatedAt: timestampValue(issue.updatedAt),
    isArchived: issue.archivedAt !== null && issue.archivedAt !== undefined,
    ...(issue.parentId ? { parentIssueId: issue.parentId } : {}),
    statusId: state.id,
    title: issue.title,
    description: managed.businessDescription,
    ...(managed.managedMarker ? { managedMarker: managed.managedMarker } : {}),
    ...(managed.workflowKind ? { workflowKind: managed.workflowKind } : {}),
  };
}

function workflowPreflightTargetValue(issue: WorkflowPreflightIssue) {
  if (typeof issue.updatedAt !== "string" || typeof issue.project?.id !== "string" ||
      typeof issue.state?.id !== "string" || typeof issue.title !== "string" ||
      typeof issue.description !== "string") throw new Error("linear_workflow_target_invalid");
  const managed = parseManagedDescription(issue.description);
  return {
    issueId: issue.id,
    projectId: issue.project.id,
    updatedAt: issue.updatedAt,
    isArchived: issue.archivedAt !== null && issue.archivedAt !== undefined,
    ...(issue.parent?.id ? { parentIssueId: issue.parent.id } : {}),
    statusId: issue.state.id,
    title: issue.title,
    description: managed.businessDescription,
    ...(managed.managedMarker ? { managedMarker: managed.managedMarker } : {}),
    ...(managed.workflowKind ? { workflowKind: managed.workflowKind } : {}),
  };
}

function workflowPreflightOutcome(
  command: import("../types.js").WorkflowMutationCommand,
  facts: ReadonlyMap<string, WorkflowPreflightIssue>,
): import("../types.js").WorkflowMutationReadBack | undefined {
  if (command.kind === "create_workflow_issue") {
    const children = facts.get(command.parentIssueId)?.children;
    if (!children || children.pageInfo?.hasNextPage !== false || !Array.isArray(children.nodes)) {
      throw new Error("linear_workflow_children_read_back_incomplete");
    }
    const matches = children.nodes.map((value) => workflowMutationRawTargetValue(value, command.parentIssueId))
      .filter((value) => value.managedMarker === command.managedMarker);
    if (matches.length > 1) throw new Error("linear_workflow_marker_ambiguous");
    const issue = matches[0];
    if (!issue) return undefined;
    if (issue.projectId !== command.expectedProjectId || issue.statusId !== command.statusId ||
        issue.title !== command.title || issue.description !== command.description) throw preconditionConflictError();
    return { writeId: command.writeId, targetIssueId: issue.issueId, remoteVersion: issue.updatedAt };
  }
  if (command.kind === "update_workflow_issue") {
    const target = workflowPreflightTargetValue(facts.get(command.target.targetIssueId)!);
    return target.statusId === command.statusId && target.title === command.title &&
      target.description === command.description &&
      (command.target.expectedParentIssueId === undefined || target.parentIssueId === command.target.expectedParentIssueId) &&
      (command.target.expectedManagedMarker === undefined || target.managedMarker === command.target.expectedManagedMarker)
      ? { writeId: command.writeId, targetIssueId: target.issueId, remoteVersion: target.updatedAt } : undefined;
  }
  if (command.kind === "archive_workflow_issue" || command.kind === "restore_workflow_issue") {
    const target = workflowPreflightTargetValue(facts.get(command.target.targetIssueId)!);
    const desiredArchived = command.kind === "archive_workflow_issue";
    return target.isArchived === desiredArchived
      ? { writeId: command.writeId, targetIssueId: target.issueId, remoteVersion: target.updatedAt }
      : undefined;
  }
  if (command.kind === "append_workflow_comment") {
    const comments = facts.get(command.target.targetIssueId)?.comments;
    if (!comments || comments.pageInfo?.hasNextPage !== false || !Array.isArray(comments.nodes)) {
      throw new Error("linear_workflow_comment_read_back_incomplete");
    }
    const body = serializeWorkflowComment(command.body, command.writeId);
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
  const relation = relations.nodes.find((value) => value.type === "blocks" &&
    value.issue?.id === sourceIssueId && value.relatedIssue?.id === targetIssueId);
  return relation?.issue?.updatedAt
    ? { writeId: command.writeId, targetIssueId: command.sourceIssueId, remoteVersion: relation.issue.updatedAt }
    : undefined;
}

function workflowPreconditionMismatch(
  command: import("../types.js").WorkflowMutationCommand,
  facts: ReadonlyMap<string, WorkflowPreflightIssue>,
): string | undefined {
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
  if (command.target.expectedManagedMarker !== undefined && target.managedMarker !== command.target.expectedManagedMarker) return "target_managed_marker";
  if (command.target.expectedIsArchived !== undefined && target.isArchived !== command.target.expectedIsArchived) return "target_archive";
  return command.kind !== "update_workflow_issue" || workflowPreflightHasStatus(facts.get(command.target.targetIssueId)!, command.statusId)
    ? undefined : "target_status_catalog";
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
    archivedAt?: unknown;
    project?: { id?: unknown } | null;
    parent?: { id?: unknown } | null;
    state?: { id?: unknown } | null;
    title?: unknown;
    description?: unknown;
  };
  if (typeof raw.id !== "string" || typeof raw.updatedAt !== "string" ||
      typeof raw.project?.id !== "string" || raw.parent?.id !== expectedParentIssueId ||
      typeof raw.state?.id !== "string" || typeof raw.title !== "string" ||
      typeof raw.description !== "string" ||
      (raw.archivedAt !== null && raw.archivedAt !== undefined && typeof raw.archivedAt !== "string")) {
    throw new Error("linear_workflow_target_invalid");
  }
  const managed = parseManagedDescription(raw.description);
  return {
    issueId: raw.id,
    projectId: raw.project.id,
    updatedAt: raw.updatedAt,
    isArchived: raw.archivedAt !== null && raw.archivedAt !== undefined,
    parentIssueId: expectedParentIssueId,
    statusId: raw.state.id,
    title: raw.title,
    description: managed.businessDescription,
    ...(managed.managedMarker ? { managedMarker: managed.managedMarker } : {}),
    ...(managed.workflowKind ? { workflowKind: managed.workflowKind } : {}),
  };
}

function serializeWorkflowIssueDescription(
  description: string,
  managedMarker: string | undefined,
  issueKind: "cycle" | "plan" | "work" | "verify" | "human" | undefined,
) {
  return managedMarker && issueKind
    ? `${description.trim()}\n\n<!-- symphony workflow issue\nmanaged_marker: ${managedMarker}\nissue_kind: ${issueKind}\n-->`
    : description.trim();
}

function serializeWorkflowComment(body: string, writeId: string) {
  if (isManagedRecordBody(body)) return body;
  return `${body.trim()}\n\n<!-- symphony workflow write\nwrite_id: ${writeId}\n-->`;
}

function isManagedRecordBody(body: string): boolean {
  return body.startsWith(MANAGED_RECORD_MARKER) && body.endsWith("\n-->");
}

function workflowIssueKindForUpdate(
  target: Awaited<ReturnType<typeof workflowMutationTargetValue>>,
) {
  return target.workflowKind ?? "work";
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
    labels: issueLabels(fact.labels),
    isArchived: fact.archivedAt !== null && fact.archivedAt !== undefined,
    ...(managed.managedMarker ? { managedMarker: managed.managedMarker } : {}),
    ...(managed.workflowKind ? { workflowKind: managed.workflowKind } : {}),
    ...(managed.nodeKind ? { nodeKind: managed.nodeKind } : {}),
    ...(managed.humanKind ? { humanKind: managed.humanKind } : {}),
    ...(managed.origin ? { origin: managed.origin } : {}),
    ...(managed.completedInputHash ? { completedInputHash: managed.completedInputHash } : {}),
    ...(managed.targetIssueId ? { targetIssueId: managed.targetIssueId } : {}),
    updatedAt: timestampValue(fact.updatedAt),
  };
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
    labels: [],
    isArchived: issue.archivedAt !== null && issue.archivedAt !== undefined,
    ...(managed.managedMarker
      ? { managedMarker: managed.managedMarker }
      : {}),
    ...(managed.workflowKind ? { workflowKind: managed.workflowKind } : {}),
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

function parseManagedDescription(description: string): {
  businessDescription: string;
  managedMarker?: string;
  nodeKind?: "work" | "human";
  humanKind?: "plan_approval" | "planned_input" | "runtime_input";
  origin?: "user" | "symphony";
  completedInputHash?: string;
  targetIssueId?: string;
  workflowKind?: "cycle" | "plan" | "work" | "verify" | "human";
} {
  const workflow = description.match(WORKFLOW_ISSUE_MARKER);
  if (workflow?.index !== undefined) {
    return {
      businessDescription: description.slice(0, workflow.index).trim(),
      managedMarker: workflow[1]!,
      workflowKind: workflow[2] as "cycle" | "plan" | "work" | "verify" | "human",
      ...(workflow[2] === "work" ? { nodeKind: "work" as const } : {}),
      ...(workflow[2] === "human" ? { nodeKind: "human" as const } : {}),
    };
  }
  return { businessDescription: description };
}

function rootCommentMarker(issueId: string) {
  return `${issueId}:root-comment`;
}

function isRootManagedComment(body: string): boolean {
  const marker = body.lastIndexOf(ROOT_MARKER_START);
  return body.startsWith("Symphony\n") && marker > 0 && body.endsWith("\n-->");
}

function isRootOwnershipComment(body: string): boolean {
  if (!body.startsWith(MANAGED_RECORD_MARKER) || !body.endsWith("\n-->")) return false;
  try {
    const value = JSON.parse(body.slice(MANAGED_RECORD_MARKER.length, -"\n-->".length));
    return value && typeof value === "object" && value.kind === "root_ownership";
  } catch {
    return false;
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

function normalizePoolMembers(values: readonly string[]): string[] | undefined {
  if (values.length === 0 || values.length > 64) return undefined;
  const result = [...values];
  if (result.some((value) => !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value))) return undefined;
  if (new Set(result).size !== result.length) return undefined;
  return result;
}

function boundedRootText(value: string, maximum: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function rootOwnershipConductorId(
  comments: readonly { body: string }[],
): string | undefined {
  const owners: string[] = [];
  for (const comment of comments) {
    if (!isRootOwnershipComment(comment.body)) continue;
    try {
      const value = JSON.parse(comment.body.slice(MANAGED_RECORD_MARKER.length, -"\n-->".length)) as {
        conductor_id?: unknown;
      };
      if (typeof value.conductor_id !== "string") throw new Error("invalid");
      owners.push(value.conductor_id);
    } catch {
      throw new Error("project_conductor_root_ownership_invalid");
    }
  }
  if (owners.length > 1) throw new Error("project_conductor_root_ownership_duplicate");
  return owners[0];
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

function projectLabelRebindFingerprint(
  plan: Extract<ConductorProjectLabelRebindPlan, { kind: "ready" }>,
): string {
  const canonical = {
    projectId: plan.projectId,
    labelName: plan.labelName,
    currentConductorLabels: [...plan.currentConductorLabels].sort((left, right) =>
      left.labelId.localeCompare(right.labelId)),
    desiredLabel: plan.desiredLabel
      ? {
          labelId: plan.desiredLabel.labelId,
          name: plan.desiredLabel.name,
          assignedProjectIds: [...plan.desiredLabel.assignedProjectIds].sort(),
        }
      : undefined,
    detachAssignments: [...plan.detachAssignments].sort((left, right) =>
      `${left.projectId}:${left.labelId}`.localeCompare(`${right.projectId}:${right.labelId}`)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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
