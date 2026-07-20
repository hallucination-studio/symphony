import assert from "node:assert/strict";
import test from "node:test";

import { ScopedAgentCommandBrokerImpl } from "../internal/ScopedAgentCommandBrokerImpl.js";
import { TurnCommandBudget } from "../internal/TurnCommandBudget.js";
import type { RootDeliveryCommand } from "../../root-delivery/api/RootDeliveryInterface.js";

const correlation = { protocol_version: "1", request_id: "request-1", turn_id: "turn-1", root_issue_id: "root-1", performer_id: "conversation-1" };
const workspace = { branch: "symphony/runs/sym-1", worktreePath: "/worktree", rootIssueId: "root-1" };

test("Git broker revalidates scope and HEAD before commit", async () => {
  let commits = 0;
  let head = "abc123";
  const broker = createBroker({
    readGitHead: async () => head,
    git: {
      async inspect() { return { head, branch: workspace.branch, status: { items: [], returned: 0, cap: 512, has_more: false, partial: false } }; },
      async diff() { return { text: "", bytes: 0, cap: 65536, partial: false }; },
      async checks() { return { items: [], returned: 0, cap: 32, has_more: false, partial: false }; },
      async commit() { commits += 1; return { kind: "committed" as const, commit: "def456" }; },
    },
  });
  const command = { ...correlation, command: "git.commit", args: { issue_id: "child-1", expected_remote_version: "version-2", expected_head: "abc123" } };
  assert.equal((await broker.execute(command)).status, "applied");
  head = "changed";
  assert.equal((await broker.execute({ ...command, request_id: "request-2" })).status, "conflict");
  assert.equal(commits, 1);
});

test("delivery broker delegates only after fresh scoped validation", async () => {
  let deliveries = 0;
  const broker = createBroker({
    delivery: {
      async deliver(command: RootDeliveryCommand) {
        deliveries += 1;
        assert.equal(command.expected.git_head, "abc123");
        return { kind: "remote_branch" as const, branch: workspace.branch };
      },
    },
  });
  const result = await broker.execute({
    ...correlation,
    command: "root.deliver",
    args: { expected_head: "abc123", expected_root_version: "version-1" },
  });
  assert.equal(result.status, "applied");
  assert.equal(deliveries, 1);
});

test("commit and delivery each perform exactly one fresh Root scope read", async () => {
  for (const command of [
    { ...correlation, command: "git.commit", args: {
      issue_id: "child-1", expected_remote_version: "version-2", expected_head: "abc123",
    } },
    { ...correlation, command: "root.deliver", args: {
      expected_head: "abc123", expected_root_version: "version-1",
    } },
  ]) {
    let scopeReads = 0;
    const broker = createBroker({
      linear: {
        async readFreshRootScope() {
          scopeReads += 1;
          return { root_issue_id: "root-1", conductor_id: "conductor-1",
            performer_id: "conversation-1", terminal: false,
            issues: [{ issue_id: "root-1", updated_at: "version-1" },
              { issue_id: "child-1", identifier: "SYM-2", parent_issue_id: "root-1",
                updated_at: "version-2" }] };
        },
        async read() { return {}; },
        async mutate() { return { kind: "applied" as const, summary: "ok" }; },
      },
      git: {
        async inspect() { throw new Error("unused"); }, async diff() { throw new Error("unused"); },
        async checks() { throw new Error("unused"); },
        async commit() { return { kind: "committed" as const, commit: "def456" }; },
      },
      delivery: { async deliver() { return { kind: "remote_branch" as const,
        branch: workspace.branch }; } },
    });

    assert.equal((await broker.execute(command)).status, "applied");
    assert.equal(scopeReads, 1);
  }
});

test("command limit rejects new broker and mutation requests", async () => {
  const budget = new TurnCommandBudget({ maxBrokerCalls: 2, maxMutations: 0 });
  const broker = createBroker({ budget });
  const commit = { ...correlation, command: "git.commit", args: { issue_id: "child-1", expected_remote_version: "version-2", expected_head: "abc123" } };
  assert.equal((await broker.execute(commit)).status, "rejected");
  assert.equal((await broker.execute({ ...commit, request_id: "request-2" })).status, "rejected");
  assert.equal((await broker.execute({ ...commit, request_id: "request-3" })).status, "rejected");
  assert.deepEqual(budget.usage(), { broker_calls: 2, mutations: 0 });
});

function createBroker(overrides: Record<string, unknown> = {}) {
  return new ScopedAgentCommandBrokerImpl({
    conductorId: "conductor-1", turnId: "turn-1", rootIssueId: "root-1", performerId: "conversation-1",
    linear: {
      async readFreshRootScope() { return { root_issue_id: "root-1", conductor_id: "conductor-1", performer_id: "conversation-1", terminal: false, issues: [{ issue_id: "root-1", updated_at: "version-1" }, { issue_id: "child-1", parent_issue_id: "root-1", updated_at: "version-2" }] }; },
      async read() { return {}; }, async mutate() { return { kind: "applied" as const, summary: "ok" }; },
    },
    readGitHead: async () => "abc123",
    workspace,
    git: { async inspect() { throw new Error("unused"); }, async diff() { throw new Error("unused"); }, async checks() { throw new Error("unused"); }, async commit() { throw new Error("unused"); } },
    delivery: { async deliver() { throw new Error("unused"); } },
    deliveryContext: { baseBranch: "main", title: "SYM-1", body: "Delivery", treeDigest: "tree-1", checksDigest: "checks-1" },
    budget: new TurnCommandBudget({ maxBrokerCalls: 10, maxMutations: 10 }),
    ...overrides,
  } as ConstructorParameters<typeof ScopedAgentCommandBrokerImpl>[0]);
}
