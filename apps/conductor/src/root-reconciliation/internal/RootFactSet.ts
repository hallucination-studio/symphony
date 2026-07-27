import { createHash } from "node:crypto";

import type { RootWorktreeGateInspection, RootWorktreeGateResult } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { rootInputId } from "./RootInputIdentity.js";
import type { DiscoveredRoot } from "../api/RootModels.js";
import type {
  MechanicalViolation,
  RootBootstrap,
  RootBootstrapSnapshot,
  RootCommentThreadState,
  RootConvergenceSnapshot,
  RootDelta,
  RootDeltaChange,
  RootFactComment,
  RootFactIssue,
  RootFactRelation,
  RootReconciliationView,
  UserCommentInput,
} from "../api/RootReconciliationContracts.js";

export interface RootFactEntry {
  key: string;
  change: RootDeltaChange;
}

export interface RootFactSet {
  bootstrap: RootBootstrap;
  entries: Map<string, RootFactEntry>;
}

export function buildRootFactSet(input: {
  root: DiscoveredRoot;
  tree: LinearWorkflowTreeSnapshot;
  worktreeGate: RootWorktreeGateResult;
  convergence: RootConvergenceSnapshot;
  mechanicalViolations: MechanicalViolation[];
}): RootFactSet {
  const manifest = new Map(input.tree.source_manifest.map((entry) => [`${entry.source_kind}:${entry.source_id}`, entry]));
  const entries = new Map<string, RootFactEntry>();
  const issues = input.tree.issues.map((issue) => toFactIssue(issue));
  const rootIssue = issues.find(({ issueId }) => issueId === input.root.issueId);
  if (!rootIssue) throw new Error("root_fact_root_issue_missing");

  for (const issue of issues) {
    const source = manifest.get(`linear_issue:${issue.issueId}`);
    add(entries, `linear_issue:${issue.issueId}`, {
      kind: "issue_current_value",
      sourceId: issue.issueId,
      sourceVersion: source?.source_version ?? issue.remoteVersion,
      actorKind: source?.actor_kind ?? "unknown",
      observedAt: input.tree.observed_at,
      issue,
    });
  }

  const userComments: RootFactComment[] = [];
  for (const comment of input.tree.comments) {
    if (comment.author_kind === "linear_integration") continue;
    const source = manifest.get(`linear_comment:${comment.comment_id}`);
    const current = toFactComment(comment);
    userComments.push(current);
    const userInput = toCommentBodyInput(current, issues, input.tree);
    add(entries, `linear_comment_body:${comment.comment_id}`, {
      kind: "comment_current_value",
      sourceId: comment.comment_id,
      sourceVersion: userInput.commentBodyDigest,
      actorKind: source?.actor_kind ?? comment.author_kind,
      observedAt: comment.updated_at,
      userInput,
    });
  }

  const userCommentThreadStates: RootCommentThreadState[] = [];
  for (const comment of input.tree.comments) {
    if (comment.comment_id !== comment.thread_root_comment_id ||
        isAcknowledgedThreadState(comment, input.tree)) continue;
    const threadState = toCommentThreadState(comment, input.tree.observed_at);
    userCommentThreadStates.push(threadState);
    add(entries, `linear_comment_thread_state:${comment.comment_id}`, {
      kind: "comment_thread_state_current_value",
      sourceId: comment.comment_id,
      sourceVersion: threadState.commentRemoteVersion,
      actorKind: threadState.actorKind,
      observedAt: threadState.observedAt,
      threadState,
    });
  }

  const relations = input.tree.relations.map(toFactRelation);
  for (const relation of relations) {
    const source = manifest.get(`linear_relation:${relation.relationId}`);
    add(entries, `linear_relation:${relation.relationId}`, {
      kind: "relation_current_value",
      sourceId: relation.relationId,
      sourceVersion: source?.source_version ?? digest(relation),
      actorKind: source?.actor_kind ?? "unknown",
      observedAt: input.tree.observed_at,
      relation,
    });
  }

  const worktreeGate = input.worktreeGate;
  add(entries, `git:${input.root.issueId}`, {
    kind: "worktree_gate_current_value",
    sourceId: `git:${input.root.issueId}`,
    sourceVersion: digest(worktreeGate),
    actorKind: "symphony",
    observedAt: input.tree.observed_at,
    worktreeGate,
  });
  add(entries, `mechanical:${input.root.issueId}`, {
    kind: "mechanical_violations_current_value",
    sourceId: `mechanical:${input.root.issueId}`,
    sourceVersion: digest(input.mechanicalViolations),
    actorKind: "symphony",
    observedAt: input.tree.observed_at,
    mechanicalViolations: input.mechanicalViolations,
  });
  add(entries, `convergence:${input.root.issueId}`, {
    kind: "convergence_current_value",
    sourceId: input.root.issueId,
    sourceVersion: digest(input.convergence),
    actorKind: "symphony",
    observedAt: input.tree.observed_at,
    convergence: input.convergence,
  });

  const cycles = input.tree.issues
    .filter((issue) => issue.issue_kind === "cycle")
    .map((cycle) => cycleObservation(cycle, input.tree, issues));
  const snapshot: RootBootstrapSnapshot = {
    root: {
      issue: rootIssue,
      objective: rootIssue.description || rootIssue.title,
      scope: rootIssue.title,
      acceptanceCriteria: [{
        criterionKey: `${rootIssue.issueId}:objective`,
        statement: rootIssue.description || rootIssue.title,
        verificationMethod: "provider-defined verification",
      }],
      constraints: [],
      rootStatus: rootIssue.status,
      convergence: input.convergence,
    },
    cycles,
    issues,
    relations,
    userComments,
    userCommentThreadStates,
    worktreeGate,
    mechanicalViolations: input.mechanicalViolations,
  };
  const sourceManifest = input.tree.source_manifest.map((source) => ({
    sourceKind: source.source_kind,
    sourceId: source.source_id,
    sourceVersion: source.source_version,
    actorKind: source.actor_kind,
    ...(source.stable_write_id ? { stableWriteId: source.stable_write_id } : {}),
  }));
  const receiptedInputIds = new Set(userComments
    .filter((comment) => isNativelyReceipted(comment, input.tree))
    .map((comment) => commentBodyInputId(comment.commentId, bodyDigest(comment.body))));
  const pendingInputIds = [...entries.values()]
    .filter(({ change }) =>
      change.actorKind !== "symphony" &&
      change.kind !== "worktree_gate_current_value" &&
      change.kind !== "mechanical_violations_current_value" &&
      (change.kind !== "comment_thread_state_current_value" || isPendingThreadState(change.threadState, input.tree)) &&
      !receiptedInputIds.has(inputIdFor(change)),
    )
    .map(({ change }) => inputIdFor(change));
  const bootstrap: RootBootstrap = {
    rootSnapshot: snapshot,
    sourceManifest,
    coverage: {
      isComplete: input.tree.coverage.is_complete,
      omissions: input.tree.coverage.omissions.map(({ source_id, reason }) => ({ sourceId: source_id, reason })),
    },
    rootDigest: digest([...entries.values()].map(({ key, change }) => ({ key, change }))),
    pendingInputIds,
  };
  return { bootstrap, entries };
}

