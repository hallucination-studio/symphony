import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { GitRootDeliveryImpl } from "../internal/GitRootDeliveryImpl.js";
import { immutableVerifyTargetTitle } from "../../root-reconciliation/internal/VerifyTargetIdentity.js";

const revision = "abc123";
const workspace = { branch: "symphony/runs/sym-1", worktreePath: "/worktree", rootIssueId: "root-1" };

test("delivery fresh-reads native, Git, and SCM facts before attaching the PR and moving Root to In Review", async () => {
  const linear = new FakeLinear();
  const calls: string[][] = [];
  const delivery = new GitRootDeliveryImpl(linear, git(), async (_executable, args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return commandResult(JSON.stringify([{
        url: "https://github.com/acme/repo/pull/7",
        headRefName: workspace.branch,
        headRefOid: revision,
        baseRefName: "main",
      }]));
    }
    throw new Error("unexpected_delivery_mutation");
  });

  assert.deepEqual(await delivery.deliver(command(linear.tree)), {
    kind: "pull_request", url: "https://github.com/acme/repo/pull/7",
  });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "create_workflow_attachment", "update_workflow_issue",
  ]);
  assert.equal(linear.tree.issues[0]?.status_name, "In Review");
  assert.equal(linear.tree.attachments.some(({ title }) => title === `Delivery pull request: ${revision}`), true);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["pr", "list"]]);
});

test("delivery rejects stale native facts before Git or SCM mutation", async () => {
  const linear = new FakeLinear();
  const input = command(linear.tree);
  linear.tree.issues.find(({ issue_id }) => issue_id === "verify-1")!.remote_version = "verify-v2";
  let calls = 0;
  const delivery = new GitRootDeliveryImpl(linear, git(), async () => {
    calls += 1;
    throw new Error("unexpected_scm_call");
  });

  await assert.rejects(delivery.deliver(input), /root_delivery_native_precondition_failed/u);
  assert.equal(calls, 0);
  assert.deepEqual(linear.mutations, []);
});

test("delivery pushes, reads the remote revision, creates a PR, then fresh-reads it", async () => {
  const linear = new FakeLinear();
  let listReads = 0;
  const calls: string[][] = [];
  const delivery = new GitRootDeliveryImpl(linear, git(), async (_executable, args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      listReads += 1;
      return commandResult(listReads === 1 ? "[]" : JSON.stringify([{
        url: "https://github.com/acme/repo/pull/8", headRefName: workspace.branch,
        headRefOid: revision, baseRefName: "main",
      }]));
    }
    if (args[0] === "ls-remote") return commandResult(`${revision}\trefs/heads/${workspace.branch}\n`);
    return commandResult("");
  });

  await delivery.deliver(command(linear.tree));
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ["pr", "list"], ["push", "--set-upstream"], ["ls-remote", "--heads"],
    ["pr", "create"], ["pr", "list"],
  ]);
});

test("delivery creates the exact current reference without removing historical attachments", async () => {
  const linear = new FakeLinear();
  linear.tree.attachments.push({
    attachment_id: "delivery-pr-historical",
    issue_id: "root-1",
    title: "Delivery pull request",
    url: "https://github.com/acme/repo/pull/3",
    source_type: "github",
    remote_version: "delivery-pr-historical-v1",
    created_at: "2026-07-20T00:00:00Z",
    updated_at: "2026-07-20T00:00:00Z",
  });
  linear.tree.source_manifest.push({
    source_kind: "linear_attachment",
    source_id: "delivery-pr-historical",
    source_version: "delivery-pr-historical-v1",
    actor_kind: "symphony",
  });
  const delivery = new GitRootDeliveryImpl(linear, git(), async (_executable, args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return commandResult(JSON.stringify([{
        url: "https://github.com/acme/repo/pull/7",
        headRefName: workspace.branch,
        headRefOid: revision,
        baseRefName: "main",
      }]));
    }
    throw new Error("unexpected_delivery_mutation");
  });

  await delivery.deliver(command(linear.tree));

  assert.equal(linear.tree.attachments.some(({ attachment_id }) => attachment_id === "delivery-pr-historical"), true);
  assert.equal(linear.tree.attachments.filter(({ title }) => title === `Delivery pull request: ${revision}`).length, 1);
});

