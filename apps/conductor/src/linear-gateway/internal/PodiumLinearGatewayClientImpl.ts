import type {
  LinearGatewayInterface,
  LinearWorkflowTreeSnapshot,
} from "../api/LinearGatewayInterface.js";
import type {
  DiscoveredRoot,
  LinearIssueState,
  LinearPriority,
} from "../../root-reconciliation/api/RootModels.js";
import type {
  ProjectRootIndexFailure,
  ProjectRootIndexPageResult,
} from "../../root-discovery/api/ProjectRootIndexInterface.js";
import type { ConductorPoolMember } from "../api/LinearGatewayInterface.js";
import { workflowIssueKind } from "../api/WorkflowKindLabels.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface ProtocolClient {
  request(input: {
    requestId: string;
    body: JsonValue;
    timeoutMs: number;
  }): Promise<JsonValue>;
}

export class PodiumLinearGatewayClientImpl implements LinearGatewayInterface {
  #sequence = 0;
  #projectId: string | undefined;
  #activeDiscovery: {
    rootHeaderCount: number;
    listPageCount: number;
    workflowTreeCount: number;
  } | undefined;
  constructor(
    private readonly conductorShortHash: string,
    private readonly protocol: ProtocolClient,
    private readonly options: {
      bindingId: string;
      instanceId: string;
      timeoutMs: number | (() => number);
      observeDiscovery?(evidence: {
        rootHeaderCount: number;
        listPageCount: number;
        workflowTreeCount: number;
      }): void;
    },
  ) {}

  async resolveProject(): Promise<
    | { kind: "resolved"; projectId: string; conductorPool: ConductorPoolMember[] }
    | { kind: "unbound" | "ambiguous" | "label_conflict" }
  > {
    const response = record(
      await this.#request({
        kind: "resolve_conductor_project",
        binding_id: this.options.bindingId,
        instance_id: this.options.instanceId,
        conductor_short_hash: this.conductorShortHash,
      }),
    );
    if (response.kind === "unbound") return { kind: "unbound" };
    if (response.kind === "conductor_project_ambiguous") {
      return { kind: "ambiguous" };
    }
    if (response.kind !== "resolved") throw protocolError(response);
    const resolved = record(response.resolved_project);
    const project = record(resolved.project);
    const projectId = string(project.project_id, "linear_project_id_invalid");
    const conductorPool = pool(resolved.conductor_pool);
    if (!conductorPool.some(({ conductorShortHash }) => conductorShortHash === this.conductorShortHash)) {
      throw new Error("linear_conductor_pool_membership_invalid");
    }
    this.#projectId = projectId;
    return { kind: "resolved", projectId, conductorPool };
  }

  async readProjectRootIndexPage(input: {
    projectId: string;
    limit: number;
    cursor?: string;
  }): Promise<ProjectRootIndexPageResult> {
    const { projectId, limit, cursor } = input;
    const discovery = { rootHeaderCount: 0, listPageCount: 0, workflowTreeCount: 0 };
    this.#activeDiscovery = discovery;
    try {
      this.#assertProject(projectId);
      const response = record(
        await this.#request({
          kind: "list_project_root_index_page",
          binding_id: this.options.bindingId,
          instance_id: this.options.instanceId,
          expected_project_id: projectId,
          page: {
            limit,
            ...(cursor ? { cursor } : {}),
          },
        }),
      );
      if (response.kind !== "project_root_index_page") {
        return { kind: "failed", failure: discoveryFailure(protocolError(response)) };
      }
      const headers = array(record(response.page).headers, "linear_roots_invalid");
      if (headers.length > limit) {
        return { kind: "failed", failure: schemaDiscoveryFailure("linear_roots_invalid") };
      }
      const roots: DiscoveredRoot[] = [];
      for (const value of headers) {
        const discovered = rootHeader(value);
        roots.push(discovered);
      }
      const pageInfo = record(record(response.page).page_info);
      const hasNextPage = boolean(
        pageInfo.has_next_page,
        "linear_page_info_invalid",
      );
      const endCursor = hasNextPage
        ? string(pageInfo.end_cursor, "linear_page_cursor_missing")
        : undefined;
      discovery.rootHeaderCount = roots.length;
      return {
        kind: "page",
        page: { roots, hasNextPage, ...(endCursor ? { endCursor } : {}) },
      };
    } catch (error) {
      return { kind: "failed", failure: discoveryFailure(error) };
    } finally {
      this.options.observeDiscovery?.({ ...discovery });
      this.#activeDiscovery = undefined;
    }
  }

  async readWorkflowIssueTree(rootIssueId: string): Promise<LinearWorkflowTreeSnapshot> {
    if (!this.#projectId) throw new Error("linear_project_not_resolved");
    const response = record(await this.#request({
      kind: "get_workflow_issue_tree",
      binding_id: this.options.bindingId,
      instance_id: this.options.instanceId,
      conductor_short_hash: this.conductorShortHash,
      expected_project_id: this.#projectId,
      root_issue_id: rootIssueId,
    }));
    if (response.kind !== "workflow_issue_tree") throw protocolError(response);
    return workflowTree(record(response.tree), rootIssueId, this.#projectId);
  }

  async mutateWorkflow(
    input: import("../api/LinearGatewayInterface.js").LinearWorkflowMutationCommand,
  ): Promise<import("../api/LinearGatewayInterface.js").LinearWorkflowMutationOutcome> {
    this.#assertProject(input.expectedProjectId);
    const response = record(await this.#request(workflowMutationBody(
      input,
      this.conductorShortHash,
      this.options.bindingId,
      this.options.instanceId,
    )));
    if (response.kind === "precondition_conflict") return { kind: "precondition_conflict" };
    if (response.kind === "applied" || response.kind === "already_applied") {
      return {
        kind: response.kind,
        readBack: workflowMutationReadBack(response.read_back),
      };
    }
    if (response.kind === "write_unconfirmed") {
      return {
        kind: response.kind,
        readBackTarget: workflowMutationReadBack(response.read_back_target),
      };
    }
    if (response.kind === "failed") {
      const error = record(response.error);
      return {
        kind: "failed",
        code: string(error.code, "linear_workflow_mutation_error_invalid"),
        summary: string(error.sanitized_reason, "linear_workflow_mutation_error_invalid"),
        retryable: boolean(error.retryable, "linear_workflow_mutation_error_invalid"),
      };
    }
    throw protocolError(response);
  }

  #request(body: JsonValue) {
    if (this.#activeDiscovery && body && typeof body === "object" && !Array.isArray(body)) {
      if (body.kind === "list_project_root_index_page") this.#activeDiscovery.listPageCount += 1;
      if (body.kind === "get_workflow_issue_tree") this.#activeDiscovery.workflowTreeCount += 1;
    }
    this.#sequence += 1;
    const timeoutMs = typeof this.options.timeoutMs === "function"
      ? this.options.timeoutMs()
      : this.options.timeoutMs;
    return this.protocol.request({
      requestId: `conductor-${this.#sequence}`,
      body,
      timeoutMs,
    });
  }

  #assertProject(projectId: string) {
    if (this.#projectId !== projectId) {
      throw new Error("linear_project_resolution_changed");
    }
  }

}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
    throw new Error("private_protocol_object_invalid");
  }
  return value;
}

