import { randomBytes, randomUUID } from "node:crypto";

import type { JsonValue } from "../../public/DesktopViewInterface.js";
import type { ConductorSummaryView } from "../../public/DesktopViewInterface.js";
import type { PodiumClientServices } from "../../public/PodiumClientProtocolHandler.js";
import type { PodiumDesktopHostPorts } from "../../public/PodiumDesktopHostPorts.js";
import { ConductorBindingUseCase } from "../conductor-bindings/ConductorBindingUseCase.js";
import { PodiumDesktopViewImpl } from "../desktop-views/PodiumDesktopViewImpl.js";
import { LinearAuthImpl } from "../linear-auth/LinearAuthImpl.js";
import { LinearOAuthHttpClientImpl } from "../linear-auth/LinearOAuthHttpClientImpl.js";
import { LinearGatewayProtocolHandlerImpl } from "../linear-gateway/LinearGatewayProtocolHandlerImpl.js";
import { LinearSdkImpl } from "../linear-gateway/internal/LinearSdkImpl.js";
import { ProjectCatalogUseCase } from "../project-catalog/ProjectCatalogUseCase.js";
import { SqlitePodiumStoreImpl } from "../storage/SqlitePodiumStoreImpl.js";

type Body = Record<string, JsonValue> & { kind: string };

export class PodiumClientServicesImpl implements PodiumClientServices {
  readonly #view = new PodiumDesktopViewImpl({ staleAfterMs: 60_000 });

  constructor(
    private readonly store: SqlitePodiumStoreImpl,
    private readonly oauth: LinearAuthImpl,
    private readonly oauthHttp: LinearOAuthHttpClientImpl,
    private readonly host: PodiumDesktopHostPorts,
    private readonly now: () => string,
  ) {}

  async completeOAuth(input: { state: string; authorizationCode: string }) {
    const connection = await this.oauth.complete(input);
    const installation = this.store.getOnlyLinearInstallation();
    if (!installation) throw new Error("linear_installation_missing");
    await new ProjectCatalogUseCase(
      this.store,
      new LinearSdkImpl(
        installation.accessToken,
        installation.organizationId,
      ),
    ).refresh(installation.installationId);
    return connection;
  }

