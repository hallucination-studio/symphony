import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
    for (const repository of pool.repositories) {
      assert.match(repository.repository_handle, /^[a-f0-9]{64}$/u);
      assert.equal(repository.repository_identity, repository.repository_handle);
      assert.equal(repository.base_branch, "main");
      assert.notEqual(repository.repository_root, sourceRepository);
      assert.equal(await git(["-C", repository.repository_root, "branch", "--show-current"]), "main");
    }

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
