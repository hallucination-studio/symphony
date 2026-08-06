import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { bindRootWorkspace } from "./RootWorkspace.js";

const execute = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execute("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "symphony-workspace-"));
  const workspace = path.join(base, "workspace");
  const runDirectory = path.join(base, "evidence");
  await Promise.all([mkdir(workspace), mkdir(runDirectory)]);
  await execute("git", ["init", "-b", "main", workspace]);
  await writeFile(path.join(workspace, "README.md"), "root workspace\n", "utf8");
  await execute("git", ["-C", workspace, "add", "README.md"]);
  await execute("git", [
    "-C", workspace, "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-m", "init",
  ]);
  return {
    base,
    workspace: await realpath(workspace),
    runDirectory: await realpath(runDirectory),
  };
}

test("adopts an exact supplied Git root without persisting a second binding", async () => {
  const input = await fixture();
  const bound = await bindRootWorkspace({
    rootId: "ENG-1",
    preferredWorkspace: input.workspace,
    invocationCwd: input.workspace,
    runDirectory: input.runDirectory,
  });

  assert.deepEqual(bound, {
    rootId: "ENG-1",
    workspacePath: input.workspace,
    runDirectory: input.runDirectory,
    rootBranch: "main",
  });
  await assert.rejects(stat(path.join(input.runDirectory, "root-binding.json")), { code: "ENOENT" });
});

test("creates a missing preferred path as an exact Root worktree and branch", async () => {
  const input = await fixture();
  const preferred = path.join(input.base, "prepared", "ENG-2");
  await mkdir(path.dirname(preferred));

  const bound = await bindRootWorkspace({
    rootId: "ENG-2",
    preferredWorkspace: preferred,
    invocationCwd: input.workspace,
    runDirectory: input.runDirectory,
  });

  const prepared = await realpath(preferred);
  assert.equal(bound.workspacePath, prepared);
  assert.equal(bound.rootBranch, "root/ENG-2");
  assert.equal(await git(prepared, ["symbolic-ref", "--quiet", "--short", "HEAD"]), "root/ENG-2");
  assert.equal(await git(input.workspace, ["worktree", "list", "--porcelain"]).then((value) => value.includes(prepared)), true);
});

test("uses the invocation Git top-level and current branch when no preferred path is supplied", async () => {
  const input = await fixture();
  const invocationCwd = path.join(input.workspace, "nested");
  await mkdir(invocationCwd);
  await writeFile(path.join(input.workspace, "untracked.txt"), "keep me\n", "utf8");

  const bound = await bindRootWorkspace({
    rootId: "ENG-3",
    invocationCwd,
    runDirectory: input.runDirectory,
  });

  assert.equal(bound.workspacePath, input.workspace);
  assert.equal(bound.rootBranch, "main");
  assert.equal(await git(input.workspace, ["status", "--porcelain"]), "?? untracked.txt");
  assert.equal(await git(input.workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"]), "main");
});

test("does not fall back when an exact preferred path cannot be prepared", async () => {
  const input = await fixture();
  const preferred = path.join(input.base, "not-a-worktree");
  await writeFile(preferred, "occupied\n", "utf8");

  await assert.rejects(
    bindRootWorkspace({
      rootId: "ENG-4",
      preferredWorkspace: preferred,
      invocationCwd: input.workspace,
      runDirectory: input.runDirectory,
    }),
    /invalid_root_workspace/u,
  );
  assert.equal(await git(input.workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"]), "main");
  assert.equal(await git(input.workspace, ["status", "--porcelain"]), "");
});

test("requires a writable run directory outside the workspace", async () => {
  const input = await fixture();
  const nested = path.join(input.workspace, "evidence");
  await mkdir(nested);
  await assert.rejects(
    bindRootWorkspace({
      rootId: "ENG-5",
      preferredWorkspace: input.workspace,
      invocationCwd: input.workspace,
      runDirectory: nested,
    }),
    /run_directory_inside_workspace/u,
  );
});
