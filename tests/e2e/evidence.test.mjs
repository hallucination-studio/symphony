import assert from "node:assert/strict";
import test from "node:test";

import { readForegroundE2EFinalEvidence } from "../../tools/e2e/evidence.mjs";

test("fresh evidence reader reads only exact Roots with active and archived facts", async () => {
  const fixture = createLinearFixture();
  const evidence = await readForegroundE2EFinalEvidence({
    accessToken: "linear-development-token",
    caseId: "approved_happy_path",
    rootIssueIds: ["root-1"],
    repositories: [{ rootIssueId: "root-1", repositoryRoot: "/repositories/root-1" }],
    createClient: fixture.createClient,
    runGit: fixture.runGit,
  });

  assert.equal(fixture.createClientCalls, 1);
  assert.deepEqual(fixture.issueRequests, ["root-1"]);
  assert.equal(fixture.teamStateReads, 1);
  assert.equal(evidence.coverage.isComplete, true);
  assert.deepEqual(evidence.rootIssueIds, ["root-1"]);
  assert.deepEqual(evidence.statusCatalog.map(({ id }) => id), ["state-review", "state-todo"]);
  assert.equal(evidence.statusCatalog[0].remoteVersion, "2026-07-26T00:00:02.000Z");
  assert.ok(fixture.readOptions.length > 0);
  assert.ok(fixture.readOptions.filter((options) => Object.hasOwn(options, "includeArchived"))
    .every(({ includeArchived }) => includeArchived === true));

  const root = evidence.roots[0];
  assert.equal(root.issues.length, 2);
  assert.equal(Object.hasOwn(root.issues[0], "source"), false);
  assert.deepEqual(root.issues.find(({ id }) => id === "root-1").labels, [{ id: "route-root", name: "symphony:conductor/root" }]);
  assert.equal(root.issues.find(({ id }) => id === "work-1").archivedAt, "2026-07-26T00:00:02.000Z");
  assert.equal(root.comments.length, 2);
  assert.equal(Object.hasOwn(root.comments[0], "source"), false);
  assert.deepEqual(root.comments.find(({ id }) => id === "comment-child").thread, {
    rootCommentId: "comment-root",
    state: "resolved",
  });
  assert.deepEqual(root.comments.find(({ id }) => id === "comment-root").reactions, [{
    id: "reaction-1",
    emoji: "white_check_mark",
    actorId: "symphony-actor",
    archivedAt: null,
    createdAt: "2026-07-26T00:00:03.000Z",
    updatedAt: "2026-07-26T00:00:03.000Z",
    remoteVersion: "2026-07-26T00:00:03.000Z",
  }]);
  assert.deepEqual(root.relations.map(({ id, remoteVersion }) => ({ id, remoteVersion })), [{
    id: "relation-1",
    remoteVersion: "2026-07-26T00:00:02.000Z",
  }]);
  assert.deepEqual(root.activity.map(({ id, remoteVersion }) => ({ id, remoteVersion })), [
    { id: "activity-1", remoteVersion: "2026-07-26T00:00:00.000Z" },
    { id: "activity-2", remoteVersion: "2026-07-26T00:00:02.000Z" },
  ]);
  assert.deepEqual(root.managedRecords.map(({ source }) => source), [
    { kind: "issue_description", id: "work-1", remoteVersion: "2026-07-26T00:00:02.000Z" },
    { kind: "comment", id: "comment-root", remoteVersion: "2026-07-26T00:00:03.000Z" },
  ]);
  assert.equal(root.managedRecords[0].record.kind, "workflow_issue");
  assert.equal(root.managedRecords[1].record.kind, "stage_result");
  assert.deepEqual(evidence.git, [{
    rootIssueId: "root-1",
    repositoryRoot: "/repositories/root-1",
    repositoryRootCanonical: "/repositories/root-1",
    branch: "main",
    headRevision: "commit-1",
    status: "",
    headChangedPaths: ["src/normalizer.ts", "tests/normalizer.test.ts"],
  }]);
});

