import { spawn as spawnProcess, type SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";

import type { CreatePullRequest } from "./TerminalPullRequest.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_KILL_GRACE_MS = 100;

type CloseListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

export interface GitHubCliProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "close", listener: CloseListener): this;
  once(event: "error", listener: ErrorListener): this;
  kill(signal: NodeJS.Signals): boolean;
}

export interface GitHubCliSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}

export type GitHubCliSpawn = (
  executable: string,
  args: readonly string[],
  options: GitHubCliSpawnOptions,
) => GitHubCliProcess;

export interface GitHubCliPullRequestOptions {
  readonly executable?: string;
  readonly spawn?: GitHubCliSpawn;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeout_ms?: number;
  readonly max_output_bytes?: number;
  readonly kill_grace_ms?: number;
}

function positiveInteger(value: number | undefined, fallback: number, reason: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(reason);
  return resolved;
}

function minimalEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "TMPDIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.LANG = source.LANG ?? "C.UTF-8";
  environment.LC_ALL = source.LC_ALL ?? "C";
  return environment;
}

function pullRequestUrl(output: Buffer): string {
  const value = output.toString("utf8").trim();
  if (value.length === 0 || /\s/u.test(value)) throw new Error("invalid_pull_request_url");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
      throw new Error("invalid_pull_request_url");
    }
  } catch {
    throw new Error("invalid_pull_request_url");
  }
  return value;
}

export function createGitHubCliPullRequest(
  options: GitHubCliPullRequestOptions = {},
): CreatePullRequest {
  const executable = options.executable ?? "gh";
  const spawn = options.spawn ?? ((command, args, spawnOptions) => (
    spawnProcess(command, args, spawnOptions as unknown as SpawnOptions) as unknown as GitHubCliProcess
  ));
  const environment = minimalEnvironment(options.environment ?? process.env);
  const timeoutMs = positiveInteger(options.timeout_ms, DEFAULT_TIMEOUT_MS, "github_pr_timeout_invalid");
  const maxOutputBytes = positiveInteger(
    options.max_output_bytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    "github_pr_output_limit_invalid",
  );
  const killGraceMs = positiveInteger(
    options.kill_grace_ms,
    DEFAULT_KILL_GRACE_MS,
    "github_pr_kill_grace_invalid",
  );

  return (request) => new Promise<string>((resolve, reject) => {
    let child: GitHubCliProcess;
    try {
      child = spawn(executable, ["pr", "create", "--fill", "--head", request.root_branch], {
        cwd: request.workspace_path,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new Error("github_pr_start_failed"));
      return;
    }

    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let failureReason: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(reason));
    };
    const stop = (reason: string) => {
      if (settled || failureReason !== undefined) return;
      failureReason = reason;
      try { child.kill("SIGTERM"); } catch { /* process already unavailable */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* process already unavailable */ }
        fail(reason);
      }, killGraceMs);
    };
    const consume = (stream: Readable, retain: boolean) => {
      stream.on("data", (chunk: Buffer | string) => {
        if (settled || failureReason !== undefined) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        outputBytes += buffer.length;
        if (outputBytes > maxOutputBytes) stop("github_pr_output_too_large");
        else if (retain) stdout.push(buffer);
      });
      stream.on("error", () => undefined);
    };

    const timeoutTimer = setTimeout(() => stop("github_pr_timed_out"), timeoutMs);
    consume(child.stdout, true);
    consume(child.stderr, false);
    child.once("error", () => fail("github_pr_start_failed"));
    child.once("close", (code, signal) => {
      if (failureReason !== undefined) {
        fail(failureReason);
        return;
      }
      if (signal !== null || code !== 0) {
        fail("github_pr_exit_nonzero");
        return;
      }
      if (settled) return;
      try {
        const url = pullRequestUrl(Buffer.concat(stdout));
        settled = true;
        cleanup();
        resolve(url);
      } catch {
        fail("invalid_pull_request_url");
      }
    });
  });
}
