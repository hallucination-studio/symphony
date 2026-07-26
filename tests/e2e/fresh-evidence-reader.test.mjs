import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  readFreshE2EEvidenceSnapshot,
  readFreshGitEvidence,
} from "../../tools/e2e/fresh-evidence-reader.mjs";

const execFile = promisify(execFileCallback);

test("fresh evidence uses a new public Linear client for each exact Root snapshot and covers archived descendants", async () => {
  const clients = [];
  const calls = [];
  const createLinearClient = () => {
    const client = linearClient(calls);
    clients.push(client);
    return client;
  };
  const repositoryContexts = [repositoryContext("repository-1")];

  const first = await readFreshE2EEvidenceSnapshot({
    root_issue_ids: ["root-1"],
    repository_contexts: repositoryContexts,
    createLinearClient,
    readGitEvidence: async (context) => gitEvidence(context),
    observedAt: () => "2026-07-25T00:00:00.000Z",
  });
  const second = await readFreshE2EEvidenceSnapshot({
    root_issue_ids: ["root-1"],
    repository_contexts: repositoryContexts,
    createLinearClient,
    readGitEvidence: async (context) => gitEvidence(context),
    observedAt: () => "2026-07-25T00:00:01.000Z",
  });

  assert.equal(first.kind, "complete");
  assert.equal(second.kind, "complete");
  assert.equal(clients.length, 2);
  assert.notEqual(clients[0], clients[1]);
  assert.deepEqual(calls.filter(({ kind }) => kind === "issue").map(({ issue_id }) => issue_id), ["root-1", "root-1"]);

  const tree = first.root_trees[0];
  assert.equal(tree.root_issue_id, "root-1");
  assert.deepEqual(tree.issues.map(({ issue_id, is_archived }) => ({ issue_id, is_archived })), [
    { issue_id: "root-1", is_archived: false },
    { issue_id: "active-child", is_archived: false },
    { issue_id: "archived-child", is_archived: true },
  ]);
  assert.deepEqual(tree.status_catalog.map(({ status_id, name, category }) => ({ status_id, name, category })), [
    { status_id: "state-todo", name: "Todo", category: "unstarted" },
    { status_id: "state-done", name: "Done", category: "completed" },
  ]);
  assert.equal(tree.issues[0].remote_version, "2026-07-25T00:00:03.000Z");
  assert.equal(tree.comments[0].remote_version, "2026-07-25T00:00:02.000Z");
  assert.equal(tree.relations[0].remote_version, "2026-07-25T00:00:01.000Z");
  assert.deepEqual(tree.relations.map(({ relation_id, direction, relation_kind }) => ({ relation_id, direction, relation_kind })), [
    { relation_id: "relation-out", direction: "outgoing", relation_kind: "blocks" },
    { relation_id: "relation-in", direction: "incoming", relation_kind: "blocked_by" },
  ]);
  assert.deepEqual(tree.comments.map(({ comment_id, thread_root_comment_id, thread_state, author }) => ({
    comment_id,
    thread_root_comment_id,
    thread_state,
    author,
  })), [
    {
      comment_id: "comment-root",
      thread_root_comment_id: "comment-root",
      thread_state: "resolved",
      author: { actor_id: "symphony-actor", actor_kind: "user" },
    },
    {
      comment_id: "comment-child",
      thread_root_comment_id: "comment-root",
      thread_state: "resolved",
      author: { actor_id: "human-actor", actor_kind: "user" },
    },
  ]);
  assert.deepEqual(tree.comments[0].reactions, [{
    reaction_id: "reaction-1",
    emoji: "white_check_mark",
    actor: { actor_id: "symphony-actor", actor_kind: "user" },
    created_at: "2026-07-25T00:00:01.000Z",
    updated_at: "2026-07-25T00:00:02.000Z",
    archived_at: null,
  }]);
  assert.deepEqual(tree.managed_blocks.map(({ source_kind, source_id, record }) => ({ source_kind, source_id, record })), [
    {
      source_kind: "issue_description",
      source_id: "root-1",
      record: { kind: "root_ownership", version: 1, root_issue_id: "root-1" },
    },
    {
      source_kind: "comment",
      source_id: "comment-root",
      record: { kind: "workflow_timeline", version: 1, timeline_event_id: "timeline-1" },
    },
  ]);
  assert.deepEqual(tree.activity[0], {
    issue_id: "root-1",
    history: [{
      activity_id: "activity-1",
      actor_id: "human-actor",
      created_at: "2026-07-25T00:00:03.000Z",
      updated_at: "2026-07-25T00:00:03.000Z",
      from_priority: 3,
      to_priority: 2,
      from_state_id: "state-todo",
      to_state_id: "state-done",
      from_title: null,
      to_title: null,
      updated_description: true,
      is_archived: false,
    }],
    state_history: [{
      state_span_id: "span-1",
      state_id: "state-todo",
      started_at: "2026-07-25T00:00:00.000Z",
      ended_at: "2026-07-25T00:00:03.000Z",
    }],
  });
  assert.deepEqual(first.repositories, [gitEvidence(repositoryContexts[0])]);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.root_trees));
  assert.ok(Object.isFrozen(first.root_trees[0].comments));
  assert.ok(calls.some(({ kind, input }) => kind === "children" && input.includeArchived === true));
  assert.ok(calls.some(({ kind, input }) => kind === "comments" && input.includeArchived === true));
  assert.ok(calls.some(({ kind, input }) => kind === "relations" && input.includeArchived === true));
  assert.ok(calls.some(({ kind, input }) => kind === "inverse_relations" && input.includeArchived === true));
  assert.ok(calls.some(({ kind, input }) => kind === "history" && input.includeArchived === true));
});