test("evidence reader records pagination, managed-block, and Git coverage omissions without a runtime fallback", async () => {
  const fixture = createLinearFixture({
    childrenPageInfo: { hasNextPage: true, endCursor: "again" },
    commentBody: "```json\n{not json}\n```",
    gitFailure: true,
  });
  const evidence = await readForegroundE2EFinalEvidence({
    accessToken: "linear-development-token",
    caseId: "approved_happy_path",
    rootIssueIds: ["root-1"],
    repositories: [{ rootIssueId: "root-1", repositoryRoot: "/repositories/root-1" }],
    createClient: fixture.createClient,
    runGit: fixture.runGit,
  });

  assert.equal(evidence.coverage.isComplete, false);
  assert.deepEqual(
    evidence.coverage.omissions.map(({ code }) => code).sort(),
    [
      "foreground_e2e_evidence_git_read_failed",
      "foreground_e2e_evidence_managed_record_invalid",
      "foreground_e2e_evidence_pagination_failed",
    ],
  );
  assert.equal(evidence.roots[0].issues.some(({ id }) => id === "work-1"), false);
  assert.equal(evidence.git.length, 0);
  assert.equal(fixture.createClientCalls, 1);
});

test("evidence reader marks an incomplete native comment thread as missing coverage", async () => {
  const fixture = createLinearFixture({ rootCommentParentId: "missing-comment" });
  const evidence = await readForegroundE2EFinalEvidence({
    accessToken: "linear-development-token",
    caseId: "approved_happy_path",
    rootIssueIds: ["root-1"],
    repositories: [{ rootIssueId: "root-1", repositoryRoot: "/repositories/root-1" }],
    createClient: fixture.createClient,
    runGit: fixture.runGit,
  });

  assert.equal(evidence.roots[0].comments.find(({ id }) => id === "comment-root").thread.state, "unknown");
  assert.deepEqual(evidence.coverage.omissions.map(({ code }) => code), ["foreground_e2e_evidence_thread_incomplete"]);
});

test("evidence reader records native label pagination failures as coverage omissions", async () => {
  const fixture = createLinearFixture({ labelsPageInfo: { hasNextPage: true, endCursor: "again" } });
  const evidence = await readForegroundE2EFinalEvidence({
    accessToken: "linear-development-token",
    caseId: "approved_happy_path",
    rootIssueIds: ["root-1"],
    repositories: [{ rootIssueId: "root-1", repositoryRoot: "/repositories/root-1" }],
    createClient: fixture.createClient,
    runGit: fixture.runGit,
  });

  assert.deepEqual(evidence.coverage.omissions, [{
    rootIssueId: "root-1",
    sourceId: "root-1",
    scope: "labels",
    code: "foreground_e2e_evidence_pagination_failed",
  }]);
});

