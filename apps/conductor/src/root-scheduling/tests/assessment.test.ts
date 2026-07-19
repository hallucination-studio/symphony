import assert from "node:assert/strict";
import test from "node:test";

import type { V3RootRunView } from "../../root-workflow/api/Models.js";
import { assessRootDispatch } from "../internal/RootDispatchAssessmentPolicy.js";

test("dispatch assessment derives only Root readiness from current facts", () => {
  const view = rootView();
  assert.deepEqual(assessRootDispatch(view), {
    rootIssueId: "root-1",
    readiness: "runnable",
  });
  assert.deepEqual(
    assessRootDispatch({
      ...view,
      workflowNodes: [{
        issueId: "human-1", identifier: "SYM-2", parentIssueId: "root-1",
        siblingOrder: 1, kind: "human", humanKind: "runtime_input",
        state: "In Progress", title: "[Human Action] Choose target",
        description: "Choose.", updatedAt: "2026-07-19T00:00:01Z",
      }],
    }),
    { rootIssueId: "root-1", readiness: "waiting_human" },
  );
  const assessment = assessRootDispatch({
    ...view,
    workflowNodes: [activeWork("work-1"), activeWork("work-2")],
  });
  assert.equal(assessment.readiness, "needs_attention");
  assert.equal("targetIssueId" in assessment, false);
  assert.equal("action" in assessment, false);
  assert.equal(assessRootDispatch({
    ...view,
    workflowNodes: [
      { ...activeWork("group"), state: "Canceled" },
      {
        issueId: "ignored-human", identifier: "SYM-3", parentIssueId: "group",
        siblingOrder: 1, kind: "human", humanKind: "runtime_input",
        state: "In Progress", title: "Ignored", description: "",
        updatedAt: "2026-07-19T00:00:01Z",
      },
    ],
  }).readiness, "runnable");
});

test("dispatch assessment keeps profile problems and retry block deterministic", () => {
  const view = rootView();
  assert.equal(assessRootDispatch({
    ...view,
    profile: { profileId: "profile-1", readiness: "login-required" },
  }).sanitizedReason, "performer_profile_not_ready");
  assert.equal(assessRootDispatch({
    ...view,
    managedComment: {
      ...view.managedComment!,
      retryBlock: {
        expectedPerformerId: "conversation-1",
        failureCode: "provider_conversation_open_failed",
        observedAt: "2026-07-19T00:00:02Z",
      },
    },
  }).sanitizedReason, "root_retry_blocked");
  assert.equal(assessRootDispatch({
    ...view,
    managedComment: {
      ...view.managedComment!,
      retryBlock: {
        expectedPerformerId: "conversation-old",
        failureCode: "provider_conversation_open_failed",
        observedAt: "2026-07-19T00:00:02Z",
      },
    },
  }).sanitizedReason, "root_retry_pointer_conflict");
});

test("dispatch assessment treats terminal and changed facts without workflow actions", () => {
  const view = rootView();
  assert.equal(assessRootDispatch({
    ...view, root: { ...view.root, state: "Done" },
  }).readiness, "terminal");
  assert.equal(assessRootDispatch({
    ...view, root: { ...view.root, state: "In Review" }, workflowNodes: [],
  }).readiness, "terminal");
  assert.deepEqual(assessRootDispatch({
    ...view, attentionProblems: ["facts_changed"],
  }), {
    rootIssueId: "root-1",
    readiness: "needs_attention",
    sanitizedReason: "root_facts_changed",
  });
});

test("dispatch assessment uses complete Tree and blocker facts", () => {
  const view = rootView();
  assert.equal(assessRootDispatch({
    ...view,
    workflowTreeComplete: false,
  }).sanitizedReason, "root_tree_incomplete");
  assert.equal(assessRootDispatch({
    ...view,
    blockerRelations: [{
      sourceIssueId: "root-1",
      targetIssueId: "root-blocker",
      targetState: "In Progress",
    }],
  }).sanitizedReason, "root_blocked");
  assert.equal(assessRootDispatch({
    ...view,
    blockerRelations: [{
      sourceIssueId: "root-1",
      targetIssueId: "root-blocker",
      targetState: "Done",
    }],
  }).readiness, "runnable");
});

function rootView(): V3RootRunView {
  return {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress",
      title: "Root", description: "Build V3", updatedAt: "2026-07-19T00:00:00Z",
    },
    conductorId: "conductor-1",
    resolvedProjectId: "project-1",
    managedComment: {
      conductorId: "conductor-1", performerProfileId: "profile-1",
      performerId: "conversation-1", deliveryBranch: "symphony/runs/sym-1",
    },
    profile: { profileId: "profile-1", readiness: "ready" },
    workflowNodes: [],
    workflowTreeComplete: true,
    blockerRelations: [],
    gitWorkspace: {
      branch: "symphony/runs/sym-1", worktreePath: "/tmp/sym-1",
      head: "0123456789abcdef", status: [],
    },
    attentionProblems: [],
  };
}

function activeWork(issueId: string) {
  return {
    issueId, identifier: issueId, parentIssueId: "root-1", siblingOrder: 1,
    kind: "work" as const, state: "In Progress" as const, title: issueId,
    description: "", updatedAt: "2026-07-19T00:00:01Z", origin: "symphony" as const,
  };
}
