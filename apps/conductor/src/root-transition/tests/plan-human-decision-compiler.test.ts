import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootReconciliationView,
  RootSemanticGateCommand,
  RootSemanticIntent,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { PlanHumanDecisionCompilerImpl } from "../internal/PlanHumanDecisionCompilerImpl.js";
import { mechanicalWriteId } from "../internal/MechanicalWriteId.js";

test("exact Plan approval compiles only the durable Approved barrier", () => {
  const current = fixture();
  const result = new PlanHumanDecisionCompilerImpl().compile(current);

  assert.deepEqual(result, {
    kind: "effect",
    command: {
      kind: "update_workflow_issue",
      writeId: mechanicalWriteId(["root-1", "plan-1", "approve-plan", current.command.subject.decisionReplyCommentId]),
      expectedProjectId: "project-1",
      rootIssueId: "root-1",
      expectedRootRemoteVersion: "root-v1",
      target: {
        targetIssueId: "plan-1",
        expectedRemoteVersion: "plan-v1",
        expectedStatusId: "in-review",
        expectedParentIssueId: "cycle-1",
        expectedIsArchived: false,
      },
      statusId: "approved",
      title: "Plan",
      description: "# Plan Result\n\nApproved content",
      labelNames: ["symphony:kind/plan"],
      parentAssignment: { mode: "retain" },
      order: 0,
    },
  });
});

test("Plan approval rejects stale content and invalid native authorization facts", () => {
  const stale = fixture();
  stale.view.tree.issues[2]!.description = "edited after the decision command";
  assert.deepEqual(new PlanHumanDecisionCompilerImpl().compile(stale), {
    kind: "invalid_intent", reason: "subject_stale",
  });

  const unauthorized = fixture();
  unauthorized.view.tree.comments[1]!.author_user_id = "user-2";
  unauthorized.view.tree.comments[1]!.author_id = "user-2";
  assert.deepEqual(new PlanHumanDecisionCompilerImpl().compile(unauthorized), {
    kind: "invalid_intent", reason: "authorization_invalid",
  });

  const wrongCycle = fixture();
  wrongCycle.view.tree.issues[1]!.status_name = "Executing";
  assert.deepEqual(new PlanHumanDecisionCompilerImpl().compile(wrongCycle), {
    kind: "invalid_intent", reason: "topology_invalid",
  });
});

