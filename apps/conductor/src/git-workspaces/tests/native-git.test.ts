import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../../composition/CommandRunner.js";
import type { GitWorkspace } from "../api/GitWorkspaceInterface.js";
import { NativeGitWorkspaceImpl } from "../internal/NativeGitWorkspaceImpl.js";

test("Root worktree gate reads fresh, recoverable, invalid, conflicting, and valid Git authority without mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-git-gate-"));
  const repository = path.join(root, "repository");
  const worktrees = path.join(root, "worktrees");
  await runCommand("git", ["init", "-b", "main", repository]);
  await runCommand("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", repository, "config", "user.name", "Symphony Test"]);
  await writeFile(path.join(repository, "README.md"), "initial\n");
  await runCommand("git", ["-C", repository, "add", "README.md"]);
  await runCommand("git", ["-C", repository, "commit", "-m", "initial"]);
  await runCommand("git", ["-C", repository, "remote", "add", "origin", "git@github.com:acme/repo.git"]);
  const base = (await runCommand("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const git = new NativeGitWorkspaceImpl(repository, worktrees);
  const common = {
    repositoryIdentity: "repository-1",
    rootIssueId: "root-1",
    rootIdentifier: "SYM-1",
    baseBranch: "main",
    requiredRevisions: [base],
  };

  assert.deepEqual(await git.inspectRootWorktreeGate({ ...common, executionKind: "fresh" }), {
    result: { kind: "fresh_missing", repositoryIdentity: "repository-1", baseBranch: "main", baseRevision: base },
  });
  await assert.rejects(access(worktrees));
  await runCommand("git", ["-C", repository, "branch", "symphony/runs/sym-1", base]);
  assert.deepEqual(await git.inspectRootWorktreeGate({ ...common, executionKind: "existing" }), {
    result: { kind: "recoverable_missing", repositoryIdentity: "repository-1", branch: "symphony/runs/sym-1", headRevision: base },
  });

  const missing = await git.inspectRootWorktreeGate({ ...common, rootIdentifier: "SYM-2", executionKind: "existing" });
  assert.equal(missing.result.kind, "execution_generation_invalid");
  assert.equal(missing.result.kind === "execution_generation_invalid" && missing.result.reason, "branch_missing");

  await mkdir(path.join(worktrees, "root-conflict"), { recursive: true });
  const conflict = await git.inspectRootWorktreeGate({ ...common, rootIssueId: "root-conflict", executionKind: "existing" });
  assert.equal(conflict.result.kind, "execution_generation_invalid");
  assert.equal(conflict.result.kind === "execution_generation_invalid" && conflict.result.reason, "worktree_identity_conflict");

  const workspace = await materializeWorkspace(git);
  const valid = await git.inspectRootWorktreeGate({ ...common, executionKind: "existing" });
  assert.equal(valid.result.kind, "valid");
  if (!("workspace" in valid)) throw new Error("valid_gate_expected");
  assert.equal(valid.workspace.worktreePath, workspace.worktreePath);
  assert.equal(valid.snapshot.head, base);
  assert.equal(valid.result.isClean, true);
});

test("Git workspace returns bounded facts and identity-checked commits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-git-workspace-"));
  const repository = path.join(root, "repository");
  const worktrees = path.join(root, "worktrees");
  await runCommand("git", ["init", "-b", "main", repository]);
  await runCommand("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", repository, "config", "user.name", "Symphony Test"]);
  await writeFile(path.join(repository, "README.md"), "initial\n");
  await runCommand("git", ["-C", repository, "add", "README.md"]);
  await runCommand("git", ["-C", repository, "commit", "-m", "initial"]);
  await runCommand("git", ["-C", repository, "remote", "add", "origin", "git@github.com:acme/repo.git"]);

  const git = new NativeGitWorkspaceImpl(repository, worktrees, {
    test: ["git", ["diff", "--check"]],
  });
  for (const forbidden of ["checkout", "switch", "merge", "rebase", "reset", "clean", "push"]) {
    assert.equal(forbidden in git, false);
  }
  const workspace = await materializeWorkspace(git);
  const initial = await git.inspect(workspace);
  assert.equal(initial.status.returned, 0);
  assert.match(initial.head, /^[a-f0-9]{40}$/);
  assert.equal(
    await git.readCommitUrl({ workspace, revision: initial.head }),
    `https://github.com/acme/repo/commit/${initial.head}`,
  );
  await assert.rejects(
    git.readCommitUrl({ workspace, revision: "deadbeef" }),
    /git_commit_revision_stale/,
  );

  await writeFile(path.join(workspace.worktreePath, "README.md"), "changed\n");
  const dirty = await git.inspect(workspace);
  assert.equal(dirty.status.returned, 1);
  assert.equal(dirty.status.partial, false);
  assert.match((await git.diff(workspace)).text, /changed/);
  await assert.rejects(git.diff(workspace, { path: "../outside" }), /git_diff_path_out_of_scope/);
  assert.deepEqual((await git.checks(workspace, ["test"])).items, [{ name: "test", status: "passed" }]);

  await assert.rejects(
    git.commit({ workspace, rootIssueId: "root-1", issueId: "outside", allowedIssueIds: ["work-1"], issueIdentifier: "SYM-2", expectedHead: initial.head }),
    /git_commit_issue_out_of_scope/,
  );
  await assert.rejects(
    git.commit({ workspace, rootIssueId: "root-1", issueId: "work-1", allowedIssueIds: ["work-1"], issueIdentifier: "SYM-2", expectedHead: "deadbeef" }),
    /git_commit_head_stale/,
  );
  const committed = await git.commit({ workspace, rootIssueId: "root-1", issueId: "work-1", allowedIssueIds: ["work-1"], issueIdentifier: "SYM-2", expectedHead: initial.head });
  assert.equal(committed.kind, "committed");
});

