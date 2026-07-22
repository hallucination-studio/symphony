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
  LinearMutationCommand,
  LinearPriority,
  RootIssueValue,
  RootUsageValue,
  WorkflowCommentValue,
  WorkflowRelationValue,
} from "../types.js";
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
const ROOT_PHASE_PREFIX = "symphony:run/";
const ROOT_HEADER_MARKER = "<!-- symphony root\n";

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
        id identifier title description priority sortOrder updatedAt
        project { id }
        parent { id }
        delegate { id }
        state { name }
        comments(first: 2, filter: { body: { contains: $commentMarker } }) {
          nodes { id body updatedAt issue { id } }
          pageInfo { hasNextPage }
        }
        workflowManagedComments: comments(first: 64, filter: { body: { contains: $workflowCommentMarker } }) {
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
  query SymphonyIssueTreeRoot($rootIssueId: String!, $commentMarker: String!) {
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
const WORKFLOW_ISSUE_TREE_ROOT_QUERY = `
  query SymphonyIssueTreeRoot($rootIssueId: String!) {
    issue(id: $rootIssueId) {
      id identifier title description sortOrder updatedAt
      project { id }
      parent { id }
      state { name }
      labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
      comments(first: 64) {
        nodes { id body updatedAt issue { id } }
        pageInfo { hasNextPage }
      }
      inverseRelations(first: 250) {
        nodes { id type issue { id state { name } project { id } } relatedIssue { id project { id } } }
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
const WORKFLOW_ISSUE_TREE_CHILDREN_QUERY = `
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
          nodes { id type issue { id state { name } project { id } } relatedIssue { id project { id } } }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const ROOT_MARKER_START = "<!-- symphony root\n";
const WORKFLOW_ISSUE_MARKER =
  /\n*<!-- symphony workflow issue\nmanaged_marker: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\nissue_kind: (cycle|plan|work|verify|human)\n-->\s*$/;
const WORKFLOW_WRITE_MARKER =
  /\n*<!-- symphony workflow write\nwrite_id: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\n-->\s*$/;
const TURN_EVENT_MARKER =
  /\n*<!-- symphony turn event\nevent_key: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}:(?:0|[1-9][0-9]{0,15}))\n-->\s*$/;
const AGENT_WRITE_MARKER =
  /\n*<!-- symphony agent write\nwrite_id: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\n-->\s*$/;
const MANAGED_IDENTITY_MARKER =
  /\n*<!-- symphony managed marker\nmanaged_marker: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\n-->\s*$/;
