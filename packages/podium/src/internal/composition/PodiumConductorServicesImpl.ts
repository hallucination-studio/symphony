import type { JsonValue } from "../../public/DesktopViewInterface.js";
import type { ConductorPresence } from "../../public/ConductorPresence.js";
import type { PodiumConductorServices } from "../../public/PodiumConductorProtocolHandler.js";
import { LinearGatewayProtocolHandlerImpl } from "../linear-gateway/LinearGatewayProtocolHandlerImpl.js";
import type { LinearClientInterface } from "../linear-gateway/api/LinearClientInterface.js";
import {
  LinearRequestBrokerImpl,
  type InstallationRequestClass,
} from "../linear-gateway/internal/LinearRequestBrokerImpl.js";
import type { LinearRequestObserverImpl } from "../linear-gateway/internal/LinearRequestObserverImpl.js";
import type { LinearPhysicalRequestObservation } from "../linear-gateway/internal/LinearSdkImpl.js";
import type {
  LinearIssueState,
  LinearIssueValue,
  LinearMutationCommand,
  WorkflowMutationCommand,
} from "../linear-gateway/types.js";
import type { LinearInstallation } from "../models.js";
import type { PodiumConductorStoreInterface } from "./PodiumStoreInterfaces.js";

type Body = Record<string, JsonValue> & { kind: string };

const MAX_LINEAR_REQUEST_TIMEOUT_MS = 5 * 60_000;

