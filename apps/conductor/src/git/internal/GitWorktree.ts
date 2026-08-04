import { createHash } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseTaskIssueId,
  type Revision,
  type CycleIssueId,
  type RootIssueId,
} from "../../contracts/identity.js";
import type { MutationResult } from "../../contracts/mutation.js";
import type { GitSnapshot } from "../../contracts/observation.js";
import { asRecord, assertExactKeys, parseBoundedString } from "../../contracts/validation.js";
import {
  createCycleHeadBranch,
  createRootHeadBranch,
} from "../../delivery/api/DeliveryInterface.js";
import type {
  GitRootReadInterface,
  GitWorkspaceInterface,
  CommitWorkspaceRequest,
  GitCommitProof,
  GitCommitProofBasis,
  PrepareWorkspaceRequest,
  CycleWorkspaceIdentity,
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
  readonly lock_reason: string | null;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mutation(
  request: Pick<PrepareWorkspaceRequest, "root_id" | "cycle_id" | "correlation_id">,
  outcome: MutationResult["outcome"],
  reason?: string,
): MutationResult {
  return outcome === "applied"
    ? { schema_version: 1, outcome, target_id: request.cycle_id, correlation_id: request.correlation_id }
    : { schema_version: 1, outcome, target_id: request.cycle_id, correlation_id: request.correlation_id, reason: reason ?? outcome };
}

function parseWorktrees(output: Buffer): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: {
    path: string;
    revision: string | null;
    branch: string | null;
    lock_reason: string | null;
  } | null = null;
  for (const field of output.toString("utf8").split("\0")) {
    if (field.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = {
        path: field.slice("worktree ".length),
        revision: null,
        branch: null,
        lock_reason: null,
      };
    } else if (current && field.startsWith("HEAD ")) {
      current.revision = field.slice("HEAD ".length);
    } else if (current && field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length);
    } else if (current && field.startsWith("locked")) {
      current.lock_reason = field.slice("locked".length).trim() || "";
    }
  }
  if (current) entries.push(current);
  return entries;
}

function commitMessage(cycleId: CycleIssueId, proof: GitCommitProofBasis): string {
  const encoded = Buffer.from(JSON.stringify(proof), "utf8").toString("base64url");
  return `symphony: complete ${cycleId}\n\nSymphony-Commit-Proof: ${encoded}`;
}

function parseProof(value: unknown): GitCommitProofBasis {
  const record = asRecord(value);
  assertExactKeys(record, [
    "cycle_id", "specification_seal_digest", "graph_seal_digest", "work_completion_set_digest",
  ]);
  const digest = (entry: unknown, code: string) => {
    const parsed = parseBoundedString(entry, code, 64);
    if (!/^[0-9a-f]{64}$/u.test(parsed)) throw new Error(code);
    return parsed;
  };
  return Object.freeze({
    cycle_id: parseTaskIssueId(record.cycle_id),
    specification_seal_digest: digest(record.specification_seal_digest, "invalid_commit_specification_seal"),
    graph_seal_digest: digest(record.graph_seal_digest, "invalid_commit_graph_seal"),
    work_completion_set_digest: digest(record.work_completion_set_digest, "invalid_commit_completion_set"),
  });
}

export class GitWorktree implements GitWorkspaceInterface, GitRootReadInterface {
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

