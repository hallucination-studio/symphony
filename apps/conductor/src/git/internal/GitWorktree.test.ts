import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  parseCorrelationId,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
} from "../../contracts/identity.js";
import { createDeliveryIdentity } from "../../delivery/api/DeliveryInterface.js";
import type { PrepareWorkspaceRequest, RootWorkspaceIdentity } from "../api/GitWorkspaceInterface.js";
import { GitWorktree } from "./GitWorktree.js";

const exec = promisify(execFile);
const repositoryId = parseRepositoryId("repo:fixture");

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function repository(cleanup: (callback: () => Promise<void>) => void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-git-worktree-"));
  cleanup(() => rm(directory, { recursive: true, force: true }));
  const repositoryPath = path.join(directory, "repository");
  const worktreeRoot = path.join(directory, "worktrees");
  await Promise.all([mkdir(repositoryPath), mkdir(worktreeRoot)]);
  await git(repositoryPath, ["init", "--initial-branch=main"]);
  await git(repositoryPath, ["config", "user.name", "Symphony Test"]);
  await git(repositoryPath, ["config", "user.email", "symphony@example.invalid"]);
  await writeFile(path.join(repositoryPath, "README.md"), "baseline\n", "utf8");
  await git(repositoryPath, ["add", "README.md"]);
  await git(repositoryPath, ["commit", "-m", "baseline"]);
  const revision = parseRevision(await git(repositoryPath, ["rev-parse", "HEAD"]));
  const workspace = await GitWorktree.create({
    executable: "git",
    repository_id: repositoryId,
    repository_path: repositoryPath,
    worktree_root: worktreeRoot,
    command_timeout_ms: 10_000,
    max_output_bytes: 4 * 1024 * 1024,
  });
  return { directory, repositoryPath, worktreeRoot, revision, workspace };
}

function identity(root: string): RootWorkspaceIdentity {
  const rootId = parseRootIssueId(root);
  const delivery = createDeliveryIdentity({
    provider: "github",
    root_id: rootId,
    repository_id: repositoryId,
    base_branch: "main",
  });
  return {
    root_id: rootId,
    repository_id: repositoryId,
    base_branch: "main",
    head_branch: delivery.head_branch,
  };
}

function prepare(workspaceIdentity: RootWorkspaceIdentity, revision: ReturnType<typeof parseRevision>): PrepareWorkspaceRequest {
  return {
    ...workspaceIdentity,
    correlation_id: parseCorrelationId(`prepare:${workspaceIdentity.root_id}`),
    expected_base_revision: revision,
  };
}

test("prepare creates one clean Root branch/worktree at the exact base and is idempotent by read-back", async (context) => {
  const f = await repository((callback) => context.after(callback));
  const root = identity("LIN-1");

  const first = await f.workspace.prepare(prepare(root, f.revision));
  const second = await f.workspace.prepare(prepare(root, f.revision));
  const observation = await f.workspace.read(root);

  assert.equal(first.outcome, "applied");
  assert.equal(second.outcome, "applied");
  assert.equal(observation.head_revision, f.revision);
  assert.equal(observation.workspace_state, "clean");
  assert.equal(observation.base_branch, "main");
  assert.equal(observation.head_branch, root.head_branch);
  assert.equal(await readFile(path.join(f.workspace.pathFor(root.root_id), "README.md"), "utf8"), "baseline\n");
  assert.equal((await git(f.repositoryPath, ["worktree", "list", "--porcelain"])).match(/^worktree /gmu)?.length, 2);
});

