import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";

import {
  parseCorrelationId,
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  type ObservationDigest,
  type RootIssueId,
} from "../../contracts/identity.js";
import type { MutationResult } from "../../contracts/mutation.js";
import type { GitSnapshot } from "../../contracts/observation.js";
import { parseBoundedString } from "../../contracts/validation.js";
import { createRootHeadBranch } from "../../delivery/api/DeliveryInterface.js";
import type {
  GitWorkspaceInterface,
  CommitWorkspaceRequest,
  PrepareWorkspaceRequest,
  RootWorkspaceIdentity,
} from "../api/GitWorkspaceInterface.js";
import { GitCommand } from "./GitCommand.js";

export interface GitWorktreeOptions {
  readonly executable: string;
  readonly repository_id: RootWorkspaceIdentity["repository_id"];
  readonly repository_path: string;
  readonly worktree_root: string;
  readonly command_timeout_ms: number;
  readonly max_output_bytes: number;
}

interface WorktreeEntry {
  readonly path: string;
  readonly revision: string | null;
  readonly branch: string | null;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mutation(
  request: Pick<PrepareWorkspaceRequest, "root_id" | "correlation_id">,
  outcome: MutationResult["outcome"],
  reason?: string,
): MutationResult {
  return outcome === "applied"
    ? { schema_version: 1, outcome, target_id: request.root_id, correlation_id: request.correlation_id }
    : { schema_version: 1, outcome, target_id: request.root_id, correlation_id: request.correlation_id, reason: reason ?? outcome };
}

function parseWorktrees(output: Buffer): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { path: string; revision: string | null; branch: string | null } | null = null;
  for (const field of output.toString("utf8").split("\0")) {
    if (field.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: field.slice("worktree ".length), revision: null, branch: null };
    } else if (current && field.startsWith("HEAD ")) {
      current.revision = field.slice("HEAD ".length);
    } else if (current && field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

function commitMessage(rootId: RootIssueId, diffDigest: ObservationDigest): string {
  return `symphony: complete ${rootId}\n\nSymphony-Diff-Digest: ${diffDigest}`;
}

export class GitWorktree implements GitWorkspaceInterface {
  readonly #commands: GitCommand;

  private constructor(
    private readonly repositoryId: RootWorkspaceIdentity["repository_id"],
    private readonly repositoryPath: string,
    private readonly worktreeRoot: string,
    options: GitWorktreeOptions,
  ) {
    this.#commands = new GitCommand({
      executable: options.executable,
      timeoutMs: options.command_timeout_ms,
      maxOutputBytes: options.max_output_bytes,
    });
  }

  static async create(options: GitWorktreeOptions): Promise<GitWorktree> {
    if (!path.isAbsolute(options.repository_path) || !path.isAbsolute(options.worktree_root)) {
      throw new Error("invalid_git_workspace_path");
    }
    if (!Number.isSafeInteger(options.command_timeout_ms) || options.command_timeout_ms < 1) {
      throw new Error("invalid_git_command_timeout");
    }
    if (!Number.isSafeInteger(options.max_output_bytes) || options.max_output_bytes < 1024) {
      throw new Error("invalid_git_output_limit");
    }
    const repositoryPath = path.normalize(await realpath(options.repository_path));
    const worktreeRoot = path.normalize(await realpath(options.worktree_root));
    if (contains(repositoryPath, worktreeRoot) || contains(worktreeRoot, repositoryPath)) {
      throw new Error("git_repository_and_worktrees_overlap");
    }
    const instance = new GitWorktree(
      parseRepositoryId(options.repository_id), repositoryPath, worktreeRoot, options,
    );
    const topLevel = path.normalize((await instance.#commands.run(repositoryPath, ["rev-parse", "--show-toplevel"]))
      .toString("utf8").trim());
    if (path.normalize(await realpath(topLevel)) !== repositoryPath) throw new Error("git_repository_identity_mismatch");
    return instance;
  }

  pathFor(rootId: RootIssueId): string {
    const encoded = Buffer.from(parseRootIssueId(rootId), "utf8").toString("hex");
    return path.join(this.worktreeRoot, encoded);
  }

  async prepare(request: PrepareWorkspaceRequest): Promise<MutationResult> {
    await this.#assertIdentity(request);
    const correlationId = parseCorrelationId(request.correlation_id);
    const expectedRevision = parseRevision(request.expected_base_revision);
    const normalized = { ...request, correlation_id: correlationId, expected_base_revision: expectedRevision };
    const baseRevision = parseRevision((await this.#commands.run(this.repositoryPath, [
      "rev-parse", "--verify", `refs/heads/${request.base_branch}^{commit}`,
    ])).toString("utf8").trim());
    if (baseRevision !== expectedRevision) return mutation(normalized, "precondition_failed", "base_revision_mismatch");

