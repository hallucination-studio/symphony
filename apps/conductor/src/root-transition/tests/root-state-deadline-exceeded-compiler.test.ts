import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateDeadlineExceededCompilerImpl } from "../internal/RootStateDeadlineExceededCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T13:00:00.000Z";
const deadlineAt = "2026-07-29T12:00:00.000Z";
const cycleConclusion = [
  "# Recovery Conclusion", "", "The Root execution deadline was exceeded before this Cycle completed.", "",
  "## Outcome", "", "recovery_abandoned",
].join("\n");

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "git_worktree" ? value.rootIssueId
      : value.kind === "linear_issue" ? value.issueId
        : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind: "symphony", observedAt } };
}

function recovered(withActiveCycle: boolean): RecoveredRootState {
  const issue = (
    issueId: string,
    issueKind: "root" | "cycle",
    statusName: string,
    parentIssueId?: string,
  ): CanonicalFact => fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId === undefined ? {} : { parentIssueId }),
    statusId: `status-${statusName.toLowerCase().replaceAll(" ", "-")}`, statusName,
    statusCategory: "started", statusPosition: 1, order: issueKind === "root" ? 2 : 5,
    depth: parentIssueId ? 1 : 0, title: issueKind === "root" ? "Root outcome" : "Cycle 1",
    description: issueKind === "root" ? "Keep this requirement unchanged." : "Current Cycle",
    labels: [`symphony:kind/${issueKind}`], isArchived: false, issueKind,
    createdAt: "2026-07-28T00:00:00.000Z", updatedAt: observedAt,
  });
  return {
    rootIssueId: "root-1", contentDigest: withActiveCycle ? "sha256:active" : "sha256:no-active",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "status-canceled", name: "Canceled", category: "canceled", position: 4 }),
      issue("root-1", "root", "In Progress"),
      ...(withActiveCycle ? [issue("cycle-1", "cycle", "Executing", "root-1")] : []),
      fact({ kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo-1", branch: "root-1", headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [] }),
    ] },
  };
}

test("concludes the unique active Cycle before the Root", () => {
  const result = new RootStateDeadlineExceededCompilerImpl(new RootStateViewPolicyImpl()).compile({
    state: recovered(true), target: { kind: "cycle", cycleIssueId: "cycle-1", sessionFence: "closed" }, deadlineAt, observedAt,
  });

  assert.deepEqual(result, {
    kind: "effect",
    effect: {
      kind: "update_issue", issueId: "cycle-1", statusId: "status-canceled", title: "Cycle 1",
      description: cycleConclusion, labelNames: ["Recovery Abandoned", "symphony:kind/cycle"], order: 5,
    },
  });
});

test("concludes the Root only after no active Cycle remains", () => {
  const compiler = new RootStateDeadlineExceededCompilerImpl(new RootStateViewPolicyImpl());
  assert.deepEqual(compiler.compile({
    state: recovered(false), target: { kind: "root" }, deadlineAt, observedAt,
  }), {
    kind: "effect",
    effect: {
      kind: "update_issue", issueId: "root-1", statusId: "status-canceled", title: "Root outcome",
      description: "Keep this requirement unchanged.",
      labelNames: ["Deadline Exceeded", "symphony:kind/root"], order: 2,
    },
  });
  assert.deepEqual(compiler.compile({
    state: recovered(true), target: { kind: "root" }, deadlineAt, observedAt,
  }), { kind: "invalid_facts", reason: "topology_invalid" });
});

test("rejects a stale clock, invalid timestamp and wrong Cycle identity", () => {
  const compiler = new RootStateDeadlineExceededCompilerImpl(new RootStateViewPolicyImpl());
  assert.deepEqual(compiler.compile({
    state: recovered(false), target: { kind: "root" }, deadlineAt, observedAt: "2026-07-29T11:59:59.999Z",
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });
  assert.deepEqual(compiler.compile({
    state: recovered(false), target: { kind: "root" }, deadlineAt: "invalid", observedAt,
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });
  assert.deepEqual(compiler.compile({
    state: recovered(true), target: { kind: "cycle", cycleIssueId: "cycle-other", sessionFence: "closed" }, deadlineAt, observedAt,
  }), { kind: "invalid_facts", reason: "topology_invalid" });
});

test("is restart-equivalent for byte-identical current facts and mechanical time", () => {
  const compiler = new RootStateDeadlineExceededCompilerImpl(new RootStateViewPolicyImpl());
  const state = recovered(true);
  const restarted = structuredClone(state);
  restarted.observation.facts = [...restarted.observation.facts].reverse();
  const input = { target: { kind: "cycle" as const, cycleIssueId: "cycle-1", sessionFence: "closed" as const }, deadlineAt, observedAt };

  assert.deepEqual(compiler.compile({ state, ...input }), compiler.compile({ state: restarted, ...input }));
});

test("waits for the active Cycle Stage session fence before deadline closure", () => {
  assert.deepEqual(new RootStateDeadlineExceededCompilerImpl(new RootStateViewPolicyImpl()).compile({
    state: recovered(true), target: { kind: "cycle", cycleIssueId: "cycle-1", sessionFence: "uncertain" }, deadlineAt, observedAt,
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });
});
