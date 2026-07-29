import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateAuthorizedInterruptedStageSuccessorCompilerImpl } from "../internal/RootStateAuthorizedInterruptedStageSuccessorCompilerImpl.js";
import { RootStateCurrentIssueProvenancePolicyImpl } from "../internal/RootStateCurrentIssueProvenancePolicyImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";
const requirement = [
  "# Objective", "", "Build it", "", "## Requested Scope", "", "Conductor", "",
  "## Acceptance Criteria", "", "- E2E reaches delivery",
].join("\n");

function successorDescription(role: "work" | "verify"): string {
  return [
    "# Recovery Goal", "", "Recover execution", "", "## Recovery Source", "",
    `The predecessor Cycle contains an interrupted ${role} attempt.`, "",
    "## Success Evidence", "", "- Recovery is verified",
  ].join("\n");
}

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "linear_issue" ? value.issueId
      : value.kind === "linear_activity" ? value.activityId
        : value.kind === "git_worktree" ? value.rootIssueId
          : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind: "symphony", observedAt } };
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle" | "plan" | "work" | "verify",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: string,
  description: string,
  options: { archived?: boolean; labels?: string[]; createdAt?: string } = {},
): CanonicalFact {
  return fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId ? { parentIssueId } : {}),
    statusId, statusName, statusCategory: "started", statusPosition: 1, order: 0,
    depth: issueKind === "root" ? 0 : issueKind === "cycle" ? 1 : 2,
    title: issueKind === "root" ? "Root" : issueKind === "cycle"
      ? `Cycle ${issueId.endsWith("2") ? "2" : "1"}`
      : issueKind === "plan" ? "Plan" : issueId,
    description, labels: options.labels ?? [`symphony:kind/${issueKind}`],
    isArchived: options.archived ?? false, issueKind,
    createdAt: options.createdAt ?? observedAt, updatedAt: observedAt,
  });
}

function state(
  role: "work" | "verify" = "work",
  options: {
    archivePlan?: boolean;
    archiveStage?: boolean;
    archiveCycle?: boolean;
    withSuccessorPlan?: boolean;
  } = {},
): RecoveredRootState {
  const phase = role === "work" ? "Executing" : "Verifying";
  return {
    rootIssueId: "root-1", contentDigest: "sha256:authorized-stage-successor",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "todo", name: "Todo", category: "unstarted", position: 1 }),
      issue("root-1", "root", undefined, "progress", "In Progress", requirement, {
        createdAt: "2026-07-28T00:00:00.000Z",
      }),
      issue("cycle-1", "cycle", "root-1", phase.toLowerCase(), phase, "Old Cycle", {
        ...(options.archiveCycle === undefined ? {} : { archived: options.archiveCycle }),
        createdAt: "2026-07-28T01:00:00.000Z",
      }),
      issue("plan-1", "plan", "cycle-1", "done", "Done", "Old Plan", {
        ...(options.archivePlan === undefined ? {} : { archived: options.archivePlan }),
      }),
      issue("stage-1", role, "cycle-1", "interrupted", "Interrupted", "Interrupted", {
        ...(options.archiveStage === undefined ? {} : { archived: options.archiveStage }),
      }),
      issue("cycle-2", "cycle", "root-1", "planning", "Planning", successorDescription(role), {
        labels: ["Interrupted Stage Recovery", "symphony:kind/cycle"],
        createdAt: "2026-07-29T00:00:00.000Z",
      }),
      ...(options.withSuccessorPlan ? [
        issue("plan-2", "plan", "cycle-2", "todo", "Todo", successorDescription(role)),
      ] : []),
      fact({
        kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo", branch: "root-1",
        headRevision: "head-1", baseRevision: "base", isClean: true, changedPaths: [],
      }),
    ] },
  };
}

function compiler() {
  return new RootStateAuthorizedInterruptedStageSuccessorCompilerImpl(
    new RootStateViewPolicyImpl(),
    new RootStateCurrentIssueProvenancePolicyImpl(),
  );
}

function compile(current: RecoveredRootState, role: "work" | "verify" = "work") {
  return compiler().compile({
    state: current, predecessorCycleIssueId: "cycle-1", successorCycleIssueId: "cycle-2",
    interruptedStageIssueId: "stage-1", role, worktreeFence: "valid", sessionFence: "closed",
    observedAt, policy: { maxCyclesPerRoot: 3, deadlineAt: "2026-07-30T00:00:00.000Z" },
  });
}

