import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { LinearClient } from "@linear/sdk";

const execFile = promisify(execFileCallback);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_ROOTS = 64;
const MAX_REPOSITORIES = 64;
const MAX_ISSUES_PER_ROOT = 512;
const MAX_COMMENTS_PER_ROOT = 4096;
const MAX_RELATIONS_PER_ROOT = 1024;
const MAX_ACTIVITY_PER_ISSUE = 2048;
const MAX_CONNECTION_NODES = 4096;
const MAX_REACTIONS = 256;
const MAX_TEXT = 32_768;
const MAX_CHANGED_PATHS = 1024;
const MAX_GIT_OUTPUT_BYTES = 1_048_576;
const PAGE_SIZE = 100;
const SYMPHONY_BLOCK = /(?:^|\r?\n)[ \t]*```symphony[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```(?=\r?\n|$)/giu;

export async function readFreshE2EEvidenceSnapshot({
  root_issue_ids: rootIssueIds,
  repository_contexts: repositoryContexts,
  createLinearClient,
  linear_access_token: linearAccessToken,
  readGitEvidence = readFreshGitEvidence,
  observedAt = () => new Date().toISOString(),
} = {}) {
  const input = snapshotInput({
    rootIssueIds,
    repositoryContexts,
    createLinearClient,
    linearAccessToken,
    readGitEvidence,
    observedAt,
  });
  const observedAtValue = timestamp(input.observedAt(), "fresh_evidence_observed_at_invalid");

  let client;
  try {
    client = await input.createLinearClient();
    if (!client || typeof client.issue !== "function") throw new Error("invalid client");
  } catch {
    return incomplete(observedAtValue, input.rootIssueIds[0], "fresh_linear_coverage_incomplete");
  }

  const rootTrees = [];
  for (const rootIssueId of input.rootIssueIds) {
    try {
      rootTrees.push(await readRootTree(client, rootIssueId));
    } catch {
      return incomplete(observedAtValue, rootIssueId, "fresh_linear_coverage_incomplete");
    }
  }

  const repositories = [];
  for (const context of input.repositoryContexts) {
    try {
      repositories.push(await normalizedGitEvidence(input.readGitEvidence, context));
    } catch {
      return incomplete(observedAtValue, context.repository_identity, "fresh_git_coverage_incomplete");
    }
  }

  return deepFreeze({
    kind: "complete",
    observed_at: observedAtValue,
    root_trees: rootTrees,
    repositories,
  });
}

export async function readFreshGitEvidence(context) {
  try {
    return await readFreshGitEvidenceInner(context);
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("fresh_git_")) throw error;
    throw stableError("fresh_git_read_failed");
  }
}

