import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../../composition/CommandRunner.js";
import type {
  BoundedGitItems,
  GitWorkspace,
  GitWorkspaceInterface,
  GitWorkspaceSnapshot,
  GitWorktreeCleanupInput,
  GitWorktreeCleanupInterface,
  RootWorktreeGateInspection,
  RootWorktreeGateResult,
  ValidRootWorktreeGateInspection,
} from "../api/GitWorkspaceInterface.js";
import { SafeWorktreeCleanup } from "./SafeWorktreeCleanup.js";

export type { GitWorkspace } from "../api/GitWorkspaceInterface.js";

export class NativeGitWorkspaceImpl implements GitWorkspaceInterface, GitWorktreeCleanupInterface {
  constructor(
    private readonly repositoryRoot: string,
    private readonly worktreeRoot: string,
    private readonly checkCommands: Readonly<Record<string, readonly [string, string[]]>> = {},
    private readonly commitRunner: typeof runCommand = runCommand,
  ) {}

  async inspectRootWorktreeGate(input: {
    repositoryIdentity: string;
    rootIssueId: string;
    rootIdentifier: string;
    baseBranch: string;
    generationOrdinal: number;
    executionKind: "fresh" | "existing";
    requiredRevisions: string[];
  }): Promise<RootWorktreeGateInspection> {
    const repositoryRoot = await realpath(this.repositoryRoot);
    if (!Number.isSafeInteger(input.generationOrdinal) || input.generationOrdinal < 1) {
      throw new Error("git_workspace_generation_ordinal_invalid");
    }
    const branch = rootBranch(input.rootIdentifier, input.generationOrdinal);
    const worktreePath = rootWorktreePath(this.worktreeRoot, input.rootIssueId, input.generationOrdinal);
    if (await pathExists(worktreePath)) {
      const identity = await this.#worktreeIdentity(worktreePath);
      if (
        !identity ||
        identity.repositoryRoot !== repositoryRoot ||
        identity.worktreeRoot !== await realpath(worktreePath) ||
        identity.branch !== branch
      ) {
        return { result: invalidGate(input.repositoryIdentity, input.generationOrdinal, branch, "worktree_identity_conflict") };
      }
      const workspace = { branch, worktreePath, rootIssueId: input.rootIssueId };
      const [snapshot, changedPaths] = await Promise.all([
        this.inspect(workspace),
        this.#changedPaths(workspace),
      ]);
      if (snapshot.status.partial || snapshot.status.has_more || changedPaths.partial || changedPaths.has_more) {
        return { result: invalidGate(input.repositoryIdentity, input.generationOrdinal, branch, "git_evidence_incomplete") };
      }
      return {
        result: {
          kind: "valid" as const,
          repositoryIdentity: input.repositoryIdentity,
          branch,
          headRevision: snapshot.head,
          isClean: changedPaths.items.length === 0,
          changedPaths: changedPaths.items,
        },
        workspace,
        snapshot,
      };
    }

    const headRevision = await this.#revision(branch);
    if (input.executionKind === "fresh" && !headRevision) {
      const baseRevision = await this.#revision(input.baseBranch);
      if (!baseRevision) {
        return { result: invalidGate(input.repositoryIdentity, input.generationOrdinal, branch, "git_evidence_incomplete") };
      }
      return {
        result: {
          kind: "fresh_missing" as const,
          repositoryIdentity: input.repositoryIdentity,
          generationOrdinal: input.generationOrdinal,
          branch,
          baseBranch: input.baseBranch,
          baseRevision,
        },
      };
    }

    if (input.executionKind === "fresh") {
      return { result: invalidGate(input.repositoryIdentity, input.generationOrdinal, branch, "generation_branch_conflict") };
    }

    if (!headRevision) {
      return { result: invalidGate(input.repositoryIdentity, input.generationOrdinal, branch, "branch_missing") };
    }
    for (const revision of input.requiredRevisions) {
      if (!safeRevision(revision) || !await this.#isAncestor(revision, branch)) {
        return { result: invalidGate(input.repositoryIdentity, input.generationOrdinal, branch, "required_commit_unreachable") };
      }
    }
    return {
      result: {
        kind: "recoverable_missing" as const,
        repositoryIdentity: input.repositoryIdentity,
        generationOrdinal: input.generationOrdinal,
        branch,
        headRevision,
      },
    };
  }