function createLinearFixture({
  childrenPageInfo = { hasNextPage: false },
  commentBody = `Stage result\n\n\`\`\`json\n${JSON.stringify({ kind: "stage_result", version: 1, result_id: "result-1" })}\n\`\`\``,
  gitFailure = false,
  labelsPageInfo = { hasNextPage: false },
  rootCommentParentId = null,
} = {}) {
  const readOptions = [];
  let teamStateReads = 0;
  const issuedAt = new Date("2026-07-26T00:00:00.000Z");
  const updatedAt = new Date("2026-07-26T00:00:02.000Z");
  const commentAt = new Date("2026-07-26T00:00:03.000Z");
  const stateTodo = { id: "state-todo", name: "Todo", type: "unstarted", position: 1, archivedAt: null, createdAt: issuedAt, updatedAt };
  const stateReview = { id: "state-review", name: "In Review", type: "started", position: 2, archivedAt: null, createdAt: issuedAt, updatedAt };
  const team = {
    id: "team-1",
    states: async (options) => {
      teamStateReads += 1;
      readOptions.push(options);
      return page([stateReview, stateTodo]);
    },
  };
  const activity = {
    id: "activity-1",
    issueId: "root-1",
    actorId: "human-actor",
    createdAt: issuedAt,
    updatedAt: issuedAt,
    fromStateId: "state-todo",
    toStateId: "state-review",
  };
  const childActivity = {
    id: "activity-2",
    issueId: "work-1",
    actorId: "symphony-actor",
    createdAt: updatedAt,
    updatedAt,
    archived: true,
  };
  const reaction = {
    id: "reaction-1",
    emoji: "white_check_mark",
    userId: "symphony-actor",
    createdAt: commentAt,
    updatedAt: commentAt,
  };
  const rootComment = {
    id: "comment-root",
    issueId: "root-1",
    body: commentBody,
    userId: "symphony-actor",
    parentId: rootCommentParentId,
    resolvedAt: commentAt,
    createdAt: commentAt,
    updatedAt: commentAt,
    reactions: [reaction],
    children: async (options) => {
      readOptions.push(options);
      return page([childComment]);
    },
  };
  const childComment = {
    id: "comment-child",
    issueId: "root-1",
    body: "Human reply",
    userId: "human-actor",
    parentId: "comment-root",
    resolvedAt: null,
    createdAt: commentAt,
    updatedAt: commentAt,
    reactions: [],
    children: async (options) => {
      readOptions.push(options);
      return page([]);
    },
  };
  const archivedWork = {
    id: "work-1",
    identifier: "SYM-2",
    title: "Archived work",
    description: `Work description\n\n\`\`\`json\n${JSON.stringify({ kind: "workflow_issue", version: 1, issue_key: "work-1" })}\n\`\`\``,
    projectId: "project-1",
    teamId: "team-1",
    parentId: "root-1",
    creatorId: "symphony-actor",
    archivedAt: updatedAt,
    createdAt: issuedAt,
    updatedAt,
    state: Promise.resolve(stateTodo),
    team: Promise.resolve(team),
    labels: async (options) => {
      readOptions.push(options);
      return page([]);
    },
    children: async (options) => {
      readOptions.push(options);
      return page([]);
    },
    comments: async (options) => {
      readOptions.push(options);
      return page([]);
    },
    relations: async (options) => {
      readOptions.push(options);
      return page([]);
    },
    inverseRelations: async (options) => {
      readOptions.push(options);
      return page([]);
    },
    history: async (options) => {
      readOptions.push(options);
      return page([childActivity]);
    },
  };
  const root = {
    id: "root-1",
    identifier: "SYM-1",
    title: "Root",
    description: "Root requirement",
    projectId: "project-1",
    teamId: "team-1",
    parentId: null,
    creatorId: "human-actor",
    archivedAt: null,
    createdAt: issuedAt,
    updatedAt,
    state: Promise.resolve(stateReview),
    team: Promise.resolve(team),
    labels: async (options) => {
      readOptions.push(options);
      return page([{ id: "route-root", name: "symphony:conductor/root" }], labelsPageInfo);
    },
    children: async (options) => {
      readOptions.push(options);
      return page([archivedWork], childrenPageInfo);
    },
    comments: async (options) => {
      readOptions.push(options);
      return page([rootComment]);
    },
    relations: async (options) => {
      readOptions.push(options);
      return page([{ id: "relation-1", type: "blocks", issueId: "root-1", relatedIssueId: "work-1", archivedAt: null, createdAt: issuedAt, updatedAt }]);
    },
    inverseRelations: async (options) => {
      readOptions.push(options);
      return page([]);
    },
    history: async (options) => {
      readOptions.push(options);
      return page([activity]);
    },
  };
  const issueRequests = [];
  let createClientCalls = 0;
  return {
    get createClientCalls() { return createClientCalls; },
    get teamStateReads() { return teamStateReads; },
    issueRequests,
    readOptions,
    createClient() {
      createClientCalls += 1;
      return {
        issue: async (issueId) => {
          issueRequests.push(issueId);
          if (issueId !== "root-1") throw new Error("unexpected issue read");
          return root;
        },
      };
    },
    async runGit({ args }) {
      if (gitFailure) throw new Error("git unavailable");
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return "/repositories/root-1\n";
      if (command === "branch --show-current") return "main\n";
      if (command === "rev-parse HEAD") return "commit-1\n";
      if (command === "status --porcelain=v1 --untracked-files=all") return "";
      if (command === "show --format= --name-only HEAD") return "src/normalizer.ts\ntests/normalizer.test.ts\n";
      throw new Error(`unexpected git command: ${command}`);
    },
  };
}

function page(nodes, pageInfo = { hasNextPage: false }) {
  return { nodes, pageInfo };
}