    const entries = await this.#worktrees();
    const expectedPath = this.pathFor(request.root_id);
    const expectedBranch = `refs/heads/${request.head_branch}`;
    const atPath = entries.filter((entry) => path.normalize(entry.path) === expectedPath);
    if (atPath.length === 1 && atPath[0]?.branch === expectedBranch) {
      try {
        const observation = await this.read(request);
        return observation.head_revision === expectedRevision && observation.workspace_state === "clean"
          ? mutation(normalized, "applied")
          : mutation(normalized, "readback_mismatch", "workspace_baseline_mismatch");
      } catch {
        return mutation(normalized, "readback_mismatch", "workspace_readback_mismatch");
      }
    }
    if (atPath.length > 0 || entries.some(({ branch }) => branch === expectedBranch) || await this.#exists(expectedPath)) {
      return mutation(normalized, "not_applied", "workspace_conflict");
    }
    if (await this.#branchExists(request.head_branch)) return mutation(normalized, "not_applied", "branch_conflict");

    try {
      await this.#commands.run(this.repositoryPath, [
        "worktree", "add", "--lock", "--reason", `symphony:${request.root_id}`,
        "-b", request.head_branch, expectedPath, expectedRevision,
      ]);
    } catch {
      return this.#classifyFailedPrepare(normalized);
    }
    try {
      const observation = await this.read(request);
      return observation.head_revision === expectedRevision && observation.workspace_state === "clean"
        ? mutation(normalized, "applied")
        : mutation(normalized, "readback_mismatch", "workspace_baseline_mismatch");
    } catch {
      return mutation(normalized, "readback_mismatch", "workspace_readback_mismatch");
    }
  }

  async read(identity: RootWorkspaceIdentity): Promise<GitSnapshot> {
    await this.#assertIdentity(identity);
    const expectedPath = this.pathFor(identity.root_id);
    const entries = (await this.#worktrees()).filter((entry) => path.normalize(entry.path) === expectedPath);
    if (entries.length !== 1) throw new Error("git_workspace_missing");
    const stat = await lstat(expectedPath).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("git_workspace_missing");
    if (path.normalize(await realpath(expectedPath)) !== expectedPath) throw new Error("git_workspace_identity_mismatch");
    if (entries[0]?.branch !== `refs/heads/${identity.head_branch}`) throw new Error("git_workspace_identity_mismatch");

    const [branchOutput, revisionOutput, status, digest] = await Promise.all([
      this.#commands.run(expectedPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.#commands.run(expectedPath, ["rev-parse", "--verify", "HEAD^{commit}"]),
      this.#commands.run(expectedPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.#diffDigest(expectedPath),
    ]);
    const branch = branchOutput.toString("utf8").trim();
    if (branch !== identity.head_branch) throw new Error("git_workspace_identity_mismatch");
    return Object.freeze({
      repository_id: this.repositoryId,
      base_branch: identity.base_branch,
      head_branch: branch,
      head_revision: parseRevision(revisionOutput.toString("utf8").trim()),
      workspace_state: status.length === 0 ? "clean" : "dirty",
      diff_digest: digest,
      pull_request: null,
    });
  }

  async commit(request: CommitWorkspaceRequest): Promise<MutationResult> {
    await this.#assertIdentity(request);
    const normalized = {
      ...request,
      correlation_id: parseCorrelationId(request.correlation_id),
      expected_head_revision: parseRevision(request.expected_head_revision),
      expected_diff_digest: parseObservationDigest(request.expected_diff_digest),
    };
    const before = await this.read(request);
    if (await this.#isCommitPostcondition(normalized, before)) return mutation(normalized, "applied");
    if (before.head_revision !== normalized.expected_head_revision) {
      return mutation(normalized, "precondition_failed", "head_revision_mismatch");
    }
    if (before.workspace_state !== "dirty") {
      return mutation(normalized, "precondition_failed", "workspace_not_dirty");
    }
    if (before.diff_digest !== normalized.expected_diff_digest) {
      return mutation(normalized, "precondition_failed", "diff_digest_mismatch");
    }

    const worktreePath = this.pathFor(normalized.root_id);
    try {
      await this.#commands.run(worktreePath, ["add", "-A", "--"]);
      const staged = await this.read(normalized);
      if (
        staged.head_revision !== normalized.expected_head_revision
        || staged.workspace_state !== "dirty"
      ) return mutation(normalized, "precondition_failed", "staged_workspace_mismatch");
      await this.#commands.run(worktreePath, [
        "commit", "--no-gpg-sign", "-m",
        commitMessage(normalized.root_id, normalized.expected_diff_digest),
      ]);
    } catch {
      return this.#classifyFailedCommit(normalized);
    }
    const after = await this.read(normalized);
    return await this.#isCommitPostcondition(normalized, after)
      ? mutation(normalized, "applied")
      : mutation(normalized, "readback_mismatch", "commit_postcondition_mismatch");
  }

  async #assertIdentity(identity: RootWorkspaceIdentity): Promise<void> {
    if (
      parseRepositoryId(identity.repository_id) !== this.repositoryId
      || createRootHeadBranch(parseRootIssueId(identity.root_id)) !== identity.head_branch
    ) throw new Error("git_workspace_identity_mismatch");
    for (const branch of [identity.base_branch, identity.head_branch]) {
      parseBoundedString(branch, "invalid_git_branch", 255);
      await this.#commands.run(this.repositoryPath, ["check-ref-format", "--branch", branch]);
    }
  }

  async #worktrees(): Promise<readonly WorktreeEntry[]> {
    return parseWorktrees(await this.#commands.run(this.repositoryPath, ["worktree", "list", "--porcelain", "-z"]));
  }

  async #branchExists(branch: string): Promise<boolean> {
    const result = await this.#commands.run(
      this.repositoryPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], [0, 1],
    );
    return result.length > 0;
  }

  async #exists(target: string): Promise<boolean> {
    return (await lstat(target).catch(() => null)) !== null;
  }

  async #classifyFailedPrepare(request: PrepareWorkspaceRequest): Promise<MutationResult> {
    try {
      const observation = await this.read(request);
      return observation.head_revision === request.expected_base_revision && observation.workspace_state === "clean"
        ? mutation(request, "applied")
        : mutation(request, "readback_mismatch", "workspace_baseline_mismatch");
    } catch {
      const pathExists = await this.#exists(this.pathFor(request.root_id));
      const branchExists = await this.#branchExists(request.head_branch);
      return pathExists || branchExists
        ? mutation(request, "readback_mismatch", "workspace_partial_effect")
        : mutation(request, "not_applied", "git_command_failed");
    }
  }

  async #classifyFailedCommit(request: CommitWorkspaceRequest): Promise<MutationResult> {
    try {
      const observation = await this.read(request);
      if (await this.#isCommitPostcondition(request, observation)) return mutation(request, "applied");
      return observation.head_revision === request.expected_head_revision
        ? mutation(request, "not_applied", "git_commit_failed")
        : mutation(request, "readback_mismatch", "commit_head_mismatch");
    } catch {
      return mutation(request, "acceptance_unknown", "commit_readback_unavailable");
    }
  }

  async #isCommitPostcondition(
    request: CommitWorkspaceRequest,
    observation: GitSnapshot,
  ): Promise<boolean> {
    if (
      observation.workspace_state !== "clean"
      || observation.head_revision === null
      || observation.head_revision === request.expected_head_revision
    ) return false;
    const worktreePath = this.pathFor(request.root_id);
    try {
      const [parent, message] = await Promise.all([
        this.#commands.run(worktreePath, ["rev-parse", "--verify", `${observation.head_revision}^1`]),
        this.#commands.run(worktreePath, ["log", "-1", "--format=%B", observation.head_revision]),
      ]);
      if (
        parseRevision(parent.toString("utf8").trim()) !== request.expected_head_revision
        || message.toString("utf8").trim() !== commitMessage(request.root_id, request.expected_diff_digest)
      ) return false;
      const confirmed = await this.read(request);
      return confirmed.workspace_state === "clean" && confirmed.head_revision === observation.head_revision;
    } catch {
      return false;
    }
  }

  async #diffDigest(worktreePath: string): Promise<ReturnType<typeof parseObservationDigest>> {
    const [tracked, untrackedOutput] = await Promise.all([
      this.#commands.run(worktreePath, [
        "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD", "--",
      ]),
      this.#commands.run(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const hash = createHash("sha256").update("tracked\0").update(tracked);
    const untracked = untrackedOutput.toString("utf8").split("\0").filter(Boolean).sort();
    for (const relative of untracked) {
      const absolute = path.resolve(worktreePath, relative);
      if (!contains(worktreePath, absolute)) throw new Error("git_diff_path_escape");
      const stat = await lstat(absolute);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("git_diff_unsupported_file");
      const content = stat.isSymbolicLink()
        ? Buffer.from(await readlink(absolute), "utf8")
        : await readFile(absolute);
      hash.update("\0untracked\0").update(Buffer.from(relative, "utf8")).update("\0").update(content);
    }
    return parseObservationDigest(`sha256:${hash.digest("hex")}`);
  }
}