test("prepare refuses stale base, occupied path, and pre-existing branch without overwrite or repair", async (context) => {
  const f = await repository((callback) => context.after(callback));
  const staleRoot = identity("LIN-1");
  const stale = await f.workspace.prepare(prepare(staleRoot, parseRevision("a".repeat(40))));
  assert.equal(stale.outcome, "precondition_failed");

  const occupiedRoot = identity("LIN-2");
  const occupiedPath = f.workspace.pathFor(occupiedRoot.root_id);
  await mkdir(occupiedPath);
  await writeFile(path.join(occupiedPath, "owner.txt"), "foreign\n", "utf8");
  const occupied = await f.workspace.prepare(prepare(occupiedRoot, f.revision));
  assert.equal(occupied.outcome, "not_applied");
  assert.equal(await readFile(path.join(occupiedPath, "owner.txt"), "utf8"), "foreign\n");

  const branchRoot = identity("LIN-3");
  await git(f.repositoryPath, ["branch", branchRoot.head_branch, f.revision]);
  const branchConflict = await f.workspace.prepare(prepare(branchRoot, f.revision));
  assert.equal(branchConflict.outcome, "not_applied");
  assert.equal(await git(f.repositoryPath, ["rev-parse", branchRoot.head_branch]), f.revision);
});

test("read stops on a missing or foreign-branch worktree and never rebuilds it", async (context) => {
  const f = await repository((callback) => context.after(callback));
  const missingRoot = identity("LIN-1");
  assert.equal((await f.workspace.prepare(prepare(missingRoot, f.revision))).outcome, "applied");
  const missingPath = f.workspace.pathFor(missingRoot.root_id);
  const movedPath = `${missingPath}-moved`;
  await rename(missingPath, movedPath);
  await assert.rejects(f.workspace.read(missingRoot), /git_workspace_missing/u);
  await assert.rejects(readFile(path.join(missingPath, "README.md")), /ENOENT/u);

  const foreignRoot = identity("LIN-2");
  assert.equal((await f.workspace.prepare(prepare(foreignRoot, f.revision))).outcome, "applied");
  const foreignPath = f.workspace.pathFor(foreignRoot.root_id);
  await git(foreignPath, ["switch", "-c", "foreign-branch"]);
  await assert.rejects(f.workspace.read(foreignRoot), /git_workspace_identity_mismatch/u);
  assert.equal(await git(foreignPath, ["branch", "--show-current"]), "foreign-branch");
});

test("read detects tracked, untracked, and binary changes in the full diff digest", async (context) => {
  const f = await repository((callback) => context.after(callback));
  const root = identity("LIN-1");
  assert.equal((await f.workspace.prepare(prepare(root, f.revision))).outcome, "applied");
  const worktreePath = f.workspace.pathFor(root.root_id);
  const clean = await f.workspace.read(root);

  await writeFile(path.join(worktreePath, "README.md"), "changed\n", "utf8");
  await writeFile(path.join(worktreePath, "new.bin"), Buffer.from([0, 1, 2, 255]));
  const dirty = await f.workspace.read(root);

  assert.equal(dirty.workspace_state, "dirty");
  assert.notEqual(dirty.diff_digest, clean.diff_digest);
  await rm(path.join(worktreePath, "new.bin"));
  const trackedOnly = await f.workspace.read(root);
  assert.notEqual(trackedOnly.diff_digest, dirty.diff_digest);
});

test("two Roots receive disjoint worktrees, branches, and mutable files", async (context) => {
  const f = await repository((callback) => context.after(callback));
  const first = identity("LIN-1");
  const second = identity("LIN-2");
  assert.equal((await f.workspace.prepare(prepare(first, f.revision))).outcome, "applied");
  assert.equal((await f.workspace.prepare(prepare(second, f.revision))).outcome, "applied");

  const firstPath = f.workspace.pathFor(first.root_id);
  const secondPath = f.workspace.pathFor(second.root_id);
  await writeFile(path.join(firstPath, "README.md"), "first root\n", "utf8");

  assert.notEqual(firstPath, secondPath);
  assert.notEqual(first.head_branch, second.head_branch);
  assert.equal(await readFile(path.join(secondPath, "README.md"), "utf8"), "baseline\n");
  assert.equal((await f.workspace.read(first)).workspace_state, "dirty");
  assert.equal((await f.workspace.read(second)).workspace_state, "clean");
});
