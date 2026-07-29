import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { CanonicalObservationBatch } from "../../linear-runtime/api/CanonicalObservationDiffPolicyInterface.js";
import type { NativeEffectObservationOutcome } from "../../linear-runtime/api/LinearRootRuntimeInterface.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { NativeLinearEffectBoundaryInterface } from "../api/RootStateEffectMaterializerInterface.js";
import { RootStateEffectMaterializerImpl } from "../internal/RootStateEffectMaterializerImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "git_worktree" ? value.rootIssueId
      : value.kind === "linear_issue" ? value.issueId
        : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind: "symphony", observedAt } };
}

function state(cycleStatus = "Sealed"): RecoveredRootState {
  const issue = (issueId: string, issueKind: "root" | "cycle", statusName: string, parentIssueId?: string): CanonicalFact => fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId === undefined ? {} : { parentIssueId }),
    statusId: `status-${statusName.toLowerCase()}`, statusName, statusCategory: "started", statusPosition: 1,
    order: 0, depth: parentIssueId ? 1 : 0, title: issueId, description: issueId,
    labels: [`symphony:kind/${issueKind}`], isArchived: false, issueKind,
    createdAt: observedAt, updatedAt: observedAt,
  });
  return {
    rootIssueId: "root-1",
    contentDigest: "sha256:base",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "status-executing", name: "Executing", category: "started", position: 1 }),
      issue("root-1", "root", "Executing"),
      issue("cycle-1", "cycle", cycleStatus, "root-1"),
      fact({ kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo-1", branch: "root-1", headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [] }),
    ] },
  };
}

function commentState(options: { receipt?: "check" | "cross"; threadState?: "resolved" | "unresolved" } = {}): RecoveredRootState {
  const current = state();
  current.observation.facts = [...current.observation.facts, fact({
    kind: "linear_comment", commentId: "request-1", issueId: "root-1", body: "Request",
    authorKind: "symphony", authorId: "symphony", threadRootCommentId: "request-1",
    threadState: options.threadState ?? "unresolved", reactions: [], createdAt: observedAt, updatedAt: observedAt,
  }), fact({
    kind: "linear_comment", commentId: "reply-1", issueId: "root-1", body: "Approved",
    authorKind: "human", authorId: "human-1", authorUserId: "human-1", parentCommentId: "request-1",
    threadRootCommentId: "request-1", threadState: options.threadState ?? "unresolved",
    reactions: options.receipt ? [{
      reactionId: "receipt-1", emoji: options.receipt === "check" ? "\u2705" : "\u274c",
      actorKind: "symphony", actorId: "symphony",
    }] : [],
    createdAt: observedAt, updatedAt: observedAt,
  })];
  return current;
}

class Boundary implements NativeLinearEffectBoundaryInterface {
  readonly calls: Parameters<NativeLinearEffectBoundaryInterface["apply"]>[0][] = [];
  constructor(private readonly outcome: NativeEffectObservationOutcome) {}

  async apply(input: Parameters<NativeLinearEffectBoundaryInterface["apply"]>[0]): Promise<NativeEffectObservationOutcome> {
    this.calls.push(input);
    return this.outcome;
  }
}

const effect = { kind: "set_issue_status" as const, issueId: "cycle-1", statusId: "status-executing" };

test("delegates one desired-state effect without exposing state or mutation preconditions", async () => {
  const readBack = { baseDigest: "sha256:base", targetDigest: "sha256:next", changes: [] } as CanonicalObservationBatch;
  const outcome: NativeEffectObservationOutcome = {
    kind: "applied", targetIdentity: { sourceKind: "linear_issue", sourceId: "cycle-1" }, readBack,
  };
  const boundary = new Boundary(outcome);
  const result = await new RootStateEffectMaterializerImpl(boundary).materialize({ state: state(), effect });

  assert.strictEqual(result, outcome);
  assert.deepEqual(boundary.calls, [{ rootIssueId: "root-1", projectId: "project-1", effect }]);
  assert.equal("state" in boundary.calls[0]!, false);
});

test("does not write an already-satisfied effect", async () => {
  const boundary = new Boundary({ kind: "acceptance_unknown" });
  const result = await new RootStateEffectMaterializerImpl(boundary).materialize({ state: state("Executing"), effect });

  assert.deepEqual(result, { kind: "not_applied" });
  assert.equal(boundary.calls.length, 0);
});

