import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { PullRequestResult, RootWorkspace } from "../contracts/workspace.js";
import { parsePullRequestResult } from "../contracts/workspace.js";
import { GitCommand } from "../git/internal/GitCommand.js";

const DEFAULT_REMOTE = "origin";
const DEFAULT_COMMIT_MESSAGE = "Symphony: complete Root";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 32 * 1024;
const MAX_EVIDENCE_OUTPUT_BYTES = 8 * 1024;
const KNOWN_GIT_REASONS = new Set([
  "git_command_failed",
  "git_command_output_too_large",
  "git_command_timed_out",
  "git_command_unavailable",
]);

export interface CreatePullRequestRequest {
  readonly workspace_path: string;
  readonly run_directory: string;
  readonly root_branch: string;
}

export type CreatePullRequest = (
  request: CreatePullRequestRequest,
) => Promise<string>;

export interface TerminalGitCommand {
  run(
    cwd: string,
    args: readonly string[],
    acceptedExitCodes?: readonly number[],
    extraEnvironment?: Readonly<Record<string, string>>,
  ): Promise<Buffer>;
}

export interface TerminalPullRequestOptions {
  readonly createPullRequest: CreatePullRequest;
  readonly onPublishing?: (workspace: RootWorkspace) => Promise<void> | void;
  readonly git?: TerminalGitCommand;
  readonly remote?: string;
  readonly timeoutMs?: number;
  readonly maxCommandOutputBytes?: number;
}

interface CommandOutcome {
  readonly output?: Buffer;
  readonly reason?: string;
}

interface EvidenceRecord {
  readonly step: "validate" | "stage" | "commit" | "push" | "create_pr";
  readonly command: string;
  readonly outcome: "succeeded" | "failed";
  readonly reason?: string;
  readonly output?: string;
}

function boundedNumber(value: number | undefined, fallback: number, code: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 120_000) throw new Error(code);
  return resolved;
}

function boundedText(value: string, limit: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limit) return value;
  const suffix = "\n[truncated]";
  return `${bytes.subarray(0, Math.max(0, limit - Buffer.byteLength(suffix, "utf8"))).toString("utf8")}${suffix}`;
}

function shellDisplay(value: string): string {
  return /^[A-Za-z0-9._/:=-]+$/u.test(value) ? value : JSON.stringify(value);
}

function commandDisplay(args: readonly string[]): string {
  return ["git", ...args].map(shellDisplay).join(" ");
}

function gitReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return KNOWN_GIT_REASONS.has(message) ? message : "git_command_failed";
}

function failed(step: "validate" | "commit" | "push", reason: string): PullRequestResult {
  return parsePullRequestResult({ status: "failed", step, reason });
}

function branchDelivered(rootBranch: string, reason: string): PullRequestResult {
  return parsePullRequestResult({ status: "branch_delivered", root_branch: rootBranch, reason });
}

function currentErrorMessage(error: unknown): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = "Unknown error";
  }
  const bounded = (message.length === 0 ? "Unknown error" : message).slice(0, 50);
  return bounded.replace(/[\r\n\0]/gu, " ");
}

function created(url: string, rootBranch: string): PullRequestResult {
  try {
    const parsed = new URL(url);
    if (parsed.username.length > 0 || parsed.password.length > 0) throw new Error("invalid_pull_request_url");
  } catch {
    throw new Error("invalid_pull_request_url");
  }
  return parsePullRequestResult({ status: "created", pull_request_url: url, root_branch: rootBranch });
}

async function recordEvidence(
  file: string,
  records: readonly EvidenceRecord[],
  limit: number,
): Promise<void> {
  const write = async (source: string): Promise<void> => {
    try {
      await writeFile(file, source, { encoding: "utf8", mode: 0o600 });
    } catch {
      throw new Error("terminal_pr_evidence_write_failed");
    }
  };
  const source = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  if (Buffer.byteLength(source, "utf8") <= limit) {
    await write(source);
    return;
  }
  const bounded = records.map((record) => ({
    ...record,
    command: boundedText(record.command, 2_048),
    reason: record.reason === undefined ? undefined : boundedText(record.reason, 256),
    output: record.output === undefined ? undefined : boundedText(record.output, 1_024),
  }));
  let boundedSource = `${bounded.map((record) => JSON.stringify(record)).join("\n")}\n`;
  if (Buffer.byteLength(boundedSource, "utf8") > limit) {
    boundedSource = `${bounded.map((record) => {
      const { output, ...withoutOutput } = record;
      void output;
      return JSON.stringify(withoutOutput);
    }).join("\n")}\n`;
  }
  if (Buffer.byteLength(boundedSource, "utf8") > limit) throw new Error("terminal_pr_evidence_too_large");
  await write(boundedSource);
}

