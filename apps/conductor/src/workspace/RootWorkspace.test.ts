import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { bindRootWorkspace } from "./RootWorkspace.js";

const execute = promisify(execFile);

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "symphony-workspace-"));
  const workspace = path.join(base, "workspace");
  const runDirectory = path.join(base, "evidence");
  const remote = path.join(base, "remote.git");
  await Promise.all([mkdir(workspace), mkdir(runDirectory)]);
  await execute("git", ["init", "--bare", remote]);
  await execute("git", ["init", "-b", "root/ENG-1", workspace]);
  await execute("git", ["-C", workspace, "remote", "add", "origin", remote]);
  await writeFile(path.join(workspace, "README.md"), "root workspace\n", "utf8");
  await execute("git", ["-C", workspace, "add", "README.md"]);
  await execute("git", ["-C", workspace, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  return { workspace: await realpath(workspace), runDirectory: await realpath(runDirectory) };
}

test("binds one supplied Root to an external Git workspace and run directory", async () => {
  const input = await fixture();
  const bound = await bindRootWorkspace({ rootId: "ENG-1", ...input });

  assert.equal(bound.rootId, "ENG-1");
  assert.equal(bound.rootBranch, "root/ENG-1");
  assert.equal(bound.workspacePath, input.workspace);
  assert.equal(bound.runDirectory, input.runDirectory);
  const record = JSON.parse(await readFile(path.join(input.runDirectory, "root-binding.json"), "utf8")) as unknown;
  assert.deepEqual(record, {
    root_id: "ENG-1",
    workspace_path: input.workspace,
    run_directory: input.runDirectory,
    root_branch: "root/ENG-1",
  });
});

test("accepts an exact restart binding and rejects a different Root", async () => {
  const input = await fixture();
  const first = await bindRootWorkspace({ rootId: "ENG-1", ...input });
  assert.deepEqual(await bindRootWorkspace({ rootId: "ENG-1", ...input }), first);
  await assert.rejects(bindRootWorkspace({ rootId: "ENG-2", ...input }), /root_binding_mismatch/u);
});

test("rejects run directories inside the workspace", async () => {
  const input = await fixture();
  const nested = path.join(input.workspace, "evidence");
  await mkdir(nested);
  await assert.rejects(
    bindRootWorkspace({ rootId: "ENG-1", workspace: input.workspace, runDirectory: nested }),
    /run_directory_inside_workspace/u,
  );
});

test("rejects a detached workspace or a workspace without a remote", async () => {
  const detached = await fixture();
  await execute("git", ["-C", detached.workspace, "checkout", "--detach"]);
  await assert.rejects(bindRootWorkspace({ rootId: "ENG-1", ...detached }), /workspace_branch_unavailable/u);

  const noRemote = await fixture();
  await execute("git", ["-C", noRemote.workspace, "remote", "remove", "origin"]);
  await assert.rejects(bindRootWorkspace({ rootId: "ENG-1", ...noRemote }), /workspace_remote_unavailable/u);
});