test("fails closed before the boundary for a foreign target or status", async () => {
  const boundary = new Boundary({ kind: "applied", targetIdentity: { sourceKind: "linear_issue", sourceId: "cycle-1" }, readBack: {} as CanonicalObservationBatch });
  const materializer = new RootStateEffectMaterializerImpl(boundary);

  assert.deepEqual(await materializer.materialize({ state: state(), effect: { ...effect, issueId: "foreign" } }), { kind: "precondition_failed" });
  assert.deepEqual(await materializer.materialize({ state: state(), effect: { ...effect, statusId: "foreign-status" } }), { kind: "precondition_failed" });
  assert.equal(boundary.calls.length, 0);
});

for (const outcome of [
  { kind: "acceptance_unknown" },
  { kind: "precondition_failed" },
  { kind: "readback_mismatch" },
] as const) {
  test(`preserves the closed ${outcome.kind} boundary outcome`, async () => {
    const result = await new RootStateEffectMaterializerImpl(new Boundary(outcome)).materialize({ state: state(), effect });
    assert.deepEqual(result, outcome);
  });
}

test("rejects an applied read-back for a different native target", async () => {
  const boundary = new Boundary({
    kind: "applied",
    targetIdentity: { sourceKind: "linear_issue", sourceId: "other-issue" },
    readBack: { baseDigest: "sha256:base", targetDigest: "sha256:next", changes: [] },
  });

  assert.deepEqual(
    await new RootStateEffectMaterializerImpl(boundary).materialize({ state: state(), effect }),
    { kind: "readback_mismatch" },
  );
});

test("materializes a complete Issue desired state and suppresses it only when every field matches", async () => {
  const update = {
    kind: "update_issue" as const,
    issueId: "cycle-1",
    statusId: "status-executing",
    title: "Cycle 1",
    description: "Recovery conclusion",
    labelNames: ["Recovery Exhausted", "symphony:kind/cycle"],
    order: 7,
  };
  const boundary = new Boundary({ kind: "not_applied" });
  assert.deepEqual(await new RootStateEffectMaterializerImpl(boundary).materialize({ state: state(), effect: update }), {
    kind: "not_applied",
  });
  assert.deepEqual(boundary.calls, [{ rootIssueId: "root-1", projectId: "project-1", effect: update }]);

  const satisfied = state("Executing");
  const cycle = satisfied.observation.facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === "cycle-1");
  assert.ok(cycle?.value.kind === "linear_issue");
  Object.assign(cycle.value, {
    title: update.title, description: update.description, labels: update.labelNames, order: update.order,
  });
  const noWrite = new Boundary({ kind: "acceptance_unknown" });
  assert.deepEqual(await new RootStateEffectMaterializerImpl(noWrite).materialize({ state: satisfied, effect: update }), {
    kind: "not_applied",
  });
  assert.equal(noWrite.calls.length, 0);
});

test("rejects malformed complete Issue effects before mutation", async () => {
  const boundary = new Boundary({ kind: "acceptance_unknown" });
  const result = await new RootStateEffectMaterializerImpl(boundary).materialize({
    state: state(),
    effect: {
      kind: "update_issue", issueId: "cycle-1", statusId: "status-executing", title: "Cycle",
      description: "Conclusion", labelNames: ["duplicate", "duplicate"], order: 0,
    },
  });
  assert.deepEqual(result, { kind: "precondition_failed" });
  assert.equal(boundary.calls.length, 0);

  assert.deepEqual(await new RootStateEffectMaterializerImpl(boundary).materialize({
    state: state(),
    effect: {
      kind: "update_issue", issueId: "cycle-1", statusId: "status-executing", title: "Cycle",
      description: "Conclusion", labelNames: ["symphony:kind/cycle", "Recovery Exhausted"], order: 0,
    },
  }), { kind: "precondition_failed" });
  assert.equal(boundary.calls.length, 0);
});

