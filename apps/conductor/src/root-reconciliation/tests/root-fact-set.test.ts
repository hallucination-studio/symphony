import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { GitWorkspaceSnapshot } from "../../git-workspaces/api/GitWorkspaceInterface.js";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootDeltaChange } from "../api/RootReconciliationContracts.js";
import { buildRootFactSet as buildRootFactSetImpl, diffRootFactSets } from "../internal/RootFactSet.js";
import { LinearRootSafetyPolicyImpl } from "../internal/LinearRootSafetyPolicyImpl.js";

const root = {
  issueId: "root-1", identifier: "SYM-1", state: "In Progress" as const, title: "Root",
  description: "Build it", updatedAt: "2026-07-23T00:00:00Z", projectId: "project-1",
  parentIssueId: null, priority: "normal" as const, order: 0,
  blockers: [], rootConductorLabels: [], isDelegatedToSymphony: true, isArchived: false,
};

function buildRootFactSet(
  input: Omit<Parameters<typeof buildRootFactSetImpl>[0], "convergence" | "worktreeGate"> & { git: GitWorkspaceSnapshot },
) {
  const { git, ...facts } = input;
  return buildRootFactSetImpl({
    ...facts,
    worktreeGate: {
      kind: "valid",
      repositoryIdentity: "repository-1",
      branch: git.branch,
      headRevision: git.head,
      isClean: git.status.items.length === 0 && !git.status.partial && !git.status.has_more,
      changedPaths: git.status.items,
    },
    convergence: {
      policy: {
        maxCyclesPerRoot: 3,
        maxSameOpenFindingCycles: 2,
        maxCycleRepairAttempts: 0,
        deadlineAt: "2026-07-26T00:00:00.000Z",
      },
      view: {
        cycleCount: 0,
        openFindingPersistence: [],
        activeCycleRepairAttempts: 0,
        isDeadlineExceeded: false,
        rootIsCanceled: false,
      },
    },
  });
}

test("fact sets send a bootstrap snapshot and only changed current values afterward", () => {
  const first = buildRootFactSet({ root, tree: tree("Root", "root-v1", "comment-v1"), git: git("head-1"), mechanicalViolations: [] });
  const second = buildRootFactSet({ root, tree: tree("Changed", "root-v2", "comment-v1"), git: git("head-1"), mechanicalViolations: [] });
  const delta = diffRootFactSets(first, second);

  assert.equal(first.bootstrap.rootSnapshot.issues.length, 1);
  assert.equal(first.bootstrap.rootSnapshot.issues[0]?.statusId, "progress");
  const manifestIdentities = first.bootstrap.sourceManifest.map(({ sourceKind, sourceId }) => `${sourceKind}:${sourceId}`);
  assert.deepEqual(manifestIdentities, [...manifestIdentities].sort());
  assert.equal(first.bootstrap.rootDigest, delta.baseRootDigest);
  assert.equal(delta.targetRootDigest, second.bootstrap.rootDigest);
  assert.deepEqual(delta.changes.map((change) => change.kind), ["replacement"]);
  assert.equal("rootSnapshot" in delta, false);
  assert.equal(delta.changes[0]?.kind, "replacement");
  if (delta.changes[0]?.kind === "replacement" && delta.changes[0].value.kind === "issue") {
    assert.equal(delta.changes[0].value.issue.title, "Changed");
    assert.equal(delta.changes[0].replacesSourceVersionOrDigest, "root-v1");
  }
});

test("bootstrap includes the current native state for each comment thread", () => {
  const factSet = buildRootFactSet({ root, tree: tree("Root", "root-v1", "comment-v1"), git: git("head-1"), mechanicalViolations: [] });

  assert.deepEqual(factSet.bootstrap.rootSnapshot.userCommentThreadStates.find(({ commentId }) => commentId === "comment-1"), {
    commentId: "comment-1",
    commentRemoteVersion: "comment-v1",
    threadRootCommentId: "comment-1",
    threadState: "unresolved",
    actorKind: "unknown",
    observedAt: "2026-07-23T00:00:02Z",
  });
});

test("initial unresolved states and natively receipted comment inputs do not re-enter pending work", () => {
  const workflow = tree("Root", "root-v1", "comment-v1");
  const commentBodyDigest = createHash("sha256").update("User input", "utf8").digest("hex");
  const inputId = rootInputId("comment_body:comment-1", commentBodyDigest);
  const initial = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });

  assert.equal(initial.bootstrap.pendingInputIds.some((value) => value.startsWith("comment_thread_state:")), false);
  assert.ok(initial.bootstrap.pendingInputIds.includes(inputId));

  workflow.comments[0]!.reactions.push({
    reaction_id: "receipt-check",
    emoji: "✅",
    actor_kind: "symphony",
    actor_id: "symphony",
  });
  workflow.comments.push(replyComment());

  const afterReceipt = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });
  assert.equal(afterReceipt.bootstrap.pendingInputIds.includes(inputId), false);
});

