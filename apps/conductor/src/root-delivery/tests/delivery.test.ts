import assert from "node:assert/strict";
import test from "node:test";

import type { RootDeliveryFacts } from "../api/RootDeliveryInterface.js";
import { GitRootDeliveryImpl } from "../internal/GitRootDeliveryImpl.js";

const workspace = { branch: "symphony/runs/sym-1", worktreePath: "/worktree", rootIssueId: "root-1" };
const expected = {
  root_version: "version-1",
  performer_id: "conversation-1",
  tree_digest: "tree-1",
  git_head: "abc123",
  checks_digest: "checks-1",
  latest_succeeded_cycle: {
    issue_id: "cycle-1",
    verify_result_id: "verify-execution-1",
    verified_revision: "abc123",
  },
  owner_generation: "generation-1",
};
const baseFacts: RootDeliveryFacts = {
  root_issue_id: "root-1",
  root_version: "version-1",
  performer_id: "conversation-1",
  terminal: false,
  blocker_issue_ids: [],
  tree_digest: "tree-1",
  tree_complete: true,
  git_head: "abc123",
  checks_digest: "checks-1",
  checks_passed: true,
  latest_succeeded_cycle: {
    issue_id: "cycle-1",
    verify_result_id: "verify-execution-1",
    verified_revision: "abc123",
  },
  owner_generation: "generation-1",
};

test("delivery rejects every stale precondition before push or PR creation", async () => {
  for (const patch of [
    { root_version: "version-2" },
    { performer_id: "conversation-2" },
    { terminal: true },
    { blocker_issue_ids: ["blocked-by-1"] },
    { tree_digest: "tree-2" },
    { tree_complete: false },
    { git_head: "def456" },
    { checks_digest: "checks-2" },
    { checks_passed: false },
    { latest_succeeded_cycle: { issue_id: "cycle-2", verify_result_id: "verify-execution-1", verified_revision: "abc123" } },
    { latest_succeeded_cycle: { issue_id: "cycle-1", verify_result_id: "verify-execution-2", verified_revision: "abc123" } },
    { latest_succeeded_cycle: { issue_id: "cycle-1", verify_result_id: "verify-execution-1", verified_revision: "def456" } },
    { owner_generation: "generation-2" },
  ] satisfies Partial<RootDeliveryFacts>[]) {
    const calls: string[][] = [];
    const delivery = new GitRootDeliveryImpl(
      async (_executable, args) => {
        calls.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      { async readFreshFacts() { return { ...baseFacts, ...patch }; } },
    );
    await assert.rejects(delivery.deliver(command()), /root_delivery_precondition_failed/);
    assert.deepEqual(calls, []);
  }
});

test("delivery reuses an existing deterministic PR and keeps results closed", async () => {
  const calls: string[][] = [];
  const delivery = new GitRootDeliveryImpl(
    async (_executable, args) => {
      calls.push(args);
      throw new Error("side effect must not run");
    },
    {
      async readFreshFacts() {
        return {
          ...baseFacts,
          existing_delivery: {
            kind: "pull_request" as const,
            url: "https://github.com/acme/repo/pull/1",
            branch: workspace.branch,
            head: "abc123",
          },
        };
      },
    },
  );
  assert.deepEqual(await delivery.deliver(command()), {
    kind: "pull_request",
    url: "https://github.com/acme/repo/pull/1",
  });
  assert.deepEqual(calls, []);
});

test("delivery rejects an invalid existing PR projection", async () => {
  const delivery = new GitRootDeliveryImpl(
    async () => assert.fail("side effect must not run"),
    {
      async readFreshFacts() {
        return {
          ...baseFacts,
          existing_delivery: {
            kind: "pull_request" as const,
            url: "not-a-url",
            branch: workspace.branch,
            head: "abc123",
          },
        };
      },
    },
  );
  await assert.rejects(delivery.deliver(command()), /root_delivery_precondition_failed/);
});

function command() {
  return {
    rootIssueId: "root-1",
    workspace,
    baseBranch: "main",
    title: "SYM-1 delivery",
    body: "Bounded delivery summary",
    expected,
  };
}