test("delivery recovers an applied but unconfirmed In Review postcondition without another write", async () => {
  const linear = new FakeLinear();
  linear.loseInReviewResponseOnce = true;
  const input = command(linear.tree);
  let scmReads = 0;
  const delivery = new GitRootDeliveryImpl(linear, git(), async (_executable, args) => {
    if (args[0] === "pr" && args[1] === "list") {
      scmReads += 1;
      return commandResult(JSON.stringify([{
        url: "https://github.com/acme/repo/pull/7",
        headRefName: workspace.branch,
        headRefOid: revision,
        baseRefName: "main",
      }]));
    }
    throw new Error("unexpected_delivery_mutation");
  });

  assert.deepEqual(await delivery.deliver(input), {
    kind: "pull_request",
    url: "https://github.com/acme/repo/pull/7",
  });
  assert.equal(linear.tree.issues[0]?.status_name, "In Review");
  const mutationCount = linear.mutations.length;

  assert.deepEqual(await delivery.deliver(input), {
    kind: "pull_request",
    url: "https://github.com/acme/repo/pull/7",
  });
  assert.equal(linear.mutations.length, mutationCount);
  assert.equal(scmReads, 2);
});

test("delivery does not accept an unconfirmed In Review write when the native postcondition is absent", async () => {
  const linear = new FakeLinear();
  linear.loseInReviewWithoutApplyingOnce = true;
  const delivery = new GitRootDeliveryImpl(linear, git(), async (_executable, args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return commandResult(JSON.stringify([{
        url: "https://github.com/acme/repo/pull/7",
        headRefName: workspace.branch,
        headRefOid: revision,
        baseRefName: "main",
      }]));
    }
    throw new Error("unexpected_delivery_mutation");
  });

  await assert.rejects(delivery.deliver(command(linear.tree)), /root_delivery_status_read_back_failed/u);
  assert.equal(linear.tree.issues[0]?.status_name, "In Progress");
});

test("delivery rejects a matching branch and revision from a foreign repository", async () => {
  const linear = new FakeLinear();
  const delivery = new GitRootDeliveryImpl(linear, git(), async (_executable, args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return commandResult(JSON.stringify([{
        url: "https://github.com/other/repository/pull/7",
        headRefName: workspace.branch,
        headRefOid: revision,
        baseRefName: "main",
      }]));
    }
    throw new Error("unexpected_delivery_mutation");
  });

  await assert.rejects(delivery.deliver(command(linear.tree)), /root_delivery_pr_precondition_failed/u);
  assert.deepEqual(linear.mutations, []);
});

test("remote acceptance distinguishes unchanged open, exact merged, and changed head", async () => {
  const scenarios = [
    [{ state: "OPEN", reviewDecision: "REVIEW_REQUIRED", headRefOid: revision, statusCheckRollup: [] }, "open_unchanged"],
    [{ state: "MERGED", reviewDecision: "APPROVED", headRefOid: revision, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }, "merged_exact"],
    [{ state: "OPEN", reviewDecision: "APPROVED", headRefOid: "different", statusCheckRollup: [] }, "head_changed"],
  ] as const;
  for (const [provider, expectedKind] of scenarios) {
    const linear = new FakeLinear();
    setDelivered(linear);
    const delivery = new GitRootDeliveryImpl(linear, git(), async (_executable, args) => {
      assert.deepEqual(args.slice(0, 3), ["pr", "view", "https://github.com/acme/repo/pull/7"]);
      return commandResult(JSON.stringify({
        url: "https://github.com/acme/repo/pull/7",
        isDraft: false,
        headRefName: workspace.branch,
        baseRefName: "main",
        mergedAt: provider.state === "MERGED" ? "2026-07-29T00:00:00Z" : null,
        ...provider,
      }));
    });

    const observation = await delivery.observeAcceptance({ view: acceptanceView(linear.tree), baseBranch: "main" });
    assert.equal(observation.kind, expectedKind);
    assert.equal(observation.deliveryReferenceId, "delivery-pr");
    assert.equal(observation.deliveryReferenceVersion, "delivery-pr-v1");
  }
});

