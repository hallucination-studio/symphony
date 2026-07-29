#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";

import { RootReconciliationRuntime } from "./root-reconciliation/internal/RootReconciliationRuntime.js";
import type { RootWakeDisposition } from "./root-scheduling/api/RootWakePolicy.js";
import { NativeGitWorkspaceImpl } from "./git-workspaces/internal/NativeGitWorkspaceImpl.js";
import { PodiumLinearGatewayClientImpl } from "./linear-gateway/internal/PodiumLinearGatewayClientImpl.js";
import { FilePerformerProfileStoreImpl } from "./performer-profiles/internal/FilePerformerProfileStoreImpl.js";
import { ConductorProfileRelayHandler } from "./performer-profiles/internal/ConductorProfileRelayHandler.js";
import { PerformerProfileControlProcessImpl } from "./performer-profiles/internal/PerformerProfileControlProcessImpl.js";
import { SerializedPerformerProcessRunnerImpl } from "./performer-profiles/internal/SerializedPerformerProcessRunnerImpl.js";
import { SessionPerformerAgentClientImpl } from "./performer-agent-client/internal/SessionPerformerAgentClientImpl.js";
import { PersistentPerformerAgentChannelFactory } from "./performer-agent-client/internal/PerformerAgentChannel.js";
import { PerformerRootReconcilerClientImpl } from "./root-reconciler-client/internal/PerformerRootReconcilerClientImpl.js";
import {
  agentProcessEnvironment,
  PROVIDER_IO_CAPTURE_PATH_ENVIRONMENT_KEY,
  validateCodexBaseUrl,
} from "./performer-agent-client/internal/AgentProcessEnvironment.js";
import { LinearHumanActionMaterializerImpl } from "./human-actions/internal/LinearHumanActionMaterializerImpl.js";
import { LinearRootReconcilerReplyWriterImpl } from "./root-action-materialization/internal/LinearRootReconcilerReplyWriterImpl.js";
import { InheritedProtocolClient } from "./private-ipc/InheritedProtocolClient.js";
import { LinearPriorityRootSchedulingPolicyImpl } from "./root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.js";
import { RootWakeController } from "./root-scheduling/internal/RootWakeController.js";
import { LinearRootSafetyPolicyImpl } from "./root-reconciliation/internal/LinearRootSafetyPolicyImpl.js";
import { LinearRootConvergencePolicyImpl } from "./root-reconciliation/internal/LinearRootConvergencePolicyImpl.js";
import { PodiumRuntimeLogPublisherImpl } from "./runtime-logs/internal/PodiumRuntimeLogPublisherImpl.js";
import { GitRootDeliveryImpl } from "./root-delivery/internal/GitRootDeliveryImpl.js";

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
      {
        CODEX_HOME: profiles.codexHome(profileId),
        ...(config.providerIoCaptureDirectory === undefined ? {} : {
          [PROVIDER_IO_CAPTURE_PATH_ENVIRONMENT_KEY]: providerIoCapturePath(
            config.providerIoCaptureDirectory,
            config.conductorShortHash,
            profileId,
          ),
        }),
      },
    ),
    channelFactory: new PersistentPerformerAgentChannelFactory(),
    deadlineMs: 300_000,
  });
  const reconciler = new PerformerRootReconcilerClientImpl(performer);
  const logs = new PodiumRuntimeLogPublisherImpl();
  const wakes = new RootWakeController();
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  const requestStop = () => {
    stopping = true;
    wakes.wake();
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
      if (isKind(body, "wake_conductor")) {
        if (body.binding_id !== config.bindingId || body.instance_id !== config.instanceId) {
          throw new Error("conductor_wake_mismatch");
        }
        wakes.wake();
        return {
          kind: "wake_conductor_ack",
          binding_id: config.bindingId,
          instance_id: config.instanceId,
        };
      }
      return new ConductorProfileRelayHandler(
        config.conductorId,
        profiles,
        profileControl,
        () => new Date().toISOString(),
      ).handleRequest(body, secret);
    },
  }, (reason, schemaPath, details) => logs.publish({
    level: "error",
    event: "private_ipc_failed",
    fields: privateIpcFailureLogFields(reason, schemaPath, details),
  }));
  const gateway = new PodiumLinearGatewayClientImpl(
    config.conductorShortHash,
    protocol,
    {
      bindingId: config.bindingId,
      instanceId: config.instanceId,
      timeoutMs: () => MAX_PRIVATE_IPC_REQUEST_TIMEOUT_MS,
      observeDiscovery(evidence) {
        logs.publish({ level: "info", event: "root_discovery_evidence", fields: {
          root_header_count: String(evidence.rootHeaderCount),
          list_page_count: String(evidence.listPageCount),
          workflow_tree_count: String(evidence.workflowTreeCount),
        }});
      },
      observeLogicalRequest(observation) {
        logs.publish({ level: "info", event: "linear_logical_request", fields: {
          request_id: observation.requestId,
          operation_kind: observation.operationKind,
          ...(observation.rootIssueId ? { root_issue_id: observation.rootIssueId } : {}),
          ...(observation.writeId ? { write_id: observation.writeId } : {}),
        }});
      },
    },
  );
  const report = async (body: JsonValue) => protocol.request({
    requestId: randomUUID(),
    body,
    timeoutMs: MAX_PRIVATE_IPC_REQUEST_TIMEOUT_MS,
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
  const humanActions = new LinearHumanActionMaterializerImpl(gateway);
  const delivery = new GitRootDeliveryImpl(gateway, git);
  const runtime = new RootReconciliationRuntime({
    conductorId: config.conductorId,
    conductorShortHash: config.conductorShortHash,
    repositoryIdentity: config.repositoryIdentity,
    baseBranch: config.baseBranch,
    linear: gateway,
    git,
    scheduling: new LinearPriorityRootSchedulingPolicyImpl(),
    safety: new LinearRootSafetyPolicyImpl(),
    convergence: new LinearRootConvergencePolicyImpl(
      config.rootConvergencePolicy,
      config.rootDeadlineDurationMs,
    ),
    reconciler,
    performer,
    delivery,
    remoteAcceptance: delivery,
    humanActions,
    replyWriter: new LinearRootReconcilerReplyWriterImpl(gateway),
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
    log: (event, fields) => logs.publish({ level: runtimeLogLevel(event), event, fields }),
  });
  const stop = () => { void requestStop().catch(() => undefined); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    let nextWake: { disposition: RootWakeDisposition; deadlineAtMs?: number } = { disposition: "empty" };
    while (!stopping) {
      await wakes.wait(nextWake);
      if (stopping) break;
      const disposition = await runtime.cycle();
      const deadlineAtMs = runtime.nextWakeAt();
      nextWake = {
        disposition,
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      };
    }
  } finally {
    await requestStop();
  }
}

export function runtimeLogLevel(event: string): "info" | "error" {
  return event.endsWith("_failed") ? "error" : "info";
}

export function privateIpcFailureLogFields(
  reason: string,
  schemaPath?: string,
  details?: {
    requestId?: string;
    bodyKind?: string;
    bodyCode?: string;
    bodyKeys?: string[];
  },
): Record<string, string> {
  return {
    sanitized_reason: reason,
    ...(details?.requestId ? { request_id: details.requestId } : {}),
    ...(schemaPath ? { schema_path: schemaPath } : {}),
    ...(details?.bodyKind ? { body_kind: details.bodyKind } : {}),
    ...(details?.bodyCode ? { body_code: details.bodyCode } : {}),
    ...(details?.bodyKeys ? { body_keys: details.bodyKeys.join(",") } : {}),
  };
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

function isKind(value: JsonValue, kind: string): value is { [key: string]: JsonValue } & { kind: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && value.kind === kind;
}

function runtimeConfig(environment: NodeJS.ProcessEnv) {
  return {
    privateIpcFd: positiveInteger(environment.SYMPHONY_PRIVATE_IPC_FD, "private_ipc_fd_invalid"),
    instanceId: required(environment.SYMPHONY_INSTANCE_ID, "instance_id_missing"),
    bindingId: required(environment.SYMPHONY_BINDING_ID, "binding_id_missing"),
    conductorId: required(environment.SYMPHONY_CONDUCTOR_ID, "conductor_id_missing"),
    conductorShortHash: required(environment.SYMPHONY_CONDUCTOR_SHORT_HASH, "conductor_short_hash_missing"),
    linearInstallationId: required(environment.SYMPHONY_LINEAR_INSTALLATION_ID, "linear_installation_id_missing"),
    organizationId: required(environment.SYMPHONY_ORGANIZATION_ID, "organization_id_missing"),
    repositoryHandle: required(environment.SYMPHONY_REPOSITORY_HANDLE, "repository_handle_missing"),
    repositoryIdentity: required(environment.SYMPHONY_REPOSITORY_IDENTITY, "repository_identity_missing"),
    repositoryRoot: required(environment.SYMPHONY_REPOSITORY_ROOT, "repository_root_missing"),
    baseBranch: required(environment.SYMPHONY_BASE_BRANCH, "base_branch_missing"),
    dataRoot: required(environment.SYMPHONY_CONDUCTOR_DATA_ROOT, "conductor_data_root_missing"),
    performerExecutable: environment.SYMPHONY_PERFORMER_EXECUTABLE ?? "performer",
    codexBaseUrl: validateCodexBaseUrl(environment.SYMPHONY_CODEX_BASE_URL),
    providerIoCaptureDirectory: providerIoCaptureDirectory(environment.SYMPHONY_PROVIDER_IO_CAPTURE_DIR),
    rootDeadlineDurationMs: rootPolicyPositiveInteger(
      environment.SYMPHONY_ROOT_DEADLINE_DURATION_MS,
      "root_deadline_duration_invalid",
    ),
    rootConvergencePolicy: {
      maxCyclesPerRoot: rootPolicyPositiveInteger(environment.SYMPHONY_ROOT_MAX_CYCLES_PER_ROOT, "root_max_cycles_per_root_invalid"),
      maxSameOpenFindingCycles: rootPolicyPositiveInteger(environment.SYMPHONY_ROOT_MAX_SAME_OPEN_FINDING_CYCLES, "root_max_same_open_finding_cycles_invalid"),
      maxCycleRepairAttempts: rootPolicyNonNegativeInteger(environment.SYMPHONY_ROOT_MAX_CYCLE_REPAIR_ATTEMPTS, "root_max_cycle_repair_attempts_invalid"),
    },
  };
}

export function providerIoCaptureDirectory(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 4_096 || /[\r\n\0]/u.test(value) || !path.isAbsolute(value)) {
    throw new Error("provider_io_capture_directory_invalid");
  }
  return path.normalize(value);
}

export function providerIoCapturePath(
  directory: string,
  conductorShortHash: string,
  profileId: string,
  processId = process.pid,
): string {
  const captureDirectory = providerIoCaptureDirectory(directory);
  if (captureDirectory === undefined ||
      !/^[a-f0-9]{12}$/u.test(conductorShortHash) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(profileId) ||
      !Number.isSafeInteger(processId) || processId < 1) {
    throw new Error("provider_io_capture_path_invalid");
  }
  return path.join(captureDirectory, `provider-io-${conductorShortHash}-${profileId}-${processId}.jsonl`);
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

function rootPolicyPositiveInteger(value: string | undefined, code: string): number {
  const parsed = rootPolicyNonNegativeInteger(value, code);
  if (parsed < 1) throw new Error(code);
  return parsed;
}

function rootPolicyNonNegativeInteger(value: string | undefined, code: string): number {
  if (!value || !/^\d+$/u.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 1_000_000_000) throw new Error(code);
  return parsed;
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
