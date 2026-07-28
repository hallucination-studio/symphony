import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runRootRevisionAndCommentCase } from "../../tools/e2e/root-revision-and-comment.mjs";

test("revision Case waits for the initial Plan gate, receipts every frozen input, and ends at the successor Plan Review", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "root_revision_and_comment");
  const calls = [];
  const inputs = {
    description: revisionInput("revision-description", "description"),
    created: revisionInput("revision-comment-create", "comment_body", { commentId: "revision-comment" }),
    edited: revisionInput("revision-comment-edit", "comment_body", { commentId: "revision-comment" }),
    resolved: revisionInput("revision-thread-resolve", "comment_thread_state", {
      commentId: "revision-comment",
      threadRootCommentId: "revision-comment",
      expectedThreadState: "resolved",
      remoteVersion: "2026-07-26T00:00:04.000Z",
    }),
    reopened: revisionInput("revision-thread-reopen", "comment_thread_state", {
      commentId: "revision-comment",
      threadRootCommentId: "revision-comment",
      expectedThreadState: "unresolved",
      remoteVersion: "2026-07-26T00:00:05.000Z",
    }),
  };
  const human = {
    actorId: "human-1",
    async waitForPlanApprovalGate(input) {
      calls.push({ kind: "wait_for_initial_plan", input });
      return {
        cycleIssueId: "initial-cycle",
        planIssueId: "initial-plan",
        planRemoteVersion: "2026-07-26T00:00:01.000Z",
        requestCommentId: "initial-review",
      };
    },
    async updateRootDescription(input) {
      calls.push({ kind: "update_description", input });
      return inputs.description;
    },
    async waitForRootDescriptionReceipt(input) {
      assert.equal(input.inputReference, inputs.description);
      calls.push({ kind: "wait_for_description_receipt", input });
    },
    async createComment(input) {
      calls.push({ kind: "create_comment", input });
      return { commentId: "revision-comment", issueId: input.issueId, inputReference: inputs.created };
    },
    async waitForCommentReceipt(input) {
      assert.ok([inputs.created, inputs.edited].includes(input.inputReference));
      calls.push({ kind: "wait_for_comment_receipt", input });
    },
    async editComment(input) {
      calls.push({ kind: "edit_comment", input });
      return { commentId: input.commentId, issueId: input.issueId, inputReference: inputs.edited };
    },
    async resolveCommentThread(input) {
      calls.push({ kind: "resolve_thread", input });
      return inputs.resolved;
    },
    async reopenCommentThread(input) {
      calls.push({ kind: "reopen_thread", input });
      return inputs.reopened;
    },
    async waitForCommentThreadReceipt(input) {
      assert.ok([inputs.resolved, inputs.reopened].includes(input.inputReference));
      calls.push({ kind: "wait_for_thread_receipt", input });
    },
    async waitForSuccessorPlanApprovalGate(input) {
      calls.push({ kind: "wait_for_successor_plan", input });
      return {
        cycleIssueId: "successor-cycle",
        planIssueId: "successor-plan",
        planRemoteVersion: "2026-07-26T00:00:06.000Z",
        requestCommentId: "successor-review",
      };
    },
  };

  const result = await runRootRevisionAndCommentCase({
    definition,
    human,
    rootCreation: {
      teamId: "team-1",
      projectId: "project-1",
      routingLabelId: "route-label",
      rootStatusId: "todo-state",
      rootIssueId: "root-1",
      identifier: "ENG-1",
    },
  });

  assert.deepEqual(calls, [
    { kind: "wait_for_initial_plan", input: { rootIssueId: "root-1" } },
    { kind: "update_description", input: { rootIssueId: "root-1", description: "Replace the uppercase helper with a lowercase identifier helper and focused tests." } },
    { kind: "wait_for_description_receipt", input: { rootIssueId: "root-1", inputReference: revisionInput("revision-description", "description") } },
    { kind: "create_comment", input: { issueId: "root-1", body: "The original helper name no longer matches the requirement." } },
    { kind: "wait_for_comment_receipt", input: { issueId: "root-1", inputReference: revisionInput("revision-comment-create", "comment_body", { commentId: "revision-comment" }) } },
    { kind: "edit_comment", input: { issueId: "root-1", commentId: "revision-comment", body: "The original helper name no longer matches the revised requirement." } },
    { kind: "wait_for_comment_receipt", input: { issueId: "root-1", inputReference: revisionInput("revision-comment-edit", "comment_body", { commentId: "revision-comment" }) } },
    { kind: "resolve_thread", input: { issueId: "root-1", threadRootCommentId: "revision-comment" } },
    { kind: "wait_for_thread_receipt", input: { issueId: "root-1", inputReference: revisionInput("revision-thread-resolve", "comment_thread_state", { commentId: "revision-comment", threadRootCommentId: "revision-comment", expectedThreadState: "resolved", remoteVersion: "2026-07-26T00:00:04.000Z" }) } },
    { kind: "reopen_thread", input: { issueId: "root-1", threadRootCommentId: "revision-comment" } },
    { kind: "wait_for_thread_receipt", input: { issueId: "root-1", inputReference: revisionInput("revision-thread-reopen", "comment_thread_state", { commentId: "revision-comment", threadRootCommentId: "revision-comment", expectedThreadState: "unresolved", remoteVersion: "2026-07-26T00:00:05.000Z" }) } },
    { kind: "wait_for_successor_plan", input: { rootIssueId: "root-1", priorCycleIssueId: "initial-cycle", priorRequestCommentId: "initial-review" } },
  ]);
  assert.deepEqual(result, {
    context: {
      humanActorId: "human-1",
      rootIssueIdsByKey: { "revision-root": "root-1" },
      initialPlan: {
        cycleIssueId: "initial-cycle",
        planIssueId: "initial-plan",
        planRemoteVersion: "2026-07-26T00:00:01.000Z",
        requestCommentId: "initial-review",
      },
      successorPlan: {
        cycleIssueId: "successor-cycle",
        planIssueId: "successor-plan",
        planRemoteVersion: "2026-07-26T00:00:06.000Z",
        requestCommentId: "successor-review",
      },
      inputReferences: [
        revisionInput("revision-description", "description"),
        revisionInput("revision-comment-create", "comment_body", { commentId: "revision-comment", binding: "revision_comment" }),
        revisionInput("revision-comment-edit", "comment_body", { commentId: "revision-comment" }),
        revisionInput("revision-thread-resolve", "comment_thread_state", { commentId: "revision-comment", threadRootCommentId: "revision-comment", expectedThreadState: "resolved", remoteVersion: "2026-07-26T00:00:04.000Z" }),
        revisionInput("revision-thread-reopen", "comment_thread_state", { commentId: "revision-comment", threadRootCommentId: "revision-comment", expectedThreadState: "unresolved", remoteVersion: "2026-07-26T00:00:05.000Z" }),
      ],
    },
  });
});

