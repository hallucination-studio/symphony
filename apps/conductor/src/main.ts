#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";

import { V3ConductorRuntime } from "./composition/ConductorRuntime.js";
import { conductorCycleDelayMs } from "./composition/ConductorCycleDelayPolicy.js";
import { AgentRootContextBuilder } from "./agent-symphony-harness/internal/AgentRootContextBuilder.js";
import { AgentSymphonyHarnessImpl } from "./agent-symphony-harness/internal/AgentSymphonyHarnessImpl.js";
import { RootConversationLifecycle } from "./agent-symphony-harness/internal/RootConversationLifecycle.js";
import { recordDeliveryCompleted } from "./agent-symphony-harness/internal/LifecycleEvidence.js";
import { RootRetryBlockCommandHandler } from "./agent-symphony-harness/internal/RootRetryBlockCommandHandler.js";
import { RunAgentRootTurnUseCase } from "./agent-symphony-harness/internal/RunAgentRootTurnUseCase.js";
import { ScopedAgentCommandBrokerImpl } from "./agent-symphony-harness/internal/ScopedAgentCommandBrokerImpl.js";
import { parseAgentCommand } from "./agent-symphony-harness/internal/AgentCommandRegistry.js";
import { TurnCommandBudget } from "./agent-symphony-harness/internal/TurnCommandBudget.js";
import { NativeGitWorkspaceImpl } from "./git-workspaces/internal/NativeGitWorkspaceImpl.js";
import { PodiumLinearGatewayClientImpl } from "./linear-gateway/internal/PodiumLinearGatewayClientImpl.js";
import { FilePerformerProfileStoreImpl } from "./performer-profiles/internal/FilePerformerProfileStoreImpl.js";
import { ConductorProfileRelayHandler } from "./performer-profiles/internal/ConductorProfileRelayHandler.js";
import { PerformerProfileControlProcessImpl } from "./performer-profiles/internal/PerformerProfileControlProcessImpl.js";
import { GlobalPerformerLane } from "./performer-turns/internal/GlobalPerformerLane.js";
import { SubprocessPerformerProcessImpl } from "./performer-turns/internal/SubprocessPerformerProcessImpl.js";
import {
  performerProcessEnvironment,
  validateCodexBaseUrl,
} from "./performer-turns/internal/PerformerProcessEnvironment.js";
import { InheritedProtocolClient } from "./private-ipc/InheritedProtocolClient.js";
import { PodiumConductorRuntimeReporterImpl } from "./runtime-reporting/internal/PodiumConductorRuntimeReporterImpl.js";
import { GitRootDeliveryImpl } from "./root-delivery/internal/GitRootDeliveryImpl.js";
import { LinearPriorityRootSchedulingPolicyImpl } from "./root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.js";
import { BoundedLinearTreeContextImpl } from "./linear-tree/internal/BoundedLinearTreeContextImpl.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export async function runConductor(environment = process.env): Promise<void> {
  const config = runtimeConfig(environment);
  const input = createReadStream("", { fd: config.privateIpcFd, autoClose: false });
  const output = createWriteStream("", {
    fd: config.privateIpcFd,
    autoClose: false,
  });
  const profiles = new FilePerformerProfileStoreImpl(config.dataRoot);
  const performerLane = new GlobalPerformerLane();
  const git = new NativeGitWorkspaceImpl(
    config.repositoryRoot,
    path.join(config.dataRoot, "worktrees"),
  );
  const profileControl = new PerformerProfileControlProcessImpl(
    performerLane,
    profiles,
    {
      executable: config.performerExecutable,
      environment: () => performerProcessEnvironment(config.codexBaseUrl),
      deadlineMs: 120_000,
    },
  );
  const performer = new SubprocessPerformerProcessImpl(performerLane, {
    runtimeRoot: path.join(config.dataRoot, "turns"),
    executable: config.performerExecutable,
    environment: (profileId) => performerProcessEnvironment(
      config.codexBaseUrl,
      { CODEX_HOME: profiles.codexHome(profileId) },
    ),
    startupDeadlineMs: 120_000,
    cancellationGraceMs: 1_000,
  });
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  const requestStop = () => {
    stopping = true;
    shutdown ??= performer.cancelAndReap();
    return shutdown;
  };
  const runtimeHandlers: { retry?: RootRetryBlockCommandHandler } = {};
  const protocol = new InheritedProtocolClient(input, output, {
    async handleRequest(body, secret) {
      if (
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        body.kind === "shutdown_conductor"
      ) {
        await requestStop();
        return { kind: "shutdown_conductor" };
      }
      if (body && typeof body === "object" && !Array.isArray(body)
        && body.kind === "acknowledge_root_retry_block") {
        if (!runtimeHandlers.retry) throw new Error("conductor_runtime_not_ready");
        return runtimeHandlers.retry.handle(body);
      }
      return new ConductorProfileRelayHandler(
        config.conductorId,
        profiles,
        profileControl,
        () => new Date().toISOString(),
      ).handleRequest(body, secret);
    },
  });
  const gateway = new PodiumLinearGatewayClientImpl(
    config.conductorShortHash,
    protocol,
    profiles,
    {
      timeoutMs: 30_000,
      conductorId: config.conductorId,
      observeDiscovery(evidence) {
        logEvent("info", "root_discovery_evidence", {
          root_header_count: String(evidence.rootHeaderCount),
          list_page_count: String(evidence.listPageCount),
          get_issue_tree_count: String(evidence.getIssueTreeCount),
        });
      },
      async gitWorkspaceFacts({ rootIssueId, branch }) {
        const workspace = { rootIssueId, branch,
          worktreePath: path.join(config.dataRoot, "worktrees", rootIssueId) };
        const snapshot = await git.inspect(workspace);
        return { branch: snapshot.branch, worktreePath: workspace.worktreePath,
          head: snapshot.head, status: snapshot.status.items };
      },
      async profileReadiness(profileId) {
        if (performer.hasPendingBootstrap(profileId)) return "ready";
        const result = await profileControl.status(profileId);
        const readiness = result.readiness;
        if (
          readiness !== "login-required" &&
          readiness !== "ready" &&
          readiness !== "invalid"
        ) {
          throw new Error("profile_status_invalid");
        }
        return readiness;
      },
    },
  );
  const readyProfile = async (profileId?: string) => {
    const file = await profiles.list();
    const id = profileId ?? file.activeProfileId;
    const profile = id ? file.profiles.find(({ profileId }) => profileId === id) : undefined;
    if (!profile || await gateway.profileReadiness(profile.profileId) !== "ready") return undefined;
    return { ...profile, readiness: "ready" as const };
  };
  const conversations = new RootConversationLifecycle({
    conductorId: config.conductorId, baseBranch: config.baseBranch,
    now: () => new Date().toISOString(), requestId: randomUUID,
    bootstrapDeadlineMs: 120_000,
    profiles: { activeReadyProfile: () => readyProfile(), fixedReadyProfile: readyProfile },
    workspaces: git, performer,
    onRootSelected(evidence) {
      logEvent("info", "root_selected", {
        root_issue_id: evidence.rootIssueId,
        root_identifier: evidence.rootIdentifier,
      });
    },
    onWorkspaceReady(evidence) {
      logEvent("info", "workspace_ready", {
        root_issue_id: evidence.rootIssueId,
        root_identifier: evidence.rootIdentifier,
        branch: evidence.branch,
        workspace_id: evidence.workspaceId,
        baseline_head: evidence.baselineHead,
      });
    },
    claims: {
      compareAndSetClaim: (value) => gateway.compareAndSetClaim(value),
      compareAndSetConversation: (value) => gateway.compareAndSetConversation(value),
      writeRetryBlock: (value) => gateway.writeRetryBlock(value),
      appendRetryProblem: (value) => gateway.appendRetryProblem(value),
      clearRetryBlock: (value) => gateway.clearRetryBlock(value),
      reconstruct: (rootId) => gateway.reconstructV3(rootId),
    },
  });
  const delivery = new GitRootDeliveryImpl(undefined, {
    async readFreshFacts(command) {
      const fresh = await gateway.reconstructV3(command.rootIssueId);
      const snapshot = await git.inspect(command.workspace);
      return {
        root_issue_id: fresh.root.issueId,
        root_version: fresh.root.updatedAt,
        performer_id: fresh.managedComment?.performerId ?? "missing",
        terminal: fresh.root.state === "Done" || fresh.root.state === "Canceled",
        blocker_issue_ids: fresh.blockerRelations
          .filter(({ targetState }) => targetState !== "Done" && targetState !== "Canceled")
          .map(({ targetIssueId }) => targetIssueId),
        tree_digest: digest(fresh.workflowNodes), tree_complete: fresh.workflowTreeComplete,
        git_head: snapshot.head, checks_digest: digest([]), checks_passed: true,
        ...(fresh.delivery ? { existing_delivery: fresh.delivery } : {}),
      };
    },
  });
  runtimeHandlers.retry = new RootRetryBlockCommandHandler(conversations);
  const limits = { maxWallTimeMs: 30 * 60_000, maxContextBytes: 8_388_608,
    maxBrokerCalls: 256, maxMutations: 64 };
  const turns = new RunAgentRootTurnUseCase({
    reconstruct: (rootId) => gateway.reconstructV3(rootId),
    context: new AgentRootContextBuilder(new BoundedLinearTreeContextImpl(gateway)),
    profiles: { get: readyProfile },
    broker({ turnId, view, performerId }) {
      const workspace = view.gitWorkspace && { rootIssueId: view.root.issueId,
        branch: view.gitWorkspace.branch, worktreePath: view.gitWorkspace.worktreePath };
      const scoped = new ScopedAgentCommandBrokerImpl({
        conductorId: config.conductorId, turnId, rootIssueId: view.root.issueId,
        performerId, linear: gateway, git, delivery,
        ...(workspace ? { workspace } : {}),
        readGitHead: async () => (await git.inspect(workspace!)).head,
        readFreshRootView: () => gateway.reconstructV3(view.root.issueId),
        deliveryContext: { baseBranch: config.baseBranch, title: view.root.title,
          body: view.root.description, treeDigest: digest(view.workflowNodes),
          checksDigest: digest([]) },
        budget: new TurnCommandBudget(limits),
      });
      return {
        async execute(value: unknown) {
          const result = await scoped.execute(value);
          let parsedCommand;
          try {
            parsedCommand = parseAgentCommand(value);
            const output = result as Record<string, JsonValue>;
            const commandProblem = output.problem && typeof output.problem === "object"
              && !Array.isArray(output.problem) ? output.problem : undefined;
            logEvent("info", "agent_broker_result", {
              turn_id: turnId,
              root_issue_id: view.root.issueId,
              performer_id: performerId,
              command: parsedCommand.command,
              status: typeof output.status === "string" ? output.status : "failed",
              ...(commandProblem && typeof commandProblem.code === "string"
                ? { problem_code: commandProblem.code } : {}),
            });
          } catch {
            // Invalid model output is rejected by the broker and is not echoed to logs.
          }
          if (workspace && parsedCommand) {
            await recordDeliveryCompleted({
              command: parsedCommand,
              result,
              workspace,
              inspect: (target) => git.inspect(target),
              log: logEvent,
            });
          }
          return result;
        },
      };
    },
    performer: {
      runRootTurn(input) {
        return performer.runRootTurn({
          ...input,
          onEvent(event) {
            const body = event.body;
            if (!body || typeof body !== "object" || Array.isArray(body)) return;
            const kind = body.kind;
            if (typeof kind !== "string") return;
            logEvent("info", "performer_turn_event", {
              turn_id: String(event.turn_id),
              root_issue_id: String(event.root_issue_id),
              performer_id: String(event.performer_id),
              event_kind: kind,
              ...(typeof body.code === "string" ? { event_code: body.code } : {}),
              ...(typeof body.sanitized_summary === "string"
                ? { sanitized_reason: body.sanitized_summary }
                : {}),
            });
          },
        });
      },
    },
    async observe({ freshView, result }) {
      if (result && typeof result === "object" && !Array.isArray(result)
        && result.result_kind === "root_conversation_unavailable") {
        await conversations.retry(freshView, freshView.managedComment?.performerId);
      }
    },
    turnId: randomUUID, now: () => new Date().toISOString(), limits,
  });
  const harness = new AgentSymphonyHarnessImpl(conversations, turns);
  const report = async (body: JsonValue) => {
    await protocol.request({
      requestId: randomUUID(),
      body,
      timeoutMs: 30_000,
    });
  };
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
  logEvent("info", "conductor_started", {
    conductor_id: config.conductorId,
    binding_id: config.bindingId,
    instance_id: config.instanceId,
  });
  const runtimeReporter = new PodiumConductorRuntimeReporterImpl({
    bindingId: config.bindingId,
    instanceId: config.instanceId,
    now: () => new Date().toISOString(),
    send: report,
  });
  const runtime = new V3ConductorRuntime(
    config.conductorId,
    gateway,
    new LinearPriorityRootSchedulingPolicyImpl(),
    harness,
    {
      async report(value) {
        logEvent(value.status === "blocked" ? "error" : "info", "conductor_cycle_reported", {
          conductor_id: config.conductorId,
          binding_id: config.bindingId,
          instance_id: config.instanceId,
          ...(value.rootId ? { root_issue_id: value.rootId } : {}),
          ...(value.sanitizedReason
            ? { sanitized_reason: value.sanitizedReason }
            : {}),
          status: value.status,
        });
        await runtimeReporter.report(value);
      },
    },
  );
  const stop = () => {
    void requestStop().catch(() => undefined);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      const disposition = await runtime.cycle();
      await report({
        kind: "conductor_heartbeat",
        binding_id: config.bindingId,
        instance_id: config.instanceId,
        occurred_at: new Date().toISOString(),
      });
      logEvent("info", "conductor_heartbeat_sent", {
        conductor_id: config.conductorId,
        binding_id: config.bindingId,
        instance_id: config.instanceId,
      });
      await delay(conductorCycleDelayMs({
        disposition,
        baseDelayMs: config.cycleDelayMs,
        random: Math.random,
      }));
    }
  } finally {
    await performer.cancelAndReap();
  }
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
    repositoryRoot: required(environment.SYMPHONY_REPOSITORY_ROOT, "repository_root_missing"),
    baseBranch: required(environment.SYMPHONY_BASE_BRANCH, "base_branch_missing"),
    dataRoot: required(environment.SYMPHONY_CONDUCTOR_DATA_ROOT, "conductor_data_root_missing"),
    performerExecutable: environment.SYMPHONY_PERFORMER_EXECUTABLE ?? "performer",
    codexBaseUrl: validateCodexBaseUrl(environment.SYMPHONY_CODEX_BASE_URL),
    cycleDelayMs: environment.SYMPHONY_CYCLE_DELAY_MS
      ? positiveInteger(environment.SYMPHONY_CYCLE_DELAY_MS, "cycle_delay_invalid")
      : 1_000,
  };
}

function required(value: string | undefined, code: string): string {
  if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) {
    throw new Error(code);
  }
  return value;
}

function positiveInteger(value: string | undefined, code: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 300_000) {
    throw new Error(code);
  }
  return parsed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function logEvent(
  level: "info" | "warning" | "error",
  event: string,
  fields: Record<string, string>,
): void {
  const line = JSON.stringify({
    event,
    level,
    ...Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        value.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]"),
      ]),
    ),
  });
  (level === "info" ? process.stdout : process.stderr).write(`${line}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runConductor().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "conductor_start_failed",
        error_code: "conductor_start_failed",
        sanitized_reason:
          error instanceof Error && /^[a-z][a-z0-9_]{1,120}$/.test(error.message)
            ? error.message
            : "conductor_start_failed",
        retryable: false,
        action_required: "restart_desktop",
        next_action: "Restart Podium Desktop after resolving the local runtime configuration.",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