async function readFreshGitEvidenceInner(context) {
  const repository = repositoryContext(context);
  const repositoryRoot = await realpath(repository.repository_root);
  const gitRoot = await realpath(await git(["-C", repositoryRoot, "rev-parse", "--show-toplevel"]));
  if (gitRoot !== repositoryRoot) throw stableError("fresh_git_repository_root_invalid");

  const [branch, headCommit, baseCommit, changedPaths, diffCheck, worktree, remoteName] = await Promise.all([
    git(["-C", repositoryRoot, "branch", "--show-current"]),
    git(["-C", repositoryRoot, "rev-parse", "HEAD"]),
    git(["-C", repositoryRoot, "merge-base", repository.base_branch, "HEAD"]),
    changedPathsSince(repositoryRoot, repository.base_branch),
    gitDiffCheck(repositoryRoot, repository.base_branch),
    worktreeSnapshot(repositoryRoot),
    gitOptional(["-C", repositoryRoot, "remote", "get-url", "origin"]),
  ]);
  if (!BRANCH.test(branch) || !COMMIT.test(headCommit) || !COMMIT.test(baseCommit)) {
    throw stableError("fresh_git_repository_fact_invalid");
  }

  let remoteHead = null;
  if (remoteName !== null) {
    const remote = await git(["-C", repositoryRoot, "ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    if (remote.length > 0) {
      const [candidate] = remote.split(/\s+/u);
      if (!COMMIT.test(candidate)) throw stableError("fresh_git_delivery_invalid");
      remoteHead = candidate;
    }
  }

  return deepFreeze({
    repository_identity: repository.repository_identity,
    branch,
    head_commit: headCommit,
    base_branch: repository.base_branch,
    base_commit: baseCommit,
    changed_paths: changedPaths,
    diff_check: diffCheck,
    worktree,
    delivery: {
      remote_name: remoteName === null ? null : "origin",
      branch,
      remote_head: remoteHead,
      is_delivered: remoteHead === headCommit,
    },
  });
}

async function readRootTree(client, rootIssueId) {
  const rootIssue = await client.issue(rootIssueId);
  if (!rootIssue || rootIssue.id !== rootIssueId) throw stableError("fresh_linear_root_invalid");

  const rootTeam = await readTeam(rootIssue);
  const statusCatalog = await readStatusCatalog(rootTeam);
  const issues = [];
  const comments = [];
  const relations = [];
  const activity = [];
  const managedBlocks = [];
  const issueIds = new Set();
  const commentIds = new Set();

  await visitIssue(rootIssue, null);
  finalizeThreadState(comments);
  const statusIds = new Set(statusCatalog.map(({ status_id: statusId }) => statusId));
  if (issues.some(({ status }) => !statusIds.has(status.status_id))) {
    throw stableError("fresh_linear_issue_status_outside_catalog");
  }

  return deepFreeze({
    root_issue_id: rootIssueId,
    status_catalog: statusCatalog,
    issues,
    comments,
    relations,
    activity,
    managed_blocks: managedBlocks,
  });

  async function visitIssue(issue, parentIssueId) {
    const issueSnapshot = await readIssue(issue, parentIssueId, rootTeam.id);
    if (issueIds.has(issueSnapshot.issue_id)) throw stableError("fresh_linear_issue_duplicate");
    if (issues.length >= MAX_ISSUES_PER_ROOT) throw stableError("fresh_linear_issue_limit_exceeded");
    issueIds.add(issueSnapshot.issue_id);
    issues.push(issueSnapshot.value);
    managedBlocks.push(...managedBlocksFromText({
      source_kind: "issue_description",
      source_id: issueSnapshot.issue_id,
      source_version: issueSnapshot.remote_version,
      actor: issueSnapshot.creator,
      body: issueSnapshot.value.description,
    }));

    const [outgoing, incoming, history, stateHistory, issueComments, children] = await Promise.all([
      readAllNodes(() => issue.relations({ first: PAGE_SIZE, includeArchived: true }), MAX_RELATIONS_PER_ROOT),
      readAllNodes(() => issue.inverseRelations({ first: PAGE_SIZE, includeArchived: true }), MAX_RELATIONS_PER_ROOT),
      readAllNodes(() => issue.history({ first: PAGE_SIZE, includeArchived: true }), MAX_ACTIVITY_PER_ISSUE),
      readAllNodes(() => issue.stateHistory({ first: PAGE_SIZE }), MAX_ACTIVITY_PER_ISSUE),
      readAllNodes(() => issue.comments({ first: PAGE_SIZE, includeArchived: true }), MAX_COMMENTS_PER_ROOT),
      readAllNodes(() => issue.children({ first: PAGE_SIZE, includeArchived: true }), MAX_ISSUES_PER_ROOT),
    ]);

    if (relations.length + outgoing.length + incoming.length > MAX_RELATIONS_PER_ROOT) {
      throw stableError("fresh_linear_connection_incomplete");
    }

    relations.push(
      ...outgoing.map((relation) => relationSnapshot(relation, "outgoing", issueSnapshot.issue_id)),
      ...incoming.map((relation) => relationSnapshot(relation, "incoming", issueSnapshot.issue_id)),
    );
    activity.push(deepFreeze({
      issue_id: issueSnapshot.issue_id,
      history: history.map(historySnapshot),
      state_history: stateHistory.map(stateHistorySnapshot),
    }));
    for (const comment of issueComments) await visitComment(comment, issueSnapshot.issue_id);
    for (const child of children) await visitIssue(child, issueSnapshot.issue_id);
  }

  async function visitComment(comment, expectedIssueId) {
    const commentSnapshot = await readComment(comment, expectedIssueId);
    if (commentIds.has(commentSnapshot.comment_id)) return;
    if (comments.length >= MAX_COMMENTS_PER_ROOT) throw stableError("fresh_linear_comment_limit_exceeded");
    commentIds.add(commentSnapshot.comment_id);
    comments.push(commentSnapshot.value);
    managedBlocks.push(...managedBlocksFromText({
      source_kind: "comment",
      source_id: commentSnapshot.comment_id,
      source_version: commentSnapshot.remote_version,
      actor: commentSnapshot.author,
      body: commentSnapshot.value.body,
    }));
    if (typeof comment.children !== "function") throw stableError("fresh_linear_comment_thread_unreadable");
    const children = await readAllNodes(() => comment.children({ first: PAGE_SIZE, includeArchived: true }), MAX_COMMENTS_PER_ROOT);
    for (const child of children) await visitComment(child, expectedIssueId);
  }
}

async function readIssue(issue, parentIssueId, rootTeamId) {
  if (!issue || typeof issue !== "object" || !identifier(issue.id) || !identifier(issue.identifier) ||
      !boundedText(issue.title) || !boundedText(issue.description, { nonempty: false }) || !priority(issue.priority) ||
      typeof issue.labels !== "function" || typeof issue.children !== "function" || typeof issue.comments !== "function" ||
      typeof issue.relations !== "function" || typeof issue.inverseRelations !== "function" ||
      typeof issue.history !== "function" || typeof issue.stateHistory !== "function") {
    throw stableError("fresh_linear_issue_invalid");
  }
  const [team, state, labels, creator, reactions] = await Promise.all([
    readTeam(issue),
    resolveObject(issue.state, "fresh_linear_issue_state_invalid"),
    readAllNodes(() => issue.labels({ first: PAGE_SIZE, includeArchived: true }), MAX_CONNECTION_NODES),
    actorSnapshotOptional(issue.creator),
    reactionSnapshots(issue.reactions),
  ]);
  if (team.id !== rootTeamId || !state || !identifier(state.id) || !boundedText(state.name) || !boundedText(state.type)) {
    throw stableError("fresh_linear_issue_invalid");
  }
  const normalizedLabels = labels.map((label) => {
    if (!label || !identifier(label.id) || !boundedText(label.name)) throw stableError("fresh_linear_label_invalid");
    return deepFreeze({ label_id: label.id, name: label.name });
  });
  const updatedAt = timestamp(issue.updatedAt, "fresh_linear_issue_version_invalid");
  return {
    issue_id: issue.id,
    remote_version: updatedAt,
    creator,
    value: {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      parent_issue_id: parentIssueId,
      remote_version: updatedAt,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      status: deepFreeze({ status_id: state.id, name: state.name, category: state.type }),
      labels: normalizedLabels,
      reactions,
      creator,
      created_at: timestamp(issue.createdAt, "fresh_linear_issue_created_at_invalid"),
      updated_at: updatedAt,
      archived_at: nullableTimestamp(issue.archivedAt, "fresh_linear_issue_archived_at_invalid"),
      is_archived: issue.archivedAt !== null && issue.archivedAt !== undefined,
    },
  };
}

async function readComment(comment, expectedIssueId) {
  if (!comment || typeof comment !== "object" || !identifier(comment.id) || comment.issueId !== expectedIssueId ||
      (comment.parentId !== null && comment.parentId !== undefined && !identifier(comment.parentId)) ||
      !boundedText(comment.body) || !Array.isArray(comment.reactions)) {
    throw stableError("fresh_linear_comment_invalid");
  }
  const [author, reactions] = await Promise.all([
    actorSnapshot(comment),
    reactionSnapshots(comment.reactions),
  ]);
  const updatedAt = timestamp(comment.updatedAt, "fresh_linear_comment_version_invalid");
  return {
    comment_id: comment.id,
    remote_version: updatedAt,
    author,
    value: {
      comment_id: comment.id,
      issue_id: comment.issueId,
      parent_comment_id: comment.parentId ?? null,
      remote_version: updatedAt,
      thread_root_comment_id: comment.parentId ?? comment.id,
      thread_state: comment.resolvedAt === null || comment.resolvedAt === undefined ? "unresolved" : "resolved",
      body: comment.body,
      author,
      reactions,
      created_at: timestamp(comment.createdAt, "fresh_linear_comment_created_at_invalid"),
      updated_at: updatedAt,
      archived_at: nullableTimestamp(comment.archivedAt, "fresh_linear_comment_archived_at_invalid"),
      resolved_at: nullableTimestamp(comment.resolvedAt, "fresh_linear_comment_resolved_at_invalid"),
    },
  };
}

async function readTeam(issue) {
  const team = await resolveObject(issue.team, "fresh_linear_team_invalid");
  if (!identifier(team.id) || typeof team.states !== "function") throw stableError("fresh_linear_team_invalid");
  return team;
}

async function readStatusCatalog(team) {
  const states = await readAllNodes(() => team.states({ first: PAGE_SIZE, includeArchived: true }), MAX_CONNECTION_NODES);
  const seen = new Set();
  const catalog = states.map((state) => {
    if (!state || !identifier(state.id) || !boundedText(state.name) || !boundedText(state.type) || seen.has(state.id)) {
      throw stableError("fresh_linear_status_catalog_invalid");
    }
    seen.add(state.id);
    return deepFreeze({ status_id: state.id, name: state.name, category: state.type });
  });
  if (catalog.length === 0) throw stableError("fresh_linear_status_catalog_invalid");
  return catalog;
}

function relationSnapshot(relation, direction, observedFromIssueId) {
  if (!relation || !identifier(relation.id) || !boundedText(relation.type) || !identifier(relation.issueId) || !identifier(relation.relatedIssueId)) {
    throw stableError("fresh_linear_relation_invalid");
  }
  return deepFreeze({
    relation_id: relation.id,
    direction,
    observed_from_issue_id: observedFromIssueId,
    relation_kind: relation.type,
    issue_id: relation.issueId,
    related_issue_id: relation.relatedIssueId,
    remote_version: timestamp(relation.updatedAt, "fresh_linear_relation_version_invalid"),
    created_at: timestamp(relation.createdAt, "fresh_linear_relation_created_at_invalid"),
    updated_at: timestamp(relation.updatedAt, "fresh_linear_relation_version_invalid"),
    archived_at: nullableTimestamp(relation.archivedAt, "fresh_linear_relation_archived_at_invalid"),
  });
}

function historySnapshot(history) {
  if (!history || !identifier(history.id)) throw stableError("fresh_linear_activity_invalid");
  return deepFreeze({
    activity_id: history.id,
    actor_id: nullableIdentifier(history.actorId),
    created_at: timestamp(history.createdAt, "fresh_linear_activity_created_at_invalid"),
    updated_at: timestamp(history.updatedAt, "fresh_linear_activity_updated_at_invalid"),
    from_priority: nullablePriority(history.fromPriority),
    to_priority: nullablePriority(history.toPriority),
    from_state_id: nullableIdentifier(history.fromStateId),
    to_state_id: nullableIdentifier(history.toStateId),
    from_title: nullableText(history.fromTitle),
    to_title: nullableText(history.toTitle),
    updated_description: history.updatedDescription === true,
    is_archived: history.archived === true,
  });
}

function stateHistorySnapshot(span) {
  if (!span || !identifier(span.id) || !identifier(span.stateId)) throw stableError("fresh_linear_state_history_invalid");
  return deepFreeze({
    state_span_id: span.id,
    state_id: span.stateId,
    started_at: timestamp(span.startedAt, "fresh_linear_state_history_started_at_invalid"),
    ended_at: nullableTimestamp(span.endedAt, "fresh_linear_state_history_ended_at_invalid"),
  });
}

async function reactionSnapshots(reactions) {
  if (!Array.isArray(reactions) || reactions.length > MAX_REACTIONS) throw stableError("fresh_linear_reaction_invalid");
  return Promise.all(reactions.map(async (reaction) => {
    if (!reaction || !identifier(reaction.id) || !boundedText(reaction.emoji)) throw stableError("fresh_linear_reaction_invalid");
    return deepFreeze({
      reaction_id: reaction.id,
      emoji: reaction.emoji,
      actor: await actorSnapshot(reaction),
      created_at: timestamp(reaction.createdAt, "fresh_linear_reaction_created_at_invalid"),
      updated_at: timestamp(reaction.updatedAt, "fresh_linear_reaction_updated_at_invalid"),
      archived_at: nullableTimestamp(reaction.archivedAt, "fresh_linear_reaction_archived_at_invalid"),
    });
  }));
}

async function actorSnapshotOptional(value) {
  if (value === undefined || value === null) return null;
  const actor = await resolveObject(value, "fresh_linear_actor_invalid");
  if (!identifier(actor.id)) throw stableError("fresh_linear_actor_invalid");
  return deepFreeze({ actor_id: actor.id, actor_kind: "user" });
}

async function actorSnapshot(source) {
  const candidates = [];
  for (const [field, actorKind] of [["user", "user"], ["botActor", "bot"], ["externalUser", "external_user"]]) {
    if (!(field in source)) continue;
    const value = source[field];
    if (value === undefined || value === null) continue;
    const actor = await resolveObject(value, "fresh_linear_actor_invalid");
    if (!identifier(actor.id)) throw stableError("fresh_linear_actor_invalid");
    candidates.push({ actor_id: actor.id, actor_kind: actorKind });
  }
  if (candidates.length !== 1) throw stableError("fresh_linear_actor_invalid");
  return deepFreeze(candidates[0]);
}

function managedBlocksFromText({ source_kind: sourceKind, source_id: sourceId, source_version: sourceVersion, actor, body }) {
  const blocks = [];
  SYMPHONY_BLOCK.lastIndex = 0;
  let match;
  while ((match = SYMPHONY_BLOCK.exec(body)) !== null) {
    let record;
    try {
      record = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record) || !boundedText(record.kind) ||
        !Number.isInteger(record.version) || record.version < 1) continue;
    blocks.push(deepFreeze({
      source_kind: sourceKind,
      source_id: sourceId,
      source_version: sourceVersion,
      actor,
      record,
    }));
  }
  return blocks;
}

