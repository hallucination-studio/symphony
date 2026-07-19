import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../../composition/CommandRunner.js";
import { NativeGitWorkspaceImpl } from "../internal/NativeGitWorkspaceImpl.js";

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

  const git = new NativeGitWorkspaceImpl(repository, worktrees, {
    test: ["git", ["diff", "--check"]],
  });
  for (const forbidden of ["checkout", "switch", "merge", "rebase", "reset", "clean", "push"]) {
    assert.equal(forbidden in git, false);
  }
  const workspace = await git.ensureWorkspace({ rootIssueId: "root-1", rootIdentifier: "SYM-1", baseBranch: "main" });
  const initial = await git.inspect(workspace);
  assert.equal(initial.status.returned, 0);
  assert.match(initial.head, /^[a-f0-9]{40}$/);

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
  const workspace = await git.ensureWorkspace({ rootIssueId: "root-1", rootIdentifier: "SYM-1", baseBranch: "main" });
  const head = (await git.inspect(workspace)).head;
  await writeFile(path.join(workspace.worktreePath, "README.md"), "changed\n");
  const result = await git.commit({ workspace, rootIssueId: "root-1", issueId: "work-1", allowedIssueIds: ["work-1"], issueIdentifier: "SYM-2", expectedHead: head });
  assert.equal(result.kind, "committed");
  assert.notEqual(result.commit, head);
});
