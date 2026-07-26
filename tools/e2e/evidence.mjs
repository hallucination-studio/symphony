import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { LinearClient } from "@linear/sdk";
import { parseSymphonyRecordBlock } from "@symphony/contracts/managed-record";

import { readAllLinearNodes } from "./linear-environment.mjs";

const execFile = promisify(execFileCallback);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const PAGE_SIZE = 250;

export async function readForegroundE2EFinalEvidence({
  accessToken,
  caseId,
  rootIssueIds,
  repositories,
  createClient = (options) => new LinearClient(options),
  runGit = defaultRunGit,
} = {}) {
  assertInput({ accessToken, caseId, rootIssueIds, repositories, createClient, runGit });
  let client;
  try {
    client = createClient({ accessToken });
  } catch {
    throw stableError("foreground_e2e_evidence_client_invalid");
  }
  if (!client || typeof client.issue !== "function") throw stableError("foreground_e2e_evidence_client_invalid");

  const coverage = createCoverage();
  const roots = [];
  const statusCatalog = new Map();
  const statusCatalogTeams = new Set();
  for (const rootIssueId of rootIssueIds) {
    const root = await readRoot({ client, rootIssueId, coverage, statusCatalog, statusCatalogTeams });
    roots.push(root);
  }

  const git = [];
  for (const repository of repositories) {
    const fact = await readGitEvidence({ repository, runGit, coverage });
    if (fact) git.push(fact);
  }
  const evidence = {
    caseId,
    observedAt: new Date().toISOString(),
    rootIssueIds: [...rootIssueIds],
    roots,
    statusCatalog: [...statusCatalog.values()].sort((left, right) => left.id.localeCompare(right.id)),
    git,
    coverage: coverage.value(),
  };
  return deepFreeze(evidence);
}

async function readRoot({ client, rootIssueId, coverage, statusCatalog, statusCatalogTeams }) {
  let rootIssue;
  try {
    rootIssue = await client.issue(rootIssueId);
  } catch {
    coverage.add({ rootIssueId, sourceId: rootIssueId, scope: "root", code: "foreground_e2e_evidence_linear_read_failed" });
    return emptyRoot(rootIssueId);
  }
  if (!validIssue(rootIssue, rootIssueId)) {
    coverage.add({ rootIssueId, sourceId: rootIssueId, scope: "root", code: "foreground_e2e_evidence_linear_read_failed" });
    return emptyRoot(rootIssueId);
  }

  const issues = [];
  await readIssueTree({ issue: rootIssue, rootIssueId, depth: 0, issues, coverage, statusCatalog, statusCatalogTeams, seen: new Set() });
  const comments = await readTreeComments({ issues, rootIssueId, coverage });
  const relations = await readTreeRelations({ issues, rootIssueId, coverage });
  const activity = await readTreeActivity({ issues, rootIssueId, coverage });
  const managedRecords = collectManagedRecords({ issues, comments, rootIssueId, coverage });
  return {
    rootIssueId,
    issues: issues.map(({ source, ...fact }) => fact),
    comments: comments.map(({ source, ...fact }) => fact),
    relations,
    activity,
    managedRecords,
  };
}

function emptyRoot(rootIssueId) {
  return { rootIssueId, issues: [], comments: [], relations: [], activity: [], managedRecords: [] };
}

async function readIssueTree({ issue, rootIssueId, depth, issues, coverage, statusCatalog, statusCatalogTeams, seen }) {
  if (seen.has(issue.id)) {
    coverage.add({ rootIssueId, sourceId: issue.id, scope: "tree", code: "foreground_e2e_evidence_tree_invalid" });
    return;
  }
  seen.add(issue.id);
  const fact = await issueFact({ issue, rootIssueId, depth, coverage, statusCatalog, statusCatalogTeams });
  if (fact) issues.push({ ...fact, source: issue });
  let children;
  try {
    children = await readAllLinearNodes(
      (after) => issue.children({ first: PAGE_SIZE, includeArchived: true, ...(after ? { after } : {}) }),
      "foreground_e2e_evidence_pagination_failed",
    );
  } catch (error) {
    coverage.add({
      rootIssueId,
      sourceId: issue.id,
      scope: "children",
      code: error?.code === "foreground_e2e_evidence_pagination_failed"
        ? error.code
        : "foreground_e2e_evidence_linear_read_failed",
    });
    return;
  }
  for (const child of children) {
    if (!validIssue(child)) {
      coverage.add({ rootIssueId, sourceId: issue.id, scope: "children", code: "foreground_e2e_evidence_tree_invalid" });
      continue;
    }
    await readIssueTree({ issue: child, rootIssueId, depth: depth + 1, issues, coverage, statusCatalog, statusCatalogTeams, seen });
  }
}