test("remote acceptance authorizes production-shaped attachments from exact Activity actors", async () => {
  const linear = new FakeLinear();
  setDelivered(linear);
  for (const source of linear.tree.source_manifest) {
    if (source.source_kind === "linear_attachment") source.actor_kind = "unknown";
  }
  linear.tree.activities.push(
    {
      activity_id: "activity-verified-revision", issue_id: "verify-1",
      activity_kinds: ["attachment_changed"], actor_kind: "symphony", actor_id: "symphony-actor",
      attachment_id: "verified-revision", remote_version: "activity-verified-revision-v1",
      created_at: "2026-07-28T00:00:01Z",
    },
    {
      activity_id: "activity-delivery-pr", issue_id: "root-1",
      activity_kinds: ["attachment_changed"], actor_kind: "symphony", actor_id: "symphony-actor",
      attachment_id: "delivery-pr", remote_version: "activity-delivery-pr-v1",
      created_at: "2026-07-28T00:00:02Z",
    },
  );
  const delivery = new GitRootDeliveryImpl(linear, git(), async () => commandResult(JSON.stringify({
    url: "https://github.com/acme/repo/pull/7", state: "OPEN", isDraft: false,
    headRefName: workspace.branch, headRefOid: revision, baseRefName: "main",
    reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [], mergedAt: null,
  })));

  const observation = await delivery.observeAcceptance({ view: acceptanceView(linear.tree), baseBranch: "main" });

  assert.equal(observation.kind, "changes_requested");

  linear.tree.activities.push({
    activity_id: "activity-verified-revision-human", issue_id: "verify-1",
    activity_kinds: ["attachment_changed"], actor_kind: "human", actor_id: "human-1",
    attachment_id: "verified-revision", remote_version: "activity-verified-revision-human-v1",
    created_at: "2026-07-28T00:00:03Z",
  });
  assert.deepEqual(
    await delivery.observeAcceptance({ view: acceptanceView(linear.tree), baseBranch: "main" }),
    { kind: "observation_invalid", reason: "native_facts" },
  );
});

test("remote acceptance selects the exact current revision while retaining historical delivery attachments", async () => {
  const linear = new FakeLinear();
  setDelivered(linear);
  const current = linear.tree.attachments.find(({ attachment_id }) => attachment_id === "delivery-pr")!;
  current.title = `Delivery pull request: ${revision}`;
  linear.tree.attachments.push({
    attachment_id: "delivery-pr-historical",
    issue_id: "root-1",
    title: "Delivery pull request",
    url: "https://github.com/acme/repo/pull/3",
    source_type: "github",
    remote_version: "delivery-pr-historical-v1",
    created_at: "2026-07-20T00:00:00Z",
    updated_at: "2026-07-20T00:00:00Z",
  });
  linear.tree.source_manifest.push({
    source_kind: "linear_attachment",
    source_id: "delivery-pr-historical",
    source_version: "delivery-pr-historical-v1",
    actor_kind: "symphony",
  });
  const delivery = new GitRootDeliveryImpl(linear, git(), async (_executable, args) => {
    assert.deepEqual(args.slice(0, 3), ["pr", "view", "https://github.com/acme/repo/pull/7"]);
    return commandResult(JSON.stringify({
      url: "https://github.com/acme/repo/pull/7",
      state: "OPEN",
      isDraft: false,
      headRefName: workspace.branch,
      headRefOid: revision,
      baseRefName: "main",
      reviewDecision: "REVIEW_REQUIRED",
      statusCheckRollup: [],
      mergedAt: null,
    }));
  });

  const observation = await delivery.observeAcceptance({ view: acceptanceView(linear.tree), baseBranch: "main" });

  assert.equal(observation.kind, "open_unchanged");
  assert.equal(observation.deliveryReferenceId, "delivery-pr");
  assert.equal(observation.deliveryReferenceVersion, "delivery-pr-v1");
});