  async query(body: Body): Promise<JsonValue> {
    switch (body.kind) {
      case "get_desktop_overview":
        return this.#overview();
      case "get_conductor_detail":
        return this.#conductorDetail(
          requiredString(body.conductor_id, "conductor_id_missing"),
        );
      case "get_root_detail":
        return this.#rootDetail(
          requiredString(body.root_issue_id, "root_issue_id_missing"),
        );
      case "get_performer_profiles":
      case "get_performer_profile_status":
        return this.host.relayProfile(body);
      default:
        throw new Error("podium_client_query_unsupported");
    }
  }

  async command(body: Body): Promise<JsonValue> {
    switch (body.kind) {
      case "connect_linear":
      case "reconnect_linear": {
        const attempt = this.oauth.start();
        await this.host.openLinearAuthorization({
          attemptId: attempt.attemptId,
          authorizationUrl: this.oauthHttp.authorizationUrl({
            state: attempt.state,
            codeChallenge: attempt.codeChallenge,
          }),
        });
        return accepted(body.kind, "accepted");
      }
      case "create_conductor":
        return this.#createConductor(body);
      case "start_conductor":
      case "stop_conductor":
      case "restart_conductor":
        return this.#controlConductor(body);
      case "create_performer_profile":
      case "update_performer_profile":
      case "start_codex_chatgpt_login":
      case "activate_performer_profile": {
        const result = record(
          await this.host.relayProfile(profileCommand(body)),
          "profile_result_invalid",
        );
        if (
          result.kind === "profile_saved" ||
          result.kind === "profile_activated" ||
          result.kind === "profile_status"
        ) {
          return record(result.profile, "profile_result_invalid");
        }
        if (
          body.kind === "start_codex_chatgpt_login" &&
          result.kind === "login_started"
        ) {
          return accepted(body.kind, "accepted");
        }
        throw new Error(
          result.kind === "profile_relay_failed"
            ? profileFailureCode(result)
            : "profile_result_invalid",
        );
      }
      default:
        throw new Error("podium_client_command_unsupported");
    }
  }

  async setApiKey(input: {
    conductorId: string;
    profileId: string;
    secret: Uint8Array;
  }): Promise<JsonValue> {
    const result = record(await this.host.relayProfile(
      {
        kind: "set_api_key",
        conductor_id: input.conductorId,
        profile_id: input.profileId,
        secret_frame_length: input.secret.byteLength,
      },
      input.secret,
    ), "profile_result_invalid");
    if (result.kind !== "profile_status") {
      throw new Error(
        result.kind === "profile_relay_failed"
          ? profileFailureCode(result)
          : "profile_result_invalid",
      );
    }
    return record(result.profile, "profile_result_invalid");
  }

  async #createConductor(body: Body): Promise<JsonValue> {
    const installation = this.store.getOnlyLinearInstallation();
    if (!installation) throw new Error("linear_installation_missing");
    const repositoryBody = record(body.repository, "repository_selection_invalid");
    const repositoryHandle = requiredString(
      repositoryBody.repository_handle,
      "repository_handle_missing",
    );
    const repository = await this.host.resolveRepository(
      repositoryHandle,
      requiredString(repositoryBody.base_branch, "repository_base_branch_missing"),
    );
    const sdk = new LinearSdkImpl(
      installation.accessToken,
      installation.organizationId,
    );
    const binding = await new ConductorBindingUseCase(this.store, sdk, {
      createBindingId: randomUUID,
      createConductorId: randomUUID,
    }).create({
      installationId: installation.installationId,
      projectId: requiredString(body.project_id, "project_id_missing"),
      repositoryContext: repository,
    });
    await this.host.startConductor({
      bindingId: binding.bindingId,
      conductorId: binding.conductorId,
      conductorShortHash: binding.conductorShortHash,
      linearInstallationId: binding.linearInstallationId,
      organizationId: binding.organizationId,
      repositoryHandle,
      repositoryRoot: binding.repositoryContext.repositoryRoot,
      baseBranch: binding.repositoryContext.baseBranch,
    });
    return accepted("create_conductor", "starting");
  }

  async #controlConductor(body: Body): Promise<JsonValue> {
    const binding = this.#binding(
      requiredString(body.conductor_id, "conductor_id_missing"),
    );
    if (body.kind === "stop_conductor") {
      await this.host.stopConductor(binding.conductorId);
      this.store.setConductorDesiredState(binding.bindingId, "stopped");
      return accepted(body.kind, "stopping");
    }
    if (body.kind === "restart_conductor") {
      await this.host.restartConductor(binding.conductorId);
    } else {
      await this.host.startConductor({
        bindingId: binding.bindingId,
        conductorId: binding.conductorId,
        conductorShortHash: binding.conductorShortHash,
        linearInstallationId: binding.linearInstallationId,
        organizationId: binding.organizationId,
        repositoryHandle: binding.repositoryContext.repositoryHandle,
        repositoryRoot: binding.repositoryContext.repositoryRoot,
        baseBranch: binding.repositoryContext.baseBranch,
      });
    }
    this.store.setConductorDesiredState(binding.bindingId, "running");
    return accepted(body.kind, "starting");
  }

  async #overview(): Promise<JsonValue> {
    const now = this.now();
    const installation = this.store.getOnlyLinearInstallation();
    const binding = this.store.getConductorBinding();
    const observation = binding
      ? this.store.getRuntimeObservation(binding.bindingId)
      : undefined;
    const profiles = binding
      ? await this.#profiles(binding.conductorId)
      : [];
    const problems: Array<{
      object_kind: string;
      summary: string;
      impact: string;
      observed_at: string;
    }> = [];
    let roots: Awaited<
      ReturnType<LinearGatewayProtocolHandlerImpl["listAllRootIssues"]>
    > = [];
    let usage: Awaited<
      ReturnType<LinearGatewayProtocolHandlerImpl["listAllRootUsage"]>
    > = [];
    if (installation && observation?.lastResolvedProjectId) {
      const gateway = this.#gateway(installation);
      try {
        roots = await gateway.listAllRootIssues(
          observation.lastResolvedProjectId,
        );
        usage = await gateway.listAllRootUsage(
          observation.lastResolvedProjectId,
        );
      } catch (error) {
        problems.push({
          object_kind: "linear_gateway",
          summary: sanitizedReason(error),
          impact:
            "Linear workflow data is unavailable; execution remains blocked until a fresh read succeeds.",
          observed_at: now,
        });
      }
    }
    if (
      observation &&
      observation.status === "ready" &&
      Date.parse(now) - Date.parse(observation.observedAt) > 60_000
    ) {
      problems.push({
        object_kind: "conductor",
        summary: "conductor_not_responding",
        impact:
          "The last heartbeat is stale. Symphony will not start a replacement until the old process tree is confirmed exited.",
        observed_at: observation.observedAt,
      });
    }
    const totals = usage.reduce(
      (sum, item) => ({
        input_tokens: sum.input_tokens + item.inputTokens,
        cached_input_tokens: sum.cached_input_tokens + item.cachedInputTokens,
        output_tokens: sum.output_tokens + item.outputTokens,
        reasoning_output_tokens:
          sum.reasoning_output_tokens + item.reasoningOutputTokens,
        total_tokens: sum.total_tokens + item.totalTokens,
        observed_at:
          item.observedAt > sum.observed_at ? item.observedAt : sum.observed_at,
      }),
      {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
        observed_at: now,
      },
    );
    return this.#view.overview({
      now,
      linear_connection: installation
        ? {
            status: "connected",
            workspace_name: installation.organizationId,
            observed_at: now,
          }
        : { status: "disconnected", observed_at: now },
      projects: installation
        ? this.store.listProjects(installation.installationId).map((project) => ({
            project_id: project.projectId,
            name: project.name,
            observed_at: project.updatedAt,
          }))
        : [],
      conductors: binding ? [conductorSummary(binding, observation, now)] : [],
      profiles,
      active_roots: roots
        .filter(({ issue }) =>
          issue.state !== "Done" &&
          issue.state !== "Canceled" &&
          issue.state !== "In Review",
        )
        .map(({ issue }) => rootSummary(issue, now)),
      review_roots: roots
        .filter(({ issue }) => issue.state === "In Review")
        .map(({ issue }) => rootSummary(issue, now)),
      completed_root_count: roots.filter(
        ({ issue }) =>
          issue.state === "Done" &&
          usage.some(({ rootIssueId }) => rootIssueId === issue.issueId),
      ).length,
      usage: totals,
      problems: [
        ...problems,
        ...(observation && observation.status !== "ready"
          ? [{
              object_kind: "conductor",
              summary: observation.sanitizedSummary,
              impact: "Local execution is paused until this problem is resolved.",
              observed_at: observation.observedAt,
            }]
          : []),
      ],
    });
  }

  async #conductorDetail(conductorId: string): Promise<JsonValue> {
    const binding = this.#binding(conductorId);
    const observation = this.store.getRuntimeObservation(binding.bindingId);
    const now = this.now();
    return {
      summary: { ...conductorSummary(binding, observation, now) },
      profiles: await this.#profiles(conductorId),
      events: observation
        ? [{
            event_kind: `conductor_${observation.status.replaceAll("-", "_")}`,
            summary: observation.sanitizedSummary,
            occurred_at: observation.observedAt,
          }]
        : [],
    };
  }

  async #rootDetail(rootIssueId: string): Promise<JsonValue> {
    const installation = this.store.getOnlyLinearInstallation();
    const binding = this.store.getConductorBinding();
    if (!installation || !binding) throw new Error("conductor_binding_missing");
    const observation = this.store.getRuntimeObservation(binding.bindingId);
    if (!observation?.lastResolvedProjectId) {
      throw new Error("conductor_project_unresolved");
    }
    const gateway = this.#gateway(installation);
    const tree = await gateway.getCompleteIssueTree(
      observation.lastResolvedProjectId,
      rootIssueId,
    );
    const root = tree.nodes.find(({ issueId }) => issueId === rootIssueId);
    if (!root) throw new Error("linear_tree_root_missing");
    const usage = (await gateway.listAllRootUsage(observation.lastResolvedProjectId))
      .find(({ rootIssueId: candidate }) => candidate === rootIssueId);
    return {
      summary: rootSummary(root, tree.observedAt),
      workflow_nodes: tree.nodes
        .filter(({ issueId }) => issueId !== rootIssueId)
        .map(workflowNode),
      usage: {
        input_tokens: usage?.inputTokens ?? 0,
        cached_input_tokens: usage?.cachedInputTokens ?? 0,
        output_tokens: usage?.outputTokens ?? 0,
        reasoning_output_tokens: usage?.reasoningOutputTokens ?? 0,
        total_tokens: usage?.totalTokens ?? 0,
        completed_root_count: root.state === "Done" ? 1 : 0,
        observed_at: usage?.observedAt ?? tree.observedAt,
        is_stale: false,
      },
      events: [],
    };
  }

  async #profiles(conductorId: string) {
    const result = record(
      await this.host.relayProfile({ kind: "get_profiles", conductor_id: conductorId }),
      "profile_result_invalid",
    );
    return Array.isArray(result.profiles) ? result.profiles as never[] : [];
  }

  #gateway(installation: {
    accessToken: string;
    organizationId: string;
  }) {
    return new LinearGatewayProtocolHandlerImpl(
      new LinearSdkImpl(installation.accessToken, installation.organizationId),
      {
        maxAttempts: 4,
        baseDelayMs: 250,
        sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
      },
    );
  }

  #binding(conductorId: string) {
    const binding = this.store.getConductorBinding();
    if (!binding || binding.conductorId !== conductorId) {
      throw new Error("conductor_binding_missing");
    }
    return binding;
  }
}