test("only human semantic input facts enter pending work", () => {
  const workflow = tree("Root", "root-v1", "comment-v1");
  workflow.relations.push({
    relation_id: "relation-1", relation_kind: "relates_to", source_issue_id: "root-1", target_issue_id: "root-1",
  });
  workflow.attachments.push({
    attachment_id: "attachment-1", issue_id: "root-1", title: "Context", url: "https://example.test/context",
    source_type: "link", remote_version: "attachment-v1", created_at: "2026-07-23T00:00:01Z",
    updated_at: "2026-07-23T00:00:01Z",
  });
  workflow.activities.push({
    activity_id: "activity-1", issue_id: "root-1", activity_kinds: ["description_changed"], actor_kind: "human",
    actor_id: "user-1", updated_description: "Updated requirement", remote_version: "activity-v1",
    created_at: "2026-07-23T00:00:02Z",
  });

  const factSet = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });
  const pendingKinds = factSet.bootstrap.pendingInputIds.map((inputId) => {
    return [...factSet.entries.values()].find(({ change }) => inputIdForTest(change) === inputId)?.change.value.kind;
  });

  assert.deepEqual(pendingKinds.sort(), ["activity", "comment"]);
  assert.equal(pendingKinds.includes("issue"), false);
  assert.equal(pendingKinds.includes("relation"), false);
  assert.equal(pendingKinds.includes("attachment"), false);
});

test("a body edit produces only the comment body current value", () => {
  const before = tree("Root", "root-v1", "comment-v1");
  const after = tree("Root", "root-v1", "comment-v2");
  after.comments[0]!.body = "Edited user input";
  after.comments[0]!.updated_at = "2026-07-23T00:00:03Z";

  const delta = diffRootFactSets(
    buildRootFactSet({ root, tree: before, git: git("head-1"), mechanicalViolations: [] }),
    buildRootFactSet({ root, tree: after, git: git("head-1"), mechanicalViolations: [] }),
  );

  assert.deepEqual(delta.changes.map(({ kind }) => kind), ["replacement"]);
  assert.deepEqual(delta.pendingInputIds, [
    rootInputId("comment_body:comment-1", createHash("sha256").update("Edited user input", "utf8").digest("hex")),
  ]);
});

test("comment input identities retain each body version when the Linear comment ID reaches its limit", () => {
  const commentId = "c".repeat(128);
  const before = tree("Root", "root-v1", "comment-v1");
  const after = tree("Root", "root-v1", "comment-v2");
  const beforeComment = before.comments.find(({ author_kind }) => author_kind === "human");
  const afterComment = after.comments.find(({ author_kind }) => author_kind === "human");
  assert.ok(beforeComment && afterComment);
  beforeComment.comment_id = commentId;
  beforeComment.thread_root_comment_id = commentId;
  afterComment.comment_id = commentId;
  afterComment.thread_root_comment_id = commentId;
  afterComment.body = "Edited user input";

  const first = commentBodyInputId(buildRootFactSet({ root, tree: before, git: git("head-1"), mechanicalViolations: [] }), commentId);
  const second = commentBodyInputId(buildRootFactSet({ root, tree: after, git: git("head-1"), mechanicalViolations: [] }), commentId);

  assert.match(first, /^input:[a-f0-9]{64}$/u);
  assert.match(second, /^input:[a-f0-9]{64}$/u);
  assert.notEqual(first, second);
});

test("a native thread-state change produces only the thread-state current value", () => {
  const before = tree("Root", "root-v1", "comment-v1");
  const after = tree("Root", "root-v1", "comment-v2");
  after.comments[0]!.thread_state = "resolved";
  after.comments[0]!.updated_at = "2026-07-23T00:00:03Z";

  const delta = diffRootFactSets(
    buildRootFactSet({ root, tree: before, git: git("head-1"), mechanicalViolations: [] }),
    buildRootFactSet({ root, tree: after, git: git("head-1"), mechanicalViolations: [] }),
  );

  assert.deepEqual(delta.changes.map(({ kind }) => kind), ["replacement"]);
  assert.equal(delta.changes[0]?.sourceKind, "comment_thread");
});

