import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
  type CorrelationId,
  type RootIssueId,
  type RuntimeGeneration,
} from "../../contracts/identity.js";
import { asRecord, parseBoundedString } from "../../contracts/validation.js";
import { MAX_ROOT_TOOL_RESPONSE_BYTES } from "../../runtime/RootToolBoundary.js";
import {
  CodexCorrelationRegistry,
  parseCodexInbound,
  type CodexInboundMessage,
  type CodexRequestMethod,
} from "./CodexProtocol.js";
import {
  assertCodexLocalOnlyConfig,
  assertCodexLocalOnlyInitialize,
  assertCodexLocalOnlyMcpInventory,
  assertCodexLocalOnlyPermissionProfiles,
  assertCodexLocalOnlyRemoteControlStatus,
  createCodexLocalOnlyRuntime,
  type CodexLocalOnlyMode,
  type CodexLocalOnlyRuntime,
  type CodexRootLocalOnlyMode,
} from "./CodexLocalOnly.js";
import { encodeJsonl, JsonlFrameDecoder } from "./JsonlPeer.js";

export interface CodexProcessOptions {
  readonly executable: string;
  readonly codexHome: string;
  readonly rootId: RootIssueId;
  readonly runtimeGeneration: RuntimeGeneration;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly capabilityMode?: { readonly kind: "standard" } | CodexLocalOnlyMode | CodexRootLocalOnlyMode;
}

export interface CodexProcessLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly localOnly?: CodexLocalOnlyRuntime;
}

export interface SpawnedCodexProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly events: EventEmitter;
  isRunning(): boolean;
  kill(signal: NodeJS.Signals): boolean;
}

export type CodexSpawner = (
  options: CodexProcessOptions,
  launch: CodexProcessLaunch,
) => SpawnedCodexProcess;

const CODEX_PROCESS_LOCAL_ONLY_DEPLOYMENT_POLICY: CodexLocalOnlyMode["deploymentPolicy"] =
  Object.freeze({
    managedMcpDenyAll: true,
    managedRemoteControlDisabled: true,
    remoteEnvironmentsAbsent: true,
    configurationImmutable: true,
  });

export function createCodexProcessLocalOnlyMode(
  mode: Omit<CodexLocalOnlyMode, "deploymentPolicy">,
): CodexLocalOnlyMode {
  return Object.freeze({
    ...mode,
    deploymentPolicy: CODEX_PROCESS_LOCAL_ONLY_DEPLOYMENT_POLICY,
  });
}

interface RootHomeAuthorityReservation {
  readonly key: string;
  readonly directory: string;
  release: Promise<void> | null;
}

const ROOT_HOME_AUTHORITIES = new Map<string, RootHomeAuthorityReservation>();
const ROOT_HOME_AUTHORITY_DIRECTORY = ".symphony-root-authority";

function rootHomeAuthorityKey(rootHome: string): string {
  const normalized = path.normalize(rootHome).replace(/[\\/]+$/u, "");
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

async function reserveRootHomeAuthority(rootHome: string): Promise<RootHomeAuthorityReservation> {
  const key = rootHomeAuthorityKey(rootHome);
  if (ROOT_HOME_AUTHORITIES.has(key)) throw new Error("codex_root_home_authority_retained");
  const directory = path.join(rootHome, ROOT_HOME_AUTHORITY_DIRECTORY);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("codex_root_home_authority_retained");
    }
    throw new Error("codex_root_home_authority_unavailable");
  }
  const reservation: RootHomeAuthorityReservation = { key, directory, release: null };
  ROOT_HOME_AUTHORITIES.set(key, reservation);
  return reservation;
}

function releaseRootHomeAuthority(reservation: RootHomeAuthorityReservation): Promise<void> {
  if (reservation.release !== null) return reservation.release;
  reservation.release = rmdir(reservation.directory).then(() => {
    if (ROOT_HOME_AUTHORITIES.get(reservation.key) === reservation) {
      ROOT_HOME_AUTHORITIES.delete(reservation.key);
    }
  }, () => {
    throw new Error("codex_root_home_authority_release_failed");
  });
  return reservation.release;
}

