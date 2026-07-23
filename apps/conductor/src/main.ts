#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";

import { LinearConductorRuntime } from "./composition/ConductorRuntime.js";
import { LinearRootStageDispatcher } from "./composition/LinearRootStageDispatcher.js";
import { conductorCycleDelayMs } from "./composition/ConductorCycleDelayPolicy.js";
import { NativeGitWorkspaceImpl } from "./git-workspaces/internal/NativeGitWorkspaceImpl.js";
import { buildRootDagView } from "./linear-dag/internal/RootDagViewBuilder.js";
import { LinearDagExecutionImpl } from "./linear-dag/internal/LinearDagExecutionImpl.js";
import { PodiumLinearGatewayClientImpl } from "./linear-gateway/internal/PodiumLinearGatewayClientImpl.js";
import { LinearRootOwnershipClaimImpl } from "./root-discovery/internal/LinearRootOwnershipClaimImpl.js";
import { FilePerformerProfileStoreImpl } from "./performer-profiles/internal/FilePerformerProfileStoreImpl.js";
import { ConductorProfileRelayHandler } from "./performer-profiles/internal/ConductorProfileRelayHandler.js";
import { PerformerProfileControlProcessImpl } from "./performer-profiles/internal/PerformerProfileControlProcessImpl.js";
import { SerializedPerformerProcessRunnerImpl } from "./performer-profiles/internal/SerializedPerformerProcessRunnerImpl.js";
import { ShortProcessPerformerStageClientImpl } from "./performer-stage-client/internal/ShortProcessPerformerStageClientImpl.js";
import { stageProcessEnvironment, validateCodexBaseUrl } from "./performer-stage-client/internal/StageProcessEnvironment.js";
import { InheritedProtocolClient } from "./private-ipc/InheritedProtocolClient.js";
import { PodiumConductorRuntimeReporterImpl } from "./runtime-reporting/internal/PodiumConductorRuntimeReporterImpl.js";
import { LinearPriorityRootSchedulingPolicyImpl } from "./root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.js";
import { LinearCycleRootWorkflowPolicyImpl } from "./root-workflow/internal/LinearCycleRootWorkflowPolicyImpl.js";
import { createDefaultRootConvergencePolicy } from "./root-workflow/internal/RootConvergencePolicy.js";
import type { DiscoveredRoot, RootDagView } from "./root-workflow/api/index.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_STAGE_WALL_TIME_MS = 5 * 60_000;
const MAX_PRIVATE_IPC_REQUEST_TIMEOUT_MS = 5 * 60_000;