test("a matching native reply thread state does not re-enter as a pending input", () => {
  const workflow = tree("Root", "root-v1", "comment-v2");
  workflow.comments[0]!.thread_state = "resolved";
  workflow.comments.push(replyComment());

  const factSet = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });

  assert.equal(factSet.entries.has("linear_comment_thread_state:comment-1"), false);
});

test("a completed Human Action thread does not re-enter after a fresh bootstrap", () => {
  const workflow = tree("Root", "root-v1");
  workflow.comments = [humanActionRequest(), humanActionReply(), humanActionResolution()];

  const factSet = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });

  assert.equal(factSet.entries.has("linear_comment_thread_state:human-request"), false);
  const humanReplyInput = rootInputId(
    "comment_body:human-reply",
    createHash("sha256").update("批准。", "utf8").digest("hex"),
  );
  assert.equal(factSet.bootstrap.pendingInputIds.includes(humanReplyInput), false);
});

test("an edited Human Action reply is pending despite an old receipt and resolution", () => {
  const workflow = tree("Root", "root-v1");
  const editedReply = humanActionReply();
  editedReply.body = "改为拒绝。";
  editedReply.remote_version = "human-reply-v3";
  editedReply.updated_at = "2026-07-23T00:04:00Z";
  workflow.comments = [humanActionRequest(), editedReply, humanActionResolution()];

  const factSet = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });
  const editedInput = rootInputId(
    "comment_body:human-reply",
    createHash("sha256").update("改为拒绝。", "utf8").digest("hex"),
  );

  assert.ok(factSet.bootstrap.pendingInputIds.includes(editedInput));
  assert.equal(factSet.entries.has("linear_comment_thread_state:human-request"), true);
});

test("a reopened Human Action request re-enters as a pending thread-state input", () => {
  const workflow = tree("Root", "root-v1");
  const reopened = humanActionRequest();
  reopened.thread_state = "unresolved";
  reopened.remote_version = "human-request-v3";
  reopened.updated_at = "2026-07-23T00:04:00Z";
  workflow.comments = [reopened, humanActionReply(), humanActionResolution()];

  const factSet = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });
  const threadState = factSet.entries.get("linear_comment_thread_state:human-request")?.change;

  assert.equal(threadState?.value.kind, "comment_thread");
  assert.ok(factSet.bootstrap.pendingInputIds.includes(rootInputId(
    "comment_thread_state:human-request:human-request:unresolved",
    "human-request-v3",
  )));
});

test("removed source facts become tombstones", () => {
  const first = buildRootFactSet({ root, tree: tree("Root", "root-v1", "comment-v1", true), git: git("head-1"), mechanicalViolations: [] });
  const second = buildRootFactSet({ root, tree: tree("Root", "root-v1", undefined, false), git: git("head-1"), mechanicalViolations: [] });
  const delta = diffRootFactSets(first, second);
  assert.ok(delta.changes.some((change) =>
    change.kind === "tombstone" && change.sourceKind === "comment" &&
    change.removesSourceVersionOrDigest === createHash("sha256").update("User input", "utf8").digest("hex")));
});

test("a completed Plan enters the next delta only as its native Issue current value", () => {
  const before = planTree(false);
  const after = planTree(true);
  const first = buildRootFactSet({ root, tree: before, git: git("head-1"), mechanicalViolations: [] });
  const second = buildRootFactSet({ root, tree: after, git: git("head-1"), mechanicalViolations: [] });
  const delta = diffRootFactSets(first, second);

  assert.deepEqual(delta.changes.map(({ kind }) => kind), ["replacement"]);
  const plan = delta.changes[0];
  assert.equal(plan?.kind, "replacement");
  if (plan?.kind === "replacement" && plan.value.kind === "issue") {
    assert.equal(plan.value.issue.issueId, "plan-1");
    assert.match(plan.value.issue.description, /Deliver the deployment workflow\./u);
  }
});

test("reconstructs archived Verify and Finding history from native Issues", () => {
  const workflow = cycleOutcomeTree();
  const factSet = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });
  const cycle = factSet.bootstrap.rootSnapshot.cycles.find(({ cycleIssue }) => cycleIssue.issueId === "cycle-1");

  assert.ok(cycle?.issues.some(({ issueId, issueKind, labels }) =>
    issueId === "verify-1" && issueKind === "verify" && labels.includes("Changes Required")));
  assert.ok(cycle?.issues.some(({ issueId, issueKind, labels }) =>
    issueId === "finding-1" && issueKind === "finding" && labels.includes("High")));
});

