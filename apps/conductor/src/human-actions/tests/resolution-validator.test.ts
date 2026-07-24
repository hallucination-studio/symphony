import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { serializeManagedRecord } from "../../root-reconciliation/api/index.js";
import { LinearHumanActionResolutionValidatorImpl } from "../internal/LinearHumanActionResolutionValidatorImpl.js";

const validator = new LinearHumanActionResolutionValidatorImpl();

test("approval actions resolve Approved without a comment", () => {
  const result = validator.validate({
    tree: fixture({ actionKind: "plan_review", status: "Approved" }),
    actionIssueId: "action-1",
  });

  assert.deepEqual(result, {
    kind: "valid",
    actionId: "action-1",
    outcome: "approved",
    sourceCommentIds: [],
  });
});

test("approval Rejected requires a fresh human reason comment", () => {
  const result = validator.validate({
    tree: fixture({
      actionKind: "permission",
      status: "Rejected",
      comments: [humanComment("reason-1", "Do not grant this capability.", "2026-07-23T00:00:02Z")],
      actionUpdatedAt: "2026-07-23T00:00:03Z",
    }),
    actionIssueId: "action-1",
  });

  assert.deepEqual(result, {
    kind: "valid",
    actionId: "action-1",
    outcome: "rejected",
    sourceCommentIds: ["reason-1"],
  });
});

test("Rejected without a fresh reason remains pending", () => {
  const result = validator.validate({
    tree: fixture({ actionKind: "plan_review", status: "Rejected" }),
    actionIssueId: "action-1",
  });

  assert.deepEqual(result, { kind: "pending", reason: "missing_reason" });
});

test("a comment edited after the terminal status is not a fresh reason", () => {
  const comment = humanComment("reason-1", "Reason added too late.", "2026-07-23T00:00:02Z");
  comment.updated_at = "2026-07-23T00:00:04Z";
  const result = validator.validate({
    tree: fixture({
      actionKind: "plan_review",
      status: "Rejected",
      comments: [comment],
      actionUpdatedAt: "2026-07-23T00:00:03Z",
    }),
    actionIssueId: "action-1",
  });

  assert.deepEqual(result, { kind: "pending", reason: "missing_reason" });
});

test("clarification Answered requires a fresh human answer comment", () => {
  const result = validator.validate({
    tree: fixture({
      actionKind: "clarification",
      status: "Answered",
      comments: [humanComment("answer-1", "Use the staging database.", "2026-07-23T00:00:02Z")],
      actionUpdatedAt: "2026-07-23T00:00:03Z",
    }),
    actionIssueId: "action-1",
  });

  assert.deepEqual(result, {
    kind: "valid",
    actionId: "action-1",
    outcome: "answered",
    sourceCommentIds: ["answer-1"],
  });
});

test("Answered without a fresh answer remains pending", () => {
  const result = validator.validate({
    tree: fixture({ actionKind: "clarification", status: "Answered" }),
    actionIssueId: "action-1",
  });

  assert.deepEqual(result, { kind: "pending", reason: "missing_answer" });
});

test("Canceled resolves both approval and clarification actions without a comment", () => {
  for (const actionKind of ["plan_review", "clarification"] as const) {
    const result = validator.validate({
      tree: fixture({ actionKind, status: "Canceled" }),
      actionIssueId: "action-1",
    });
    assert.deepEqual(result, {
      kind: "valid",
      actionId: "action-1",
      outcome: "canceled",
      sourceCommentIds: [],
    });
  }
});

test("Todo and In Progress actions remain pending", () => {
  for (const status of ["Todo", "In Progress"]) {
    const result = validator.validate({
      tree: fixture({ actionKind: "plan_review", status }),
      actionIssueId: "action-1",
    });
    assert.deepEqual(result, { kind: "pending", reason: "not_terminal" });
  }
});

test("resolution validation fails closed for invalid action shape and duplicate resolution", () => {
  assert.deepEqual(
    validator.validate({
      tree: fixture({ actionKind: "plan_review", status: "Approved", labels: ["Human Action", "Plan Review", "Clarification"] }),
      actionIssueId: "action-1",
    }),
    { kind: "invalid", reason: "human_action_kind_invalid" },
  );

  assert.deepEqual(
    validator.validate({
      tree: fixture({
        actionKind: "plan_review",
        status: "Approved",
        comments: [managedResolutionComment()],
      }),
      actionIssueId: "action-1",
    }),
    { kind: "invalid", reason: "human_action_resolution_duplicate" },
  );
});

