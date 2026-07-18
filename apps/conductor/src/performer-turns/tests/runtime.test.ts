import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GlobalPerformerLane } from "../internal/GlobalPerformerLane.js";
import { NativeGitWorkspaceImpl } from "../../git-workspaces/internal/NativeGitWorkspaceImpl.js";
import {
  applyCorrelatedTurnResult,
  accumulateUsage,
} from "../../runtime-reporting/internal/RuntimeConvergence.js";
import { runCommand } from "../../composition/CommandRunner.js";
import { GitRootDeliveryImpl } from "../../root-delivery/internal/GitRootDeliveryImpl.js";
import { ConductorRuntime } from "../../composition/ConductorRuntime.js";

test("the global Performer lane serializes child processes", async () => {
  const lane = new GlobalPerformerLane();
  const log = path.join(await mkdtemp(path.join(tmpdir(), "performer-lane-")), "log");
  const script = [
    "const fs=require('fs');",
    "const [log,id,delay]=process.argv.slice(1);",
    "fs.appendFileSync(log, `start:${id}\\n`);",
    "setTimeout(()=>{fs.appendFileSync(log, `end:${id}\\n`)}, Number(delay));",
  ].join("");

  await Promise.all([
    lane.run({
      executable: process.execPath,
      arguments: ["-e", script, log, "one", "40"],
      deadlineMs: 1000,
    }),
    lane.run({
      executable: process.execPath,
      arguments: ["-e", script, log, "two", "1"],
      deadlineMs: 1000,
    }),
  ]);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "start:one",
    "end:one",
    "start:two",
    "end:two",
  ]);
});

test("the global Performer lane drains stdout before process exit", async () => {
  const lane = new GlobalPerformerLane();
  let observed: (() => void) | undefined;
  const stdoutObserved = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let processSettled = false;
  const running = lane.run({
    executable: process.execPath,
    arguments: [
      "-e",
      "process.stdout.write('event\\n');setTimeout(() => {}, 50)",
    ],
    deadlineMs: 1_000,
    onStdout() {
      observed?.();
    },
  });
  void running.finally(() => {
    processSettled = true;
  });

  await Promise.race([
    stdoutObserved,
    running.then(() => assert.fail("process exited before stdout was observed")),
  ]);
  assert.equal(processSettled, false);
  assert.equal((await running).stdout, "event\n");
});

test("stopping the Performer lane is bounded and rejects queued Turns", async () => {
  const lane = new GlobalPerformerLane();
  const active = lane.run({
    executable: process.execPath,
    arguments: ["-e", "setInterval(() => {}, 1000)"],
    deadlineMs: 10_000,
  });
  const queued = lane.run({
    executable: process.execPath,
    arguments: ["-e", "process.exit(0)"],
    deadlineMs: 1000,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await lane.cancelAndReap(100);
  await assert.rejects(active, /performer_process_failed/);
  await assert.rejects(queued, /performer_lane_stopped/);
});

test("Git workspace creation and Work commit leave the original checkout untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conductor-git-"));
  const repository = path.join(root, "repository");
  const worktrees = path.join(root, "worktrees");
  await runCommand("git", ["init", repository]);
  await runCommand("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", repository, "config", "user.name", "Symphony Test"]);
  await writeFile(path.join(repository, "README.md"), "base\n");
  await runCommand("git", ["-C", repository, "add", "README.md"]);
  await runCommand("git", ["-C", repository, "commit", "-m", "base"]);
  const baseBranch = (
    await runCommand("git", ["-C", repository, "branch", "--show-current"])
  ).stdout.trim();

  const git = new NativeGitWorkspaceImpl(repository, worktrees);
  const workspace = await git.ensureWorkspace({
    rootIssueId: "root-1",
    rootIdentifier: "SYM-1",
    baseBranch,
  });
  await writeFile(path.join(workspace.worktreePath, "README.md"), "changed\n");
  const commit = await git.commitWork(workspace, "SYM-2: implement work");
  assert.equal(commit.kind, "committed");
  assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "base\n");

  const resumed = await git.ensureWorkspace({
    rootIssueId: "root-1",
    rootIdentifier: "SYM-1",
    baseBranch,
  });
  assert.deepEqual(resumed, workspace);
});

