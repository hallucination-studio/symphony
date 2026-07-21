import type { V3RuntimeGateway } from "../../composition/ConductorRuntime.js";
import type {
  LinearGatewayInterface,
  LinearRootScopeSnapshot,
  LinearWorkflowTreeSnapshot,
} from "../api/LinearGatewayInterface.js";
import type { PerformerProfileStoreInterface } from "../../performer-profiles/api/PerformerProfileStoreInterface.js";
import type {
  DiscoveredRoot,
  LinearIssueState,
  LinearPriority,
  V3RootRunView,
  WorkflowNode,
} from "../../root-workflow/api/Models.js";
import {
  parseV3RootManagedComment,
  serializeV3RootManagedComment,
} from "../../root-workflow/api/index.js";

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
  updated_at: string;
  node_kind?: "work" | "human";
  managed_marker?: string;
  human_kind?: "plan_approval" | "planned_input" | "runtime_input";
  origin?: "user" | "symphony";
  completed_input_hash?: string;
  target_issue_id?: string;
};

export class PodiumLinearGatewayClientImpl implements V3RuntimeGateway, LinearGatewayInterface {
  #sequence = 0;
  #projectId: string | undefined;
  #projectUpdatedAt: string | undefined;
  #activeDiscovery: {
    rootHeaderCount: number;
    listPageCount: number;
    getIssueTreeCount: number;
  } | undefined;
  readonly #rootBlockers = new Map<string, DiscoveredRoot["blockers"]>();

  constructor(
    private readonly conductorShortHash: string,
    private readonly protocol: ProtocolClient,
    private readonly profiles: PerformerProfileStoreInterface,
    private readonly options: {
      timeoutMs: number;
      conductorId?: string;
      observeDiscovery?(evidence: {
        rootHeaderCount: number;
        listPageCount: number;
        getIssueTreeCount: number;
      }): void;
      gitWorkspaceFacts?(input: {
        rootIssueId: string; rootIdentifier: string; branch: string;
      }): Promise<V3RootRunView["gitWorkspace"]>;
      profileReadiness(
        profileId: string,
      ): Promise<"login-required" | "ready" | "invalid">;
    },
  ) {}

  async resolveProject(): Promise<
    | { kind: "resolved"; projectId: string }
    | { kind: "unbound" | "ambiguous" | "label_conflict" }
  > {
    const response = record(
      await this.#request({
        kind: "resolve_conductor_project",
        conductor_short_hash: this.conductorShortHash,
      }),
    );
    if (response.kind === "unbound") return { kind: "unbound" };
    if (response.kind === "conductor_project_ambiguous") {
      return { kind: "ambiguous" };
    }
    if (response.kind === "conductor_project_label_conflict") {
      return { kind: "label_conflict" };
    }
    if (response.kind !== "resolved") throw protocolError(response);
    const resolved = record(response.resolved_project);
    const project = record(resolved.project);
    const projectId = string(project.project_id, "linear_project_id_invalid");
    this.#projectId = projectId;
    this.#projectUpdatedAt = string(
      project.updated_at,
      "linear_project_updated_at_invalid",
    );
    return { kind: "resolved", projectId };
  }

  profileReadiness(profileId: string) {
    return this.options.profileReadiness(profileId);
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
    const discovery = { rootHeaderCount: 0, listPageCount: 0, getIssueTreeCount: 0 };
    let rootCount = 0;
    this.#activeDiscovery = discovery;
    try {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = record(
        await this.#request({
          kind: "list_root_issues",
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
        const managed = v3ManagedCommentSnapshots(
          item.root_managed_comments,
          issue.issue_id,
        );
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
          ...(managed.comment
            ? { managedConductorId: managed.comment.conductorId }
            : {}),
        };
        roots.push(discovered);
        this.#rootBlockers.set(discovered.issueId, discovered.blockers);
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

  async reconstructV3(rootId: string): Promise<V3RootRunView> {
    const projectId = this.#projectId;
    const conductorId = this.options.conductorId;
    if (!projectId || !conductorId) throw new Error("linear_v3_runtime_not_configured");
    const state = await this.#v3ManagedState(projectId, rootId);
    const root = state.nodes.find(({ issue_id }) => issue_id === rootId);
    if (!root) throw new Error("linear_tree_root_missing");
    const profiles = await this.profiles.list();
    const profileId = state.managedComment?.performerProfileId
      ?? profiles.activeProfileId;
    const profile = profileId
      ? profiles.profiles.find(({ profileId: candidate }) => candidate === profileId)
      : undefined;
    const workflowNodes = state.nodes
      .filter(({ issue_id }) => issue_id !== rootId)
      .map((node) => workflowNode(node, rootId, state.humanAnswers.get(node.issue_id)));
    const gitWorkspace = state.managedComment && this.options.gitWorkspaceFacts
      ? await this.options.gitWorkspaceFacts({
          rootIssueId: rootId,
          rootIdentifier: root.identifier,
          branch: state.managedComment.deliveryBranch,
        })
      : undefined;
    return {
      root: rootIssue(root),
      conductorId,
      resolvedProjectId: projectId,
      ...(state.managedComment ? { managedComment: state.managedComment } : {}),
      ...(state.managedCommentRemote
        ? { managedCommentRemote: state.managedCommentRemote } : {}),
      ...(profile ? { profile: {
        profileId: profile.profileId,
        readiness: await this.options.profileReadiness(profile.profileId),
      } } : {}),
      workflowNodes,
      workflowTreeComplete: true,
      blockerRelations: this.#rootBlockers.get(rootId) ?? [],
      ...(gitWorkspace ? { gitWorkspace } : {}),
      attentionProblems: [],
    };
  }

  async readFreshRootScope(rootIssueId: string): Promise<LinearRootScopeSnapshot> {
    if (!this.#projectId) throw new Error("linear_project_not_resolved");
    const response = record(await this.#request({
      kind: "get_root_scope",
      project_id: this.#projectId,
      root_issue_id: rootIssueId,
    }));
    if (response.kind !== "root_scope") throw protocolError(response);
    const responseRootId = string(response.root_issue_id, "linear_root_scope_invalid");
    if (responseRootId !== rootIssueId) throw new Error("linear_root_scope_invalid");
    const issues = array(response.issues, "linear_root_scope_invalid").map((value) => {
      const issue = record(value);
      return {
        issue_id: string(issue.issue_id, "linear_root_scope_invalid"),
        identifier: string(issue.identifier, "linear_root_scope_invalid"),
        updated_at: string(issue.updated_at, "linear_root_scope_invalid"),
        ...(issue.parent_issue_id === undefined ? {} : {
          parent_issue_id: string(issue.parent_issue_id, "linear_root_scope_invalid"),
        }),
        ...(issue.state === undefined ? {} : {
          state: linearIssueState(issue.state),
        }),
        ...(issue.node_kind === undefined ? {} : {
          node_kind: rootScopeNodeKind(issue.node_kind),
        }),
        ...(issue.human_kind === undefined ? {} : {
          human_kind: rootScopeHumanKind(issue.human_kind),
        }),
      };
    });
    return {
      root_issue_id: rootIssueId,
      conductor_id: string(response.conductor_id, "linear_root_scope_invalid"),
      ...(response.performer_id === undefined ? {} : {
        performer_id: string(response.performer_id, "linear_root_scope_invalid"),
      }),
      terminal: boolean(response.terminal, "linear_root_scope_invalid"),
      issues,
    };
  }

  async readWorkflowIssueTree(rootIssueId: string): Promise<LinearWorkflowTreeSnapshot> {
    if (!this.#projectId) throw new Error("linear_project_not_resolved");
    const response = record(await this.#request({
      kind: "get_workflow_issue_tree",
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
    const response = record(await this.#request(workflowMutationBody(input, this.conductorShortHash)));
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

  async read(input: {
    rootIssueId: string; issueId: string; include: string[];
    scope: LinearRootScopeSnapshot;
    cursor?: string; limit?: number;
  }): Promise<JsonValue> {
    if (input.scope.root_issue_id !== input.rootIssueId) {
      throw new Error("linear_root_scope_invalid");
    }
    const issue = input.scope.issues.find(({ issue_id }) => issue_id === input.issueId);
    if (!issue) throw new Error("linear_target_out_of_scope");
    return {
      issue,
      ...(input.include.includes("children") ? {
        children: input.scope.issues.filter(({ parent_issue_id }) => parent_issue_id === input.issueId),
      } : {}),
    } as unknown as JsonValue;
  }

  async readRootContext(rootIssueId: string) {
    const view = await this.reconstructV3(rootIssueId);
    const section = (items: JsonValue[], cap: number) => ({
      items: items.slice(0, cap), cap, hasMore: items.length > cap, includeErrors: [],
    });
    return {
      root: section([view.root as unknown as JsonValue], 1),
      tree: section(view.workflowNodes as unknown as JsonValue[], 512),
      ancestors: section([], 32),
      comments: section([], 128),
      relations: section(view.blockerRelations as unknown as JsonValue[], 512),
    };
  }

  async compareAndSetClaim(input: {
    rootIssueId: string; resolvedProjectId: string; expectedRootUpdatedAt: string;
    expectedRootState: "Todo"; expectedManagedComment: "none";
    managedComment: import("../../root-workflow/api/Models.js").V3RootManagedComment;
  }) {
    this.#assertProject(input.resolvedProjectId);
    return mutationCas(await this.sendMutation({
      kind: "upsert_root_managed_comment", project: this.projectPrecondition(),
      root_precondition: { expected_issue_id: input.rootIssueId,
        expected_updated_at: input.expectedRootUpdatedAt,
        expected_state: input.expectedRootState },
      managed_marker: `${input.rootIssueId}:root-comment`,
      body: serializeV3RootManagedComment(input.managedComment),
    }));
  }

  async compareAndSetConversation(input: {
    rootIssueId: string; resolvedProjectId: string; expectedRootUpdatedAt: string;
    expectedCommentUpdatedAt: string; expectedPerformerId?: string; performerId: string;
  }) {
    return this.#replaceManagedComment(input, (managed) => ({ ...managed,
      performerId: input.performerId }));
  }

  async writeRetryBlock(input: {
    rootIssueId: string; resolvedProjectId: string; expectedRootUpdatedAt: string;
    expectedCommentUpdatedAt: string; expectedPerformerId?: string;
    retryBlock: import("../../root-workflow/api/Models.js").RootRetryBlock;
  }) {
    return this.#replaceManagedComment(input, (managed) => ({ ...managed,
      retryBlock: input.retryBlock }));
  }

  async clearRetryBlock(input: {
    rootIssueId: string; resolvedProjectId: string; expectedRootUpdatedAt: string;
    expectedCommentUpdatedAt: string; expectedPerformerId?: string;
    expectedFailureCode: string; expectedObservedAt: string;
  }) {
    return this.#replaceManagedComment(input, (managed) => {
      if (managed.retryBlock?.failureCode !== input.expectedFailureCode
        || managed.retryBlock.observedAt !== input.expectedObservedAt) {
        throw new Error("root_retry_acknowledgement_stale");
      }
      const next = { ...managed };
      delete next.retryBlock;
      return next;
    });
  }

  async appendRetryProblem(input: {
    rootIssueId: string; writeId: string; failureCode: string; observedAt: string;
  }) {
    const eventKey = `root-retry-${input.rootIssueId}:0`;
    await this.sendMutation({ kind: "project_root_comment",
      project: this.projectPrecondition(), root_issue_id: input.rootIssueId,
      event_key: eventKey,
      body: `Symphony Timeline\n${input.failureCode}\nObserved: ${input.observedAt}\n<!-- symphony turn event\nevent_key: ${eventKey}\n-->` });
  }

  async #replaceManagedComment(
    input: { rootIssueId: string; resolvedProjectId: string;
      expectedRootUpdatedAt: string; expectedCommentUpdatedAt: string;
      expectedPerformerId?: string },
    update: (managed: import("../../root-workflow/api/Models.js").V3RootManagedComment) =>
      import("../../root-workflow/api/Models.js").V3RootManagedComment,
  ) {
    this.#assertProject(input.resolvedProjectId);
    const current = await this.reconstructV3(input.rootIssueId);
    const managed = current.managedComment;
    const remote = current.managedCommentRemote;
    if (!managed || !remote || remote.updatedAt !== input.expectedCommentUpdatedAt
      || managed.performerId !== input.expectedPerformerId) return "conflict" as const;
    return mutationCas(await this.sendMutation({
      kind: "upsert_root_managed_comment", project: this.projectPrecondition(),
      root_precondition: { expected_issue_id: input.rootIssueId,
        expected_updated_at: input.expectedRootUpdatedAt },
      comment_precondition: { expected_issue_id: remote.commentId,
        expected_updated_at: remote.updatedAt,
        expected_managed_marker: `${input.rootIssueId}:root-comment` },
      managed_marker: `${input.rootIssueId}:root-comment`,
      body: serializeV3RootManagedComment(update(managed)),
    }));
  }

  async mutate(input: Parameters<LinearGatewayInterface["mutate"]>[0]) {
    const args = input.args;
    const project = this.projectPrecondition();
    const precondition = (issueId: string) => ({
      expected_issue_id: issueId,
      expected_updated_at: requiredString(args.expected_remote_version),
    });
    let command: JsonValue;
    if (input.command === "linear.issue.create_child") {
      const kind = requiredString(args.kind);
      command = { kind: "create_managed_node", project,
        parent_issue_id: requiredString(args.parent_issue_id),
        managed_marker: requiredString(args.write_id),
        node_kind: kind === "human" ? "human" : "work",
        ...(kind === "human" ? { human_kind: "plan_approval" } : {}),
        order: 0, title: requiredString(args.title),
        description: requiredString(args.description) };
    } else if (input.command === "linear.issue.update") {
      const issueId = requiredString(args.issue_id);
      const view = await this.reconstructV3(input.rootIssueId);
      const node = view.workflowNodes.find(({ issueId: candidate }) => candidate === issueId);
      if (!node?.managedMarker) return { kind: "rejected" as const,
        code: "linear_target_not_managed", summary: "Only managed workflow nodes can be updated." };
      command = { kind: "update_managed_node", project,
        precondition: { ...precondition(issueId), expected_managed_marker: node.managedMarker },
        node_kind: node.kind,
        ...(node.kind === "human" ? { human_kind: node.humanKind,
          ...(node.targetIssueId ? { target_issue_id: node.targetIssueId } : {}) } : {}),
        title: typeof args.title === "string" ? args.title : node.title,
        description: typeof args.description === "string" ? args.description : node.description };
    } else if (input.command === "linear.status.set") {
      command = { kind: "update_issue_state", project,
        precondition: precondition(requiredString(args.issue_id)),
        state: requiredString(args.status) };
    } else if (input.command === "linear.assignee.set") {
      command = { kind: "update_issue_assignee", project,
        precondition: precondition(requiredString(args.issue_id)),
        assignee_id: requiredString(args.assignee_id) };
    } else if (input.command === "linear.label.set") {
      command = { kind: "update_issue_label", project,
        precondition: precondition(requiredString(args.issue_id)),
        label: requiredString(args.label), operation: requiredString(args.operation) };
    } else if (input.command === "linear.comment.create") {
      const writeId = requiredString(args.write_id);
      command = { kind: "create_issue_comment", project,
        precondition: precondition(requiredString(args.issue_id)), write_id: writeId,
        body: `${requiredString(args.body)}\n\n<!-- symphony agent write\nwrite_id: ${writeId}\n-->` };
    } else {
      return { kind: "rejected" as const, code: "linear_command_unsupported",
        summary: "The requested Linear mutation is not supported." };
    }
    const result = await this.sendMutation(command);
    if (result.kind === "applied") return { kind: "applied" as const, summary: "Mutation applied." };
    if (result.kind === "already_applied") return { kind: "already_applied" as const, summary: "Mutation already applied." };
    if (result.kind === "linear_precondition_conflict") return { kind: "conflict" as const, summary: "Linear precondition changed." };
    if (result.kind === "write_unconfirmed") return {
      kind: "unconfirmed" as const, summary: "Mutation requires read-back.",
      read_back_target: input.command === "linear.comment.create"
        ? { kind: "comment_write" as const, issue_id: requiredString(args.issue_id),
          write_id: requiredString(args.write_id) }
        : { kind: "issue" as const,
          issue_id: requiredString(args.issue_id ?? args.parent_issue_id ?? input.rootIssueId) },
    };
    return { kind: "failed" as const, code: "linear_mutation_failed", summary: "Linear mutation failed." };
  }

  async #v3ManagedState(projectId: string, rootId: string) {
    const response = record(await this.#request({
      kind: "get_issue_tree", project_id: projectId,
      root_issue_id: rootId, page: { limit: 250 },
    }));
    if (response.kind !== "issue_tree_page") throw protocolError(response);
    const tree = record(response.tree);
    const managed = v3ManagedCommentSnapshots(tree.root_managed_comments, rootId);
    return {
      nodes: array(tree.nodes, "linear_tree_invalid").map(wireIssue),
      humanAnswers: new Map(array(tree.human_answers, "linear_human_answers_invalid").map(
        (value) => {
          const answer = record(value);
          return [string(answer.human_issue_id, "linear_human_answer_issue_invalid"),
            string(answer.answer, "linear_human_answer_invalid")] as const;
        },
      )),
      ...(managed.comment ? { managedComment: managed.comment } : {}),
      ...(managed.remote ? { managedCommentRemote: managed.remote } : {}),
    };
  }

  projectPrecondition() {
    if (!this.#projectId || !this.#projectUpdatedAt) {
      throw new Error("linear_project_not_resolved");
    }
    return {
      conductor_short_hash: this.conductorShortHash,
      expected_project_id: this.#projectId,
      expected_project_updated_at: this.#projectUpdatedAt,
    };
  }

  async sendMutation(body: JsonValue) {
    return record(await this.#request(body));
  }

  #request(body: JsonValue) {
    if (this.#activeDiscovery && body && typeof body === "object" && !Array.isArray(body)) {
      if (body.kind === "list_root_issues") this.#activeDiscovery.listPageCount += 1;
      if (body.kind === "get_issue_tree") this.#activeDiscovery.getIssueTreeCount += 1;
    }
    this.#sequence += 1;
    return this.protocol.request({
      requestId: `conductor-${this.#sequence}`,
      body,
      timeoutMs: this.options.timeoutMs,
    });
  }

  #assertProject(projectId: string) {
    if (this.#projectId !== projectId) {
      throw new Error("linear_project_resolution_changed");
    }
  }
}