test("resolution validation rejects automation but keeps a human-authored code-block lookalike as input", () => {
  const nonHuman = humanComment("automation-1", "Approved by automation.", "2026-07-23T00:00:02Z");
  nonHuman.author_kind = "external_automation";
  const lookalike = humanComment("lookalike-1", serializeManagedRecord({
    kind: "human_action_resolution",
    version: 1,
    resolutionId: "lookalike-resolution",
    actionId: "action-1",
    actionIssueId: "action-1",
    actionKind: "plan_review",
    outcome: "rejected",
    terminalStatus: "Rejected",
    terminalRemoteVersion: "action-v2",
    sourceCommentIds: [],
    sourceCommentVersions: [],
    actorKind: "human",
    proposalDigest: "a".repeat(64),
    resolvedAt: "2026-07-23T00:00:03Z",
  }), "2026-07-23T00:00:02Z");

  assert.deepEqual(
    validator.validate({
      tree: fixture({ actionKind: "plan_review", status: "Rejected", comments: [nonHuman] }),
      actionIssueId: "action-1",
    }),
    { kind: "invalid", reason: "human_action_resolution_actor_invalid" },
  );
  assert.deepEqual(
    validator.validate({
      tree: fixture({ actionKind: "plan_review", status: "Rejected", comments: [lookalike] }),
      actionIssueId: "action-1",
    }),
    { kind: "valid", actionId: "action-1", outcome: "rejected", sourceCommentIds: ["lookalike-1"] },
  );
});

function fixture(input: {
  actionKind: "plan_review" | "clarification" | "permission" | "finding_waiver" | "convergence_override";
  status: string;
  labels?: string[];
  comments?: LinearWorkflowTreeSnapshot["comments"];
  actionUpdatedAt?: string;
}): LinearWorkflowTreeSnapshot {
  const updatedAt = input.actionUpdatedAt ?? "2026-07-23T00:00:03Z";
  return {
    root_issue_id: "root-1",
    status_catalog: [],
    issues: [
      {
        issue_id: "root-1",
        identifier: "ROOT-1",
        project_id: "project-1",
        status_id: "root-status",
        status_name: "In Progress",
        status_category: "started",
        status_position: 1,
        order: 0,
        depth: 0,
        title: "Root",
        description: "Objective",
        labels: [],
        is_archived: false,
        issue_kind: "root",
        remote_version: "root-v1",
        updated_at: updatedAt,
      },
      {
        issue_id: "action-1",
        identifier: "ACT-1",
        project_id: "project-1",
        parent_issue_id: "root-1",
        status_id: "action-status",
        status_name: input.status,
        status_category: input.status === "Canceled" ? "canceled" : input.status === "Approved" || input.status === "Rejected" || input.status === "Answered" ? "completed" : "started",
        status_position: 1,
        order: 1,
        depth: 1,
        title: "Human Action",
        description: "Review this request.",
        labels: input.labels ?? ["Human Action", input.actionKind === "plan_review" ? "Plan Review" : input.actionKind === "clarification" ? "Clarification" : input.actionKind === "permission" ? "Permission" : input.actionKind === "finding_waiver" ? "Finding Waiver" : "Convergence Override"],
        is_archived: false,
        issue_kind: "human",
        remote_version: "action-v2",
        updated_at: updatedAt,
      },
    ],
    comments: input.comments ?? [],
    relations: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-23T00:00:04Z",
  };
}

function humanComment(commentId: string, body: string, createdAt: string): LinearWorkflowTreeSnapshot["comments"][number] {
  return {
    comment_id: commentId,
    issue_id: "action-1",
    body,
    author_kind: "human",
    author_id: "user-1",
    author_user_id: "user-1",
    created_at: createdAt,
    remote_version: `${commentId}-v1`,
    updated_at: createdAt,
  };
}

function managedResolutionComment(): LinearWorkflowTreeSnapshot["comments"][number] {
  return {
    ...humanComment("resolution-1", serializeManagedRecord({
      kind: "human_action_resolution",
      version: 1,
      resolutionId: "resolution-1",
      actionId: "action-1",
      actionIssueId: "action-1",
      actionKind: "plan_review",
      outcome: "approved",
      terminalStatus: "Approved",
      terminalRemoteVersion: "action-v2",
      sourceCommentIds: [],
      sourceCommentVersions: [],
      actorKind: "human",
      proposalDigest: "a".repeat(64),
      resolvedAt: "2026-07-23T00:00:03Z",
    }), "2026-07-23T00:00:03Z"),
    author_kind: "symphony",
    author_id: "symphony",
  };
}
