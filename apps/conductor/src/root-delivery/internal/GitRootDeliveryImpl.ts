import type { CommandResult } from "../../composition/CommandRunner.js";
import { runCommand } from "../../composition/CommandRunner.js";
import type { GitWorkspaceInterface, GitWorkspaceProvisionerInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootDeliveryCommand, RootDeliveryInterface, RootDeliveryResult } from "../api/RootDeliveryInterface.js";

type Runner = (executable: string, arguments_: string[], options?: { cwd?: string }) => Promise<CommandResult>;
type DeliveryGit = GitWorkspaceInterface & Pick<GitWorkspaceProvisionerInterface, "readCommitUrl">;

const VERIFIED_REVISION_TITLE = "Verified Git revision";
const DELIVERY_PR_TITLE = "Delivery pull request";

export class GitRootDeliveryImpl implements RootDeliveryInterface {
  constructor(
    private readonly linear: LinearGatewayInterface,
    private readonly git: DeliveryGit,
    private readonly runner: Runner = runCommand,
  ) {}

  async deliver(command: RootDeliveryCommand): Promise<RootDeliveryResult> {
    validateText(command.title, 256, "title");
    validateText(command.body, 16_384, "body");
    if (!("workspace" in command.view)) throw new Error("root_delivery_worktree_invalid");
    const workspace = command.view.workspace;
    const expected = deliveryFacts(command.view.tree, command.view.root.issueId);
    const freshTree = await this.linear.readWorkflowIssueTree(command.view.root.issueId);
    const fresh = deliveryFacts(freshTree, command.view.root.issueId);
    if (!sameNativeFacts(expected, fresh) || !freshTree.coverage.is_complete) {
      throw new Error("root_delivery_native_precondition_failed");
    }

    const snapshot = await this.git.inspect(workspace);
    if (snapshot.head !== fresh.revision || snapshot.branch !== workspace.branch ||
        snapshot.status.partial || snapshot.status.has_more || snapshot.status.items.length !== 0) {
      throw new Error("root_delivery_git_precondition_failed");
    }
    const commitUrl = await this.git.readCommitUrl({ workspace, revision: fresh.revision });
    if (commitUrl !== fresh.revisionUrl) throw new Error("root_delivery_revision_attachment_mismatch");

    let pullRequest = await this.readPullRequest(command, workspace, fresh.revision);
    if (!pullRequest) {
      await this.runner("git", ["push", "--set-upstream", "origin", workspace.branch], {
        cwd: workspace.worktreePath,
      });
      await this.assertRemoteBranch(workspace, fresh.revision);
      await this.runner("gh", [
        "pr", "create", "--base", command.baseBranch, "--head", workspace.branch,
        "--title", command.title, "--body", command.body,
      ], { cwd: workspace.worktreePath });
      pullRequest = await this.readPullRequest(command, workspace, fresh.revision);
      if (!pullRequest) throw new Error("root_delivery_pr_read_back_failed");
    }

    let tree = freshTree;
    const root = issue(tree, command.view.root.issueId);
    const links = matchingAttachments(tree, root.issue_id, DELIVERY_PR_TITLE, pullRequest.url);
    if (links.length > 1) throw new Error("root_delivery_pr_attachment_ambiguous");
    if (links.length === 0) {
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_workflow_attachment",
        writeId: `${command.directive.rootDirectiveId}:delivery-pr`,
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: root.issue_id,
          expectedRemoteVersion: root.remote_version,
          expectedStatusId: root.status_id,
          expectedIsArchived: false,
        },
        title: DELIVERY_PR_TITLE,
        url: pullRequest.url,
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
        throw new Error(`root_delivery_pr_attachment_${outcome.kind}`);
      }
      tree = await this.linear.readWorkflowIssueTree(root.issue_id);
    }
    if (matchingAttachments(tree, root.issue_id, DELIVERY_PR_TITLE, pullRequest.url).length !== 1) {
      throw new Error("root_delivery_pr_attachment_read_back_failed");
    }

    const currentRoot = issue(tree, root.issue_id);
    if (currentRoot.status_name !== "In Progress" || currentRoot.is_archived) {
      throw new Error("root_delivery_root_state_invalid");
    }
    const inReview = tree.status_catalog.find(({ name }) => name === "In Review");
    if (!inReview) throw new Error("root_delivery_in_review_status_missing");
    const outcome = await this.linear.mutateWorkflow({
      kind: "update_workflow_issue",
      writeId: `${command.directive.rootDirectiveId}:delivery-in-review`,
      expectedProjectId: currentRoot.project_id,
      rootIssueId: currentRoot.issue_id,
      expectedRootRemoteVersion: currentRoot.remote_version,
      target: {
        targetIssueId: currentRoot.issue_id,
        expectedRemoteVersion: currentRoot.remote_version,
        expectedStatusId: currentRoot.status_id,
        expectedIsArchived: false,
      },
      statusId: inReview.status_id,
      title: currentRoot.title,
      description: currentRoot.description,
      labelNames: currentRoot.labels,
      isArchived: false,
      parentAssignment: { mode: "retain" },
      order: currentRoot.order,
    });
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      throw new Error(`root_delivery_status_${outcome.kind}`);
    }
    const readBack = await this.linear.readWorkflowIssueTree(currentRoot.issue_id);
    if (issue(readBack, currentRoot.issue_id).status_name !== "In Review" ||
        matchingAttachments(readBack, currentRoot.issue_id, DELIVERY_PR_TITLE, pullRequest.url).length !== 1) {
      throw new Error("root_delivery_status_read_back_failed");
    }
    return { kind: "pull_request", url: pullRequest.url };
  }

  private async readPullRequest(command: RootDeliveryCommand, workspace: { branch: string; worktreePath: string }, revision: string) {
    const result = await this.runner("gh", [
      "pr", "list", "--head", workspace.branch, "--state", "open",
      "--json", "url,headRefName,headRefOid,baseRefName", "--limit", "2",
    ], { cwd: workspace.worktreePath });
    const values = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(values) || values.length > 1) throw new Error("root_delivery_pr_ambiguous");
    const value = values[0] as Record<string, unknown> | undefined;
    if (!value) return undefined;
    const url = validPullRequestUrl(value.url);
    if (!url || value.headRefName !== workspace.branch || value.headRefOid !== revision || value.baseRefName !== command.baseBranch) {
      throw new Error("root_delivery_pr_precondition_failed");
    }
    return { url };
  }

  private async assertRemoteBranch(workspace: { branch: string; worktreePath: string }, revision: string): Promise<void> {
    const result = await this.runner("git", ["ls-remote", "--heads", "origin", workspace.branch], {
      cwd: workspace.worktreePath,
    });
    const matches = result.stdout.trim().split("\n").filter(Boolean);
    if (matches.length !== 1 || matches[0]?.split(/\s+/u)[0] !== revision) {
      throw new Error("root_delivery_remote_read_back_failed");
    }
  }
}