test("materializes desired Issue archive state and suppresses exact current state", async () => {
  const archive = { kind: "set_issue_archive_state" as const, issueId: "cycle-1", isArchived: true };
  const boundary = new Boundary({ kind: "not_applied" });
  assert.deepEqual(await new RootStateEffectMaterializerImpl(boundary).materialize({ state: state(), effect: archive }), {
    kind: "not_applied",
  });
  assert.deepEqual(boundary.calls, [{ rootIssueId: "root-1", projectId: "project-1", effect: archive }]);

  const archived = state();
  const cycle = archived.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "cycle-1");
  assert.ok(cycle?.value.kind === "linear_issue");
  cycle.value.isArchived = true;
  const noWrite = new Boundary({ kind: "acceptance_unknown" });
  assert.deepEqual(await new RootStateEffectMaterializerImpl(noWrite).materialize({ state: archived, effect: archive }), {
    kind: "not_applied",
  });
  assert.equal(noWrite.calls.length, 0);

  const restore = { ...archive, isArchived: false };
  const restoreBoundary = new Boundary({ kind: "not_applied" });
  assert.deepEqual(await new RootStateEffectMaterializerImpl(restoreBoundary).materialize({
    state: archived, effect: restore,
  }), { kind: "not_applied" });
  assert.deepEqual(restoreBoundary.calls, [{ rootIssueId: "root-1", projectId: "project-1", effect: restore }]);

  assert.deepEqual(await new RootStateEffectMaterializerImpl(noWrite).materialize({
    state: state(), effect: { ...archive, issueId: "foreign" },
  }), { kind: "precondition_failed" });
  assert.equal(noWrite.calls.length, 0);
});

test("materializes identity-free child Issue creation with exact current-state suppression", async () => {
  const current = state();
  current.observation.facts = [...current.observation.facts, fact({
    kind: "linear_status", statusId: "status-todo", name: "Todo", category: "unstarted", position: 2,
  })];
  const create = {
    kind: "create_issue" as const, parentIssueId: "cycle-1", statusId: "status-todo",
    title: "Plan", description: "Plan shell", labelNames: ["symphony:kind/plan"],
  };
  const outcome: NativeEffectObservationOutcome = {
    kind: "applied", targetIdentity: { sourceKind: "linear_issue", sourceId: "plan-new" },
    readBack: { baseDigest: "sha256:base", targetDigest: "sha256:next", changes: [] },
  };
  const boundary = new Boundary(outcome);
  assert.strictEqual(await new RootStateEffectMaterializerImpl(boundary).materialize({ state: current, effect: create }), outcome);
  assert.deepEqual(boundary.calls, [{ rootIssueId: "root-1", projectId: "project-1", effect: create }]);

  const exact = fact({
    kind: "linear_issue", issueId: "plan-1", identifier: "PLAN-1", projectId: "project-1",
    parentIssueId: "cycle-1", statusId: "status-todo", statusName: "Todo", statusCategory: "unstarted",
    statusPosition: 2, order: 0, depth: 2, title: "Plan", description: "Plan shell",
    labels: ["symphony:kind/plan"], isArchived: false, issueKind: "plan",
    createdAt: observedAt, updatedAt: observedAt,
  });
  current.observation.facts = [...current.observation.facts, exact];
  const noWrite = new Boundary({ kind: "acceptance_unknown" });
  assert.deepEqual(await new RootStateEffectMaterializerImpl(noWrite).materialize({ state: current, effect: create }), {
    kind: "not_applied",
  });
  assert.equal(noWrite.calls.length, 0);

  current.observation.facts = [...current.observation.facts, fact({
    ...(exact.value as Extract<CanonicalFactValue, { kind: "linear_issue" }>), issueId: "plan-2", identifier: "PLAN-2",
  })];
  assert.deepEqual(await new RootStateEffectMaterializerImpl(noWrite).materialize({ state: current, effect: create }), {
    kind: "precondition_failed",
  });

  const invalidReadBack = new Boundary({
    kind: "applied", targetIdentity: { sourceKind: "linear_issue", sourceId: "cycle-1" },
    readBack: { baseDigest: "sha256:base", targetDigest: "sha256:next", changes: [] },
  });
  const fresh = state();
  fresh.observation.facts = [...fresh.observation.facts, fact({
    kind: "linear_status", statusId: "status-todo", name: "Todo", category: "unstarted", position: 2,
  })];
  assert.deepEqual(await new RootStateEffectMaterializerImpl(invalidReadBack).materialize({ state: fresh, effect: create }), {
    kind: "readback_mismatch",
  });
});

