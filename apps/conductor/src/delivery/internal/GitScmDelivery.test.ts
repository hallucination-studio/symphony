import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  parseCorrelationId,
  parseRevision,
} from "../../contracts/identity.js";
import type { PullRequestSnapshot } from "../../contracts/observation.js";
import {
  createDeliveryIdentity,
  type DeliveryIdentity,
} from "../api/DeliveryInterface.js";
import {
  GitScmDelivery,
  type ScmBoundary,
} from "./GitScmDelivery.js";

const exec = promisify(execFile);

class FakeScm implements ScmBoundary {
  pullRequests: PullRequestSnapshot[] = [];
  createOutcome: "accepted" | "rejected" | "unknown" = "accepted";
  materialize = true;

  read(): Promise<readonly PullRequestSnapshot[]> {
    return Promise.resolve(this.pullRequests);
  }

  create(identity: DeliveryIdentity, revision: ReturnType<typeof parseRevision>): Promise<"accepted" | "rejected" | "unknown"> {
    if (this.materialize) {
      this.pullRequests = [{
        provider: identity.provider,
        repository_id: identity.repository_id,
        base_branch: identity.base_branch,
        head_branch: identity.head_branch,
        state: "open",
        head_revision: revision,
        url: "https://github.example/pull/1",
      }];
    }
    return Promise.resolve(this.createOutcome);
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-delivery-"));
  const remote = path.join(root, "remote.git");
  const repository = path.join(root, "repository");
  await git(root, "init", "--bare", remote);
  await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.name", "Symphony Test");
  await git(repository, "config", "user.email", "symphony@example.invalid");
  await git(repository, "commit", "--allow-empty", "-m", "initial");
  await git(repository, "remote", "add", "origin", remote);
  const revision = parseRevision(await git(repository, "rev-parse", "HEAD"));
  const identity = createDeliveryIdentity({
    provider: "github",
    root_id: "LIN-1",
    repository_id: "repo:1",
    base_branch: "main",
  });
  const scm = new FakeScm();
  const delivery = await GitScmDelivery.create({
    executable: "git",
    repository_path: repository,
    repository_id: identity.repository_id,
    command_timeout_ms: 5_000,
    max_output_bytes: 64 * 1024,
    scm,
  });
  return { root, repository, revision, identity, scm, delivery };
}

async function leaseRaceExecutable(root: string, branch: string, externalRevision: string): Promise<string> {
  const executable = path.join(root, "lease-race-git.mjs");
  const marker = path.join(root, "lease-race-fired");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "import { existsSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    `const args = process.argv.slice(2); const marker = ${JSON.stringify(marker)};`,
    `if (args.includes('push') && !existsSync(marker)) {`,
    `  spawnSync('git', ['push', 'origin', ${JSON.stringify(`${externalRevision}:refs/heads/${branch}`)}], { cwd: process.cwd(), stdio: 'inherit' });`,
    "  await import('node:fs/promises').then(({ writeFile }) => writeFile(marker, 'fired'));",
    "}",
    "const result = spawnSync('git', args, { cwd: process.cwd(), stdio: 'inherit' });",
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n"), "utf8");
  await chmod(executable, 0o700);
  return executable;
}

test("GitScmDelivery uses an expected-old lease for exact remote revision updates", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.delivery.read(f.identity)).remote_revision, null);
    const pushed = await f.delivery.push({
      identity: f.identity,
      verified_revision: f.revision,
      expected_remote_revision: null,
      correlation_id: parseCorrelationId("delivery:push"),
    });
    assert.equal(pushed.outcome, "applied");
    assert.equal((await f.delivery.read(f.identity)).remote_revision, f.revision);

    await git(f.repository, "commit", "--allow-empty", "-m", "next exact revision");
    const nextRevision = parseRevision(await git(f.repository, "rev-parse", "HEAD"));
    const updated = await f.delivery.push({
      identity: f.identity,
      verified_revision: nextRevision,
      expected_remote_revision: f.revision,
      correlation_id: parseCorrelationId("delivery:lease-update"),
    });
    assert.equal(updated.outcome, "applied");
    assert.equal((await f.delivery.read(f.identity)).remote_revision, nextRevision);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("GitScmDelivery reports a stale expected-old lease without overwriting an external update", async () => {
  const f = await fixture();
  try {
    await f.delivery.push({
      identity: f.identity,
      verified_revision: f.revision,
      expected_remote_revision: null,
      correlation_id: parseCorrelationId("delivery:lease-base"),
    });
    await git(f.repository, "commit", "--allow-empty", "-m", "external revision");
    const externalRevision = parseRevision(await git(f.repository, "rev-parse", "HEAD"));
    await git(f.repository, "commit", "--allow-empty", "-m", "candidate revision");
    const candidateRevision = parseRevision(await git(f.repository, "rev-parse", "HEAD"));
    const executable = await leaseRaceExecutable(f.root, f.identity.head_branch, externalRevision);
    const racedDelivery = await GitScmDelivery.create({
      executable,
      repository_path: f.repository,
      repository_id: f.identity.repository_id,
      command_timeout_ms: 5_000,
      max_output_bytes: 64 * 1024,
      scm: f.scm,
    });
    const conflict = await racedDelivery.push({
      identity: f.identity,
      verified_revision: candidateRevision,
      expected_remote_revision: f.revision,
      correlation_id: parseCorrelationId("delivery:stale-lease"),
    });

    assert.equal(conflict.outcome, "readback_mismatch");
    assert.equal(conflict.reason, "push_remote_conflict");
    assert.equal((await racedDelivery.read(f.identity)).remote_revision, externalRevision);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("GitScmDelivery classifies PR creation by fresh identity read-back without retry", async () => {
  const f = await fixture();
  try {
    const request = {
      identity: f.identity,
      verified_revision: f.revision,
      expected_remote_revision: f.revision,
      correlation_id: parseCorrelationId("delivery:create"),
    };
    await f.delivery.push({ ...request, expected_remote_revision: null });

    f.scm.createOutcome = "unknown";
    assert.equal((await f.delivery.createPullRequest(request)).outcome, "acceptance_unknown");
    assert.equal((await f.delivery.read(f.identity)).matching_pull_requests.length, 1);

    f.scm.pullRequests = [];
    f.scm.createOutcome = "rejected";
    f.scm.materialize = false;
    assert.equal((await f.delivery.createPullRequest(request)).outcome, "not_applied");

    f.scm.createOutcome = "accepted";
    assert.equal((await f.delivery.createPullRequest(request)).outcome, "readback_mismatch");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
