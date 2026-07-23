import { randomBytes, randomUUID } from "node:crypto";

import type { JsonValue } from "../../public/DesktopViewInterface.js";
import type { ConductorSummaryView } from "../../public/DesktopViewInterface.js";
import type { ConductorPresence } from "../../public/ConductorPresence.js";
import type { PodiumClientServices } from "../../public/PodiumClientProtocolHandler.js";
import type { PodiumDesktopHostPorts } from "../../public/PodiumDesktopHostPorts.js";
import type { LinearClientInterface } from "../linear-gateway/api/LinearClientInterface.js";
import { ConductorBindingUseCase } from "../conductor-bindings/ConductorBindingUseCase.js";
import { PodiumDesktopViewImpl } from "../desktop-views/PodiumDesktopViewImpl.js";
import { LinearAuthImpl } from "../linear-auth/LinearAuthImpl.js";
import { LinearOAuthHttpClientImpl } from "../linear-auth/LinearOAuthHttpClientImpl.js";
import { LinearSdkImpl } from "../linear-gateway/internal/LinearSdkImpl.js";
import { ProjectCatalogUseCase } from "../project-catalog/ProjectCatalogUseCase.js";
import type { LinearInstallationStoreInterface } from "../linear-auth/api/LinearInstallationStoreInterface.js";
import type { LinearInstallation } from "../models.js";
import type { PodiumClientStoreInterface } from "./PodiumStoreInterfaces.js";

type Body = Record<string, JsonValue> & { kind: string };

export class PodiumClientServicesImpl implements PodiumClientServices {
  readonly #view = new PodiumDesktopViewImpl();

  constructor(
    private readonly store: PodiumClientStoreInterface,
    private readonly presence: ConductorPresence,
    private readonly oauth: LinearAuthImpl,
    private readonly oauthHttp: LinearOAuthHttpClientImpl,
    private readonly host: PodiumDesktopHostPorts,
    private readonly now: () => string,
    private readonly createLinearSdk: (
      installation: LinearInstallation,
    ) => LinearClientInterface = (installation) => new LinearSdkImpl(
      installation.kind === "development_token"
        ? {
            kind: installation.kind,
            token: installation.accessToken,
            delegateActorId: installation.delegateActorId,
          }
        : { kind: installation.kind, token: installation.accessToken },
      installation.organizationId,
    ),
  ) {}

  async completeOAuth(input: { state: string; authorizationCode: string }) {
    const connection = await this.oauth.complete(input);
    const installation = this.store.getOnlyLinearCredential();
    if (!installation) throw new Error("linear_installation_missing");
    await new ProjectCatalogUseCase(
      this.store,
      this.createLinearSdk(installation),
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
        return {
          kind: "linear_authorization_started",
          attempt_id: attempt.attemptId,
        };
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
          return {
            kind: "codex_login_started",
            profile_id: requiredString(body.profile_id, "profile_id_missing"),
          };
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
    const installation = this.store.getOnlyLinearCredential();
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
    const sdk = this.createLinearSdk(installation);
    await sdk.initializeTargetTeamWorkflow({
      projectId: requiredString(body.project_id, "project_id_missing"),
      authorized: true,
    });
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
    return {
      kind: "conductor_created",
      conductor_id: binding.conductorId,
    };
  }

  async #controlConductor(body: Body): Promise<JsonValue> {
    const binding = this.#binding(
      requiredString(body.conductor_id, "conductor_id_missing"),
    );
    if (body.kind === "stop_conductor") {
      await this.host.stopConductor(binding.conductorId);
      this.store.setConductorDesiredState(binding.bindingId, "stopped");
      return {
        kind: "conductor_command_completed",
        conductor_id: binding.conductorId,
        command_kind: body.kind,
      };
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
    return {
      kind: "conductor_command_completed",
      conductor_id: binding.conductorId,
      command_kind: body.kind,
    };
  }

  async #overview(): Promise<JsonValue> {
    const now = this.now();
    const installation = this.store.getOnlyLinearCredential();
    const bindings = this.#bindings();
    const logs = this.presence.recentLogs();
    return this.#view.overview({
      now,
      linear_connection: installation
        ? { status: "connected", workspace_name: installation.organizationId, observed_at: now }
        : { status: "disconnected", observed_at: now },
      projects: installation
        ? this.store.listProjects(installation.installationId).map((project) => ({
            project_id: project.projectId,
            name: project.name,
            observed_at: project.updatedAt,
          }))
        : [],
      conductors: bindings.map((binding) => conductorSummary(
        binding,
        this.presence.snapshot(binding.bindingId),
        now,
      )),
      logs,
    });
  }

  async #conductorDetail(conductorId: string): Promise<JsonValue> {
    const binding = this.#binding(conductorId);
    const observation = this.presence.snapshot(binding.bindingId);
    const now = this.now();
    return {
      summary: { ...conductorSummary(binding, observation, now) },
      profiles: await this.#profiles(conductorId),
      logs: this.presence.recentLogs(binding.bindingId).map((log) => ({ ...log })),
    };
  }

  async #profiles(conductorId: string) {
    const result = record(
      await this.host.relayProfile({ kind: "get_profiles", conductor_id: conductorId }),
      "profile_result_invalid",
    );
    return Array.isArray(result.profiles) ? result.profiles as never[] : [];
  }

  #binding(conductorId: string) {
    const binding = this.#bindings().find(({ conductorId: id }) => id === conductorId);
    if (!binding || binding.conductorId !== conductorId) {
      throw new Error("conductor_binding_missing");
    }
    return binding;
  }

  #bindings() {
    const store = this.store as PodiumClientStoreInterface & {
      listConductorBindings?: () => ReturnType<PodiumClientStoreInterface["getConductorBinding"]>[];
    };
    const listed = store.listConductorBindings?.();
    return listed ?? (store.getConductorBinding() ? [store.getConductorBinding()!] : []);
  }

}

function conductorSummary(
  binding: NonNullable<ReturnType<PodiumClientStoreInterface["getConductorBinding"]>>,
  observation: ReturnType<ConductorPresence["snapshot"]>,
  now: string,
): ConductorSummaryView {
  return {
    conductor_id: binding.conductorId,
    display_name: binding.repositoryContext.repositoryDisplayName,
    status: observation?.presence === "online" && binding.desiredState === "running"
      ? "online"
      : "offline",
    repository_display_name: binding.repositoryContext.repositoryDisplayName,
    base_branch: binding.repositoryContext.baseBranch,
    observed_at: observation?.observed_at ?? now,
  };
}

function record(value: JsonValue | undefined, code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value;
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

export function createLinearAuth(
  store: LinearInstallationStoreInterface,
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

function requiredString(value: JsonValue | undefined, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}
