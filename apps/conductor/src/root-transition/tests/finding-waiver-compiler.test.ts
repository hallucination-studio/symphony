import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { FindingWaiverCompilerImpl } from "../internal/FindingWaiverCompilerImpl.js";

test("Finding waiver converges one Finding, receipt and thread effect at a time", () => {
  const current = view();
  const compiler = new FindingWaiverCompilerImpl();

  const first = compiler.compile({ target: target(current), view: current });
  assert.equal(first.kind, "effect");
  if (first.kind !== "effect") return;
  assert.equal(first.command.kind, "update_workflow_issue");
  if (first.command.kind !== "update_workflow_issue") return;
  assert.equal(first.command.target.targetIssueId, "finding-a");
  assert.equal(first.command.statusId, "canceled");

  cancelFinding(current.tree, "finding-a");
  const second = compiler.compile({ target: target(current), view: current });
  assert.equal(second.kind, "effect");
  if (second.kind !== "effect" || second.command.kind !== "update_workflow_issue") return;
  assert.equal(second.command.target.targetIssueId, "finding-b");

  cancelFinding(current.tree, "finding-b");
  const receipt = compiler.compile({ target: target(current), view: current });
  assert.equal(receipt.kind, "effect");
  if (receipt.kind !== "effect") return;
  assert.equal(receipt.command.kind, "create_comment_receipt_reaction");

  const reply = current.tree.comments.find(({ comment_id }) => comment_id === "waiver-reply")!;
  reply.reactions.push({ reaction_id: "receipt", emoji: "✅", actor_kind: "symphony", actor_id: "symphony" });
  const resolve = compiler.compile({ target: target(current), view: current });
  assert.equal(resolve.kind, "effect");
  if (resolve.kind !== "effect") return;
  assert.equal(resolve.command.kind, "set_comment_thread_state");

  for (const comment of current.tree.comments) comment.thread_state = "resolved";
  assert.deepEqual(compiler.compile({ target: target(current), view: current }), { kind: "satisfied" });
});

test("Finding waiver rejects stale scope, actor, provenance and premature completion without effects", () => {
  const changes: Array<(current: RootReconciliationView) => void> = [
    (current) => { current.tree.comments.find(({ comment_id }) => comment_id === "waiver-request")!.body = current.tree.comments[0]!.body.replace("- FIND-B", "- FIND-C"); },
    (current) => { current.tree.comments.find(({ comment_id }) => comment_id === "waiver-reply")!.author_user_id = "other-human"; },
    (current) => { current.tree.issues.find(({ issue_id }) => issue_id === "finding-a")!.remote_version = "human-edit"; },
    (current) => { current.tree.comments.find(({ comment_id }) => comment_id === "waiver-request")!.thread_state = "resolved"; },
    (current) => { current.tree.comments.find(({ comment_id }) => comment_id === "waiver-reply")!.reactions.push({ reaction_id: "early", emoji: "✅", actor_kind: "symphony", actor_id: "symphony" }); },
  ];
  for (const change of changes) {
    const current = view();
    change(current);
    assert.equal(new FindingWaiverCompilerImpl().compile({ target: target(current), view: current }).kind, "invalid_facts");
  }
});

test("Finding waiver effects preserve Verify facts", () => {
  const current = view();
  const verifyBefore = structuredClone(current.tree.issues.find(({ issue_id }) => issue_id === "verify")!);
  const result = new FindingWaiverCompilerImpl().compile({ target: target(current), view: current });
  assert.equal(result.kind, "effect");
  assert.deepEqual(current.tree.issues.find(({ issue_id }) => issue_id === "verify"), verifyBefore);
  if (result.kind === "effect" && result.command.kind === "update_workflow_issue") {
    assert.notEqual(result.command.target.targetIssueId, "verify");
  }
});

function target(current: RootReconciliationView): Extract<RootMechanicalTarget, { kind: "converge_finding_waiver" }> {
  return {
    kind: "converge_finding_waiver", cycleIssueId: "cycle", requestCommentId: "waiver-request",
    humanReplyCommentId: "waiver-reply", adoptionCommentId: "waiver-adoption",
    findingIssueIds: ["finding-a", "finding-b"],
    expectedWorktreeGate: current.worktreeGate as Extract<RootMechanicalTarget, { kind: "converge_finding_waiver" }>["expectedWorktreeGate"],
  };
}