test("a terminal Cycle requires no persisted CycleOutcome", () => {
  const policy = new LinearRootSafetyPolicyImpl();
  const validTree = cycleOutcomeTree();
  const valid = policy.validate({ root, tree: validTree });
  assert.equal(valid.kind, "safe");
  if (valid.kind === "safe") {
    assert.equal(valid.mechanicalViolations.some(({ violationKind }) => violationKind === "multiple_nonterminal_cycles"), false);
  }
});

test("a native Symphony Markdown comment is projected without becoming human pending input", () => {
  const workflow = tree("Root", "root-v1");
  workflow.comments = [{
    comment_id: "comment-invalid", issue_id: "root-1", body: "## System output", author_kind: "symphony",
    author_id: "symphony", thread_root_comment_id: "comment-invalid", thread_state: "unresolved", reactions: [], created_at: "2026-07-23T00:00:01Z", remote_version: "comment-v1",
    updated_at: "2026-07-23T00:00:01Z",
  }];

  const facts = buildRootFactSet({ root, tree: workflow, git: git("head-1"), mechanicalViolations: [] });

  assert.equal(facts.bootstrap.rootSnapshot.userComments[0]?.body, "## System output");
  assert.equal(facts.bootstrap.pendingInputIds.includes(
    rootInputId("comment_body:comment-invalid", createHash("sha256").update("## System output", "utf8").digest("hex")),
  ), false);
});

function git(head: string) {
  return { head, branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } };
}

function humanActionRequest(): LinearWorkflowTreeSnapshot["comments"][number] {
  return {
    comment_id: "human-request", issue_id: "root-1", body: "## 需要你审批\n\n请审批 Plan。",
    author_kind: "symphony", author_id: "symphony", thread_root_comment_id: "human-request",
    thread_state: "resolved", reactions: [], created_at: "2026-07-23T00:00:00Z",
    remote_version: "human-request-v2", updated_at: "2026-07-23T00:03:00Z",
  };
}

function humanActionReply(): LinearWorkflowTreeSnapshot["comments"][number] {
  return {
    comment_id: "human-reply", issue_id: "root-1", parent_comment_id: "human-request", body: "批准。",
    author_kind: "human", author_id: "user-1", author_user_id: "user-1",
    thread_root_comment_id: "human-request", thread_state: "resolved",
    reactions: [{ reaction_id: "receipt-check", emoji: "✅", actor_kind: "symphony", actor_id: "symphony" }],
    created_at: "2026-07-23T00:01:00Z", remote_version: "human-reply-v2", updated_at: "2026-07-23T00:02:00Z",
  };
}

function humanActionResolution(): LinearWorkflowTreeSnapshot["comments"][number] {
  return {
    comment_id: "human-resolution", issue_id: "root-1", parent_comment_id: "human-reply", body: "## ✅ 已接受",
    author_kind: "symphony", author_id: "symphony", thread_root_comment_id: "human-request",
    thread_state: "resolved", reactions: [], created_at: "2026-07-23T00:02:00Z",
    remote_version: "human-resolution-v1", updated_at: "2026-07-23T00:02:00Z",
  };
}

function commentBodyInputId(factSet: ReturnType<typeof buildRootFactSet>, commentId: string): string {
  const entry = factSet.entries.get(`linear_comment_body:${commentId}`)?.change;
  if (entry?.value.kind !== "comment" || entry.value.userInput.kind !== "comment_body") {
    throw new Error("comment_body_input_missing");
  }
  return entry.value.userInput.inputId;
}

function rootInputId(sourceId: string, sourceVersion: string): string {
  return `input:${createHash("sha256").update(`${sourceId}\u0000${sourceVersion}`, "utf8").digest("hex")}`;
}

function inputIdForTest(change: RootDeltaChange): string {
  if (change.kind === "tombstone") return rootInputId(change.sourceId, change.sourceVersionOrDigest);
  switch (change.value.kind) {
    case "comment": return change.value.userInput.inputId;
    case "comment_thread": {
      const thread = change.value.threadState;
      return rootInputId(
        `comment_thread_state:${thread.commentId}:${thread.threadRootCommentId}:${thread.threadState}`,
        thread.commentRemoteVersion,
      );
    }
    default: return rootInputId(change.sourceId, change.sourceVersionOrDigest);
  }
}

