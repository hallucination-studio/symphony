import { spawn as spawnProcess, type SpawnOptions } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  parsePerformerLaunchRequest,
  parsePerformerTokenUsage,
  parsePerformerProcessResult,
  type PerformerLaunchRequest,
  type PerformerProcessResult,
  type PerformerTokenUsage,
} from "../../contracts/performer.js";
import type { Performer } from "../api/Performer.js";

const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_FINAL_RESPONSE_BYTES = 100_000;
const MAX_VISIBLE_REASON_LENGTH = 50;
const DEFAULT_KILL_GRACE_MS = 100;
const MAX_DIAGNOSTIC_PATH_BYTES = 4 * 1024;

type CloseListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

export interface CodexCliProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "close", listener: CloseListener): this;
  once(event: "error", listener: ErrorListener): this;
  kill(signal: NodeJS.Signals): boolean;
}

export interface CodexCliSpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: readonly unknown[];
}

export type CodexCliSpawn = (
  executable: string,
  args: readonly string[],
  options: CodexCliSpawnOptions,
) => CodexCliProcess;

export interface CodexCliPerformerOptions {
  readonly executable?: string;
  readonly spawn?: CodexCliSpawn;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly base_url?: string;
  readonly max_stream_bytes?: number;
  readonly kill_grace_ms?: number;
  readonly now?: () => number;
}

type TerminalStatus = PerformerProcessResult["launch_status"];

function processEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "CODEX_HOME", "CODEX_API_KEY", "TMPDIR"]) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.LANG = source.LANG ?? "C.UTF-8";
  environment.LC_ALL = source.LC_ALL ?? "C";
  return environment;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function optionalBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 2_048 || value.trim() !== value) {
    throw new Error("invalid_codex_base_url");
  }
  try {
    const parsed = new URL(value);
    if (!(["http:", "https:"] as const).includes(parsed.protocol as "http:" | "https:")
      || parsed.username.length > 0 || parsed.password.length > 0
      || parsed.search.length > 0 || parsed.hash.length > 0) {
      throw new Error("invalid_codex_base_url");
    }
  } catch {
    throw new Error("invalid_codex_base_url");
  }
  return value;
}

function sandboxArgument(sandbox: PerformerLaunchRequest["sandbox"]): "read-only" | "workspace-write" {
  return sandbox === "workspace_write" ? "workspace-write" : "read-only";
}

function launchArguments(request: PerformerLaunchRequest, baseUrl: string | undefined): readonly string[] {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "-c",
    `approval_policy=${tomlString("never")}`,
    "--sandbox",
    sandboxArgument(request.sandbox),
  ];
  if (request.model !== undefined) args.push("--model", request.model);
  if (request.reasoning_effort !== undefined) {
    args.push("-c", `model_reasoning_effort=${tomlString(request.reasoning_effort)}`);
  }
  if (baseUrl !== undefined) args.push("-c", `openai_base_url=${tomlString(baseUrl)}`);
  args.push("--cd", request.working_directory);
  if (request.sandbox === "no_workspace") args.push("--skip-git-repo-check");
  if (request.final_response_path !== undefined) {
    args.push("--output-last-message", request.final_response_path);
  }
  args.push("-");
  return Object.freeze(args);
}

function visibleErrorMessage(error: unknown, fallback: string): string {
  let message: string;
  if (error instanceof Error) message = error.message;
  else {
    try { message = String(error); } catch { message = fallback; }
  }
  const value = message.length === 0 ? fallback : message;
  return value.slice(0, MAX_VISIBLE_REASON_LENGTH).replace(/[\r\n\0]/gu, " ");
}

function visibleReason(message: string, fallback: string): string {
  return visibleErrorMessage(new Error(message), fallback);
}

function reasonForStatus(
  status: TerminalStatus,
  details: {
    readonly timeoutMs?: number;
    readonly exitCode?: number;
    readonly signalName?: NodeJS.Signals;
  } = {},
): string | undefined {
  switch (status) {
    case "timed_out":
      return `Process timed out after ${details.timeoutMs ?? 0} ms`;
    case "interrupted":
      return details.signalName === undefined ? "Process interrupted" : `Process terminated by ${details.signalName}`;
    case "start_failed": return "Process could not start";
    case "exited":
      if (details.exitCode !== undefined && details.exitCode !== 0) {
        return `Process exited with code ${details.exitCode}`;
      }
      if (details.signalName !== undefined) return `Process terminated by ${details.signalName}`;
      return undefined;
  }
}