async function issueFact({ issue, rootIssueId, depth, coverage, statusCatalog, statusCatalogTeams }) {
  try {
    const [state, team] = await Promise.all([issue.state, issue.team]);
    if (!validState(state) || !team || !IDENTIFIER.test(team.id) || typeof team.states !== "function") {
      throw new Error("issue shape invalid");
    }
    if (!statusCatalogTeams.has(team.id)) {
      const states = await readAllLinearNodes(
        (after) => team.states({ first: PAGE_SIZE, includeArchived: true, ...(after ? { after } : {}) }),
        "foreground_e2e_evidence_pagination_failed",
      );
      for (const candidate of states) {
        if (!validState(candidate)) throw new Error("status shape invalid");
        statusCatalog.set(candidate.id, statusFact(candidate));
      }
      statusCatalogTeams.add(team.id);
    }
    return {
      id: issue.id,
      identifier: text(issue.identifier),
      rootIssueId,
      parentId: nullableIdentifier(issue.parentId),
      projectId: nullableIdentifier(issue.projectId),
      teamId: team.id,
      creatorId: nullableIdentifier(issue.creatorId),
      title: text(issue.title),
      description: nullableText(issue.description),
      state: statusFact(state),
      archivedAt: timestampOrNull(issue.archivedAt),
      createdAt: timestamp(issue.createdAt),
      updatedAt: timestamp(issue.updatedAt),
      remoteVersion: timestamp(issue.updatedAt),
      depth,
    };
  } catch (error) {
    coverage.add({
      rootIssueId,
      sourceId: issue.id,
      scope: "issue",
      code: error?.code === "foreground_e2e_evidence_pagination_failed"
        ? error.code
        : "foreground_e2e_evidence_linear_read_failed",
    });
    return undefined;
  }
}

