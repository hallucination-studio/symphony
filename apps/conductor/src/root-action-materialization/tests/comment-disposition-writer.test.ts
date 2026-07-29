import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootCommentDisposition,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { buildRootFactSet } from "../../root-reconciliation/internal/RootFactSet.js";
import { rootInputId } from "../../root-reconciliation/internal/RootInputIdentity.js";
import { LinearRootReconcilerReplyWriterImpl } from "../internal/LinearRootReconcilerReplyWriterImpl.js";

test("not_applied writes one reason, cross receipt and resolution that fresh bootstrap consumes", async () => {
  const linear = new SemanticFakeLinear();
  const disposition = commentDisposition("not_applied");
  const writer = new LinearRootReconcilerReplyWriterImpl(linear);

  const result = await writer.write({ operationId: "intent-1", disposition, view: view(linear.tree) });

  assert.deepEqual(result, { kind: "materialized" });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "create_comment_reply",
    "create_comment_receipt_reaction",
    "set_comment_thread_state",
  ]);
  assert.equal(receipt(linear.source()), "cross");
  assert.equal(linear.source().thread_state, "resolved");
  assert.match(linear.reply().body, /Cannot apply this request/u);
  assert.deepEqual(factSet(linear.tree).bootstrap.pendingInputIds, []);

  const replay = await writer.write({ operationId: "intent-1", disposition, view: view(linear.tree) });
  assert.deepEqual(replay, result);
  assert.equal(linear.mutations.length, 3);
});

test("answer_only writes one direct answer with a check receipt", async () => {
  const linear = new SemanticFakeLinear();
  const disposition = commentDisposition("answer_only");

  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    operationId: "intent-2",
    disposition,
    view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "materialized" });
  assert.equal(receipt(linear.source()), "check");
  assert.match(linear.reply().body, /The current target is main/u);
  assert.deepEqual(factSet(linear.tree).bootstrap.pendingInputIds, []);
});

test("needs_response performs no writes until an active Information Human Action exists", async () => {
  const linear = new SemanticFakeLinear();
  const disposition = commentDisposition("needs_response");

  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    operationId: "intent-3",
    disposition,
    view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "failed", code: "reply_information_request_missing" });
  assert.equal(linear.mutations.length, 0);
});

test("needs_response receipts the source only after the Information Human Action is visible", async () => {
  const linear = new SemanticFakeLinear();
  linear.addInformationRequest();
  const disposition = commentDisposition("needs_response");

  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    operationId: "intent-3",
    disposition,
    view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "materialized" });
  assert.equal(receipt(linear.source()), "check");
  assert.match(linear.reply().body, /Which deployment target should be used/u);
});

test("a stale source identity produces no native effects", async () => {
  const linear = new SemanticFakeLinear({ body: "The user edited this request." });
  const disposition = commentDisposition("answer_only");

  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    operationId: "intent-4",
    disposition,
    view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "failed", code: "reply_source_comment_stale" });
  assert.equal(linear.mutations.length, 0);
});

test("an unrelated human source produces no native effects", async () => {
  const linear = new SemanticFakeLinear();
  linear.source().author_id = "user-2";
  linear.source().author_user_id = "user-2";

  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    operationId: "intent-unauthorized",
    disposition: commentDisposition("answer_only"),
    view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "failed", code: "reply_source_comment_actor_invalid" });
  assert.equal(linear.mutations.length, 0);
});

test("receipt failure resumes without duplicating the accepted child reply", async () => {
  const linear = new SemanticFakeLinear({ failReceiptCreateOnce: true });
  const disposition = commentDisposition("answer_only");
  const writer = new LinearRootReconcilerReplyWriterImpl(linear);

  assert.deepEqual(await writer.write({ operationId: "intent-5", disposition, view: view(linear.tree) }), {
    kind: "failed", code: "reply_reaction_create_failed",
  });
  assert.equal(linear.replyCount(), 1);
  assert.deepEqual(await writer.write({ operationId: "intent-5", disposition, view: view(linear.tree) }), {
    kind: "materialized",
  });
  assert.equal(linear.replyCount(), 1);
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "create_comment_reply", "create_comment_receipt_reaction", "create_comment_receipt_reaction", "set_comment_thread_state",
  ]);
});