test("fresh evidence passes the Human Personal API key to every public Linear client", async () => {
  const clientOptions = [];
  const snapshot = await readFreshE2EEvidenceSnapshot({
    root_issue_ids: ["root-1"],
    repository_contexts: [repositoryContext("repository-1")],
    linear_api_key: "human-api-key",
    createLinearClient(options) {
      clientOptions.push(options);
      return { issue: async () => rootIssue() };
    },
    readGitEvidence: async (context) => gitEvidence(context),
    observedAt: () => "2026-07-25T00:00:00.000Z",
  });

  assert.equal(snapshot.kind, "complete");
  assert.deepEqual(clientOptions, [{ apiKey: "human-api-key" }]);
});

test("fresh evidence returns an explicit redacted incomplete result instead of partial or cached facts", async () => {
  const partialRoot = rootIssue({
    children: () => ({ nodes: [], pageInfo: { hasNextPage: true } }),
  });
  const snapshot = await readFreshE2EEvidenceSnapshot({
    root_issue_ids: ["root-1"],
    repository_contexts: [repositoryContext("repository-1")],
    createLinearClient: () => ({ issue: async () => partialRoot }),
    readGitEvidence: async () => {
      throw new Error("repository token must not leak");
    },
    observedAt: () => "2026-07-25T00:00:00.000Z",
  });

  assert.deepEqual(snapshot, {
    kind: "incomplete",
    observed_at: "2026-07-25T00:00:00.000Z",
    omissions: [{ source_id: "root-1", reason_code: "fresh_linear_coverage_incomplete" }],
  });
  assert.equal("root_trees" in snapshot, false);
  assert.equal("repositories" in snapshot, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /token/u);
});

test("fresh evidence makes a Git observer failure incomplete after Linear coverage succeeds", async () => {
  const snapshot = await readFreshE2EEvidenceSnapshot({
    root_issue_ids: ["root-1"],
    repository_contexts: [repositoryContext("repository-1")],
    createLinearClient: () => ({ issue: async () => rootIssue() }),
    readGitEvidence: async () => {
      throw new Error("remote access token must not leak");
    },
    observedAt: () => "2026-07-25T00:00:00.000Z",
  });

  assert.deepEqual(snapshot, {
    kind: "incomplete",
    observed_at: "2026-07-25T00:00:00.000Z",
    omissions: [{ source_id: "repository-1", reason_code: "fresh_git_coverage_incomplete" }],
  });
  assert.equal("root_trees" in snapshot, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /token/u);
});

