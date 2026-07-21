import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  cleanupTargetRunScope,
  createTargetGitFixture,
  createTargetRunScope,
  readTargetGitObservation,
} from "../../tools/e2e/target-workflow-fixtures.mjs";

const run = promisify(execFile);

test("target run scope and Git fixture expose a clean retained baseline", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-target-fixture-test-"));
  const scope = await createTargetRunScope({ runId: "target-fixture-1", parentDirectory: parent });
  try {
    const fixture = await createTargetGitFixture({ scope });
    const observation = await readTargetGitObservation({
      repositoryRoot: fixture.repositoryRoot,
      branch: fixture.baseBranch,
    });

    assert.equal(observation.branch, "main");
    assert.equal(observation.head, fixture.initialCommit);
    assert.equal(observation.clean, true);
    assert.equal(observation.repositoryIdentity, await realpath(fixture.repositoryRoot));
    assert.equal(await run("git", ["-C", fixture.repositoryRoot, "status", "--porcelain"]).then(({ stdout }) => stdout), "");
    assert.match(await readFile(path.join(fixture.repositoryRoot, "README.md"), "utf8"), /target-fixture-1/u);
    assert.deepEqual(Object.keys(fixture).sort(), ["baseBranch", "initialCommit", "repositoryRoot"]);
  } finally {
    await cleanupTargetRunScope(scope);
    await assert.rejects(access(scope.root));
    await rm(parent, { recursive: true, force: true });
  }
});

test("target Git observation rejects a branch that is not the current clean workspace", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-target-fixture-test-"));
  const scope = await createTargetRunScope({ runId: "target-fixture-2", parentDirectory: parent });
  try {
    const fixture = await createTargetGitFixture({ scope });
    await run("git", ["-C", fixture.repositoryRoot, "checkout", "-b", "other"]);

    await assert.rejects(
      readTargetGitObservation({ repositoryRoot: fixture.repositoryRoot, branch: "main" }),
      /target_git_observation_mismatch/u,
    );
  } finally {
    await cleanupTargetRunScope(scope);
    await rm(parent, { recursive: true, force: true });
  }
});

test("target scope cleanup fails closed for a foreign owner", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-target-fixture-test-"));
  const scope = await createTargetRunScope({ runId: "target-fixture-3", parentDirectory: parent });
  try {
    const marker = path.join(scope.root, ".symphony-target-run");
    await writeFile(marker, "foreign\n");
    await assert.rejects(cleanupTargetRunScope(scope), /target_run_scope_cleanup_invalid/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
