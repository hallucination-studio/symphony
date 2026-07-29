import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFactInput } from "../api/CanonicalFact.js";
import type {
  RootStateFactReadResult,
  RootStateRecoverySourceInterface,
} from "../api/RootStateRecoveryInterface.js";
import { RootStateRecoveryImpl } from "../internal/RootStateRecoveryImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";
const symphony = { actorKind: "symphony" as const, observedAt };
const human = { actorKind: "human" as const, observedAt };

function completeFacts(): CanonicalFactInput[] {
  return [
    { value: { kind: "linear_status", statusId: "status-todo", name: "Todo", category: "unstarted", position: 1 }, provenance: symphony },
    { value: { kind: "linear_status", statusId: "status-done", name: "Done", category: "completed", position: 2 }, provenance: symphony },
    {
      value: {
        kind: "linear_issue", issueId: "root-1", identifier: "SYM-1", projectId: "project-1",
        statusId: "status-todo", statusName: "Todo", statusCategory: "unstarted", statusPosition: 1,
        order: 0, depth: 0, title: "Root", description: "Outcome", labels: ["symphony:kind/root"],
        isArchived: false, issueKind: "root", createdAt: observedAt, updatedAt: observedAt,
      },
      provenance: human,
    },
    {
      value: {
        kind: "linear_issue", issueId: "cycle-1", identifier: "SYM-2", projectId: "project-1", parentIssueId: "root-1",
        statusId: "status-done", statusName: "Done", statusCategory: "completed", statusPosition: 2,
        order: 0, depth: 1, title: "Cycle", description: "Cycle", labels: ["symphony:kind/cycle"],
        isArchived: true, issueKind: "cycle", createdAt: observedAt, updatedAt: observedAt,
      },
      provenance: symphony,
    },
    {
      value: {
        kind: "linear_issue", issueId: "plan-1", identifier: "SYM-3", projectId: "project-1", parentIssueId: "cycle-1",
        statusId: "status-done", statusName: "Done", statusCategory: "completed", statusPosition: 2,
        order: 0, depth: 2, title: "Plan", description: "Plan", labels: ["symphony:kind/plan"],
        isArchived: true, issueKind: "plan", createdAt: observedAt, updatedAt: observedAt,
      },
      provenance: symphony,
    },
    {
      value: {
        kind: "linear_comment", commentId: "comment-1", issueId: "root-1", body: "Please proceed",
        authorKind: "human", authorId: "user-1", authorUserId: "user-1", threadRootCommentId: "comment-1",
        threadState: "unresolved", reactions: [], createdAt: observedAt, updatedAt: observedAt,
      },
      provenance: human,
    },
    { value: { kind: "linear_relation", relationId: "relation-1", relationKind: "blocks", sourceIssueId: "plan-1", targetIssueId: "cycle-1" }, provenance: symphony },
    { value: { kind: "linear_attachment", attachmentId: "attachment-1", issueId: "cycle-1", title: "Commit", url: "https://example.test/commit/abc", sourceType: "github", createdAt: observedAt, updatedAt: observedAt }, provenance: symphony },
    { value: { kind: "linear_activity", activityId: "activity-1", issueId: "plan-1", activityKinds: ["archive_changed"], actorKind: "symphony", actorId: "app-1", archived: true, createdAt: observedAt }, provenance: symphony },
  ];
}

function gitFact(): CanonicalFactInput {
  return {
    value: {
      kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo-1",
      branch: "symphony/root-1", headRevision: "abc123", baseRevision: "base123",
      isClean: false, changedPaths: ["src/b.ts", "src/a.ts"],
    },
    provenance: symphony,
  };
}

function source(
  linear: RootStateFactReadResult = { kind: "complete", facts: completeFacts() },
  git: RootStateFactReadResult = { kind: "complete", facts: [gitFact()] },
): RootStateRecoverySourceInterface {
  return {
    async readLinearRootFacts() { return linear; },
    async readGitRootFacts() { return git; },
  };
}

test("recovers active and archived current facts into one frozen canonical Root state", async () => {
  const result = await new RootStateRecoveryImpl(source()).recover("root-1");

  assert.equal(result.kind, "recovered");
  if (result.kind !== "recovered") return;
  assert.ok(Object.isFrozen(result.state));
  assert.ok(Object.isFrozen(result.state.observation));
  assert.match(result.state.contentDigest, /^sha256:[a-f0-9]{64}$/u);
  const archived = result.state.observation.facts.filter(({ value }) => value.kind === "linear_issue" && value.isArchived);
  assert.deepEqual(archived.map(({ identity }) => identity.sourceId), ["cycle-1", "plan-1"]);
  const git = result.state.observation.facts.find(({ value }) => value.kind === "git_worktree");
  assert.equal(git?.value.kind, "git_worktree");
  if (git?.value.kind === "git_worktree") assert.deepEqual(git.value.changedPaths, ["src/a.ts", "src/b.ts"]);
});

