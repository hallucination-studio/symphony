import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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
}

export interface SpawnedCodexProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly events: EventEmitter;
  kill(signal: NodeJS.Signals): boolean;
}

export type CodexSpawner = (options: CodexProcessOptions) => SpawnedCodexProcess;

const nodeSpawner: CodexSpawner = (options) => {
  const child = spawn(options.executable, [
    "app-server", "--stdio", "--strict-config", "-c", `model=${JSON.stringify(options.model)}`,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "C.UTF-8",
      TMPDIR: process.env.TMPDIR,
      CODEX_HOME: options.codexHome,
      OPENAI_API_KEY: options.apiKey,
      OPENAI_BASE_URL: options.baseUrl,
      RUST_LOG: "error",
    },
  });
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, events: child, kill: (signal) => child.kill(signal) };
};

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

  private constructor(
    private readonly options: CodexProcessOptions,
    private readonly process: SpawnedCodexProcess,
  ) {
    process.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    process.stdout.on("end", () => this.#fail("codex_process_stream_ended"));
    process.stderr.on("data", () => undefined);
    process.events.once("error", () => this.#fail("codex_process_error"));
    process.events.once("exit", () => this.#fail("codex_process_exited"));
  }

  static async start(options: CodexProcessOptions, spawner: CodexSpawner = nodeSpawner): Promise<CodexProcess> {
    const instance = new CodexProcess(options, spawner(options));
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
      await instance.#write({ method: "initialized", params: {} });
      return instance;
    } catch (error) {
      await instance.shutdown().catch(() => undefined);
      throw error;
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
    params: Record<string, unknown>,
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
      void this.#write({ id, method, params }).catch(() => this.#fail("codex_process_write_failed"));
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

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending("codex_process_shutdown");
    this.#notifyFailure("codex_process_shutdown");
    this.process.stdin.end();
    if (!this.process.kill("SIGTERM")) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.process.kill("SIGKILL");
        resolve();
      }, this.options.shutdownTimeoutMs);
      this.process.events.once("exit", () => { clearTimeout(timer); resolve(); });
    });
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
    this.#notifyFailure(code);
    this.process.kill("SIGKILL");
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
