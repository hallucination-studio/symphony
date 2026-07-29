import type { CommandResult } from "../../composition/CommandRunner.js";
import { runCommand } from "../../composition/CommandRunner.js";
import type { GitWorkspaceInterface, GitWorkspaceProvisionerInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { hasCurrentWorkflowAttachmentProof } from "../../linear-gateway/api/CurrentWorkflowAttachmentProvenance.js";
import type {
  RootDeliveryCommand,
  RootDeliveryInterface,
  RootDeliveryResult,
  RootRemoteAcceptanceCommand,
  RootRemoteAcceptanceInterface,
  RootRemoteAcceptanceObservation,
} from "../api/RootDeliveryInterface.js";
import { IMMUTABLE_VERIFY_TARGET_TITLE_PREFIX } from "../../root-reconciliation/internal/VerifyTargetIdentity.js";

type Runner = (executable: string, arguments_: string[], options?: { cwd?: string }) => Promise<CommandResult>;
type DeliveryGit = GitWorkspaceInterface & Pick<GitWorkspaceProvisionerInterface, "readCommitUrl">;

const DELIVERY_PR_TITLE_PREFIX = "Delivery pull request: ";

export class GitRootDeliveryImpl implements RootDeliveryInterface, RootRemoteAcceptanceInterface {
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
    const expected = deliveryFacts(command.view.tree, command.view.root.issueId, ["In Progress"]);
    const freshTree = await this.linear.readWorkflowIssueTree(command.view.root.issueId);
    const fresh = deliveryFacts(freshTree, command.view.root.issueId, ["In Progress", "In Review"]);
    if (!sameDeliveryAuthority(expected, fresh) ||
        (fresh.rootStatus === "In Progress" && expected.rootVersion !== fresh.rootVersion) ||
        !freshTree.coverage.is_complete) {
      throw new Error("root_delivery_native_precondition_failed");
    }

    const snapshot = await this.git.inspect(workspace);
    if (snapshot.head !== fresh.revision || snapshot.branch !== workspace.branch ||
        snapshot.status.partial || snapshot.status.has_more || snapshot.status.items.length !== 0) {
      throw new Error("root_delivery_git_precondition_failed");
    }
    const commitUrl = await this.git.readCommitUrl({ workspace, revision: fresh.revision });
    if (commitUrl !== fresh.revisionUrl) throw new Error("root_delivery_revision_attachment_mismatch");
    const repository = githubRepository(commitUrl);
    if (!repository) throw new Error("root_delivery_repository_identity_invalid");

    let pullRequest = await this.readPullRequest(command, workspace, fresh.revision, repository);
    if (!pullRequest) {
      await this.runner("git", ["push", "--set-upstream", "origin", workspace.branch], {
        cwd: workspace.worktreePath,
      });
      await this.assertRemoteBranch(workspace, fresh.revision);
      await this.runner("gh", [
        "pr", "create", "--base", command.baseBranch, "--head", workspace.branch,
        "--title", command.title, "--body", command.body,
      ], { cwd: workspace.worktreePath });
      pullRequest = await this.readPullRequest(command, workspace, fresh.revision, repository);
      if (!pullRequest) throw new Error("root_delivery_pr_read_back_failed");
    }
    const deliveryTitle = deliveryPullRequestTitle(fresh.revision);

    if (fresh.rootStatus === "In Review") {
      const links = matchingSymphonyAttachments(freshTree, command.view.root.issueId, deliveryTitle, pullRequest.url);
      if (links.length !== 1) throw new Error(links.length > 1
        ? "root_delivery_pr_attachment_ambiguous"
        : "root_delivery_in_review_postcondition_invalid");
      return { kind: "pull_request", url: pullRequest.url };
    }

    let tree = freshTree;
    const root = issue(tree, command.view.root.issueId);
    const links = matchingSymphonyAttachments(tree, root.issue_id, deliveryTitle, pullRequest.url);
    if (links.length > 1) throw new Error("root_delivery_pr_attachment_ambiguous");
    if (links.length === 0) {
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_workflow_attachment",
        writeId: `${command.operationId}:delivery-pr`,
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: root.issue_id,
          expectedRemoteVersion: root.remote_version,
          expectedStatusId: root.status_id,
          expectedIsArchived: false,
        },
        title: deliveryTitle,
        url: pullRequest.url,
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
        throw new Error(`root_delivery_pr_attachment_${outcome.kind}`);
      }
      tree = await this.linear.readWorkflowIssueTree(root.issue_id);
    }
    if (matchingSymphonyAttachments(tree, root.issue_id, deliveryTitle, pullRequest.url).length !== 1) {
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
      writeId: `${command.operationId}:delivery-in-review`,
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
      parentAssignment: { mode: "retain" },
      order: currentRoot.order,
    });
    if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
      throw new Error(`root_delivery_status_${outcome.kind}`);
    }
    const readBack = await this.linear.readWorkflowIssueTree(currentRoot.issue_id);
    if (issue(readBack, currentRoot.issue_id).status_name !== "In Review" ||
        matchingSymphonyAttachments(readBack, currentRoot.issue_id, deliveryTitle, pullRequest.url).length !== 1) {
      throw new Error("root_delivery_status_read_back_failed");
    }
    return { kind: "pull_request", url: pullRequest.url };
  }

  async observeAcceptance(command: RootRemoteAcceptanceCommand): Promise<RootRemoteAcceptanceObservation> {
    if (!("workspace" in command.view)) return { kind: "observation_invalid", reason: "git_facts" };
    const workspace = command.view.workspace;
    let expected: ReturnType<typeof deliveryFacts>;
    let freshTree: LinearWorkflowTreeSnapshot;
    let fresh: ReturnType<typeof deliveryFacts>;
    try {
      expected = deliveryFacts(command.view.tree, command.view.root.issueId, ["In Review"]);
      freshTree = await this.linear.readWorkflowIssueTree(command.view.root.issueId);
      fresh = deliveryFacts(freshTree, command.view.root.issueId, ["In Review"]);
    } catch {
      return { kind: "observation_invalid", reason: "native_facts" };
    }
    if (!freshTree.coverage.is_complete || !sameDeliveryAuthority(expected, fresh) ||
        expected.rootVersion !== fresh.rootVersion) {
      return { kind: "observation_invalid", reason: "native_facts" };
    }
    const snapshot = await this.git.inspect(workspace);
    const commitUrl = await this.git.readCommitUrl({ workspace, revision: fresh.revision });
    if (snapshot.head !== fresh.revision || snapshot.branch !== workspace.branch || snapshot.status.partial ||
        snapshot.status.has_more || snapshot.status.items.length !== 0 || commitUrl !== fresh.revisionUrl) {
      return { kind: "observation_invalid", reason: "git_facts" };
    }
    const repository = githubRepository(commitUrl);
    const deliveryTitle = deliveryPullRequestTitle(fresh.revision);
    const attachments = freshTree.attachments.filter((attachment) =>
      attachment.issue_id === command.view.root.issueId && attachment.title === deliveryTitle &&
      hasCurrentWorkflowAttachmentProof({ tree: freshTree, attachment }));
    if (!repository || attachments.length !== 1) return { kind: "observation_invalid", reason: "pull_request_identity" };
    const pullRequestUrl = validPullRequestUrl(attachments[0]!.url);
    if (!pullRequestUrl || githubRepository(pullRequestUrl) !== repository) {
      return { kind: "observation_invalid", reason: "pull_request_identity" };
    }
    const deliveryReference = {
      deliveryReferenceId: attachments[0]!.attachment_id,
      deliveryReferenceVersion: attachments[0]!.remote_version,
    };
    let value: Record<string, unknown>;
    try {
      const result = await this.runner("gh", [
        "pr", "view", pullRequestUrl,
        "--json", "url,state,isDraft,headRefName,headRefOid,baseRefName,reviewDecision,statusCheckRollup,mergedAt",
      ], { cwd: workspace.worktreePath });
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      value = parsed as Record<string, unknown>;
    } catch {
      return { kind: "observation_invalid", reason: "provider_response" };
    }
    const observedUrl = validPullRequestUrl(value.url);
    if (observedUrl !== pullRequestUrl || githubRepository(observedUrl) !== repository ||
        value.headRefName !== workspace.branch || value.baseRefName !== command.baseBranch ||
        typeof value.headRefOid !== "string" || !["OPEN", "CLOSED", "MERGED"].includes(String(value.state))) {
      return { kind: "observation_invalid", reason: "pull_request_identity" };
    }
    if (value.headRefOid !== fresh.revision) {
      return { kind: "head_changed", ...deliveryReference, pullRequestUrl, expectedRevision: fresh.revision, observedRevision: value.headRefOid };
    }
    if (value.state === "MERGED") {
      if (typeof value.mergedAt !== "string" || !checksPassed(value.statusCheckRollup)) {
        return { kind: "observation_invalid", reason: "checks_incomplete" };
      }
      return { kind: "merged_exact", ...deliveryReference, pullRequestUrl, exactRevision: fresh.revision };
    }
    if (value.state === "CLOSED") return { kind: "closed_unmerged", ...deliveryReference, pullRequestUrl, exactRevision: fresh.revision };
    if (value.reviewDecision === "CHANGES_REQUESTED") {
      return { kind: "changes_requested", ...deliveryReference, pullRequestUrl, exactRevision: fresh.revision };
    }
    return { kind: "open_unchanged", ...deliveryReference, pullRequestUrl, exactRevision: fresh.revision };
  }

  private async readPullRequest(
    command: RootDeliveryCommand,
    workspace: { branch: string; worktreePath: string },
    revision: string,
    repository: string,
  ) {
    const result = await this.runner("gh", [
      "pr", "list", "--head", workspace.branch, "--state", "open",
      "--json", "url,headRefName,headRefOid,baseRefName", "--limit", "2",
    ], { cwd: workspace.worktreePath });
    const values = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(values) || values.length > 1) throw new Error("root_delivery_pr_ambiguous");
    const value = values[0] as Record<string, unknown> | undefined;
    if (!value) return undefined;
    const url = validPullRequestUrl(value.url);
    if (!url || githubRepository(url) !== repository || value.headRefName !== workspace.branch ||
        value.headRefOid !== revision || value.baseRefName !== command.baseBranch) {
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

function deliveryFacts(
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
  allowedRootStatuses: Array<"In Progress" | "In Review">,
) {
  const root = issue(tree, rootIssueId);
  if (!allowedRootStatuses.includes(root.status_name as "In Progress" | "In Review") || root.is_archived) {
    throw new Error("root_delivery_root_state_invalid");
  }
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
    attachment.issue_id === verify.issue_id && attachment.title.startsWith(IMMUTABLE_VERIFY_TARGET_TITLE_PREFIX) &&
    hasCurrentWorkflowAttachmentProof({ tree, attachment }),
  );
  if (attachments.length !== 1) throw new Error("root_delivery_revision_attachment_ambiguous");
  const revision = commitRevision(attachments[0]!.url);
  const titleRevision = attachments[0]!.title.slice(IMMUTABLE_VERIFY_TARGET_TITLE_PREFIX.length);
  if (!revision || revision !== titleRevision) throw new Error("root_delivery_revision_attachment_invalid");
  return {
    rootVersion: root.remote_version,
    rootStatus: root.status_name as "In Progress" | "In Review",
    cycleId: cycle.issue_id,
    cycleVersion: cycle.remote_version,
    verifyId: verify.issue_id,
    verifyVersion: verify.remote_version,
    revision,
    revisionUrl: attachments[0]!.url,
  };
}

