import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

test("GitScmDelivery pushes only the exact local revision to the approved remote ref", async () => {
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

    await git(f.repository, "commit", "--allow-empty", "-m", "conflict");
    const otherRevision = parseRevision(await git(f.repository, "rev-parse", "HEAD"));
    await git(f.repository, "push", "origin", `${otherRevision}:refs/heads/${f.identity.head_branch}`);
    const conflict = await f.delivery.push({
      identity: f.identity,
      verified_revision: f.revision,
      expected_remote_revision: otherRevision,
      correlation_id: parseCorrelationId("delivery:conflict"),
    });
    assert.equal(conflict.outcome, "precondition_failed");
    assert.equal((await f.delivery.read(f.identity)).remote_revision, otherRevision);
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
