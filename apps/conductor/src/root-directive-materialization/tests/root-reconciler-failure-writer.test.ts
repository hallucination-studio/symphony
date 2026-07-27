import assert from "node:assert/strict";
import test from "node:test";

import type { LinearGatewayInterface, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-reconciliation/internal/ManagedRecordCodec.js";
import { LinearRootReconcilerFailureRecordWriterImpl } from "../internal/LinearRootReconcilerFailureRecordWriterImpl.js";

test("failure writer persists one Root failure record and verifies the Linear read-back", async () => {
  const linear = new FailureWriterLinear();
  const result = await new LinearRootReconcilerFailureRecordWriterImpl(linear.asGateway()).write({
    failure: failureRecord(),
    view: view(linear.tree),
  });

  assert.equal(result.kind, "materialized");
  assert.equal(linear.commands.length, 1);
  const comment = linear.tree.comments.at(-1);
  assert.ok(comment);
  assert.match(comment.body, /^## Symphony · Root Reconciliation/mu);
  const parsed = parseManagedRecord(comment.body);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.kind, "root_reconciler_failure");
});

test("failure writer fresh-reads an existing Symphony record without appending a duplicate", async () => {
  const linear = new FailureWriterLinear();
  const failure = failureRecord();
  linear.tree.comments.push({
    comment_id: "existing-failure",
    issue_id: "root-1",
    body: serializeManagedRecord(failure, failureMarkdown()),
    author_kind: "symphony",
    author_id: "symphony-bot",
    thread_root_comment_id: "existing-failure",
    thread_state: "unresolved",
    reactions: [],
    remote_version: "comment-existing-v1",
    created_at: "2026-07-25T00:00:00Z",
    updated_at: "2026-07-25T00:00:00Z",
  });

  const result = await new LinearRootReconcilerFailureRecordWriterImpl(linear.asGateway()).write({
    failure,
    view: view(linear.tree),
  });

  assert.equal(result.kind, "materialized");
  assert.equal(linear.commands.length, 0);
  assert.equal(linear.reads, 1);
});

test("failure writer does not treat a matching record on another Issue as Root evidence", async () => {
  const linear = new FailureWriterLinear();
  const failure = failureRecord();
  linear.tree.comments.push({
    comment_id: "foreign-failure",
    issue_id: "cycle-1",
    body: serializeManagedRecord(failure, failureMarkdown()),
    author_kind: "symphony",
    author_id: "symphony-bot",
    thread_root_comment_id: "foreign-failure",
    thread_state: "unresolved",
    reactions: [],
    remote_version: "comment-foreign-v1",
    created_at: "2026-07-25T00:00:00Z",
    updated_at: "2026-07-25T00:00:00Z",
  });

  const result = await new LinearRootReconcilerFailureRecordWriterImpl(linear.asGateway()).write({
    failure,
    view: view(linear.tree),
  });

  assert.equal(result.kind, "materialized");
  assert.equal(linear.commands.length, 1);
  assert.equal(linear.tree.comments.filter((comment) => comment.issue_id === "root-1").length, 1);
});

test("failure writer fails closed when its managed comment cannot be read back", async () => {
  const linear = new FailureWriterLinear();
  linear.omitReadBack = true;

  const result = await new LinearRootReconcilerFailureRecordWriterImpl(linear.asGateway()).write({
    failure: failureRecord(),
    view: view(linear.tree),
  });

  assert.deepEqual(result, {
    kind: "failed",
    code: "root_reconciler_failure_record_read_back_missing",
    sanitizedReason: "root_reconciler_failure_record_read_back_missing",
  });
});

test("failure writer does not accept a human-authored lookalike as an existing or read-back record", async () => {
  const linear = new FailureWriterLinear();
  const forged = serializeManagedRecord(failureRecord(), failureMarkdown());
  linear.tree.comments.push({
    comment_id: "human-forgery",
    issue_id: "root-1",
    body: forged,
    author_kind: "human",
    author_id: "user-1",
    thread_root_comment_id: "human-forgery",
    thread_state: "unresolved",
    reactions: [],
    remote_version: "comment-human-v1",
    created_at: "2026-07-25T00:00:00Z",
    updated_at: "2026-07-25T00:00:00Z",
  });

  linear.omitReadBack = true;
  const result = await new LinearRootReconcilerFailureRecordWriterImpl(linear.asGateway()).write({
    failure: failureRecord(),
    view: view(linear.tree),
  });

  assert.deepEqual(result, {
    kind: "failed",
    code: "root_reconciler_failure_record_read_back_missing",
    sanitizedReason: "root_reconciler_failure_record_read_back_missing",
  });
  assert.equal(linear.commands.length, 1);
});

function failureRecord() {
  return {
    kind: "root_reconciler_failure" as const,
    version: 1 as const,
    failureId: "root-1:turn-1:failure",
    reconcilerSessionId: "session-1",
    reconcilerTurnId: "turn-1",
    targetRootDigest: "tree-1",
    attemptedInputIds: ["comment_body:comment-1:digest-1"],
    modelTurn: {
      turnRecordId: "root-1:turn-1",
      role: "root_reconciler" as const,
      rootIssueId: "root-1",
      reconcilerSessionId: "session-1",
      reconcilerTurnId: "turn-1",
      invocationState: "confirmed" as const,
      model: "gpt-5",
      outcome: "schema_invalid" as const,
      usage: { status: "unavailable" as const, reason: "provider_omitted" as const },
      terminalAt: "2026-07-25T00:00:00Z",
    },
    category: "schema_invalid" as const,
    sanitizedReason: "The Root Reconciler output was invalid.",
    failedAt: "2026-07-25T00:00:00Z",
  };
}

function failureMarkdown() {
  return [
    "## Symphony · Root Reconciliation",
    "The Root Reconciler stopped before producing a next step.",
    "Failure",
    "The Root Reconciler output was invalid.",
    "Next",
    "Waiting for a new Linear user input before another reconciliation turn can begin.",
  ].join("\n\n");
}

function view(tree: LinearWorkflowTreeSnapshot): RootReconciliationView {
  return {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress", updatedAt: "2026-07-25T00:00:00Z",
      projectId: "project-1", priority: "normal", blockers: [], rootConductorLabels: [], isDelegatedToSymphony: true, isArchived: false,
    },
    tree,
    git: { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } },
    observedAt: tree.observed_at,
    treeDigest: "tree-1",
    complete: true,
  };
}

