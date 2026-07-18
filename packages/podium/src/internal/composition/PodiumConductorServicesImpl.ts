import type { JsonValue } from "../../public/DesktopViewInterface.js";
import type { PodiumConductorServices } from "../../public/PodiumConductorProtocolHandler.js";
import { LinearGatewayProtocolHandlerImpl } from "../linear-gateway/LinearGatewayProtocolHandlerImpl.js";
import type { LinearClientInterface } from "../linear-gateway/api/LinearClientInterface.js";
import type {
  LinearIssueState,
  LinearIssueValue,
  LinearMutationCommand,
} from "../linear-gateway/types.js";
import type { LinearInstallation } from "../models.js";
import type { PodiumConductorStoreInterface } from "./PodiumStoreInterfaces.js";

type Body = Record<string, JsonValue> & { kind: string };

export class PodiumConductorServicesImpl implements PodiumConductorServices {
  #activeInstanceId: string | undefined;

  constructor(
    private readonly store: PodiumConductorStoreInterface,
    private readonly options: {
      now(): string;
      sleep(delayMs: number): Promise<void>;
      createLinearSdk(installation: LinearInstallation): LinearClientInterface;
    },
  ) {}

  observeExit(input: {
    bindingId: string;
    instanceId: string;
    observedAt: string;
    sanitizedReason?: string;
  }): void {
    const binding = this.store.getConductorBinding();
    if (
      !binding ||
      binding.bindingId !== input.bindingId ||
      (this.#activeInstanceId !== undefined &&
        this.#activeInstanceId !== input.instanceId)
    ) {
      throw new Error("conductor_exit_observation_mismatch");
    }
    this.#activeInstanceId = undefined;
    this.store.saveRuntimeObservation({
      bindingId: binding.bindingId,
      status: "crashed",
      observedAt: input.observedAt,
      sanitizedSummary:
        input.sanitizedReason ?? "conductor_process_observed_exit",
    });
  }

  async handle(body: Body): Promise<JsonValue> {
    if (
      body.kind === "conductor_handshake" ||
      body.kind === "conductor_heartbeat" ||
      body.kind === "conductor_runtime_report"
    ) {
      return this.#runtime(body);
    }
    if (!this.#activeInstanceId) throw new Error("conductor_handshake_required");
    const binding = this.store.getConductorBinding();
    if (!binding) throw new Error("conductor_binding_missing");
    const installation = this.store.getLinearCredential(
      binding.linearInstallationId,
    );
    if (!installation) throw new Error("linear_installation_missing");
    const gateway = new LinearGatewayProtocolHandlerImpl(
      this.options.createLinearSdk(installation),
      {
        maxAttempts: 4,
        baseDelayMs: 250,
        sleep: this.options.sleep,
      },
    );
    switch (body.kind) {
      case "resolve_conductor_project":
        return this.#resolveProject(gateway, body);
      case "list_root_issues":
        return this.#listRoots(gateway, body);
      case "get_issue_tree":
        return this.#getTree(gateway, body);
      case "list_root_usage":
        return this.#listUsage(gateway, body);
      case "create_managed_node":
      case "update_managed_node":
      case "update_issue_state":
      case "reorder_issue_node":
      case "replace_root_phase_label":
      case "upsert_root_managed_comment":
        return mutationResult(
          await gateway.mutate(mutationCommand(body)),
        ) as unknown as JsonValue;
      default:
        throw new Error("conductor_request_unsupported");
    }
  }

  #runtime(body: Body): JsonValue {
    const binding = this.store.getConductorBinding();
    const instanceId = requiredString(
      body.instance_id,
      "conductor_instance_missing",
    );
    if (
      !binding ||
      body.binding_id !== binding.bindingId ||
      (body.kind === "conductor_handshake" &&
        (body.conductor_id !== binding.conductorId ||
          body.conductor_short_hash !== binding.conductorShortHash ||
          body.linear_installation_id !== binding.linearInstallationId ||
          body.organization_id !== binding.organizationId ||
          !matchesRepository(body.repository, binding.repositoryContext)))
    ) {
      throw new Error("conductor_handshake_mismatch");
    }
    if (body.kind === "conductor_handshake") {
      if (
        this.#activeInstanceId &&
        this.#activeInstanceId !== instanceId
      ) {
        throw new Error("conductor_instance_already_active");
      }
      this.#activeInstanceId = instanceId;
    } else if (this.#activeInstanceId !== instanceId) {
      throw new Error("conductor_instance_mismatch");
    }
    const status =
      body.kind === "conductor_runtime_report" && typeof body.status === "string"
        ? runtimeStatus(body.status)
        : body.kind === "conductor_handshake"
          ? "starting"
          : "ready";
    this.store.saveRuntimeObservation({
      bindingId: binding.bindingId,
      status,
      observedAt:
        typeof body.observed_at === "string"
          ? body.observed_at
          : typeof body.occurred_at === "string"
            ? body.occurred_at
            : this.options.now(),
      sanitizedSummary:
        typeof body.sanitized_summary === "string"
          ? body.sanitized_summary
          : `conductor_${status.replaceAll("-", "_")}`,
      ...(typeof body.current_project_id === "string"
        ? { lastResolvedProjectId: body.current_project_id }
        : {}),
    });
    return {
      kind: "conductor_runtime_report",
      binding_id: binding.bindingId,
      instance_id: instanceId,
      status,
      observed_at: this.options.now(),
    };
  }

  async #resolveProject(
    gateway: LinearGatewayProtocolHandlerImpl,
    body: Body,
  ): Promise<JsonValue> {
    const conductorShortHash = requiredString(
      body.conductor_short_hash,
      "conductor_short_hash_missing",
    );
    const resolution = await gateway.resolveProject(conductorShortHash);
    if (resolution.kind === "resolved") {
      const binding = this.store.getConductorBinding();
      if (!binding) throw new Error("conductor_binding_missing");
      const project = this.store.getProject(resolution.projectId);
      if (!project) throw new Error("linear_project_catalog_missing");
      return {
        kind: "resolved",
        resolved_project: {
          conductor_short_hash: conductorShortHash,
          project: {
            project_id: project.projectId,
            organization_id: project.organizationId,
            name: project.name,
            updated_at: resolution.updatedAt,
          },
        },
      };
    }
    if (resolution.kind === "unbound") return { kind: "unbound" };
    return failure(
      resolution.kind === "ambiguous"
        ? "conductor_project_ambiguous"
        : "conductor_project_label_conflict",
    );
  }