test("fresh evidence preserves a valid empty Issue description", async () => {
  const snapshot = await readFreshE2EEvidenceSnapshot({
    root_issue_ids: ["root-1"],
    repository_contexts: [repositoryContext("repository-1")],
    createLinearClient: () => ({ issue: async () => rootIssue({ description: "" }) }),
    readGitEvidence: async (context) => gitEvidence(context),
    observedAt: () => "2026-07-25T00:00:00.000Z",
  });

  assert.equal(snapshot.kind, "complete");
  assert.equal(snapshot.root_trees[0].issues[0].description, "");
});

test("fresh evidence preserves an activity whose external actor is unavailable", async () => {
  const activity = historyEntry();
  delete activity.actorId;
  const snapshot = await readFreshE2EEvidenceSnapshot({
    root_issue_ids: ["root-1"],
    repository_contexts: [repositoryContext("repository-1")],
    createLinearClient: () => ({
      issue: async () => rootIssue({ history: async () => pagedConnection([[activity]]) }),
    }),
    readGitEvidence: async (context) => gitEvidence(context),
    observedAt: () => "2026-07-25T00:00:00.000Z",
  });

  assert.equal(snapshot.kind, "complete");
  assert.equal(snapshot.root_trees[0].activity[0].history[0].actor_id, null);
});

test("fresh evidence is incomplete when complete relation coverage exceeds the Root cap", async () => {
  const snapshot = await readFreshE2EEvidenceSnapshot({
    root_issue_ids: ["root-1"],
    repository_contexts: [repositoryContext("repository-1")],
    createLinearClient: () => ({
      issue: async () => rootIssue({
        relations: async () => pagedConnection([manyRelations("out", 600, "root-1", "outside")]),
        inverseRelations: async () => pagedConnection([manyRelations("in", 600, "outside", "root-1")]),
      }),
    }),
    readGitEvidence: async (context) => gitEvidence(context),
    observedAt: () => "2026-07-25T00:00:00.000Z",
  });

  assert.deepEqual(snapshot, {
    kind: "incomplete",
    observed_at: "2026-07-25T00:00:00.000Z",
    omissions: [{ source_id: "root-1", reason_code: "fresh_linear_coverage_incomplete" }],
  });
});

