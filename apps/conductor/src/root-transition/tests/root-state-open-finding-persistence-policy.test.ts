import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateOpenFindingPersistencePolicyImpl } from "../internal/RootStateOpenFindingPersistencePolicyImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "git_worktree" ? value.rootIssueId
      : value.kind === "linear_issue" ? value.issueId
        : value.kind === "linear_relation" ? value.relationId
          : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind: "symphony", observedAt } };
}

function state(): RecoveredRootState {
  const issue = (
    issueId: string,
    issueKind: "root" | "cycle" | "finding",
    parentIssueId: string | undefined,
    statusName: string,
    isArchived: boolean,
    createdAt: string,
  ): CanonicalFact => fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId === undefined ? {} : { parentIssueId }),
    statusId: `status-${statusName.toLowerCase()}`, statusName,
    statusCategory: statusName === "Canceled" ? "canceled" : statusName === "Changes Required" ? "completed" : statusName === "Done" ? "completed" : "unstarted",
    statusPosition: 1, order: 0, depth: parentIssueId ? (issueKind === "cycle" ? 1 : 2) : 0,
    title: issueId, description: issueId, labels: [`symphony:kind/${issueKind}`], isArchived,
    issueKind, createdAt, updatedAt: observedAt,
  });
  return {
    rootIssueId: "root-1", contentDigest: "sha256:lineage",
    observation: { facts: [
      issue("root-1", "root", undefined, "Todo", false, "2026-07-27T00:00:00.000Z"),
      issue("cycle-1", "cycle", "root-1", "Changes Required", true, "2026-07-28T00:00:00.000Z"),
      issue("finding-1", "finding", "cycle-1", "Todo", true, "2026-07-28T01:00:00.000Z"),
      issue("cycle-2", "cycle", "root-1", "Verifying", false, "2026-07-29T00:00:00.000Z"),
      issue("finding-2", "finding", "cycle-2", "Todo", false, "2026-07-29T01:00:00.000Z"),
      fact({ kind: "linear_relation", relationId: "lineage-1", relationKind: "triggered_by", sourceIssueId: "finding-2", targetIssueId: "finding-1" }),
      fact({ kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo-1", branch: "root-1", headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [] }),
    ] },
  };
}

function derive(value: RecoveredRootState) {
  const view = new RootStateViewPolicyImpl().derive(value);
  return new RootStateOpenFindingPersistencePolicyImpl().derive({ view, activeCycleIssueId: "cycle-2" });
}

test("derives one directed adjacent-Cycle open Finding lineage", () => {
  assert.deepEqual(derive(state()), [{ findingId: "finding-2", openCycleCount: 2, findingIds: ["finding-2", "finding-1"] }]);
});

test("resets persistence at a terminal predecessor", () => {
  const value = state();
  const predecessor = value.observation.facts.find(({ value: candidate }) => candidate.kind === "linear_issue" && candidate.issueId === "finding-1");
  assert.ok(predecessor?.value.kind === "linear_issue");
  Object.assign(predecessor.value, { statusName: "Done", statusId: "status-done", statusCategory: "completed" });

  assert.deepEqual(derive(value), [{ findingId: "finding-2", openCycleCount: 1, findingIds: ["finding-2"] }]);
});

test("rejects reversed, skipped-Cycle, branched and equal-time lineage", () => {
  const reversed = state();
  const reversedRelation = reversed.observation.facts.find(({ value }) => value.kind === "linear_relation");
  assert.ok(reversedRelation?.value.kind === "linear_relation");
  [reversedRelation.value.sourceIssueId, reversedRelation.value.targetIssueId] = [reversedRelation.value.targetIssueId, reversedRelation.value.sourceIssueId];
  assert.throws(() => derive(reversed), /root_state_finding_lineage_invalid/u);

  const skipped = state();
  const cycle = skipped.observation.facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === "cycle-1");
  assert.ok(cycle?.value.kind === "linear_issue");
  skipped.observation.facts = [...skipped.observation.facts, fact({
    ...cycle.value,
    issueId: "cycle-middle",
    identifier: "cycle-middle",
    createdAt: "2026-07-28T12:00:00.000Z",
  })];
  assert.throws(() => derive(skipped), /root_state_finding_lineage_invalid/u);

  const branched = state();
  const tip = branched.observation.facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === "finding-2");
  assert.ok(tip?.value.kind === "linear_issue");
  branched.observation.facts = [
    ...branched.observation.facts,
    fact({ ...tip.value, issueId: "finding-3", identifier: "finding-3" }),
    fact({ kind: "linear_relation", relationId: "lineage-2", relationKind: "triggered_by", sourceIssueId: "finding-3", targetIssueId: "finding-1" }),
  ];
  assert.throws(() => derive(branched), /root_state_finding_lineage_invalid/u);

  const merged = state();
  const predecessor = merged.observation.facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === "finding-1");
  assert.ok(predecessor?.value.kind === "linear_issue");
  merged.observation.facts = [
    ...merged.observation.facts,
    fact({ ...predecessor.value, issueId: "finding-other", identifier: "finding-other" }),
    fact({ kind: "linear_relation", relationId: "lineage-merge", relationKind: "triggered_by", sourceIssueId: "finding-2", targetIssueId: "finding-other" }),
  ];
  assert.throws(() => derive(merged), /root_state_finding_lineage_invalid/u);

  const equalTime = state();
  const cycle2 = equalTime.observation.facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === "cycle-2");
  assert.ok(cycle2?.value.kind === "linear_issue");
  cycle2.value.createdAt = "2026-07-28T00:00:00.000Z";
  assert.throws(() => derive(equalTime), /root_state_finding_lineage_invalid/u);
});

test("rejects a nonterminal Finding outside the closed open-status subset", () => {
  const value = state();
  const tip = value.observation.facts.find(({ value: candidate }) => candidate.kind === "linear_issue" && candidate.issueId === "finding-2");
  assert.ok(tip?.value.kind === "linear_issue");
  Object.assign(tip.value, { statusName: "Planning", statusId: "status-planning", statusCategory: "started" });
  assert.throws(() => derive(value), /root_state_finding_lineage_invalid/u);
});

test("rejects an open tip outside the active Cycle", () => {
  assert.throws(() => {
    const view = new RootStateViewPolicyImpl().derive(state());
    new RootStateOpenFindingPersistencePolicyImpl().derive({ view, activeCycleIssueId: "cycle-1" });
  }, /root_state_finding_lineage_invalid/u);
});