test("rejects malformed child creation and a parent outside the active Root project", async () => {
  const current = state();
  current.observation.facts = [...current.observation.facts, fact({
    kind: "linear_status", statusId: "status-todo", name: "Todo", category: "unstarted", position: 2,
  })];
  const create = {
    kind: "create_issue" as const, parentIssueId: "cycle-1", statusId: "status-todo",
    title: "Plan", description: "Plan shell", labelNames: ["symphony:kind/plan", "Plan"],
  };
  const boundary = new Boundary({ kind: "acceptance_unknown" });

  assert.deepEqual(await new RootStateEffectMaterializerImpl(boundary).materialize({
    state: current, effect: create,
  }), { kind: "precondition_failed" });

  const parent = current.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "cycle-1");
  assert.ok(parent?.value.kind === "linear_issue");
  parent.value.projectId = "project-2";
  assert.deepEqual(await new RootStateEffectMaterializerImpl(boundary).materialize({
    state: current, effect: { ...create, labelNames: ["Plan", "symphony:kind/plan"] },
  }), { kind: "precondition_failed" });

  parent.value.projectId = "project-1";
  parent.value.isArchived = true;
  assert.deepEqual(await new RootStateEffectMaterializerImpl(boundary).materialize({
    state: current, effect: { ...create, labelNames: ["Plan", "symphony:kind/plan"] },
  }), { kind: "precondition_failed" });
  assert.equal(boundary.calls.length, 0);
});

test("rejects a child creation read-back with a comment identity", async () => {
  const current = state();
  current.observation.facts = [...current.observation.facts, fact({
    kind: "linear_status", statusId: "status-todo", name: "Todo", category: "unstarted", position: 2,
  })];
  const boundary = new Boundary({
    kind: "applied", targetIdentity: { sourceKind: "linear_comment", sourceId: "comment-new" },
    readBack: { baseDigest: "sha256:base", targetDigest: "sha256:next", changes: [] },
  });

  assert.deepEqual(await new RootStateEffectMaterializerImpl(boundary).materialize({
    state: current,
    effect: {
      kind: "create_issue", parentIssueId: "cycle-1", statusId: "status-todo",
      title: "Plan", description: "Plan shell", labelNames: ["symphony:kind/plan"],
    },
  }), { kind: "readback_mismatch" });
});

test("materializes a comment receipt and suppresses an already present exact receipt", async () => {
  const effect = { kind: "set_comment_receipt" as const, commentId: "reply-1", threadRootCommentId: "request-1", receipt: "check" as const };
  const boundary = new Boundary({ kind: "not_applied" });
  assert.deepEqual(await new RootStateEffectMaterializerImpl(boundary).materialize({ state: commentState(), effect }), {
    kind: "not_applied",
  });
  assert.equal(boundary.calls.length, 1);

  const noWrite = new Boundary({ kind: "acceptance_unknown" });
  assert.deepEqual(await new RootStateEffectMaterializerImpl(noWrite).materialize({ state: commentState({ receipt: "check" }), effect }), {
    kind: "not_applied",
  });
  assert.equal(noWrite.calls.length, 0);
});

test("rejects a conflicting receipt and materializes thread resolution", async () => {
  const receipt = { kind: "set_comment_receipt" as const, commentId: "reply-1", threadRootCommentId: "request-1", receipt: "check" as const };
  const boundary = new Boundary({ kind: "not_applied" });
  assert.deepEqual(await new RootStateEffectMaterializerImpl(boundary).materialize({ state: commentState({ receipt: "cross" }), effect: receipt }), {
    kind: "precondition_failed",
  });
  assert.equal(boundary.calls.length, 0);

  const resolve = { kind: "set_comment_thread_state" as const, commentId: "reply-1", threadRootCommentId: "request-1", threadState: "resolved" as const };
  assert.deepEqual(await new RootStateEffectMaterializerImpl(boundary).materialize({ state: commentState(), effect: resolve }), {
    kind: "not_applied",
  });
  assert.equal(boundary.calls.length, 1);
  assert.deepEqual(await new RootStateEffectMaterializerImpl(new Boundary({ kind: "acceptance_unknown" })).materialize({
    state: commentState({ threadState: "resolved" }), effect: resolve,
  }), { kind: "not_applied" });
});
