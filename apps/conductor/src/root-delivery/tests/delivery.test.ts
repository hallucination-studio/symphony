import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { GitRootDeliveryImpl } from "../internal/GitRootDeliveryImpl.js";

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
  assert.equal(linear.tree.attachments.some(({ title }) => title === "Delivery pull request"), true);
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
    directive: { rootDirectiveId: "directive-1" } as never,
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

class FakeLinear {
  readonly mutations: LinearWorkflowMutationCommand[] = [];
  readonly tree = tree();

  async resolveProject() { return { kind: "resolved" as const, projectId: "project-1", conductorPool: [] }; }
  async readProjectRootIndexPage() { return { kind: "page" as const, page: { roots: [], hasNextPage: false } }; }
  async readWorkflowIssueTree() { return structuredClone(this.tree); }
  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    const root = this.tree.issues[0]!;
    if (command.kind === "create_workflow_attachment") {
      this.tree.attachments.push({
        attachment_id: `attachment-${this.tree.attachments.length + 1}`, issue_id: command.target.targetIssueId,
        title: command.title, url: command.url, source_type: "github", remote_version: "attachment-v1",
        created_at: this.tree.observed_at, updated_at: this.tree.observed_at,
      });
      root.remote_version = "root-v2";
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: root.issue_id, remoteVersion: "attachment-v1" } };
    }
    if (command.kind === "update_workflow_issue") {
      const status = this.tree.status_catalog.find(({ status_id }) => status_id === command.statusId)!;
      Object.assign(root, { status_id: status.status_id, status_name: status.name, status_category: status.category, status_position: status.position, remote_version: "root-v3" });
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
      attachment_id: "verified-revision", issue_id: "verify-1", title: "Verified Git revision",
      url: `https://github.com/acme/repo/commit/${revision}`, source_type: "github", remote_version: "attachment-v1",
      created_at: observedAt, updated_at: observedAt,
    }],
    activities: [],
    source_manifest: [], coverage: { is_complete: true, omissions: [] }, observed_at: observedAt,
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