test("remote acceptance rejects duplicate exact current revision references before SCM", async () => {
  const linear = new FakeLinear();
  setDelivered(linear);
  linear.tree.attachments.push({
    ...linear.tree.attachments.find(({ attachment_id }) => attachment_id === "delivery-pr")!,
    attachment_id: "delivery-pr-duplicate",
    remote_version: "delivery-pr-duplicate-v1",
  });
  linear.tree.source_manifest.push({
    source_kind: "linear_attachment",
    source_id: "delivery-pr-duplicate",
    source_version: "delivery-pr-duplicate-v1",
    actor_kind: "symphony",
  });
  let scmCalls = 0;
  const delivery = new GitRootDeliveryImpl(linear, git(), async () => {
    scmCalls += 1;
    throw new Error("unexpected_scm_call");
  });

  assert.deepEqual(
    await delivery.observeAcceptance({ view: acceptanceView(linear.tree), baseBranch: "main" }),
    { kind: "observation_invalid", reason: "pull_request_identity" },
  );
  assert.equal(scmCalls, 0);
});

function git() {
  return {
    async inspect() {
      return { head: revision, branch: workspace.branch, status: { items: [], returned: 0, cap: 512, has_more: false, partial: false } };
    },
    async readCommitUrl() { return `https://github.com/acme/repo/commit/${revision}`; },
  } as never;
}

function command(tree: LinearWorkflowTreeSnapshot) {
  return {
    operationId: "delivery-1",
    view: {
      root: {
        issueId: "root-1", identifier: "SYM-1", projectId: "project-1", state: "In Progress",
        updatedAt: tree.observed_at, priority: "normal", blockers: [], rootConductorLabels: [],
        isDelegatedToSymphony: true, isArchived: false,
      },
      tree: structuredClone(tree), observedAt: tree.observed_at, treeDigest: "tree-1", complete: true,
      worktreeGate: { kind: "valid", repositoryIdentity: "repository-1", branch: workspace.branch, headRevision: revision, isClean: true, changedPaths: [] },
      workspace,
      git: { head: revision, branch: workspace.branch, status: { items: [], returned: 0, cap: 512, has_more: false, partial: false } },
    } as RootReconciliationView,
    baseBranch: "main",
    title: "SYM-1 delivery",
    body: "Delivers verified changes.",
  };
}

function acceptanceView(tree: LinearWorkflowTreeSnapshot) {
  const view = command(tree).view;
  return { ...view, root: { ...view.root, state: "In Review" as const } };
}

function setDelivered(linear: FakeLinear): void {
  const root = linear.tree.issues[0]!;
  Object.assign(root, { status_id: "review", status_name: "In Review", status_category: "started" });
  linear.tree.attachments.push({
    attachment_id: "delivery-pr", issue_id: root.issue_id, title: `Delivery pull request: ${revision}`,
    url: "https://github.com/acme/repo/pull/7", source_type: "github", remote_version: "delivery-pr-v1",
    created_at: linear.tree.observed_at, updated_at: linear.tree.observed_at,
  });
  linear.tree.source_manifest.push({
    source_kind: "linear_attachment", source_id: "delivery-pr", source_version: "delivery-pr-v1", actor_kind: "symphony",
  });
}

class FakeLinear {
  readonly mutations: LinearWorkflowMutationCommand[] = [];
  readonly tree = tree();
  loseInReviewResponseOnce = false;
  loseInReviewWithoutApplyingOnce = false;