test("stale or failed Linear application never becomes local success", async () => {
  const result = await applyCorrelatedTurnResult({
    command: {
      turnId: "turn-1",
      rootIssueId: "root-1",
      workIssueId: "work-1",
      performerProfileId: "profile-1",
      turnInputHash: "hash-1",
    },
    result: {
      turnId: "turn-1",
      rootIssueId: "root-1",
      workIssueId: "work-1",
      performerProfileId: "profile-1",
      turnInputHash: "hash-1",
    },
    latest: {
      rootState: "In Progress",
      conductorIdMatches: true,
      projectStillResolved: true,
      turnInputHash: "hash-2",
    },
    applyLinear: async () => {
      throw new Error("must not run");
    },
  });
  assert.deepEqual(result, { kind: "stale", reason: "turn_input_changed" });

  const failed = await applyCorrelatedTurnResult({
    command: {
      turnId: "turn-1",
      rootIssueId: "root-1",
      workIssueId: "work-1",
      performerProfileId: "profile-1",
      turnInputHash: "hash-1",
    },
    result: {
      turnId: "turn-1",
      rootIssueId: "root-1",
      workIssueId: "work-1",
      performerProfileId: "profile-1",
      turnInputHash: "hash-1",
    },
    latest: {
      rootState: "In Progress",
      conductorIdMatches: true,
      projectStillResolved: true,
      turnInputHash: "hash-1",
    },
    applyLinear: async () => ({
      kind: "failed",
      sanitizedReason: "Linear update exhausted after 4 attempts",
    }),
  });
  assert.deepEqual(failed, {
    kind: "blocked",
    reason: "Linear update exhausted after 4 attempts",
  });
});

test("usage is deduplicated by turn ID without double-counting cached input", () => {
  const initial = {
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 10,
    reasoningOutputTokens: 5,
    totalTokens: 110,
    lastUsageTurnId: "turn-1",
  };
  assert.deepEqual(
    accumulateUsage(initial, "turn-1", {
      inputTokens: 50,
      cachedInputTokens: 25,
      outputTokens: 5,
      reasoningOutputTokens: 2,
      totalTokens: 55,
    }),
    initial,
  );
  assert.equal(
    accumulateUsage(initial, "turn-2", {
      inputTokens: 50,
      cachedInputTokens: 25,
      outputTokens: 5,
      reasoningOutputTokens: 2,
      totalTokens: 55,
    }).totalTokens,
    165,
  );
});

test("delivery reuses an existing PR and never merges it", async () => {
  const calls: string[][] = [];
  const delivery = new GitRootDeliveryImpl(async (_executable, arguments_) => {
    calls.push(arguments_);
    return {
      stdout: '[{"url":"https://example.test/pr/1"}]\n',
      stderr: "",
      exitCode: 0,
    };
  });
  assert.deepEqual(
    await delivery.deliver({
      workspace: {
        branch: "symphony/runs/sym-1",
        worktreePath: "/private/worktree",
      },
      baseBranch: "main",
      title: "SYM-1",
      body: "Delivered by Symphony",
    }),
    { kind: "pull_request", url: "https://example.test/pr/1" },
  );
  assert.deepEqual(calls, [
    ["pr", "list", "--head", "symphony/runs/sym-1", "--json", "url", "--limit", "1"],
  ]);
});

test("database-free runtime reports Gateway failure and executes no action", async () => {
  let executed = false;
  const reports: Array<{ status: string; sanitizedReason?: string }> = [];
  const runtime = new ConductorRuntime(
    "conductor-1",
    {
      resolveProject: async () => {
        throw new Error("Linear unavailable after bounded retries");
      },
      listRoots: async () => [],
      reconstruct: async () => {
        throw new Error("not reached");
      },
    },
    {
      execute: async () => {
        executed = true;
      },
    },
    {
      report: async (report) => {
        reports.push(report);
      },
    },
  );
  await runtime.cycle();
  assert.equal(executed, false);
  assert.deepEqual(reports, [
    {
      status: "blocked",
      sanitizedReason: "Linear unavailable after bounded retries",
    },
  ]);
});