function finalizeThreadState(comments) {
  const byId = new Map(comments.map((comment) => [comment.comment_id, comment]));
  for (const comment of comments) {
    let root = comment;
    const visited = new Set([comment.comment_id]);
    while (root.parent_comment_id !== null) {
      const parent = byId.get(root.parent_comment_id);
      if (!parent || visited.has(parent.comment_id)) throw stableError("fresh_linear_comment_thread_invalid");
      visited.add(parent.comment_id);
      root = parent;
    }
    comment.thread_root_comment_id = root.comment_id;
    comment.thread_state = root.resolved_at === null ? "unresolved" : "resolved";
  }
}

async function readAllNodes(readPage, maximum) {
  const connection = await readPage();
  if (!connection || typeof connection !== "object" || !Array.isArray(connection.nodes) || !connection.pageInfo ||
      typeof connection.pageInfo.hasNextPage !== "boolean") {
    throw stableError("fresh_linear_connection_invalid");
  }
  while (connection.pageInfo.hasNextPage) {
    if (connection.nodes.length >= maximum || typeof connection.fetchNext !== "function") {
      throw stableError("fresh_linear_connection_incomplete");
    }
    await connection.fetchNext();
    if (!Array.isArray(connection.nodes) || !connection.pageInfo || typeof connection.pageInfo.hasNextPage !== "boolean") {
      throw stableError("fresh_linear_connection_invalid");
    }
  }
  if (connection.nodes.length > maximum) throw stableError("fresh_linear_connection_incomplete");
  return connection.nodes;
}