function workflowNode(
  node: WireIssue,
  rootIssueId: string,
  answer?: string,
): WorkflowNode {
  if (node.node_kind === "human") {
    const targetIsInvalid = node.human_kind === "plan_approval"
      ? node.target_issue_id !== undefined
      : node.target_issue_id === undefined;
    if (
      !node.managed_marker ||
      !node.human_kind ||
      targetIsInvalid
    ) {
      throw new Error("human_managed_marker_invalid");
    }
    return {
      issueId: node.issue_id,
      identifier: node.identifier,
      parentIssueId:
        node.parent_issue_id === rootIssueId
          ? null
          : node.parent_issue_id ?? null,
      siblingOrder: node.order,
      kind: "human",
      humanKind: node.human_kind,
      state: node.state,
      title: node.title,
      description: node.description,
      updatedAt: node.updated_at,
      managedMarker: node.managed_marker,
      ...(node.target_issue_id
        ? { targetIssueId: node.target_issue_id }
        : {}),
      ...(answer ? { answer } : {}),
    };
  }
  const work: WorkflowNode = {
    issueId: node.issue_id,
    identifier: node.identifier,
    parentIssueId:
      node.parent_issue_id === rootIssueId
        ? null
        : node.parent_issue_id ?? null,
    siblingOrder: node.order,
    kind: "work",
    state: node.state,
    title: node.title,
    description: node.description,
    updatedAt: node.updated_at,
    ...(node.origin ? { origin: node.origin } : {}),
    ...(node.managed_marker
      ? { managedMarker: node.managed_marker }
      : {}),
    ...(node.completed_input_hash
      ? { completedInputHash: node.completed_input_hash }
      : {}),
  };
  return work;
}