  async materializeRootWorkspace(input: {
    repositoryIdentity: string;
    rootIssueId: string;
    rootIdentifier: string;
    baseBranch: string;
    generationOrdinal: number;
    expectedGate: Extract<RootWorktreeGateResult, { kind: "fresh_missing" | "recoverable_missing" }>;
  }): Promise<ValidRootWorktreeGateInspection> {
    const current = await this.inspectRootWorktreeGate({
      repositoryIdentity: input.repositoryIdentity,
      rootIssueId: input.rootIssueId,
      rootIdentifier: input.rootIdentifier,
      baseBranch: input.baseBranch,
      generationOrdinal: input.generationOrdinal,
      executionKind: input.expectedGate.kind === "fresh_missing" ? "fresh" : "existing",
      requiredRevisions: input.expectedGate.kind === "recoverable_missing" ? [input.expectedGate.headRevision] : [],
    });
    if (!sameWorktreeGate(current.result, input.expectedGate)) {
      throw new Error("git_workspace_gate_stale");
    }
    const repositoryRoot = await realpath(this.repositoryRoot);
    const branch = rootBranch(input.rootIdentifier, input.generationOrdinal);
    const worktreePath = rootWorktreePath(this.worktreeRoot, input.rootIssueId, input.generationOrdinal);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    if (input.expectedGate.kind === "recoverable_missing") {
      await runCommand("git", ["-C", repositoryRoot, "worktree", "add", worktreePath, branch]);
    } else {
      await runCommand("git", ["-C", repositoryRoot, "worktree", "add", "-b", branch, worktreePath, input.expectedGate.baseRevision]);
    }
    const readBack = await this.inspectRootWorktreeGate({
      repositoryIdentity: input.repositoryIdentity,
      rootIssueId: input.rootIssueId,
      rootIdentifier: input.rootIdentifier,
      baseBranch: input.baseBranch,
      generationOrdinal: input.generationOrdinal,
      executionKind: "existing",
      requiredRevisions: [input.expectedGate.kind === "fresh_missing" ? input.expectedGate.baseRevision : input.expectedGate.headRevision],
    });
    if (!("workspace" in readBack)) throw new Error("git_workspace_read_back_invalid");
    return readBack;
  }

  async readCommitUrl(input: { workspace: GitWorkspace; revision: string }): Promise<string> {
    if (!safeRevision(input.revision)) throw new Error("git_commit_revision_invalid");
    const snapshot = await this.inspect(input.workspace);
    if (snapshot.head !== input.revision) throw new Error("git_commit_revision_stale");
    const remote = await runCommand("git", ["remote", "get-url", "origin"], {
      cwd: input.workspace.worktreePath,
    });
    const repositoryUrl = githubRepositoryUrl(remote.stdout.trim());
    if (!repositoryUrl) throw new Error("git_commit_remote_unsupported");
    return `${repositoryUrl}/commit/${input.revision}`;
  }

  async inspect(workspace: GitWorkspace): Promise<GitWorkspaceSnapshot> {
    await this.#assertWorkspaceIdentity(workspace);
    const [head, status] = await Promise.all([
      runCommand("git", ["-C", workspace.worktreePath, "rev-parse", "HEAD"]),
      runCommand("git", ["-C", workspace.worktreePath, "status", "--porcelain=v1"]),
    ]);
    return {
      head: head.stdout.trim(),
      branch: workspace.branch,
      status: boundedLines(status.stdout, 512),
    };
  }