export class PodiumConductorServicesImpl implements PodiumConductorServices {
  readonly #activeInstances = new Map<string, string>();
  readonly #linearRequests: LinearRequestBrokerImpl;
  readonly #linearGateways = new Map<InstallationRequestClass, {
    installation: LinearInstallation;
    gateway: LinearGatewayProtocolHandlerImpl;
  }>();

  constructor(
    private readonly store: PodiumConductorStoreInterface,
    private readonly presence: ConductorPresence,
    private readonly options: {
      now(): string;
      sleep(delayMs: number): Promise<void>;
      createLinearSdk(
        installation: LinearInstallation,
        observe: (observation: LinearPhysicalRequestObservation) => void,
      ): LinearClientInterface;
      linearRequestObserver?: LinearRequestObserverImpl;
    },
  ) {
    this.#linearRequests = new LinearRequestBrokerImpl({
      maxConcurrent: 8,
      maxHighPriorityBurst: 4,
      ...(this.options.linearRequestObserver ? { observer: this.options.linearRequestObserver } : {}),
    });
  }

  observeExit(input: {
    bindingId: string;
    instanceId: string;
    observedAt: string;
    sanitizedReason?: string;
  }): void {
    const binding = this.#bindingForId(input.bindingId);
    const activeInstanceId = this.#activeInstances.get(input.bindingId);
    if (
      !binding ||
      (activeInstanceId !== undefined && activeInstanceId !== input.instanceId)
    ) {
      throw new Error("conductor_exit_observation_mismatch");
    }
    this.#activeInstances.delete(input.bindingId);
    this.presence.observeOffline({
      bindingId: binding.bindingId,
      observedAt: input.observedAt,
      ...(input.sanitizedReason ? { sanitizedError: input.sanitizedReason } : {}),
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
    const binding = this.#requestBinding(body);
    if (!this.#activeInstances.has(binding.bindingId)) {
      throw new Error("conductor_handshake_required");
    }
    const installation = this.store.getLinearCredential(
      binding.linearInstallationId,
    );
    if (!installation) throw new Error("linear_installation_missing");
    const classification = requestClass(body.kind);
    const gateway = this.#linearGateway(installation, classification);
    return this.#linearRequests.run(classification, async () => {
      switch (body.kind) {
      case "resolve_conductor_project":
        return this.#resolveProject(gateway, body);
      case "list_root_issues":
        return this.#listRoots(gateway, body);
      case "get_issue_tree":
        return this.#getTree(gateway, body);
      case "get_workflow_issue_tree":
        return this.#getWorkflowTree(gateway, body);
      case "list_root_usage":
        return this.#listUsage(gateway, body);
      case "create_managed_node":
      case "update_managed_node":
      case "update_issue_state":
      case "update_issue_assignee":
      case "update_issue_label":
      case "create_issue_comment":
      case "reorder_issue_node":
      case "replace_root_phase_label":
      case "upsert_root_managed_comment":
      case "project_root_comment":
        return mutationResult(
          await gateway.mutate(mutationCommand(body)),
        ) as unknown as JsonValue;
      case "create_workflow_issue":
      case "update_workflow_issue":
      case "append_workflow_comment":
      case "create_workflow_relation":
        return workflowMutationResult(
          await gateway.mutateWorkflow(workflowMutationCommand(body)),
        ) as unknown as JsonValue;
      default:
        throw new Error("conductor_request_unsupported");
      }
    }, {
      deadlineAtMs: Date.now() + MAX_LINEAR_REQUEST_TIMEOUT_MS,
      ...(classification === "mutation" ? {} : {
        coalesceKey: JSON.stringify(body),
      }),
    });
  }

  #linearGateway(
    installation: LinearInstallation,
    classification: InstallationRequestClass,
  ): LinearGatewayProtocolHandlerImpl {
    const current = this.#linearGateways.get(classification);
    if (current && sameInstallation(current.installation, installation)) {
      return current.gateway;
    }
    if ([...this.#linearGateways.values()].some(({ installation: cached }) =>
      !sameInstallation(cached, installation))) {
      this.#linearGateways.clear();
    }
    const gateway = new LinearGatewayProtocolHandlerImpl(
      this.options.createLinearSdk(installation, (observation) => {
        this.#linearRequests.observe(observation);
      }),
      {
        maxAttempts: 4,
        baseDelayMs: 250,
        maxDelayMs: 30_000,
        random: Math.random,
        sleep: this.options.sleep,
      },
    );
    this.#linearGateways.set(classification, { installation, gateway });
    return gateway;
  }

  #runtime(body: Body): JsonValue {
    const bindingId = requiredString(body.binding_id, "conductor_binding_missing");
    const binding = this.#bindingForId(bindingId);
    const instanceId = requiredString(
      body.instance_id,
      "conductor_instance_missing",
    );
    if (
      !binding ||
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
      const activeInstanceId = this.#activeInstances.get(bindingId);
      if (activeInstanceId && activeInstanceId !== instanceId) {
        throw new Error("conductor_instance_already_active");
      }
      this.#activeInstances.set(bindingId, instanceId);
    } else if (this.#activeInstances.get(bindingId) !== instanceId) {
      throw new Error("conductor_instance_mismatch");
    }
    const observedAt =
      typeof body.observed_at === "string"
        ? body.observed_at
        : typeof body.occurred_at === "string"
          ? body.occurred_at
          : this.options.now();
    const sanitizedSummary =
      typeof body.sanitized_summary === "string"
        ? body.sanitized_summary
        : body.kind === "conductor_handshake"
          ? "Conductor private channel connected."
          : "Conductor private channel heartbeat received.";
    this.presence.observeOnline({
      bindingId: binding.bindingId,
      observedAt,
      protocolVersion: "1",
      ...(body.kind === "conductor_runtime_report" ? { summary: sanitizedSummary } : {}),
    });
    return {
      kind: "conductor_runtime_report",
      binding_id: binding.bindingId,
      instance_id: instanceId,
      status: "ready",
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
      const binding = this.#requestBinding(body);
      if (binding.conductorShortHash !== conductorShortHash) {
        throw new Error("conductor_binding_mismatch");
      }
      const project = this.store.getProject(resolution.projectId);
      if (!project) throw new Error("linear_project_catalog_missing");
      return {
        kind: "resolved",
        resolved_project: {
          conductor_short_hash: conductorShortHash,
          conductor_pool: resolution.conductorPool.map(({ conductorShortHash: hash }) => ({
            conductor_short_hash: hash,
          })),
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
    const pageRequest = recordValue(body.page, "linear_page_missing");
    const limit = requiredNumber(pageRequest.limit, "linear_page_limit_missing");
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
      throw new Error("linear_page_limit_invalid");
    }
    const page = await gateway.listRootIssuesPage({
      projectId: requiredString(body.project_id, "linear_project_id_missing"),
      limit,
      ...(typeof pageRequest.cursor === "string"
        ? { cursor: pageRequest.cursor }
        : {}),
    });
    return {
      kind: "root_issues_page",
      items: page.items.map((root) => ({
        issue: issueSnapshot(root.issue),
        is_delegated_to_symphony: root.isDelegatedToSymphony,
        priority: root.priority,
        blockers: root.blockers.map((blocker) => ({
          source_issue_id: blocker.sourceIssueId,
          target_issue_id: blocker.targetIssueId,
          target_state: blocker.targetState,
        })),
        root_conductor_labels: root.rootConductorLabels.map(({ conductorShortHash }) => ({
          conductor_short_hash: conductorShortHash,
        })),
        root_managed_comments: root.rootManagedComments.map((comment) => ({
          comment_id: comment.commentId,
          issue_id: comment.issueId,
          body: comment.body,
          managed_marker: comment.managedMarker,
          updated_at: comment.updatedAt,
        })),
      })),
      page_info: {
        has_next_page: page.pageInfo.hasNextPage,
        ...(page.pageInfo.endCursor
          ? { end_cursor: page.pageInfo.endCursor }
          : {}),
      },
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
        root_conductor_labels: tree.rootConductorLabels.map(({ conductorShortHash }) => ({
          conductor_short_hash: conductorShortHash,
        })),
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

  async #getWorkflowTree(
    gateway: LinearGatewayProtocolHandlerImpl,
    body: Body,
  ): Promise<JsonValue> {
    const conductorShortHash = requiredString(
      body.conductor_short_hash,
      "linear_conductor_short_hash_missing",
    );
    const binding = this.#requestBinding(body);
    if (!binding || binding.conductorShortHash !== conductorShortHash) {
      throw new Error("linear_conductor_short_hash_mismatch");
    }
    const tree = await gateway.getWorkflowIssueTree(
      requiredString(body.expected_project_id, "linear_project_id_missing"),
      requiredString(body.root_issue_id, "linear_root_issue_id_missing"),
    );
    return {
      kind: "workflow_issue_tree",
      tree: {
        root_issue_id: tree.rootIssueId,
        status_catalog: tree.statusCatalog.map((status) => ({
          status_id: status.statusId,
          name: status.name,
          category: status.category,
          position: status.position,
        })),
        issues: tree.issues.map((issue) => ({
          issue_id: issue.issueId,
          identifier: issue.identifier,
          project_id: issue.projectId,
          ...(issue.parentIssueId ? { parent_issue_id: issue.parentIssueId } : {}),
          status_id: issue.statusId,
          status_name: issue.statusName,
          status_category: issue.statusCategory,
          status_position: issue.statusPosition,
          order: issue.order,
          depth: issue.depth,
          title: issue.title,
          description: issue.description,
          ...(issue.managedMarker ? { managed_marker: issue.managedMarker } : {}),
          ...(issue.issueKind ? { issue_kind: issue.issueKind } : {}),
          remote_version: issue.remoteVersion,
          updated_at: issue.updatedAt,
        })),
        comments: tree.comments.map((comment) => ({
          comment_id: comment.commentId,
          issue_id: comment.issueId,
          body: comment.body,
          ...(comment.managedMarker ? { managed_marker: comment.managedMarker } : {}),
          remote_version: comment.remoteVersion,
          updated_at: comment.updatedAt,
        })),
        relations: tree.relations.map((relation) => ({
          relation_id: relation.relationId,
          relation_kind: relation.relationKind,
          source_issue_id: relation.sourceIssueId,
          target_issue_id: relation.targetIssueId,
        })),
        observed_at: tree.observedAt,
      },
    };
  }

  #requestBinding(body: Body) {
    const requestedId = typeof body.binding_id === "string"
      ? body.binding_id
      : undefined;
    if (requestedId) {
      const binding = this.#bindingForId(requestedId);
      if (!binding) throw new Error("conductor_binding_missing");
      return binding;
    }
    const requestedHash = typeof body.conductor_short_hash === "string"
      ? body.conductor_short_hash
      : typeof body.project === "object" && body.project !== null && !Array.isArray(body.project) &&
          typeof body.project.conductor_short_hash === "string"
        ? body.project.conductor_short_hash
        : undefined;
    if (!requestedHash && this.#activeInstances.size === 1) {
      return this.#bindingForId([...this.#activeInstances.keys()][0]!)!;
    }
    if (!requestedHash) throw new Error("conductor_binding_missing");
    const candidates = this.#allBindings().filter(
      ({ conductorShortHash }) => conductorShortHash === requestedHash,
    );
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) throw new Error("conductor_binding_ambiguous");
    throw new Error("conductor_binding_missing");
  }

  #bindingForId(bindingId: string) {
    const store = this.store as PodiumConductorStoreInterface & {
      getConductorBindingById?: (id: string) => ReturnType<PodiumConductorStoreInterface["getConductorBinding"]>;
      listConductorBindings?: () => ReturnType<PodiumConductorStoreInterface["getConductorBinding"]>[];
    };
    const byId = store.getConductorBindingById?.(bindingId);
    if (byId) return byId;
    const listed = store.listConductorBindings?.().find(({ bindingId: id }) => id === bindingId);
    if (listed) return listed;
    const legacy = store.getConductorBinding();
    return legacy?.bindingId === bindingId ? legacy : undefined;
  }

  #allBindings() {
    const store = this.store as PodiumConductorStoreInterface & {
      listConductorBindings?: () => ReturnType<PodiumConductorStoreInterface["getConductorBinding"]>[];
    };
    const listed = store.listConductorBindings?.();
    return listed ?? (store.getConductorBinding() ? [store.getConductorBinding()!] : []);
  }

}