async function finalResponseReference(
  request: PerformerLaunchRequest,
): Promise<{ readonly ref?: string; readonly reason?: string }> {
  const responsePath = request.final_response_path;
  if (responsePath === undefined) return {};
  try {
    const response = await stat(responsePath);
    if (!response.isFile() || response.size === 0) return { reason: "Final response unavailable" };
    if (response.size > MAX_FINAL_RESPONSE_BYTES) {
      return { reason: `Final response exceeded ${MAX_FINAL_RESPONSE_BYTES} bytes` };
    }
    return { ref: responsePath };
  } catch {
    return { reason: "Final response unavailable" };
  }
}

function duration(now: () => number, startedAt: number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

function positiveLimit(value: number | undefined, fallback: number, code: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(code);
  return limit;
}

interface DiagnosticCapture {
  readonly jsonlPath?: string;
  readonly stderrPath?: string;
  readonly invalidPath: boolean;
  readonly jsonl: Buffer[];
  readonly stderr: Buffer[];
}

interface DiagnosticReferences {
  readonly jsonlRef?: string;
  readonly stderrRef?: string;
  readonly captureFailed: boolean;
}

function diagnosticCapture(request: PerformerLaunchRequest): DiagnosticCapture {
  const paths = [request.diagnostic_jsonl_path, request.diagnostic_stderr_path]
    .filter((value): value is string => value !== undefined);
  const invalidPath = paths.some((value) => (
    Buffer.byteLength(value, "utf8") > MAX_DIAGNOSTIC_PATH_BYTES
    || !path.isAbsolute(value)
    || value.includes("\0")
    || path.posix.normalize(value) !== value
  ));
  return {
    ...(request.diagnostic_jsonl_path === undefined ? {} : { jsonlPath: request.diagnostic_jsonl_path }),
    ...(request.diagnostic_stderr_path === undefined ? {} : { stderrPath: request.diagnostic_stderr_path }),
    invalidPath,
    jsonl: [],
    stderr: [],
  };
}

function notFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function parentDirectoryIsSafe(pathname: string): Promise<boolean> {
  const parsed = path.parse(pathname);
  const relative = path.relative(parsed.root, parsed.dir);
  let current = parsed.root;
  for (const [index, component] of relative.split(path.sep).entries()) {
    if (component.length === 0) continue;
    current = path.join(current, component);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (notFound(error)) return false;
      return false;
    }
    if (metadata.isSymbolicLink()) {
      if (!(process.platform === "darwin" && index === 0 && current === "/var")) return false;
      continue;
    }
    if (!metadata.isDirectory()) return false;
  }
  return true;
}

async function persistDiagnosticFile(pathname: string | undefined, chunks: readonly Buffer[]): Promise<boolean> {
  if (pathname === undefined) return false;
  if (!path.isAbsolute(pathname) || pathname.includes("\0")) return false;
  if (!(await parentDirectoryIsSafe(pathname))) return false;
  let file;
  try {
    file = await open(
      pathname,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await file.writeFile(Buffer.concat(chunks));
    await file.chmod(0o600);
    await file.sync();
    await file.close();
    return true;
  } catch {
    await file?.close().catch(() => undefined);
    return false;
  }
}

async function persistDiagnostics(capture: DiagnosticCapture): Promise<DiagnosticReferences> {
  if (capture.invalidPath) return { captureFailed: true };
  const [jsonlWritten, stderrWritten] = await Promise.all([
    persistDiagnosticFile(capture.jsonlPath, capture.jsonl),
    persistDiagnosticFile(capture.stderrPath, capture.stderr),
  ]);
  return {
    ...(jsonlWritten && capture.jsonlPath !== undefined ? { jsonlRef: capture.jsonlPath } : {}),
    ...(stderrWritten && capture.stderrPath !== undefined ? { stderrRef: capture.stderrPath } : {}),
    captureFailed:
      (capture.jsonlPath !== undefined && !jsonlWritten)
      || (capture.stderrPath !== undefined && !stderrWritten),
  };
}

function threadIdFromJsonl(chunks: readonly Buffer[]): string | undefined {
  const source = Buffer.concat(chunks).toString("utf8");
  for (const line of source.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.type !== "thread.started" || typeof record.thread_id !== "string") continue;
      if (
        record.thread_id.length === 0
        || record.thread_id.length > 256
        || /[\r\n\0]/u.test(record.thread_id)
      ) continue;
      return record.thread_id;
    } catch {
      // Keep malformed JSONL as raw diagnostics and continue looking for a valid start event.
    }
  }
  return undefined;
}

function tokenCounter(value: unknown): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return undefined;
  return value as number;
}

