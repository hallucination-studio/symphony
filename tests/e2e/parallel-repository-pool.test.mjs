import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { provisionParallelE2ERepositories } from "../../tools/e2e/parallel-repository-pool.mjs";

const execFile = promisify(execFileCallback);

test("parallel E2E repository pool creates three independent canonical Git clone contexts", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-repository-source-"));
  const sourceRepository = path.join(temporaryDirectory, "source");
  let pool;
  try {
    await initializeRepository(sourceRepository);
    pool = await provisionParallelE2ERepositories({ sourceRepositoryRoot: sourceRepository });

    assert.equal(pool.repositories.length, 3);
    assert.equal(new Set(pool.repositories.map(({ repository_handle }) => repository_handle)).size, 3);
    assert.equal(new Set(pool.repositories.map(({ repository_identity }) => repository_identity)).size, 3);
    const sourceGitDirectory = await realpath(await git(["-C", sourceRepository, "rev-parse", "--absolute-git-dir"]));
    for (const repository of pool.repositories) {
      assert.match(repository.repository_handle, /^[a-f0-9]{64}$/u);
      assert.equal(repository.repository_identity, repository.repository_handle);
      assert.equal(repository.base_branch, "main");
      assert.notEqual(repository.repository_root, sourceRepository);
      assert.equal(await git(["-C", repository.repository_root, "branch", "--show-current"]), "main");
      assert.notEqual(
        await canonicalPath(await git(["-C", repository.repository_root, "remote", "get-url", "origin"])),
        sourceGitDirectory,
      );
      assert.equal(
        await git(["-C", repository.repository_root, "ls-remote", "--heads", "origin", "refs/heads/main"]),
        `${await git(["-C", sourceRepository, "rev-parse", "HEAD"])}\trefs/heads/main`,
      );
    }

    const first = pool.repositories[0];
    await writeFile(path.join(first.repository_root, "delivery.txt"), "isolated delivery\n", "utf8");
    await git(["-C", first.repository_root, "add", "delivery.txt"]);
    await git([
      "-C", first.repository_root,
      "-c", "user.name=Symphony E2E",
      "-c", "user.email=symphony-e2e@example.test",
      "commit", "-m", "Verify isolated delivery",
    ]);
    await git(["-C", first.repository_root, "push", "origin", "HEAD:refs/heads/symphony/runs/e2e"]);
    assert.equal(await gitOptional(["-C", sourceRepository, "show-ref", "--verify", "refs/heads/symphony/runs/e2e"]), null);

    const poolDirectory = path.dirname(pool.repositories[0].repository_root);
    await pool.close();
    await assert.rejects(access(poolDirectory), { code: "ENOENT" });
  } finally {
    await pool?.close();
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

async function initializeRepository(directory) {
  await mkdir(directory, { recursive: true });
  await git(["init", "-b", "main", directory]);
  await writeFile(path.join(directory, "README.md"), "# E2E source\n", "utf8");
  await git(["-C", directory, "add", "README.md"]);
  await git([
    "-C", directory,
    "-c", "user.name=Symphony E2E",
    "-c", "user.email=symphony-e2e@example.test",
    "commit", "-m", "Initialize E2E source",
  ]);
}

async function git(arguments_) {
  const { stdout } = await execFile("git", arguments_, { maxBuffer: 1_048_576 });
  return stdout.trim();
}

async function gitOptional(arguments_) {
  try {
    return await git(arguments_);
  } catch {
    return null;
  }
}

async function canonicalPath(value) {
  return realpath(value);
}
