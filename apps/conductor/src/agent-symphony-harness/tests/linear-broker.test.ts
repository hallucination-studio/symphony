import assert from "node:assert/strict";
import test from "node:test";

import type {
  LinearGatewayInterface,
  LinearRootScopeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import { ScopedAgentCommandBrokerImpl } from "../internal/ScopedAgentCommandBrokerImpl.js";

const envelope = {
  protocol_version: "1",
  request_id: "request-1",
  turn_id: "turn-1",
  root_issue_id: "root-1",
  performer_id: "conversation-1",
};

function gateway(overrides: Partial<LinearGatewayInterface> = {}) {
  let mutations = 0;
  const value: LinearGatewayInterface = {
    async readFreshRootScope() {
      return {
        root_issue_id: "root-1",
        conductor_id: "conductor-1",
        performer_id: "conversation-1",
        terminal: false,
        issues: [
          { issue_id: "root-1", updated_at: "version-1" },
          { issue_id: "child-1", updated_at: "version-2", parent_issue_id: "root-1" },
        ],
      };
    },
    async read() { return { summary: "bounded read" }; },
    async mutate() { mutations += 1; return { kind: "applied", summary: "applied" }; },
    ...overrides,
  };
  return { value, mutations: () => mutations };
}

test("Linear broker rejects stale Conversation and foreign targets before mutation", async () => {
  for (const command of [
    { ...envelope, performer_id: "old-conversation", command: "linear.status.set", args: writeArgs("child-1") },
    { ...envelope, command: "linear.status.set", args: writeArgs("foreign-1") },
    { ...envelope, command: "linear.read", args: { issue_id: "foreign-1", include: ["issue"] } },
  ]) {
    const fake = gateway();
    const broker = brokerFor(fake.value);
    const result = await broker.execute(command);
    assert.equal(result.status, "rejected");
    assert.equal(fake.mutations(), 0);
  }
});

test("Linear broker maps applied, conflict, and ambiguous read-back outcomes", async () => {
  for (const [outcome, status] of [
    [{ kind: "applied", summary: "updated" }, "applied"],
    [{ kind: "already_applied", summary: "matched by write ID" }, "already_applied"],
    [{ kind: "conflict", summary: "remote version changed" }, "conflict"],
    [{ kind: "unconfirmed", summary: "read-back unavailable", read_back_target: { kind: "issue", issue_id: "child-1" } }, "write_unconfirmed"],
  ] as const) {
    const fake = gateway({ async mutate() { return outcome; } });
    const result = await brokerFor(fake.value).execute({
      ...envelope,
      command: "linear.comment.create",
      args: {
        issue_id: "child-1",
        body: "Progress",
        write_id: "write-1",
        expected_remote_version: "version-2",
        expected_git_head: "abc123",
      },
    });
    assert.equal(result.status, status);
    if (status === "write_unconfirmed") assert.deepEqual(result.read_back_target, { kind: "issue", issue_id: "child-1" });
  }
});

test("linear.read reuses its single fresh Root scope snapshot", async () => {
  let scopeReads = 0;
  let freshScope: LinearRootScopeSnapshot | undefined;
  const fake = gateway({
    async readFreshRootScope() {
      scopeReads += 1;
      freshScope = {
        root_issue_id: "root-1", conductor_id: "conductor-1",
        performer_id: "conversation-1", terminal: false,
        issues: [{ issue_id: "root-1", updated_at: "version-1" }],
      };
      return freshScope;
    },
    async read(input) {
      assert.equal(input.scope, freshScope);
      return { summary: "bounded read" };
    },
  });

  const result = await brokerFor(fake.value).execute({
    ...envelope, command: "linear.read",
    args: { issue_id: "root-1", include: ["issue"] },
  });

  assert.equal(result.status, "read");
  assert.equal(scopeReads, 1);
});

test("create-child tolerates Conductor-owned Root version churn without weakening other mutations", async () => {
  const create = gateway({
    async readFreshRootScope() {
      return {
        root_issue_id: "root-1", conductor_id: "conductor-1",
        performer_id: "conversation-1", terminal: false,
        issues: [{ issue_id: "root-1", updated_at: "version-after-conductor-maintenance" }],
      };
    },
  });

  const createResult = await brokerFor(create.value).execute({
    ...envelope,
    command: "linear.issue.create_child",
    args: {
      parent_issue_id: "root-1",
      kind: "human",
      title: "Approve the plan",
      description: "Review the proposed implementation plan.",
      write_id: "plan-approval-1",
      expected_remote_version: "version-observed-by-performer",
      expected_git_head: "abc123",
    },
  });

  assert.equal(createResult.status, "applied");
  assert.equal(create.mutations(), 1);

  const staleHead = gateway({
    async readFreshRootScope() {
      return {
        root_issue_id: "root-1", conductor_id: "conductor-1",
        performer_id: "conversation-1", terminal: false,
        issues: [{ issue_id: "root-1", updated_at: "version-after-conductor-maintenance" }],
      };
    },
  });
  const staleHeadResult = await brokerFor(staleHead.value, "new-head").execute({
    ...envelope,
    command: "linear.issue.create_child",
    args: {
      parent_issue_id: "root-1", kind: "work", title: "Implement",
      description: "Implement the approved plan.", write_id: "work-1",
      expected_remote_version: "version-observed-by-performer",
      expected_git_head: "abc123",
    },
  });
  assert.equal(staleHeadResult.status, "conflict");
  assert.equal(staleHead.mutations(), 0);

  const update = gateway({
    async readFreshRootScope() {
      return {
        root_issue_id: "root-1", conductor_id: "conductor-1",
        performer_id: "conversation-1", terminal: false,
        issues: [
          { issue_id: "root-1", updated_at: "version-1" },
          { issue_id: "child-1", updated_at: "version-after-conductor-maintenance", parent_issue_id: "root-1" },
        ],
      };
    },
  });

  const updateResult = await brokerFor(update.value).execute({
    ...envelope,
    command: "linear.status.set",
    args: writeArgs("child-1"),
  });

  assert.equal(updateResult.status, "conflict");
  assert.equal(update.mutations(), 0);
});

function brokerFor(linear: LinearGatewayInterface, gitHead = "abc123") {
  return new ScopedAgentCommandBrokerImpl({
    conductorId: "conductor-1",
    turnId: "turn-1",
    rootIssueId: "root-1",
    performerId: "conversation-1",
    linear,
    async readGitHead() { return gitHead; },
  });
}

function writeArgs(issue_id: string) {
  return {
    issue_id,
    status: "In Progress",
    expected_remote_version: "version-2",
    expected_git_head: "abc123",
  };
}
