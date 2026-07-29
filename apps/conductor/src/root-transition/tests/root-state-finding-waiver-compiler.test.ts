import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStateFindingWaiverCompilerImpl } from "../internal/RootStateFindingWaiverCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:04:00.000Z";

function fact(value: CanonicalFactValue, actorKind: "human" | "symphony" = "symphony"): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "git_worktree" ? value.rootIssueId
      : value.kind === "linear_issue" ? value.issueId
        : value.kind === "linear_comment" ? value.commentId
          : value.kind === "linear_relation" ? value.relationId
            : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind, observedAt } };
}

function state(): RecoveredRootState {
  const issue = (
    issueId: string, identifier: string, issueKind: "root" | "cycle" | "plan" | "work" | "verify" | "finding",
    parentIssueId: string | undefined, statusName: string, labels: readonly string[] = [`symphony:kind/${issueKind}`],
  ): CanonicalFact => fact({
    kind: "linear_issue", issueId, identifier, projectId: "project",
    ...(parentIssueId === undefined ? { creatorUserId: "human" } : { parentIssueId }),
    statusId: statusName.toLowerCase().replaceAll(" ", "-"), statusName,
    statusCategory: statusName === "Done" ? "completed" : statusName === "Todo" ? "unstarted" : "started",
    statusPosition: 1, order: 0, depth: parentIssueId ? (issueKind === "cycle" ? 1 : 2) : 0,
    title: issueKind, description: issueKind === "verify" ? "# Verify Result\n\nVerify Changes Required." : issueKind,
    labels, isArchived: false, issueKind, createdAt: "2026-07-29T00:00:00.000Z", updatedAt: observedAt,
  });
  const requestBody = [
    "## 需要你确认 Finding 豁免", "", "### 相关对象", "- FIND-A", "- FIND-B", "",
    "### Verify 与 Cycle", "- VERIFY-1", "- CYCLE-1",
  ].join("\n");
  const comment = (
    commentId: string, authorKind: "human" | "symphony", authorId: string, body: string,
    parentCommentId?: string,
  ): CanonicalFact => fact({
    kind: "linear_comment", commentId, issueId: "root", body, authorKind, authorId,
    ...(authorKind === "human" ? { authorUserId: authorId } : {}),
    ...(parentCommentId === undefined ? {} : { parentCommentId }),
    threadRootCommentId: "waiver-request", threadState: "unresolved", reactions: [],
    createdAt: commentId === "waiver-request" ? "2026-07-29T00:01:00.000Z" :
      commentId === "waiver-reply" ? "2026-07-29T00:02:00.000Z" : "2026-07-29T00:03:00.000Z",
    updatedAt: commentId === "waiver-request" ? "2026-07-29T00:01:00.000Z" :
      commentId === "waiver-reply" ? "2026-07-29T00:02:00.000Z" : "2026-07-29T00:03:00.000Z",
  }, authorKind);
  return {
    rootIssueId: "root", contentDigest: "sha256:waiver",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "canceled", name: "Canceled", category: "canceled", position: 5 }),
      issue("root", "ROOT", "root", undefined, "Needs Approval"),
      issue("cycle", "CYCLE-1", "cycle", "root", "Verifying"),
      issue("plan", "PLAN-1", "plan", "cycle", "Done"),
      issue("work", "WORK-1", "work", "cycle", "Done"),
      issue("verify", "VERIFY-1", "verify", "cycle", "Done", ["Changes Required", "symphony:kind/verify"]),
      issue("finding-a", "FIND-A", "finding", "cycle", "Todo", ["Finding", "symphony:kind/finding"]),
      issue("finding-b", "FIND-B", "finding", "cycle", "In Progress", ["Finding", "symphony:kind/finding"]),
      comment("waiver-request", "symphony", "symphony", requestBody),
      comment("waiver-reply", "human", "human", "Waive both.", "waiver-request"),
      comment("waiver-adoption", "symphony", "symphony", "## 已应用\n\nThe complete unchanged Finding set is approved for waiver.", "waiver-reply"),
      fact({ kind: "linear_relation", relationId: "a-v", relationKind: "relates_to", sourceIssueId: "finding-a", targetIssueId: "verify" }),
      fact({ kind: "linear_relation", relationId: "b-v", relationKind: "relates_to", sourceIssueId: "finding-b", targetIssueId: "verify" }),
      fact({ kind: "git_worktree", rootIssueId: "root", repositoryId: "repo", branch: "root", headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [] }),
    ] },
  };
}

const input = {
  cycleIssueId: "cycle", requestCommentId: "waiver-request", humanReplyCommentId: "waiver-reply",
  adoptionCommentId: "waiver-adoption", findingIssueIds: ["finding-a", "finding-b"],
};

function compiler() {
  return new RootStateFindingWaiverCompilerImpl(new RootStateViewPolicyImpl());
}