export async function runConductor(environment = process.env): Promise<void> {
  const config = runtimeConfig(environment);
  const rootDeadlineMs = Date.parse(config.rootConvergencePolicy.deadlineAt);
  const input = createReadStream("", { fd: config.privateIpcFd, autoClose: false });
  const output = createWriteStream("", { fd: config.privateIpcFd, autoClose: false });
  const profiles = new FilePerformerProfileStoreImpl(config.dataRoot);
  const processRunner = new SerializedPerformerProcessRunnerImpl();
  const profileControl = new PerformerProfileControlProcessImpl(processRunner, profiles, {
    executable: config.performerExecutable,
    environment: () => stageProcessEnvironment(config.performerExecutable, config.codexBaseUrl),
    deadlineMs: 120_000,
  });
  const git = new NativeGitWorkspaceImpl(
    config.repositoryRoot,
    path.join(config.dataRoot, "worktrees"),
  );
  const performer = new ShortProcessPerformerStageClientImpl({
    runtimeRoot: path.join(config.dataRoot, "stages"),
    executable: config.performerExecutable,
    environment: (profileId) => stageProcessEnvironment(
      config.performerExecutable,
      config.codexBaseUrl,
      { CODEX_HOME: profiles.codexHome(profileId) },
    ),
    ...(config.codexBaseUrl ? { codexBaseUrl: config.codexBaseUrl } : {}),
    startupDeadlineMs: 120_000,
    cancellationGraceMs: 1_000,
  });
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
  }, (reason, schemaPath, details) => logEvent("error", "private_ipc_failed", {
    sanitized_reason: reason,
    ...(schemaPath ? { schema_path: schemaPath } : {}),
    ...(details?.bodyKind ? { body_kind: details.bodyKind } : {}),
    ...(details?.bodyCode ? { body_code: details.bodyCode } : {}),
    ...(details?.bodyKeys ? { body_keys: details.bodyKeys.join(",") } : {}),
  }));
  const gateway = new PodiumLinearGatewayClientImpl(
    config.conductorShortHash,
    protocol,
    {
      bindingId: config.bindingId,
      timeoutMs: () => remainingRuntimeTimeout(rootDeadlineMs),
      observeDiscovery(evidence) {
        logEvent("info", "root_discovery_evidence", {
          root_header_count: String(evidence.rootHeaderCount),
          list_page_count: String(evidence.listPageCount),
          get_issue_tree_count: String(evidence.getIssueTreeCount),
        });
      },
    },
  );
  const workspaceFor = (root: DiscoveredRoot) => ({
    rootIssueId: root.issueId,
    branch: `symphony/runs/${root.identifier.toLowerCase()}`,
    worktreePath: path.join(config.dataRoot, "worktrees", root.issueId),
  });
  const readRootDag = async (rootIssueId: string): Promise<RootDagView> => {
    const tree = await gateway.readWorkflowIssueTree(rootIssueId);
    const root = tree.issues.find((issue) => issue.issue_id === rootIssueId);
    if (!root) throw new Error("root_tree_root_missing");
    const workspace = await git.ensureWorkspace({
      rootIssueId,
      rootIdentifier: root.identifier,
      baseBranch: config.baseBranch,
    });
    return buildRootDagView({ tree, workspace, git: await git.inspect(workspace) });
  };
  const readyProfile = async (view: RootDagView) => {
    const file = await profiles.list();
    const profileId = view.root.ownership?.performerProfileId ?? file.activeProfileId;
    const profile = profileId
      ? file.profiles.find((candidate) => candidate.profileId === profileId)
      : undefined;
    return profile && await profileReadiness(profileControl, performer, profile.profileId) === "ready"
      ? profile
      : undefined;
  };
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
        ready: await profileReadiness(profileControl, performer, profile.profileId) === "ready",
      };
    },
    workspaceFor,
    conductorId: config.conductorId,
    ownerGeneration: config.instanceId,
    baseBranch: config.baseBranch,
  });
  const targetGateway = {
    resolveProject: () => gateway.resolveProject(),
    listRoots: (projectId: string) => gateway.listRoots(projectId),
    admitRoot: (root: DiscoveredRoot) => ownershipClaim.claim({ root }),
    readRootDag,
  };
  const execution = new LinearDagExecutionImpl(
    { linear: gateway, git, performer },
    undefined,
    undefined,
    config.rootConvergencePolicy,
  );
  const dispatcher = new LinearRootStageDispatcher({
    execution,
    profileFor: readyProfile,
    workspaceFor,
    optionsFor({ root, view, profile, stage }) {
      const cycle = view.cycles.find(({ issue }) => ![
        "Succeeded", "Changes Required", "Canceled",
      ].includes(issue.status_name));
      return {
        conductorShortHash: config.conductorShortHash,
        repositoryIdentity: config.repositoryHandle,
        baseBranch: config.baseBranch,
        performerProfileId: profile.profileId,
        modelSettings: {
          model: profile.codexTurnSettings.model,
          reasoningEffort: stageReasoningEffort(profile.codexTurnSettings.reasoningEffort),
          isFastModeEnabled: profile.codexTurnSettings.isFastModeEnabled,
        },
        limits: {
          maxContextBytes: 8_388_608,
          maxResultBytes: 1_048_576,
          maxWallTimeMs: MAX_STAGE_WALL_TIME_MS,
          maxToolCalls: 256,
          maxCommandDurationMs: 300_000,
          reservedTotalTokens: 50_000,
          maxOutputTokens: 8_000,
        },
        instructionSetId: `${stage}-v1`,
        stageInstructions: stageInstructions(stage),
        now: () => new Date().toISOString(),
        stageId: (_root, cycleIssueId, attempt) =>
          `${root.issueId}:${stage}:${cycle?.issue.issue_id ?? cycleIssueId}:${attempt}`,
      };
    },
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
  const runtimeReporter = new PodiumConductorRuntimeReporterImpl({
    bindingId: config.bindingId,
    instanceId: config.instanceId,
    now: () => new Date().toISOString(),
    async send(body) { await report(body); },
  });
  const runtime = new LinearConductorRuntime(
    config.conductorId,
    config.conductorShortHash,
    targetGateway,
    new LinearPriorityRootSchedulingPolicyImpl(),
    new LinearCycleRootWorkflowPolicyImpl(config.rootConvergencePolicy),
    dispatcher,
    {
      async report(value) {
        logEvent(value.status === "blocked" ? "error" : "info", "conductor_cycle_reported", {
          conductor_id: config.conductorId,
          binding_id: config.bindingId,
          instance_id: config.instanceId,
          ...(value.rootId ? { root_issue_id: value.rootId } : {}),
          ...(value.sanitizedReason ? { sanitized_reason: value.sanitizedReason } : {}),
          status: value.status,
        });
        await runtimeReporter.report(value);
      },
    },
  );
  const stop = () => { void requestStop().catch(() => undefined); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const deadlineTimer = setTimeout(stop, Math.max(0, rootDeadlineMs - Date.now()));
  try {
    let idleAttempt = 0;
    while (!stopping) {
      const disposition = await runtime.cycle();
      const currentIdleAttempt = idleAttempt;
      idleAttempt = disposition === "progress" ? 0 : Math.min(20, idleAttempt + 1);
      await report({
        kind: "conductor_heartbeat",
        binding_id: config.bindingId,
        instance_id: config.instanceId,
        occurred_at: new Date().toISOString(),
      });
      const cycleDelay = conductorCycleDelayMs({
        disposition,
        baseDelayMs: config.cycleDelayMs,
        ...(config.idleDelayMs === undefined ? {} : { idleDelayMs: config.idleDelayMs }),
        idleAttempt: currentIdleAttempt,
        random: Math.random,
      });
      await delay(Math.min(cycleDelay, Math.max(0, rootDeadlineMs - Date.now())));
    }
  } finally {
    clearTimeout(deadlineTimer);
    await requestStop();
  }
}

async function profileReadiness(
  control: PerformerProfileControlProcessImpl,
  performer: ShortProcessPerformerStageClientImpl,
  profileId: string,
) {
  if (performer) {
    const result = await control.status(profileId);
    const readiness = result.readiness;
    if (readiness === "login-required" || readiness === "ready" || readiness === "invalid") return readiness;
  }
  throw new Error("profile_status_invalid");
}

function stageReasoningEffort(value: string): "low" | "medium" | "high" {
  if (value === "high" || value === "xhigh") return "high";
  if (value === "medium") return "medium";
  return "low";
}

function stageInstructions(stage: "plan" | "work" | "verify") {
  if (stage === "plan") return "Produce a bounded Plan Contract from the supplied Root facts. included_scope and excluded_scope must contain only exact repository-relative path prefixes; do not put prose, actions, or rationale in those arrays.";
  if (stage === "work") return "Implement the selected Work node within the approved scope.";
  return "Verify the immutable artifact against the approved Plan Contract.";
}

function isKind(value: JsonValue, kind: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && value.kind === kind;
}

function runtimeConfig(environment: NodeJS.ProcessEnv) {
  const defaultRootConvergencePolicy = createDefaultRootConvergencePolicy();
  const rootDeadlineAt = environment.SYMPHONY_ROOT_DEADLINE_AT;
  const rootConvergencePolicy = rootDeadlineAt === undefined
    ? defaultRootConvergencePolicy
    : {
      ...defaultRootConvergencePolicy,
      deadlineAt: validTimestamp(rootDeadlineAt, "root_deadline_invalid"),
    };
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
    idleDelayMs: environment.SYMPHONY_CYCLE_IDLE_DELAY_MS
      ? positiveInteger(environment.SYMPHONY_CYCLE_IDLE_DELAY_MS, "cycle_idle_delay_invalid")
      : undefined,
    rootConvergencePolicy,
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

function logEvent(level: "info" | "warning" | "error", event: string, fields: Record<string, string>): void {
  const line = JSON.stringify({
    event,
    level,
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [
      key,
      value.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]"),
    ])),
  });
  (level === "info" ? process.stdout : process.stderr).write(`${line}\n`);
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
