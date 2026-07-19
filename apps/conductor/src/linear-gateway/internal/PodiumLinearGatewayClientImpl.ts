import type { RuntimeGateway } from "../../composition/ConductorRuntime.js";
import type { PerformerProfileStoreInterface } from "../../performer-profiles/api/PerformerProfileStoreInterface.js";
import type {
  DiscoveredRoot,
  LinearIssueState,
  LinearPriority,
  RootPhase,
  RootRunView,
  WorkflowNode,
} from "../../root-workflow/api/Models.js";
import {
  hashWorkInput,
  parseRootManagedComment,
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

export class PodiumLinearGatewayClientImpl implements RuntimeGateway {
  #sequence = 0;
  #projectId: string | undefined;
  #projectUpdatedAt: string | undefined;

  constructor(
    private readonly conductorShortHash: string,
    private readonly protocol: ProtocolClient,
    private readonly profiles: PerformerProfileStoreInterface,
    private readonly options: {
      timeoutMs: number;
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
        const managed = managedCommentSnapshots(
          item.root_managed_comments,
          issue.issue_id,
        );
        roots.push({
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
        });
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

  async reconstruct(rootId: string): Promise<RootRunView> {
    const projectId = this.#projectId;
    if (!projectId) throw new Error("linear_project_not_resolved");
    const state = await this.#managedState(projectId, rootId);
    const root = state.nodes.find(({ issue_id }) => issue_id === rootId);
    if (!root) throw new Error("linear_tree_root_missing");
    const profileId = state.managedComment?.performerProfileId;
    const profileFile = await this.profiles.list();
    const profile = profileId
      ? profileFile.profiles.find(({ profileId: candidate }) => candidate === profileId)
      : undefined;
    const workflowNodes = state.nodes
      .filter(({ issue_id }) => issue_id !== rootId)
      .map((node) =>
        workflowNode(
          node,
          rootId,
          state.humanAnswers.get(node.issue_id),
        ),
      );
    for (const work of workflowNodes.filter(
      (node): node is WorkflowNode & { kind: "work" } => node.kind === "work",
    )) {
      work.currentInputHash = hashWorkInput(
        { title: root.title, description: root.description },
        {
          identifier: work.identifier,
          title: work.title,
          description: work.description,
          humanInputs: workflowNodes
            .filter(
              (node) =>
                node.kind === "human" && node.targetIssueId === work.issueId,
            )
            .map((node) => ({
              issueId: node.issueId,
              status: node.state === "Canceled" ? "canceled" : "answered",
              ...(node.answer ? { answer: node.answer } : {}),
            })),
          isLeaf: !workflowNodes.some(
            ({ parentIssueId }) => parentIssueId === work.issueId,
          ),
        },
      );
    }
    return {
      root: {
        issueId: root.issue_id,
        identifier: root.identifier,
        state: root.state,
        title: root.title,
        description: root.description,
        updatedAt: root.updated_at,
      },
      conductorId: state.managedComment?.conductorId ?? "unclaimed",
      resolvedProjectId: projectId,
      phaseLabels: state.phaseLabels,
      ...(state.managedComment
        ? { managedComment: state.managedComment }
        : {}),
      ...(state.managedCommentRemote
        ? { managedCommentRemote: state.managedCommentRemote }
        : {}),
      ...(profile
        ? {
            profile: {
              profileId: profile.profileId,
              readiness: await this.options.profileReadiness(profile.profileId),
            },
          }
        : {}),
      workflowNodes,
    };
  }

  async #managedState(projectId: string, rootId: string) {
    const response = record(
      await this.#request({
        kind: "get_issue_tree",
        project_id: projectId,
        root_issue_id: rootId,
        page: { limit: 250 },
      }),
    );
    if (response.kind !== "issue_tree_page") throw protocolError(response);
    const tree = record(response.tree);
    const managed = managedCommentSnapshots(
      tree.root_managed_comments,
      rootId,
    );
    const phases = array(tree.root_phase_labels, "root_phase_labels_invalid");
    if (phases.length > 1) throw new Error("root_phase_ambiguous");
    return {
      nodes: array(tree.nodes, "linear_tree_invalid").map(wireIssue),
      humanAnswers: new Map(
        array(tree.human_answers, "linear_human_answers_invalid").map(
          (value) => {
            const answer = record(value);
            return [
              string(
                answer.human_issue_id,
                "linear_human_answer_issue_invalid",
              ),
              string(answer.answer, "linear_human_answer_invalid"),
            ];
          },
        ),
      ),
      phaseLabels: phases.map(rootPhase),
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

  async mutate(body: JsonValue) {
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

function managedCommentSnapshots(
  value: JsonValue | undefined,
  rootIssueId: string,
) {
  const comments = array(value, "root_managed_comments_invalid");
  if (comments.length > 1) throw new Error("root_managed_comment_ambiguous");
  if (!comments[0]) return {};
  const snapshot = record(comments[0]);
  if (
    string(snapshot.issue_id, "root_managed_comment_issue_invalid") !== rootIssueId ||
    string(snapshot.managed_marker, "root_managed_comment_marker_invalid") !==
      `${rootIssueId}:root-comment`
  ) {
    throw new Error("root_managed_comment_identity_invalid");
  }
  const parsed = parseRootManagedComment(
    string(snapshot.body, "root_managed_comment_invalid"),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    comment: parsed.value,
    remote: {
      commentId: string(
        snapshot.comment_id,
        "root_managed_comment_id_invalid",
      ),
      updatedAt: string(
        snapshot.updated_at,
        "root_managed_comment_updated_at_invalid",
      ),
    },
  };
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

function rootPhase(value: JsonValue): RootPhase {
  if (
    value === "planning" || value === "awaiting-human" || value === "working" ||
    value === "gating" || value === "delivering" || value === "in-review" ||
    value === "blocked" || value === "failed"
  ) return value;
  throw new Error("root_phase_invalid");
}

function protocolError(response: Record<string, JsonValue>): Error {
  const code = typeof response.code === "string" ? response.code : "private_protocol_unexpected_result";
  return new Error(code);
}