export function viewFromFactSet(input: {
  root: DiscoveredRoot;
  tree: LinearWorkflowTreeSnapshot;
  gate: RootWorktreeGateInspection;
  factSet: RootFactSet;
}): RootReconciliationView {
  const base = {
    root: input.root,
    tree: input.tree,
    observedAt: input.tree.observed_at,
    treeDigest: input.factSet.bootstrap.rootDigest,
    complete: true as const,
  };
  return "workspace" in input.gate
    ? { ...base, worktreeGate: input.gate.result, workspace: input.gate.workspace, git: input.gate.snapshot }
    : { ...base, worktreeGate: input.gate.result };
}

export function diffRootFactSets(previous: RootFactSet, current: RootFactSet): RootDelta {
  const changes: RootDeltaChange[] = [];
  const keys = new Set([...previous.entries.keys(), ...current.entries.keys()]);
  for (const key of [...keys].sort()) {
    const before = previous.entries.get(key)?.change;
    const after = current.entries.get(key)?.change;
    if (before && after && unchangedCurrentValue(previous, current, before, after)) continue;
    if (after) changes.push(after);
    else if (before) {
      if (
        before.kind === "comment_thread_state_current_value" &&
        previous.entries.has(`linear_comment_body:${before.threadState.commentId}`)
      ) continue;
      changes.push(tombstone(before));
    }
  }
  return {
    baseRootDigest: previous.bootstrap.rootDigest,
    targetRootDigest: current.bootstrap.rootDigest,
    changes,
    pendingInputIds: changes
      .map((change) => inputIdFor(change))
      .filter((inputId) => current.bootstrap.pendingInputIds.includes(inputId)),
  };
}

