import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";
import { RootStateCyclePhaseCompilerImpl } from "../internal/RootStateCyclePhaseCompilerImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "git_worktree" ? value.rootIssueId
      : "issueId" in value ? value.issueId
        : "unknown";
  return {
    identity: { sourceKind: value.kind, sourceId },
    value,
    provenance: { actorKind: "symphony", observedAt },
  };
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle" | "plan" | "work" | "verify",
  statusName: string,
  statusId: string,
  parentIssueId?: string,
): CanonicalFactValue {
  return {
    kind: "linear_issue", issueId, identifier: issueId.toUpperCase(), projectId: "project-1",
    ...(parentIssueId === undefined ? {} : { parentIssueId }),
    statusId, statusName, statusCategory: statusName === "Done" ? "completed" : "started", statusPosition: 1,
    order: 0, depth: parentIssueId ? (issueKind === "cycle" ? 1 : 2) : 0,
    title: issueId, description: issueId, labels: [`symphony:kind/${issueKind}`], isArchived: false,
    issueKind, createdAt: observedAt, updatedAt: observedAt,
  };
}

function recovered(cycleStatus = "Sealed", workStatus = "Todo", verifyStatus = "Todo"): RecoveredRootState {
  const statusId = (name: string) => `status-${name.toLowerCase()}`;
  const facts = ["Todo", "Sealed", "Executing", "Verifying", "Done"].map((name, position) => fact({
    kind: "linear_status", statusId: statusId(name), name,
    category: name === "Done" ? "completed" : name === "Todo" ? "unstarted" : "started", position,
  }));
  facts.push(
    fact(issue("root-1", "root", "Executing", statusId("Executing"))),
    fact(issue("cycle-1", "cycle", cycleStatus, statusId(cycleStatus), "root-1")),
    fact(issue("plan-1", "plan", "Done", statusId("Done"), "cycle-1")),
    fact(issue("work-1", "work", workStatus, statusId(workStatus), "cycle-1")),
    fact(issue("verify-1", "verify", verifyStatus, statusId(verifyStatus), "cycle-1")),
    fact({ kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo-1", branch: "symphony/root-1", headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [] }),
  );
  return { rootIssueId: "root-1", contentDigest: "sha256:test", observation: { facts } };
}

test("derives a frozen transition view directly from recovered canonical state", () => {
  const view = new RootStateViewPolicyImpl().derive(recovered());

  assert.equal(view.root.issueId, "root-1");
  assert.equal(view.worktree.rootIssueId, "root-1");
  assert.deepEqual(view.issues.map(({ issueId }) => issueId), ["root-1", "cycle-1", "plan-1", "work-1", "verify-1"]);
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.issues));
  assert.ok(Object.isFrozen(view.root));
  assert.ok(Object.isFrozen(view.root.labels));
  assert.ok(Object.isFrozen(view.worktree.changedPaths));
});

test("compiles Cycle phases to desired-state effects without mutation preconditions", () => {
  const compiler = new RootStateCyclePhaseCompilerImpl(new RootStateViewPolicyImpl());

  assert.deepEqual(compiler.compile({ state: recovered(), cycleIssueId: "cycle-1", desiredStatus: "Executing" }), {
    kind: "effect",
    effect: { kind: "set_issue_status", issueId: "cycle-1", statusId: "status-executing" },
  });
  assert.deepEqual(compiler.compile({ state: recovered("Executing", "Done"), cycleIssueId: "cycle-1", desiredStatus: "Verifying" }), {
    kind: "effect",
    effect: { kind: "set_issue_status", issueId: "cycle-1", statusId: "status-verifying" },
  });
});

test("is restart-equivalent and fails closed for invalid lifecycle facts", () => {
  const compiler = new RootStateCyclePhaseCompilerImpl(new RootStateViewPolicyImpl());
  const first = recovered("Executing", "Done");
  const restarted = structuredClone(first);
  restarted.observation.facts = [...restarted.observation.facts].reverse();

  assert.deepEqual(
    compiler.compile({ state: first, cycleIssueId: "cycle-1", desiredStatus: "Verifying" }),
    compiler.compile({ state: restarted, cycleIssueId: "cycle-1", desiredStatus: "Verifying" }),
  );
  assert.deepEqual(compiler.compile({ state: recovered("Sealed", "Done"), cycleIssueId: "cycle-1", desiredStatus: "Executing" }), {
    kind: "invalid_facts", reason: "topology_invalid",
  });
});

test("recognizes satisfied state and rejects an ambiguous status catalog", () => {
  const compiler = new RootStateCyclePhaseCompilerImpl(new RootStateViewPolicyImpl());
  assert.deepEqual(compiler.compile({ state: recovered("Executing"), cycleIssueId: "cycle-1", desiredStatus: "Executing" }), {
    kind: "satisfied",
  });

  const ambiguous = recovered();
  const executing = ambiguous.observation.facts.find(({ value }) => value.kind === "linear_status" && value.name === "Executing");
  assert.ok(executing?.value.kind === "linear_status");
  ambiguous.observation.facts = [
    ...ambiguous.observation.facts,
    fact({ ...executing.value, statusId: "status-executing-duplicate" }),
  ];
  assert.deepEqual(compiler.compile({ state: ambiguous, cycleIssueId: "cycle-1", desiredStatus: "Executing" }), {
    kind: "invalid_facts", reason: "status_catalog_invalid",
  });
});