  async #changedPaths(workspace: GitWorkspace): Promise<BoundedGitItems<string>> {
    await this.#assertWorkspaceIdentity(workspace);
    const [unstaged, staged, untracked] = await Promise.all([
      runCommand("git", ["-C", workspace.worktreePath, "diff", "--name-only", "--no-renames", "-z"]),
      runCommand("git", ["-C", workspace.worktreePath, "diff", "--cached", "--name-only", "--no-renames", "-z"]),
      runCommand("git", ["-C", workspace.worktreePath, "ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const paths = [...new Set([unstaged.stdout, staged.stdout, untracked.stdout]
      .flatMap((value) => value.split("\0").filter(Boolean)))].sort();
    return boundedItems(paths, 512);
  }

  async diff(workspace: GitWorkspace, options: { staged?: boolean; path?: string; fromRevision?: string; toRevision?: string } = {}) {
    await this.#assertWorkspaceIdentity(workspace);
    if (options.path !== undefined && !safeRelativePath(options.path)) {
      throw new Error("git_diff_path_out_of_scope");
    }
    if ((options.fromRevision !== undefined && !safeRevision(options.fromRevision))
      || (options.toRevision !== undefined && !safeRevision(options.toRevision))) {
      throw new Error("git_diff_revision_invalid");
    }
    const result = await runCommand("git", [
      "-C",
      workspace.worktreePath,
      "diff",
      "--no-ext-diff",
      ...(options.fromRevision === undefined ? [] : [options.fromRevision, options.toRevision ?? "HEAD"]),
      ...(options.staged ? ["--cached"] : []),
      ...(options.path ? ["--", options.path] : []),
    ]);
    const cap = 65_536;
    const bytes = Buffer.byteLength(result.stdout, "utf8");
    return {
      text: truncateUtf8(result.stdout, cap),
      bytes: Math.min(bytes, cap),
      cap,
      partial: bytes > cap,
    };
  }

  async restoreWorktree(workspace: GitWorkspace, expectedHead: string) {
    if (!workspace.rootIssueId || path.resolve(workspace.worktreePath) !== path.resolve(path.join(this.worktreeRoot, workspace.rootIssueId))) {
      throw new Error("git_restore_workspace_scope_invalid");
    }
    await this.#assertWorkspaceIdentity(workspace);
    if (!safeRevision(expectedHead)) throw new Error("git_restore_revision_invalid");
    const snapshot = await this.inspect(workspace);
    if (snapshot.head !== expectedHead) throw new Error("git_restore_head_changed");
    await runCommand("git", ["-C", workspace.worktreePath, "restore", "--source", expectedHead, "--staged", "--worktree", "--", "."]);
    await runCommand("git", ["-C", workspace.worktreePath, "clean", "-fd", "--", "."]);
    const restored = await this.inspect(workspace);
    if (restored.head !== expectedHead || restored.status.items.length > 0 || restored.status.partial || restored.status.has_more) {
      throw new Error("git_restore_read_back_invalid");
    }
    return { kind: "restored" as const };
  }

  async checks(workspace: GitWorkspace, names: string[]) {
    await this.#assertWorkspaceIdentity(workspace);
    if (names.length > 32) throw new Error("git_checks_cap_exceeded");
    const items: Array<{ name: string; status: "passed" | "failed" }> = [];
    for (const name of names) {
      const command = this.checkCommands[name];
      if (!command) throw new Error("git_check_unknown");
      try {
        await runCommand(command[0], command[1], { cwd: workspace.worktreePath });
        items.push({ name, status: "passed" });
      } catch {
        items.push({ name, status: "failed" });
      }
    }
    return boundedItems(items, 32);
  }

  async commit(input: {
    workspace: GitWorkspace;
    rootIssueId: string;
    issueId: string;
    allowedIssueIds: string[];
    issueIdentifier: string;
    expectedHead: string;
  }) {
    if (input.workspace.rootIssueId && input.workspace.rootIssueId !== input.rootIssueId) {
      throw new Error("git_commit_root_identity_mismatch");
    }
    if (!input.allowedIssueIds.includes(input.issueId)) {
      throw new Error("git_commit_issue_out_of_scope");
    }
    await this.#assertWorkspaceIdentity(input.workspace);
    const snapshot = await this.inspect(input.workspace);
    if (snapshot.head !== input.expectedHead) throw new Error("git_commit_head_stale");
    const message = `${input.issueIdentifier}: Symphony work`;
    await runCommand("git", ["-C", input.workspace.worktreePath, "add", "--all"]);
    const status = await runCommand("git", ["-C", input.workspace.worktreePath, "status", "--porcelain"]);
    if (!status.stdout.trim()) return { kind: "no_changes" as const, commit: snapshot.head };
    try {
      await this.commitRunner("git", ["-C", input.workspace.worktreePath, "commit", "-m", message]);
    } catch (error) {
      const readBack = await this.#readCommitOutcome(input.workspace, input.expectedHead, message);
      if (readBack) return { kind: "committed" as const, commit: readBack };
      throw error;
    }
    const readBack = await this.#readCommitOutcome(input.workspace, input.expectedHead, message);
    if (!readBack) throw new Error("git_commit_unconfirmed");
    return { kind: "committed" as const, commit: readBack };
  }

  cleanup(input: GitWorktreeCleanupInput) {
    return new SafeWorktreeCleanup(this.repositoryRoot, this.worktreeRoot).cleanup(input);
  }

  async commitWork(workspace: GitWorkspace, message: string) {
    await runCommand("git", ["-C", workspace.worktreePath, "add", "--all"]);
    const status = await runCommand("git", [
      "-C",
      workspace.worktreePath,
      "status",
      "--porcelain",
    ]);
    if (!status.stdout.trim()) {
      const head = await runCommand("git", [
        "-C",
        workspace.worktreePath,
        "rev-parse",
        "HEAD",
      ]);
      return { kind: "no_changes", commit: head.stdout.trim() } as const;
    }
    await runCommand("git", [
      "-C",
      workspace.worktreePath,
      "commit",
      "-m",
      message,
    ]);
    const head = await runCommand("git", [
      "-C",
      workspace.worktreePath,
      "rev-parse",
      "HEAD",
    ]);
    return { kind: "committed", commit: head.stdout.trim() } as const;
  }

  async #revision(revision: string) {
    if (!safeRevision(revision)) return undefined;
    try {
      const result = await runCommand("git", ["-C", this.repositoryRoot, "rev-parse", "--verify", `${revision}^{commit}`]);
      return result.stdout.trim();
    } catch {
      return undefined;
    }
  }

