import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateInitialRequirementCompilerImpl } from "../internal/RootStateInitialRequirementCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "linear_issue" ? value.issueId
      : value.kind === "git_worktree" ? value.rootIssueId
        : "unused";
  return {
    identity: { sourceKind: value.kind, sourceId }, value,
    provenance: { actorKind: "symphony", observedAt: "2026-07-29T00:00:00.000Z" },
  };
}

function state(): RecoveredRootState {
  return {
    rootIssueId: "root-1",
    contentDigest: "sha256:current-root",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "todo", name: "Todo", category: "unstarted", position: 1 }),
      fact({ kind: "linear_status", statusId: "progress", name: "In Progress", category: "started", position: 2 }),
      fact({
        kind: "linear_issue", issueId: "root-1", identifier: "SYM-1", projectId: "project-1",
        creatorUserId: "human", statusId: "todo", statusName: "Todo", statusCategory: "unstarted",
        statusPosition: 1, order: 0, depth: 0, title: "Root", description: "Draft requirement",
        labels: ["symphony:kind/root"], isArchived: false, issueKind: "root",
        createdAt: "2026-07-29T00:00:00.000Z", updatedAt: "2026-07-29T00:00:00.000Z",
      }),
      fact({
        kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo", branch: "root-1",
        headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [],
      }),
    ] },
  };
}

function input() {
  return {
    state: state(),
    intent: {
      semanticGate: "requirement_and_comment" as const,
      rootIssueId: "root-1",
      basedOnRootDigest: "sha256:current-root",
      consumedInputIds: [] as string[],
      commentDispositions: [] as Array<{ kind: "applied"; sourceInputId: string }>,
      intent: {
        kind: "define_requirement" as const,
        requirement: {
          objective: "  Build it  ", requestedScope: "  Conductor  ",
          constraints: ["No compatibility shim"], acceptanceCriteria: ["E2E reaches Plan"],
        },
        activeCycleImpact: "initial" as const,
      },
    },
  };
}

function compiler() {
  return new RootStateInitialRequirementCompilerImpl(new RootStateViewPolicyImpl());
}

test("compiles a fresh requirement definition to one complete desired Root state", () => {
  const current = input();
  assert.deepEqual(compiler().compile(current), {
    kind: "effect",
    effect: {
      kind: "update_issue", issueId: "root-1", statusId: "progress", title: "Root",
      description: [
        "# Objective", "", "Build it", "", "## Requested Scope", "", "Conductor",
        "", "## Constraints", "", "- No compatibility shim",
        "", "## Acceptance Criteria", "", "- E2E reaches Plan",
      ].join("\n"),
      labelNames: ["symphony:kind/root"], order: 0,
    },
  });
});

test("rejects a stale digest, foreign Root and non-initial impact", () => {
  const stale = input();
  stale.intent.basedOnRootDigest = "sha256:stale";
  assert.deepEqual(compiler().compile(stale), { kind: "invalid_intent", reason: "subject_stale" });

  const foreign = input();
  foreign.intent.rootIssueId = "root-2";
  assert.deepEqual(compiler().compile(foreign), { kind: "invalid_intent", reason: "subject_stale" });

  const impact = input();
  impact.intent.intent.activeCycleImpact = "compatible" as "initial";
  assert.deepEqual(compiler().compile(impact), { kind: "invalid_intent", reason: "impact_invalid" });
});

test("rejects descendants, relations, pending inputs and ambiguous status", () => {
  const descendant = input();
  const root = descendant.state.observation.facts.find(({ value }) => value.kind === "linear_issue");
  assert.ok(root?.value.kind === "linear_issue");
  descendant.state.observation.facts = [...descendant.state.observation.facts, fact({
    ...root.value, issueId: "cycle-1", identifier: "SYM-2", issueKind: "cycle", parentIssueId: "root-1", depth: 1,
  })];
  assert.deepEqual(compiler().compile(descendant), { kind: "invalid_intent", reason: "topology_invalid" });

  const relation = input();
  relation.state.observation.facts = [...relation.state.observation.facts, fact({
    kind: "linear_relation", relationId: "relation-1", relationKind: "relates_to",
    sourceIssueId: "root-1", targetIssueId: "root-1",
  })];
  assert.deepEqual(compiler().compile(relation), { kind: "invalid_intent", reason: "topology_invalid" });

  const pending = input();
  pending.intent.consumedInputIds = ["input-1"];
  pending.intent.commentDispositions = [{ kind: "applied", sourceInputId: "input-1" }];
  assert.deepEqual(compiler().compile(pending), { kind: "invalid_intent", reason: "input_disposition_invalid" });

  const ambiguous = input();
  ambiguous.state.observation.facts = [...ambiguous.state.observation.facts, fact({
    kind: "linear_status", statusId: "progress-2", name: "In Progress", category: "started", position: 3,
  })];
  assert.deepEqual(compiler().compile(ambiguous), { kind: "invalid_intent", reason: "status_catalog_invalid" });
});

test("rejects an incomplete requirement", () => {
  const empty = input();
  empty.intent.intent.requirement.objective = "   ";
  assert.deepEqual(compiler().compile(empty), { kind: "invalid_intent", reason: "requirement_invalid" });
});

test("rejects requirement content that injects a canonical structural heading", () => {
  const injected = input();
  injected.intent.intent.requirement.objective = "Build it\n\n## Requested Scope\n\nSomething else";

  assert.deepEqual(compiler().compile(injected), {
    kind: "invalid_intent",
    reason: "requirement_invalid",
  });
});