function view(): RootReconciliationView {
  const issues = [
    issue("root", "ROOT", "root", undefined, "Needs Approval", []),
    issue("cycle", "CYCLE-1", "cycle", "root", "Verifying", [workflowKindLabel("cycle")]),
    issue("plan", "PLAN-1", "plan", "cycle", "Done", [workflowKindLabel("plan")]),
    issue("work", "WORK-1", "work", "cycle", "Done", [workflowKindLabel("work")]),
    { ...issue("verify", "VERIFY-1", "verify", "cycle", "Done", [workflowKindLabel("verify"), "Changes Required"]), description: "# Verify Result\n\nVerify Changes Required." },
    issue("finding-a", "FIND-A", "finding", "cycle", "Todo", [workflowKindLabel("finding"), "Finding"]),
    issue("finding-b", "FIND-B", "finding", "cycle", "In Progress", [workflowKindLabel("finding"), "Finding"]),
  ];
  issues[0]!.creator_user_id = "human";
  const requestBody = ["## 需要你确认 Finding 豁免", "", "### 相关对象", "- FIND-A", "- FIND-B", "", "### Verify 与 Cycle", "- VERIFY-1", "- CYCLE-1"].join("\n");
  const comments: LinearWorkflowTreeSnapshot["comments"] = [
    comment("waiver-request", "symphony", "symphony", requestBody),
    { ...comment("waiver-reply", "human", "human", "Waive both."), author_user_id: "human", parent_comment_id: "waiver-request", thread_root_comment_id: "waiver-request", created_at: "2026-07-29T00:02:00Z", updated_at: "2026-07-29T00:02:00Z" },
    { ...comment("waiver-adoption", "symphony", "symphony", "## 已应用\n\nThe complete unchanged Finding set is approved for waiver."), parent_comment_id: "waiver-reply", thread_root_comment_id: "waiver-request", created_at: "2026-07-29T00:03:00Z", updated_at: "2026-07-29T00:03:00Z" },
  ];
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root", status_catalog: [{ status_id: "canceled", name: "Canceled", category: "canceled", position: 5 }],
    issues, comments,
    relations: [
      { relation_id: "a-v", relation_kind: "relates_to", source_issue_id: "finding-a", target_issue_id: "verify" },
      { relation_id: "b-v", relation_kind: "relates_to", source_issue_id: "finding-b", target_issue_id: "verify" },
    ],
    attachments: [], activities: [],
    source_manifest: [
      ...issues.map((item) => ({ source_kind: "linear_issue" as const, source_id: item.issue_id, source_version: item.remote_version, actor_kind: "symphony" as const })),
      ...comments.map((item) => ({ source_kind: "linear_comment" as const, source_id: item.comment_id, source_version: item.remote_version, actor_kind: item.author_kind })),
    ], coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T00:04:00Z",
  };
  return {
    root: { issueId: "root", identifier: "ROOT", state: "Needs Approval", updatedAt: tree.observed_at, projectId: "project", priority: "normal", blockers: [], rootConductorLabels: [], isDelegatedToSymphony: true, isArchived: false },
    tree, worktreeGate: { kind: "valid", repositoryIdentity: "repo", branch: "symphony/runs/root", headRevision: "head", isClean: true, changedPaths: [] },
    workspace: { branch: "symphony/runs/root", worktreePath: "/tmp/root", rootIssueId: "root" },
    git: { head: "head", branch: "symphony/runs/root", status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt: tree.observed_at, treeDigest: "tree", complete: true,
  };
}

function issue(issueId: string, identifier: string, kind: NonNullable<LinearWorkflowTreeSnapshot["issues"][number]["issue_kind"]>, parentIssueId: string | undefined, status: string, labels: string[]): LinearWorkflowTreeSnapshot["issues"][number] {
  return { issue_id: issueId, identifier, project_id: "project", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}), status_id: status.toLowerCase().replace(" ", "-"), status_name: status, status_category: status === "Done" ? "completed" : status === "Todo" ? "unstarted" : "started", status_position: 1, order: 0, depth: parentIssueId ? 1 : 0, title: kind, description: kind, labels, is_archived: false, issue_kind: kind, remote_version: `${issueId}-v1`, created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z" };
}

function comment(commentId: string, authorKind: "human" | "symphony", authorId: string, body: string): LinearWorkflowTreeSnapshot["comments"][number] {
  return { comment_id: commentId, issue_id: "root", body, author_kind: authorKind, author_id: authorId, thread_root_comment_id: commentId, thread_state: "unresolved", reactions: [], created_at: "2026-07-29T00:01:00Z", updated_at: "2026-07-29T00:01:00Z", remote_version: `${commentId}-v1` };
}

function cancelFinding(tree: LinearWorkflowTreeSnapshot, issueId: string): void {
  const finding = tree.issues.find(({ issue_id }) => issue_id === issueId)!;
  finding.status_id = "canceled"; finding.status_name = "Canceled"; finding.status_category = "canceled";
  finding.remote_version = `${issueId}-v2`;
  tree.source_manifest.find(({ source_kind, source_id }) => source_kind === "linear_issue" && source_id === issueId)!.source_version = finding.remote_version;
}