function array(value: JsonValue | undefined, code: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function string(value: JsonValue | undefined, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function number(value: JsonValue | undefined, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(code);
  return value;
}

function boolean(value: JsonValue | undefined, code: string): boolean {
  if (typeof value !== "boolean") throw new Error(code);
  return value;
}

function pool(value: JsonValue | undefined): ConductorPoolMember[] {
  const entries = array(value, "linear_conductor_pool_invalid");
  if (entries.length > 64) throw new Error("linear_conductor_pool_invalid");
  const seen = new Set<string>();
  return entries.map((item) => {
    const entry = record(item);
    const conductorShortHash = string(entry.conductor_short_hash, "linear_conductor_hash_invalid");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conductorShortHash) || seen.has(conductorShortHash)) {
      throw new Error("linear_conductor_pool_invalid");
    }
    seen.add(conductorShortHash);
    return { conductorShortHash };
  });
}

function rootHeader(value: JsonValue): DiscoveredRoot {
  const header = record(value);
  const issueId = string(header.root_issue_id, "linear_root_header_invalid");
  const labels = pool(header.root_conductor_labels);
  if (labels.length > 1) throw new Error("linear_root_header_invalid");
  return {
    issueId,
    identifier: string(header.identifier, "linear_root_header_invalid"),
    projectId: string(header.project_id, "linear_root_header_invalid"),
    state: linearIssueState(header.state),
    isArchived: boolean(header.is_archived, "linear_root_header_invalid"),
    updatedAt: string(header.updated_at, "linear_root_header_invalid"),
    isDelegatedToSymphony: boolean(header.is_delegated_to_symphony, "linear_root_delegation_invalid"),
    priority: linearPriority(header.priority),
    blockers: array(header.blockers, "linear_blockers_invalid").map(
      (blocker) => linearBlocker(issueId, blocker),
    ),
    rootConductorLabels: labels,
  };
}

