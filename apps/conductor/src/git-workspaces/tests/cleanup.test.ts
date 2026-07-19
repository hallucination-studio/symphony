import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../../composition/CommandRunner.js";
import { NativeGitWorkspaceImpl } from "../internal/NativeGitWorkspaceImpl.js";
import { unsafeCleanupPath } from "../internal/SafeWorktreeCleanup.js";

test("worktree cleanup removes one delivered terminal clean pushed worktree", async () => {
  const fixture = await setup();
  assert.deepEqual(await fixture.git.cleanup(input(fixture.workspace)), { kind: "removed" });
  await assert.rejects(runCommand("git", ["-C", fixture.workspace.worktreePath, "status"]));
  const list = await runCommand("git", ["-C", fixture.repository, "worktree", "list", "--porcelain"]);
  assert.doesNotMatch(list.stdout, new RegExp(fixture.workspace.worktreePath));
});

test("worktree cleanup rejects dirty, live, unpushed, and unproven delivery states", async () => {
  const dirty = await setup();
  await writeFile(path.join(dirty.workspace.worktreePath, "dirty.txt"), "dirty\n");
  await assert.rejects(dirty.git.cleanup(input(dirty.workspace)), /git_worktree_cleanup_dirty/);

  const live = await setup();
  await assert.rejects(live.git.cleanup({ ...input(live.workspace), hasLiveWriter: true }),
    /git_worktree_cleanup_live_writer/);
  await assert.rejects(live.git.cleanup({ ...input(live.workspace), hasActivePermit: true }),
    /git_worktree_cleanup_active_permit/);
  await assert.rejects(live.git.cleanup({ ...input(live.workspace), deliveryProven: false }),
    /git_worktree_cleanup_delivery_unproven/);

  const ahead = await setup();
  await writeFile(path.join(ahead.workspace.worktreePath, "ahead.txt"), "ahead\n");
  await runCommand("git", ["-C", ahead.workspace.worktreePath, "add", "."]);
  await runCommand("git", ["-C", ahead.workspace.worktreePath, "commit", "-m", "ahead"]);
  await assert.rejects(ahead.git.cleanup(input(ahead.workspace)),
    /git_worktree_cleanup_unpushed_commits/);
});

test("worktree cleanup rejects broad and foreign paths", async () => {
  const fixture = await setup();
  await assert.rejects(fixture.git.cleanup({ ...input(fixture.workspace), terminal: false }),
    /git_worktree_cleanup_not_authorized/);
  await assert.rejects(fixture.git.cleanup(input({ ...fixture.workspace,
    worktreePath: fixture.repository })), /git_worktree_cleanup_path_unsafe/);
  await assert.rejects(fixture.git.cleanup(input({ ...fixture.workspace,
    worktreePath: path.dirname(fixture.workspace.worktreePath) })),
    /git_worktree_cleanup_path_unsafe/);
  assert.equal(unsafeCleanupPath("/users/test", "/repo", "/data/worktrees", "/users/test"), true);
  assert.equal(unsafeCleanupPath("/data/worktrees", "/repo", "/data/worktrees", "/users/test"), true);
  const foreign = await mkdtemp(path.join(tmpdir(), "symphony-foreign-"));
  await assert.rejects(fixture.git.cleanup(input({ ...fixture.workspace,
    worktreePath: foreign })), /git_worktree_cleanup_path_unsafe/);

  await assert.rejects(fixture.git.cleanup(input({ ...fixture.workspace,
    branch: "symphony/runs/other" })), /git_worktree_cleanup_identity_mismatch/);
  await runCommand("git", ["-C", fixture.workspace.worktreePath, "branch", "--unset-upstream"]);
  await assert.rejects(fixture.git.cleanup(input(fixture.workspace)),
    /git_worktree_cleanup_upstream_unproven/);
});

function input(workspace: { branch: string; worktreePath: string; rootIssueId?: string }) {
  return { workspace, terminal: true, explicitlyAuthorized: false,
    hasLiveWriter: false, hasActivePermit: false, deliveryProven: true };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-cleanup-"));
  const remote = path.join(root, "remote.git");
  const repository = path.join(root, "repository");
  const worktrees = path.join(root, "worktrees");
  await runCommand("git", ["init", "--bare", remote]);
  await runCommand("git", ["clone", remote, repository]);
  await runCommand("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", repository, "config", "user.name", "Test"]);
  await writeFile(path.join(repository, "README.md"), "initial\n");
  await runCommand("git", ["-C", repository, "add", "."]);
  await runCommand("git", ["-C", repository, "commit", "-m", "initial"]);
  await runCommand("git", ["-C", repository, "push", "-u", "origin", "HEAD:main"]);
  const git = new NativeGitWorkspaceImpl(repository, worktrees);
  const workspace = await git.ensureWorkspace({
    rootIssueId: "root-1", rootIdentifier: "SYM-1", baseBranch: "main",
  });
  await runCommand("git", ["-C", workspace.worktreePath, "push", "-u", "origin", workspace.branch]);
  return { git, repository, workspace };
}
