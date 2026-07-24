import type {
  LinearGatewayInterface,
  LinearWorkflowTreeSnapshot,
} from "../api/LinearGatewayInterface.js";
import type {
  DiscoveredRoot,
  LinearIssueState,
  LinearPriority,
} from "../../root-reconciliation/api/RootModels.js";
import type { ConductorPoolMember } from "../api/LinearGatewayInterface.js";
import { parseManagedRecord } from "../../root-reconciliation/api/index.js";
import type { WorkflowIssueRecord } from "../../root-reconciliation/api/ManagedRecords.js";

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

type WireIssue = {
  issue_id: string;
  identifier: string;
  project_id: string;
  parent_issue_id?: string;
  state: LinearIssueState;
  order: number;
  depth: number;
  title: string;
  description: string;
  is_archived: boolean;
  updated_at: string;
};

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
      bindingId?: string;
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
        binding_id: this.#bindingId(),
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

  async listRoots(projectId: string) {
    const roots: DiscoveredRoot[] = [];
    for await (const page of this.listRootPages(projectId)) roots.push(...page.roots);
    return roots;
  }

  async *listRootPages(projectId: string): AsyncGenerator<{
    roots: DiscoveredRoot[];
    hasNextPage: boolean;
    ordering: "unsupported";
  }> {
    this.#assertProject(projectId);
    if (this.#activeDiscovery) throw new Error("linear_discovery_overlap");
    const discovery = { rootHeaderCount: 0, listPageCount: 0, workflowTreeCount: 0 };
    let rootCount = 0;
    this.#activeDiscovery = discovery;
    try {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = record(
        await this.#request({
          kind: "list_root_issues",
          binding_id: this.#bindingId(),
          project_id: projectId,
          page: {
            limit: 250,
            ...(cursor ? { cursor } : {}),
          },
        }),
      );
      if (response.kind !== "root_issues_page") throw protocolError(response);
      const items = array(response.items, "linear_roots_invalid");
      const roots: DiscoveredRoot[] = [];
      for (const value of items) {
        const item = record(value);
        const issue = wireIssue(item.issue);
        const managedConductorId = rootManagedConductorId(item.root_managed_comments, issue.issue_id);
        const discovered: DiscoveredRoot = {
          issueId: issue.issue_id,
          identifier: issue.identifier,
          state: issue.state,
          title: issue.title,
          description: issue.description,
          updatedAt: issue.updated_at,
          projectId: issue.project_id,
          parentIssueId: issue.parent_issue_id ?? null,
          isDelegatedToSymphony: boolean(
            item.is_delegated_to_symphony,
            "linear_delegation_invalid",
          ),
          priority: linearPriority(item.priority),
          order: issue.order,
          blockers: array(item.blockers, "linear_blockers_invalid").map(
            (blocker) => linearBlocker(issue.issue_id, blocker),
          ),
          rootConductorLabels: pool(item.root_conductor_labels),
          ...(managedConductorId ? { managedConductorId } : {}),
        };
        roots.push(discovered);
        rootCount += 1;
        if (rootCount > 512) throw new Error("linear_roots_too_many");
      }
      const pageInfo = record(response.page_info);
      const hasNextPage = boolean(
        pageInfo.has_next_page,
        "linear_page_info_invalid",
      );
      cursor = hasNextPage
        ? string(pageInfo.end_cursor, "linear_page_cursor_missing")
        : undefined;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error("linear_page_cursor_repeated");
        cursors.add(cursor);
      }
      yield { roots, hasNextPage, ordering: "unsupported" };
    } while (cursor);
    } finally {
      discovery.rootHeaderCount = rootCount;
      this.options.observeDiscovery?.({ ...discovery });
      this.#activeDiscovery = undefined;
    }
  }

  async readWorkflowIssueTree(rootIssueId: string): Promise<LinearWorkflowTreeSnapshot> {
    if (!this.#projectId) throw new Error("linear_project_not_resolved");
    const response = record(await this.#request({
      kind: "get_workflow_issue_tree",
      binding_id: this.#bindingId(),
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
    const response = record(await this.#request(workflowMutationBody(input, this.conductorShortHash, this.#bindingId())));
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
      if (body.kind === "list_root_issues") this.#activeDiscovery.listPageCount += 1;
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

  #bindingId(): string {
    return this.options.bindingId ?? "binding-1";
  }
}

function wireIssue(value: JsonValue | undefined): WireIssue {
  return record(value) as unknown as WireIssue;
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

function rootManagedConductorId(value: JsonValue | undefined, rootIssueId: string): string | undefined {
  if (value === undefined) return undefined;
  const comments = array(value, "linear_root_managed_comments_invalid");
  if (comments.length > 2) throw new Error("linear_root_managed_comments_invalid");
  let conductorId: string | undefined;
  for (const item of comments) {
    const comment = record(item);
    if (string(comment.issue_id, "linear_root_managed_comment_invalid") !== rootIssueId) {
      throw new Error("linear_root_managed_comment_scope_invalid");
    }
    if (comment.author_kind !== "symphony") continue;
    const body = string(comment.body, "linear_root_managed_comment_invalid");
    const parsed = parseManagedRecord(body);
    if (!parsed.ok || parsed.value.kind !== "root_ownership") continue;
    if (parsed.value.rootIssueId !== rootIssueId) throw new Error("linear_root_ownership_scope_invalid");
    if (conductorId !== undefined) throw new Error("linear_root_ownership_duplicate");
    conductorId = parsed.value.conductorId;
  }
  return conductorId;
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
      updated_at: string(issue.updated_at, "linear_workflow_issue_invalid"),
    };
  });
  const issues = rawIssues.map((issue) => {
    if (issue.issue_id === root) return { ...issue, issue_kind: "root" as const };
    const record = workflowIssueRecord(issue, root);
    return record === undefined ? issue : {
      ...issue,
      issue_kind: record.issueKind,
      workflow_issue_key: record.issueKey,
    };
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
  const comments = array(value.comments, "linear_workflow_comments_invalid").map((item) => {
    const comment = record(item);
    return {
      comment_id: string(comment.comment_id, "linear_workflow_comment_invalid"),
      issue_id: string(comment.issue_id, "linear_workflow_comment_invalid"),
      body: string(comment.body, "linear_workflow_comment_invalid"),
      author_kind: workflowCommentAuthorKind(comment.author_kind),
      author_id: string(comment.author_id, "linear_workflow_comment_invalid"),
      ...(comment.author_user_id === undefined ? {} : { author_user_id: string(comment.author_user_id, "linear_workflow_comment_invalid") }),
      created_at: string(comment.created_at, "linear_workflow_comment_invalid"),
      remote_version: string(comment.remote_version, "linear_workflow_comment_invalid"),
      updated_at: string(comment.updated_at, "linear_workflow_comment_invalid"),
    };
  });
  if (comments.length > 4_096) throw new Error("linear_workflow_comments_invalid");
  const commentIds = new Set<string>();
  for (const comment of comments) {
    if (commentIds.has(comment.comment_id) || !issueIds.has(comment.issue_id)) {
      throw new Error("linear_workflow_comment_invalid");
    }
    commentIds.add(comment.comment_id);
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
    source_manifest: sourceManifest,
    coverage,
    observed_at: string(value.observed_at, "linear_workflow_tree_invalid"),
  };
}

function workflowIssueRecord(
  issue: { issue_id: string; parent_issue_id?: string; description: string },
  rootIssueId: string,
): WorkflowIssueRecord | undefined {
  const parsed = parseManagedRecord(issue.description);
  if (!parsed.ok) {
    if (issue.description.includes("```symphony")) {
      throw new Error(`linear_workflow_issue_record_invalid:${parsed.error}`);
    }
    return undefined;
  }
  if (parsed.value.kind !== "workflow_issue") return undefined;
  if (
    parsed.value.rootIssueId !== rootIssueId ||
    parsed.value.parentIssueId !== issue.parent_issue_id
  ) {
    throw new Error("linear_workflow_issue_record_scope_invalid");
  }
  return parsed.value;
}

function workflowStatusCategory(value: JsonValue | undefined): LinearWorkflowTreeSnapshot["status_catalog"][number]["category"] {
  if (value === "backlog" || value === "unstarted" || value === "started" || value === "completed" || value === "canceled") return value;
  throw new Error("linear_workflow_status_category_invalid");
}

function workflowCommentAuthorKind(value: JsonValue | undefined): LinearWorkflowTreeSnapshot["comments"][number]["author_kind"] {
  if (value === "human" || value === "symphony" || value === "linear_integration" || value === "external_automation" || value === "unknown") return value;
  throw new Error("linear_workflow_comment_author_kind_invalid");
}

function workflowRelationKind(value: JsonValue | undefined): LinearWorkflowTreeSnapshot["relations"][number]["relation_kind"] {
  if (value === "blocks" || value === "blocked_by" || value === "relates_to" || value === "triggered_by") return value;
  throw new Error("linear_workflow_relation_kind_invalid");
}

function workflowSourceKind(value: JsonValue | undefined): LinearWorkflowTreeSnapshot["source_manifest"][number]["source_kind"] {
  if (value === "linear_issue" || value === "linear_comment" || value === "linear_relation" || value === "linear_status_catalog") return value;
  throw new Error("linear_workflow_source_manifest_invalid");
}

function protocolError(response: Record<string, JsonValue>): Error {
  const code = typeof response.code === "string" ? response.code : "private_protocol_unexpected_result";
  return new Error(code);
}

function workflowMutationBody(
  input: import("../api/LinearGatewayInterface.js").LinearWorkflowMutationCommand,
  conductorShortHash: string,
  bindingId: string,
): Record<string, JsonValue> {
  const common = {
    binding_id: bindingId,
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
    case "archive_workflow_issue":
    case "restore_workflow_issue":
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
            ...(input.order === undefined ? {} : { order: input.order }),
          }
          : input.kind === "append_workflow_comment" ? { body: input.body } : {}),
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
      };
    case "remove_workflow_relation":
      return {
        ...common,
        kind: input.kind,
        relation_id: input.relationId,
        source_issue_id: input.sourceIssueId,
        source_expected_remote_version: input.sourceExpectedRemoteVersion,
        target_issue_id: input.targetIssueId,
        target_expected_remote_version: input.targetExpectedRemoteVersion,
        relation_kind: input.relationKind,
      };
  }
}

function workflowMutationReadBack(value: JsonValue | undefined) {
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
  return {
    writeId: string(readBack.write_id, "linear_workflow_read_back_invalid"),
    targetIssueId: string(readBack.target_issue_id, "linear_workflow_read_back_invalid"),
    remoteVersion: string(readBack.remote_version, "linear_workflow_read_back_invalid"),
    ...(issueVersions ? { issueVersions } : {}),
  };
}