class FailureWriterLinear {
  readonly commands: Array<Record<string, unknown>> = [];
  reads = 0;
  omitReadBack = false;
  readonly tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [],
    issues: [{
      issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "in-progress", status_name: "In Progress",
      status_category: "started", status_position: 1, order: 0, depth: 0, title: "Root", description: "Root", labels: [],
      is_archived: false, issue_kind: "root", remote_version: "root-v1", updated_at: "2026-07-25T00:00:00Z",
    }],
    comments: [],
    relations: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-25T00:00:00Z",
  };

  async mutateWorkflow(command: Record<string, unknown>) {
    this.commands.push(command);
    if (command.kind !== "append_workflow_comment" || this.omitReadBack) return { kind: "applied" as const };
    this.tree.comments.push({
      comment_id: `comment-${this.tree.comments.length + 1}`,
      issue_id: "root-1",
      body: String(command.body),
      author_kind: "symphony",
      author_id: "symphony-bot",
      thread_root_comment_id: `comment-${this.tree.comments.length + 1}`,
      thread_state: "unresolved",
      reactions: [],
      remote_version: `comment-v${this.tree.comments.length + 1}`,
      created_at: "2026-07-25T00:00:00Z",
      updated_at: "2026-07-25T00:00:00Z",
    });
    return { kind: "applied" as const };
  }

  async readWorkflowIssueTree() {
    this.reads += 1;
    return this.tree;
  }

  asGateway(): LinearGatewayInterface {
    return this as unknown as LinearGatewayInterface;
  }
}