function v3ManagedCommentSnapshots(value: JsonValue | undefined, rootIssueId: string) {
  const comments = array(value, "root_managed_comments_invalid");
  if (comments.length > 1) throw new Error("root_managed_comment_ambiguous");
  if (!comments[0]) return {};
  const snapshot = record(comments[0]);
  if (string(snapshot.issue_id, "root_managed_comment_issue_invalid") !== rootIssueId
    || string(snapshot.managed_marker, "root_managed_comment_marker_invalid")
      !== `${rootIssueId}:root-comment`) {
    throw new Error("root_managed_comment_identity_invalid");
  }
  const parsed = parseV3RootManagedComment(string(snapshot.body, "root_managed_comment_invalid"));
  if (!parsed.ok) throw new Error(parsed.error);
  return { comment: parsed.value, remote: {
    commentId: string(snapshot.comment_id, "root_managed_comment_id_invalid"),
    updatedAt: string(snapshot.updated_at, "root_managed_comment_updated_at_invalid"),
  } };
}

function rootIssue(issue: WireIssue) {
  return { issueId: issue.issue_id, identifier: issue.identifier, state: issue.state,
    title: issue.title, description: issue.description, updatedAt: issue.updated_at };
}

function requiredString(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error("linear_command_string_invalid");
  return value;
}