  async #listRoots(
    gateway: LinearGatewayProtocolHandlerImpl,
    body: Body,
  ): Promise<JsonValue> {
    const items = await gateway.listAllRootIssues(
      requiredString(body.project_id, "linear_project_id_missing"),
    );
    return {
      kind: "root_issues_page",
      items: items.map((root) => ({
        issue: issueSnapshot(root.issue),
        is_delegated_to_symphony: root.isDelegatedToSymphony,
      })),
      page_info: { has_next_page: false },
    };
  }

  async #getTree(
    gateway: LinearGatewayProtocolHandlerImpl,
    body: Body,
  ): Promise<JsonValue> {
    const tree = await gateway.getCompleteIssueTree(
      requiredString(body.project_id, "linear_project_id_missing"),
      requiredString(body.root_issue_id, "linear_root_issue_id_missing"),
    );
    return {
      kind: "issue_tree_page",
      tree: {
        root_issue_id: tree.rootIssueId,
        nodes: tree.nodes.map(issueSnapshot),
        root_phase_labels: tree.rootPhaseLabels,
        root_managed_comments: tree.rootManagedComments.map((comment) => ({
          comment_id: comment.commentId,
          issue_id: comment.issueId,
          body: comment.body,
          managed_marker: comment.managedMarker,
          updated_at: comment.updatedAt,
        })),
        human_answers: tree.humanAnswers.map((answer) => ({
          human_issue_id: answer.humanIssueId,
          comment_id: answer.commentId,
          answer: answer.answer,
          updated_at: answer.updatedAt,
        })),
        observed_at: tree.observedAt,
      },
      page_info: { has_next_page: false },
    };
  }

  async #listUsage(
    gateway: LinearGatewayProtocolHandlerImpl,
    body: Body,
  ): Promise<JsonValue> {
    const items = await gateway.listAllRootUsage(
      requiredString(body.project_id, "linear_project_id_missing"),
    );
    return {
      kind: "root_usage_page",
      items: items.map((usage) => ({
        root_issue_id: usage.rootIssueId,
        input_tokens: usage.inputTokens,
        cached_input_tokens: usage.cachedInputTokens,
        output_tokens: usage.outputTokens,
        reasoning_output_tokens: usage.reasoningOutputTokens,
        total_tokens: usage.totalTokens,
        observed_at: usage.observedAt,
      })),
      page_info: { has_next_page: false },
    };
  }
}