function unchangedCurrentValue(
  previous: RootFactSet,
  current: RootFactSet,
  before: RootDeltaChange,
  after: RootDeltaChange,
): boolean {
  if (digest(before) === digest(after)) return true;
  if (before.kind === "comment_current_value" && after.kind === "comment_current_value") {
    return before.userInput.kind === "comment_body" && after.userInput.kind === "comment_body" &&
      before.userInput.commentBodyDigest === after.userInput.commentBodyDigest;
  }
  if (before.kind !== "comment_thread_state_current_value" || after.kind !== "comment_thread_state_current_value") {
    return false;
  }
  if (
    before.threadState.threadRootCommentId !== after.threadState.threadRootCommentId ||
    before.threadState.threadState !== after.threadState.threadState
  ) return false;

  const bodyKey = `linear_comment_body:${before.threadState.commentId}`;
  const beforeBody = previous.entries.get(bodyKey)?.change;
  const afterBody = current.entries.get(bodyKey)?.change;
  return beforeBody?.kind === "comment_current_value" && afterBody?.kind === "comment_current_value" &&
    beforeBody.userInput.kind === "comment_body" && afterBody.userInput.kind === "comment_body" &&
    beforeBody.userInput.commentBodyDigest !== afterBody.userInput.commentBodyDigest;
}

function add(entries: Map<string, RootFactEntry>, key: string, change: RootDeltaChange): void {
  entries.set(key, { key, change });
}

function tombstone(change: RootDeltaChange): RootDeltaChange {
  const base = {
    sourceId: change.sourceId,
    sourceVersion: change.sourceVersion,
    actorKind: change.actorKind,
    observedAt: change.observedAt,
  };
  if (change.kind.startsWith("issue_")) return { ...base, kind: "issue_detached" };
  if (change.kind.startsWith("comment_")) return { ...base, kind: "comment_removed" };
  if (change.kind.startsWith("relation_")) return { ...base, kind: "relation_removed" };
  return { ...base, kind: "mechanical_violations_current_value", mechanicalViolations: [] };
}

function toFactIssue(issue: LinearWorkflowTreeSnapshot["issues"][number]): RootFactIssue {
  const issueKind = issue.issue_kind;
  if (!issueKind) throw new Error("root_issue_kind_missing");
  return {
    issueId: issue.issue_id,
    issueKind,
    ...(issue.parent_issue_id ? { parentIssueId: issue.parent_issue_id } : {}),
    title: issue.title,
    description: issue.description,
    status: issue.status_name as RootFactIssue["status"],
    isArchived: issue.is_archived,
    labels: issue.labels,
    remoteVersion: issue.remote_version,
  };
}

