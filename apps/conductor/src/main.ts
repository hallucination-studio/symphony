#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";

import { RootReconciliationRuntime } from "./root-reconciliation/internal/RootReconciliationRuntime.js";
import { NativeGitWorkspaceImpl } from "./git-workspaces/internal/NativeGitWorkspaceImpl.js";
import { PodiumLinearGatewayClientImpl } from "./linear-gateway/internal/PodiumLinearGatewayClientImpl.js";
import { LinearRootOwnershipClaimImpl } from "./root-discovery/internal/LinearRootOwnershipClaimImpl.js";
import { FilePerformerProfileStoreImpl } from "./performer-profiles/internal/FilePerformerProfileStoreImpl.js";
import { ConductorProfileRelayHandler } from "./performer-profiles/internal/ConductorProfileRelayHandler.js";
import { PerformerProfileControlProcessImpl } from "./performer-profiles/internal/PerformerProfileControlProcessImpl.js";
import { SerializedPerformerProcessRunnerImpl } from "./performer-profiles/internal/SerializedPerformerProcessRunnerImpl.js";
import { SessionPerformerAgentClientImpl } from "./performer-agent-client/internal/SessionPerformerAgentClientImpl.js";
import { PersistentPerformerAgentChannelFactory } from "./performer-agent-client/internal/PerformerAgentChannel.js";
import { PerformerRootReconcilerClientImpl } from "./root-reconciler-client/internal/PerformerRootReconcilerClientImpl.js";
import { agentProcessEnvironment, validateCodexBaseUrl } from "./performer-agent-client/internal/AgentProcessEnvironment.js";
import { LinearHumanActionMaterializerImpl } from "./human-actions/internal/LinearHumanActionMaterializerImpl.js";
import { LinearRootDirectiveMaterializerImpl } from "./root-directive-materialization/internal/LinearRootDirectiveMaterializerImpl.js";
import { InheritedProtocolClient } from "./private-ipc/InheritedProtocolClient.js";
import { LinearPriorityRootSchedulingPolicyImpl } from "./root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.js";
import { LinearRootInvariantPolicyImpl } from "./root-reconciliation/internal/LinearRootInvariantPolicyImpl.js";
import { PodiumRuntimeLogPublisherImpl } from "./runtime-logs/internal/PodiumRuntimeLogPublisherImpl.js";
import type { DiscoveredRoot } from "./root-reconciliation/api/RootModels.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_PRIVATE_IPC_REQUEST_TIMEOUT_MS = 5 * 60_000;