const MANAGED_RECORD_MARKER = "<!-- symphony managed-record\n";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
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
  observe?(observation: LinearPhysicalRequestObservation): void;
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
  workflowManagedComments?: {
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
    permit?: () => void,
  ): Promise<string> {
    const client = observedClient(
      { kind: "development_token", token: developmentToken, delegateActorId: "bootstrap" },
      observe || permit
        ? {
            correlationId: randomUUID,
            now: Date.now,
            ...(observe ? { observe } : {}),
            ...(permit ? { permit } : {}),
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
          parentId: command.parentIssueId,
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
      const rootManagedComments = [
        ...fact.comments.nodes,
        ...(fact.workflowManagedComments?.nodes ?? []),
      ].flatMap((comment) => {
        if (comment.issue.id !== fact.id) {
          throw new Error("linear_root_comment_identity_mismatch");
        }
        if (!isRootManagedComment(comment.body) && !isRootOwnershipComment(comment.body)) return [];
        return [{
          commentId: comment.id,
          issueId: fact.id,
          updatedAt: timestampValue(comment.updatedAt),
          managedMarker: isRootManagedComment(comment.body)
            ? rootCommentMarker(fact.id)
            : `${fact.id}:managed-record:${comment.id}`,
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
    comments: WorkflowCommentValue[];
    relations: WorkflowRelationValue[];
    observedAt: string;
    pageInfo: PageInfo;
  }> {
    if (input.cursor) throw new Error("linear_tree_cursor_invalid");
    const batched = await this.#batchedIssueTree(input.projectId, input.rootIssueId, false);
    if (batched) return batched;
    const root = await this.#client.issue(input.rootIssueId);
    if (root.projectId !== input.projectId || root.parentId) {
      throw new Error("linear_tree_root_invalid");
    }
    const nodes: LinearIssueValue[] = [];
    const workflowFacts: Issue[] = [];
    await collectTree(root, input.projectId, 0, nodes, workflowFacts);
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
      comments: await workflowCommentsFromIssues(workflowFacts),
      relations: await workflowRelationsFromIssues(workflowFacts, input.projectId),
      observedAt: new Date().toISOString(),
      pageInfo: { hasNextPage: false },
    };
  }

  async #batchedIssueTree(
    projectId: string,
    rootIssueId: string,
    workflow = false,
  ) {
    const rawRequest = this.#client.client?.rawRequest?.bind(this.#client.client);
    if (!rawRequest) return undefined;
    const rootResponse = await rawRequest<IssueTreeRootData, {
      rootIssueId: string;
      commentMarker?: string;
    }>(
      workflow ? WORKFLOW_ISSUE_TREE_ROOT_QUERY : ISSUE_TREE_ROOT_QUERY,
      workflow ? { rootIssueId } : { rootIssueId, commentMarker: ROOT_HEADER_MARKER },
    );
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
        }>(workflow ? WORKFLOW_ISSUE_TREE_CHILDREN_QUERY : ISSUE_TREE_CHILDREN_QUERY, {
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
    const comments = [...facts.values()].flatMap(({ fact }) =>
      fact.comments.nodes.map((comment) => workflowCommentValue(comment, fact.id)),
    );
    if (workflow && comments.length > MAX_ROOT_COMMENTS) {
      throw new Error("linear_workflow_comments_too_many");
    }
    const relations = workflow ? workflowRelationValues(facts, projectId) : [];
    if (relations.length > 1_024) {
      throw new Error("linear_workflow_relations_too_many");
    }
    return {
      nodes,
      rootPhaseLabels,
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
      true,
    ) ?? await this.getIssueTree({ ...input, limit: PAGE_LIMIT });
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
          updatedAt title description state { id }
          team { id states(first: 64) { nodes { id } pageInfo { hasNextPage } } }
          comments(first: 64) { nodes { id body updatedAt issue { id } } pageInfo { hasNextPage } }
          children(first: 64) { nodes { id updatedAt project { id } parent { id } state { id } title description } pageInfo { hasNextPage } }
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
      `query WorkflowMutationChildren { issue(id: ${quoteGraphql(parentIssueId)}) { ${workflowScopeSelection(32)} updatedAt children(first: 64) { nodes { id updatedAt project { id } parent { id } state { id } title description } pageInfo { hasNextPage } } } }`,
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
    const response = await rawRequest(`query WorkflowMutationTarget { issue(id: ${quoteGraphql(issueId)}) { ${workflowScopeSelection(32)} updatedAt title description state { id } } }`);
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
      .filter(({ body }) => isRootManagedComment(body) || isRootOwnershipComment(body));
    if (comments.length > 2) {
      throw new Error("linear_root_comments_too_many");
    }
    return comments.map((comment) => ({
      commentId: comment.id,
      issueId: issue.id,
      updatedAt: comment.updatedAt.toISOString(),
      managedMarker: isRootManagedComment(comment.body)
        ? rootCommentMarker(issue.id)
        : `${issue.id}:managed-record:${comment.id}`,
      body: comment.body,
    }));
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
  observation.permit?.();
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

async function collectTree(
  issue: Issue,
  projectId: string,
  depth: number,
  output: LinearIssueValue[],
  workflowFacts?: Issue[],
): Promise<void> {
  if (depth > 32 || output.length >= MAX_TREE_NODES) {
    throw new Error("linear_tree_bounds_exceeded");
  }
  if (issue.projectId !== projectId) throw new Error("linear_project_mismatch");
  output.push(await issueValue(issue, depth));
  workflowFacts?.push(issue);
  const children = await allNodes(issue.children({ first: PAGE_LIMIT }), MAX_TREE_NODES);
  children.sort(
    (left, right) =>
      (left.subIssueSortOrder ?? left.sortOrder) -
        (right.subIssueSortOrder ?? right.sortOrder) ||
      left.identifier.localeCompare(right.identifier),
  );
  for (const child of children) {
    if (child.parentId !== issue.id) throw new Error("linear_parent_mismatch");
    await collectTree(child, projectId, depth + 1, output, workflowFacts);
  }
}

async function workflowCommentsFromIssues(
  issues: Issue[],
): Promise<WorkflowCommentValue[]> {
  const comments: WorkflowCommentValue[] = [];
  for (const issue of issues) {
    const values = await allNodes(issue.comments({ first: PAGE_LIMIT }), MAX_ROOT_COMMENTS);
    for (const comment of values) {
      if (comment.issueId !== issue.id) throw new Error("linear_workflow_comment_identity_mismatch");
      comments.push(workflowCommentValue(comment, issue.id));
    }
  }
  return comments;
}

async function workflowRelationsFromIssues(
  issues: Issue[],
  projectId: string,
): Promise<WorkflowRelationValue[]> {
  const issueIds = new Set(issues.map(({ id }) => id));
  const relations: WorkflowRelationValue[] = [];
  const relationIds = new Set<string>();
  for (const issue of issues) {
    const values = await allNodes(issue.inverseRelations({ first: PAGE_LIMIT }), MAX_TREE_NODES);
    for (const relation of values) {
      const relationKind = workflowRelationKindValue(relation.type);
      if (!relationKind) continue;
      if (
        !relation.id ||
        !relation.issueId ||
        relation.relatedIssueId !== issue.id ||
        relation.issueId === issue.id ||
        relationIds.has(relation.id)
      ) {
        throw new Error("linear_workflow_relation_invalid");
      }
      const source = await relation.issue;
      if (!source || source.id !== relation.issueId || source.projectId !== projectId) {
        throw new Error("linear_workflow_relation_project_invalid");
      }
      if (!issueIds.has(source.id)) continue;
      relationIds.add(relation.id);
      relations.push({
        relationId: relation.id,
        relationKind,
        sourceIssueId: source.id,
        targetIssueId: issue.id,
      });
    }
  }
  return relations;
}

function workflowCommentValue(
  comment: { id: string; issue?: unknown; issueId?: string | null; body: string; updatedAt: string | Date },
  issueId: string,
): WorkflowCommentValue {
  const commentIssue = comment.issue as { id?: unknown } | undefined;
  if (
    (comment.issueId !== undefined && comment.issueId !== issueId) ||
    (commentIssue !== undefined && commentIssue.id !== issueId)
  ) {
    throw new Error("linear_workflow_comment_identity_mismatch");
  }
  const managedMarker = commentManagedMarker(comment.body, issueId, comment.id);
  return {
    commentId: comment.id,
    issueId,
    body: comment.body,
    ...(managedMarker ? { managedMarker } : {}),
    remoteVersion: timestampValue(comment.updatedAt),
    updatedAt: timestampValue(comment.updatedAt),
  };
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
  return body.match(AGENT_WRITE_MARKER)?.[1]
    ?? body.match(WORKFLOW_WRITE_MARKER)?.[1]
    ?? body.match(TURN_EVENT_MARKER)?.[1];
}

async function workflowMutationTargetValue(issue: Issue) {
  const state = await issue.state;
  if (!state || !issue.projectId) throw new Error("linear_workflow_target_invalid");
  const managed = parseManagedDescription(issue.description ?? "");
  return {
    issueId: issue.id,
    projectId: issue.projectId,
    updatedAt: timestampValue(issue.updatedAt),
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
    project?: { id?: unknown } | null;
    parent?: { id?: unknown } | null;
    state?: { id?: unknown } | null;
    title?: unknown;
    description?: unknown;
  };
  if (typeof raw.id !== "string" || typeof raw.updatedAt !== "string" ||
      typeof raw.project?.id !== "string" || raw.parent?.id !== expectedParentIssueId ||
      typeof raw.state?.id !== "string" || typeof raw.title !== "string" ||
      typeof raw.description !== "string") {
    throw new Error("linear_workflow_target_invalid");
  }
  const managed = parseManagedDescription(raw.description);
  return {
    issueId: raw.id,
    projectId: raw.project.id,
    updatedAt: raw.updatedAt,
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
    ...(managed.workflowKind ? { workflowKind: managed.workflowKind } : {}),
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