function tree(title: string, rootVersion: string, commentVersion?: string, includeComment = true): LinearWorkflowTreeSnapshot {
  const userComment: LinearWorkflowTreeSnapshot["comments"][number] | undefined = includeComment && commentVersion
    ? {
        comment_id: "comment-1", issue_id: "root-1", body: "User input", author_kind: "human", author_id: "user-1",
        author_user_id: "user-1", thread_root_comment_id: "comment-1", thread_state: "unresolved", reactions: [], created_at: "2026-07-23T00:00:01Z", remote_version: commentVersion,
        updated_at: "2026-07-23T00:00:01Z",
      }
    : undefined;
  return {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "progress", name: "In Progress", category: "started", position: 1 }],
    issues: [{
      issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "progress",
      creator_user_id: "user-1",
      status_name: "In Progress", status_category: "started", status_position: 1, order: 0, depth: 0,
      title, description: "Build it", labels: [], is_archived: false, issue_kind: "root",
      remote_version: rootVersion, created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
    }],
    comments: [...(userComment ? [userComment] : [])],
    relations: [], attachments: [], activities: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-23T00:00:02Z",
  };
}

function planTree(completed: boolean): LinearWorkflowTreeSnapshot {
  const workflow = tree("Root", "root-v1");
  workflow.status_catalog.push(
    { status_id: "planning", name: "Planning", category: "started", position: 2 },
    { status_id: "review", name: "In Review", category: "started", position: 3 },
  );
  workflow.issues.push(
    {
      issue_id: "cycle-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1",
      status_id: "planning", status_name: "Planning", status_category: "started", status_position: 2, order: 1, depth: 1,
      title: "Cycle", description: "Cycle", labels: [], is_archived: false, issue_kind: "cycle", remote_version: "cycle-v1", created_at: "2026-07-23T00:00:00Z",
      updated_at: "2026-07-23T00:00:00Z",
    },
    {
      issue_id: "plan-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1",
      status_id: completed ? "review" : "planning", status_name: completed ? "In Review" : "Planning",
      status_category: "started", status_position: 3, order: 2, depth: 2, title: "Plan", description: "Plan", labels: [],
      is_archived: false, issue_kind: "plan", remote_version: completed ? "plan-v2" : "plan-v1", created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
    },
  );
  if (completed) {
    workflow.issues.find(({ issue_id }) => issue_id === "plan-1")!.description = [
      "# Plan Result",
      "## Objective",
      "Deliver the deployment workflow.",
      "## Included Scope",
      "- deployment service",
      "## Proposed Work",
      "- Implement deployment",
      "## Proposed Verification",
      "- Verify deployment",
    ].join("\n");
  }
  return workflow;
}

function cycleOutcomeTree(): LinearWorkflowTreeSnapshot {
  const workflow = planTree(true);
  const cycle = workflow.issues.find(({ issue_id }) => issue_id === "cycle-1")!;
  cycle.is_archived = true;
  cycle.status_id = "changes-required";
  cycle.status_name = "Changes Required";
  cycle.status_category = "completed";
  workflow.status_catalog.push(
    { status_id: "changes-required", name: "Changes Required", category: "completed", position: 4 },
    { status_id: "done", name: "Done", category: "completed", position: 5 },
  );
  workflow.issues.push({
    issue_id: "verify-1", identifier: "SYM-4", project_id: "project-1", parent_issue_id: "cycle-1",
    status_id: "done", status_name: "Done", status_category: "completed", status_position: 5,
    order: 3, depth: 2, title: "Verify", description: "Verification found a failure at head-1.", labels: ["symphony:kind/verify", "Changes Required"], is_archived: true,
    issue_kind: "verify", remote_version: "verify-v1", created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
  }, {
    issue_id: "finding-1", identifier: "SYM-5", project_id: "project-1", parent_issue_id: "cycle-1",
    status_id: "changes-required", status_name: "Changes Required", status_category: "completed", status_position: 4,
    order: 4, depth: 2, title: "Verification failure", description: "Fix the failing verification before retrying.",
    labels: ["symphony:kind/finding", "High"], is_archived: true, issue_kind: "finding", remote_version: "finding-v1",
    created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
  });
  workflow.relations.push({
    relation_id: "finding-source-1", relation_kind: "triggered_by", source_issue_id: "finding-1", target_issue_id: "verify-1",
  });
  return workflow;
}

function replyComment() {
  return {
    comment_id: "reply-comment-1", issue_id: "root-1", author_kind: "symphony" as const, author_id: "symphony",
    parent_comment_id: "comment-1", thread_root_comment_id: "comment-1", thread_state: "resolved" as const, reactions: [],
    created_at: "2026-07-23T00:00:03Z", remote_version: "reply-comment-v1", updated_at: "2026-07-23T00:00:03Z",
    body: "## ✅ 已接受\n\n已按你的要求处理。",
  };
}
