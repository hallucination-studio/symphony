import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../../composition/CommandRunner.js";

export interface GitWorkspace {
  branch: string;
  worktreePath: string;
}

export class NativeGitWorkspaceImpl {
  constructor(
    private readonly repositoryRoot: string,
    private readonly worktreeRoot: string,
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
      return { branch, worktreePath };
    }

    const branchExists = await this.#branchExists(branch);
    const arguments_ = ["-C", repositoryRoot, "worktree", "add"];
    if (branchExists) {
      arguments_.push(worktreePath, branch);
    } else {
      arguments_.push("-b", branch, worktreePath, input.baseBranch);
    }
    await runCommand("git", arguments_);
    return { branch, worktreePath };
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
}
