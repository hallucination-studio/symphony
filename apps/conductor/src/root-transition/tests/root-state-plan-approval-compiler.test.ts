import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import { RootStatePlanApprovalCompilerImpl } from "../internal/RootStatePlanApprovalCompilerImpl.js";
import { RootStateViewPolicyImpl } from "../internal/RootStateViewPolicyImpl.js";

const observedAt = "2026-07-29T00:00:00.000Z";
const planDescription = "# Plan Result\n\nApproved content";
const replyBody = "I approve this plan.";

function fact(value: CanonicalFactValue, actorKind: "human" | "symphony" = "symphony"): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "linear_issue" ? value.issueId
      : value.kind === "linear_comment" ? value.commentId
        : value.kind === "git_worktree" ? value.rootIssueId
          : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind, observedAt } };
}

function issue(
  issueId: string, identifier: string, issueKind: "root" | "cycle" | "plan",
  parentIssueId: string | undefined, statusId: string, statusName: string, description: string,
): CanonicalFact {
  return fact({
    kind: "linear_issue", issueId, identifier, projectId: "project-1", ...(parentIssueId ? { parentIssueId } : {}),
    ...(issueKind === "root" ? { creatorUserId: "user-1", assigneeUserId: "user-1" } : {}),
    statusId, statusName, statusCategory: "started", statusPosition: 1, order: 0,
    depth: parentIssueId ? (issueKind === "cycle" ? 1 : 2) : 0, title: issueKind === "plan" ? "Plan" : issueKind,
    description, labels: [`symphony:kind/${issueKind}`], isArchived: false, issueKind,
    createdAt: observedAt, updatedAt: observedAt,
  });
}

function comment(
  commentId: string, body: string, authorKind: "human" | "symphony", parentCommentId?: string,
): CanonicalFact {
  return fact({
    kind: "linear_comment", commentId, issueId: "root-1", body, authorKind,
    authorId: authorKind === "human" ? "user-1" : "symphony",
    ...(authorKind === "human" ? { authorUserId: "user-1" } : {}),
    ...(parentCommentId ? { parentCommentId } : {}), threadRootCommentId: "approval-request",
    threadState: "unresolved", reactions: [], createdAt: observedAt, updatedAt: observedAt,
  }, authorKind);
}

function state(): RecoveredRootState {
  return {
    rootIssueId: "root-1", contentDigest: "sha256:approval-root",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "planning", name: "Planning", category: "started", position: 1 }),
      fact({ kind: "linear_status", statusId: "in-review", name: "In Review", category: "started", position: 2 }),
      fact({ kind: "linear_status", statusId: "approved", name: "Approved", category: "started", position: 3 }),
      issue("root-1", "SYM-1", "root", undefined, "root-progress", "In Progress", "Requirement"),
      issue("cycle-1", "SYM-2", "cycle", "root-1", "planning", "Planning", "Planning"),
      issue("plan-1", "SYM-3", "plan", "cycle-1", "in-review", "In Review", planDescription),
      comment("approval-request", "## 需要你审批\n\n### 相关对象\n- SYM-3", "symphony"),
      comment("approval-reply", replyBody, "human", "approval-request"),
      fact({
        kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo", branch: "root-1",
        headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [],
      }),
    ] },
  };
}

function input() {
  const inputId = "input-approval-reply";
  return {
    state: state(),
    intent: {
      semanticGate: "plan_human_decision" as const,
      rootIssueId: "root-1",
      basedOnRootDigest: "sha256:approval-root",
      pendingInputRefs: [{
        sourceKind: "comment_body" as const, inputId, nativeSourceIdentity: "approval-reply",
        sourceVersionOrDigest: digest(replyBody),
      }],
      consumedInputIds: [inputId],
      commentDispositions: [{
        kind: "applied" as const, sourceInputId: inputId,
        source: { kind: "comment_body" as const, commentId: "approval-reply", commentBodyDigest: digest(replyBody) },
      }],
      subject: {
        planIssueId: "plan-1", planContentDigest: digest(planDescription),
        approvalThreadRootCommentId: "approval-request", decisionReplyCommentId: "approval-reply",
        decisionReplyBodyDigest: digest(replyBody), actorId: "user-1", actorAuthorization: "authorized" as const,
      },
      intent: { kind: "approve_plan" as const },
    },
  };
}

