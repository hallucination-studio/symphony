import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateAuthorizedTerminalSuccessorCompilerImpl } from "../internal/RootStateAuthorizedTerminalSuccessorCompilerImpl.js";
import { RootStateCurrentIssueProvenancePolicyImpl } from "../internal/RootStateCurrentIssueProvenancePolicyImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";
const requirement = [
  "# Objective", "", "Build it", "", "## Requested Scope", "", "Conductor", "",
  "## Acceptance Criteria", "", "- E2E reaches delivery",
].join("\n");
const successorDescription = [
  "# Successor Objective", "", "Cover rollout", "", "## Required Outcomes", "",
  "- Rollout is verified", "", "## Preserved Constraints", "", "- Preserve acceptance",
].join("\n");

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "linear_issue" ? value.issueId
      : value.kind === "git_worktree" ? value.rootIssueId
        : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind: "symphony", observedAt } };
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle" | "plan" | "work",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: string,
  description: string,
  options: { archived?: boolean; depth?: number; labels?: string[]; createdAt?: string } = {},
): CanonicalFact {
  return fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId ? { parentIssueId } : {}),
    statusId, statusName,
    statusCategory: statusName === "Succeeded" || statusName === "Done" ? "completed" : "started",
    statusPosition: 1, order: 0, depth: options.depth ?? (issueKind === "root" ? 0 : issueKind === "cycle" ? 1 : 2),
    title: issueKind === "root" ? "Root" : issueKind === "cycle" ? `Cycle ${issueId.endsWith("2") ? "2" : "1"}` : issueKind === "plan" ? "Plan" : issueId,
    description, labels: options.labels ?? [`symphony:kind/${issueKind}`],
    isArchived: options.archived ?? false, issueKind,
    createdAt: options.createdAt ?? observedAt, updatedAt: observedAt,
  });
}

function state(options: { archiveWork?: boolean; archivePlan?: boolean; archiveCycle?: boolean; withSuccessorPlan?: boolean } = {}): RecoveredRootState {
  return {
    rootIssueId: "root-1", contentDigest: "sha256:successor",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "todo", name: "Todo", category: "unstarted", position: 1 }),
      issue("root-1", "root", undefined, "progress", "In Progress", requirement, {
        createdAt: "2026-07-28T00:00:00.000Z",
      }),
      issue("cycle-1", "cycle", "root-1", "succeeded", "Succeeded", "Build it", {
        ...(options.archiveCycle === undefined ? {} : { archived: options.archiveCycle }),
        createdAt: "2026-07-28T01:00:00.000Z",
      }),
      issue("plan-1", "plan", "cycle-1", "done", "Done", "Old plan", {
        ...(options.archivePlan === undefined ? {} : { archived: options.archivePlan }),
      }),
      issue("work-1", "work", "plan-1", "done", "Done", "Old work", {
        ...(options.archiveWork === undefined ? {} : { archived: options.archiveWork }),
        depth: 3,
      }),
      issue("cycle-2", "cycle", "root-1", "planning", "Planning", successorDescription, {
        labels: ["Terminal Review Successor", "symphony:kind/cycle"],
        createdAt: "2026-07-29T00:00:00.000Z",
      }),
      ...(options.withSuccessorPlan ? [
        issue("plan-2", "plan", "cycle-2", "todo", "Todo", successorDescription),
      ] : []),
      fact({
        kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo", branch: "root-1",
        headRevision: "head-1", baseRevision: "base", isClean: true, changedPaths: [],
      }),
    ] },
  };
}

function compiler() {
  return new RootStateAuthorizedTerminalSuccessorCompilerImpl(
    new RootStateViewPolicyImpl(),
    new RootStateCurrentIssueProvenancePolicyImpl(),
  );
}

function compile(current: RecoveredRootState) {
  return compiler().compile({
    state: current, predecessorCycleIssueId: "cycle-1", successorCycleIssueId: "cycle-2",
    worktreeFence: "valid", observedAt,
    policy: { maxCyclesPerRoot: 3, deadlineAt: "2026-07-30T00:00:00.000Z" },
  });
}

test("archives the predecessor leaf-first and archives its Cycle last", () => {
  assert.deepEqual(compile(state()), {
    kind: "effect", effect: { kind: "set_issue_archive_state", issueId: "work-1", isArchived: true },
  });
  assert.deepEqual(compile(state({ archiveWork: true })), {
    kind: "effect", effect: { kind: "set_issue_archive_state", issueId: "plan-1", isArchived: true },
  });
  assert.deepEqual(compile(state({ archiveWork: true, archivePlan: true })), {
    kind: "effect", effect: { kind: "set_issue_archive_state", issueId: "cycle-1", isArchived: true },
  });
});

test("creates one Todo Plan after predecessor archival and recognizes restart satisfaction", () => {
  assert.deepEqual(compile(state({ archiveWork: true, archivePlan: true, archiveCycle: true })), {
    kind: "effect",
    effect: {
      kind: "create_issue", parentIssueId: "cycle-2", statusId: "todo", title: "Plan",
      description: successorDescription, labelNames: ["symphony:kind/plan"],
    },
  });
  const restarted = state({
    archiveWork: true, archivePlan: true, archiveCycle: true, withSuccessorPlan: true,
  });
  restarted.observation.facts = [...restarted.observation.facts].reverse();
  assert.deepEqual(compile(restarted), { kind: "satisfied" });
});

test("rejects stale admission, malformed successor authorization and archived-parent drift", () => {
  const malformed = state();
  const successor = malformed.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "cycle-2");
  assert.ok(successor?.value.kind === "linear_issue");
  successor.value.labels = ["symphony:kind/cycle"];
  assert.deepEqual(compile(malformed), { kind: "invalid_facts", reason: "topology_invalid" });

  const expired = compiler().compile({
    state: state(), predecessorCycleIssueId: "cycle-1", successorCycleIssueId: "cycle-2",
    worktreeFence: "valid", observedAt, policy: { maxCyclesPerRoot: 3, deadlineAt: observedAt },
  });
  assert.deepEqual(expired, { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });

  const drift = state({ archiveCycle: true });
  assert.deepEqual(compile(drift), { kind: "invalid_facts", reason: "topology_invalid" });
});

test("rejects successor relation or premature Plan topology before predecessor archival", () => {
  const related = state();
  related.observation.facts = [...related.observation.facts, fact({
    kind: "linear_relation", relationId: "relation-1", relationKind: "relates_to",
    sourceIssueId: "cycle-2", targetIssueId: "cycle-1",
  })];
  assert.deepEqual(compile(related), { kind: "invalid_facts", reason: "topology_invalid" });

  assert.deepEqual(compile(state({ withSuccessorPlan: true })), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});