  pathFor(cycleId: CycleIssueId): string {
    const encoded = Buffer.from(parseCycleIssueId(cycleId), "utf8").toString("hex");
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
    const expectedPath = this.pathFor(request.cycle_id);
    const expectedLockReason = `symphony:${request.cycle_id}`;
    const atPath = entries.filter((entry) => path.normalize(entry.path) === expectedPath);
    if (
      atPath.length === 1
      && atPath[0]?.branch === null
      && atPath[0]?.lock_reason === expectedLockReason
    ) {
      try {
        const observation = await this.read(request);
        return observation.head_revision === expectedRevision && observation.workspace_state === "clean"
          ? mutation(normalized, "applied")
          : mutation(normalized, "readback_mismatch", "workspace_baseline_mismatch");
      } catch {
        return mutation(normalized, "readback_mismatch", "workspace_readback_mismatch");
      }
    }
    if (
      atPath.length > 0
      || entries.some(({ branch }) => branch === `refs/heads/${createCycleHeadBranch(request.cycle_id)}`)
      || await this.#exists(expectedPath)
    ) {
      return mutation(normalized, "not_applied", "workspace_conflict");
    }
    if (await this.#branchExists(request.head_branch)) return mutation(normalized, "not_applied", "branch_conflict");

    try {
      await this.#commands.run(this.repositoryPath, [
        "worktree", "add", "--lock", "--reason", `symphony:${request.cycle_id}`,
        "--detach", expectedPath, expectedRevision,
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

  async read(identity: CycleWorkspaceIdentity): Promise<GitSnapshot> {
    await this.#assertIdentity(identity);
    const expectedPath = this.pathFor(identity.cycle_id);
    const entries = (await this.#worktrees()).filter((entry) => path.normalize(entry.path) === expectedPath);
    if (entries.length !== 1) throw new Error("git_workspace_missing");
    const stat = await lstat(expectedPath).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("git_workspace_missing");
    if (path.normalize(await realpath(expectedPath)) !== expectedPath) throw new Error("git_workspace_identity_mismatch");
    if (
      entries[0]?.branch !== null
      || entries[0]?.lock_reason !== `symphony:${identity.cycle_id}`
    ) {
      throw new Error("git_workspace_identity_mismatch");
    }

    const [branchOutput, revisionOutput, status, digest] = await Promise.all([
      this.#commands.run(expectedPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]),
      this.#commands.run(expectedPath, ["rev-parse", "--verify", "HEAD^{commit}"]),
      this.#commands.run(expectedPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.#diffDigest(expectedPath),
    ]);
    const branch = branchOutput.toString("utf8").trim();
    if (branch !== "") throw new Error("git_workspace_identity_mismatch");
    return Object.freeze({
      repository_id: this.repositoryId,
      base_branch: identity.base_branch,
      head_branch: identity.head_branch,
      head_revision: parseRevision(revisionOutput.toString("utf8").trim()),
      workspace_state: status.length === 0 ? "clean" : "dirty",
      diff_digest: digest,
      pull_request: null,
    });
  }

  async readRoot(identity: RootWorkspaceIdentity): Promise<GitSnapshot> {
    await this.#assertRootIdentity(identity);
    const [branchOutput, revisionOutput, status, digest] = await Promise.all([
      this.#commands.run(this.repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.#commands.run(this.repositoryPath, [
        "rev-parse", "--verify", `refs/heads/${identity.base_branch}^{commit}`,
      ]),
      this.#commands.run(this.repositoryPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.#diffDigest(this.repositoryPath),
    ]);
    if (branchOutput.toString("utf8").trim() !== identity.base_branch) {
      throw new Error("git_repository_base_branch_mismatch");
    }
    return Object.freeze({
      repository_id: this.repositoryId,
      base_branch: identity.base_branch,
      head_branch: identity.head_branch,
      head_revision: parseRevision(revisionOutput.toString("utf8").trim()),
      workspace_state: status.length === 0 ? "clean" : "dirty",
      diff_digest: digest,
      pull_request: null,
    });
  }

  async deleteCycle(
    rootIdValue: RootIssueId,
    cycleIdValue: CycleIssueId,
    isLive: (rootId: RootIssueId) => boolean,
  ): Promise<void> {
    const rootId = parseRootIssueId(rootIdValue);
    const cycleId = parseCycleIssueId(cycleIdValue);
    if (isLive(rootId)) throw new Error("git_workspace_is_live");

    const expectedPath = this.pathFor(cycleId);
    const entries = (await this.#worktrees()).filter((entry) => path.normalize(entry.path) === expectedPath);
    if (entries.length === 0) {
      if (await this.#exists(expectedPath)) throw new Error("git_workspace_identity_mismatch");
      return;
    }
    if (
      entries.length !== 1
      || entries[0]?.branch !== null
      || entries[0]?.lock_reason !== `symphony:${cycleId}`
    ) {
      throw new Error("git_workspace_identity_mismatch");
    }

    const stat = await lstat(expectedPath).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("git_workspace_missing");
    if (path.normalize(await realpath(expectedPath)) !== expectedPath) {
      throw new Error("git_workspace_identity_mismatch");
    }
    const status = await this.#commands.run(expectedPath, [
      "status", "--porcelain=v1", "-z", "--untracked-files=all",
    ]);
    if (status.length > 0) throw new Error("git_workspace_dirty");

    try {
      await this.#commands.run(this.repositoryPath, ["worktree", "unlock", "--", expectedPath], [0, 1]);
      await this.#commands.run(this.repositoryPath, ["worktree", "remove", "--", expectedPath]);
    } catch {
      throw new Error("git_workspace_cleanup_failed");
    }
    if ((await this.#worktrees()).some((entry) => path.normalize(entry.path) === expectedPath)) {
      throw new Error("git_workspace_cleanup_readback_mismatch");
    }
    if (await this.#exists(expectedPath)) throw new Error("git_workspace_cleanup_readback_mismatch");
  }

  async deleteCycles(
    rootId: RootIssueId,
    cycleIds: readonly CycleIssueId[],
    isLive: (rootId: RootIssueId) => boolean,
  ): Promise<void> {
    for (const cycleId of cycleIds) await this.deleteCycle(rootId, cycleId, isLive);
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

    const worktreePath = this.pathFor(normalized.cycle_id);
    try {
      await this.#commands.run(worktreePath, ["add", "-A", "--"]);
      const staged = await this.read(normalized);
      if (
        staged.head_revision !== normalized.expected_head_revision
        || staged.workspace_state !== "dirty"
      ) return mutation(normalized, "precondition_failed", "staged_workspace_mismatch");
      await this.#commands.run(worktreePath, [
        "commit", "--no-gpg-sign", "-m",
        commitMessage(normalized.cycle_id, normalized.proof),
      ]);
    } catch {
      return this.#classifyFailedCommit(normalized);
    }
    const after = await this.read(normalized);
    return await this.#isCommitPostcondition(normalized, after)
      ? mutation(normalized, "applied")
      : mutation(normalized, "readback_mismatch", "commit_postcondition_mismatch");
  }

  async readCommitProof(
    identity: CycleWorkspaceIdentity,
    carryingObjectId: Revision,
  ): Promise<GitCommitProof> {
    await this.#assertIdentity(identity);
    const objectId = parseRevision(carryingObjectId);
    const worktreePath = this.pathFor(identity.cycle_id);
    const [parent, tree, message] = await Promise.all([
      this.#commands.run(worktreePath, ["rev-parse", "--verify", `${objectId}^1`]),
      this.#commands.run(worktreePath, ["rev-parse", "--verify", `${objectId}^{tree}`]),
      this.#commands.run(worktreePath, ["log", "-1", "--format=%B", objectId]),
    ]);
    const prefix = `symphony: complete ${identity.cycle_id}\n\nSymphony-Commit-Proof: `;
    const body = message.toString("utf8").trim();
    if (!body.startsWith(prefix) || body.slice(prefix.length).includes("\n")) {
      throw new Error("git_commit_proof_missing");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(body.slice(prefix.length), "base64url").toString("utf8"));
    } catch {
      throw new Error("git_commit_proof_invalid");
    }
    const proof = parseProof(decoded);
    const parentRevision = parseRevision(parent.toString("utf8").trim());
    return Object.freeze({
      ...proof,
      carrying_object_id: objectId,
      parent_revision: parentRevision,
      diff_digest: parseObservationDigest(`sha256:${createHash("sha256")
        .update(parentRevision, "utf8")
        .update("\0", "utf8")
        .update(tree.toString("utf8").trim(), "utf8")
        .digest("hex")}`),
    });
  }

  async #assertIdentity(identity: CycleWorkspaceIdentity): Promise<void> {
    if (
      parseRepositoryId(identity.repository_id) !== this.repositoryId
      || createCycleHeadBranch(parseCycleIssueId(identity.cycle_id)) !== identity.head_branch
    ) throw new Error("git_workspace_identity_mismatch");
    for (const branch of [identity.base_branch, identity.head_branch]) {
      parseBoundedString(branch, "invalid_git_branch", 255);
      await this.#commands.run(this.repositoryPath, ["check-ref-format", "--branch", branch]);
    }
  }