function matchesRepository(
  value: JsonValue | undefined,
  expected: {
    repositoryHandle: string;
    repositoryRoot: string;
    baseBranch: string;
  },
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    value.repository_handle === expected.repositoryHandle &&
    value.canonical_path === expected.repositoryRoot &&
    value.base_branch === expected.baseBranch
  );
}

function issueSnapshot(issue: LinearIssueValue) {
  if (
    issue.identifier === undefined ||
    issue.projectId === undefined ||
    issue.state === undefined ||
    issue.order === undefined ||
    issue.depth === undefined ||
    issue.title === undefined ||
    issue.description === undefined
  ) {
    throw new Error("linear_issue_snapshot_incomplete");
  }
  return {
    issue_id: issue.issueId,
    identifier: issue.identifier,
    project_id: issue.projectId,
    ...(issue.parentIssueId ? { parent_issue_id: issue.parentIssueId } : {}),
    state: issue.state,
    order: issue.order,
    depth: issue.depth,
    title: issue.title,
    description: issue.description,
    ...(issue.managedMarker ? { managed_marker: issue.managedMarker } : {}),
    ...(issue.nodeKind ? { node_kind: issue.nodeKind } : {}),
    ...(issue.humanKind ? { human_kind: issue.humanKind } : {}),
    ...(issue.origin ? { origin: issue.origin } : {}),
    ...(issue.completedInputHash
      ? { completed_input_hash: issue.completedInputHash }
      : {}),
    ...(issue.targetIssueId ? { target_issue_id: issue.targetIssueId } : {}),
    updated_at: issue.updatedAt,
  };
}

