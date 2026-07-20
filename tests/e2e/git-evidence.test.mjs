import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { readRootGitEvidence } from "../../tools/e2e/git-evidence.mjs";
import { createRunScopedGitFixture } from "../../tools/e2e/run-fixtures.mjs";

const run = promisify(execFile);

test("Git evidence proves one clean Root branch with the exact output and commit", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-git-evidence-test-"));
  try {
    const fixture = await createRunScopedGitFixture({ runId: "git-evidence-1", parentDirectory: parent });
    const workspace = path.join(parent, "worktree-root-1");
    await run("git", ["-C", fixture.repositoryRoot, "worktree", "add", "-b", "symphony/runs/root-1", workspace, "main"]);
    await writeFile(path.join(workspace, "e2e-high.txt"), "high-priority root\n");
    await run("git", ["-C", workspace, "add", "e2e-high.txt"]);
    await run("git", ["-C", workspace, "commit", "-m", "Create high marker"]);

    const evidence = await readRootGitEvidence({
      repositoryRoot: fixture.repositoryRoot,
      branch: "symphony/runs/root-1",
      baselineHead: fixture.initialCommit,
      filename: "e2e-high.txt",
      expectedContent: "high-priority root\n",
    });

    assert.deepEqual(evidence.changedPaths, ["e2e-high.txt"]);
    assert.equal(evidence.branch, "symphony/runs/root-1");
    assert.equal(evidence.baselineHead, fixture.initialCommit);
    assert.equal(evidence.cleanStatus, true);
    assert.equal(evidence.commitCount, 1);
    assert.equal(evidence.commonGitDirValid, true);
    assert.match(evidence.head, /^[0-9a-f]{40}$/u);
    assert.match(evidence.outputDigest, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Git evidence rejects a Root branch containing an unrelated changed path", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-git-evidence-test-"));
  try {
    const fixture = await createRunScopedGitFixture({ runId: "git-evidence-2", parentDirectory: parent });
    const workspace = path.join(parent, "worktree-root-2");
    await mkdir(workspace, { recursive: true });
    await run("git", ["-C", fixture.repositoryRoot, "worktree", "add", "-b", "symphony/runs/root-2", workspace, "main"]);
    await writeFile(path.join(workspace, "e2e-medium.txt"), "medium-priority root\n");
    await writeFile(path.join(workspace, "unrelated.txt"), "wrong\n");
    await run("git", ["-C", workspace, "add", "--all"]);
    await run("git", ["-C", workspace, "commit", "-m", "Create invalid marker"]);

    await assert.rejects(
      readRootGitEvidence({
        repositoryRoot: fixture.repositoryRoot,
        branch: "symphony/runs/root-2",
        baselineHead: fixture.initialCommit,
        filename: "e2e-medium.txt",
        expectedContent: "medium-priority root\n",
      }),
      /e2e_git_output_mismatch/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
