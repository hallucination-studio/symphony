import type { GitWorkspace } from "../../git-workspaces/internal/NativeGitWorkspaceImpl.js";
import { runCommand, type CommandResult } from "../../composition/CommandRunner.js";
import type {
  RootDeliveryCommand,
  RootDeliveryFacts,
  RootDeliveryFactsReader,
  RootDeliveryInterface,
  RootDeliveryResult,
} from "../api/RootDeliveryInterface.js";

type Runner = (
  executable: string,
  arguments_: string[],
  options?: { cwd?: string },
) => Promise<CommandResult>;

export class GitRootDeliveryImpl implements RootDeliveryInterface {
  constructor(
    private readonly runner: Runner = runCommand,
    private readonly factsReader?: RootDeliveryFactsReader,
  ) {}

  async deliver(input: RootDeliveryCommand): Promise<RootDeliveryResult>;
  async deliver(input: {
    workspace: GitWorkspace;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<RootDeliveryResult>;
  async deliver(input: RootDeliveryCommand | {
    workspace: GitWorkspace;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<RootDeliveryResult> {
    if ("expected" in input) {
      if (!this.factsReader) throw new Error("root_delivery_facts_reader_missing");
      validateText(input.title, 256, "title");
      validateText(input.body, 16_384, "body");
      const facts = await this.factsReader.readFreshFacts(input);
      this.#assertPreconditions(input, facts);
      if (facts.existing_delivery) return existingResult(facts.existing_delivery);
    }
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
      const url = validPullRequestUrl(created.stdout.trim());
      return url
        ? ({ kind: "pull_request", url } as const)
        : ({ kind: "remote_branch", branch: input.workspace.branch } as const);
    } catch {
      return { kind: "remote_branch", branch: input.workspace.branch } as const;
    }
  }

  #assertPreconditions(command: RootDeliveryCommand, facts: RootDeliveryFacts) {
    const expected = command.expected;
    const existing = facts.existing_delivery;
    const valid =
      facts.root_issue_id === command.rootIssueId &&
      (!command.workspace.rootIssueId || command.workspace.rootIssueId === command.rootIssueId) &&
      facts.root_version === expected.root_version &&
      facts.performer_id === expected.performer_id &&
      !facts.terminal &&
      facts.blocker_issue_ids.length === 0 &&
      facts.tree_digest === expected.tree_digest &&
      facts.tree_complete &&
      facts.git_head === expected.git_head &&
      facts.checks_digest === expected.checks_digest &&
      facts.checks_passed &&
      matchingSucceededCycle(expected, facts) &&
      (!existing ||
        (existing.branch === command.workspace.branch && existing.head === expected.git_head));
    if (!valid) throw new Error("root_delivery_precondition_failed");
  }

  async #existingPullRequest(workspace: GitWorkspace) {
    try {
      const result = await this.runner(
        "gh",
        ["pr", "list", "--head", workspace.branch, "--json", "url", "--limit", "1"],
        { cwd: workspace.worktreePath },
      );
      const parsed = JSON.parse(result.stdout) as Array<{ url?: string }>;
      return validPullRequestUrl(parsed[0]?.url);
    } catch {
      return undefined;
    }
  }
}

function matchingSucceededCycle(
  expected: RootDeliveryCommand["expected"],
  facts: RootDeliveryFacts,
): boolean {
  if (!expected.latest_succeeded_cycle && expected.owner_generation === undefined) return true;
  const cycle = expected.latest_succeeded_cycle;
  const observed = facts.latest_succeeded_cycle;
  return cycle !== undefined && observed !== undefined &&
    observed.issue_id === cycle.issue_id &&
    observed.verify_result_id === cycle.verify_result_id &&
    observed.verified_revision === cycle.verified_revision &&
    facts.git_head === observed.verified_revision &&
    expected.owner_generation !== undefined &&
    facts.owner_generation === expected.owner_generation;
}

function existingResult(delivery: NonNullable<RootDeliveryFacts["existing_delivery"]>): RootDeliveryResult {
  if (delivery.kind === "pull_request") {
    const url = validPullRequestUrl(delivery.url);
    if (!url) {
      throw new Error("root_delivery_precondition_failed");
    }
    return { kind: "pull_request", url };
  }
  return { kind: delivery.kind, branch: delivery.branch };
}

function validPullRequestUrl(value: string | undefined) {
  return value && /^https:\/\/[^\s]+$/u.test(value) && value.length <= 2048
    ? value
    : undefined;
}

function validateText(value: string, cap: number, field: string) {
  if ([...value].length > cap) throw new Error(`root_delivery_${field}_too_long`);
}
