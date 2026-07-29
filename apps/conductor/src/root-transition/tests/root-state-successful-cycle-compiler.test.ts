import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateSuccessfulCycleCompilerImpl } from "../internal/RootStateSuccessfulCycleCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "git_worktree" ? value.rootIssueId
      : value.kind === "linear_issue" ? value.issueId
        : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind: "symphony", observedAt } };
}

function recovered(cycleStatus = "Verifying", findingStatus = "Done", verifyLabels = ["symphony:kind/verify", "Passed"]): RecoveredRootState {
  const issue = (
    issueId: string,
    issueKind: "root" | "cycle" | "work" | "verify" | "finding",
    statusName: string,
    parentIssueId: string | undefined,
    labels = [`symphony:kind/${issueKind}`],
  ): CanonicalFact => fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId === undefined ? {} : { parentIssueId }),
    statusId: `status-${statusName.toLowerCase()}`, statusName,
    statusCategory: statusName === "Done" || statusName === "Succeeded" ? "completed" : "started", statusPosition: 1,
    order: 0, depth: parentIssueId ? (issueKind === "cycle" ? 1 : 2) : 0,
    title: issueId, description: issueId, labels, isArchived: false, issueKind,
    createdAt: observedAt, updatedAt: observedAt,
  });
  return {
    rootIssueId: "root-1", contentDigest: "sha256:success",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "status-succeeded", name: "Succeeded", category: "completed", position: 3 }),
      issue("root-1", "root", "In Progress", undefined),
      issue("cycle-1", "cycle", cycleStatus, "root-1"),
      issue("work-1", "work", "Done", "cycle-1"),
      issue("verify-1", "verify", "Done", "cycle-1", verifyLabels),
      issue("finding-1", "finding", findingStatus, "cycle-1"),
      fact({ kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo-1", branch: "root-1", headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [] }),
    ] },
  };
}

test("concludes one fully verified Cycle with a pure Succeeded status effect", () => {
  const result = new RootStateSuccessfulCycleCompilerImpl(new RootStateViewPolicyImpl()).compile({
    state: recovered(), cycleIssueId: "cycle-1", verifyIssueId: "verify-1",
  });

  assert.deepEqual(result, {
    kind: "effect",
    effect: { kind: "set_issue_status", issueId: "cycle-1", statusId: "status-succeeded" },
  });
});

test("recognizes the durable successful Cycle after restart", () => {
  const compiler = new RootStateSuccessfulCycleCompilerImpl(new RootStateViewPolicyImpl());
  const first = recovered("Succeeded");
  const restarted = structuredClone(first);
  restarted.observation.facts = [...restarted.observation.facts].reverse();

  assert.deepEqual(compiler.compile({ state: first, cycleIssueId: "cycle-1", verifyIssueId: "verify-1" }), { kind: "satisfied" });
  assert.deepEqual(
    compiler.compile({ state: first, cycleIssueId: "cycle-1", verifyIssueId: "verify-1" }),
    compiler.compile({ state: restarted, cycleIssueId: "cycle-1", verifyIssueId: "verify-1" }),
  );
});

test("rejects unresolved Findings and a Verify without the Passed conclusion", () => {
  const compiler = new RootStateSuccessfulCycleCompilerImpl(new RootStateViewPolicyImpl());

  assert.deepEqual(compiler.compile({ state: recovered("Verifying", "Todo"), cycleIssueId: "cycle-1", verifyIssueId: "verify-1" }), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
  assert.deepEqual(compiler.compile({
    state: recovered("Verifying", "Done", ["symphony:kind/verify"]), cycleIssueId: "cycle-1", verifyIssueId: "verify-1",
  }), { kind: "invalid_facts", reason: "topology_invalid" });
});
