import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import type { RootWorkspace } from "../contracts/workspace.js";
import { publishPullRequest } from "./TerminalPullRequest.js";

const execute = promisify(execFile);

interface Fixture {
  readonly workspace: string;
  readonly runDirectory: string;
  readonly remote: string;
  readonly rootBranch: string;
}

async function git(workspace: string, args: readonly string[]): Promise<string> {
  const result = await execute("git", ["-C", workspace, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function fixture(context: TestContext): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-terminal-pr-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace");
  const runDirectory = path.join(directory, "run-evidence");
  const remote = path.join(directory, "remote.git");
  const rootBranch = "root/ENG-1";
  await mkdir(workspace);
  await mkdir(runDirectory);
  await execute("git", ["init", "--bare", remote]);
  await execute("git", ["init", "-b", rootBranch, workspace]);
  await git(workspace, ["remote", "add", "origin", remote]);
  await writeFile(path.join(workspace, "README.md"), "root workspace\n", "utf8");
  await git(workspace, ["add", "README.md"]);
  await execute("git", [
    "-C", workspace,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "commit", "-m", "init",
  ]);
  return { workspace, runDirectory, remote, rootBranch };
}

async function fakePrCli(context: TestContext, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-fake-pr-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pr-cli");
  await writeFile(executable, `#!${process.execPath}\n${source}\n`, "utf8");
  await chmod(executable, 0o700);
  return executable;
}

function rootWorkspace(world: Fixture): RootWorkspace {
  return {
    workspace_path: world.workspace,
    run_directory: world.runDirectory,
    root_branch: world.rootBranch,
  };
}

async function evidence(world: Fixture): Promise<readonly Record<string, unknown>[]> {
  const files = (await readdir(world.runDirectory)).filter((file) => file.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const source = await readFile(path.join(world.runDirectory, files[0] as string), "utf8");
  return source.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("publishes a changed Root workspace once and records bounded external command evidence", async (context) => {
  const world = await fixture(context);
  const prCli = await fakePrCli(context, [
    'if (process.argv[2] !== "root/ENG-1") process.exit(3);',
    'process.stdout.write("https://github.example/pull/1\\n");',
  ].join("\n"));
  await writeFile(path.join(world.workspace, "change.txt"), "published\n", "utf8");
  const events: string[] = [];

  const result = await publishPullRequest(rootWorkspace(world), {
    onPublishing: () => { events.push("publishing"); },
    createPullRequest: async (request) => {
      events.push("create_pr");
      assert.equal(request.root_branch, world.rootBranch);
      assert.equal(await git(world.workspace, ["status", "--porcelain"]), "");
      assert.equal(await git(world.workspace, ["show", "HEAD:change.txt"]), "published");
      const response = await execute(prCli, [request.root_branch], {
        cwd: request.workspace_path,
        encoding: "utf8",
      });
      return response.stdout.trim();
    },
  });

  assert.deepEqual(result, {
    status: "created",
    pull_request_url: "https://github.example/pull/1",
    root_branch: world.rootBranch,
  });
  assert.deepEqual(events, ["publishing", "create_pr"]);
  assert.equal(await git(world.workspace, ["ls-remote", "origin", `refs/heads/${world.rootBranch}`])
    .then((value) => value.endsWith(`refs/heads/${world.rootBranch}`)), true);

  const records = await evidence(world);
  assert.deepEqual(records.map((record) => record.step), ["validate", "stage", "commit", "push", "create_pr"]);
  for (const record of records) {
    assert.equal(typeof record.command, "string");
    assert.ok(Buffer.byteLength(JSON.stringify(record), "utf8") <= 16 * 1024);
  }
});

test("rejects an empty workspace before publishing and leaves the callback untouched", async (context) => {
  const world = await fixture(context);
  let publishingCalls = 0;
  let createPullRequestCalls = 0;

  const result = await publishPullRequest(rootWorkspace(world), {
    onPublishing: () => { publishingCalls += 1; },
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      return "https://github.example/pull/never";
    },
  });

  assert.deepEqual(result, {
    status: "failed",
    step: "validate",
    reason: "workspace_diff_empty",
  });
  assert.equal(publishingCalls, 0);
  assert.equal(createPullRequestCalls, 0);
  assert.deepEqual((await evidence(world)).map((record) => record.step), ["validate"]);
});

test("a publishing callback failure is sanitized and does not stage or commit the workspace", async (context) => {
  const world = await fixture(context);
  await writeFile(path.join(world.workspace, "change.txt"), "retained\n", "utf8");
  const secret = "Authorization: Bearer callback-secret";

  const result = await publishPullRequest(rootWorkspace(world), {
    onPublishing: () => { throw new Error(secret); },
    createPullRequest: async () => "https://github.example/pull/never",
  });

  assert.deepEqual(result, {
    status: "failed",
    step: "validate",
    reason: "publishing_callback_failed",
  });
  assert.equal(result.reason.includes(secret), false);
  assert.match(await git(world.workspace, ["status", "--porcelain"]), /\?\? change\.txt/u);
  assert.deepEqual((await evidence(world)).map((record) => record.step), ["validate"]);
});

test("fails closed when the terminal PR evidence directory cannot be written", async (context) => {
  const world = await fixture(context);
  await writeFile(path.join(world.workspace, "change.txt"), "retain evidence boundary\n", "utf8");
  await rm(world.runDirectory, { recursive: true, force: true });

  await assert.rejects(
    publishPullRequest(rootWorkspace(world), {
      createPullRequest: async () => "https://github.example/pull/never",
    }),
    /terminal_pr_evidence_write_failed/u,
  );
});

test("PR creation failure reports the delivered branch and the bounded current error message", async (context) => {
  const world = await fixture(context);
  await writeFile(path.join(world.workspace, "change.txt"), "keep for inspection\n", "utf8");
  const providerError = "provider unavailable after push ".repeat(4);

  const result = await publishPullRequest(rootWorkspace(world), {
    createPullRequest: async () => { throw new Error(providerError); },
  });

  assert.deepEqual(result, {
    status: "branch_delivered",
    root_branch: world.rootBranch,
    reason: providerError.slice(0, 50),
  });
  assert.equal(await git(world.workspace, ["status", "--porcelain"]), "");
  assert.equal(await git(world.workspace, ["show", "HEAD:change.txt"]), "keep for inspection");
  assert.equal(await git(world.workspace, ["ls-remote", "origin", `refs/heads/${world.rootBranch}`])
    .then((value) => value.endsWith(`refs/heads/${world.rootBranch}`)), true);
  assert.deepEqual((await evidence(world)).map((record) => record.step), ["validate", "stage", "commit", "push", "create_pr"]);
});

test("an invalid PR result after push is a delivered branch with its current error", async (context) => {
  const world = await fixture(context);
  await writeFile(path.join(world.workspace, "change.txt"), "keep branch\n", "utf8");

  const result = await publishPullRequest(rootWorkspace(world), {
    createPullRequest: async () => "not-a-url",
  });

  assert.deepEqual(result, {
    status: "branch_delivered",
    root_branch: world.rootBranch,
    reason: "invalid_pull_request_url",
  });
  assert.equal(await git(world.workspace, ["ls-remote", "origin", `refs/heads/${world.rootBranch}`])
    .then((value) => value.endsWith(`refs/heads/${world.rootBranch}`)), true);
});