export async function runConductor(environment = process.env): Promise<void> {
  const config = runtimeConfig(environment);
  const rootDeadlineMs = Date.parse(config.rootDeadlineAt);
  const input = createReadStream("", { fd: config.privateIpcFd, autoClose: false });
  const output = createWriteStream("", { fd: config.privateIpcFd, autoClose: false });
  const profiles = new FilePerformerProfileStoreImpl(config.dataRoot);
  const processRunner = new SerializedPerformerProcessRunnerImpl();
  const profileControl = new PerformerProfileControlProcessImpl(processRunner, profiles, {
    executable: config.performerExecutable,
    environment: () => agentProcessEnvironment(config.performerExecutable, config.codexBaseUrl),
    deadlineMs: 120_000,
  });
  const git = new NativeGitWorkspaceImpl(
    config.repositoryRoot,
    path.join(config.dataRoot, "worktrees"),
  );
  const performer = new SessionPerformerAgentClientImpl({
    executable: config.performerExecutable,
    environment: (profileId) => agentProcessEnvironment(
      config.performerExecutable,
      config.codexBaseUrl,
      { CODEX_HOME: profiles.codexHome(profileId) },
    ),
    channelFactory: new PersistentPerformerAgentChannelFactory(),
    deadlineMs: 300_000,
  });
  const reconciler = new PerformerRootReconcilerClientImpl(performer);
  const logs = new PodiumRuntimeLogPublisherImpl();
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  const requestStop = () => {
    stopping = true;
    shutdown ??= Promise.all([
      performer.cancelAndReap(),
      processRunner.cancelAndReap(1_000),
    ]).then(() => undefined);
    return shutdown;
  };
  const protocol = new InheritedProtocolClient(input, output, {
    async handleRequest(body, secret) {
      if (isKind(body, "shutdown_conductor")) {
        await requestStop();
        return { kind: "shutdown_conductor_ack" };
      }
      return new ConductorProfileRelayHandler(
        config.conductorId,
        profiles,
        profileControl,
        () => new Date().toISOString(),
      ).handleRequest(body, secret);
    },
  }, (reason, schemaPath, details) => logs.publish({ level: "error", event: "private_ipc_failed", fields: {
    sanitized_reason: reason,
    ...(schemaPath ? { schema_path: schemaPath } : {}),
    ...(details?.bodyKind ? { body_kind: details.bodyKind } : {}),
    ...(details?.bodyCode ? { body_code: details.bodyCode } : {}),
    ...(details?.bodyKeys ? { body_keys: details.bodyKeys.join(",") } : {}),
  }}));
  const gateway = new PodiumLinearGatewayClientImpl(
    config.conductorShortHash,
    protocol,
    {
      bindingId: config.bindingId,
      timeoutMs: () => remainingRuntimeTimeout(rootDeadlineMs),
      observeDiscovery(evidence) {
        logs.publish({ level: "info", event: "root_discovery_evidence", fields: {
          root_header_count: String(evidence.rootHeaderCount),
          list_page_count: String(evidence.listPageCount),
          workflow_tree_count: String(evidence.workflowTreeCount),
        }});
      },
    },
  );
  const workspaceFor = (root: DiscoveredRoot) => ({
    rootIssueId: root.issueId,
    branch: `symphony/runs/${root.identifier.toLowerCase()}`,
    worktreePath: path.join(config.dataRoot, "worktrees", root.issueId),
  });
  const ownershipClaim = new LinearRootOwnershipClaimImpl({
    linear: gateway,
    git,
    profileFor: async ({ ownedProfileId }) => {
      const file = await profiles.list();
      const profileId = ownedProfileId ?? file.activeProfileId;
      const profile = profileId
        ? file.profiles.find((candidate) => candidate.profileId === profileId)
        : undefined;
      if (!profile) return undefined;
      return {
        profileId: profile.profileId,
        ready: await profileReadiness(profileControl, profile.profileId) === "ready",
      };
    },
    workspaceFor,
    conductorId: config.conductorId,
    ownerGeneration: config.instanceId,
    baseBranch: config.baseBranch,
  });
  const report = async (body: JsonValue) => protocol.request({
    requestId: randomUUID(),
    body,
    timeoutMs: remainingRuntimeTimeout(rootDeadlineMs),
  });
  await report({
    kind: "conductor_handshake",
    binding_id: config.bindingId,
    conductor_id: config.conductorId,
    conductor_short_hash: config.conductorShortHash,
    instance_id: config.instanceId,
    linear_installation_id: config.linearInstallationId,
    organization_id: config.organizationId,
    repository: {
      repository_handle: config.repositoryHandle,
      canonical_path: config.repositoryRoot,
      base_branch: config.baseBranch,
    },
  });
  const runtime = new RootReconciliationRuntime({
    conductorId: config.conductorId,
    conductorShortHash: config.conductorShortHash,
    baseBranch: config.baseBranch,
    linear: gateway,
    git,
    ownership: ownershipClaim,
    scheduling: new LinearPriorityRootSchedulingPolicyImpl(),
    invariants: new LinearRootInvariantPolicyImpl(),
    reconciler,
    performer,
    materializer: new LinearRootDirectiveMaterializerImpl(
      gateway,
      new LinearHumanActionMaterializerImpl(gateway),
    ),
    profileIdFor: async () => {
      const file = await profiles.list();
      const profileId = file.activeProfileId;
      if (!profileId) return undefined;
      const profile = file.profiles.find((candidate) => candidate.profileId === profileId);
      return profile && await profileReadiness(profileControl, profile.profileId) === "ready"
        ? profile.profileId
        : undefined;
    },
    modelSettingsFor: async (profileId) => {
      const file = await profiles.list();
      const profile = file.profiles.find((candidate) => candidate.profileId === profileId);
      if (!profile) throw new Error("performer_profile_missing");
      return {
        model: profile.codexTurnSettings.model,
        reasoningEffort: stageReasoningEffort(profile.codexTurnSettings.reasoningEffort),
        isFastModeEnabled: profile.codexTurnSettings.isFastModeEnabled,
      };
    },
    log: (event, fields) => logs.publish({ level: "info", event, fields }),
  });
  const stop = () => { void requestStop().catch(() => undefined); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const deadlineTimer = setTimeout(stop, Math.max(0, rootDeadlineMs - Date.now()));
  try {
    while (!stopping) {
      await runtime.cycle();
      await delay(Math.min(config.cycleDelayMs, Math.max(0, rootDeadlineMs - Date.now())));
    }
  } finally {
    clearTimeout(deadlineTimer);
    await requestStop();
  }
}

async function profileReadiness(
  control: PerformerProfileControlProcessImpl,
  profileId: string,
) {
  const result = await control.status(profileId);
  const readiness = result.readiness;
  if (readiness === "login-required" || readiness === "ready" || readiness === "invalid") return readiness;
  throw new Error("profile_status_invalid");
}

function stageReasoningEffort(value: string): "low" | "medium" | "high" {
  if (value === "high" || value === "xhigh") return "high";
  if (value === "medium") return "medium";
  return "low";
}

function isKind(value: JsonValue, kind: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && value.kind === kind;
}

function runtimeConfig(environment: NodeJS.ProcessEnv) {
  const rootDeadlineAt = environment.SYMPHONY_ROOT_DEADLINE_AT;
  return {
    privateIpcFd: positiveInteger(environment.SYMPHONY_PRIVATE_IPC_FD, "private_ipc_fd_invalid"),
    instanceId: required(environment.SYMPHONY_INSTANCE_ID, "instance_id_missing"),
    bindingId: required(environment.SYMPHONY_BINDING_ID, "binding_id_missing"),
    conductorId: required(environment.SYMPHONY_CONDUCTOR_ID, "conductor_id_missing"),
    conductorShortHash: required(environment.SYMPHONY_CONDUCTOR_SHORT_HASH, "conductor_short_hash_missing"),
    linearInstallationId: required(environment.SYMPHONY_LINEAR_INSTALLATION_ID, "linear_installation_id_missing"),
    organizationId: required(environment.SYMPHONY_ORGANIZATION_ID, "organization_id_missing"),
    repositoryHandle: required(environment.SYMPHONY_REPOSITORY_HANDLE, "repository_handle_missing"),
    repositoryRoot: required(environment.SYMPHONY_REPOSITORY_ROOT, "repository_root_missing"),
    baseBranch: required(environment.SYMPHONY_BASE_BRANCH, "base_branch_missing"),
    dataRoot: required(environment.SYMPHONY_CONDUCTOR_DATA_ROOT, "conductor_data_root_missing"),
    performerExecutable: environment.SYMPHONY_PERFORMER_EXECUTABLE ?? "performer",
    codexBaseUrl: validateCodexBaseUrl(environment.SYMPHONY_CODEX_BASE_URL),
    cycleDelayMs: environment.SYMPHONY_CYCLE_DELAY_MS
      ? positiveInteger(environment.SYMPHONY_CYCLE_DELAY_MS, "cycle_delay_invalid")
      : 1_000,
    rootDeadlineAt: rootDeadlineAt === undefined
      ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      : validTimestamp(rootDeadlineAt, "root_deadline_invalid"),
  };
}

function validTimestamp(value: string, code: string): string {
  if (!value || value.length > 128 || /[\r\n\0]/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(code);
  }
  return new Date(value).toISOString();
}

function remainingRuntimeTimeout(deadlineMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (!Number.isFinite(remaining) || remaining < 1) throw new Error("root_deadline_exceeded");
  return Math.min(MAX_PRIVATE_IPC_REQUEST_TIMEOUT_MS, Math.floor(remaining));
}

function required(value: string | undefined, code: string): string {
  if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error(code);
  return value;
}

function positiveInteger(value: string | undefined, code: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 300_000) throw new Error(code);
  return parsed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runConductor().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "conductor_start_failed",
      error_code: "conductor_start_failed",
      sanitized_reason: error instanceof Error && /^[a-z][a-z0-9_]{1,120}$/.test(error.message)
        ? error.message
        : "conductor_start_failed",
      retryable: false,
      action_required: "restart_desktop",
      next_action: "Restart Podium Desktop after resolving the local runtime configuration.",
    })}\n`);
    process.exitCode = 1;
  });
}
