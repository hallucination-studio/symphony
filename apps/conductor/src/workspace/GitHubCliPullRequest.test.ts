import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createGitHubCliPullRequest,
  type GitHubCliProcess,
  type GitHubCliSpawn,
} from "./GitHubCliPullRequest.js";

class FakeProcess extends EventEmitter implements GitHubCliProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killedWith: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.killedWith.push(signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }
}

const request = {
  workspace_path: "/work/root",
  run_directory: "/work/evidence",
  root_branch: "root/ENG-42",
} as const;

function controlledSpawn(
  inspect?: (...args: Parameters<GitHubCliSpawn>) => void,
): { readonly child: FakeProcess; readonly spawn: GitHubCliSpawn } {
  const child = new FakeProcess();
  const spawn: GitHubCliSpawn = (executable, args, options) => {
    inspect?.(executable, args, options);
    return child;
  };
  return { child, spawn };
}

async function rejectionMessage(action: Promise<unknown>): Promise<string> {
  try {
    await action;
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
}

test("runs gh pr create with the Root branch, workspace, and minimal environment", async () => {
  const environment = {
    PATH: "/bin",
    HOME: "/home/test",
    GH_CONFIG_DIR: "/home/test/.config/gh",
    XDG_CONFIG_HOME: "/home/test/.config",
    TMPDIR: "/tmp/test",
    LANG: "private-language",
    LC_ALL: "private-locale",
    GH_TOKEN: "fixture-gh-token",
    GITHUB_TOKEN: "fixture-github-token",
    UNRELATED: "not-forwarded",
  };
  const controlled = controlledSpawn((executable, args, options) => {
    assert.equal(executable, "gh");
    assert.deepEqual(args, ["pr", "create", "--fill", "--head", "root/ENG-42"]);
    assert.deepEqual(options, {
      cwd: "/work/root",
      env: {
        PATH: "/bin",
        HOME: "/home/test",
        GH_CONFIG_DIR: "/home/test/.config/gh",
        XDG_CONFIG_HOME: "/home/test/.config",
        TMPDIR: "/tmp/test",
        GH_TOKEN: "fixture-gh-token",
        GITHUB_TOKEN: "fixture-github-token",
        LANG: "private-language",
        LC_ALL: "private-locale",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
  const createPullRequest = createGitHubCliPullRequest({
    spawn: controlled.spawn,
    environment,
  });

  const result = createPullRequest(request);
  controlled.child.stdout.end("https://github.com/acme/repo/pull/42\n");
  controlled.child.close(0);

  assert.equal(await result, "https://github.com/acme/repo/pull/42");
});

test("sanitizes synchronous and asynchronous process start failures", async () => {
  const privateDiagnostic = "provider diagnostic must stay private";
  const throwing = createGitHubCliPullRequest({
    spawn: () => { throw new Error(privateDiagnostic); },
  });
  assert.equal(await rejectionMessage(throwing(request)), "github_pr_start_failed");

  const controlled = controlledSpawn();
  const result = createGitHubCliPullRequest({ spawn: controlled.spawn })(request);
  controlled.child.emit("error", new Error(privateDiagnostic));
  const message = await rejectionMessage(result);
  assert.equal(message, "github_pr_start_failed");
  assert.equal(message.includes(privateDiagnostic), false);
});

test("sanitizes a nonzero exit and discards stderr", async () => {
  const privateDiagnostic = "fixture-gh-token";
  const controlled = controlledSpawn();
  const result = createGitHubCliPullRequest({
    spawn: controlled.spawn,
    environment: { GH_TOKEN: privateDiagnostic },
  })(request);
  controlled.child.stderr.end(privateDiagnostic);
  controlled.child.close(7);

  const message = await rejectionMessage(result);
  assert.equal(message, "github_pr_exit_nonzero");
  assert.equal(message.includes(privateDiagnostic), false);
});

test("bounds execution time and terminates the process", async () => {
  const controlled = controlledSpawn();
  const result = createGitHubCliPullRequest({
    spawn: controlled.spawn,
    timeout_ms: 5,
    kill_grace_ms: 5,
  })(request);

  assert.equal(await rejectionMessage(result), "github_pr_timed_out");
  assert.deepEqual(controlled.child.killedWith, ["SIGTERM", "SIGKILL"]);
});

test("bounds combined process output without exposing it", async () => {
  const privateOutput = "private-output";
  const controlled = controlledSpawn();
  const result = createGitHubCliPullRequest({
    spawn: controlled.spawn,
    max_output_bytes: 8,
    kill_grace_ms: 5,
  })(request);
  controlled.child.stdout.write(privateOutput);

  const message = await rejectionMessage(result);
  assert.equal(message, "github_pr_output_too_large");
  assert.equal(message.includes(privateOutput), false);
  assert.deepEqual(controlled.child.killedWith, ["SIGTERM", "SIGKILL"]);
});

for (const output of [
  "",
  "not a URL",
  "http://github.com/acme/repo/pull/42",
  "https://user@example.com/acme/repo/pull/42",
  "https://github.com/acme/repo/pull/42\nhttps://github.com/acme/repo/pull/43",
  "created https://github.com/acme/repo/pull/42",
]) {
  test(`rejects malformed pull request output: ${JSON.stringify(output)}`, async () => {
    const controlled = controlledSpawn();
    const result = createGitHubCliPullRequest({ spawn: controlled.spawn })(request);
    controlled.child.stdout.end(output);
    controlled.child.close(0);
    assert.equal(await rejectionMessage(result), "invalid_pull_request_url");
  });
}