function sameInstallation(left: LinearInstallation, right: LinearInstallation): boolean {
  return left.kind === right.kind &&
    left.installationId === right.installationId &&
    left.organizationId === right.organizationId &&
    left.accessToken === right.accessToken &&
    (left.kind === "oauth" && right.kind === "oauth"
      ? left.refreshToken === right.refreshToken && left.expiresAt === right.expiresAt
      : left.kind === "development_token" && right.kind === "development_token" &&
        left.delegateActorId === right.delegateActorId);
}

function requestClass(kind: string): InstallationRequestClass {
  if (kind === "resolve_conductor_project") return "control";
  if (
    kind === "get_issue_tree" ||
    kind === "get_workflow_issue_tree" ||
    kind === "list_root_issues"
  ) return "workflow";
  if (kind === "list_root_usage") return "background";
  return "mutation";
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
    case "update_issue_assignee":
      return {
        ...common, kind: body.kind, precondition: remotePrecondition(body.precondition),
        assigneeId: requiredString(body.assignee_id, "linear_assignee_id_missing"),
      };
    case "update_issue_label":
      return {
        ...common, kind: body.kind, precondition: remotePrecondition(body.precondition),
        label: requiredString(body.label, "linear_label_missing"),
        operation: requiredLabelOperation(body.operation),
      };
    case "create_issue_comment":
      return {
        ...common, kind: body.kind, precondition: remotePrecondition(body.precondition),
        writeId: requiredString(body.write_id, "linear_write_id_missing"),
        body: requiredString(body.body, "linear_comment_body_missing"),
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
    case "project_root_comment":
      return {
        ...common,
        kind: body.kind,
        rootIssueId: requiredString(body.root_issue_id, "linear_root_issue_id_missing"),
        ...rootCommentIdentity(body),
        body: requiredString(body.body, "linear_comment_body_missing"),
      };
  }
  throw new Error("linear_mutation_kind_unsupported");
}