function tokenUsageFromJsonl(chunks: readonly Buffer[]): PerformerTokenUsage | undefined {
  const source = Buffer.concat(chunks).toString("utf8");
  let usage: PerformerTokenUsage | undefined;
  for (const line of source.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.type !== "turn.completed") continue;

    // A later terminal event supersedes an earlier one; malformed required
    // counters leave usage unknown instead of carrying forward stale facts.
    usage = undefined;
    const raw = record.usage;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const counters = raw as Record<string, unknown>;
    const inputTokens = tokenCounter(counters.input_tokens);
    const outputTokens = tokenCounter(counters.output_tokens);
    if (
      inputTokens === undefined
      || outputTokens === undefined
      || inputTokens > Number.MAX_SAFE_INTEGER - outputTokens
    ) continue;
    const cachedInputTokens = tokenCounter(counters.cached_input_tokens);
    const cacheWriteInputTokens = tokenCounter(counters.cache_write_input_tokens);
    const reasoningOutputTokens = tokenCounter(counters.reasoning_output_tokens);

    const candidate = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cachedInputTokens === undefined
        ? {}
        : { cached_input_tokens: cachedInputTokens }),
      ...(cacheWriteInputTokens === undefined
        ? {}
        : { cache_write_input_tokens: cacheWriteInputTokens }),
      ...(reasoningOutputTokens === undefined
        ? {}
        : { reasoning_output_tokens: reasoningOutputTokens }),
    };
    try {
      usage = parsePerformerTokenUsage(candidate);
    } catch {
      usage = undefined;
    }
  }
  return usage;
}

function jsonlErrorMessage(chunks: readonly Buffer[]): string | undefined {
  const source = Buffer.concat(chunks).toString("utf8");
  for (const line of source.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.type !== "error" && record.type !== "turn.failed") continue;
    if (typeof record.message === "string" && record.message.length > 0) return record.message;
    const nested = record.error;
    if (typeof nested !== "object" || nested === null || Array.isArray(nested)) continue;
    const nestedMessage = (nested as Record<string, unknown>).message;
    if (typeof nestedMessage === "string" && nestedMessage.length > 0) return nestedMessage;
  }
  return undefined;
}

export class CodexCliPerformer implements Performer {
  readonly #executable: string;
  readonly #spawn: CodexCliSpawn;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #baseUrl: string | undefined;
  readonly #maxStreamBytes: number;
  readonly #killGraceMs: number;
  readonly #now: () => number;