function sameDeliveryAuthority(left: ReturnType<typeof deliveryFacts>, right: ReturnType<typeof deliveryFacts>): boolean {
  return left.cycleId === right.cycleId && left.cycleVersion === right.cycleVersion && left.verifyId === right.verifyId &&
    left.verifyVersion === right.verifyVersion && left.revision === right.revision &&
    left.revisionUrl === right.revisionUrl;
}

function deliveryPullRequestTitle(revision: string): string {
  return `${DELIVERY_PR_TITLE_PREFIX}${revision}`;
}

function issue(tree: LinearWorkflowTreeSnapshot, issueId: string) {
  const value = tree.issues.find((candidate) => candidate.issue_id === issueId);
  if (!value) throw new Error("root_delivery_issue_missing");
  return value;
}

function matchingSymphonyAttachments(tree: LinearWorkflowTreeSnapshot, issueId: string, title: string, url: string) {
  return tree.attachments.filter((attachment) =>
    attachment.issue_id === issueId && attachment.title === title && attachment.url === url &&
    hasCurrentWorkflowAttachmentProof({ tree, attachment }),
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

function githubRepository(value: string): string | undefined {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return url.protocol === "https:" && url.hostname === "github.com" && segments.length >= 2
      ? `${segments[0]!.toLowerCase()}/${segments[1]!.toLowerCase()}`
      : undefined;
  } catch {
    return undefined;
  }
}

function checksPassed(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((check) => {
    if (!check || typeof check !== "object" || Array.isArray(check)) return false;
    const record = check as Record<string, unknown>;
    return record.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(record.conclusion));
  });
}

function validateText(value: string, cap: number, field: string): void {
  if ([...value].length === 0 || [...value].length > cap) throw new Error(`root_delivery_${field}_invalid`);
}
