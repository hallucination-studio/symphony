import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runBlackBoxScenario } from "./black-box-runner.mjs";
import {
  SCENARIO_TIMEOUT_MS,
  cleanupGitFixture,
  cleanupLinearFixture,
  conductorConfiguration,
  createGitFixture,
  createLinearFixture,
  delegateRoot,
  readRootTree,
  updateIssueState,
  waitForInReview,
} from "./accepted-root.test.mjs";

const NODE_TEST_TIMEOUT_MS = 4 * 60_000;

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function rootHomePath(git, rootId) {
  return path.join(
    git.programDataPath,
    "root-reconcills",
    Buffer.from(rootId, "utf8").toString("hex"),
  );
}

function worktreeRootPath(git) {
  return path.join(
    git.programDataPath,
    "worktrees",
    Buffer.from(git.repositoryId, "utf8").toString("hex"),
  );
}

function cycleWorktreePath(git, cycleId) {
  return path.join(worktreeRootPath(git), Buffer.from(cycleId, "utf8").toString("hex"));
}

test("RM-E2E-009 external Done closes the bound Root before owned cleanup and process exit", {
  timeout: NODE_TEST_TIMEOUT_MS,
}, async () => {
  const runId = `e9-cleanup-${randomUUID().replaceAll("-", "")}`;
  const fixtureDirectory = `e2e-fixture/${runId}`;
  await runBlackBoxScenario({
    scenario: async ({ fixtures, product }) => {
      const linear = await fixtures.create({
        setup: (access) => createLinearFixture(access, runId, fixtureDirectory),
        cleanup: cleanupLinearFixture,
      });
      const git = await fixtures.create({
        setup: () => createGitFixture(linear.rootId),
        cleanup: cleanupGitFixture,
      });
      await writeFile(git.configPath, `${JSON.stringify(conductorConfiguration(linear, git), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });

      const foreignHome = path.join(git.programDataPath, "root-reconcills", "foreign-root");
      const foreignWorktree = path.join(worktreeRootPath(git), "foreign-cycle");
      await mkdir(foreignHome, { recursive: true, mode: 0o700 });
      await mkdir(foreignWorktree, { recursive: true, mode: 0o700 });
      await writeFile(path.join(foreignHome, "owner.txt"), "foreign-root\n", { mode: 0o600 });
      await writeFile(path.join(foreignWorktree, "owner.txt"), "foreign-cycle\n", { mode: 0o600 });

      const running = await product.start(git.configPath);
      await fixtures.operate((access) => delegateRoot(access, linear));
      const accepted = await Promise.race([
        waitForInReview(fixtures, linear, Date.now() + SCENARIO_TIMEOUT_MS, new AbortController().signal),
        running.waitForFailure(),
      ]);
      assert.equal(accepted.root.state, "In Review");
      assert.equal(accepted.cycles.length, 1);
      const cycleIds = accepted.cycles.map((cycle) => cycle.id);
      const home = rootHomePath(git, linear.rootId);
      assert.equal(await pathExists(home), true, "bound_root_home_missing_before_done");

      await fixtures.operate((access) => updateIssueState(
        access,
        linear.rootId,
        linear.states.Done,
        "external_done_update_failed",
      ));
      const exit = await Promise.race([
        running.waitForExit(),
        running.waitForFailure(),
      ]);
      assert.deepEqual(exit, { status: "stopped" });

      const finalTree = await fixtures.operate((access) => readRootTree(access, linear));
      assert.equal(finalTree.root.state, "Done");
      assert.equal(await pathExists(home), false, "bound_root_home_not_cleaned");
      for (const cycleId of cycleIds) {
        assert.equal(await pathExists(cycleWorktreePath(git, cycleId)), false, "owned_cycle_worktree_not_cleaned");
      }
      assert.equal(await pathExists(foreignHome), true, "foreign_root_home_deleted");
      assert.equal(await pathExists(foreignWorktree), true, "foreign_worktree_deleted");
    },
  });
});