test("Git workspace semantic read-back confirms an ambiguously reported commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-git-readback-"));
  const repository = path.join(root, "repository");
  await runCommand("git", ["init", "-b", "main", repository]);
  await runCommand("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", repository, "config", "user.name", "Symphony Test"]);
  await writeFile(path.join(repository, "README.md"), "initial\n");
  await runCommand("git", ["-C", repository, "add", "README.md"]);
  await runCommand("git", ["-C", repository, "commit", "-m", "initial"]);
  const git = new NativeGitWorkspaceImpl(repository, path.join(root, "worktrees"), {}, async (executable, args, options) => {
    await runCommand(executable, args, options);
    throw new Error("connection_lost_after_commit");
  });
  const workspace = await materializeWorkspace(git);
  const head = (await git.inspect(workspace)).head;
  await writeFile(path.join(workspace.worktreePath, "README.md"), "changed\n");
  const result = await git.commit({ workspace, rootIssueId: "root-1", issueId: "work-1", allowedIssueIds: ["work-1"], issueIdentifier: "SYM-2", expectedHead: head });
  assert.equal(result.kind, "committed");
  assert.notEqual(result.commit, head);
});

test("Git workspace restores a failed Work attempt to its baseline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-git-restore-"));
  const repository = path.join(root, "repository");
  await runCommand("git", ["init", "-b", "main", repository]);
  await runCommand("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", repository, "config", "user.name", "Symphony Test"]);
  await writeFile(path.join(repository, "README.md"), "initial\n");
  await runCommand("git", ["-C", repository, "add", "README.md"]);
  await runCommand("git", ["-C", repository, "commit", "-m", "initial"]);

  const git = new NativeGitWorkspaceImpl(repository, path.join(root, "worktrees"));
  const workspace = await materializeWorkspace(git);
  const head = (await git.inspect(workspace)).head;
  await writeFile(path.join(workspace.worktreePath, "README.md"), "rejected\n");
  await writeFile(path.join(workspace.worktreePath, "untracked.txt"), "rejected\n");
  await runCommand("git", ["-C", workspace.worktreePath, "add", "README.md"]);

  await assert.rejects(git.restoreWorktree(workspace, "deadbeef"), /git_restore_head_changed|git_restore_revision_invalid/);
  assert.deepEqual(await git.restoreWorktree(workspace, head), { kind: "restored" });
  assert.equal((await git.inspect(workspace)).status.items.length, 0);
  assert.equal(await readFile(path.join(workspace.worktreePath, "README.md"), "utf8"), "initial\n");
  await assert.rejects(access(path.join(workspace.worktreePath, "untracked.txt")));
});

test("Git workspace materialization rejects a stale gate without mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-git-stale-gate-"));
  const repository = path.join(root, "repository");
  const worktrees = path.join(root, "worktrees");
  await runCommand("git", ["init", "-b", "main", repository]);
  await runCommand("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", repository, "config", "user.name", "Symphony Test"]);
  await writeFile(path.join(repository, "README.md"), "initial\n");
  await runCommand("git", ["-C", repository, "add", "README.md"]);
  await runCommand("git", ["-C", repository, "commit", "-m", "initial"]);
  const git = new NativeGitWorkspaceImpl(repository, worktrees);
  const gate = await git.inspectRootWorktreeGate(gateInput());
  if (gate.result.kind !== "fresh_missing") throw new Error("fresh_missing_gate_expected");
  await runCommand("git", ["-C", repository, "commit", "--allow-empty", "-m", "advance base"]);

  await assert.rejects(git.materializeRootWorkspace({
    repositoryIdentity: "repository-1",
    rootIssueId: "root-1",
    rootIdentifier: "SYM-1",
    baseBranch: "main",
    expectedGate: gate.result,
  }), /git_workspace_gate_stale/);
  await assert.rejects(access(worktrees));
  await assert.rejects(runCommand("git", ["-C", repository, "rev-parse", "--verify", "symphony/runs/sym-1"]));
});

async function materializeWorkspace(
  git: NativeGitWorkspaceImpl,
  overrides: Partial<ReturnType<typeof gateInput>> = {},
): Promise<GitWorkspace> {
  const input = gateInput(overrides);
  const gate = await git.inspectRootWorktreeGate(input);
  if (gate.result.kind !== "fresh_missing" && gate.result.kind !== "recoverable_missing") {
    throw new Error("missing_worktree_gate_expected");
  }
  return (await git.materializeRootWorkspace({
    repositoryIdentity: input.repositoryIdentity,
    rootIssueId: input.rootIssueId,
    rootIdentifier: input.rootIdentifier,
    baseBranch: input.baseBranch,
    expectedGate: gate.result,
  })).workspace;
}

function gateInput(overrides: Partial<{
  repositoryIdentity: string;
  rootIssueId: string;
  rootIdentifier: string;
  baseBranch: string;
  executionKind: "fresh" | "existing";
  requiredRevisions: string[];
}> = {}) {
  return {
    repositoryIdentity: "repository-1",
    rootIssueId: "root-1",
    rootIdentifier: "SYM-1",
    baseBranch: "main",
    executionKind: "fresh" as const,
    requiredRevisions: [],
    ...overrides,
  };
}
