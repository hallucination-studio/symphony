import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../linear-gateway/api/LinearGatewayInterface.js";
import { RootDeliveryCoordinator, LinearRootDeliveryCompletionWriter } from "./RootDeliveryComposition.js";
import type { RootDeliveryCommand } from "../root-delivery/api/RootDeliveryInterface.js";

test("delivery records a receipt, moves Root to In Review, and retries idempotently", async () => {
  const gateway = new FakeGateway();
  let deliveryCalls = 0;
  const coordinator = new RootDeliveryCoordinator({
    async deliver() {
      deliveryCalls += 1;
      return { kind: "pull_request", url: "https://github.com/acme/repo/pull/7" };
    },
  }, new LinearRootDeliveryCompletionWriter(gateway, () => "2026-07-21T10:00:00Z"));

  await coordinator.deliver(command());
  await coordinator.deliver(command());

  assert.equal(deliveryCalls, 2);
  assert.equal(gateway.tree.issues[0]?.status_name, "In Review");
  assert.equal(gateway.tree.comments.length, 1);
  assert.equal(gateway.mutations.filter(({ kind }) => kind === "append_workflow_comment").length, 1);
  assert.equal(gateway.mutations.filter(({ kind }) => kind === "update_workflow_issue").length, 1);
  assert.notEqual(gateway.tree.issues[0]?.status_name, "Done");
});

test("delivery completion fails closed for a terminal Root", async () => {
  const gateway = new FakeGateway();
  gateway.tree.issues[0] = { ...gateway.tree.issues[0]!, status_name: "Done", status_category: "completed", status_id: "status-done" };
  await assert.rejects(
    new LinearRootDeliveryCompletionWriter(gateway, () => "2026-07-21T10:00:00Z").persist({
      command: command(),
      result: { kind: "remote_branch", branch: "symphony/runs/sym-1" },
    }),
    /root_delivery_state_invalid/,
  );
  assert.equal(gateway.mutations.length, 0);
});

function command(): RootDeliveryCommand {
  return {
    rootIssueId: "root-1",
    projectId: "project-1",
    workspace: { branch: "symphony/runs/sym-1", worktreePath: "/worktree", rootIssueId: "root-1" },
    baseBranch: "main", title: "SYM-1 delivery", body: "Bounded delivery summary",
    expected: {
      root_version: "root-version-1", tree_digest: "tree-1", git_head: "abc123", checks_digest: "checks-1",
      latest_succeeded_cycle: { issue_id: "cycle-1", verify_result_id: "verify-1", verified_revision: "abc123" },
      owner_generation: "generation-1",
    },
  };
}

class FakeGateway {
  tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "status-progress", name: "In Progress", category: "started", position: 1 },
      { status_id: "status-review", name: "In Review", category: "started", position: 2 },
      { status_id: "status-done", name: "Done", category: "completed", position: 3 },
    ],
    issues: [{
      issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "status-progress", status_name: "In Progress", status_category: "started", status_position: 1,
      order: 0, depth: 0, title: "Root", description: "Build it", remote_version: "root-version-1", updated_at: "2026-07-21T09:00:00Z",
      is_archived: false,
    }],
    comments: [], relations: [], observed_at: "2026-07-21T09:00:00Z",
  };
  mutations: LinearWorkflowMutationCommand[] = [];

  async readWorkflowIssueTree() { return this.tree; }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind === "append_workflow_comment") {
      this.tree.comments.push({ comment_id: command.writeId, issue_id: command.target.targetIssueId, body: command.body, author_kind: "symphony", author_id: "symphony-bot", author_user_id: "symphony-bot", created_at: "2026-07-21T10:00:00Z", managed_marker: command.writeId, remote_version: command.writeId, updated_at: "2026-07-21T10:00:00Z" });
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: command.target.targetIssueId, remoteVersion: command.writeId } };
    }
    if (command.kind === "update_workflow_issue") {
      const target = this.tree.issues.find(({ issue_id }) => issue_id === command.target.targetIssueId)!;
      const status = this.tree.status_catalog.find(({ status_id }) => status_id === command.statusId)!;
      Object.assign(target, { status_id: status.status_id, status_name: status.name, status_category: status.category, status_position: status.position, remote_version: `${target.remote_version}:review` });
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: target.issue_id, remoteVersion: target.remote_version } };
    }
    throw new Error("unexpected_mutation");
  }
}