function workflowMutationCommand(body: Body): WorkflowMutationCommand {
  const target = body.target === undefined ? undefined : recordValue(body.target, "linear_workflow_target_invalid");
  const common = {
    writeId: requiredString(body.write_id, "linear_workflow_write_id_missing"),
    conductorShortHash: requiredString(body.conductor_short_hash, "linear_conductor_short_hash_missing"),
    expectedProjectId: requiredString(body.expected_project_id, "linear_expected_project_id_missing"),
    rootIssueId: requiredString(body.root_issue_id, "linear_root_issue_id_missing"),
    expectedRootRemoteVersion: requiredString(body.expected_root_remote_version, "linear_root_version_missing"),
  };
  if (body.kind === "create_workflow_issue") {
    return {
      ...common,
      kind: body.kind,
      parentExpectedRemoteVersion: requiredString(body.parent_expected_remote_version, "linear_workflow_parent_version_missing"),
      parentExpectedStatusId: requiredString(body.parent_expected_status_id, "linear_workflow_parent_status_missing"),
      parentIssueId: requiredString(body.parent_issue_id, "linear_workflow_parent_id_missing"),
      issueKind: workflowIssueKind(body.issue_kind),
      title: requiredString(body.title, "linear_workflow_title_missing"),
      description: requiredString(body.description, "linear_workflow_description_missing"),
      statusId: requiredString(body.status_id, "linear_workflow_status_id_missing"),
      managedMarker: requiredString(body.managed_marker, "linear_workflow_marker_missing"),
      ...(body.order === undefined ? {} : { order: requiredNumber(body.order, "linear_workflow_order_invalid") }),
    };
  }
  if (body.kind === "create_workflow_relation") {
    return {
      ...common,
      kind: body.kind,
      sourceIssueId: requiredString(body.source_issue_id, "linear_workflow_source_id_missing"),
      sourceExpectedRemoteVersion: requiredString(body.source_expected_remote_version, "linear_workflow_source_version_missing"),
      targetIssueId: requiredString(body.target_issue_id, "linear_workflow_target_id_missing"),
      targetExpectedRemoteVersion: requiredString(body.target_expected_remote_version, "linear_workflow_target_version_missing"),
      relationKind: workflowRelationKind(body.relation_kind),
    };
  }
  if (!target) throw new Error("linear_workflow_target_missing");
  const targetValue = {
    targetIssueId: requiredString(target.target_issue_id, "linear_workflow_target_id_missing"),
    expectedRemoteVersion: requiredString(target.expected_remote_version, "linear_workflow_target_version_missing"),
    ...(target.expected_status_id === undefined ? {} : { expectedStatusId: requiredString(target.expected_status_id, "linear_workflow_target_status_invalid") }),
    ...(target.expected_parent_issue_id === undefined ? {} : { expectedParentIssueId: requiredString(target.expected_parent_issue_id, "linear_workflow_target_parent_invalid") }),
    ...(target.expected_managed_marker === undefined ? {} : { expectedManagedMarker: requiredString(target.expected_managed_marker, "linear_workflow_target_marker_invalid") }),
  };
  if (body.kind === "update_workflow_issue") {
    return {
      ...common, kind: body.kind, target: targetValue,
      statusId: requiredString(body.status_id, "linear_workflow_status_id_missing"),
      title: requiredString(body.title, "linear_workflow_title_missing"),
      description: requiredString(body.description, "linear_workflow_description_missing"),
    };
  }
  if (body.kind === "append_workflow_comment") {
    return { ...common, kind: body.kind, target: targetValue,
      body: requiredString(body.body, "linear_workflow_comment_body_missing") };
  }
  throw new Error("linear_workflow_kind_unsupported");
}