test("revision Case rejects noncanonical definitions and a Human boundary without the fixed receipt operations", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "root_revision_and_comment");
  const human = {
    actorId: "human-1",
    async waitForPlanApprovalGate() { return planGate("cycle-1", "plan-1", "review-1", "2026-07-26T00:00:01.000Z"); },
    async updateRootDescription() { return revisionInput("description", "description"); },
    async waitForRootDescriptionReceipt() {},
    async createComment() { return { commentId: "comment-1", issueId: "root-1", inputReference: revisionInput("create", "comment_body", { commentId: "comment-1" }) }; },
    async waitForCommentReceipt() {},
    async editComment() { return { commentId: "comment-1", issueId: "root-1", inputReference: revisionInput("edit", "comment_body", { commentId: "comment-1" }) }; },
    async resolveCommentThread() { return revisionInput("resolve", "comment_thread_state", { commentId: "comment-1", threadRootCommentId: "comment-1", expectedThreadState: "resolved", remoteVersion: "2026-07-26T00:00:04.000Z" }); },
    async reopenCommentThread() { return revisionInput("reopen", "comment_thread_state", { commentId: "comment-1", threadRootCommentId: "comment-1", expectedThreadState: "unresolved", remoteVersion: "2026-07-26T00:00:05.000Z" }); },
    async waitForCommentThreadReceipt() {},
    async waitForSuccessorPlanApprovalGate() { return planGate("cycle-2", "plan-2", "review-2", "2026-07-26T00:00:06.000Z"); },
  };

  const rootCreation = admittedRootCreation();
  await assert.rejects(
    runRootRevisionAndCommentCase({ definition: { ...definition, caseId: "approved_happy_path" }, human, rootCreation }),
    hasCode("foreground_e2e_revision_case_definition_invalid"),
  );
  await assert.rejects(
    runRootRevisionAndCommentCase({ definition, human: { ...human, waitForCommentThreadReceipt: undefined }, rootCreation }),
    hasCode("foreground_e2e_revision_case_input_invalid"),
  );
});

test("revision Case forwards cancellation to every Linear Human operation", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "root_revision_and_comment");
  const abortController = new AbortController();
  const waits = [];
  const commentId = "comment-1";
  const description = revisionInput("description", "description");
  const created = revisionInput("created", "comment_body", { commentId });
  const edited = revisionInput("edited", "comment_body", { commentId });
  const resolved = revisionInput("resolved", "comment_thread_state", { commentId, threadRootCommentId: commentId, expectedThreadState: "resolved", remoteVersion: "2026-07-26T00:00:04.000Z" });
  const reopened = revisionInput("reopened", "comment_thread_state", { commentId, threadRootCommentId: commentId, expectedThreadState: "unresolved", remoteVersion: "2026-07-26T00:00:05.000Z" });
  const human = {
    actorId: "human-1",
    async waitForPlanApprovalGate(input) { waits.push(input); return planGate("cycle-1", "plan-1", "review-1", "2026-07-26T00:00:01.000Z"); },
    async updateRootDescription() { return description; },
    async waitForRootDescriptionReceipt(input) { waits.push(input); },
    async createComment() { return { commentId, issueId: "root-1", inputReference: created }; },
    async waitForCommentReceipt(input) { waits.push(input); },
    async editComment() { return { commentId, issueId: "root-1", inputReference: edited }; },
    async resolveCommentThread() { return resolved; },
    async reopenCommentThread() { return reopened; },
    async waitForCommentThreadReceipt(input) { waits.push(input); },
    async waitForSuccessorPlanApprovalGate(input) { waits.push(input); return planGate("cycle-2", "plan-2", "review-2", "2026-07-26T00:00:06.000Z"); },
  };

  await runRootRevisionAndCommentCase({
    definition,
    human,
    signal: abortController.signal,
    rootCreation: admittedRootCreation(),
  });

  assert.equal(waits.length, 7);
  assert.ok(waits.every(({ signal }) => signal === abortController.signal));
});

function planGate(cycleIssueId, planIssueId, requestCommentId, planRemoteVersion) {
  return { cycleIssueId, planIssueId, requestCommentId, planRemoteVersion };
}

function admittedRootCreation() {
  return {
    teamId: "team-1",
    projectId: "project-1",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
    rootIssueId: "root-1",
    identifier: "ENG-1",
  };
}

function revisionInput(sourceId, kind, extra = {}) {
  return { sourceId, kind, ...extra };
}

function hasCode(code) {
  return (error) => error?.code === code;
}