test("archives every predecessor child deterministically and archives the Cycle last", () => {
  assert.deepEqual(compile(state()), {
    kind: "effect", effect: { kind: "set_issue_archive_state", issueId: "plan-1", isArchived: true },
  });
  assert.deepEqual(compile(state("work", { archivePlan: true })), {
    kind: "effect", effect: { kind: "set_issue_archive_state", issueId: "stage-1", isArchived: true },
  });
  assert.deepEqual(compile(state("work", { archivePlan: true, archiveStage: true })), {
    kind: "effect", effect: { kind: "set_issue_archive_state", issueId: "cycle-1", isArchived: true },
  });
});

for (const role of ["work", "verify"] as const) {
  test(`creates one Todo Plan for an authorized ${role} successor and recovers satisfaction`, () => {
    const archived = { archivePlan: true, archiveStage: true, archiveCycle: true };
    assert.deepEqual(compile(state(role, archived), role), {
      kind: "effect",
      effect: {
        kind: "create_issue", parentIssueId: "cycle-2", statusId: "todo", title: "Plan",
        description: successorDescription(role), labelNames: ["symphony:kind/plan"],
      },
    });
    const restarted = state(role, { ...archived, withSuccessorPlan: true });
    restarted.observation.facts = [...restarted.observation.facts].reverse();
    assert.deepEqual(compile(restarted, role), { kind: "satisfied" });
  });
}

test("rejects fence, admission, role topology and successor relation drift", () => {
  assert.deepEqual(compiler().compile({
    state: state(), predecessorCycleIssueId: "cycle-1", successorCycleIssueId: "cycle-2",
    interruptedStageIssueId: "stage-1", role: "work", worktreeFence: "valid",
    sessionFence: "active", observedAt,
    policy: { maxCyclesPerRoot: 3, deadlineAt: "2026-07-30T00:00:00.000Z" },
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });

  assert.deepEqual(compiler().compile({
    state: state(), predecessorCycleIssueId: "cycle-1", successorCycleIssueId: "cycle-2",
    interruptedStageIssueId: "stage-1", role: "work", worktreeFence: "valid",
    sessionFence: "closed", observedAt, policy: { maxCyclesPerRoot: 3, deadlineAt: observedAt },
  }), { kind: "invalid_facts", reason: "mechanical_precondition_invalid" });

  assert.deepEqual(compile(state("verify"), "work"), {
    kind: "invalid_facts", reason: "topology_invalid",
  });

  const related = state();
  related.observation.facts = [...related.observation.facts, fact({
    kind: "linear_relation", relationId: "relation-1", relationKind: "relates_to",
    sourceIssueId: "cycle-2", targetIssueId: "cycle-1",
  })];
  assert.deepEqual(compile(related), { kind: "invalid_facts", reason: "topology_invalid" });
});

test("rejects a live predecessor child after the predecessor Cycle was archived", () => {
  assert.deepEqual(compile(state("work", { archiveCycle: true })), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});

test("re-proves the Stage-to-successor actor chain on every convergence round", () => {
  const forged = state();
  const forgedStage = forged.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "stage-1");
  assert.ok(forgedStage?.value.kind === "linear_issue");
  forgedStage.provenance.actorKind = "human";
  assert.deepEqual(compile(forged), { kind: "invalid_facts", reason: "topology_invalid" });

  const recovered = state();
  const stage = recovered.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "stage-1");
  const successor = recovered.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "cycle-2");
  assert.ok(stage?.value.kind === "linear_issue");
  assert.ok(successor?.value.kind === "linear_issue");
  stage.provenance.actorKind = "unknown";
  stage.value.creatorUserId = "delegate-1";
  successor.provenance.actorKind = "unknown";
  successor.value.creatorUserId = "delegate-1";
  recovered.observation.facts = [...recovered.observation.facts, fact({
    kind: "linear_activity", activityId: "stage-1-interrupted", issueId: "stage-1",
    activityKinds: ["status_changed"], actorKind: "symphony", actorId: "delegate-1",
    toStateId: "interrupted", createdAt: observedAt,
  })];
  assert.deepEqual(compile(recovered), {
    kind: "effect", effect: { kind: "set_issue_archive_state", issueId: "plan-1", isArchived: true },
  });
});
