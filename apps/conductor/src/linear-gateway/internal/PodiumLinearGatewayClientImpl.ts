import type { V3RuntimeGateway } from "../../composition/ConductorRuntime.js";
import type { LinearGatewayInterface, LinearRootScopeSnapshot } from "../api/LinearGatewayInterface.js";
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
  readonly #rootBlockers = new Map<string, DiscoveredRoot["blockers"]>();

  constructor(
    private readonly conductorShortHash: string,
    private readonly protocol: ProtocolClient,
    private readonly profiles: PerformerProfileStoreInterface,
    private readonly options: {
      timeoutMs: number;
      conductorId?: string;
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
    this.#assertProject(projectId);
    const roots: DiscoveredRoot[] = [];
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
        if (roots.length > 512) throw new Error("linear_roots_too_many");
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
    } while (cursor);
    return roots;
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
    const view = await this.reconstructV3(rootIssueId);
    return {
      root_issue_id: rootIssueId,
      conductor_id: view.managedComment?.conductorId ?? "unclaimed",
      ...(view.managedComment?.performerId
        ? { performer_id: view.managedComment.performerId } : {}),
      terminal: view.root.state === "Done" || view.root.state === "Canceled",
      issues: [{ issue_id: view.root.issueId, identifier: view.root.identifier,
        updated_at: view.root.updatedAt }, ...view.workflowNodes.map((issue) => ({
        issue_id: issue.issueId, identifier: issue.identifier,
        updated_at: issue.updatedAt,
        parent_issue_id: issue.parentIssueId ?? rootIssueId,
      }))],
    };
  }

  async read(input: {
    rootIssueId: string; issueId: string; include: string[];
    cursor?: string; limit?: number;
  }): Promise<JsonValue> {
    const scope = await this.readFreshRootScope(input.rootIssueId);
    const issue = scope.issues.find(({ issue_id }) => issue_id === input.issueId);
    if (!issue) throw new Error("linear_target_out_of_scope");
    return { issue, include: input.include.slice(0, 16) } as unknown as JsonValue;
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
    if (input.command === "linear.status.set") {
      command = { kind: "update_issue_state", project,
        precondition: precondition(requiredString(args.issue_id)),
        state: requiredString(args.status) };
    } else if (input.command === "linear.comment.create") {
      command = { kind: "project_root_comment", project,
        root_issue_id: input.rootIssueId,
        event_key: `${requiredString(args.write_id)}:0`,
        body: `${requiredString(args.body)}\n\n<!-- symphony turn event\nevent_key: ${requiredString(args.write_id)}:0\n-->` };
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
      read_back_target: { kind: "issue" as const, issue_id: requiredString(args.issue_id ?? input.rootIssueId) },
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

function protocolError(response: Record<string, JsonValue>): Error {
  const code = typeof response.code === "string" ? response.code : "private_protocol_unexpected_result";
  return new Error(code);
}

function mutationCas(response: Record<string, JsonValue>): "applied" | "conflict" {
  return response.kind === "applied" || response.kind === "already_applied"
    ? "applied" : "conflict";
}
