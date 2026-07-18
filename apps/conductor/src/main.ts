#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";

import { ConductorRuntime } from "./composition/ConductorRuntime.js";
import { ManagedRootActionExecutor } from "./composition/ManagedRootActionExecutor.js";
import { NativeGitWorkspaceImpl } from "./git-workspaces/internal/NativeGitWorkspaceImpl.js";
import { PodiumLinearGatewayClientImpl } from "./linear-gateway/internal/PodiumLinearGatewayClientImpl.js";
import { FilePerformerProfileStoreImpl } from "./performer-profiles/internal/FilePerformerProfileStoreImpl.js";
import { ConductorProfileRelayHandler } from "./performer-profiles/internal/ConductorProfileRelayHandler.js";
import { PerformerProfileControlProcessImpl } from "./performer-profiles/internal/PerformerProfileControlProcessImpl.js";
import { GlobalPerformerLane } from "./performer-turns/internal/GlobalPerformerLane.js";
import { PerformerTurnProcessImpl } from "./performer-turns/internal/PerformerTurnProcessImpl.js";
import {
  performerProcessEnvironment,
  validateCodexBaseUrl,
} from "./performer-turns/internal/PerformerProcessEnvironment.js";
import { InheritedProtocolClient } from "./private-ipc/InheritedProtocolClient.js";
import { GitRootDeliveryImpl } from "./root-delivery/internal/GitRootDeliveryImpl.js";

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
  const profileControl = new PerformerProfileControlProcessImpl(
    performerLane,
    profiles,
    {
      executable: config.performerExecutable,
      environment: () => performerProcessEnvironment(config.codexBaseUrl),
      deadlineMs: 120_000,
    },
  );
  let stopping = false;
  const protocol = new InheritedProtocolClient(input, output, {
    async handleRequest(body, secret) {
      if (
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        body.kind === "shutdown_conductor"
      ) {
        stopping = true;
        return { kind: "shutdown_conductor" };
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
      async profileReadiness(profileId) {
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
  const git = new NativeGitWorkspaceImpl(
    config.repositoryRoot,
    path.join(config.dataRoot, "worktrees"),
  );
  const executor = new ManagedRootActionExecutor({
    conductorId: config.conductorId,
    baseBranch: config.baseBranch,
    gateway,
    profiles,
    git,
    turns: new PerformerTurnProcessImpl(performerLane, {
      runtimeRoot: path.join(config.dataRoot, "turns"),
      executable: config.performerExecutable,
      environment: (profileId) => performerProcessEnvironment(
        config.codexBaseUrl,
        { CODEX_HOME: profiles.codexHome(profileId) },
      ),
      deadlineMs: 30 * 60_000,
    }),
    delivery: new GitRootDeliveryImpl(),
    now: () => new Date().toISOString(),
    createId: randomUUID,
    sleep: delay,
    reportWarning(code) {
      logEvent("warning", "managed_run_usage_update_failed", {
        conductor_id: config.conductorId,
        binding_id: config.bindingId,
        instance_id: config.instanceId,
        sanitized_reason: code,
      });
    },
    reportTurnRetry(warning) {
      logEvent("warning", "performer_turn_retry", {
        conductor_id: config.conductorId,
        binding_id: config.bindingId,
        instance_id: config.instanceId,
        attempt: String(warning.attempt),
        error_code: warning.errorCode,
        sanitized_reason: warning.sanitizedReason,
      });
    },
    reportTurnObservation(observation) {
      const correlation = {
        conductor_id: config.conductorId,
        binding_id: config.bindingId,
        instance_id: config.instanceId,
        turn_id: observation.turnId,
        root_issue_id: observation.rootIssueId,
        ...(observation.workIssueId
          ? { work_issue_id: observation.workIssueId }
          : {}),
        sequence: String(observation.sequence),
        event_kind: observation.eventKind,
      };
      if (observation.observationKind === "failure") {
        logEvent("warning", "performer_turn_observation_failed", {
          ...correlation,
          error_code: observation.failureCode,
          sanitized_reason: observation.sanitizedReason,
        });
        return;
      }
      logEvent(
        observation.eventKind === "warning_raised" ||
          observation.eventKind === "error_raised"
          ? "warning"
          : "info",
        "performer_turn_event",
        {
          ...correlation,
          ...(observation.code ? { event_code: observation.code } : {}),
          ...(observation.retryable === undefined
            ? {}
            : { retryable: String(observation.retryable) }),
          ...(observation.sanitizedReason
            ? { sanitized_reason: observation.sanitizedReason }
            : {}),
        },
      );
    },
  });
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
  const runtime = new ConductorRuntime(
    config.conductorId,
    gateway,
    executor,
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
        await report({
          kind: "conductor_runtime_report",
          binding_id: config.bindingId,
          instance_id: config.instanceId,
          status: "ready",
          ...(value.rootId ? { active_root_issue_id: value.rootId } : {}),
          ...(value.sanitizedReason
            ? { sanitized_summary: value.sanitizedReason }
            : {}),
          observed_at: new Date().toISOString(),
        });
      },
    },
  );
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      await runtime.cycle();
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
      await delay(config.cycleDelayMs);
    }
  } finally {
    await performerLane.cancelAndReap(1_000);
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