export function createLinearAuth(
  store: SqlitePodiumStoreImpl,
  oauthHttp: LinearOAuthHttpClientImpl,
  now: () => string,
) {
  return new LinearAuthImpl(store, oauthHttp, {
    createId: randomUUID,
    createSecret: () => randomBytes(48).toString("base64url"),
    createState: () => randomBytes(32).toString("base64url"),
    now,
  });
}

function accepted(commandKind: string, status: string) {
  return { kind: "command_accepted", command_kind: commandKind, status };
}

function sanitizedReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : "linear_gateway_failed";
  return /^[a-z][a-z0-9_]{1,120}$/.test(reason)
    ? reason
    : "linear_gateway_failed";
}

function profileFailureCode(result: Record<string, JsonValue>): string {
  const error = record(result.error, "profile_relay_failed");
  return typeof error.code === "string" ? error.code : "profile_relay_failed";
}

function profileCommand(body: Body) {
  switch (body.kind) {
    case "create_performer_profile":
      return { ...body, kind: "create_profile", backend_kind: "codex" };
    case "update_performer_profile":
      return { ...body, kind: "update_profile" };
    case "start_codex_chatgpt_login":
      return { ...body, kind: "start_chatgpt_login" };
    case "activate_performer_profile":
      return { ...body, kind: "activate_profile" };
    default:
      throw new Error("profile_command_invalid");
  }
}

