import assert from "node:assert/strict";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootDirective,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { LinearGitRootActionMaterializerImpl } from "../internal/LinearGitRootActionMaterializerImpl.js";

test("materializes exactly one approved Plan node and its native relations", async () => {
  const linear = new FakeLinear();
  const result = await materializer(linear).materialize({ directive: directive(), view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "materialized",
    rootDirectiveId: "directive-1",
    sourceIssueIds: ["cycle-1", "plan-1", "work-1", "dependency-1"],
  });
  const created = linear.issue("work-1");
  assert.equal(created.description, "Implement the approved change.\n\nRequired check: npm test");
  assert.deepEqual(created.labels, ["symphony:kind/work"]);
  assert.equal(created.parent_issue_id, "cycle-1");
  assert.equal(created.order, 2);
  assert.equal(created.description.includes("```json"), false);
  assert.equal(linear.mutations.filter(({ kind }) => kind === "create_workflow_issue").length, 1);
  assert.deepEqual(linear.tree.relations.map(({ relation_kind, source_issue_id, target_issue_id }) => [
    relation_kind, source_issue_id, target_issue_id,
  ]).sort(), [
    ["blocks", "dependency-1", "work-1"],
    ["relates_to", "plan-1", "work-1"],
  ]);
});

test("accepts one fresh native postcondition after an ambiguous create response", async () => {
  const linear = new FakeLinear("write_unconfirmed");
  const result = await materializer(linear).materialize({ directive: directive(), view: view(linear.tree) });

  assert.equal(result.kind, "materialized");
  assert.equal(linear.tree.issues.filter(({ issue_id }) => issue_id === "work-1").length, 1);
});

test("rejects indistinguishable duplicate native postconditions without another create", async () => {
  const linear = new FakeLinear();
  linear.addMatchingNode("work-1");
  linear.addMatchingNode("work-2");

  const result = await materializer(linear).materialize({ directive: directive(), view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "failed",
    rootDirectiveId: "directive-1",
    code: "plan_node_create_ambiguous",
    sanitizedReason: "plan_node_create_ambiguous",
  });
  assert.deepEqual(linear.mutations, []);
});

test("reuses one exact native node and does not create a duplicate", async () => {
  const linear = new FakeLinear();
  linear.addMatchingNode("work-1");
  linear.tree.relations.push(
    relation("plan-node", "relates_to", "plan-1", "work-1"),
    relation("dependency-node", "blocks", "dependency-1", "work-1"),
  );

  const result = await materializer(linear).materialize({ directive: directive(), view: view(linear.tree) });

  assert.equal(result.kind, "materialized");
  assert.deepEqual(linear.mutations, []);
});

test("rejects approval from a non-human actor", async () => {
  const linear = new FakeLinear();
  linear.tree.comments.find(({ comment_id }) => comment_id === "approval-reply")!.author_kind = "external_automation";

  const result = await materializer(linear).materialize({ directive: directive(), view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "failed",
    rootDirectiveId: "directive-1",
    code: "plan_node_approval_reply_invalid",
    sanitizedReason: "plan_node_approval_reply_invalid",
  });
  assert.deepEqual(linear.mutations, []);
});

function materializer(linear: FakeLinear) {
  return new LinearGitRootActionMaterializerImpl(linear, {} as never, {} as never, "main", {} as never);
}

function directive(): RootDirective & { action: Extract<RootDirective["action"], { kind: "materialize_plan_node" }> } {
  return {
    protocolVersion: 1,
    requestId: "request-1",
    rootDirectiveId: "directive-1",
    reconcilerSessionId: "session-1",
    reconcilerTurnId: "turn-1",
    modelTurn: {
      turnRecordId: "root-1:turn-1", role: "root_reconciler", rootIssueId: "root-1",
      reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", invocationState: "confirmed",
      model: "gpt", outcome: "directive_accepted", usage: { status: "unavailable", reason: "provider_omitted" },
      terminalAt: "2026-07-24T00:00:00Z",
    },
    basedOnTargetRootDigest: "tree-v1",
    rationale: "Create the next approved native Work node.",
    evidenceRefs: [{ referenceId: "plan-1", sourceKind: "linear_issue" }],
    consumedInputIds: [],
    commentReplies: [],
    action: {
      kind: "materialize_plan_node",
      cycleIssueId: "cycle-1",
      expectedCycleRemoteVersion: "cycle-1-v1",
      planIssueId: "plan-1",
      expectedPlanRemoteVersion: "plan-1-v1",
      approvalRequestCommentId: "approval-request",
      expectedApprovalRequestRemoteVersion: "approval-request-v1",
      approvalReplyCommentId: "approval-reply",
      expectedApprovalReplyRemoteVersion: "approval-reply-v1",
      nodeKind: "work",
      title: "Implement approved change",
      description: "Implement the approved change.\n\nRequired check: npm test",
      order: 2,
      dependencyIssueIds: ["dependency-1"],
    },
  };
}

class FakeLinear {
  readonly mutations: LinearWorkflowMutationCommand[] = [];
  tree: LinearWorkflowTreeSnapshot = tree();

