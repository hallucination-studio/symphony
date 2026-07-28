import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootDirective,
  RootReconciliationView,
  UserCommentReply,
  UserCommentReplySource,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { LinearRootReconcilerReplyWriterImpl } from "../internal/LinearRootReconcilerReplyWriterImpl.js";

test("reply writer materializes a native child reply and receipts the human source once", async () => {
  const linear = new FakeLinear();
  const candidate = reply();
  const writer = new LinearRootReconcilerReplyWriterImpl(linear);

  const result = await writer.write({ directive: directive(candidate), reply: candidate, view: view(linear.tree) });

  assert.deepEqual(result, { kind: "materialized" });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "create_comment_reply",
    "set_comment_receipt_reaction",
    "set_comment_thread_state",
  ]);
  const created = linear.mutations[0]!;
  assert.equal(created.kind, "create_comment_reply");
  if (created.kind !== "create_comment_reply") return;
  assert.equal(created.sourceCommentId, "comment-1");
  assert.equal(created.expectedThreadRootCommentId, "comment-1");
  assert.equal(created.expectedThreadState, "unresolved");
  assert.match(created.body, /## ✅ 已接受/u);
  assert.match(created.body, /\*\*确认\*\*\nWe received your request\./u);
  assert.doesNotMatch(created.body, /```json|root_reconciler_reply|directive-1|input-1|work-1/u);
  assert.equal(linear.source().thread_state, "resolved");
  assert.equal(receipt(linear.source()), "check");
  assert.equal(receipt(linear.reply()), "none");

  const replay = await writer.write({ directive: directive(candidate), reply: candidate, view: view(linear.tree) });
  assert.deepEqual(replay, result);
  assert.equal(linear.mutations.length, 3);
});

test("resolving the last Human Action returns the Root to In Progress", async () => {
  const linear = new FakeLinear();
  linear.setHumanActionThread("plan_approval");
  const candidate = reply();
  const writer = new LinearRootReconcilerReplyWriterImpl(linear);

  const result = await writer.write({ directive: directive(candidate), reply: candidate, view: view(linear.tree) });

  assert.deepEqual(result, { kind: "materialized" });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "create_comment_reply",
    "set_comment_receipt_reaction",
    "set_comment_thread_state",
    "update_workflow_issue",
  ]);
  assert.equal(linear.root().status_name, "In Progress");

  const replay = await writer.write({ directive: directive(candidate), reply: candidate, view: view(linear.tree) });
  assert.deepEqual(replay, result);
  assert.equal(linear.mutations.length, 4);
});

test("resolving an approval preserves a remaining information barrier", async () => {
  const linear = new FakeLinear();
  linear.setHumanActionThread("plan_approval");
  linear.addHumanActionRequest("information", "information-request");
  const candidate = reply();

  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    directive: directive(candidate), reply: candidate, view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "materialized" });
  assert.equal(linear.root().status_name, "Needs Info");
});

test("reply writer keeps an unresolved thread open without issuing a thread-state mutation", async () => {
  const linear = new FakeLinear();
  const candidate = reply({
    disposition: "follow_up_required",
    reaction: "none",
    threadAction: "keep_open",
    nextStep: "Please provide the deployment target.",
  });

  const writer = new LinearRootReconcilerReplyWriterImpl(linear);
  const result = await writer.write({
    directive: directive(candidate), reply: candidate, view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "materialized" });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["create_comment_reply"]);
  assert.equal(linear.source().thread_state, "unresolved");
  assert.equal(receipt(linear.reply()), "none");
});

test("reply writer reopens a resolved native thread from a thread-state input", async () => {
  const linear = new FakeLinear({ threadState: "resolved", remoteVersion: "comment-v2" });
  const candidate = reply({
    source: {
      kind: "comment_thread_state",
      commentId: "comment-1",
      commentRemoteVersion: "comment-v2",
      threadRootCommentId: "comment-1",
      threadState: "resolved",
    },
    disposition: "follow_up_required",
    reaction: "none",
    threadAction: "reopen",
  });

  const writer = new LinearRootReconcilerReplyWriterImpl(linear);
  const result = await writer.write({
    directive: directive(candidate), reply: candidate, view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "materialized" });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "create_comment_reply",
    "set_comment_thread_state",
  ]);
  assert.equal(linear.source().thread_state, "unresolved");

  const replay = await writer.write({
    directive: directive(candidate), reply: candidate, view: view(linear.tree),
  });

  assert.deepEqual(replay, result);
  assert.equal(linear.mutations.length, 2);
});

test("reply writer rejects a receipt for a native thread-state input", async () => {
  const linear = new FakeLinear({ threadState: "resolved", remoteVersion: "comment-v2" });
  const candidate = reply({
    source: {
      kind: "comment_thread_state",
      commentId: "comment-1",
      commentRemoteVersion: "comment-v2",
      threadRootCommentId: "comment-1",
      threadState: "resolved",
    },
    reaction: "check",
    threadAction: "reopen",
  });

  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    directive: directive(candidate), reply: candidate, view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "failed", code: "reply_thread_state_receipt_invalid" });
  assert.equal(linear.mutations.length, 0);
});

test("reply writer stops before receipt and thread writes when child reply read-back is absent", async () => {
  const linear = new FakeLinear({ omitCreatedReply: true });
  const candidate = reply();

  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    directive: directive(candidate), reply: candidate, view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "failed", code: "reply_read_back_missing" });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["create_comment_reply"]);
});

test("reply writer rejects a stale body source before writing Linear", async () => {
  const linear = new FakeLinear({ body: "The user edited this request." });
  const candidate = reply();

  const result = await new LinearRootReconcilerReplyWriterImpl(linear).write({
    directive: directive(candidate), reply: candidate, view: view(linear.tree),
  });

  assert.deepEqual(result, { kind: "failed", code: "reply_source_comment_stale" });
  assert.equal(linear.mutations.length, 0);
});

function directive(candidate: UserCommentReply): RootDirective {
  return {
    protocolVersion: 1,
    requestId: "request-1",
    rootDirectiveId: "directive-1",
    reconcilerSessionId: "session-1",
    reconcilerTurnId: "turn-1",
    modelTurn: rootModelTurn(),
    basedOnTargetRootDigest: "tree-v1",
    rationale: "The user requested a fresh check.",
    evidenceRefs: [{ referenceId: "comment-1", sourceKind: "linear_comment" }],
    consumedInputIds: [candidate.sourceInputId],
    commentReplies: [candidate],
    action: { kind: "wait", reasonCode: "runtime_condition", blockingFactRefs: [{ referenceId: "comment-1", sourceKind: "linear_comment" }] },
  };
}

function rootModelTurn(): RootDirective["modelTurn"] {
  return {
    turnRecordId: "root-1:turn-1", role: "root_reconciler", rootIssueId: "root-1",
    reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", invocationState: "confirmed",
    model: "gpt", outcome: "directive_accepted", usage: { status: "unavailable", reason: "provider_omitted" },
    terminalAt: "2026-07-24T00:00:00Z",
  };
}

function reply(overrides: Partial<UserCommentReply> = {}): UserCommentReply {
  const source = overrides.source ?? {
    kind: "comment_body" as const,
    commentId: "comment-1",
    commentBodyDigest: digest("Please rerun this check."),
  };
  return {
    replyId: replyId(source),
    sourceInputId: "input-1",
    acknowledgement: "We received your request.",
    interpretedRequest: "Please rerun Verify.",
    decidedAction: "The Root Reconciler will rerun the check.",
    nextStep: "Wait for the next Verify result.",
    disposition: "accepted",
    reaction: "check",
    threadAction: "resolve",
    ...overrides,
    source,
  };
}

function replyId(source: UserCommentReplySource): string {
  const sourceIdentity = source.kind === "comment_body"
    ? [source.kind, source.commentId, source.commentBodyDigest]
    : [source.kind, source.commentId, source.commentRemoteVersion, source.threadRootCommentId, source.threadState];
  return createHash("sha256").update(["directive-1", ...sourceIdentity].join("\0")).digest("hex");
}

function view(tree: LinearWorkflowTreeSnapshot): RootReconciliationView {
  return {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress",
      updatedAt: "2026-07-23T00:00:00Z", projectId: "project-1",
      priority: "normal", blockers: [], rootConductorLabels: [{ conductorShortHash: "abc123" }], isDelegatedToSymphony: true, isArchived: false,
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

class FakeLinear {
  tree: LinearWorkflowTreeSnapshot;
  readonly mutations: LinearWorkflowMutationCommand[] = [];
  private nextVersion = 3;

  constructor(input: { body?: string; remoteVersion?: string; threadState?: "resolved" | "unresolved"; omitCreatedReply?: boolean } = {}) {
    const body = input.body ?? "Please rerun this check.";
    this.tree = {
      root_issue_id: "root-1",
      status_catalog: [
        { status_id: "in-progress", name: "In Progress", category: "started", position: 1 },
        { status_id: "needs-approval", name: "Needs Approval", category: "started", position: 2 },
        { status_id: "needs-info", name: "Needs Info", category: "started", position: 3 },
      ],
      issues: [
        issue("root-1", "SYM-1", undefined, "Root", 0),
        issue("work-1", "SYM-2", "root-1", "Work", 1),
      ],
      comments: [{
        comment_id: "comment-1", issue_id: "work-1", body, author_kind: "human", author_id: "user-1", author_user_id: "user-1",
        thread_root_comment_id: "comment-1", thread_state: input.threadState ?? "unresolved", reactions: [],
        created_at: "2026-07-23T00:00:01Z", remote_version: input.remoteVersion ?? "comment-v1", updated_at: "2026-07-23T00:00:01Z",
      }],
      relations: [], attachments: [], activities: [], source_manifest: [], coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-23T00:00:02Z",
    };
    this.omitCreatedReply = input.omitCreatedReply ?? false;
  }

  private readonly omitCreatedReply: boolean;

  root() {
    const root = this.tree.issues.find(({ issue_id }) => issue_id === "root-1");
    if (!root) throw new Error("root_missing");
    return root;
  }

  setHumanActionThread(actionKind: "plan_approval" | "information"): void {
    const source = this.source();
    const requestId = "request-1";
    Object.assign(source, {
      issue_id: "root-1",
      parent_comment_id: requestId,
      thread_root_comment_id: requestId,
    });
    this.tree.comments.unshift(humanActionRequest(actionKind, requestId));
    Object.assign(this.root(), {
      status_id: actionKind === "information" ? "needs-info" : "needs-approval",
      status_name: actionKind === "information" ? "Needs Info" : "Needs Approval",
    });
  }

  addHumanActionRequest(actionKind: "plan_approval" | "information", requestId: string): void {
    this.tree.comments.push(humanActionRequest(actionKind, requestId));
  }

  source() {
    const source = this.tree.comments.find(({ comment_id }) => comment_id === "comment-1");
    if (!source) throw new Error("source_missing");
    return source;
  }

  reply() {
    const reply = this.tree.comments.find(({ parent_comment_id, author_kind }) =>
      parent_comment_id === "comment-1" && author_kind === "symphony");
    if (!reply) throw new Error("reply_missing");
    return reply;
  }

  async readWorkflowIssueTree() {
    return structuredClone(this.tree);
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind === "create_comment_reply") {
      if (!this.omitCreatedReply) {
        const source = this.source();
        this.tree.comments.push({
          comment_id: `reply-${command.writeId}`,
          issue_id: source.issue_id,
          parent_comment_id: source.comment_id,
          thread_root_comment_id: source.thread_root_comment_id,
          thread_state: source.thread_state,
          reactions: [],
          body: command.body,
          author_kind: "symphony",
          author_id: "symphony-bot",
          author_user_id: "symphony-bot",
          created_at: "2026-07-23T00:00:03Z",
          remote_version: "reply-v1",
          updated_at: "2026-07-23T00:00:03Z",
        });
      }
      return applied(command.writeId, "work-1", "reply-v1");
    }
    if (command.kind === "set_comment_receipt_reaction") {
      const source = this.tree.comments.find(({ comment_id }) => comment_id === command.sourceCommentId);
      if (!source) throw new Error("source_missing");
      source.reactions = source.reactions.filter(({ actor_kind, emoji }) =>
        actor_kind !== "symphony" || (emoji !== "✅" && emoji !== "❌"));
      if (command.receipt !== "none") {
        source.reactions.push({
          reaction_id: `receipt-${command.receipt}`,
          emoji: command.receipt === "check" ? "✅" : "❌",
          actor_kind: "symphony",
          actor_id: "symphony-bot",
        });
      }
      source.remote_version = `comment-v${this.nextVersion++}`;
      return applied(command.writeId, source.issue_id, source.remote_version);
    }
    if (command.kind === "set_comment_thread_state") {
      const source = this.source();
      for (const comment of this.tree.comments) {
        if (comment.comment_id === command.threadRootCommentId ||
            comment.thread_root_comment_id === command.threadRootCommentId) {
          comment.thread_state = command.threadState;
        }
      }
      source.remote_version = `comment-v${this.nextVersion++}`;
      return applied(command.writeId, source.issue_id, source.remote_version);
    }
    if (command.kind === "update_workflow_issue") {
      const root = this.root();
      const status = this.tree.status_catalog.find(({ status_id }) => status_id === command.statusId);
      if (!status) throw new Error("status_missing");
      Object.assign(root, {
        status_id: status.status_id,
        status_name: status.name,
        status_category: status.category,
        status_position: status.position,
      });
      return applied(command.writeId, root.issue_id, root.remote_version);
    }
    throw new Error(`unexpected_mutation:${command.kind}`);
  }
}

function issue(issueId: string, identifier: string, parentIssueId: string | undefined, title: string, depth: number) {
  return {
    issue_id: issueId, identifier, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    ...(issueId === "root-1" ? { creator_user_id: "user-1" } : {}),
    status_id: "in-progress", status_name: "In Progress", status_category: "started" as const, status_position: 1,
    order: depth, depth, title, description: title, labels: [], is_archived: false,
    issue_kind: issueId === "root-1" ? "root" as const : "work" as const,
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

function humanActionRequest(
  actionKind: "plan_approval" | "information",
  commentId: string,
): LinearWorkflowTreeSnapshot["comments"][number] {
  const heading = actionKind === "information" ? "需要你补充信息" : "需要你审批";
  return {
    comment_id: commentId,
    issue_id: "root-1",
    body: `## ${heading}\n\n请回复。`,
    author_kind: "symphony",
    author_id: "symphony-bot",
    thread_root_comment_id: commentId,
    thread_state: "unresolved",
    reactions: [],
    created_at: "2026-07-23T00:00:00Z",
    remote_version: `${commentId}-v1`,
    updated_at: "2026-07-23T00:00:00Z",
  };
}

function applied(writeId: string, targetIssueId: string, remoteVersion: string) {
  return { kind: "applied" as const, readBack: { writeId, targetIssueId, remoteVersion } };
}
