import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateInitialCyclePlanCompilerImpl } from "../internal/RootStateInitialCyclePlanCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";
const requirement = [
  "# Objective", "", "Build it", "", "## Requested Scope", "", "Conductor", "",
  "## Constraints", "", "- No compatibility shim", "", "## Acceptance Criteria", "", "- E2E reaches Plan",
].join("\n");
const planDescription = [
  "# Plan Goal", "", "Build it", "", "## Requested Scope", "", "Conductor", "",
  "## Constraints", "", "- No compatibility shim", "", "## Acceptance And Verification", "",
  "- E2E reaches Plan (provider-defined verification)",
].join("\n");

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "linear_issue" ? value.issueId
      : value.kind === "linear_relation" ? value.relationId
        : value.kind === "git_worktree" ? value.rootIssueId
          : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind: "symphony", observedAt } };
}

function issue(
  issueId: string, issueKind: "root" | "cycle" | "plan", parentIssueId: string | undefined,
  statusId: string, statusName: string, title: string, description: string,
): CanonicalFact {
  return fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId ? { parentIssueId } : {}), statusId, statusName,
    statusCategory: statusName === "Todo" ? "unstarted" : "started", statusPosition: 1,
    order: 0, depth: parentIssueId ? (issueKind === "cycle" ? 1 : 2) : 0,
    title, description, labels: [`symphony:kind/${issueKind}`], isArchived: false, issueKind,
    createdAt: observedAt, updatedAt: observedAt,
  });
}

function state(options: { withCycle?: boolean; withPlan?: boolean } = {}): RecoveredRootState {
  return {
    rootIssueId: "root-1", contentDigest: "sha256:initial",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "planning", name: "Planning", category: "started", position: 1 }),
      fact({ kind: "linear_status", statusId: "todo", name: "Todo", category: "unstarted", position: 2 }),
      issue("root-1", "root", undefined, "progress", "In Progress", "Root", requirement),
      ...(options.withCycle ? [issue("cycle-1", "cycle", "root-1", "planning", "Planning", "Cycle 1", "Build it")] : []),
      ...(options.withPlan ? [issue("plan-1", "plan", "cycle-1", "todo", "Todo", "Plan", planDescription)] : []),
      fact({
        kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo", branch: "root-1",
        headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [],
      }),
    ] },
  };
}

function compiler() {
  return new RootStateInitialCyclePlanCompilerImpl(new RootStateViewPolicyImpl());
}

test("creates one initial Cycle, then one Plan, then reports satisfaction", () => {
  assert.deepEqual(compiler().compile({ state: state(), worktreeFence: "valid" }), {
    kind: "effect", effect: {
      kind: "create_issue", parentIssueId: "root-1", statusId: "planning", title: "Cycle 1",
      description: "Build it", labelNames: ["symphony:kind/cycle"],
    },
  });
  assert.deepEqual(compiler().compile({ state: state({ withCycle: true }), worktreeFence: "valid" }), {
    kind: "effect", effect: {
      kind: "create_issue", parentIssueId: "cycle-1", statusId: "todo", title: "Plan",
      description: planDescription, labelNames: ["symphony:kind/plan"],
    },
  });
  assert.deepEqual(compiler().compile({
    state: state({ withCycle: true, withPlan: true }), worktreeFence: "valid",
  }), { kind: "satisfied" });
});

test("fails closed for an invalid fence or noncanonical Root requirement", () => {
  assert.deepEqual(compiler().compile({ state: state(), worktreeFence: "invalid" }), {
    kind: "invalid_facts", reason: "mechanical_precondition_invalid",
  });
  const malformed = state();
  issueValue(malformed, "root-1").description = "Build it";
  assert.deepEqual(compiler().compile({ state: malformed, worktreeFence: "valid" }), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});

test("rejects status ambiguity, partial topology drift and relations", () => {
  const status = state();
  status.observation.facts = [...status.observation.facts, fact({
    kind: "linear_status", statusId: "planning-2", name: "Planning", category: "started", position: 3,
  })];
  assert.deepEqual(compiler().compile({ state: status, worktreeFence: "valid" }), {
    kind: "invalid_facts", reason: "status_catalog_invalid",
  });

  const wrongCycle = state({ withCycle: true });
  issueValue(wrongCycle, "cycle-1").description = "Wrong objective";
  assert.equal(compiler().compile({ state: wrongCycle, worktreeFence: "valid" }).kind, "invalid_facts");

  const duplicate = state({ withCycle: true, withPlan: true });
  duplicate.observation.facts = [...duplicate.observation.facts, fact({
    ...issueValue(duplicate, "plan-1"), issueId: "plan-2", identifier: "plan-2",
  })];
  assert.equal(compiler().compile({ state: duplicate, worktreeFence: "valid" }).kind, "invalid_facts");

  const related = state({ withCycle: true });
  related.observation.facts = [...related.observation.facts, fact({
    kind: "linear_relation", relationId: "relation-1", relationKind: "relates_to",
    sourceIssueId: "cycle-1", targetIssueId: "root-1",
  })];
  assert.equal(compiler().compile({ state: related, worktreeFence: "valid" }).kind, "invalid_facts");
});

test("produces the same desired effect for every canonical fact order", () => {
  const forward = state({ withCycle: true });
  const reversed = structuredClone(forward);
  reversed.observation.facts = [...reversed.observation.facts].reverse();

  assert.deepEqual(
    compiler().compile({ state: reversed, worktreeFence: "valid" }),
    compiler().compile({ state: forward, worktreeFence: "valid" }),
  );
});

function issueValue(current: RecoveredRootState, issueId: string) {
  const found = current.observation.facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === issueId);
  assert.ok(found?.value.kind === "linear_issue");
  return found.value;
}