export class TerminalPullRequest {
  readonly #options: Required<Pick<TerminalPullRequestOptions, "createPullRequest">> &
    Omit<TerminalPullRequestOptions, "createPullRequest">;
  readonly #git: TerminalGitCommand;
  readonly #remote: string;
  readonly #evidenceLimit: number;

  constructor(options: TerminalPullRequestOptions) {
    this.#options = options;
    this.#git = options.git ?? new GitCommand({
      executable: "git",
      timeoutMs: boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, "terminal_pr_timeout_invalid"),
      maxOutputBytes: boundedNumber(
        options.maxCommandOutputBytes,
        DEFAULT_COMMAND_OUTPUT_BYTES,
        "terminal_pr_output_limit_invalid",
      ),
    });
    this.#remote = options.remote ?? DEFAULT_REMOTE;
    this.#evidenceLimit = MAX_EVIDENCE_BYTES;
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(this.#remote)) {
      throw new Error("terminal_pr_remote_invalid");
    }
  }

  async publish(workspace: RootWorkspace): Promise<PullRequestResult> {
    const evidencePath = path.join(workspace.run_directory, `terminal-pr-${randomUUID()}.jsonl`);
    const records: EvidenceRecord[] = [];
    const record = async (
      step: EvidenceRecord["step"],
      args: readonly string[],
      outcome: EvidenceRecord["outcome"],
      details: { readonly reason?: string; readonly output?: Buffer } = {},
    ): Promise<void> => {
      records.push({
        step,
        command: commandDisplay(args),
        outcome,
        ...(details.reason === undefined ? {} : { reason: details.reason }),
        ...(details.output === undefined ? {} : {
          output: boundedText(details.output.toString("utf8"), MAX_EVIDENCE_OUTPUT_BYTES),
        }),
      });
      await recordEvidence(evidencePath, records, this.#evidenceLimit);
    };
    const run = async (args: readonly string[]): Promise<CommandOutcome> => {
      try {
        return { output: await this.#git.run(workspace.workspace_path, args) };
      } catch (error) {
        return { reason: gitReason(error) };
      }
    };

    const validateArgs = ["status", "--porcelain=v1", "--untracked-files=all"] as const;
    const validation = await run(validateArgs);
    if (validation.reason !== undefined) {
      await record("validate", validateArgs, "failed", { reason: validation.reason });
      return failed("validate", validation.reason);
    }
    if ((validation.output?.toString("utf8").trim().length ?? 0) === 0) {
      await record("validate", validateArgs, "failed", { reason: "workspace_diff_empty" });
      return failed("validate", "workspace_diff_empty");
    }

    try {
      await this.#options.onPublishing?.(workspace);
    } catch {
      await record("validate", validateArgs, "failed", { reason: "publishing_callback_failed" });
      return failed("validate", "publishing_callback_failed");
    }
    await record(
      "validate",
      validateArgs,
      "succeeded",
      validation.output === undefined ? {} : { output: validation.output },
    );

    const addArgs = ["add", "--all"] as const;
    const add = await run(addArgs);
    if (add.reason !== undefined) {
      await record("stage", addArgs, "failed", { reason: add.reason });
      return failed("commit", add.reason);
    }
    await record(
      "stage",
      addArgs,
      "succeeded",
      add.output === undefined ? {} : { output: add.output },
    );

    const commitArgs = ["commit", "-m", DEFAULT_COMMIT_MESSAGE] as const;
    const commit = await run(commitArgs);
    if (commit.reason !== undefined) {
      await record("commit", commitArgs, "failed", { reason: commit.reason });
      return failed("commit", commit.reason);
    }
    await record(
      "commit",
      commitArgs,
      "succeeded",
      commit.output === undefined ? {} : { output: commit.output },
    );

    const pushArgs = ["push", "--set-upstream", this.#remote, workspace.root_branch] as const;
    const push = await run(pushArgs);
    if (push.reason !== undefined) {
      await record("push", pushArgs, "failed", { reason: push.reason });
      return failed("push", push.reason);
    }
    await record(
      "push",
      pushArgs,
      "succeeded",
      push.output === undefined ? {} : { output: push.output },
    );

    try {
      const url = await this.#options.createPullRequest({
        workspace_path: workspace.workspace_path,
        run_directory: workspace.run_directory,
        root_branch: workspace.root_branch,
      });
      const result = created(url, workspace.root_branch);
      await record("create_pr", ["createPullRequest"], "succeeded");
      return result;
    } catch (error) {
      const reason = currentErrorMessage(error);
      await record("create_pr", ["createPullRequest"], "failed", { reason });
      return branchDelivered(workspace.root_branch, reason);
    }
  }
}

export async function publishPullRequest(
  workspace: RootWorkspace,
  options: TerminalPullRequestOptions,
): Promise<PullRequestResult> {
  return new TerminalPullRequest(options).publish(workspace);
}
