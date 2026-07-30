import assert from "node:assert/strict";
import test from "node:test";

import { parseRepositoryId, parseRevision, parseRootIssueId } from "../../contracts/identity.js";
import { createDeliveryIdentity } from "../api/DeliveryInterface.js";
import { GitHubScm } from "./GitHubScm.js";

const identity = createDeliveryIdentity({
  provider: "github",
  root_id: parseRootIssueId("ROOT-1"),
  repository_id: parseRepositoryId("repo-1"),
  base_branch: "main",
});
const revision = parseRevision("a".repeat(40));

test("GitHub SCM projects exact PR identity from bounded gh JSON", async () => {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const scm = new GitHubScm("hallucination-studio/symphony", {
    run: (args) => {
      mutableCalls.push([...args]);
      return Promise.resolve(JSON.stringify([{
        url: "https://github.com/hallucination-studio/symphony/pull/123",
        state: "OPEN",
        baseRefName: "main",
        headRefName: identity.head_branch,
        headRefOid: revision,
      }]));
    },
  });

  assert.deepEqual(await scm.read(identity), [{
    provider: "github",
    repository_id: identity.repository_id,
    base_branch: identity.base_branch,
    head_branch: identity.head_branch,
    state: "open",
    head_revision: revision,
    url: "https://github.com/hallucination-studio/symphony/pull/123",
  }]);
  assert.deepEqual(mutableCalls[0], [
    "pr", "list", "--repo", "hallucination-studio/symphony", "--base", "main",
    "--head", identity.head_branch, "--state", "all",
    "--json", "url,state,baseRefName,headRefName,headRefOid",
  ]);
});

test("GitHub SCM creates one exact PR and reports command uncertainty without retry", async () => {
  const calls: string[][] = [];
  const accepted = new GitHubScm("hallucination-studio/symphony", {
    run: (args) => { calls.push([...args]); return Promise.resolve(""); },
  });
  assert.equal(await accepted.create(identity, revision), "accepted");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.slice(0, 8), [
    "pr", "create", "--repo", "hallucination-studio/symphony",
    "--base", "main", "--head", identity.head_branch,
  ]);

  let attempts = 0;
  const uncertain = new GitHubScm("hallucination-studio/symphony", {
    run: () => { attempts += 1; return Promise.reject(new Error("raw provider secret")); },
  });
  assert.equal(await uncertain.create(identity, revision), "unknown");
  assert.equal(attempts, 1);
});

test("GitHub SCM rejects malformed, duplicate, and foreign provider observations", async () => {
  for (const payload of [
    "{}",
    JSON.stringify([{ url: "not-a-url", state: "OPEN", baseRefName: "main", headRefName: identity.head_branch, headRefOid: revision }]),
    JSON.stringify([
      { url: "https://github.com/a/pull/1", state: "OPEN", baseRefName: "main", headRefName: identity.head_branch, headRefOid: revision },
      { url: "https://github.com/a/pull/2", state: "OPEN", baseRefName: "main", headRefName: identity.head_branch, headRefOid: revision },
    ]),
  ]) {
    const scm = new GitHubScm("hallucination-studio/symphony", { run: () => Promise.resolve(payload) });
    await assert.rejects(scm.read(identity), /github_pr_readback_invalid/u);
  }
  const scm = new GitHubScm("hallucination-studio/symphony", { run: () => Promise.resolve("[]") });
  await assert.rejects(scm.read({ ...identity, provider: "gitlab" }), /github_delivery_identity_mismatch/u);
});