function fixture(): {
  command: Extract<RootSemanticGateCommand, { semanticGate: "plan_human_decision" }>;
  intent: Extract<RootSemanticIntent, { semanticGate: "plan_human_decision" }>;
  view: RootReconciliationView;
} {
  const planDescription = "# Plan Result\n\nApproved content";
  const replyBody = "I approve this plan.";
  const observedAt = "2026-07-29T00:00:00Z";
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "planning", name: "Planning", category: "started", position: 1 },
      { status_id: "in-review", name: "In Review", category: "started", position: 2 },
      { status_id: "approved", name: "Approved", category: "started", position: 3 },
    ],
    issues: [
      issue("root-1", "root", undefined, "root-progress", "In Progress", "Root", "Requirement", "root-v1", observedAt),
      issue("cycle-1", "cycle", "root-1", "planning", "Planning", "Cycle", "Planning", "cycle-v1", observedAt),
      issue("plan-1", "plan", "cycle-1", "in-review", "In Review", "Plan", planDescription, "plan-v1", observedAt),
    ],
    comments: [
      comment("approval-request", undefined, "approval-request", "symphony", undefined,
        "## 需要你审批\n\n### 相关对象\n- SYM-3", observedAt),
      comment("approval-reply", "approval-request", "approval-request", "human", "user-1", replyBody, observedAt),
    ],
    relations: [], attachments: [], activities: [], source_manifest: [],
    coverage: { is_complete: true, omissions: [] }, observed_at: observedAt,
  };
  const inputId = "input-approval-reply";
  const command = {
    semanticGate: "plan_human_decision" as const,
    trigger: "plan_approval_reply" as const,
    expectedOutputContract: "plan_human_decision_intent.v1" as const,
    pendingInputRefs: [{
      sourceKind: "comment_body" as const, inputId, nativeSourceIdentity: "approval-reply",
      sourceVersionOrDigest: digest(replyBody),
    }],
    subject: {
      planIssueId: "plan-1", planContentDigest: digest(planDescription),
      approvalThreadRootCommentId: "approval-request", decisionReplyCommentId: "approval-reply",
      decisionReplyBodyDigest: digest(replyBody), actorId: "user-1", actorAuthorization: "authorized" as const,
    },
  };
  const view: RootReconciliationView = {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress", updatedAt: observedAt,
      projectId: "project-1", priority: "normal", blockers: [], rootConductorLabels: [],
      isDelegatedToSymphony: true, isArchived: false,
    },
    tree,
    worktreeGate: {
      kind: "valid", repositoryIdentity: "repo-1", branch: "symphony/runs/sym-1",
      headRevision: "head-1", isClean: true, changedPaths: [],
    },
    workspace: { branch: "symphony/runs/sym-1", worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
    git: { head: "head-1", branch: "symphony/runs/sym-1", status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt, treeDigest: "tree-v1", complete: true,
  };
  return {
    command,
    view,
    intent: {
      protocolVersion: 1, requestId: "request-1", intentId: "intent-1", rootIssueId: "root-1",
      reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1",
      modelTurn: {
        turnRecordId: "root-1:turn-1", role: "root_reconciler", rootIssueId: "root-1",
        reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", invocationState: "confirmed",
        model: "gpt", outcome: "intent_accepted", usage: { status: "unavailable", reason: "provider_omitted" }, terminalAt: observedAt,
      },
      basedOnTargetRootDigest: view.treeDigest, rationale: "The authorized human approved the exact Plan.",
      evidenceRefs: [], consumedInputIds: [inputId],
      commentDispositions: [{
        kind: "applied", sourceInputId: inputId,
        source: { kind: "comment_body", commentId: "approval-reply", commentBodyDigest: digest(replyBody) },
        summary: "Approved Plan accepted.",
      }],
      kind: "plan_human_decision_intent", semanticGate: "plan_human_decision", intent: { kind: "approve_plan" },
    },
  };
}

function issue(
  issueId: string, kind: "root" | "cycle" | "plan", parentIssueId: string | undefined,
  statusId: string, statusName: "In Progress" | "Planning" | "In Review", title: string,
  description: string, remoteVersion: string, timestamp: string,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId === "root-1" ? "SYM-1" : issueId === "cycle-1" ? "SYM-2" : "SYM-3",
    project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId, status_name: statusName, status_category: "started", status_position: 1,
    order: 0, depth: parentIssueId ? (kind === "cycle" ? 1 : 2) : 0, title, description,
    labels: [`symphony:kind/${kind}`], is_archived: false, issue_kind: kind,
    remote_version: remoteVersion, created_at: timestamp, updated_at: timestamp,
    ...(kind === "root" ? { creator_user_id: "user-1", assignee_user_id: "user-1" } : {}),
  };
}

function comment(
  commentId: string, parentCommentId: string | undefined, threadRootCommentId: string,
  authorKind: "symphony" | "human", authorUserId: string | undefined, body: string, timestamp: string,
): LinearWorkflowTreeSnapshot["comments"][number] {
  return {
    comment_id: commentId, issue_id: "root-1", author_id: authorUserId ?? "symphony-1",
    ...(authorUserId ? { author_user_id: authorUserId } : {}), author_kind: authorKind,
    ...(parentCommentId ? { parent_comment_id: parentCommentId } : {}), thread_root_comment_id: threadRootCommentId,
    thread_state: "unresolved", body, reactions: [], remote_version: `${commentId}-v1`, created_at: timestamp, updated_at: timestamp,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
