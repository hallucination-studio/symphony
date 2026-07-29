import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateCurrentIssueProvenancePolicyImpl } from "../internal/RootStateCurrentIssueProvenancePolicyImpl.js";
import { RootStateInterruptedPlanSuccessorCompilerImpl } from "../internal/RootStateInterruptedPlanSuccessorCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T04:00:00.000Z";

function fact(
  value: CanonicalFactValue,
  actorKind: "human" | "symphony" | "unknown" = "symphony",
): CanonicalFact {
  const sourceId = value.kind === "linear_issue" ? value.issueId
    : value.kind === "linear_activity" ? value.activityId
      : value.kind === "git_worktree" ? value.rootIssueId
        : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind, observedAt } };
}

function issue(
  issueId: string, issueKind: "root" | "cycle" | "plan", parentIssueId: string | undefined,
  statusName: string, createdAt: string, labels: readonly string[] = [`symphony:kind/${issueKind}`],
): CanonicalFact {
  return fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId ? { parentIssueId } : {}), statusId: statusName.toLowerCase().replaceAll(" ", "-"),
    statusName, statusCategory: statusName === "Todo" ? "unstarted" : statusName === "Interrupted" ? "canceled" : "started",
    statusPosition: 1, order: 0, depth: parentIssueId ? (issueKind === "cycle" ? 1 : 2) : 0,
    title: issueKind, description: `${issueKind} description`, labels, isArchived: false, issueKind,
    createdAt, updatedAt: createdAt,
  });
}

function state(): RecoveredRootState {
  return {
    rootIssueId: "root-1", contentDigest: "sha256:interrupted-plan-successor",
    observation: { facts: [
      issue("root-1", "root", undefined, "In Progress", "2026-07-29T00:00:00.000Z"),
      issue("cycle-1", "cycle", "root-1", "Planning", "2026-07-29T01:00:00.000Z"),
      issue("plan-1", "plan", "cycle-1", "Interrupted", "2026-07-29T02:00:00.000Z"),
      issue("plan-2", "plan", "cycle-1", "Todo", "2026-07-29T03:00:00.000Z",
        ["Interrupted Plan Successor", "symphony:kind/plan"]),
      fact({
        kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo", branch: "root-1",
        headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [],
      }),
    ] },
  };
}

function compiler() {
  return new RootStateInterruptedPlanSuccessorCompilerImpl(
    new RootStateViewPolicyImpl(), new RootStateCurrentIssueProvenancePolicyImpl(),
  );
}

const input = {
  cycleIssueId: "cycle-1", predecessorPlanIssueId: "plan-1", successorPlanIssueId: "plan-2",
  worktreeFence: "valid" as const,
};

test("archives only the exact authorized interrupted Plan predecessor", () => {
  assert.deepEqual(compiler().compile({ state: state(), ...input }), {
    kind: "effect", effect: { kind: "set_issue_archive_state", issueId: "plan-1", isArchived: true },
  });
});

test("recognizes durable predecessor archival while preserving archived Plan history", () => {
  const current = state();
  issueValue(current, "plan-1").isArchived = true;
  current.observation.facts = [...current.observation.facts,
    { ...issue("plan-0", "plan", "cycle-1", "Interrupted", "2026-07-28T00:00:00.000Z"),
      value: { ...issueValueFromFact(issue("plan-0", "plan", "cycle-1", "Interrupted", "2026-07-28T00:00:00.000Z")), isArchived: true } },
  ];
  assert.deepEqual(compiler().compile({ state: current, ...input }), { kind: "satisfied" });
});

test("accepts the unknown-manifest predecessor actor to successor creator proof", () => {
  const current = state();
  const predecessor = issueFact(current, "plan-1");
  const successor = issueFact(current, "plan-2");
  predecessor.provenance.actorKind = "unknown";
  successor.provenance.actorKind = "unknown";
  assert.ok(successor.value.kind === "linear_issue");
  successor.value.creatorUserId = "symphony-actor";
  current.observation.facts = [...current.observation.facts, fact({
    kind: "linear_activity", activityId: "plan-1-interrupted", issueId: "plan-1",
    activityKinds: ["status_changed"], actorKind: "symphony", actorId: "symphony-actor",
    toStateId: "interrupted", createdAt: "2026-07-29T02:30:00.000Z",
  })];
  assert.equal(compiler().compile({ state: current, ...input }).kind, "effect");

  successor.value.creatorUserId = "other-actor";
  assert.deepEqual(compiler().compile({ state: current, ...input }), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
  successor.value.creatorUserId = "symphony-actor";

  current.observation.facts = [...current.observation.facts, fact({
    kind: "linear_activity", activityId: "plan-2-human-edit", issueId: "plan-2",
    activityKinds: ["description_changed"], actorKind: "human", actorId: "human",
    updatedDescription: successor.value.description, createdAt: "2026-07-29T03:30:00.000Z",
  }, "human")];
  assert.deepEqual(compiler().compile({ state: current, ...input }), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});

test("rejects a foreign successor actor, stale order, extra child and invalid worktree fence", () => {
  const foreign = state();
  issueFact(foreign, "plan-2").provenance.actorKind = "human";
  assert.equal(compiler().compile({ state: foreign, ...input }).kind, "invalid_facts");

  const stale = state();
  issueValue(stale, "plan-2").createdAt = "2026-07-29T01:30:00.000Z";
  assert.equal(compiler().compile({ state: stale, ...input }).kind, "invalid_facts");

  const extra = state();
  extra.observation.facts = [...extra.observation.facts,
    issue("plan-3", "plan", "cycle-1", "Todo", "2026-07-29T03:30:00.000Z")];
  assert.equal(compiler().compile({ state: extra, ...input }).kind, "invalid_facts");

  const related = state();
  related.observation.facts = [...related.observation.facts, fact({
    kind: "linear_relation", relationId: "plan-relation", relationKind: "relates_to",
    sourceIssueId: "plan-2", targetIssueId: "plan-1",
  })];
  assert.equal(compiler().compile({ state: related, ...input }).kind, "invalid_facts");

  assert.deepEqual(compiler().compile({ state: state(), ...input, worktreeFence: "invalid" }), {
    kind: "invalid_facts", reason: "mechanical_precondition_invalid",
  });
});

function issueFact(current: RecoveredRootState, issueId: string) {
  const found = current.observation.facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === issueId);
  assert.ok(found?.value.kind === "linear_issue");
  return found;
}

function issueValue(current: RecoveredRootState, issueId: string) {
  return issueFact(current, issueId).value as Extract<CanonicalFactValue, { kind: "linear_issue" }>;
}

function issueValueFromFact(current: CanonicalFact) {
  assert.ok(current.value.kind === "linear_issue");
  return current.value;
}