function requiredString(value: JsonValue | undefined, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function runtimeStatus(value: string) {
  if (
    value === "stopped" ||
    value === "starting" ||
    value === "ready" ||
    value === "recovering" ||
    value === "not-responding" ||
    value === "crashed" ||
    value === "unbound" ||
    value === "project-conflict"
  ) {
    return value;
  }
  throw new Error("conductor_runtime_status_invalid");
}

function failure(kind: string) {
  return {
    kind,
    error: {
      code: kind,
      category: "linear",
      sanitized_reason: kind,
      retryable: false,
      action_required: "block_root",
      next_action: "Resolve the Conductor Project label conflict in Linear.",
    },
  };
}

function mutationCommand(body: Body): LinearMutationCommand {
  const project = recordValue(body.project, "linear_project_precondition_invalid");
  const projectPrecondition = {
    conductorShortHash: requiredString(
      project.conductor_short_hash,
      "linear_conductor_short_hash_missing",
    ),
    expectedProjectId: requiredString(
      project.expected_project_id,
      "linear_expected_project_id_missing",
    ),
    expectedProjectUpdatedAt: requiredString(
      project.expected_project_updated_at,
      "linear_expected_project_updated_at_missing",
    ),
  };
  const common = { project: projectPrecondition };
  switch (body.kind) {
    case "create_managed_node":
      return {
        ...common,
        kind: body.kind,
        parentIssueId: requiredString(body.parent_issue_id, "linear_parent_issue_id_missing"),
        managedMarker: requiredString(body.managed_marker, "linear_managed_marker_missing"),
        nodeKind: requiredNodeKind(body.node_kind),
        ...(typeof body.human_kind === "string"
          ? { humanKind: requiredHumanKind(body.human_kind) }
          : {}),
        ...(typeof body.target_issue_id === "string"
          ? { targetIssueId: body.target_issue_id }
          : {}),
        order: requiredNumber(body.order, "linear_order_missing"),
        title: requiredString(body.title, "linear_title_missing"),
        description: requiredString(body.description, "linear_description_missing"),
      } as LinearMutationCommand;
    case "update_managed_node":
      return {
        ...common,
        kind: body.kind,
        precondition: remotePrecondition(body.precondition),
        nodeKind: requiredNodeKind(body.node_kind),
        ...(typeof body.human_kind === "string"
          ? { humanKind: requiredHumanKind(body.human_kind) }
          : {}),
        ...(typeof body.target_issue_id === "string"
          ? { targetIssueId: body.target_issue_id }
          : {}),
        ...(typeof body.completed_input_hash === "string"
          ? { completedInputHash: body.completed_input_hash }
          : {}),
        title: requiredString(body.title, "linear_title_missing"),
        description: requiredString(body.description, "linear_description_missing"),
      } as LinearMutationCommand;
    case "update_issue_state":
      return {
        ...common,
        kind: body.kind,
        precondition: remotePrecondition(body.precondition),
        state: requiredState(body.state),
      };
    case "reorder_issue_node":
      return {
        ...common,
        kind: body.kind,
        precondition: remotePrecondition(body.precondition),
        parentIssueId: requiredString(body.parent_issue_id, "linear_parent_issue_id_missing"),
        order: requiredNumber(body.order, "linear_order_missing"),
      };
    case "replace_root_phase_label":
      return {
        ...common,
        kind: body.kind,
        precondition: remotePrecondition(body.precondition),
        phase: requiredPhase(body.phase),
      };
    case "upsert_root_managed_comment":
      return {
        ...common,
        kind: body.kind,
        rootPrecondition: remotePrecondition(body.root_precondition),
        ...(body.comment_precondition
          ? { commentPrecondition: remotePrecondition(body.comment_precondition) }
          : {}),
        managedMarker: requiredString(body.managed_marker, "linear_managed_marker_missing"),
        body: requiredString(body.body, "linear_comment_body_missing"),
      };
  }
  throw new Error("linear_mutation_kind_unsupported");
}

function mutationResult(result: Awaited<ReturnType<LinearGatewayProtocolHandlerImpl["mutate"]>>) {
  if (result.kind === "failed") {
    return {
      kind: result.kind,
      error: {
        code: result.error.code,
        category: result.error.category,
        sanitized_reason: result.error.sanitizedReason,
        retryable: result.error.retryable,
        action_required: result.error.actionRequired,
        next_action: result.error.nextAction,
      },
    };
  }
  return {
    kind: result.kind,
    ...("issue" in result && result.issue
      ? { issue: issueSnapshot(result.issue) }
      : {}),
  };
}

function remotePrecondition(value: JsonValue | undefined) {
  const input = recordValue(value, "linear_remote_precondition_invalid");
  return {
    expectedIssueId: requiredString(input.expected_issue_id, "linear_expected_issue_id_missing"),
    expectedUpdatedAt: requiredString(input.expected_updated_at, "linear_expected_updated_at_missing"),
    ...(typeof input.expected_state === "string"
      ? { expectedState: requiredState(input.expected_state) }
      : {}),
    ...(typeof input.expected_parent_issue_id === "string"
      ? { expectedParentIssueId: input.expected_parent_issue_id }
      : {}),
    ...(typeof input.expected_managed_marker === "string"
      ? { expectedManagedMarker: input.expected_managed_marker }
      : {}),
  };
}

function recordValue(value: JsonValue | undefined, code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

function requiredNumber(value: JsonValue | undefined, code: string) {
  if (typeof value !== "number") throw new Error(code);
  return value;
}

function requiredNodeKind(value: JsonValue | undefined) {
  if (value === "work" || value === "human") return value;
  throw new Error("linear_node_kind_invalid");
}

function requiredHumanKind(value: string) {
  if (value === "plan_approval" || value === "planned_input" || value === "runtime_input") return value;
  throw new Error("linear_human_kind_invalid");
}

function requiredState(value: JsonValue | undefined): LinearIssueState {
  if (value === "Todo" || value === "In Progress" || value === "In Review" || value === "Done" || value === "Canceled") return value;
  throw new Error("linear_issue_state_invalid");
}

function requiredPhase(value: JsonValue | undefined) {
  if (
    value === "planning" || value === "awaiting-human" || value === "working" ||
    value === "gating" || value === "delivering" || value === "in-review" ||
    value === "blocked" || value === "failed"
  ) return value;
  throw new Error("linear_root_phase_invalid");
}
