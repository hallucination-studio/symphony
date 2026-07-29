import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateStageInterruptionCompilerImpl } from "../internal/RootStateStageInterruptionCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "git_worktree" ? value.rootIssueId
      : value.kind === "linear_issue" ? value.issueId
        : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind: "symphony", observedAt } };
}

function recovered(role: "plan" | "work" | "verify" = "plan", stageStatus = "In Progress"): RecoveredRootState {
  const issue = (
    issueId: string,
    issueKind: "root" | "cycle" | "plan" | "work" | "verify",
    statusName: string,
    parentIssueId?: string,
  ): CanonicalFact => fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId === undefined ? {} : { parentIssueId }),
    statusId: `status-${statusName.toLowerCase().replaceAll(" ", "-")}`, statusName,
    statusCategory: statusName === "Interrupted" ? "canceled" : "started", statusPosition: 1,
    order: 0, depth: parentIssueId ? (issueKind === "cycle" ? 1 : 2) : 0,
    title: issueId, description: issueId, labels: [`symphony:kind/${issueKind}`], isArchived: false,
    issueKind, createdAt: observedAt, updatedAt: observedAt,
  });
  return {
    rootIssueId: "root-1", contentDigest: "sha256:stage",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "status-interrupted", name: "Interrupted", category: "canceled", position: 2 }),
      issue("root-1", "root", "In Progress"),
      issue("cycle-1", "cycle", role === "plan" ? "Planning" : role === "work" ? "Executing" : "Verifying", "root-1"),
      issue("stage-1", role, stageStatus, "cycle-1"),
      fact({ kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo-1", branch: "root-1", headRevision: "abc", baseRevision: "base", isClean: false, changedPaths: ["src/a.ts"] }),
    ] },
  };
}

test("compiles each fenced active Stage to one desired Interrupted status effect", () => {
  const compiler = new RootStateStageInterruptionCompilerImpl(new RootStateViewPolicyImpl());

  for (const role of ["plan", "work", "verify"] as const) {
    assert.deepEqual(compiler.compile({
      state: recovered(role), role, cycleIssueId: "cycle-1", stageIssueId: "stage-1", sessionFence: "closed",
    }), {
      kind: "effect",
      effect: { kind: "set_issue_status", issueId: "stage-1", statusId: "status-interrupted" },
    }, role);
  }
});

test("waits for a closed session fence and recognizes the durable satisfied state", () => {
  const compiler = new RootStateStageInterruptionCompilerImpl(new RootStateViewPolicyImpl());

  assert.deepEqual(compiler.compile({
    state: recovered(), role: "plan", cycleIssueId: "cycle-1", stageIssueId: "stage-1", sessionFence: "active",
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });
  assert.deepEqual(compiler.compile({
    state: recovered("plan", "Interrupted"), role: "plan", cycleIssueId: "cycle-1", stageIssueId: "stage-1", sessionFence: "closed",
  }), { kind: "satisfied" });
});

test("fails closed for a mismatched role, parent or ambiguous status", () => {
  const compiler = new RootStateStageInterruptionCompilerImpl(new RootStateViewPolicyImpl());
  assert.deepEqual(compiler.compile({
    state: recovered("work"), role: "plan", cycleIssueId: "cycle-1", stageIssueId: "stage-1", sessionFence: "closed",
  }), { kind: "invalid_facts", reason: "topology_invalid" });

  const ambiguous = recovered();
  ambiguous.observation.facts = [
    ...ambiguous.observation.facts,
    fact({ kind: "linear_status", statusId: "status-interrupted-2", name: "Interrupted", category: "canceled", position: 3 }),
  ];
  assert.deepEqual(compiler.compile({
    state: ambiguous, role: "plan", cycleIssueId: "cycle-1", stageIssueId: "stage-1", sessionFence: "closed",
  }), { kind: "invalid_facts", reason: "status_catalog_invalid" });
});