test("restart and input permutation reproduce byte-equivalent canonical state and digest", async () => {
  const facts = completeFacts();
  const first = await new RootStateRecoveryImpl(source()).recover("root-1");
  const restarted = await new RootStateRecoveryImpl(source(
    { kind: "complete", facts: [...facts].reverse() },
    { kind: "complete", facts: [gitFact()] },
  )).recover("root-1");

  assert.equal(first.kind, "recovered");
  assert.equal(restarted.kind, "recovered");
  if (first.kind !== "recovered" || restarted.kind !== "recovered") return;
  assert.equal(JSON.stringify(first.state), JSON.stringify(restarted.state));
  assert.equal(first.state.contentDigest, restarted.state.contentDigest);
});

test("incomplete coverage and missing Git authority return closed failures without an old-state fallback", async () => {
  const recovery = new RootStateRecoveryImpl(source());
  assert.equal((await recovery.recover("root-1")).kind, "recovered");

  const incomplete = new RootStateRecoveryImpl(source({
    kind: "incomplete",
    omissions: [{ sourceId: "comments", reason: "page_timeout" }],
  }));
  assert.deepEqual(await incomplete.recover("root-1"), {
    kind: "failed",
    failure: { code: "root_linear_coverage_incomplete", category: "coverage", retryable: true },
  });

  const missingGit = new RootStateRecoveryImpl(source(
    { kind: "complete", facts: completeFacts() },
    { kind: "complete", facts: [] },
  ));
  assert.deepEqual(await missingGit.recover("root-1"), {
    kind: "failed",
    failure: { code: "root_git_authority_missing", category: "git", retryable: false },
  });
  assert.equal("current" in recovery, false);
});

test("invalid parent-kind topology, status coverage and dangling references fail before state publication", async () => {
  const cases: Array<[string, (facts: CanonicalFactInput[]) => void, string]> = [
    ["parent kind", (facts) => {
      const plan = facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === "plan-1");
      assert.ok(plan?.value.kind === "linear_issue");
      plan.value.parentIssueId = "root-1";
      plan.value.depth = 1;
    }, "root_graph_parent_kind_invalid:plan-1"],
    ["status", (facts) => {
      const root = facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === "root-1");
      assert.ok(root?.value.kind === "linear_issue");
      root.value.statusName = "Done";
    }, "root_graph_status_mismatch:root-1"],
    ["reference", (facts) => {
      const comment = facts.find(({ value }) => value.kind === "linear_comment");
      assert.ok(comment?.value.kind === "linear_comment");
      comment.value.issueId = "outside-root";
    }, "root_graph_reference_missing:linear_comment:comment-1:outside-root"],
  ];

  for (const [name, mutate, code] of cases) {
    const facts = structuredClone(completeFacts());
    mutate(facts);
    const result = await new RootStateRecoveryImpl(source({ kind: "complete", facts })).recover("root-1");
    assert.equal(result.kind, "failed", name);
    assert.equal(result.kind === "failed" ? result.failure.code : "", code, name);
  }
});

test("native kind labels, comment threads and relation topology are validated independently of the source adapter", async () => {
  const cases: Array<[(facts: CanonicalFactInput[]) => void, string]> = [
    [(facts) => {
      const plan = facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === "plan-1");
      assert.ok(plan?.value.kind === "linear_issue");
      plan.value.labels = ["symphony:kind/work"];
    }, "root_graph_issue_kind_label_invalid:plan-1"],
    [(facts) => {
      const comment = facts.find(({ value }) => value.kind === "linear_comment");
      assert.ok(comment?.value.kind === "linear_comment");
      comment.value.threadRootCommentId = "comment-other";
      facts.push({
        value: { ...comment.value, commentId: "comment-other", threadRootCommentId: "comment-other" },
        provenance: human,
      });
    }, "root_graph_comment_thread_invalid:comment-1"],
    [(facts) => {
      const relation = facts.find(({ value }) => value.kind === "linear_relation");
      assert.ok(relation?.value.kind === "linear_relation");
      relation.value.targetIssueId = relation.value.sourceIssueId;
    }, "root_graph_relation_self_reference:relation-1"],
  ];

  for (const [mutate, code] of cases) {
    const facts = structuredClone(completeFacts());
    mutate(facts);
    const result = await new RootStateRecoveryImpl(source({ kind: "complete", facts })).recover("root-1");
    assert.equal(result.kind, "failed");
    assert.equal(result.kind === "failed" ? result.failure.code : "", code);
  }
});