function snapshotInput({ rootIssueIds, repositoryContexts, createLinearClient, linearAccessToken, readGitEvidence, observedAt }) {
  if (!uniqueIdentifiers(rootIssueIds, MAX_ROOTS) || !Array.isArray(repositoryContexts) || repositoryContexts.length === 0 ||
      repositoryContexts.length > MAX_REPOSITORIES || new Set(repositoryContexts.map((context) => context?.repository_identity)).size !== repositoryContexts.length ||
      !repositoryContexts.every((context) => validRepositoryContext(context)) || typeof readGitEvidence !== "function" ||
      typeof observedAt !== "function") {
    throw stableError("fresh_evidence_input_invalid");
  }
  if (createLinearClient !== undefined && typeof createLinearClient !== "function") throw stableError("fresh_evidence_input_invalid");
  if (createLinearClient === undefined && !token(linearAccessToken)) throw stableError("fresh_evidence_input_invalid");
  return {
    rootIssueIds: [...rootIssueIds],
    repositoryContexts: repositoryContexts.map(repositoryContext),
    createLinearClient: createLinearClient ?? (() => new LinearClient({ accessToken: linearAccessToken })),
    readGitEvidence,
    observedAt,
  };
}

async function normalizedGitEvidence(readGitEvidence, context) {
  const evidence = await readGitEvidence(context);
  if (!evidence || typeof evidence !== "object" || evidence.repository_identity !== context.repository_identity ||
      !BRANCH.test(evidence.branch) || !COMMIT.test(evidence.head_commit) || evidence.base_branch !== context.base_branch ||
      !COMMIT.test(evidence.base_commit) || !Array.isArray(evidence.changed_paths) || evidence.changed_paths.length > MAX_CHANGED_PATHS ||
      !evidence.changed_paths.every((entry) => boundedText(entry)) || !["passed", "failed"].includes(evidence.diff_check) ||
      !evidence.worktree || typeof evidence.worktree !== "object" || typeof evidence.worktree.is_clean !== "boolean" ||
      !SHA256.test(evidence.worktree.status_sha256) ||
      !evidence.delivery || typeof evidence.delivery !== "object" ||
      (evidence.delivery.remote_name !== null && evidence.delivery.remote_name !== "origin") || evidence.delivery.branch !== evidence.branch ||
      (evidence.delivery.remote_head !== null && !COMMIT.test(evidence.delivery.remote_head)) ||
      typeof evidence.delivery.is_delivered !== "boolean" ||
      evidence.delivery.is_delivered !== (evidence.delivery.remote_head === evidence.head_commit)) {
    throw stableError("fresh_git_evidence_invalid");
  }
  return deepFreeze({
    repository_identity: evidence.repository_identity,
    branch: evidence.branch,
    head_commit: evidence.head_commit,
    base_branch: evidence.base_branch,
    base_commit: evidence.base_commit,
    changed_paths: [...evidence.changed_paths],
    diff_check: evidence.diff_check,
    worktree: {
      is_clean: evidence.worktree.is_clean,
      status_sha256: evidence.worktree.status_sha256,
    },
    delivery: {
      remote_name: evidence.delivery.remote_name,
      branch: evidence.delivery.branch,
      remote_head: evidence.delivery.remote_head,
      is_delivered: evidence.delivery.is_delivered,
    },
  });
}