  async resolveProject() { return { kind: "resolved" as const, projectId: "project-1", conductorPool: [] }; }
  async readProjectRootIndexPage() { return { kind: "page" as const, page: { roots: [], hasNextPage: false } }; }
  async readWorkflowIssueTree() { return structuredClone(this.tree); }
  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    const root = this.tree.issues[0]!;
    if (command.kind === "create_workflow_attachment") {
      const attachmentId = `attachment-${this.tree.attachments.length + 1}`;
      this.tree.attachments.push({
        attachment_id: attachmentId, issue_id: command.target.targetIssueId,
        title: command.title, url: command.url, source_type: "github", remote_version: "attachment-v1",
        created_at: this.tree.observed_at, updated_at: this.tree.observed_at,
      });
      this.tree.source_manifest.push({
        source_kind: "linear_attachment", source_id: attachmentId, source_version: "attachment-v1",
        actor_kind: "symphony",
      });
      root.remote_version = "root-v2";
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: root.issue_id, remoteVersion: "attachment-v1" } };
    }
    if (command.kind === "update_workflow_issue") {
      const status = this.tree.status_catalog.find(({ status_id }) => status_id === command.statusId)!;
      if (this.loseInReviewWithoutApplyingOnce && status.name === "In Review") {
        this.loseInReviewWithoutApplyingOnce = false;
        return {
          kind: "write_unconfirmed" as const,
          readBackTarget: { writeId: command.writeId, targetIssueId: root.issue_id, remoteVersion: root.remote_version },
        };
      }
      Object.assign(root, { status_id: status.status_id, status_name: status.name, status_category: status.category, status_position: status.position, remote_version: "root-v3" });
      if (this.loseInReviewResponseOnce && status.name === "In Review") {
        this.loseInReviewResponseOnce = false;
        return {
          kind: "write_unconfirmed" as const,
          readBackTarget: { writeId: command.writeId, targetIssueId: root.issue_id, remoteVersion: root.remote_version },
        };
      }
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: root.issue_id, remoteVersion: root.remote_version } };
    }
    throw new Error("unexpected_mutation");
  }
}

function tree(): LinearWorkflowTreeSnapshot {
  const observedAt = "2026-07-28T00:00:00Z";
  return {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "progress", name: "In Progress", category: "started", position: 1 },
      { status_id: "review", name: "In Review", category: "started", position: 2 },
      { status_id: "succeeded", name: "Succeeded", category: "completed", position: 3 },
      { status_id: "done", name: "Done", category: "completed", position: 4 },
    ],
    issues: [
      issue("root-1", "root", undefined, "progress", "In Progress", "root-v1", []),
      issue("cycle-1", "cycle", "root-1", "succeeded", "Succeeded", "cycle-v1", ["Cycle"]),
      issue("verify-1", "verify", "cycle-1", "done", "Done", "verify-v1", ["Verify", "Passed"]),
    ],
    comments: [], relations: [], attachments: [{
      attachment_id: "verified-revision", issue_id: "verify-1", title: immutableVerifyTargetTitle(revision),
      url: `https://github.com/acme/repo/commit/${revision}`, source_type: "github", remote_version: "attachment-v1",
      created_at: observedAt, updated_at: observedAt,
    }],
    activities: [],
    source_manifest: [{
      source_kind: "linear_attachment", source_id: "verified-revision", source_version: "attachment-v1",
      actor_kind: "symphony",
    }], coverage: { is_complete: true, omissions: [] }, observed_at: observedAt,
  };
}

function issue(issueId: string, kind: "root" | "cycle" | "verify", parentId: string | undefined, statusId: string, statusName: string, version: string, labels: string[]) {
  const category = statusName === "Succeeded" || statusName === "Done" ? "completed" as const : "started" as const;
  return {
    issue_id: issueId, identifier: issueId, project_id: "project-1", ...(parentId ? { parent_issue_id: parentId } : {}),
    status_id: statusId, status_name: statusName, status_category: category, status_position: 1,
    order: parentId ? 1 : 0, depth: parentId === undefined ? 0 : parentId === "root-1" ? 1 : 2,
    title: kind, description: `${kind} description`, labels, is_archived: false, issue_kind: kind,
    remote_version: version, created_at: "2026-07-28T00:00:00Z", updated_at: "2026-07-28T00:00:00Z",
  };
}

function commandResult(stdout: string) {
  return { stdout, stderr: "", exitCode: 0 };
}