test("converges one Finding, receipt and thread effect at a time", () => {
  const current = state();
  assert.deepEqual(compiler().compile({ state: current, ...input }), {
    kind: "effect", effect: { kind: "set_issue_status", issueId: "finding-a", statusId: "canceled" },
  });
  cancel(current, "finding-a");
  assert.deepEqual(compiler().compile({ state: current, ...input }), {
    kind: "effect", effect: { kind: "set_issue_status", issueId: "finding-b", statusId: "canceled" },
  });
  cancel(current, "finding-b");
  assert.deepEqual(compiler().compile({ state: current, ...input }), {
    kind: "effect", effect: { kind: "set_comment_receipt", commentId: "waiver-reply", threadRootCommentId: "waiver-request", receipt: "check" },
  });
  const reply = comment(current, "waiver-reply");
  reply.reactions = [{ reactionId: "receipt", emoji: "\u2705", actorKind: "symphony", actorId: "symphony" }];
  assert.deepEqual(compiler().compile({ state: current, ...input }), {
    kind: "effect", effect: { kind: "set_comment_thread_state", commentId: "waiver-reply", threadRootCommentId: "waiver-request", threadState: "resolved" },
  });
  for (const id of ["waiver-request", "waiver-reply", "waiver-adoption"]) comment(current, id).threadState = "resolved";
  assert.deepEqual(compiler().compile({ state: current, ...input }), { kind: "satisfied" });
});

test("rejects scope drift, unauthorized human and missing adoption", () => {
  const drift = state();
  comment(drift, "waiver-request").body = comment(drift, "waiver-request").body.replace("- FIND-B", "- FIND-X");
  assert.equal(compiler().compile({ state: drift, ...input }).kind, "invalid_facts");

  const unauthorized = state();
  Object.assign(comment(unauthorized, "waiver-reply"), { authorId: "other", authorUserId: "other" });
  assert.equal(compiler().compile({ state: unauthorized, ...input }).kind, "invalid_facts");

  const missing = state();
  missing.observation.facts = missing.observation.facts.filter(({ value }) => value.kind !== "linear_comment" || value.commentId !== "waiver-adoption");
  assert.equal(compiler().compile({ state: missing, ...input }).kind, "invalid_facts");
});

test("rejects an extra open Finding and invalid Finding relation direction", () => {
  const extra = state();
  const finding = issueFact(extra, "finding-a");
  extra.observation.facts = [...extra.observation.facts, fact({ ...finding, issueId: "finding-extra", identifier: "FIND-X" })];
  assert.equal(compiler().compile({ state: extra, ...input }).kind, "invalid_facts");

  const invalidRelation = state();
  const relation = invalidRelation.observation.facts.find(({ value }) => value.kind === "linear_relation");
  assert.ok(relation?.value.kind === "linear_relation");
  [relation.value.sourceIssueId, relation.value.targetIssueId] = [relation.value.targetIssueId, relation.value.sourceIssueId];
  assert.equal(compiler().compile({ state: invalidRelation, ...input }).kind, "invalid_facts");
});

test("uses canonical target ID order and rejects conflicting receipts", () => {
  const current = state();
  assert.deepEqual(compiler().compile({ state: current, ...input, findingIssueIds: ["finding-b", "finding-a"] }), {
    kind: "effect", effect: { kind: "set_issue_status", issueId: "finding-a", statusId: "canceled" },
  });

  cancel(current, "finding-a");
  cancel(current, "finding-b");
  comment(current, "waiver-reply").reactions = [
    { reactionId: "cross", emoji: "❌", actorKind: "symphony", actorId: "symphony" },
  ];
  assert.equal(compiler().compile({ state: current, ...input }).kind, "invalid_facts");
});

test("rejects stale comment provenance and duplicate Finding relations", () => {
  const provenance = state();
  const reply = provenance.observation.facts.find(({ value }) =>
    value.kind === "linear_comment" && value.commentId === "waiver-reply");
  assert.ok(reply);
  reply.provenance.actorKind = "unknown";
  assert.equal(compiler().compile({ state: provenance, ...input }).kind, "invalid_facts");

  const duplicate = state();
  duplicate.observation.facts = [...duplicate.observation.facts, fact({
    kind: "linear_relation", relationId: "a-v-duplicate", relationKind: "relates_to",
    sourceIssueId: "finding-a", targetIssueId: "verify",
  })];
  assert.equal(compiler().compile({ state: duplicate, ...input }).kind, "invalid_facts");
});

test("requires current Symphony status proof for canceled Findings with unknown provenance", () => {
  const current = state();
  cancel(current, "finding-a");
  const finding = current.observation.facts.find(({ value }) =>
    value.kind === "linear_issue" && value.issueId === "finding-a");
  assert.ok(finding?.value.kind === "linear_issue");
  finding.value.creatorUserId = "symphony";
  finding.provenance.actorKind = "unknown";
  assert.equal(compiler().compile({ state: current, ...input }).kind, "invalid_facts");

  current.observation.facts = [...current.observation.facts, fact({
    kind: "linear_activity", activityId: "finding-a-canceled", issueId: "finding-a",
    activityKinds: ["status_changed"], actorKind: "symphony", actorId: "symphony",
    toStateId: "canceled", createdAt: observedAt,
  })];
  assert.deepEqual(compiler().compile({ state: current, ...input }), {
    kind: "effect", effect: { kind: "set_issue_status", issueId: "finding-b", statusId: "canceled" },
  });
});

function issueFact(current: RecoveredRootState, issueId: string) {
  const found = current.observation.facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === issueId);
  assert.ok(found?.value.kind === "linear_issue");
  return found.value;
}

function comment(current: RecoveredRootState, commentId: string) {
  const found = current.observation.facts.find(({ value }) => value.kind === "linear_comment" && value.commentId === commentId);
  assert.ok(found?.value.kind === "linear_comment");
  return found.value;
}

function cancel(current: RecoveredRootState, issueId: string): void {
  Object.assign(issueFact(current, issueId), { statusId: "canceled", statusName: "Canceled", statusCategory: "canceled" });
}