function rootCommentIdentity(body: Body):
  | { commentId: string; eventKey?: never }
  | { eventKey: string; commentId?: never } {
  const hasCommentId = body.comment_id !== undefined;
  const hasEventKey = body.event_key !== undefined;
  if (hasCommentId === hasEventKey) {
    throw new Error("linear_root_comment_identity_invalid");
  }
  return hasCommentId
    ? { commentId: requiredString(body.comment_id, "linear_comment_id_invalid") }
    : { eventKey: requiredString(body.event_key, "linear_event_key_invalid") };
}

function workflowIssueKind(value: JsonValue | undefined): "cycle" | "plan" | "work" | "verify" | "human" {
  if (value === "cycle" || value === "plan" || value === "work" || value === "verify" || value === "human") {
    return value;
  }
  throw new Error("linear_workflow_issue_kind_invalid");
}

function workflowRelationKind(value: JsonValue | undefined): "blocks" | "blocked_by" | "triggered_by" {
  if (value === "blocks" || value === "blocked_by" || value === "triggered_by") return value;
  throw new Error("linear_workflow_relation_kind_invalid");
}

function workflowMutationResult(
  result: Awaited<ReturnType<LinearGatewayProtocolHandlerImpl["mutateWorkflow"]>>,
) {
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
  if (result.kind === "write_unconfirmed") {
    return { kind: result.kind, read_back_target: {
      write_id: result.readBackTarget.writeId,
      target_issue_id: result.readBackTarget.targetIssueId,
      remote_version: result.readBackTarget.remoteVersion,
      ...(result.readBackTarget.issueVersions ? { issue_versions: result.readBackTarget.issueVersions.map((value) => ({ issue_id: value.issueId, remote_version: value.remoteVersion })) } : {}),
    } };
  }
  if (result.kind === "precondition_conflict") return { kind: result.kind };
  return { kind: result.kind, read_back: {
    write_id: result.readBack.writeId,
    target_issue_id: result.readBack.targetIssueId,
    remote_version: result.readBack.remoteVersion,
    ...(result.readBack.issueVersions ? { issue_versions: result.readBack.issueVersions.map((value) => ({ issue_id: value.issueId, remote_version: value.remoteVersion })) } : {}),
  } };
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
  if (result.kind === "write_unconfirmed") {
    return {
      kind: result.kind,
      read_back_target: {
        kind: result.readBackTarget.kind,
        target_id: result.readBackTarget.targetId,
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

function requiredLabelOperation(value: JsonValue | undefined): "add" | "remove" {
  if (value !== "add" && value !== "remove") {
    throw new Error("linear_label_operation_invalid");
  }
  return value;
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