  async #isAncestor(revision: string, branch: string) {
    try {
      await runCommand("git", ["-C", this.repositoryRoot, "merge-base", "--is-ancestor", revision, branch]);
      return true;
    } catch {
      return false;
    }
  }

  async #worktreeIdentity(worktreePath: string) {
    try {
      const root = await runCommand("git", [
        "-C",
        worktreePath,
        "rev-parse",
        "--show-toplevel",
      ]);
      const common = await runCommand("git", [
        "-C",
        worktreePath,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      const branch = await runCommand("git", [
        "-C",
        worktreePath,
        "branch",
        "--show-current",
      ]);
      return {
        repositoryRoot: path.dirname(common.stdout.trim()),
        worktreeRoot: root.stdout.trim(),
        branch: branch.stdout.trim(),
      };
    } catch {
      return undefined;
    }
  }

  async #assertWorkspaceIdentity(workspace: GitWorkspace) {
    const expectedRepository = await realpath(this.repositoryRoot);
    const expectedWorktree = await realpath(workspace.worktreePath);
    const identity = await this.#worktreeIdentity(expectedWorktree);
    if (
      !identity ||
      identity.repositoryRoot !== expectedRepository ||
      identity.worktreeRoot !== expectedWorktree ||
      identity.branch !== workspace.branch
    ) {
      throw new Error("git_workspace_identity_conflict");
    }
  }

  async #readCommitOutcome(workspace: GitWorkspace, previousHead: string, message: string) {
    try {
      const [head, subject] = await Promise.all([
        runCommand("git", ["-C", workspace.worktreePath, "rev-parse", "HEAD"]),
        runCommand("git", ["-C", workspace.worktreePath, "log", "-1", "--format=%s"]),
      ]);
      const currentHead = head.stdout.trim();
      return currentHead !== previousHead && subject.stdout.trim() === message
        ? currentHead
        : undefined;
    } catch {
      throw new Error("git_commit_unconfirmed");
    }
  }
}

function boundedLines(value: string, cap: number): BoundedGitItems<string> {
  const lines = value.split("\n").filter(Boolean);
  return boundedItems(lines.slice(0, cap), cap, lines.length > cap);
}

function boundedItems<T>(items: T[], cap: number, hasMore = false): BoundedGitItems<T> {
  return { items, returned: items.length, cap, has_more: hasMore, partial: hasMore };
}

function truncateUtf8(value: string, cap: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= cap) return value;
  return bytes.subarray(0, cap).toString("utf8").replace(/\uFFFD$/u, "");
}

function safeRelativePath(value: string) {
  if (!value || value.includes("\0") || path.isAbsolute(value)) return false;
  return !value.split(/[\\/]/u).some((part) => part === "..");
}

function safeRevision(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value);
}

function githubRepositoryUrl(value: string): string | undefined {
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(value);
  if (ssh) return `https://github.com/${ssh[1]}`;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash) return undefined;
    const repository = url.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
      ? `https://github.com/${repository}`
      : undefined;
  } catch {
    return undefined;
  }
}

function rootBranch(rootIdentifier: string, generationOrdinal: number): string {
  const rootBranch = `symphony/runs/${rootIdentifier.toLowerCase()}`;
  return generationOrdinal === 1 ? rootBranch : `${rootBranch}-g${generationOrdinal}`;
}

function rootWorktreePath(worktreeRoot: string, rootIssueId: string, generationOrdinal: number): string {
  const rootPath = path.join(worktreeRoot, rootIssueId);
  return generationOrdinal === 1 ? rootPath : path.join(worktreeRoot, `${rootIssueId}-g${generationOrdinal}`);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function invalidGate(
  repositoryIdentity: string,
  _generationOrdinal: number,
  expectedBranch: string,
  reason: "worktree_identity_conflict" | "generation_branch_conflict" | "branch_missing" | "required_commit_unreachable" | "git_evidence_incomplete",
) {
  return {
    kind: "execution_generation_invalid" as const,
    repositoryIdentity,
    expectedBranch,
    reason,
  };
}

function sameWorktreeGate(
  actual: RootWorktreeGateResult,
  expected: Extract<RootWorktreeGateResult, { kind: "fresh_missing" | "recoverable_missing" }>,
): boolean {
  if (actual.kind !== expected.kind || actual.repositoryIdentity !== expected.repositoryIdentity) return false;
  return actual.kind === "fresh_missing" && expected.kind === "fresh_missing"
    ? actual.generationOrdinal === expected.generationOrdinal && actual.branch === expected.branch &&
      actual.baseBranch === expected.baseBranch && actual.baseRevision === expected.baseRevision
    : actual.kind === "recoverable_missing" && expected.kind === "recoverable_missing" &&
      actual.generationOrdinal === expected.generationOrdinal && actual.branch === expected.branch &&
      actual.headRevision === expected.headRevision;
}
