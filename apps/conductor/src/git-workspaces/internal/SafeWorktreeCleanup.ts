import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../../composition/CommandRunner.js";
import type { GitWorktreeCleanupInput } from "../api/GitWorkspaceInterface.js";

export class SafeWorktreeCleanup {
  constructor(
    private readonly repositoryRoot: string,
    private readonly worktreeRoot: string,
  ) {}

  async cleanup(input: GitWorktreeCleanupInput): Promise<{ kind: "removed" }> {
    if (!input.terminal && !input.explicitlyAuthorized) {
      throw new Error("git_worktree_cleanup_not_authorized");
    }
    if (input.hasLiveWriter) throw new Error("git_worktree_cleanup_live_writer");
    if (input.hasActivePermit) throw new Error("git_worktree_cleanup_active_permit");
    if (!input.deliveryProven) throw new Error("git_worktree_cleanup_delivery_unproven");

    const repository = await realpath(this.repositoryRoot);
    const worktreeRoot = await realpath(this.worktreeRoot);
    const worktree = await realpath(input.workspace.worktreePath);
    const home = await realpath(homedir());
    if (unsafeCleanupPath(worktree, repository, worktreeRoot, home)) {
      throw new Error("git_worktree_cleanup_path_unsafe");
    }
    const [topLevel, commonDir, branch, status] = await Promise.all([
      git(worktree, ["rev-parse", "--show-toplevel"]),
      git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(worktree, ["branch", "--show-current"]),
      git(worktree, ["status", "--porcelain=v1"]),
    ]);
    if (await realpath(topLevel) !== worktree
      || path.dirname(await realpath(commonDir)) !== repository
      || branch !== input.workspace.branch) {
      throw new Error("git_worktree_cleanup_identity_mismatch");
    }
    if (status) throw new Error("git_worktree_cleanup_dirty");
    let ahead: string;
    try {
      ahead = await git(worktree, ["rev-list", "--count", "@{upstream}..HEAD"]);
    } catch {
      throw new Error("git_worktree_cleanup_upstream_unproven");
    }
    if (ahead !== "0") throw new Error("git_worktree_cleanup_unpushed_commits");

    await runCommand("git", ["-C", repository, "worktree", "remove", "--", worktree]);
    await runCommand("git", ["-C", repository, "worktree", "prune"]);
    return { kind: "removed" };
  }
}

export function unsafeCleanupPath(
  worktree: string,
  repository: string,
  worktreeRoot: string,
  home: string,
): boolean {
  return worktree === repository || worktree === worktreeRoot || worktree === home
    || path.dirname(worktree) !== worktreeRoot;
}

async function git(worktree: string, args: string[]): Promise<string> {
  return (await runCommand("git", ["-C", worktree, ...args])).stdout.trim();
}