  constructor(options: CodexCliPerformerOptions = {}) {
    this.#executable = options.executable ?? "codex";
    this.#spawn = options.spawn ?? ((executable, args, spawnOptions) => (
      spawnProcess(executable, args, spawnOptions as SpawnOptions) as unknown as CodexCliProcess
    ));
    this.#environment = options.environment ?? process.env;
    this.#baseUrl = optionalBaseUrl(options.base_url);
    this.#maxStreamBytes = positiveLimit(options.max_stream_bytes, MAX_STREAM_BYTES, "invalid_stream_limit");
    this.#killGraceMs = positiveLimit(options.kill_grace_ms, DEFAULT_KILL_GRACE_MS, "invalid_kill_grace");
    this.#now = options.now ?? Date.now;
  }

  async launch(
    input: PerformerLaunchRequest,
    signal?: AbortSignal,
  ): Promise<PerformerProcessResult> {
    const request = parsePerformerLaunchRequest(input);
    const startedAt = this.#now();
    if (signal?.aborted) {
      return parsePerformerProcessResult({
        launch_status: "interrupted",
        duration_ms: duration(this.#now, startedAt),
        sanitized_reason: "performer_interrupted",
      });
    }
    const capture = diagnosticCapture(request);

    const args = launchArguments(request, this.#baseUrl);
    const spawnOptions: CodexCliSpawnOptions = {
      cwd: request.working_directory,
      env: processEnvironment(this.#environment),
      stdio: ["pipe", "pipe", "pipe"],
    };

    let child: CodexCliProcess;
    try {
      child = this.#spawn(this.#executable, args, spawnOptions);
    } catch (error) {
      const diagnostics = await persistDiagnostics(capture);
      const directReason = visibleErrorMessage(error, "Process could not start");
      return parsePerformerProcessResult({
        launch_status: "start_failed",
        duration_ms: duration(this.#now, startedAt),
        ...(diagnostics.jsonlRef === undefined ? {} : { diagnostic_jsonl_ref: diagnostics.jsonlRef }),
        ...(diagnostics.stderrRef === undefined ? {} : { diagnostic_stderr_ref: diagnostics.stderrRef }),
        sanitized_reason: directReason,
      });
    }

    return new Promise<PerformerProcessResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let interrupted = false;
      let streamOverflow = false;
      let directFailureMessage: string | undefined;
      let closeTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let streamBytes = 0;

      const cleanup = () => {
        if (timeoutTimer !== null) clearTimeout(timeoutTimer);
        if (closeTimer !== null) clearTimeout(closeTimer);
        signal?.removeEventListener("abort", abort);
      };

      const settle = async (
        status: TerminalStatus,
        exitCode?: number,
        signalName?: NodeJS.Signals,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        const [response, diagnostics] = await Promise.all([
          status === "exited"
            ? finalResponseReference(request)
            : Promise.resolve({} as { readonly ref?: string; readonly reason?: string }),
          persistDiagnostics(capture),
        ]);
        const tokenUsage = tokenUsageFromJsonl(capture.jsonl);
        const eventReason = streamOverflow
          ? `Output exceeded ${this.#maxStreamBytes} bytes`
          : reasonForStatus(status, {
            timeoutMs: request.timeout_ms,
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(signalName === undefined ? {} : { signalName }),
          });
        const jsonlReason = jsonlErrorMessage(capture.jsonl);
        const reason = directFailureMessage
          ?? jsonlReason
          ?? eventReason
          ?? (diagnostics.captureFailed ? "Diagnostic capture failed" : undefined)
          ?? response.reason;
        resolve(parsePerformerProcessResult({
          launch_status: status,
          ...(status === "exited" && exitCode !== undefined ? { exit_code: exitCode } : {}),
          duration_ms: duration(this.#now, startedAt),
          ...(response.ref === undefined ? {} : { final_response_ref: response.ref }),
          ...(diagnostics.jsonlRef === undefined ? {} : { diagnostic_jsonl_ref: diagnostics.jsonlRef }),
          ...(diagnostics.stderrRef === undefined ? {} : { diagnostic_stderr_ref: diagnostics.stderrRef }),
          ...(() => {
            const threadId = threadIdFromJsonl(capture.jsonl);
            return threadId === undefined ? {} : { thread_id: threadId };
          })(),
          ...(tokenUsage === undefined ? {} : { token_usage: tokenUsage }),
          ...(reason === undefined ? {} : {
            sanitized_reason: visibleReason(reason, "Unknown error"),
          }),
        }));
        void signalName;
      };

      const forceStop = () => {
        if (settled) return;
        try { child.kill("SIGKILL"); } catch { /* process already gone */ }
        closeTimer = setTimeout(() => {
          void settle(timedOut ? "timed_out" : "interrupted");
        }, this.#killGraceMs);
      };

      const stop = (kind: "timeout" | "interrupt") => {
        if (settled) return;
        if (kind === "timeout") timedOut = true;
        else interrupted = true;
        try { child.kill("SIGTERM"); } catch { /* process already gone */ }
        closeTimer = setTimeout(forceStop, this.#killGraceMs);
      };

      const abort = () => stop("interrupt");
      signal?.addEventListener("abort", abort, { once: true });

      const consume = (stream: Readable, target: Buffer[]) => {
        stream.on("data", (chunk: Buffer | string) => {
          if (streamOverflow) return;
          const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
          const available = Math.max(0, this.#maxStreamBytes - streamBytes);
          if (available > 0) target.push(buffer.subarray(0, available));
          streamBytes += buffer.length;
          if (streamBytes > this.#maxStreamBytes) {
            streamOverflow = true;
            stop("interrupt");
          }
        });
        stream.on("error", (error) => {
          directFailureMessage ??= visibleErrorMessage(error, "Stream read failed");
        });
      };
      consume(child.stdout, capture.jsonl);
      consume(child.stderr, capture.stderr);

      child.once("error", (error) => {
        directFailureMessage ??= visibleErrorMessage(error, "Process could not start");
        void settle("start_failed");
      });
      child.once("close", (exitCode, signalName) => {
        if (timedOut) void settle("timed_out");
        else if (interrupted || signalName !== null) void settle("interrupted");
        else void settle("exited", exitCode ?? undefined, signalName ?? undefined);
      });

      timeoutTimer = setTimeout(() => stop("timeout"), request.timeout_ms);
      try {
        child.stdin.end(request.prompt, "utf8");
      } catch (error) {
        directFailureMessage ??= visibleErrorMessage(error, "Input stream failed");
        stop("interrupt");
      }
    });
  }
}

export function createCodexCliPerformer(options: CodexCliPerformerOptions = {}): Performer {
  return new CodexCliPerformer(options);
}