test("fresh Git evidence reads branch, commit, diff, check, and delivery facts from the exact repository", async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-evidence-"));
  try {
    await git(repositoryRoot, ["init", "--initial-branch", "main"]);
    await git(repositoryRoot, ["config", "user.name", "Symphony E2E"]);
    await git(repositoryRoot, ["config", "user.email", "e2e@example.test"]);
    await writeFile(path.join(repositoryRoot, "README.md"), "# Initial\n", "utf8");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, ["commit", "-m", "Initial"]);
    await git(repositoryRoot, ["checkout", "-b", "symphony/runs/root-1"]);
    await writeFile(path.join(repositoryRoot, "README.md"), "# Changed\n", "utf8");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, ["commit", "-m", "Change"]);

    const evidence = await readFreshGitEvidence({
      repository_identity: "repository-1",
      repository_root: repositoryRoot,
      base_branch: "main",
    });

    assert.equal(evidence.repository_identity, "repository-1");
    assert.equal(evidence.branch, "symphony/runs/root-1");
    assert.match(evidence.head_commit, /^[0-9a-f]{40}$/u);
    assert.match(evidence.base_commit, /^[0-9a-f]{40}$/u);
    assert.deepEqual(evidence.changed_paths, ["README.md"]);
    assert.equal(evidence.diff_check, "passed");
    assert.deepEqual(evidence.delivery, {
      remote_name: null,
      branch: "symphony/runs/root-1",
      remote_head: null,
      is_delivered: false,
    });
    assert.deepEqual(evidence.worktree, {
      is_clean: true,
      status_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });

    await writeFile(path.join(repositoryRoot, "README.md"), "# Dirty   \n", "utf8");
    const dirtyEvidence = await readFreshGitEvidence({
      repository_identity: "repository-1",
      repository_root: repositoryRoot,
      base_branch: "main",
    });
    assert.equal(dirtyEvidence.worktree.is_clean, false);
    assert.match(dirtyEvidence.worktree.status_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(dirtyEvidence.diff_check, "failed");
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("fresh evidence reader keeps public SDK and native Git boundaries free of product internals and raw GraphQL", async () => {
  const source = await (await import("node:fs/promises")).readFile("tools/e2e/fresh-evidence-reader.mjs", "utf8");
  assert.match(source, /from "@linear\/sdk"/u);
  assert.doesNotMatch(source, /rawRequest|LinearSdkImpl|LinearGatewayProtocolHandlerImpl|podium\.db|apps\/conductor|packages\/podium\/src\/internal/u);
  assert.doesNotMatch(source, /createIssue|updateIssue|archiveIssue|createComment|updateComment|createReaction/u);
});

function linearClient(calls) {
  const root = rootIssue({
    children(input) {
      calls.push({ kind: "children", input });
      return pagedConnection([[activeChild()], [archivedChild()]]);
    },
    comments(input) {
      calls.push({ kind: "comments", input });
      return pagedConnection([[rootComment()]]);
    },
    relations(input) {
      calls.push({ kind: "relations", input });
      return pagedConnection([[relation("relation-out", "blocks", "root-1", "outside-1")]]);
    },
    inverseRelations(input) {
      calls.push({ kind: "inverse_relations", input });
      return pagedConnection([[relation("relation-in", "blocked_by", "outside-2", "root-1")]]);
    },
    history(input) {
      calls.push({ kind: "history", input });
      return pagedConnection([[historyEntry()]]);
    },
    stateHistory(input) {
      calls.push({ kind: "state_history", input });
      return pagedConnection([[stateSpan()]]);
    },
  });
  return {
    async issue(issueId) {
      calls.push({ kind: "issue", issue_id: issueId });
      assert.equal(issueId, "root-1");
      return root;
    },
  };
}

function rootIssue(overrides = {}) {
  const team = {
    id: "team-1",
    states: async () => pagedConnection([[{ id: "state-todo", name: "Todo", type: "unstarted" }, { id: "state-done", name: "Done", type: "completed" }]]),
  };
  return {
    id: "root-1",
    identifier: "SYM-1",
    title: "Root",
    description: "Root description\n\n```symphony\n{\"kind\":\"root_ownership\",\"version\":1,\"root_issue_id\":\"root-1\"}\n```",
    priority: 2,
    createdAt: date("2026-07-25T00:00:00.000Z"),
    updatedAt: date("2026-07-25T00:00:03.000Z"),
    archivedAt: null,
    state: Promise.resolve({ id: "state-todo", name: "Todo", type: "unstarted" }),
    team: Promise.resolve(team),
    labels: async () => pagedConnection([[{ id: "label-root", name: "Root" }]]),
    reactions: [],
    creator: Promise.resolve({ id: "human-actor" }),
    children: async () => pagedConnection([[]]),
    comments: async () => pagedConnection([[]]),
    relations: async () => pagedConnection([[]]),
    inverseRelations: async () => pagedConnection([[]]),
    history: async () => pagedConnection([[]]),
    stateHistory: async () => pagedConnection([[]]),
    ...overrides,
  };
}

function activeChild() {
  return issueChild({
    id: "active-child",
    identifier: "SYM-2",
    title: "Active child",
  });
}

function archivedChild() {
  return issueChild({
    id: "archived-child",
    identifier: "SYM-3",
    title: "Archived child",
    archivedAt: date("2026-07-25T00:00:04.000Z"),
  });
}

function issueChild({ id, identifier, title, archivedAt = null }) {
  const child = rootIssue({
    id,
    identifier,
    title,
    description: "Child description",
    archivedAt,
    children: async () => pagedConnection([[]]),
    comments: async () => pagedConnection([[]]),
    relations: async () => pagedConnection([[]]),
    inverseRelations: async () => pagedConnection([[]]),
    history: async () => pagedConnection([[]]),
    stateHistory: async () => pagedConnection([[]]),
  });
  return child;
}

function rootComment() {
  return {
    id: "comment-root",
    issueId: "root-1",
    parentId: null,
    body: "Timeline\n\n```symphony\n{\"kind\":\"workflow_timeline\",\"version\":1,\"timeline_event_id\":\"timeline-1\"}\n```",
    createdAt: date("2026-07-25T00:00:01.000Z"),
    updatedAt: date("2026-07-25T00:00:02.000Z"),
    archivedAt: null,
    resolvedAt: date("2026-07-25T00:00:04.000Z"),
    user: Promise.resolve({ id: "symphony-actor" }),
    reactions: [{
      id: "reaction-1",
      emoji: "white_check_mark",
      createdAt: date("2026-07-25T00:00:01.000Z"),
      updatedAt: date("2026-07-25T00:00:02.000Z"),
      archivedAt: null,
      user: Promise.resolve({ id: "symphony-actor" }),
    }],
    children: async () => pagedConnection([[childComment()]]),
  };
}

function childComment() {
  return {
    id: "comment-child",
    issueId: "root-1",
    parentId: "comment-root",
    body: "Human follow-up",
    createdAt: date("2026-07-25T00:00:03.000Z"),
    updatedAt: date("2026-07-25T00:00:03.000Z"),
    archivedAt: null,
    resolvedAt: null,
    user: Promise.resolve({ id: "human-actor" }),
    reactions: [],
    children: async () => pagedConnection([[]]),
  };
}

function relation(id, type, issueId, relatedIssueId) {
  return {
    id,
    type,
    issueId,
    relatedIssueId,
    createdAt: date("2026-07-25T00:00:00.000Z"),
    updatedAt: date("2026-07-25T00:00:01.000Z"),
    archivedAt: null,
  };
}

function manyRelations(prefix, count, issueId, relatedIssuePrefix) {
  return Array.from({ length: count }, (_, index) => relation(
    `${prefix}-relation-${index}`,
    "blocks",
    issueId === "root-1" ? issueId : `${issueId}-${index}`,
    relatedIssuePrefix === "root-1" ? relatedIssuePrefix : `${relatedIssuePrefix}-${index}`,
  ));
}

function historyEntry() {
  return {
    id: "activity-1",
    actorId: "human-actor",
    createdAt: date("2026-07-25T00:00:03.000Z"),
    updatedAt: date("2026-07-25T00:00:03.000Z"),
    fromPriority: 3,
    toPriority: 2,
    fromStateId: "state-todo",
    toStateId: "state-done",
    fromTitle: null,
    toTitle: null,
    updatedDescription: true,
    archived: false,
  };
}

function stateSpan() {
  return {
    id: "span-1",
    stateId: "state-todo",
    startedAt: date("2026-07-25T00:00:00.000Z"),
    endedAt: date("2026-07-25T00:00:03.000Z"),
  };
}

function pagedConnection(pages) {
  const connection = {
    nodes: [...pages[0]],
    pageInfo: { hasNextPage: pages.length > 1 },
    async fetchNext() {
      const next = pages.shift();
      assert.ok(next);
      const following = pages[0] ?? [];
      this.nodes.push(...following);
      this.pageInfo.hasNextPage = pages.length > 1;
    },
  };
  return connection;
}

function repositoryContext(identity) {
  return {
    repository_identity: identity,
    repository_root: "/repository/root",
    base_branch: "main",
  };
}

function gitEvidence(context) {
  return {
    repository_identity: context.repository_identity,
    branch: "symphony/runs/root-1",
    head_commit: "1".repeat(40),
    base_branch: context.base_branch,
    base_commit: "0".repeat(40),
    changed_paths: ["README.md"],
    diff_check: "passed",
    worktree: {
      is_clean: true,
      status_sha256: "a".repeat(64),
    },
    delivery: {
      remote_name: null,
      branch: "symphony/runs/root-1",
      remote_head: null,
      is_delivered: false,
    },
  };
}

function date(value) {
  return new Date(value);
}

async function git(repositoryRoot, arguments_) {
  await execFile("git", ["-C", repositoryRoot, ...arguments_]);
}