function deliveryFacts(tree: LinearWorkflowTreeSnapshot, rootIssueId: string) {
  const root = issue(tree, rootIssueId);
  if (root.status_name !== "In Progress" || root.is_archived) throw new Error("root_delivery_root_state_invalid");
  const cycles = tree.issues.filter((candidate) =>
    candidate.issue_kind === "cycle" && candidate.parent_issue_id === rootIssueId &&
    candidate.status_name === "Succeeded" && !candidate.is_archived,
  );
  if (cycles.length !== 1) throw new Error("root_delivery_cycle_ambiguous");
  const cycle = cycles[0]!;
  const verifies = tree.issues.filter((candidate) =>
    candidate.issue_kind === "verify" && candidate.parent_issue_id === cycle.issue_id &&
    candidate.status_name === "Done" && candidate.labels.includes("Passed") && !candidate.is_archived,
  );
  if (verifies.length !== 1) throw new Error("root_delivery_verify_ambiguous");
  const verify = verifies[0]!;
  const attachments = tree.attachments.filter((attachment) =>
    attachment.issue_id === verify.issue_id && attachment.title === VERIFIED_REVISION_TITLE,
  );
  if (attachments.length !== 1) throw new Error("root_delivery_revision_attachment_ambiguous");
  const revision = commitRevision(attachments[0]!.url);
  if (!revision) throw new Error("root_delivery_revision_attachment_invalid");
  return {
    rootVersion: root.remote_version,
    cycleId: cycle.issue_id,
    cycleVersion: cycle.remote_version,
    verifyId: verify.issue_id,
    verifyVersion: verify.remote_version,
    revision,
    revisionUrl: attachments[0]!.url,
  };
}

function sameNativeFacts(left: ReturnType<typeof deliveryFacts>, right: ReturnType<typeof deliveryFacts>): boolean {
  return left.rootVersion === right.rootVersion && left.cycleId === right.cycleId &&
    left.cycleVersion === right.cycleVersion && left.verifyId === right.verifyId &&
    left.verifyVersion === right.verifyVersion && left.revision === right.revision &&
    left.revisionUrl === right.revisionUrl;
}

function issue(tree: LinearWorkflowTreeSnapshot, issueId: string) {
  const value = tree.issues.find((candidate) => candidate.issue_id === issueId);
  if (!value) throw new Error("root_delivery_issue_missing");
  return value;
}

function matchingAttachments(tree: LinearWorkflowTreeSnapshot, issueId: string, title: string, url: string) {
  return tree.attachments.filter((attachment) =>
    attachment.issue_id === issueId && attachment.title === title && attachment.url === url,
  );
}

function commitRevision(value: string): string | undefined {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const revision = url.protocol === "https:" && url.hostname === "github.com" && !url.search && !url.hash &&
      segments.length === 4 && segments[2] === "commit" ? segments[3] : undefined;
    return revision && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
}

function validPullRequestUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(url.pathname) && !url.search && !url.hash
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function validateText(value: string, cap: number, field: string): void {
  if ([...value].length === 0 || [...value].length > cap) throw new Error(`root_delivery_${field}_invalid`);
}
