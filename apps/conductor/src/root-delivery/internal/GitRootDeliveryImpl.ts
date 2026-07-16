import type { GitWorkspace } from "../../git-workspaces/internal/NativeGitWorkspaceImpl.js";
import { runCommand, type CommandResult } from "../../composition/CommandRunner.js";

type Runner = (
  executable: string,
  arguments_: string[],
  options?: { cwd?: string },
) => Promise<CommandResult>;

export class GitRootDeliveryImpl {
  constructor(private readonly runner: Runner = runCommand) {}

  async deliver(input: {
    workspace: GitWorkspace;
    baseBranch: string;
    title: string;
    body: string;
  }) {
    const existing = await this.#existingPullRequest(input.workspace);
    if (existing) return { kind: "pull_request", url: existing } as const;

    try {
      await this.runner(
        "git",
        ["push", "--set-upstream", "origin", input.workspace.branch],
        { cwd: input.workspace.worktreePath },
      );
    } catch {
      return { kind: "local_branch", branch: input.workspace.branch } as const;
    }

    try {
      const created = await this.runner(
        "gh",
        [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.workspace.branch,
          "--title",
          input.title,
          "--body",
          input.body,
        ],
        { cwd: input.workspace.worktreePath },
      );
      const url = created.stdout.trim();
      return url
        ? ({ kind: "pull_request", url } as const)
        : ({ kind: "remote_branch", branch: input.workspace.branch } as const);
    } catch {
      return { kind: "remote_branch", branch: input.workspace.branch } as const;
    }
  }

  async #existingPullRequest(workspace: GitWorkspace) {
    try {
      const result = await this.runner(
        "gh",
        ["pr", "list", "--head", workspace.branch, "--json", "url", "--limit", "1"],
        { cwd: workspace.worktreePath },
      );
      const parsed = JSON.parse(result.stdout) as Array<{ url?: string }>;
      return parsed[0]?.url;
    } catch {
      return undefined;
    }
  }
}