function conductorSummary(
  binding: NonNullable<ReturnType<SqlitePodiumStoreImpl["getConductorBinding"]>>,
  observation: ReturnType<SqlitePodiumStoreImpl["getRuntimeObservation"]>,
  now: string,
): ConductorSummaryView {
  const status = observation
    ? Date.parse(now) - Date.parse(observation.observedAt) > 60_000 &&
      binding.desiredState === "running"
      ? "not_responding"
      : runtimeViewStatus(observation.status)
    : binding.desiredState === "running"
      ? "starting"
      : "stopped";
  return {
    conductor_id: binding.conductorId,
    display_name: binding.repositoryContext.repositoryDisplayName,
    status,
    ...(observation?.lastResolvedProjectId
      ? { project_name: observation.lastResolvedProjectId }
      : {}),
    repository_display_name: binding.repositoryContext.repositoryDisplayName,
    base_branch: binding.repositoryContext.baseBranch,
    observed_at: observation?.observedAt ?? now,
  };
}

function runtimeViewStatus(
  status: NonNullable<ReturnType<SqlitePodiumStoreImpl["getRuntimeObservation"]>>["status"],
): ConductorSummaryView["status"] {
  if (status === "not-responding") return "not_responding";
  if (status === "project-conflict") return "project_conflict";
  return status;
}

function rootSummary(issue: { issueId: string; identifier?: string; title?: string; state?: string; updatedAt: string }, observedAt: string) {
  return {
    root_issue_id: issue.issueId,
    identifier: requiredString(issue.identifier, "linear_issue_identifier_missing"),
    title: requiredString(issue.title, "linear_issue_title_missing"),
    status: requiredString(issue.state, "linear_issue_state_missing"),
    observed_at: observedAt,
  };
}

function workflowNode(issue: { issueId: string; parentIssueId?: string; nodeKind?: string; humanKind?: string; state?: string; order?: number; depth?: number; title?: string }) {
  const kind = issue.nodeKind === "human"
    ? issue.humanKind ?? "planned_input"
    : "work_leaf";
  return {
    issue_id: issue.issueId,
    ...(issue.parentIssueId ? { parent_issue_id: issue.parentIssueId } : {}),
    kind,
    state: requiredString(issue.state, "linear_issue_state_missing"),
    order: issue.order ?? 0,
    depth: issue.depth ?? 0,
    title: requiredString(issue.title, "linear_issue_title_missing"),
    is_canceled: issue.state === "Canceled",
  };
}

function record(value: JsonValue | undefined, code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value;
}

function requiredString(value: JsonValue | undefined, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}