function compiler() {
  return new RootStatePlanApprovalCompilerImpl(new RootStateViewPolicyImpl());
}

test("compiles exact Plan approval to one complete desired Plan state", () => {
  assert.deepEqual(compiler().compile(input()), {
    kind: "effect",
    effect: {
      kind: "update_issue", issueId: "plan-1", statusId: "approved", title: "Plan",
      description: planDescription, labelNames: ["symphony:kind/plan"], order: 0,
    },
  });
});

test("recognizes the exact durable Approved barrier after read-back", () => {
  const current = input();
  Object.assign(issueValue(current.state, "plan-1"), { statusId: "approved", statusName: "Approved" });
  current.state.contentDigest = "sha256:post-approval";
  assert.deepEqual(compiler().compile(current), { kind: "satisfied" });
});

test("rejects stale Root and Plan subjects", () => {
  const staleRoot = input();
  staleRoot.intent.basedOnRootDigest = "sha256:stale";
  assert.deepEqual(compiler().compile(staleRoot), { kind: "invalid_intent", reason: "subject_stale" });

  const stalePlan = input();
  issueValue(stalePlan.state, "plan-1").description = "Edited Plan";
  assert.deepEqual(compiler().compile(stalePlan), { kind: "invalid_intent", reason: "subject_stale" });
});

test("rejects unauthorized or non-current approval comments", () => {
  const unauthorized = input();
  Object.assign(commentValue(unauthorized.state, "approval-reply"), { authorId: "user-2", authorUserId: "user-2" });
  assert.deepEqual(compiler().compile(unauthorized), { kind: "invalid_intent", reason: "authorization_invalid" });

  const staleProvenance = input();
  const reply = staleProvenance.state.observation.facts.find(({ value }) =>
    value.kind === "linear_comment" && value.commentId === "approval-reply");
  assert.ok(reply);
  reply.provenance.actorKind = "unknown";
  assert.deepEqual(compiler().compile(staleProvenance), { kind: "invalid_intent", reason: "authorization_invalid" });
});

test("rejects topology, input disposition and status ambiguity", () => {
  const topology = input();
  issueValue(topology.state, "cycle-1").statusName = "Executing";
  assert.deepEqual(compiler().compile(topology), { kind: "invalid_intent", reason: "topology_invalid" });

  const disposition = input();
  disposition.intent.consumedInputIds = [];
  assert.deepEqual(compiler().compile(disposition), { kind: "invalid_intent", reason: "input_disposition_invalid" });

  const duplicateDisposition = input();
  duplicateDisposition.intent.pendingInputRefs.push({
    ...duplicateDisposition.intent.pendingInputRefs[0]!, inputId: "input-approval-reply-2",
  });
  duplicateDisposition.intent.consumedInputIds.push("input-approval-reply-2");
  duplicateDisposition.intent.commentDispositions.push({ ...duplicateDisposition.intent.commentDispositions[0]! });
  assert.deepEqual(compiler().compile(duplicateDisposition), {
    kind: "invalid_intent", reason: "input_disposition_invalid",
  });

  const ambiguous = input();
  ambiguous.state.observation.facts = [...ambiguous.state.observation.facts, fact({
    kind: "linear_status", statusId: "approved-2", name: "Approved", category: "started", position: 4,
  })];
  assert.deepEqual(compiler().compile(ambiguous), { kind: "invalid_intent", reason: "status_catalog_invalid" });
});

test("requires the exact Plan identifier in the approval request scope", () => {
  const current = input();
  commentValue(current.state, "approval-request").body = "## 需要你审批\n\n### 相关对象\n- SYM-30";
  assert.deepEqual(compiler().compile(current), { kind: "invalid_intent", reason: "authorization_invalid" });
});

function issueValue(current: RecoveredRootState, issueId: string) {
  const found = current.observation.facts.find(({ value }) => value.kind === "linear_issue" && value.issueId === issueId);
  assert.ok(found?.value.kind === "linear_issue");
  return found.value;
}

function commentValue(current: RecoveredRootState, commentId: string) {
  const found = current.observation.facts.find(({ value }) => value.kind === "linear_comment" && value.commentId === commentId);
  assert.ok(found?.value.kind === "linear_comment");
  return found.value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