const nodeSpawner: CodexSpawner = (_options, launch) => {
  const isolatedProcessGroup = launch.localOnly !== undefined && process.platform !== "win32";
  const child = spawn(launch.executable, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
    ...(isolatedProcessGroup ? { detached: true } : {}),
    env: launch.env,
  });
  let spawnFailed = false;
  child.once("error", () => {
    if (child.pid === undefined) spawnFailed = true;
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    events: child,
    isRunning: () => {
      if (!isolatedProcessGroup || child.pid === undefined) {
        return !spawnFailed && child.exitCode === null && child.signalCode === null;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    },
    kill: (signal) => {
      if (!isolatedProcessGroup || child.pid === undefined) return child.kill(signal);
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        return false;
      }
    },
  };
};

async function assertNoRemoteEnvironmentConfig(codexHome: string): Promise<void> {
  try {
    await lstat(path.join(codexHome, "environments.toml"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("codex_local_only_preflight_failed");
  }
  throw new Error("codex_local_only_preflight_failed");
}

async function resolveLaunch(options: CodexProcessOptions): Promise<CodexProcessLaunch> {
  const baseArgs = [
    "app-server",
    "--stdio",
    "--strict-config",
    "-c",
    `model=${JSON.stringify(options.model)}`,
  ];
  const baseEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR,
    CODEX_HOME: options.codexHome,
    OPENAI_API_KEY: options.apiKey,
    RUST_LOG: "error",
  };
  if (
    options.capabilityMode?.kind !== "local_only"
    && options.capabilityMode?.kind !== "root_local_only"
  ) {
    return Object.freeze({
      executable: options.executable,
      args: Object.freeze(baseArgs),
      env: Object.freeze(baseEnv),
    });
  }
  if (process.platform === "win32") throw new Error("codex_local_only_platform_unsupported");

  const localOnly = createCodexLocalOnlyRuntime(
    options.capabilityMode,
    options.codexHome,
    options.baseUrl,
  );
  await assertNoRemoteEnvironmentConfig(options.codexHome);
  return Object.freeze({
    executable: options.executable,
    args: Object.freeze([...baseArgs, ...localOnly.configArguments]),
    cwd: localOnly.workspaceRoot,
    env: Object.freeze({
      ...baseEnv,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
    }),
    localOnly,
  });
}

const SUPPRESSED_NOTIFICATIONS = [
  "account/login/completed", "account/rateLimits/updated", "account/updated", "app/list/updated",
  "command/exec/outputDelta", "configWarning", "deprecationNotice", "externalAgentConfig/import/completed",
  "externalAgentConfig/import/progress", "fs/changed", "fuzzyFileSearch/sessionCompleted",
  "fuzzyFileSearch/sessionUpdated", "guardianWarning", "hook/completed", "hook/started",
  "item/agentMessage/delta", "item/autoApprovalReview/completed", "item/autoApprovalReview/started",
  "item/commandExecution/outputDelta", "item/commandExecution/terminalInteraction", "item/completed",
  "item/fileChange/outputDelta", "item/fileChange/patchUpdated", "item/mcpToolCall/progress",
  "item/plan/delta", "item/reasoning/summaryPartAdded", "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta", "item/started", "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated", "model/rerouted", "model/safetyBuffering/updated",
  "model/verification", "process/exited", "process/outputDelta", "remoteControl/status/changed",
  "serverRequest/resolved", "skills/changed", "thread/archived", "thread/closed", "thread/compacted",
  "thread/deleted", "thread/environment/connected", "thread/environment/disconnected",
  "thread/goal/cleared", "thread/goal/updated", "thread/name/updated", "thread/realtime/closed",
  "thread/realtime/error", "thread/realtime/itemAdded", "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp", "thread/realtime/started", "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done", "thread/settings/updated", "thread/started",
  "thread/status/changed", "thread/tokenUsage/updated", "thread/unarchived", "turn/diff/updated",
  "turn/moderationMetadata", "turn/plan/updated", "warning",
  "windows/worldWritableWarning", "windowsSandbox/setupCompleted",
] as const;

const MAX_CODEX_TOOL_RESPONSE_FRAME_BYTES = MAX_ROOT_TOOL_RESPONSE_BYTES * 6 + 1024;

interface PendingRequest {
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class CodexProcess {
  readonly #decoder = new JsonlFrameDecoder(MAX_CODEX_TOOL_RESPONSE_FRAME_BYTES);
  readonly #correlations = new CodexCorrelationRegistry();
  readonly #failures = new Set<(code: string) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #notifications = new Set<(message: CodexInboundMessage) => void>();
  #closed = false;
  #shutdown: Promise<void> | null = null;
  #rootHomeAuthority: RootHomeAuthorityReservation | null;

  private constructor(
    private readonly options: CodexProcessOptions,
    private readonly process: SpawnedCodexProcess,
    readonly localOnly: CodexLocalOnlyRuntime | undefined,
    rootHomeAuthority: RootHomeAuthorityReservation | null,
  ) {
    this.#rootHomeAuthority = rootHomeAuthority;
    process.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    process.stdout.on("end", () => this.#fail("codex_process_stream_ended"));
    process.stderr.on("data", () => undefined);
    process.events.once("error", () => this.#fail("codex_process_error"));
    process.events.once("exit", () => {
      void this.#releaseRootHomeIfTerminated().catch(() => undefined);
      this.#fail("codex_process_exited");
    });
  }

  static async start(options: CodexProcessOptions, spawner: CodexSpawner = nodeSpawner): Promise<CodexProcess> {
    const launch = await resolveLaunch(options);
    const rootHomeAuthority = launch.localOnly?.role === "root"
      ? await reserveRootHomeAuthority(launch.localOnly.codexHome)
      : null;
    let spawned: SpawnedCodexProcess;
    try {
      spawned = spawner(options, launch);
    } catch (error) {
      if (rootHomeAuthority !== null) await releaseRootHomeAuthority(rootHomeAuthority).catch(() => undefined);
      throw error;
    }
    const instance = new CodexProcess(options, spawned, launch.localOnly, rootHomeAuthority);
    try {
      const result = asRecord(await instance.request(
        "initialize",
        {
          clientInfo: { name: "symphony", title: "Symphony", version: "0.1.0" },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: SUPPRESSED_NOTIFICATIONS,
          },
        },
        parseCorrelationId("initialize:1"),
        options.startupTimeoutMs,
      ), "invalid_codex_initialize_response");
      for (const key of ["codexHome", "platformFamily", "platformOs", "userAgent"] as const) {
        parseBoundedString(result[key], "invalid_codex_initialize_response", 1024);
      }
      if (instance.localOnly !== undefined) assertCodexLocalOnlyInitialize(result, instance.localOnly);
      await instance.#write({ method: "initialized", params: {} });
      if (instance.localOnly !== undefined) await instance.#preflightLocalOnly();
      return instance;
    } catch (error) {
      try {
        await instance.shutdown();
      } catch {
        throw new Error("codex_process_termination_failed");
      }
      throw error;
    }
  }

  async #preflightLocalOnly(): Promise<void> {
    const runtime = this.localOnly;
    if (runtime === undefined) return;
    let stage: "config" | "remote_control" | "permissions" | "mcp" = "config";
    try {
      assertCodexLocalOnlyConfig(await this.request(
        "config/read",
        { cwd: runtime.workspaceRoot, includeLayers: false },
        parseCorrelationId("local-only:config"),
        this.options.startupTimeoutMs,
      ), runtime);
      stage = "remote_control";
      assertCodexLocalOnlyRemoteControlStatus(await this.request(
        "remoteControl/status/read",
        undefined,
        parseCorrelationId("local-only:remote-control"),
        this.options.startupTimeoutMs,
      ));
      stage = "permissions";
      assertCodexLocalOnlyPermissionProfiles(await this.request(
        "permissionProfile/list",
        { cwd: runtime.workspaceRoot, limit: 1_000 },
        parseCorrelationId("local-only:permissions"),
        this.options.startupTimeoutMs,
      ), runtime);
      stage = "mcp";
      assertCodexLocalOnlyMcpInventory(await this.request(
        "mcpServerStatus/list",
        { cursor: null, detail: "toolsAndAuthOnly", limit: 100 },
        parseCorrelationId("local-only:mcp"),
        this.options.startupTimeoutMs,
      ));
    } catch {
      throw new Error(`codex_local_only_preflight_failed:${stage}`);
    }
  }

  onNotification(listener: (message: CodexInboundMessage) => void): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  onFailure(listener: (code: string) => void): () => void {
    if (this.#closed) {
      queueMicrotask(() => listener("codex_process_closed"));
      return () => undefined;
    }
    this.#failures.add(listener);
    return () => this.#failures.delete(listener);
  }

  request(
    method: CodexRequestMethod,
    params: Record<string, unknown> | undefined,
    correlationId: CorrelationId,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("codex_process_closed"));
    const id = this.#correlations.register({
      root_id: this.options.rootId,
      runtime_generation: this.options.runtimeGeneration,
      correlation_id: correlationId,
      method,
    });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail("codex_request_timed_out");
      }, timeoutMs);
      this.#pending.set(id, { timer, resolve, reject });
      void this.#write({ id, method, ...(params === undefined ? {} : { params }) })
        .catch(() => this.#fail("codex_process_write_failed"));
    });
  }

  async respondToTool(requestId: string, success: boolean, text: string): Promise<void> {
    parseBoundedString(requestId, "invalid_codex_request_id", 128);
    parseBoundedString(text, "invalid_codex_tool_response", MAX_ROOT_TOOL_RESPONSE_BYTES);
    if (Buffer.byteLength(text, "utf8") > MAX_ROOT_TOOL_RESPONSE_BYTES) {
      throw new Error("invalid_codex_tool_response");
    }
    await this.#write({
      id: requestId,
      result: { success, contentItems: [{ type: "inputText", text }] },
    }, MAX_CODEX_TOOL_RESPONSE_FRAME_BYTES);
  }

  shutdown(): Promise<void> {
    if (this.#shutdown !== null) return this.#shutdown;
    this.#closed = true;
    this.#rejectPending("codex_process_shutdown");
    this.process.stdin.end();
    this.#shutdown = this.#terminateAndRelease("SIGTERM");
    this.#notifyFailure("codex_process_shutdown");
    return this.#shutdown;
  }

  #receive(chunk: Buffer): void {
    if (this.#closed) return;
    try {
      for (const frame of this.#decoder.push(chunk)) this.#handle(parseCodexInbound(frame));
    } catch {
      this.#fail("invalid_codex_output");
    }
  }

  #handle(message: CodexInboundMessage): void {
    if (message.kind === "response" || message.kind === "error") {
      this.#correlations.accept(message.id);
      const pending = this.#pending.get(message.id);
      if (!pending) throw new Error("unknown_or_stale_codex_response");
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.kind === "error") pending.reject(new Error("codex_request_failed"));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.#notifications) listener(message);
  }

  async #write(message: Record<string, unknown>, maxFrameBytes?: number): Promise<void> {
    if (this.#closed) throw new Error("codex_process_closed");
    const frame = encodeJsonl(message, maxFrameBytes);
    await new Promise<void>((resolve, reject) => {
      this.process.stdin.write(frame, (error) => error ? reject(new Error("codex_process_write_failed")) : resolve());
    });
  }

  #fail(code: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(code);
    this.process.stdin.end();
    this.#shutdown = this.#terminateAndRelease("SIGKILL");
    void this.#shutdown.catch(() => undefined);
    this.#notifyFailure(code);
  }

  async #terminate(initialSignal: "SIGTERM" | "SIGKILL"): Promise<void> {
    if (!this.process.isRunning()) return;
    this.process.kill(initialSignal);
    if (await this.#waitForTermination()) return;
    if (initialSignal === "SIGTERM") {
      this.process.kill("SIGKILL");
      if (await this.#waitForTermination()) return;
    }
    throw new Error("codex_process_termination_failed");
  }

  async #terminateAndRelease(initialSignal: "SIGTERM" | "SIGKILL"): Promise<void> {
    await this.#terminate(initialSignal);
    await this.#releaseRootHomeIfTerminated();
  }

  async #releaseRootHomeIfTerminated(): Promise<void> {
    if (this.process.isRunning() || this.#rootHomeAuthority === null) return;
    await releaseRootHomeAuthority(this.#rootHomeAuthority);
    this.#rootHomeAuthority = null;
  }

  async #waitForTermination(): Promise<boolean> {
    const deadline = performance.now() + this.options.shutdownTimeoutMs;
    while (this.process.isRunning()) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
    }
    return true;
  }

  #notifyFailure(code: string): void {
    for (const listener of this.#failures) {
      try { listener(code); } catch { /* failure observers cannot reopen the boundary */ }
    }
    this.#failures.clear();
  }

  #rejectPending(code: string): void {
    this.#correlations.cancelGeneration(this.options.runtimeGeneration);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.#pending.clear();
  }
}

export function testCodexOptions(codexHome: string): CodexProcessOptions {
  return {
    executable: "codex",
    codexHome,
    rootId: parseRootIssueId("TEST-ROOT"),
    runtimeGeneration: parseRuntimeGeneration(1),
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000,
    apiKey: "test-api-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5",
  };
}