async function changedPathsSince(repositoryRoot, baseBranch) {
  const output = await git(["-C", repositoryRoot, "diff", "--name-only", "-z", `${baseBranch}...HEAD`]);
  const paths = output.length === 0 ? [] : output.slice(0, -1).split("\0");
  if (paths.length > MAX_CHANGED_PATHS || !paths.every((entry) => boundedText(entry))) {
    throw stableError("fresh_git_diff_invalid");
  }
  return paths;
}

async function gitDiffCheck(repositoryRoot, baseBranch) {
  const outcomes = await Promise.all([
    oneGitDiffCheck(["-C", repositoryRoot, "diff", "--check", `${baseBranch}...HEAD`]),
    oneGitDiffCheck(["-C", repositoryRoot, "diff", "--check"]),
    oneGitDiffCheck(["-C", repositoryRoot, "diff", "--cached", "--check"]),
  ]);
  return outcomes.every((outcome) => outcome === "passed") ? "passed" : "failed";
}

async function oneGitDiffCheck(arguments_) {
  try {
    await git(arguments_);
    return "passed";
  } catch (error) {
    if (Number.isInteger(error?.exit_code)) return "failed";
    throw error;
  }
}

async function worktreeSnapshot(repositoryRoot) {
  const status = await git(["-C", repositoryRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return {
    is_clean: status.length === 0,
    status_sha256: createHash("sha256").update(status).digest("hex"),
  };
}

async function git(arguments_) {
  try {
    const { stdout } = await execFile("git", arguments_, { maxBuffer: MAX_GIT_OUTPUT_BYTES });
    return stdout.trim();
  } catch (error) {
    throw stableErrorWithExit("fresh_git_read_failed", error);
  }
}

async function gitOptional(arguments_) {
  try {
    return await git(arguments_);
  } catch (error) {
    if (error.code === "fresh_git_read_failed" && error.exit_code === 2) return null;
    throw error;
  }
}

function repositoryContext(value) {
  if (!validRepositoryContext(value)) throw stableError("fresh_git_context_invalid");
  return {
    repository_identity: value.repository_identity,
    repository_root: value.repository_root,
    base_branch: value.base_branch,
  };
}

function validRepositoryContext(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && identifier(value.repository_identity) &&
    typeof value.repository_root === "string" && value.repository_root.length > 0 && value.repository_root.length <= 4096 &&
    !value.repository_root.includes("\0") && BRANCH.test(value.base_branch);
}

function incomplete(observedAt, sourceId, reasonCode) {
  return deepFreeze({
    kind: "incomplete",
    observed_at: observedAt,
    omissions: [{ source_id: sourceId, reason_code: reasonCode }],
  });
}

function resolveObject(value, code) {
  return Promise.resolve(value).then((result) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) throw stableError(code);
    return result;
  }, () => { throw stableError(code); });
}