  async #assertRootIdentity(identity: RootWorkspaceIdentity): Promise<void> {
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
      const pathExists = await this.#exists(this.pathFor(request.cycle_id));
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
    try {
      const proof = await this.readCommitProof(request, observation.head_revision);
      if (
        proof.parent_revision !== request.expected_head_revision
        || proof.diff_digest !== request.expected_diff_digest
        || proof.cycle_id !== request.proof.cycle_id
        || proof.specification_seal_digest !== request.proof.specification_seal_digest
        || proof.graph_seal_digest !== request.proof.graph_seal_digest
        || proof.work_completion_set_digest !== request.proof.work_completion_set_digest
      ) return false;
      const confirmed = await this.read(request);
      return confirmed.workspace_state === "clean" && confirmed.head_revision === observation.head_revision;
    } catch {
      return false;
    }
  }

  async #diffDigest(worktreePath: string): Promise<ReturnType<typeof parseObservationDigest>> {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-git-index-"));
    const index = path.join(temporary, "index");
    const environment = { GIT_INDEX_FILE: index };
    try {
      const parent = parseRevision((await this.#commands.run(
        worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"], [0], environment,
      )).toString("utf8").trim());
      await this.#commands.run(worktreePath, ["read-tree", "HEAD"], [0], environment);
      await this.#commands.run(worktreePath, ["add", "-A", "--"], [0], environment);
      const tree = (await this.#commands.run(worktreePath, ["write-tree"], [0], environment))
        .toString("utf8").trim();
      return parseObservationDigest(`sha256:${createHash("sha256")
        .update(parent, "utf8").update("\0", "utf8").update(tree, "utf8").digest("hex")}`);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