test("thread-state failure resumes without duplicating the reply or receipt", async () => {
  const linear = new SemanticFakeLinear({ failThreadStateOnce: true });
  const disposition = commentDisposition("answer_only");
  const writer = new LinearRootReconcilerReplyWriterImpl(linear);

  assert.deepEqual(await writer.write({ operationId: "intent-6", disposition, view: view(linear.tree) }), {
    kind: "failed", code: "reply_thread_state_failed",
  });
  assert.deepEqual(await writer.write({ operationId: "intent-6", disposition, view: view(linear.tree) }), {
    kind: "materialized",
  });
  assert.equal(linear.replyCount(), 1);
  assert.equal(linear.source().reactions.length, 1);
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "create_comment_reply", "create_comment_receipt_reaction", "set_comment_thread_state", "set_comment_thread_state",
  ]);
});

test("a conflicting receipt is removed and read back before the desired receipt is created", async () => {
  const linear = new SemanticFakeLinear();
  linear.setReceipt("cross");
  const disposition = commentDisposition("answer_only");

  assert.deepEqual(await new LinearRootReconcilerReplyWriterImpl(linear).write({
    operationId: "intent-7", disposition, view: view(linear.tree),
  }), { kind: "materialized" });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "create_comment_reply", "remove_comment_receipt_reaction", "create_comment_receipt_reaction", "set_comment_thread_state",
  ]);
  assert.equal(receipt(linear.source()), "check");
});

test("Finding-waiver adoption writes only a visible reply and leaves the input pending", async () => {
  const linear = new SemanticFakeLinear();
  linear.addFindingWaiverRequest();
  const disposition = commentDisposition("applied");

  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    operationId: "waiver-adoption-1", disposition, view: view(linear.tree), completion: "adoption_only",
  });

  assert.deepEqual(result, { kind: "materialized" });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["create_comment_reply"]);
  assert.equal(receipt(linear.source()), "none");
  assert.equal(linear.source().thread_state, "unresolved");
  assert.match(linear.reply().body, /^## 已应用/mu);
  assert.equal(factSet(linear.tree).bootstrap.pendingInputIds.length, 1);
});

function commentDisposition(kind: RootCommentDisposition["kind"]): RootCommentDisposition {
  const source = {
    kind: "comment_body" as const,
    commentId: "comment-1",
    commentBodyDigest: digest("Please rerun this check."),
  };
  const base = {
    sourceInputId: rootInputId("comment_body:comment-1", source.commentBodyDigest),
    source,
  };
  if (kind === "not_applied") return { ...base, kind, reason: "Cannot apply this request to the current Root." };
  if (kind === "answer_only") return { ...base, kind, answer: "The current target is main." };
  if (kind === "needs_response") return { ...base, kind, reply: "Which deployment target should be used?" };
  return { ...base, kind, summary: "The request was applied." };
}