  constructor(private readonly createOutcome: "applied" | "write_unconfirmed" = "applied") {}

  issue(issueId: string) {
    const found = this.tree.issues.find(({ issue_id }) => issue_id === issueId);
    if (!found) throw new Error(`missing issue ${issueId}`);
    return found;
  }

  addMatchingNode(issueId: string): void {
    const node = issue(issueId, "work", "cycle-1", "todo", "Todo", 2, 2);
    node.title = "Implement approved change";
    node.description = "Implement the approved change.\n\nRequired check: npm test";
    this.tree.issues.push(node);
  }

  async readWorkflowIssueTree() {
    return structuredClone(this.tree);
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind === "create_workflow_issue") {
      const created = issue("work-1", "work", command.parentIssueId, command.statusId, "Todo", 2, command.order ?? 0);
      created.title = command.title;
      created.description = command.description;
      created.labels = command.labelNames;
      this.tree.issues.push(created);
      return this.createOutcome === "write_unconfirmed"
        ? { kind: "write_unconfirmed" as const, readBackTarget: {
          writeId: command.writeId, targetIssueId: created.issue_id, remoteVersion: created.remote_version,
        } }
        : applied(command.writeId, created);
    }
    if (command.kind === "create_workflow_relation") {
      this.tree.relations.push(relation(command.writeId, command.relationKind, command.sourceIssueId, command.targetIssueId));
      return applied(command.writeId, this.issue(command.sourceIssueId));
    }
    throw new Error(`unexpected mutation ${command.kind}`);
  }
}

function tree(): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: "root-1",
    status_catalog: [
      status("root-progress", "In Progress", "started", 1),
      status("cycle-planning", "Planning", "started", 2),
      status("plan-review", "In Review", "started", 3),
      status("todo", "Todo", "unstarted", 4),
    ],
    issues: [
      issue("root-1", "root", undefined, "root-progress", "In Progress", 0, 0),
      issue("cycle-1", "cycle", "root-1", "cycle-planning", "Planning", 1, 0),
      issue("plan-1", "plan", "cycle-1", "plan-review", "In Review", 2, 0),
      issue("dependency-1", "work", "cycle-1", "todo", "Todo", 2, 1),
    ],
    comments: [approvalRequest(), approvalReply()],
    relations: [], attachments: [], activities: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-24T00:02:00Z",
  };
}

function view(tree: LinearWorkflowTreeSnapshot): RootReconciliationView {
  return {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress", updatedAt: "2026-07-24T00:00:00Z",
      projectId: "project-1", priority: "normal", blockers: [], rootConductorLabels: [],
      isDelegatedToSymphony: true, isArchived: false,
    },
    tree,
    worktreeGate: { kind: "valid", repositoryIdentity: "repository-1", branch: "main", headRevision: "head-1", isClean: true, changedPaths: [] },
    workspace: { branch: "main", worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
    git: { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt: tree.observed_at, treeDigest: "tree-v1", complete: true,
  };
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle" | "plan" | "work" | "verify",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: string,
  depth: number,
  order: number,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId, project_id: "project-1",
    ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId, status_name: statusName, status_category: statusName === "Todo" ? "unstarted" : "started",
    status_position: depth, order, depth, title: issueKind, description: `${issueKind} description`,
    labels: [`symphony:kind/${issueKind}`],
    is_archived: false, issue_kind: issueKind, remote_version: `${issueId}-v1`,
    created_at: "2026-07-24T00:00:00Z", updated_at: "2026-07-24T00:00:00Z",
  };
}

function status(statusId: string, name: string, category: "unstarted" | "started", position: number) {
  return { status_id: statusId, name, category, position };
}

function relation(id: string, kind: "blocks" | "blocked_by" | "relates_to" | "triggered_by", source: string, target: string) {
  return { relation_id: id, relation_kind: kind, source_issue_id: source, target_issue_id: target };
}

function approvalRequest() {
  return {
    comment_id: "approval-request", issue_id: "root-1", body: "## 需要你审批\n\n请审批 Plan。\n\n- plan-1",
    author_kind: "symphony" as const, author_id: "symphony", thread_root_comment_id: "approval-request",
    thread_state: "unresolved" as const, reactions: [], created_at: "2026-07-24T00:00:00Z",
    remote_version: "approval-request-v1", updated_at: "2026-07-24T00:00:00Z",
  };
}

function approvalReply() {
  return {
    comment_id: "approval-reply", issue_id: "root-1", parent_comment_id: "approval-request", body: "批准。",
    author_kind: "human" as const, author_id: "human-1", author_user_id: "human-1",
    thread_root_comment_id: "approval-request", thread_state: "unresolved" as const, reactions: [],
    created_at: "2026-07-24T00:01:00Z", remote_version: "approval-reply-v1", updated_at: "2026-07-24T00:01:00Z",
  };
}

function applied(writeId: string, issue: LinearWorkflowTreeSnapshot["issues"][number]) {
  return { kind: "applied" as const, readBack: { writeId, targetIssueId: issue.issue_id, remoteVersion: issue.remote_version } };
}
