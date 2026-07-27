import assert from "node:assert/strict";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  CreateHumanActionAction,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { LinearHumanActionMaterializerImpl } from "../internal/LinearHumanActionMaterializerImpl.js";

test("creates one native Human Action thread on the Root", async () => {
  const linear = new FakeLinear();
  const result = await new LinearHumanActionMaterializerImpl(linear).materialize({
    rootDirectiveId: "directive-1",
    view: view(linear.tree),
    action: planApproval(linear.tree),
  });

  assert.deepEqual(result, { kind: "materialized", requestCommentId: "request-1" });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["append_workflow_comment"]);
  const request = linear.tree.comments[0]!;
  assert.equal(request.issue_id, "root-1");
  assert.equal(request.parent_comment_id, undefined);
  assert.equal(request.thread_root_comment_id, request.comment_id);
  assert.equal(request.author_kind, "symphony");
  assert.match(request.body, /^## 需要你审批/mu);
  assert.match(request.body, /SYM-PLAN-1/u);
  assert.doesNotMatch(request.body, /```json|<!--|root_directive|proposal_digest/u);
});

test("rejects stale or invalid native Human Action targets before writing", async () => {
  const linear = new FakeLinear();
  const materializer = new LinearHumanActionMaterializerImpl(linear);
  const stale = await materializer.materialize({
    rootDirectiveId: "directive-1",
    view: view(linear.tree),
    action: { ...planApproval(linear.tree), expectedRootRemoteVersion: "stale" },
  });
  assert.equal(stale.kind, "failed");

  const invalid = await materializer.materialize({
    rootDirectiveId: "directive-2",
    view: view(linear.tree),
    action: { ...planApproval(linear.tree), targetIssueIds: ["cycle-1"] },
  });
  assert.equal(invalid.kind, "failed");
  assert.deepEqual(linear.mutations, []);
});

test("fails closed when a native comment write is not confirmed", async () => {
  const linear = new FakeLinear();
  linear.unconfirmed = true;
  const result = await new LinearHumanActionMaterializerImpl(linear).materialize({
    rootDirectiveId: "directive-1",
    view: view(linear.tree),
    action: planApproval(linear.tree),
  });
  assert.deepEqual(result, {
    kind: "failed",
    code: "human_action_request_write_unconfirmed",
    sanitizedReason: "human_action_request_write_unconfirmed",
  });
});

function planApproval(tree: LinearWorkflowTreeSnapshot): CreateHumanActionAction {
  return {
    kind: "create_human_action",
    rootIssueId: "root-1",
    actionKind: "plan_approval",
    targetIssueIds: ["plan-1"],
    expectedRootRemoteVersion: tree.issues[0]!.remote_version,
    question: "请审批当前计划。",
    context: "批准后才会开始创建 Work 与 Verify 节点。",
    options: ["批准", "拒绝"],
    evidenceRefs: [{ referenceId: "plan-1", sourceKind: "linear_issue" }],
  };
}

function view(tree: LinearWorkflowTreeSnapshot): RootReconciliationView {
  return {
    root: {
      issueId: "root-1", identifier: "SYM-ROOT-1", state: "In Progress", updatedAt: tree.observed_at,
      projectId: "project-1", priority: "normal", blockers: [], rootConductorLabels: [],
      isDelegatedToSymphony: true, isArchived: false,
    },
    tree,
    worktreeGate: { kind: "valid", repositoryIdentity: "repository-1", branch: "main", headRevision: "head-1", isClean: true, changedPaths: [] },
    workspace: { branch: "main", worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
    git: { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt: tree.observed_at,
    treeDigest: "tree-digest-1",
    complete: true,
  };
}

class FakeLinear {
  readonly mutations: LinearWorkflowMutationCommand[] = [];
  unconfirmed = false;
  tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "progress", name: "In Progress", category: "started", position: 1 },
      { status_id: "planning", name: "Planning", category: "started", position: 2 },
      { status_id: "review", name: "In Review", category: "started", position: 3 },
    ],
    issues: [
      issue("root-1", "SYM-ROOT-1", "root", undefined, "progress", "In Progress", 0),
      issue("cycle-1", "SYM-CYCLE-1", "cycle", "root-1", "planning", "Planning", 1),
      issue("plan-1", "SYM-PLAN-1", "plan", "cycle-1", "review", "In Review", 2),
    ],
    comments: [], relations: [], attachments: [], activities: [], source_manifest: [],
    coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-24T00:00:00Z",
  };

  async readWorkflowIssueTree() { return structuredClone(this.tree); }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind !== "append_workflow_comment") throw new Error("unexpected mutation");
    if (this.unconfirmed) {
      return { kind: "write_unconfirmed" as const, readBackTarget: { writeId: command.writeId, targetIssueId: "root-1", remoteVersion: "root-v1" } };
    }
    const comment = {
      comment_id: "request-1", issue_id: "root-1", body: command.body, author_kind: "symphony" as const,
      author_id: "symphony", thread_root_comment_id: "request-1", thread_state: "unresolved" as const,
      reactions: [], created_at: "2026-07-24T00:00:01Z", remote_version: "request-v1", updated_at: "2026-07-24T00:00:01Z",
    };
    this.tree.comments.push(comment);
    return {
      kind: "applied" as const,
      readBack: { writeId: command.writeId, targetIssueId: "root-1", remoteVersion: "root-v2", comment },
    };
  }
}

function issue(
  issueId: string,
  identifier: string,
  issueKind: "root" | "cycle" | "plan",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: string,
  depth: number,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId, status_name: statusName, status_category: "started", status_position: depth,
    order: depth, depth, title: issueKind, description: `${issueKind} description`, labels: [], is_archived: false,
    issue_kind: issueKind, remote_version: `${issueId}-v1`, created_at: "2026-07-24T00:00:00Z", updated_at: "2026-07-24T00:00:00Z",
  };
}