function nullableIdentifier(value) {
  if (value === undefined || value === null) return null;
  if (!identifier(value)) throw stableError("fresh_linear_activity_invalid");
  return value;
}

function nullablePriority(value) {
  if (value === undefined || value === null) return null;
  if (!priority(value)) throw stableError("fresh_linear_activity_invalid");
  return value;
}

function nullableText(value) {
  if (value === undefined || value === null) return null;
  if (!boundedText(value)) throw stableError("fresh_linear_activity_invalid");
  return value;
}

function nullableTimestamp(value, code) {
  if (value === undefined || value === null) return null;
  return timestamp(value, code);
}

function timestamp(value, code) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw stableError(code);
  return date.toISOString();
}

function uniqueIdentifiers(value, maximum) {
  return Array.isArray(value) && value.length > 0 && value.length <= maximum && value.every(identifier) && new Set(value).size === value.length;
}

function boundedText(value, { nonempty = true } = {}) {
  return typeof value === "string" && value.length <= MAX_TEXT && !value.includes("\0") && (!nonempty || value.length > 0);
}

function priority(value) {
  return Number.isInteger(value) && value >= 0 && value <= 4;
}

function token(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function stableErrorWithExit(code, error) {
  const stable = stableError(code);
  if (Number.isInteger(error?.code)) stable.exit_code = error.code;
  return stable;
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