async function readTreeComments({ issues, rootIssueId, coverage }) {
  const comments = new Map();
  for (const issue of issues) {
    try {
      const topLevel = await readAllLinearNodes(
        (after) => issue.source.comments({ first: PAGE_SIZE, includeArchived: true, ...(after ? { after } : {}) }),
        "foreground_e2e_evidence_pagination_failed",
      );
      for (const comment of topLevel) {
        await readComment({ comment, issueId: issue.id, rootIssueId, comments, coverage });
      }
    } catch (error) {
      coverage.add({
        rootIssueId,
        sourceId: issue.id,
        scope: "comments",
        code: error?.code === "foreground_e2e_evidence_pagination_failed"
          ? error.code
          : "foreground_e2e_evidence_linear_read_failed",
      });
    }
  }
  return [...comments.values()]
    .map((comment) => ({ ...comment, thread: threadFact({ comment, comments, rootIssueId, coverage }) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function readComment({ comment, issueId, rootIssueId, comments, coverage }) {
  if (!validComment(comment, issueId)) {
    coverage.add({ rootIssueId, sourceId: issueId, scope: "comments", code: "foreground_e2e_evidence_comment_invalid" });
    return;
  }
  if (comments.has(comment.id)) return;
  if (!Array.isArray(comment.reactions)) {
    coverage.add({ rootIssueId, sourceId: comment.id, scope: "reactions", code: "foreground_e2e_evidence_comment_invalid" });
    return;
  }
  const reactions = [];
  for (const reaction of comment.reactions) {
    if (!validReaction(reaction)) {
      coverage.add({ rootIssueId, sourceId: comment.id, scope: "reactions", code: "foreground_e2e_evidence_comment_invalid" });
      return;
    }
    reactions.push(reactionFact(reaction));
  }
  comments.set(comment.id, {
    id: comment.id,
    issueId,
    parentId: nullableIdentifier(comment.parentId),
    authorId: nullableIdentifier(comment.userId),
    body: comment.body,
    archivedAt: timestampOrNull(comment.archivedAt),
    createdAt: timestamp(comment.createdAt),
    updatedAt: timestamp(comment.updatedAt),
    remoteVersion: timestamp(comment.updatedAt),
    editedAt: timestampOrNull(comment.editedAt),
    resolvedAt: timestampOrNull(comment.resolvedAt),
    reactions: reactions.sort((left, right) => left.id.localeCompare(right.id)),
    source: comment,
  });
  try {
    const children = await readAllLinearNodes(
      (after) => comment.children({ first: PAGE_SIZE, includeArchived: true, ...(after ? { after } : {}) }),
      "foreground_e2e_evidence_pagination_failed",
    );
    for (const child of children) {
      await readComment({ comment: child, issueId, rootIssueId, comments, coverage });
    }
  } catch (error) {
    coverage.add({
      rootIssueId,
      sourceId: comment.id,
      scope: "comment_children",
      code: error?.code === "foreground_e2e_evidence_pagination_failed"
        ? error.code
        : "foreground_e2e_evidence_linear_read_failed",
    });
  }
}

async function readTreeRelations({ issues, rootIssueId, coverage }) {
  const relations = new Map();
  for (const issue of issues) {
    for (const relationMethod of ["relations", "inverseRelations"]) {
      try {
        const values = await readAllLinearNodes(
          (after) => issue.source[relationMethod]({ first: PAGE_SIZE, includeArchived: true, ...(after ? { after } : {}) }),
          "foreground_e2e_evidence_pagination_failed",
        );
        for (const relation of values) {
          if (!validRelation(relation)) {
            coverage.add({ rootIssueId, sourceId: issue.id, scope: "relations", code: "foreground_e2e_evidence_relation_invalid" });
            continue;
          }
          relations.set(relation.id, relationFact(relation));
        }
      } catch (error) {
        coverage.add({
          rootIssueId,
          sourceId: issue.id,
          scope: "relations",
          code: error?.code === "foreground_e2e_evidence_pagination_failed"
            ? error.code
            : "foreground_e2e_evidence_linear_read_failed",
        });
      }
    }
  }
  return [...relations.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function readTreeActivity({ issues, rootIssueId, coverage }) {
  const activity = [];
  for (const issue of issues) {
    try {
      const values = await readAllLinearNodes(
        (after) => issue.source.history({ first: PAGE_SIZE, includeArchived: true, ...(after ? { after } : {}) }),
        "foreground_e2e_evidence_pagination_failed",
      );
      for (const entry of values) {
        if (!entry || !IDENTIFIER.test(entry.id) || entry.issueId !== issue.id || !timestampValue(entry.createdAt) || !timestampValue(entry.updatedAt)) {
          coverage.add({ rootIssueId, sourceId: issue.id, scope: "activity", code: "foreground_e2e_evidence_activity_invalid" });
          continue;
        }
        activity.push({
          id: entry.id,
          issueId: issue.id,
          actorId: nullableIdentifier(entry.actorId),
          createdAt: timestamp(entry.createdAt),
          updatedAt: timestamp(entry.updatedAt),
          remoteVersion: timestamp(entry.updatedAt),
          archived: entry.archived === true ? true : entry.archived === false ? false : null,
          fromStateId: nullableIdentifier(entry.fromStateId),
          toStateId: nullableIdentifier(entry.toStateId),
          fromParentId: nullableIdentifier(entry.fromParentId),
          toParentId: nullableIdentifier(entry.toParentId),
          fromPriority: finiteNumberOrNull(entry.fromPriority),
          toPriority: finiteNumberOrNull(entry.toPriority),
          updatedDescription: entry.updatedDescription === true,
        });
      }
    } catch (error) {
      coverage.add({
        rootIssueId,
        sourceId: issue.id,
        scope: "activity",
        code: error?.code === "foreground_e2e_evidence_pagination_failed"
          ? error.code
          : "foreground_e2e_evidence_linear_read_failed",
      });
    }
  }
  return activity.sort((left, right) => left.id.localeCompare(right.id));
}

function collectManagedRecords({ issues, comments, rootIssueId, coverage }) {
  const records = [];
  for (const issue of issues) {
    addManagedRecord({
      body: issue.description,
      source: { kind: "issue_description", id: issue.id, remoteVersion: issue.remoteVersion },
      issueId: issue.id,
      rootIssueId,
      coverage,
      records,
    });
  }
  for (const comment of comments) {
    addManagedRecord({
      body: comment.body,
      source: { kind: "comment", id: comment.id, remoteVersion: comment.remoteVersion },
      issueId: comment.issueId,
      rootIssueId,
      coverage,
      records,
    });
  }
  return records;
}

function addManagedRecord({ body, source, issueId, rootIssueId, coverage, records }) {
  if (body === null) return;
  const parsed = parseSymphonyRecordBlock(body);
  if (!parsed.ok) {
    if (parsed.error !== "managed_record_block_missing") {
      coverage.add({ rootIssueId, sourceId: source.id, scope: "managed_record", code: "foreground_e2e_evidence_managed_record_invalid" });
    }
    return;
  }
  records.push({ issueId, source, markdown: parsed.markdown, record: parsed.record });
}

function threadFact({ comment, comments, rootIssueId, coverage }) {
  let current = comment;
  const seen = new Set();
  while (current.parentId) {
    if (seen.has(current.id)) {
      coverage.add({
        rootIssueId,
        sourceId: current.parentId,
        scope: "thread",
        code: "foreground_e2e_evidence_thread_incomplete",
      });
      return { rootCommentId: current.id, state: "unknown" };
    }
    seen.add(current.id);
    const parent = comments.get(current.parentId);
    if (!parent) {
      coverage.add({
        rootIssueId,
        sourceId: current.parentId,
        scope: "thread",
        code: "foreground_e2e_evidence_thread_incomplete",
      });
      return { rootCommentId: current.parentId, state: "unknown" };
    }
    current = parent;
  }
  return { rootCommentId: current.id, state: current.resolvedAt ? "resolved" : "unresolved" };
}

async function readGitEvidence({ repository, runGit, coverage }) {
  try {
    const repositoryRootCanonical = singleLine(await runGit({ repositoryRoot: repository.repositoryRoot, args: ["rev-parse", "--show-toplevel"] }));
    const branch = singleLine(await runGit({ repositoryRoot: repository.repositoryRoot, args: ["branch", "--show-current"] }));
    const headRevision = singleLine(await runGit({ repositoryRoot: repository.repositoryRoot, args: ["rev-parse", "HEAD"] }));
    const status = await runGit({ repositoryRoot: repository.repositoryRoot, args: ["status", "--porcelain=v1", "--untracked-files=all"] });
    const headChangedPaths = lines(await runGit({ repositoryRoot: repository.repositoryRoot, args: ["show", "--format=", "--name-only", "HEAD"] }));
    if (!repositoryRootCanonical || !branch || !headRevision) throw new Error("git fact invalid");
    return {
      rootIssueId: repository.rootIssueId,
      repositoryRoot: repository.repositoryRoot,
      repositoryRootCanonical,
      branch,
      headRevision,
      status,
      headChangedPaths,
    };
  } catch {
    coverage.add({
      rootIssueId: repository.rootIssueId,
      sourceId: repository.rootIssueId,
      scope: "git",
      code: "foreground_e2e_evidence_git_read_failed",
    });
    return undefined;
  }
}

async function defaultRunGit({ repositoryRoot, args }) {
  const { stdout } = await execFile("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 1_048_576,
  });
  return stdout;
}

function createCoverage() {
  const omissions = [];
  const keys = new Set();
  return {
    add(omission) {
      const key = [omission.rootIssueId, omission.sourceId, omission.scope, omission.code].join("\u0000");
      if (keys.has(key)) return;
      keys.add(key);
      omissions.push(omission);
    },
    value() {
      const values = omissions.sort((left, right) =>
        [left.rootIssueId, left.sourceId, left.scope, left.code].join("\u0000")
          .localeCompare([right.rootIssueId, right.sourceId, right.scope, right.code].join("\u0000")),
      );
      return { isComplete: values.length === 0, omissions: values };
    },
  };
}

function assertInput({ accessToken, caseId, rootIssueIds, repositories, createClient, runGit }) {
  if (!token(accessToken) || !IDENTIFIER.test(caseId) || !Array.isArray(rootIssueIds) || rootIssueIds.length === 0 ||
      new Set(rootIssueIds).size !== rootIssueIds.length || rootIssueIds.some((id) => !IDENTIFIER.test(id)) ||
      !Array.isArray(repositories) || repositories.length !== rootIssueIds.length || typeof createClient !== "function" ||
      typeof runGit !== "function") {
    throw stableError("foreground_e2e_evidence_input_invalid");
  }
  const repositoryRoots = new Set();
  const repositoryIssueIds = new Set();
  for (const repository of repositories) {
    if (!repository || !IDENTIFIER.test(repository.rootIssueId) || !rootIssueIds.includes(repository.rootIssueId) ||
        typeof repository.repositoryRoot !== "string" || repository.repositoryRoot.length === 0 ||
        repositoryRoots.has(repository.repositoryRoot) || repositoryIssueIds.has(repository.rootIssueId)) {
      throw stableError("foreground_e2e_evidence_input_invalid");
    }
    repositoryRoots.add(repository.repositoryRoot);
    repositoryIssueIds.add(repository.rootIssueId);
  }
}

function validIssue(issue, expectedId) {
  return issue && typeof issue === "object" && IDENTIFIER.test(issue.id) &&
    (expectedId === undefined || issue.id === expectedId) && typeof issue.children === "function" &&
    typeof issue.comments === "function" && typeof issue.relations === "function" &&
    typeof issue.inverseRelations === "function" && typeof issue.history === "function";
}

function validState(state) {
  return state && IDENTIFIER.test(state.id) && typeof state.name === "string" &&
    typeof state.type === "string" && Number.isFinite(state.position) &&
    timestampValue(state.createdAt) && timestampValue(state.updatedAt);
}

function validComment(comment, issueId) {
  return comment && IDENTIFIER.test(comment.id) && comment.issueId === issueId && typeof comment.body === "string" &&
    timestampValue(comment.createdAt) && timestampValue(comment.updatedAt) && typeof comment.children === "function";
}

function validReaction(reaction) {
  return reaction && IDENTIFIER.test(reaction.id) && typeof reaction.emoji === "string" &&
    IDENTIFIER.test(reaction.userId) && timestampValue(reaction.createdAt) && timestampValue(reaction.updatedAt);
}

function validRelation(relation) {
  return relation && IDENTIFIER.test(relation.id) && typeof relation.type === "string" &&
    IDENTIFIER.test(relation.issueId) && IDENTIFIER.test(relation.relatedIssueId) &&
    timestampValue(relation.createdAt) && timestampValue(relation.updatedAt);
}

function statusFact(state) {
  return {
    id: state.id,
    name: state.name,
    type: state.type,
    position: state.position,
    archivedAt: timestampOrNull(state.archivedAt),
    createdAt: timestamp(state.createdAt),
    updatedAt: timestamp(state.updatedAt),
    remoteVersion: timestamp(state.updatedAt),
  };
}

function reactionFact(reaction) {
  return {
    id: reaction.id,
    emoji: reaction.emoji,
    actorId: reaction.userId,
    archivedAt: timestampOrNull(reaction.archivedAt),
    createdAt: timestamp(reaction.createdAt),
    updatedAt: timestamp(reaction.updatedAt),
    remoteVersion: timestamp(reaction.updatedAt),
  };
}

function relationFact(relation) {
  return {
    id: relation.id,
    type: relation.type,
    issueId: relation.issueId,
    relatedIssueId: relation.relatedIssueId,
    archivedAt: timestampOrNull(relation.archivedAt),
    createdAt: timestamp(relation.createdAt),
    updatedAt: timestamp(relation.updatedAt),
    remoteVersion: timestamp(relation.updatedAt),
  };
}

function token(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}

function text(value) {
  if (typeof value !== "string") throw new Error("text invalid");
  return value;
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  return text(value);
}

function nullableIdentifier(value) {
  if (value === null || value === undefined) return null;
  if (!IDENTIFIER.test(value)) throw new Error("identifier invalid");
  return value;
}

function timestamp(value) {
  if (!timestampValue(value)) throw new Error("timestamp invalid");
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function timestampOrNull(value) {
  return value === null || value === undefined ? null : timestamp(value);
}

function timestampValue(value) {
  return value instanceof Date ? !Number.isNaN(value.valueOf()) : typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function finiteNumberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function singleLine(value) {
  return typeof value === "string" ? value.trim().split(/\r?\n/u)[0] ?? "" : "";
}

function lines(value) {
  return typeof value === "string" ? value.split(/\r?\n/u).filter(Boolean).sort() : [];
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
