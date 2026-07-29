import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateInvalidExecutionGenerationCompilerImpl } from "../internal/RootStateInvalidExecutionGenerationCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_issue" ? value.issueId
    : value.kind === "git_worktree" ? value.rootIssueId
      : value.kind === "linear_status" ? value.statusId
        : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind: "symphony", observedAt } };
}

function issue(
  issueId: string, issueKind: "root" | "cycle" | "plan" | "work", parentIssueId: string | undefined,
  statusName: string, depth: number, labels: readonly string[] = [`symphony:kind/${issueKind}`],
): CanonicalFact {
  return fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId ? { parentIssueId } : {}), statusId: statusName.toLowerCase(), statusName,
    statusCategory: statusName === "Canceled" ? "canceled" : "started", statusPosition: 1,
    order: 0, depth, title: issueKind, description: issueKind, labels, isArchived: false, issueKind,
    createdAt: observedAt, updatedAt: observedAt,
  });
}

function state(): RecoveredRootState {
  return {
    rootIssueId: "root-1", contentDigest: "sha256:invalid-generation",
    observation: { facts: [
      issue("root-1", "root", undefined, "In Progress", 0),
      issue("cycle-1", "cycle", "root-1", "Canceled", 1,
        ["Execution Invalidated", "symphony:kind/cycle"]),
      issue("plan-a", "plan", "cycle-1", "Done", 2),
      issue("work-b", "work", "cycle-1", "Done", 2),
      fact({
        kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo", branch: "root-1",
        headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [],
      }),
    ] },
  };
}

function compiler() {
  return new RootStateInvalidExecutionGenerationCompilerImpl(new RootStateViewPolicyImpl());
}

const input = { cycleIssueId: "cycle-1", executionGenerationFence: "invalid" as const };

test("archives one deepest invalid-generation descendant in canonical ID order", () => {
  assert.deepEqual(compiler().compile({ state: state(), ...input }), {
    kind: "effect", effect: { kind: "set_issue_archive_state", issueId: "plan-a", isArchived: true },
  });
});

test("archives the invalidated Cycle last and recognizes durable completion", () => {
  const current = state();
  issueValue(current, "plan-a").isArchived = true;
  issueValue(current, "work-b").isArchived = true;
  assert.deepEqual(compiler().compile({ state: current, ...input }), {
    kind: "effect", effect: { kind: "set_issue_archive_state", issueId: "cycle-1", isArchived: true },
  });
  issueValue(current, "cycle-1").isArchived = true;
  assert.deepEqual(compiler().compile({ state: current, ...input }), { kind: "satisfied" });
});

test("fails closed without the invalid fence or exact invalidated Cycle facts", () => {
  assert.deepEqual(compiler().compile({
    state: state(), cycleIssueId: "cycle-1", executionGenerationFence: "valid",
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });

  const wrongLabel = state();
  issueValue(wrongLabel, "cycle-1").labels = ["symphony:kind/cycle"];
  assert.deepEqual(compiler().compile({ state: wrongLabel, ...input }), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});

test("rejects a foreign Cycle and non-descendant live Issue does not enter the archive set", () => {
  const current = state();
  current.observation.facts = [...current.observation.facts,
    issue("cycle-2", "cycle", "root-1", "Planning", 1),
    issue("plan-foreign", "plan", "cycle-2", "Todo", 2),
  ];
  assert.deepEqual(compiler().compile({ state: current, ...input }), {
    kind: "effect", effect: { kind: "set_issue_archive_state", issueId: "plan-a", isArchived: true },
  });
  assert.deepEqual(compiler().compile({ state: current, ...input, cycleIssueId: "cycle-2" }), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});

function issueValue(current: RecoveredRootState, issueId: string) {
  const found = current.observation.facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === issueId);
  assert.ok(found?.value.kind === "linear_issue");
  return found.value;
}