function toFactComment(comment: LinearWorkflowTreeSnapshot["comments"][number]): RootFactComment {
  return {
    commentId: comment.comment_id,
    commentRemoteVersion: comment.remote_version,
    issueId: comment.issue_id,
    authorId: comment.author_id,
    ...(comment.author_user_id ? { authorUserId: comment.author_user_id } : {}),
    authorKind: comment.author_kind,
    ...(comment.parent_comment_id ? { parentCommentId: comment.parent_comment_id } : {}),
    threadRootCommentId: comment.thread_root_comment_id,
    threadState: comment.thread_state,
    reactions: comment.reactions.map((reaction) => ({
      reactionId: reaction.reaction_id,
      emoji: reaction.emoji,
      actorKind: reaction.actor_kind,
      actorId: reaction.actor_id,
    })),
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
}

function toCommentBodyInput(
  comment: RootFactComment,
  issues: RootFactIssue[],
  tree: LinearWorkflowTreeSnapshot,
): Extract<UserCommentInput, { kind: "comment_body" }> {
  const issue = issues.find(({ issueId }) => issueId === comment.issueId);
  if (!issue) throw new Error("root_comment_issue_missing");
  const cycleIssueId = cycleForIssue(comment.issueId, tree);
  const commentBodyDigest = bodyDigest(comment.body);
  return {
    kind: "comment_body",
    inputId: commentBodyInputId(comment.commentId, commentBodyDigest),
    commentId: comment.commentId,
    commentBodyDigest,
    issueId: comment.issueId,
    issueKind: issue.issueKind,
    ...(cycleIssueId ? { cycleIssueId } : {}),
    authorKind: comment.authorKind === "symphony" ? "unknown" : comment.authorKind,
    authorId: comment.authorId,
    ...(comment.authorUserId ? { authorUserId: comment.authorUserId } : {}),
    body: comment.body,
    threadRootCommentId: comment.threadRootCommentId,
    threadState: comment.threadState,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function toCommentThreadState(
  comment: LinearWorkflowTreeSnapshot["comments"][number],
  observedAt: string,
): RootCommentThreadState {
  return {
    commentId: comment.comment_id,
    commentRemoteVersion: comment.remote_version,
    threadRootCommentId: comment.thread_root_comment_id,
    threadState: comment.thread_state,
    // Linear exposes the current resolved state but not the resolving actor.
    actorKind: "unknown",
    observedAt,
  };
}

function isPendingThreadState(
  threadState: RootCommentThreadState,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  const comment = tree.comments.find(({ comment_id }) => comment_id === threadState.commentId);
  return Boolean(
    comment &&
    (threadState.threadState !== "unresolved" || comment.created_at !== comment.updated_at),
  );
}

function isAcknowledgedThreadState(
  comment: LinearWorkflowTreeSnapshot["comments"][number],
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  return tree.comments.some((reply) =>
    reply.parent_comment_id === comment.comment_id &&
    reply.thread_root_comment_id === comment.thread_root_comment_id &&
    reply.author_kind === "symphony" &&
    reply.body.trim().length > 0);
}

function isNativelyReceipted(comment: RootFactComment, tree: LinearWorkflowTreeSnapshot): boolean {
  if (comment.authorKind !== "human" || !comment.authorUserId || comment.authorId !== comment.authorUserId) return false;
  const receipts = new Set(comment.reactions
    .filter(({ actorKind, emoji }) => actorKind === "symphony" && (emoji === "✅" || emoji === "❌"))
    .map(({ emoji }) => emoji));
  return receipts.size === 1 && tree.comments.some((reply) =>
    reply.parent_comment_id === comment.commentId &&
    reply.thread_root_comment_id === comment.threadRootCommentId &&
    reply.author_kind === "symphony" &&
    reply.body.trim().length > 0);
}

function cycleForIssue(issueId: string, tree: LinearWorkflowTreeSnapshot): string | undefined {
  let current = tree.issues.find(({ issue_id }) => issue_id === issueId);
  const visited = new Set<string>();
  while (current && !visited.has(current.issue_id)) {
    visited.add(current.issue_id);
    if (current.issue_kind === "cycle") return current.issue_id;
    current = current.parent_issue_id
      ? tree.issues.find(({ issue_id }) => issue_id === current!.parent_issue_id)
      : undefined;
  }
  return undefined;
}

function toFactRelation(relation: LinearWorkflowTreeSnapshot["relations"][number]): RootFactRelation {
  return { relationId: relation.relation_id, relationKind: relation.relation_kind, sourceIssueId: relation.source_issue_id, targetIssueId: relation.target_issue_id };
}

function cycleObservation(
  cycle: LinearWorkflowTreeSnapshot["issues"][number],
  tree: LinearWorkflowTreeSnapshot,
  issues: RootFactIssue[],
) {
  const descendants = new Set<string>();
  for (const issue of tree.issues) {
    let current = issue.parent_issue_id;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (current === cycle.issue_id) {
        descendants.add(issue.issue_id);
        break;
      }
      current = tree.issues.find(({ issue_id }) => issue_id === current)?.parent_issue_id;
    }
  }
  const cycleIssues = issues.filter(({ issueId }) => descendants.has(issueId));
  const cycleRelations = tree.relations
    .filter((relation) => descendants.has(relation.source_issue_id) && descendants.has(relation.target_issue_id))
    .map(toFactRelation);
  return {
    cycleIssue: toFactIssue(cycle),
    cycleStatus: cycle.status_name as RootFactIssue["status"],
    isArchived: cycle.is_archived,
    issues: cycleIssues,
    relations: cycleRelations,
  };
}

function inputIdFor(change: RootDeltaChange): string {
  if (change.kind === "comment_current_value") return change.userInput.inputId;
  if (change.kind === "comment_thread_state_current_value") {
    return threadStateInputId(change.threadState);
  }
  return rootInputId(change.sourceId, change.sourceVersion);
}

function commentBodyInputId(commentId: string, commentBodyDigest: string): string {
  return rootInputId(`comment_body:${commentId}`, commentBodyDigest);
}

function threadStateInputId(threadState: RootCommentThreadState): string {
  return rootInputId(
    `comment_thread_state:${threadState.commentId}:${threadState.threadRootCommentId}:${threadState.threadState}`,
    threadState.commentRemoteVersion,
  );
}

function bodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