function linearPriority(value: JsonValue | undefined): LinearPriority {
  if (
    value === "urgent" ||
    value === "high" ||
    value === "normal" ||
    value === "low" ||
    value === "no_priority"
  ) {
    return value;
  }
  throw new Error("linear_priority_invalid");
}

function linearBlocker(rootIssueId: string, value: JsonValue) {
  const blocker = record(value);
  const sourceIssueId = string(
    blocker.source_issue_id,
    "linear_blocker_source_invalid",
  );
  const targetIssueId = string(
    blocker.target_issue_id,
    "linear_blocker_target_invalid",
  );
  if (sourceIssueId !== rootIssueId || targetIssueId === rootIssueId) {
    throw new Error("linear_blocker_relation_invalid");
  }
  return {
    sourceIssueId,
    targetIssueId,
    targetState: linearIssueState(blocker.target_state),
  };
}

function linearIssueState(value: JsonValue | undefined): LinearIssueState {
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

function workflowTree(
  value: Record<string, JsonValue>,
  rootIssueId: string,
  projectId: string,
): LinearWorkflowTreeSnapshot {
  const root = string(value.root_issue_id, "linear_workflow_root_invalid");
  const statuses = array(value.status_catalog, "linear_workflow_status_catalog_invalid").map((item) => {
    const status = record(item);
    return {
      status_id: string(status.status_id, "linear_workflow_status_invalid"),
      name: string(status.name, "linear_workflow_status_invalid"),
      category: workflowStatusCategory(status.category),
      position: number(status.position, "linear_workflow_status_invalid"),
    };
  });
  if (statuses.length === 0 || statuses.length > 64) {
    throw new Error("linear_workflow_status_catalog_invalid");
  }
  const statusIds = new Set<string>();
  const statusNames = new Set<string>();
  const statusById = new Map(statuses.map((status) => [status.status_id, status]));
  for (const status of statuses) {
    if (statusIds.has(status.status_id) || statusNames.has(status.name)) {
      throw new Error("linear_workflow_status_catalog_ambiguous");
    }
    statusIds.add(status.status_id);
    statusNames.add(status.name);
  }
  const rawIssues = array(value.issues, "linear_workflow_issues_invalid").map((item) => {
    const issue = record(item);
    return {
      issue_id: string(issue.issue_id, "linear_workflow_issue_invalid"),
      identifier: string(issue.identifier, "linear_workflow_issue_invalid"),
      project_id: string(issue.project_id, "linear_workflow_issue_invalid"),
      ...(issue.parent_issue_id === undefined ? {} : { parent_issue_id: string(issue.parent_issue_id, "linear_workflow_issue_invalid") }),
      ...(issue.creator_user_id === undefined ? {} : { creator_user_id: string(issue.creator_user_id, "linear_workflow_issue_invalid") }),
      ...(issue.assignee_user_id === undefined ? {} : { assignee_user_id: string(issue.assignee_user_id, "linear_workflow_issue_invalid") }),
      status_id: string(issue.status_id, "linear_workflow_issue_invalid"),
      status_name: string(issue.status_name, "linear_workflow_issue_invalid"),
      status_category: workflowStatusCategory(issue.status_category),
      status_position: number(issue.status_position, "linear_workflow_issue_invalid"),
      order: number(issue.order, "linear_workflow_issue_invalid"),
      depth: number(issue.depth, "linear_workflow_issue_invalid"),
      title: string(issue.title, "linear_workflow_issue_invalid"),
      description: string(issue.description, "linear_workflow_issue_invalid"),
      labels: array(issue.labels, "linear_workflow_issue_labels_invalid").map((label) =>
        string(label, "linear_workflow_issue_label_invalid")),
      is_archived: boolean(issue.is_archived, "linear_workflow_issue_invalid"),
      remote_version: string(issue.remote_version, "linear_workflow_issue_invalid"),
      created_at: string(issue.created_at, "linear_workflow_issue_invalid"),
      updated_at: string(issue.updated_at, "linear_workflow_issue_invalid"),
    };
  });
  const issues = rawIssues.map((issue) => {
    if (issue.issue_id === root) return { ...issue, issue_kind: "root" as const };
    return { ...issue, issue_kind: primaryIssueKind(issue.labels) };
  });
  if (issues.length === 0 || issues.length > 512) {
    throw new Error("linear_workflow_issues_invalid");
  }
  const issueIds = new Set<string>();
  for (const issue of issues) {
    const status = statusById.get(issue.status_id);
    if (
      issueIds.has(issue.issue_id) ||
      issue.project_id !== projectId ||
      !statusIds.has(issue.status_id) ||
      issue.status_name !== status?.name ||
      issue.status_category !== status?.category ||
      issue.status_position !== status?.position ||
      !Number.isInteger(issue.depth) ||
      issue.depth < 0 ||
      issue.depth > 32
    ) {
      throw new Error("linear_workflow_issue_invalid");
    }
    issueIds.add(issue.issue_id);
  }
  const comments = array(value.comments, "linear_workflow_comments_invalid").map(workflowComment);
  if (comments.length > 4_096) throw new Error("linear_workflow_comments_invalid");
  const commentIds = new Set<string>();
  for (const comment of comments) {
    if (commentIds.has(comment.comment_id) || !issueIds.has(comment.issue_id)) {
      throw new Error("linear_workflow_comment_invalid");
    }
    commentIds.add(comment.comment_id);
    if (
      (comment.parent_comment_id === undefined && comment.thread_root_comment_id !== comment.comment_id) ||
      (comment.parent_comment_id !== undefined &&
        comment.parent_comment_id === comment.comment_id)
    ) {
      throw new Error("linear_workflow_comment_thread_invalid");
    }
    const reactionIds = new Set<string>();
    for (const reaction of comment.reactions) {
      if (reactionIds.has(reaction.reaction_id)) throw new Error("linear_workflow_comment_reaction_invalid");
      reactionIds.add(reaction.reaction_id);
    }
  }
  for (const comment of comments) {
    if (
      comment.parent_comment_id !== undefined &&
      (!commentIds.has(comment.parent_comment_id) || !commentIds.has(comment.thread_root_comment_id))
    ) {
      throw new Error("linear_workflow_comment_thread_invalid");
    }
  }
  const relations = array(value.relations, "linear_workflow_relations_invalid").map((item) => {
    const relation = record(item);
    return {
      relation_id: string(relation.relation_id, "linear_workflow_relation_invalid"),
      relation_kind: workflowRelationKind(relation.relation_kind),
      source_issue_id: string(relation.source_issue_id, "linear_workflow_relation_invalid"),
      target_issue_id: string(relation.target_issue_id, "linear_workflow_relation_invalid"),
    };
  });
  if (relations.length > 1_024) throw new Error("linear_workflow_relations_invalid");
  const relationIds = new Set<string>();
  for (const relation of relations) {
    if (
      relationIds.has(relation.relation_id) ||
      !issueIds.has(relation.source_issue_id) ||
      !issueIds.has(relation.target_issue_id) ||
      relation.source_issue_id === relation.target_issue_id
    ) {
      throw new Error("linear_workflow_relation_invalid");
    }
    relationIds.add(relation.relation_id);
  }
  const attachments = array(value.attachments, "linear_workflow_attachments_invalid").map((item) => {
    const attachment = record(item);
    return {
      attachment_id: string(attachment.attachment_id, "linear_workflow_attachment_invalid"),
      issue_id: string(attachment.issue_id, "linear_workflow_attachment_invalid"),
      title: string(attachment.title, "linear_workflow_attachment_invalid"),
      url: string(attachment.url, "linear_workflow_attachment_invalid"),
      source_type: string(attachment.source_type, "linear_workflow_attachment_invalid"),
      remote_version: string(attachment.remote_version, "linear_workflow_attachment_invalid"),
      created_at: string(attachment.created_at, "linear_workflow_attachment_invalid"),
      updated_at: string(attachment.updated_at, "linear_workflow_attachment_invalid"),
    };
  });
  if (attachments.length > 1_024) throw new Error("linear_workflow_attachments_invalid");
  const attachmentIds = new Set<string>();
  for (const attachment of attachments) {
    if (attachmentIds.has(attachment.attachment_id) || !issueIds.has(attachment.issue_id)) {
      throw new Error("linear_workflow_attachment_invalid");
    }
    attachmentIds.add(attachment.attachment_id);
  }
  const activities = array(value.activities, "linear_workflow_activities_invalid").map((item) => {
    const activity = record(item);
    const activityKinds = array(activity.activity_kinds, "linear_workflow_activity_invalid")
      .map(workflowActivityKind);
    if (activityKinds.length === 0 || activityKinds.length > 7 || new Set(activityKinds).size !== activityKinds.length) {
      throw new Error("linear_workflow_activity_invalid");
    }
    return {
      activity_id: string(activity.activity_id, "linear_workflow_activity_invalid"),
      issue_id: string(activity.issue_id, "linear_workflow_activity_invalid"),
      activity_kinds: activityKinds,
      actor_kind: workflowCommentAuthorKind(activity.actor_kind),
      ...(activity.actor_id === undefined ? {} : { actor_id: string(activity.actor_id, "linear_workflow_activity_invalid") }),
      ...(activity.from_state_id === undefined ? {} : { from_state_id: string(activity.from_state_id, "linear_workflow_activity_invalid") }),
      ...(activity.to_state_id === undefined ? {} : { to_state_id: string(activity.to_state_id, "linear_workflow_activity_invalid") }),
      ...(activity.updated_description === undefined ? {} : { updated_description: string(activity.updated_description, "linear_workflow_activity_invalid") }),
      ...(activity.archived === undefined ? {} : { archived: boolean(activity.archived, "linear_workflow_activity_invalid") }),
      ...(activity.added_label_ids === undefined ? {} : { added_label_ids: workflowIdentifierArray(activity.added_label_ids) }),
      ...(activity.removed_label_ids === undefined ? {} : { removed_label_ids: workflowIdentifierArray(activity.removed_label_ids) }),
      ...(activity.from_parent_id === undefined ? {} : { from_parent_id: string(activity.from_parent_id, "linear_workflow_activity_invalid") }),
      ...(activity.to_parent_id === undefined ? {} : { to_parent_id: string(activity.to_parent_id, "linear_workflow_activity_invalid") }),
      ...(activity.from_delegate_id === undefined ? {} : { from_delegate_id: string(activity.from_delegate_id, "linear_workflow_activity_invalid") }),
      ...(activity.to_delegate_id === undefined ? {} : { to_delegate_id: string(activity.to_delegate_id, "linear_workflow_activity_invalid") }),
      ...(activity.attachment_id === undefined ? {} : { attachment_id: string(activity.attachment_id, "linear_workflow_activity_invalid") }),
      remote_version: string(activity.remote_version, "linear_workflow_activity_invalid"),
      created_at: string(activity.created_at, "linear_workflow_activity_invalid"),
    };
  });
  if (activities.length > 8_192) throw new Error("linear_workflow_activities_invalid");
  const activityIds = new Set<string>();
  for (const activity of activities) {
    if (activityIds.has(activity.activity_id) || !issueIds.has(activity.issue_id)) {
      throw new Error("linear_workflow_activity_invalid");
    }
    activityIds.add(activity.activity_id);
  }
  const sourceManifest = array(value.source_manifest, "linear_workflow_source_manifest_invalid").map((item) => {
    const source = record(item);
    return {
      source_kind: workflowSourceKind(source.source_kind),
      source_id: string(source.source_id, "linear_workflow_source_manifest_invalid"),
      source_version: string(source.source_version, "linear_workflow_source_manifest_invalid"),
      actor_kind: workflowCommentAuthorKind(source.actor_kind),
      ...(source.stable_write_id === undefined ? {} : {
        stable_write_id: string(source.stable_write_id, "linear_workflow_source_manifest_invalid"),
      }),
    };
  });
  if (sourceManifest.length > 8_192) throw new Error("linear_workflow_source_manifest_invalid");
  const coverageValue = record(value.coverage);
  const omissions = array(coverageValue.omissions, "linear_workflow_source_coverage_invalid").map((item) => {
    const omission = record(item);
    return {
      source_id: string(omission.source_id, "linear_workflow_source_coverage_invalid"),
      reason: string(omission.reason, "linear_workflow_source_coverage_invalid"),
    };
  });
  const coverage = {
    is_complete: boolean(coverageValue.is_complete, "linear_workflow_source_coverage_invalid"),
    omissions,
  };
  const rootIssue = issues.find(({ issue_id }) => issue_id === rootIssueId);
  if (
    root !== rootIssueId ||
    !rootIssue ||
    rootIssue.depth !== 0 ||
    rootIssue.parent_issue_id !== undefined ||
    issues.some((issue) => issue.project_id !== projectId)
  ) {
    throw new Error("linear_workflow_tree_scope_invalid");
  }
  return {
    root_issue_id: root,
    status_catalog: statuses,
    issues,
    comments,
    relations,
    attachments,
    activities,
    source_manifest: sourceManifest,
    coverage,
    observed_at: string(value.observed_at, "linear_workflow_tree_invalid"),
  };
}

function primaryIssueKind(
  labels: string[],
): "cycle" | "plan" | "work" | "verify" | "finding" {
  const kind = workflowIssueKind(labels);
  if (!kind || kind === "root") throw new Error("linear_workflow_issue_kind_invalid");
  return kind;
}

function workflowStatusCategory(value: JsonValue | undefined): LinearWorkflowTreeSnapshot["status_catalog"][number]["category"] {
  if (value === "backlog" || value === "unstarted" || value === "started" || value === "completed" || value === "canceled") return value;
  throw new Error("linear_workflow_status_category_invalid");
}

function workflowCommentAuthorKind(value: JsonValue | undefined): LinearWorkflowTreeSnapshot["comments"][number]["author_kind"] {
  if (value === "human" || value === "symphony" || value === "linear_integration" || value === "external_automation" || value === "unknown") return value;
  throw new Error("linear_workflow_comment_author_kind_invalid");
}

function workflowComment(value: JsonValue): LinearWorkflowTreeSnapshot["comments"][number] {
  const comment = record(value);
  const reactions = array(comment.reactions, "linear_workflow_comment_reactions_invalid").map((value) => {
    const reaction = record(value);
    return {
      reaction_id: string(reaction.reaction_id, "linear_workflow_comment_reaction_invalid"),
      emoji: string(reaction.emoji, "linear_workflow_comment_reaction_invalid"),
      actor_kind: workflowCommentAuthorKind(reaction.actor_kind),
      actor_id: string(reaction.actor_id, "linear_workflow_comment_reaction_invalid"),
    };
  });
  return {
    comment_id: string(comment.comment_id, "linear_workflow_comment_invalid"),
    issue_id: string(comment.issue_id, "linear_workflow_comment_invalid"),
    body: string(comment.body, "linear_workflow_comment_invalid"),
    author_kind: workflowCommentAuthorKind(comment.author_kind),
    author_id: string(comment.author_id, "linear_workflow_comment_invalid"),
    ...(comment.author_user_id === undefined ? {} : { author_user_id: string(comment.author_user_id, "linear_workflow_comment_invalid") }),
    ...(comment.parent_comment_id === undefined ? {} : { parent_comment_id: string(comment.parent_comment_id, "linear_workflow_comment_invalid") }),
    thread_root_comment_id: string(comment.thread_root_comment_id, "linear_workflow_comment_invalid"),
    thread_state: workflowCommentThreadState(comment.thread_state),
    reactions,
    created_at: string(comment.created_at, "linear_workflow_comment_invalid"),
    remote_version: string(comment.remote_version, "linear_workflow_comment_invalid"),
    updated_at: string(comment.updated_at, "linear_workflow_comment_invalid"),
  };
}

function workflowCommentThreadState(value: JsonValue | undefined): "resolved" | "unresolved" {
  if (value === "resolved" || value === "unresolved") return value;
  throw new Error("linear_workflow_comment_thread_state_invalid");
}

function workflowRelationKind(value: JsonValue | undefined): LinearWorkflowTreeSnapshot["relations"][number]["relation_kind"] {
  if (value === "blocks" || value === "blocked_by" || value === "relates_to" || value === "triggered_by") return value;
  throw new Error("linear_workflow_relation_kind_invalid");
}

function workflowActivityKind(value: JsonValue): LinearWorkflowTreeSnapshot["activities"][number]["activity_kinds"][number] {
  if (
    value === "status_changed" || value === "description_changed" || value === "archive_changed"
    || value === "labels_changed" || value === "parent_changed" || value === "delegation_changed"
    || value === "attachment_changed"
  ) return value;
  throw new Error("linear_workflow_activity_invalid");
}

function workflowIdentifierArray(value: JsonValue): string[] {
  const identifiers = array(value, "linear_workflow_activity_invalid")
    .map((entry) => string(entry, "linear_workflow_activity_invalid"));
  if (identifiers.length > 64 || new Set(identifiers).size !== identifiers.length) {
    throw new Error("linear_workflow_activity_invalid");
  }
  return identifiers;
}

function workflowSourceKind(value: JsonValue | undefined): LinearWorkflowTreeSnapshot["source_manifest"][number]["source_kind"] {
  if (value === "linear_issue" || value === "linear_comment" || value === "linear_relation" || value === "linear_attachment" || value === "linear_activity" || value === "linear_status_catalog") return value;
  throw new Error("linear_workflow_source_manifest_invalid");
}

function protocolError(response: Record<string, JsonValue>): Error {
  const code = typeof response.code === "string" ? response.code : "private_protocol_unexpected_result";
  const category = projectRootIndexFailureCategory(response.category);
  const error = new Error(code);
  Object.assign(error, {
    category: category ?? "protocol",
    retryable: category !== undefined && response.retryable === true,
  });
  return error;
}

function discoveryFailure(error: unknown): ProjectRootIndexFailure {
  const details = error instanceof Error
    ? error as Error & { category?: unknown; retryable?: unknown }
    : undefined;
  const code = details && /^[a-z][a-z0-9_:-]{1,120}$/u.test(details.message)
    ? details.message
    : "linear_discovery_failed";
  const category = projectRootIndexFailureCategory(details?.category);
  const malformedCategory = details?.category !== undefined && category === undefined;
  const retryable = !malformedCategory && (details?.retryable === true || new Set([
    "private_ipc_closed",
    "private_ipc_request_timeout",
    "private_ipc_write_failed",
  ]).has(code));
  return {
    code,
    category: malformedCategory ? "protocol" : category ?? (retryable ? "transport" : "schema"),
    retryable,
  };
}

function schemaDiscoveryFailure(code: string): ProjectRootIndexFailure {
  return { code, category: "schema", retryable: false };
}

function projectRootIndexFailureCategory(
  value: unknown,
): ProjectRootIndexFailure["category"] | undefined {
  if (value === "linear" || value === "protocol" || value === "schema" || value === "transport") {
    return value;
  }
  return undefined;
}

function workflowMutationBody(
  input: import("../api/LinearGatewayInterface.js").LinearWorkflowMutationCommand,
  conductorShortHash: string,
  bindingId: string,
  instanceId: string,
): Record<string, JsonValue> {
  const common = {
    binding_id: bindingId,
    instance_id: instanceId,
    write_id: input.writeId,
    conductor_short_hash: conductorShortHash,
    expected_project_id: input.expectedProjectId,
    root_issue_id: input.rootIssueId,
    expected_root_remote_version: input.expectedRootRemoteVersion,
  };
  switch (input.kind) {
    case "create_workflow_issue":
      return {
        ...common,
        kind: input.kind,
        parent_expected_remote_version: input.parentExpectedRemoteVersion,
        parent_expected_status_id: input.parentExpectedStatusId,
        parent_issue_id: input.parentIssueId,
        title: input.title,
        description: input.description,
        status_id: input.statusId,
        label_names: input.labelNames,
        ...(input.order === undefined ? {} : { order: input.order }),
      };
    case "update_workflow_issue":
    case "append_workflow_comment":
    case "create_workflow_attachment":
      return {
        ...common,
        kind: input.kind,
        target: {
          target_issue_id: input.target.targetIssueId,
          expected_remote_version: input.target.expectedRemoteVersion,
          ...(input.target.expectedStatusId === undefined ? {} : { expected_status_id: input.target.expectedStatusId }),
          ...(input.target.expectedParentIssueId === undefined ? {} : { expected_parent_issue_id: input.target.expectedParentIssueId }),
          ...(input.target.expectedIsArchived === undefined ? {} : { expected_is_archived: input.target.expectedIsArchived }),
        },
        ...(input.kind === "update_workflow_issue"
          ? {
            status_id: input.statusId,
            title: input.title,
            description: input.description,
            label_names: input.labelNames,
            is_archived: input.isArchived,
            parent_assignment: input.parentAssignment.mode === "set"
              ? { mode: "set", parent_issue_id: input.parentAssignment.parentIssueId }
              : { mode: input.parentAssignment.mode },
            ...(input.order === undefined ? {} : { order: input.order }),
          }
          : input.kind === "append_workflow_comment" ? { body: input.body }
            : input.kind === "create_workflow_attachment" ? { title: input.title, url: input.url } : {}),
      };
    case "create_comment_reply":
      return {
        ...common,
        kind: input.kind,
        source_comment_id: input.sourceCommentId,
        expected_source_comment_remote_version: input.expectedSourceCommentRemoteVersion,
        expected_thread_root_comment_id: input.expectedThreadRootCommentId,
        expected_thread_state: input.expectedThreadState,
        body: input.body,
      };
    case "set_comment_receipt_reaction":
      return {
        ...common,
        kind: input.kind,
        reply_write_id: input.replyWriteId,
        source_comment_id: input.sourceCommentId,
        expected_source_comment_remote_version: input.expectedSourceCommentRemoteVersion,
        thread_root_comment_id: input.threadRootCommentId,
        expected_receipt: input.expectedReceipt,
        receipt: input.receipt,
      };
    case "set_comment_thread_state":
      return {
        ...common,
        kind: input.kind,
        reply_write_id: input.replyWriteId,
        source_comment_id: input.sourceCommentId,
        expected_source_comment_remote_version: input.expectedSourceCommentRemoteVersion,
        thread_root_comment_id: input.threadRootCommentId,
        expected_thread_state: input.expectedThreadState,
        thread_state: input.threadState,
      };
    case "create_workflow_relation":
      return {
        ...common,
        kind: input.kind,
        source_issue_id: input.sourceIssueId,
        source_expected_remote_version: input.sourceExpectedRemoteVersion,
        target_issue_id: input.targetIssueId,
        target_expected_remote_version: input.targetExpectedRemoteVersion,
        relation_kind: input.relationKind,
        relation_state: input.relationState,
      };
  }
}

function workflowMutationReadBack(value: JsonValue | undefined): import("../api/LinearGatewayInterface.js").WorkflowMutationReadBack {
  const readBack = record(value);
  const issueVersions = Array.isArray(readBack.issue_versions)
    ? readBack.issue_versions.map((value) => {
      const version = record(value);
      return {
        issueId: string(version.issue_id, "linear_workflow_read_back_invalid"),
        remoteVersion: string(version.remote_version, "linear_workflow_read_back_invalid"),
      };
    })
    : undefined;
  const comment = readBack.comment === undefined
    ? undefined
    : workflowComment(readBack.comment);
  const receipt = readBack.symphony_receipt === undefined
    ? undefined
    : (() => {
      const value = record(readBack.symphony_receipt);
      const rawReceipt = value.receipt;
      if (rawReceipt !== "check" && rawReceipt !== "cross" && rawReceipt !== "none") {
        throw new Error("linear_workflow_read_back_invalid");
      }
      const receipt: "check" | "cross" | "none" = rawReceipt;
      return {
        replyWriteId: string(value.reply_write_id, "linear_workflow_read_back_invalid"),
        sourceCommentId: string(value.source_comment_id, "linear_workflow_read_back_invalid"),
        threadRootCommentId: string(value.thread_root_comment_id, "linear_workflow_read_back_invalid"),
        receipt,
      };
    })();
  return {
    writeId: string(readBack.write_id, "linear_workflow_read_back_invalid"),
    targetIssueId: string(readBack.target_issue_id, "linear_workflow_read_back_invalid"),
    remoteVersion: string(readBack.remote_version, "linear_workflow_read_back_invalid"),
    ...(issueVersions ? { issueVersions } : {}),
    ...(comment ? { comment } : {}),
    ...(receipt ? { symphonyReceipt: receipt } : {}),
  };
}
