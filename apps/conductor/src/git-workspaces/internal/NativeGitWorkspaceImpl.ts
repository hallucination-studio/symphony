import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../../composition/CommandRunner.js";
import type {
  BoundedGitItems,
  GitWorkspace,
  GitWorkspaceInterface,
  GitWorkspaceSnapshot,
} from "../api/GitWorkspaceInterface.js";

export type { GitWorkspace } from "../api/GitWorkspaceInterface.js";

export class NativeGitWorkspaceImpl implements GitWorkspaceInterface {
  constructor(
    private readonly repositoryRoot: string,
    private readonly worktreeRoot: string,
    private readonly checkCommands: Readonly<Record<string, readonly [string, string[]]>> = {},
  ) {}

  async ensureWorkspace(input: {
    rootIssueId: string;
    rootIdentifier: string;
    baseBranch: string;
  }): Promise<GitWorkspace> {
    const repositoryRoot = await realpath(this.repositoryRoot);
    const branch = `symphony/runs/${input.rootIdentifier.toLowerCase()}`;
    const worktreePath = path.join(this.worktreeRoot, input.rootIssueId);
    await mkdir(this.worktreeRoot, { recursive: true });

    const existing = await this.#worktreeIdentity(worktreePath);
    if (existing) {
      if (existing.repositoryRoot !== repositoryRoot || existing.branch !== branch) {
        throw new Error("git_workspace_identity_conflict");
      }
      return { branch, worktreePath, rootIssueId: input.rootIssueId };
    }

    const branchExists = await this.#branchExists(branch);
    const arguments_ = ["-C", repositoryRoot, "worktree", "add"];
    if (branchExists) {
      arguments_.push(worktreePath, branch);
    } else {
      arguments_.push("-b", branch, worktreePath, input.baseBranch);
    }
    await runCommand("git", arguments_);
    return { branch, worktreePath, rootIssueId: input.rootIssueId };
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

  async diff(workspace: GitWorkspace, options: { staged?: boolean } = {}) {
    await this.#assertWorkspaceIdentity(workspace);
    const result = await runCommand("git", [
      "-C",
      workspace.worktreePath,
      "diff",
      "--no-ext-diff",
      ...(options.staged ? ["--cached"] : []),
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
    return this.commitWork(input.workspace, `${input.issueIdentifier}: Symphony work`);
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

  async #branchExists(branch: string) {
    try {
      await runCommand("git", [
        "-C",
        this.repositoryRoot,
        "show-ref",
        "--verify",
        `refs/heads/${branch}`,
      ]);
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