function view(tree: LinearWorkflowTreeSnapshot): RootReconciliationView {
  return {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress",
      updatedAt: "2026-07-23T00:00:00Z", projectId: "project-1",
      priority: "normal", blockers: [], rootConductorLabels: [{ conductorShortHash: "abc123" }],
      isDelegatedToSymphony: true, isArchived: false,
    },
    tree,
    worktreeGate: { kind: "valid", repositoryIdentity: "repository-1", branch: "symphony/runs/sym-1", headRevision: "abc123", isClean: true, changedPaths: [] },
    workspace: { branch: "symphony/runs/sym-1", worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
    git: { head: "abc123", branch: "symphony/runs/sym-1", status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt: tree.observed_at,
    treeDigest: "tree-v1",
    complete: true,
  };
}

function factSet(tree: LinearWorkflowTreeSnapshot) {
  const currentView = view(tree);
  return buildRootFactSet({
    root: currentView.root,
    tree,
    worktreeGate: currentView.worktreeGate,
    convergence: {
      policy: {
        maxCyclesPerRoot: 3,
        maxSameOpenFindingCycles: 2,
        maxCycleRepairAttempts: 1,
        deadlineAt: "2026-07-30T00:00:00.000Z",
      },
      view: {
        cycleCount: 0,
        openFindingPersistence: [],
        activeCycleRepairAttempts: 0,
        isDeadlineExceeded: false,
        rootIsCanceled: false,
      },
    },
    mechanicalViolations: [],
  });
}

class SemanticFakeLinear {
  tree: LinearWorkflowTreeSnapshot;
  readonly mutations: LinearWorkflowMutationCommand[] = [];
  private nextVersion = 2;

  private failReceiptCreate: boolean;
  private failThreadState: boolean;

  constructor(input: { body?: string; failReceiptCreateOnce?: boolean; failThreadStateOnce?: boolean } = {}) {
    this.tree = {
      root_issue_id: "root-1",
      status_catalog: [{ status_id: "in-progress", name: "In Progress", category: "started", position: 1 }],
      issues: [issue("root-1", "SYM-1", undefined), issue("work-1", "SYM-2", "root-1")],
      comments: [{
        comment_id: "comment-1", issue_id: "work-1", body: input.body ?? "Please rerun this check.",
        author_kind: "human", author_id: "user-1", author_user_id: "user-1",
        thread_root_comment_id: "comment-1", thread_state: "unresolved", reactions: [],
        created_at: "2026-07-23T00:00:01Z", updated_at: "2026-07-23T00:00:01Z", remote_version: "comment-v1",
      }],
      relations: [], attachments: [], activities: [], source_manifest: [],
      coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-23T00:00:02Z",
    };
    this.failReceiptCreate = input.failReceiptCreateOnce ?? false;
    this.failThreadState = input.failThreadStateOnce ?? false;
  }

  source() {
    const value = this.tree.comments.find(({ comment_id }) => comment_id === "comment-1");
    if (!value) throw new Error("source_missing");
    return value;
  }

  reply() {
    const value = this.tree.comments.find(({ parent_comment_id, author_kind }) =>
      parent_comment_id === "comment-1" && author_kind === "symphony");
    if (!value) throw new Error("reply_missing");
    return value;
  }

  replyCount(): number {
    return this.tree.comments.filter(({ parent_comment_id, author_kind }) =>
      parent_comment_id === "comment-1" && author_kind === "symphony").length;
  }

  setReceipt(value: "check" | "cross" | "none"): void {
    this.source().reactions = value === "none" ? [] : [{
      reaction_id: `receipt-${value}`, emoji: value === "check" ? "✅" : "❌",
      actor_kind: "symphony", actor_id: "symphony-bot",
    }];
  }

  addInformationRequest(): void {
    this.tree.comments.push({
      comment_id: "information-1", issue_id: "root-1", body: "## 需要你补充信息\n\n请回复。",
      author_kind: "symphony", author_id: "symphony-bot", thread_root_comment_id: "information-1",
      thread_state: "unresolved", reactions: [], created_at: "2026-07-23T00:00:02Z",
      updated_at: "2026-07-23T00:00:02Z", remote_version: "information-v1",
    });
  }

  addFindingWaiverRequest(): void {
    const source = this.source();
    source.issue_id = "root-1";
    source.parent_comment_id = "waiver-request-1";
    source.thread_root_comment_id = "waiver-request-1";
    this.tree.comments.unshift({
      comment_id: "waiver-request-1", issue_id: "root-1", body: "## 需要你确认 Finding 豁免\n\n请确认。",
      author_kind: "symphony", author_id: "symphony-bot", thread_root_comment_id: "waiver-request-1",
      thread_state: "unresolved", reactions: [], created_at: "2026-07-23T00:00:00Z",
      updated_at: "2026-07-23T00:00:00Z", remote_version: "waiver-request-v1",
    });
  }

  async readWorkflowIssueTree() {
    return structuredClone(this.tree);
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind === "create_comment_reply") {
      const source = this.source();
      this.tree.comments.push({
        comment_id: `reply-${command.writeId}`, issue_id: source.issue_id,
        parent_comment_id: source.comment_id, thread_root_comment_id: source.thread_root_comment_id,
        thread_state: source.thread_state, reactions: [], body: command.body,
        author_kind: "symphony", author_id: "symphony-bot", author_user_id: "symphony-bot",
        created_at: "2026-07-23T00:00:03Z", updated_at: "2026-07-23T00:00:03Z", remote_version: "reply-v1",
      });
      return applied(command.writeId, source.issue_id, "reply-v1");
    }
    if (command.kind === "create_comment_receipt_reaction") {
      const source = this.source();
      if (this.failReceiptCreate) {
        this.failReceiptCreate = false;
        return { kind: "failed" as const, code: "linear_mutation_failed", summary: "failed", retryable: true };
      }
      source.reactions.push({
        reaction_id: `receipt-${command.receipt}`, emoji: command.receipt === "check" ? "✅" : "❌",
        actor_kind: "symphony", actor_id: "symphony-bot",
      });
      source.remote_version = `comment-v${this.nextVersion++}`;
      return applied(command.writeId, source.issue_id, source.remote_version);
    }
    if (command.kind === "remove_comment_receipt_reaction") {
      const source = this.source();
      source.reactions = source.reactions.filter(({ actor_kind, emoji }) =>
        actor_kind !== "symphony" || (emoji !== "✅" && emoji !== "❌"));
      source.remote_version = `comment-v${this.nextVersion++}`;
      return applied(command.writeId, source.issue_id, source.remote_version);
    }
    if (command.kind === "set_comment_thread_state") {
      if (this.failThreadState) {
        this.failThreadState = false;
        return { kind: "failed" as const, code: "linear_mutation_failed", summary: "failed", retryable: true };
      }
      for (const comment of this.tree.comments) {
        if (comment.thread_root_comment_id === command.threadRootCommentId) comment.thread_state = command.threadState;
      }
      this.source().remote_version = `comment-v${this.nextVersion++}`;
      return applied(command.writeId, this.source().issue_id, this.source().remote_version);
    }
    throw new Error(`unexpected_mutation:${command.kind}`);
  }
}

function issue(issueId: string, identifier: string, parentIssueId: string | undefined) {
  return {
    issue_id: issueId, identifier, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    ...(issueId === "root-1" ? { creator_user_id: "user-1" } : {}),
    status_id: "in-progress", status_name: "In Progress", status_category: "started" as const, status_position: 1,
    order: parentIssueId ? 1 : 0, depth: parentIssueId ? 1 : 0, title: identifier, description: identifier,
    labels: [], is_archived: false, issue_kind: issueId === "root-1" ? "root" as const : "work" as const,
    remote_version: `${issueId}-v1`, created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
  };
}

function receipt(comment: LinearWorkflowTreeSnapshot["comments"][number]): "check" | "cross" | "none" {
  const value = comment.reactions.find(({ actor_kind, emoji }) => actor_kind === "symphony" && (emoji === "✅" || emoji === "❌"));
  return value?.emoji === "✅" ? "check" : value?.emoji === "❌" ? "cross" : "none";
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function applied(writeId: string, targetIssueId: string, remoteVersion: string) {
  return { kind: "applied" as const, readBack: { writeId, targetIssueId, remoteVersion } };
}
