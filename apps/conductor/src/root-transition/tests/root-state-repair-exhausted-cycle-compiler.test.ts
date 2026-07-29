import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateRepairExhaustedCycleCompilerImpl } from "../internal/RootStateRepairExhaustedCycleCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";
const conclusion = [
  "# Recovery Conclusion", "", "The maximum Cycle repair attempt limit was exceeded.", "",
  "## Outcome", "", "recovery_exhausted",
].join("\n");

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "git_worktree" ? value.rootIssueId
      : value.kind === "linear_issue" ? value.issueId
        : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind: "symphony", observedAt } };
}

function recovered(options: { cycleStatus?: string; attemptStatuses?: readonly string[]; description?: string; labels?: readonly string[] } = {}): RecoveredRootState {
  const issue = (
    issueId: string,
    issueKind: "root" | "cycle" | "work" | "verify",
    statusName: string,
    parentIssueId: string | undefined,
    labels: readonly string[] = [`symphony:kind/${issueKind}`],
  ): CanonicalFact => fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId === undefined ? {} : { parentIssueId }),
    statusId: `status-${statusName.toLowerCase().replaceAll(" ", "-")}`, statusName,
    statusCategory: statusName === "Canceled" ? "canceled" : statusName === "Done" ? "completed" : "started",
    statusPosition: 1, order: issueKind === "cycle" ? 7 : 0,
    depth: parentIssueId ? (issueKind === "cycle" ? 1 : 2) : 0,
    title: issueKind === "cycle" ? "Cycle 1" : issueId,
    description: issueKind === "cycle" ? (options.description ?? "Current Cycle") : issueId,
    labels: issueKind === "cycle" ? (options.labels ?? labels) : labels,
    isArchived: false, issueKind, createdAt: observedAt, updatedAt: observedAt,
  });
  const attempts = options.attemptStatuses ?? ["Failed", "Interrupted", "Done"];
  return {
    rootIssueId: "root-1", contentDigest: "sha256:repair-limit",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "status-canceled", name: "Canceled", category: "canceled", position: 4 }),
      issue("root-1", "root", "In Progress", undefined),
      issue("cycle-1", "cycle", options.cycleStatus ?? "Executing", "root-1"),
      ...attempts.map((status, index) => issue(
        `attempt-${index + 1}`, index === 2 ? "verify" : "work", status, "cycle-1",
        index === 2 ? ["symphony:kind/verify", "Changes Required"] : undefined,
      )),
      fact({ kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo-1", branch: "root-1", headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [] }),
    ] },
  };
}

test("derives an exceeded repair budget and compiles one complete Issue desired state", () => {
  const result = new RootStateRepairExhaustedCycleCompilerImpl(new RootStateViewPolicyImpl()).compile({
    state: recovered(), cycleIssueId: "cycle-1", maxCycleRepairAttempts: 2, sessionFence: "closed",
  });

  assert.deepEqual(result, {
    kind: "effect",
    effect: {
      kind: "update_issue", issueId: "cycle-1", statusId: "status-canceled", title: "Cycle 1",
      description: conclusion, labelNames: ["Recovery Exhausted", "symphony:kind/cycle"], order: 7,
    },
  });
});

test("recognizes the exact durable conclusion and rejects a partial terminal state", () => {
  const compiler = new RootStateRepairExhaustedCycleCompilerImpl(new RootStateViewPolicyImpl());
  assert.deepEqual(compiler.compile({
    state: recovered({ cycleStatus: "Canceled", description: conclusion, labels: ["Recovery Exhausted", "symphony:kind/cycle"] }),
    cycleIssueId: "cycle-1", maxCycleRepairAttempts: 2, sessionFence: "closed",
  }), { kind: "satisfied" });

  assert.deepEqual(compiler.compile({
    state: recovered({ cycleStatus: "Canceled" }), cycleIssueId: "cycle-1", maxCycleRepairAttempts: 2, sessionFence: "closed",
  }), { kind: "invalid_facts", reason: "topology_invalid" });
});

test("rejects a non-exceeded budget, multiple active Cycles and invalid policy", () => {
  const compiler = new RootStateRepairExhaustedCycleCompilerImpl(new RootStateViewPolicyImpl());
  assert.deepEqual(compiler.compile({
    state: recovered({ attemptStatuses: ["Failed", "Interrupted"] }), cycleIssueId: "cycle-1", maxCycleRepairAttempts: 2, sessionFence: "closed",
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });
  assert.deepEqual(compiler.compile({
    state: recovered(), cycleIssueId: "cycle-1", maxCycleRepairAttempts: -1, sessionFence: "closed",
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });

  const multiple = recovered();
  const cycle = multiple.observation.facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === "cycle-1");
  assert.ok(cycle?.value.kind === "linear_issue");
  multiple.observation.facts = [...multiple.observation.facts, fact({ ...cycle.value, issueId: "cycle-2", identifier: "cycle-2" })];
  assert.deepEqual(compiler.compile({ state: multiple, cycleIssueId: "cycle-1", maxCycleRepairAttempts: 2, sessionFence: "closed" }), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});

test("waits for the active Cycle Stage session fence before terminalizing", () => {
  assert.deepEqual(new RootStateRepairExhaustedCycleCompilerImpl(new RootStateViewPolicyImpl()).compile({
    state: recovered(), cycleIssueId: "cycle-1", maxCycleRepairAttempts: 2, sessionFence: "active",
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });
});