function wireIssue(value: JsonValue | undefined): WireIssue {
  const issue = record(value);
  return issue as unknown as WireIssue;
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
  const issues = array(value.issues, "linear_workflow_issues_invalid").map((item) => {
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
      ...(issue.managed_marker === undefined ? {} : { managed_marker: string(issue.managed_marker, "linear_workflow_issue_invalid") }),
      ...(issue.issue_kind === undefined ? {} : { issue_kind: workflowIssueKind(issue.issue_kind) }),
      remote_version: string(issue.remote_version, "linear_workflow_issue_invalid"),
      updated_at: string(issue.updated_at, "linear_workflow_issue_invalid"),
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
      ...(comment.managed_marker === undefined ? {} : { managed_marker: string(comment.managed_marker, "linear_workflow_comment_invalid") }),
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
    observed_at: string(value.observed_at, "linear_workflow_tree_invalid"),
  };
}

function workflowStatusCategory(value: JsonValue | undefined): LinearWorkflowTreeSnapshot["status_catalog"][number]["category"] {
  if (value === "backlog" || value === "unstarted" || value === "started" || value === "completed" || value === "canceled") return value;
  throw new Error("linear_workflow_status_category_invalid");
}

function workflowIssueKind(value: JsonValue | undefined): NonNullable<LinearWorkflowTreeSnapshot["issues"][number]["issue_kind"]> {
  if (value === "root" || value === "cycle" || value === "plan" || value === "work" || value === "verify" || value === "human") return value;
  throw new Error("linear_workflow_issue_kind_invalid");
}

function workflowRelationKind(value: JsonValue | undefined): LinearWorkflowTreeSnapshot["relations"][number]["relation_kind"] {
  if (value === "blocks" || value === "blocked_by" || value === "triggered_by") return value;
  throw new Error("linear_workflow_relation_kind_invalid");
}

function rootScopeNodeKind(value: JsonValue): "work" | "human" {
  if (value === "work" || value === "human") return value;
  throw new Error("linear_root_scope_invalid");
}

function rootScopeHumanKind(
  value: JsonValue,
): "plan_approval" | "planned_input" | "runtime_input" {
  if (value === "plan_approval" || value === "planned_input" || value === "runtime_input") {
    return value;
  }
  throw new Error("linear_root_scope_invalid");
}

function protocolError(response: Record<string, JsonValue>): Error {
  const code = typeof response.code === "string" ? response.code : "private_protocol_unexpected_result";
  return new Error(code);
}

function workflowMutationBody(
  input: import("../api/LinearGatewayInterface.js").LinearWorkflowMutationCommand,
  conductorShortHash: string,
): Record<string, JsonValue> {
  const common = {
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
        issue_kind: input.issueKind,
        title: input.title,
        description: input.description,
        status_id: input.statusId,
        managed_marker: input.managedMarker,
        ...(input.order === undefined ? {} : { order: input.order }),
      };
    case "update_workflow_issue":
    case "append_workflow_comment":
      return {
        ...common,
        kind: input.kind,
        target: {
          target_issue_id: input.target.targetIssueId,
          expected_remote_version: input.target.expectedRemoteVersion,
          ...(input.target.expectedStatusId === undefined ? {} : { expected_status_id: input.target.expectedStatusId }),
          ...(input.target.expectedParentIssueId === undefined ? {} : { expected_parent_issue_id: input.target.expectedParentIssueId }),
          ...(input.target.expectedManagedMarker === undefined ? {} : { expected_managed_marker: input.target.expectedManagedMarker }),
        },
        ...(input.kind === "update_workflow_issue"
          ? { status_id: input.statusId, title: input.title, description: input.description }
          : { body: input.body }),
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
  }
}

function workflowMutationReadBack(value: JsonValue | undefined) {
  const readBack = record(value);
  return {
    writeId: string(readBack.write_id, "linear_workflow_read_back_invalid"),
    targetIssueId: string(readBack.target_issue_id, "linear_workflow_read_back_invalid"),
    remoteVersion: string(readBack.remote_version, "linear_workflow_read_back_invalid"),
  };
}

function mutationCas(response: Record<string, JsonValue>): "applied" | "conflict" {
  return response.kind === "applied" || response.kind === "already_applied"
    ? "applied" : "conflict";
}
