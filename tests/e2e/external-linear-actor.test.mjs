import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createVerifiedExternalLinearActors } from "../../tools/e2e/external-linear-actor.mjs";

test("external Linear actors use independent clients and return only the verified Human client", async () => {
  const clientInputs = [];
  const humanClient = viewerClient("human-actor");
  const actors = await createVerifiedExternalLinearActors({
    symphonyAccessToken: "symphony-token",
    humanApiKey: "human-api-key",
    createClient(input) {
      clientInputs.push(input);
      return input.accessToken === "symphony-token" ? viewerClient("symphony-actor") : humanClient;
    },
  });

  assert.deepEqual(clientInputs, [
    { accessToken: "symphony-token" },
    { apiKey: "human-api-key" },
  ]);
  assert.equal(actors.symphony_actor_id, "symphony-actor");
  assert.equal(actors.human_actor_id, "human-actor");
  assert.notEqual(actors.human, humanClient);
  assert.equal(await actors.human.readActorId(), "human-actor");
  assert.equal(await actors.human.readSymphonyActorId(), "symphony-actor");
  assert.equal("viewer" in actors.human, false);
  assert.equal("symphony" in actors, false);
});

test("external Linear actor verification rejects equal credentials before creating a client", async () => {
  let calls = 0;
  await assert.rejects(
    createVerifiedExternalLinearActors({
      symphonyAccessToken: "same-token",
      humanApiKey: "same-token",
      createClient() {
        calls += 1;
        return viewerClient("not-called");
      },
    }),
    /external_linear_actor_credentials_not_distinct/u,
  );
  assert.equal(calls, 0);
});

test("external Linear actor verification rejects equal public identities", async () => {
  await assert.rejects(
    createVerifiedExternalLinearActors({
      symphonyAccessToken: "symphony-token",
      humanApiKey: "human-api-key",
      createClient: () => viewerClient("same-actor"),
    }),
    /external_linear_actor_identities_not_distinct/u,
  );
});

test("external Linear actor verification rejects an invalid viewer response without exposing credentials", async () => {
  await assert.rejects(
    createVerifiedExternalLinearActors({
      symphonyAccessToken: "symphony-token",
      humanApiKey: "human-api-key",
      createClient: () => ({ viewer: Promise.resolve({ id: "" }) }),
    }),
    (error) => error.code === "external_linear_actor_identity_invalid" &&
      !error.message.includes("symphony-token") && !error.message.includes("human-api-key"),
  );
});

test("external Linear actor verification redacts a failed public identity read", async () => {
  await assert.rejects(
    createVerifiedExternalLinearActors({
      symphonyAccessToken: "symphony-token",
      humanApiKey: "human-api-key",
      createClient: () => ({ viewer: Promise.reject(new Error("remote failure: human-api-key")) }),
    }),
    (error) => error.code === "external_linear_actor_identity_read_failed" &&
      !error.message.includes("symphony-token") && !error.message.includes("human-api-key"),
  );
});

test("external Linear actor verification creates fresh public clients on every verification", async () => {
  let calls = 0;
  const createClient = (input) => {
    calls += 1;
    return viewerClient(input.accessToken === "symphony-token" ? "symphony-actor" : "human-actor");
  };

  await createVerifiedExternalLinearActors({
    symphonyAccessToken: "symphony-token",
    humanApiKey: "human-api-key",
    createClient,
  });
  await createVerifiedExternalLinearActors({
    symphonyAccessToken: "symphony-token",
    humanApiKey: "human-api-key",
    createClient,
  });

  assert.equal(calls, 4);
});

test("external Linear actor depends only on the official public SDK boundary", async () => {
  const source = await readFile("tools/e2e/external-linear-actor.mjs", "utf8");
  assert.match(source, /from "@linear\/sdk"/u);
  assert.doesNotMatch(source, /@symphony\/podium|internal\/|LinearSdkImpl|LinearGatewayProtocolHandlerImpl|podium\.db/u);
  assert.doesNotMatch(source, /\.(?:createReaction|deleteReaction|archiveIssue|unarchiveIssue|issueAddLabel|issueRemoveLabel|createIssueRelation|deleteIssueRelation|rawRequest)\b/u);
});

test("verified Human Actor exposes only bounded E2E baseline reset, Root, and ordinary Markdown comment operations", async () => {
  const calls = [];
  const client = humanClient(calls);
  const { human } = await verifiedActors(client);

  assert.deepEqual(Object.keys(human).sort(), [
    "createComment",
    "createRoot",
    "discoverProjectRouting",
    "editComment",
    "readActorId",
    "readSymphonyActorId",
    "reopenCommentThread",
    "resetE2EProject",
    "resolveCommentThread",
    "resolveHumanAction",
    "updateRoot",
  ]);

  const root = await human.createRoot({
    team_id: "team-1",
    project_id: "project-1",
    routing_label_ids: ["route-a", "route-b"],
    title: "Test Root",
    description: "Need a real user flow.",
    priority: 2,
    status_id: "state-todo",
  });
  assert.deepEqual(root, { root_issue_id: "root-1" });
  assert.deepEqual(calls.shift(), {
    kind: "create_issue",
    input: {
      teamId: "team-1",
      projectId: "project-1",
      labelIds: ["route-a", "route-b"],
      title: "Test Root",
      description: "Need a real user flow.",
      priority: 2,
      stateId: "state-todo",
    },
  });

  await human.updateRoot({
    root_issue_id: root.root_issue_id,
    description: "Updated scope.",
    priority: 1,
    status_id: "state-in-progress",
  });
  assert.deepEqual(calls.shift(), {
    kind: "update_issue",
    issue_id: "root-1",
    input: { description: "Updated scope.", priority: 1, stateId: "state-in-progress" },
  });

  const markdown = "User input \u2705\n\n```js\nconst approved = true;\n```";
  const createdComment = await human.createComment({ issue_id: root.root_issue_id, body: markdown });
  assert.deepEqual(createdComment, { comment_id: "human-comment-2" });
  await human.editComment({ comment_id: "human-comment-1", body: "Edited \ud83d\udd0d\n\n```text\nverified\n```" });
  assert.deepEqual(calls, [
    { kind: "create_comment", input: { issueId: "root-1", body: markdown } },
    { kind: "read_comment", comment_id: "human-comment-1" },
    { kind: "update_comment", comment_id: "human-comment-1", input: { body: "Edited \ud83d\udd0d\n\n```text\nverified\n```" } },
  ]);
});

test("E2E baseline reset flat-archives every active Project Issue without walking Root children", async () => {
  const calls = [];
  const activeIssues = new Map();
  const root = projectIssue({ id: "root-1", parentId: null, stateName: "Canceled", activeIssues, calls });
  const child = projectIssue({ id: "child-1", parentId: "root-1", stateName: "Done", activeIssues, calls });
  activeIssues.set(root.id, root);
  activeIssues.set(child.id, child);
  const client = humanClient(calls);
  client.project = async (projectSlugId) => {
    calls.push({ kind: "read_project", project_slug_id: projectSlugId });
    return {
      id: "project-1",
      issues: async (input) => {
        calls.push({ kind: "read_project_issues", input });
        return connection([...activeIssues.values()]);
      },
      labels: async () => connection([]),
    };
  };
  const { human } = await verifiedActors(client);

  const result = await human.resetE2EProject({ project_slug_id: "e2e-project" });

  assert.deepEqual(result, { project_id: "project-1" });
  assert.deepEqual(calls.filter(({ kind }) => kind === "archive_issue").map(({ issue_id: issueId }) => issueId), [
    "root-1",
    "child-1",
  ]);
  assert.equal(calls.some(({ kind }) => kind === "read_issue_children"), false);
  assert.equal(activeIssues.size, 0);
  assert.deepEqual(calls.filter(({ kind }) => kind === "read_project"), [
    { kind: "read_project", project_slug_id: "e2e-project" },
    { kind: "read_project", project_slug_id: "e2e-project" },
    { kind: "read_project", project_slug_id: "e2e-project" },
  ]);
  assert.deepEqual(calls.filter(({ kind }) => kind === "read_project_issues").map(({ input }) => input), [
    { first: 250 },
    { first: 250 },
  ]);
});

test("E2E baseline reset fails closed when Project Issues cannot read back empty", async () => {
  const calls = [];
  const issue = {
    id: "root-1",
    parentId: null,
    async archive() {
      calls.push({ kind: "archive_issue", issue_id: "root-1" });
      return { success: true };
    },
  };
  const client = humanClient(calls);
  client.project = async () => ({
    id: "project-1",
    issues: async () => connection([issue]),
    labels: async () => connection([]),
  });
  const { human } = await verifiedActors(client);

  await assert.rejects(
    human.resetE2EProject({ project_slug_id: "e2e-project" }),
    /external_linear_e2e_project_reset_issue_read_back_failed/u,
  );
  assert.deepEqual(calls, [{ kind: "archive_issue", issue_id: "root-1" }]);
});

test("E2E baseline reset does not retire routing labels before active Issues read back empty", async () => {
  const calls = [];
  const issue = {
    id: "root-1",
    async archive() {
      calls.push({ kind: "archive_issue", issue_id: "root-1" });
      return { success: true };
    },
  };
  const project = {
    id: "project-1",
    issues: async () => connection([issue]),
    labels: async () => connection([{
      id: "project-label-1",
      name: "symphony:conductor/abcdef123456",
      isGroup: false,
      archivedAt: null,
      retiredById: null,
      projects: async () => connection([project]),
    }]),
    teams: async () => connection([{ id: "team-1" }]),
  };
  const client = humanClient(calls);
  client.project = async () => project;
  client.issueLabels = async () => connection([{
    id: "issue-label-1",
    name: "symphony:conductor/abcdef123456",
    isGroup: false,
    archivedAt: null,
    retiredById: null,
    teamId: "team-1",
    issues: async () => connection([]),
  }]);
  client.issueLabelRetire = async (labelId) => {
    calls.push({ kind: "retire_issue_label", label_id: labelId });
    return { success: true };
  };
  const { human } = await verifiedActors(client);

  await assert.rejects(
    human.resetE2EProject({ project_slug_id: "e2e-project" }),
    /external_linear_e2e_project_reset_issue_read_back_failed/u,
  );
  assert.deepEqual(calls, [{ kind: "archive_issue", issue_id: "root-1" }]);
});

test("E2E baseline reset removes and retires only stale exclusive conductor routing labels idempotently", async () => {
  const calls = [];
  const activeIssues = new Map();
  const projectLabels = new Map();
  const issueLabels = new Map();
  const project = {
    id: "project-1",
    issues: async () => connection([...activeIssues.values()]),
    teams: async () => connection([{ id: "team-1" }]),
    labels: async () => connection([...projectLabels.values()]),
  };
  const projectLabel = {
    id: "project-label-1",
    name: "symphony:conductor/abcdef123456",
    isGroup: false,
    archivedAt: null,
    retiredById: null,
    projects: async () => connection([project]),
  };
  const issueLabel = {
    id: "issue-label-1",
    name: projectLabel.name,
    isGroup: false,
    archivedAt: null,
    retiredById: null,
    teamId: "team-1",
    issues: async () => connection([]),
  };
  projectLabels.set(projectLabel.id, projectLabel);
  issueLabels.set(issueLabel.id, issueLabel);
  const active = projectIssue({ id: "root-1", parentId: null, stateName: "Todo", activeIssues, calls });
  activeIssues.set(active.id, active);
  const client = humanClient(calls);
  client.project = async () => project;
  client.issueLabels = async (input) => {
    calls.push({ kind: "read_issue_labels", input });
    return connection([...issueLabels.values()].filter(({ name, retiredById }) =>
      name === input.filter?.name?.eq && retiredById === null,
    ));
  };
  client.projectRemoveLabel = async (projectId, labelId) => {
    calls.push({ kind: "remove_project_label", project_id: projectId, label_id: labelId });
    projectLabels.delete(labelId);
    return { success: true };
  };
  client.projectLabelRetire = async (labelId) => {
    calls.push({ kind: "retire_project_label", label_id: labelId });
    projectLabel.retiredById = "human-actor";
    return { success: true };
  };
  client.issueLabelRetire = async (labelId) => {
    calls.push({ kind: "retire_issue_label", label_id: labelId });
    issueLabel.retiredById = "human-actor";
    return { success: true };
  };
  const { human } = await verifiedActors(client);

  assert.deepEqual(await human.resetE2EProject({ project_slug_id: "e2e-project" }), { project_id: "project-1" });
  assert.deepEqual(calls.filter(({ kind }) => kind === "archive_issue").map(({ issue_id: issueId }) => issueId), ["root-1"]);
  assert.deepEqual(calls.filter(({ kind }) => kind === "remove_project_label"), [
    { kind: "remove_project_label", project_id: "project-1", label_id: "project-label-1" },
  ]);
  assert.deepEqual(calls.filter(({ kind }) => kind.startsWith("retire_")), [
    { kind: "retire_issue_label", label_id: "issue-label-1" },
    { kind: "retire_project_label", label_id: "project-label-1" },
  ]);
  assert.equal(projectLabels.size, 0);
  assert.equal(issueLabel.retiredById, "human-actor");

  const firstMutationCount = calls.filter(({ kind }) => kind === "remove_project_label" || kind.startsWith("retire_")).length;
  await human.resetE2EProject({ project_slug_id: "e2e-project" });
  assert.equal(calls.filter(({ kind }) => kind === "remove_project_label" || kind.startsWith("retire_")).length, firstMutationCount);
});

test("E2E baseline reset fails closed before mutation when active conductor Project labels are ambiguous", async () => {
  const calls = [];
  const project = {
    id: "project-1",
    issues: async () => connection([]),
    labels: async () => connection([
      conductorProjectLabel("project-label-1"),
      conductorProjectLabel("project-label-2"),
    ]),
    teams: async () => connection([{ id: "team-1" }]),
  };
  function conductorProjectLabel(id) {
    return {
      id,
      name: "symphony:conductor/abcdef123456",
      isGroup: false,
      archivedAt: null,
      retiredById: null,
      projects: async () => connection([project]),
    };
  }
  const client = humanClient(calls);
  client.project = async () => project;
  const { human } = await verifiedActors(client);

  await assert.rejects(
    human.resetE2EProject({ project_slug_id: "e2e-project" }),
    /external_linear_e2e_project_reset_label_ownership_invalid/u,
  );
  assert.deepEqual(calls, []);
});

test("E2E baseline reset fails closed before mutation when a routing label has an external Project association", async () => {
  const calls = [];
  const project = {
    id: "project-1",
    issues: async () => connection([]),
    teams: async () => connection([{ id: "team-1" }]),
    labels: async () => connection([{
      id: "project-label-1",
      name: "symphony:conductor/abcdef123456",
      isGroup: false,
      archivedAt: null,
      retiredById: null,
      projects: async () => connection([{ id: "project-1" }, { id: "foreign-project" }]),
    }]),
  };
  const client = humanClient(calls);
  client.project = async () => project;
  client.issueLabels = async () => connection([{
    id: "issue-label-1",
    name: "symphony:conductor/abcdef123456",
    isGroup: false,
    archivedAt: null,
    retiredById: null,
    teamId: "team-1",
    issues: async () => connection([]),
  }]);
  const { human } = await verifiedActors(client);

  await assert.rejects(
    human.resetE2EProject({ project_slug_id: "e2e-project" }),
    /external_linear_e2e_project_reset_label_ownership_invalid/u,
  );
  assert.equal(calls.some(({ kind }) => kind === "remove_project_label" || kind === "retire_project_label"), false);
});

test("Human Actor discovers the exact Project Team and active routing Labels through the public Linear boundary", async () => {
  const calls = [];
  const client = humanClient(calls);
  client.project = async (projectId) => {
    calls.push({ kind: "read_project", project_id: projectId });
    return {
      id: projectId,
      teams: async () => connection([{ id: "team-1" }]),
      labels: async () => connection([
        { id: "label-a", name: "symphony:conductor/abcdef123456", isGroup: false, archivedAt: null, retiredById: null },
        { id: "label-b", name: "symphony:conductor/abcdef123457", isGroup: false, archivedAt: null, retiredById: null },
        { id: "label-c", name: "symphony:conductor/abcdef123458", isGroup: false, archivedAt: null, retiredById: null },
      ]),
    };
  };
  const { human } = await verifiedActors(client);

  const routing = await human.discoverProjectRouting({
    project_id: "project-1",
    conductor_short_hashes: ["abcdef123456", "abcdef123457", "abcdef123458"],
  });

  assert.deepEqual(routing, {
    team_id: "team-1",
    routing_labels: [
      { conductor_short_hash: "abcdef123456", label_id: "label-a" },
      { conductor_short_hash: "abcdef123457", label_id: "label-b" },
      { conductor_short_hash: "abcdef123458", label_id: "label-c" },
    ],
  });
  assert.deepEqual(calls, [{ kind: "read_project", project_id: "project-1" }]);
});

test("Human Actor resolves only verified Human Actions and writes required reason before terminal status", async () => {
  const calls = [];
  const client = humanClient(calls);
  const { human } = await verifiedActors(client);

  await human.resolveHumanAction({
    human_action_issue_id: "action-1",
    terminal_status: "rejected",
    reason_or_answer: "The plan omits rollback behavior.",
  });
  assert.deepEqual(calls, [
    { kind: "read_issue", issue_id: "action-1" },
    { kind: "create_comment", input: { issueId: "action-1", body: "The plan omits rollback behavior." } },
    { kind: "update_issue", issue_id: "action-1", input: { stateId: "state-rejected" } },
  ]);

  calls.length = 0;
  await assert.rejects(
    human.resolveHumanAction({ human_action_issue_id: "action-1", terminal_status: "answered" }),
    /external_linear_human_action_input_invalid/u,
  );
  await assert.rejects(
    human.resolveHumanAction({
      human_action_issue_id: "plan-1",
      terminal_status: "approved",
    }),
    /external_linear_human_action_target_invalid/u,
  );
  assert.deepEqual(calls, [{ kind: "read_issue", issue_id: "plan-1" }]);
});

test("Human Actor maps every no-comment terminal status from the verified team catalog", async () => {
  const calls = [];
  const { human } = await verifiedActors(humanClient(calls));

  await human.resolveHumanAction({ human_action_issue_id: "action-1", terminal_status: "approved" });
  await human.resolveHumanAction({ human_action_issue_id: "action-1", terminal_status: "canceled" });
  assert.deepEqual(calls, [
    { kind: "read_issue", issue_id: "action-1" },
    { kind: "update_issue", issue_id: "action-1", input: { stateId: "state-approved" } },
    { kind: "read_issue", issue_id: "action-1" },
    { kind: "update_issue", issue_id: "action-1", input: { stateId: "state-canceled" } },
  ]);

  calls.length = 0;
  await assert.rejects(
    human.resolveHumanAction({ human_action_issue_id: "action-1", terminal_status: "done" }),
    /external_linear_human_action_input_invalid/u,
  );
  assert.deepEqual(calls, []);
});

test("Human Actor rejects managed content and non-human lifecycle mutations before writes", async () => {
  const calls = [];
  const client = humanClient(calls);
  const { human } = await verifiedActors(client);

  await assert.rejects(
    human.createComment({ issue_id: "root-1", body: "```symphony\n{\"kind\":\"stage_result\"}\n```" }),
    /external_linear_human_markdown_managed_forbidden/u,
  );
  await assert.rejects(
    human.createRoot({
      team_id: "team-1",
      project_id: "project-1",
      routing_label_ids: ["route-a"],
      title: "Managed root",
      description: "```symphony\n{\"kind\":\"workflow_issue\"}\n```",
    }),
    /external_linear_human_markdown_managed_forbidden/u,
  );
  await assert.rejects(
    human.updateRoot({ root_issue_id: "plan-1", status_id: "state-done" }),
    /external_linear_human_root_unknown/u,
  );
  await assert.rejects(
    human.createRoot({
      team_id: "team-1",
      project_id: "project-1",
      routing_label_ids: ["route-a", "route-a"],
      title: "Duplicate routing labels",
      description: "Rejected before Linear.",
    }),
    /external_linear_human_root_input_invalid/u,
  );
  assert.deepEqual(calls, []);
  assert.equal("archiveIssue" in human, false);
  assert.equal("updateIssue" in human, false);
  assert.equal("createReaction" in human, false);
  assert.equal("client" in human, false);
});

test("Human Actor cannot edit another actor or a managed comment", async () => {
  const calls = [];
  const { human } = await verifiedActors(humanClient(calls, { commentAuthorId: "symphony-actor" }));

  await assert.rejects(
    human.editComment({ comment_id: "managed-comment", body: "Attempted edit" }),
    /external_linear_human_comment_target_invalid/u,
  );
  assert.deepEqual(calls, [{ kind: "read_comment", comment_id: "managed-comment" }]);

  calls.length = 0;
  const { human: ownCommentHuman } = await verifiedActors(humanClient(calls, {
    commentBody: "```symphony\n{\"kind\":\"workflow_timeline\"}\n```",
  }));
  await assert.rejects(
    ownCommentHuman.editComment({ comment_id: "managed-comment", body: "Attempted edit" }),
    /external_linear_human_comment_target_invalid/u,
  );
  assert.deepEqual(calls, [{ kind: "read_comment", comment_id: "managed-comment" }]);
});

test("Human Actor maps native thread operations and redacts external write failures", async () => {
  const calls = [];
  const client = humanClient(calls, { createCommentError: new Error("remote human-token failure") });
  const { human } = await verifiedActors(client);

  await human.resolveCommentThread({ thread_root_comment_id: "comment-1" });
  await human.reopenCommentThread({ thread_root_comment_id: "comment-1" });
  assert.deepEqual(calls, [
    { kind: "resolve_thread", comment_id: "comment-1" },
    { kind: "reopen_thread", comment_id: "comment-1" },
  ]);

  await assert.rejects(
    human.createComment({ issue_id: "root-1", body: "A normal comment" }),
    (error) => error.code === "external_linear_human_comment_create_failed" && !error.message.includes("human-token"),
  );
});

function viewerClient(id) {
  return { viewer: Promise.resolve({ id }) };
}

async function verifiedActors(humanClientValue) {
  return createVerifiedExternalLinearActors({
    symphonyAccessToken: "symphony-token",
    humanApiKey: "human-api-key",
    createClient(input) {
      return input.accessToken === "symphony-token" ? viewerClient("symphony-actor") : humanClientValue;
    },
  });
}

function humanClient(calls, { createCommentError, commentAuthorId = "human-actor", commentBody = "Original user input" } = {}) {
  const humanAction = {
    labels: async () => connection([{ id: "label-human", name: "Human Action" }]),
    state: Promise.resolve({ id: "state-todo", name: "Todo", type: "unstarted" }),
    team: Promise.resolve({
      states: async () => connection([
        { id: "state-approved", name: "Approved", type: "completed" },
        { id: "state-rejected", name: "Rejected", type: "canceled" },
        { id: "state-answered", name: "Answered", type: "completed" },
        { id: "state-canceled", name: "Canceled", type: "canceled" },
      ]),
    }),
  };
  const plan = {
    labels: async () => connection([{ id: "label-plan", name: "Plan" }]),
    team: humanAction.team,
  };
  return {
    viewer: Promise.resolve({ id: "human-actor" }),
    async createIssue(input) {
      calls.push({ kind: "create_issue", input });
      return { success: true, issueId: "root-1" };
    },
    async updateIssue(issueId, input) {
      calls.push({ kind: "update_issue", issue_id: issueId, input });
      return { success: true, issueId };
    },
    async createComment(input) {
      if (createCommentError) throw createCommentError;
      calls.push({ kind: "create_comment", input });
      return { success: true, commentId: "human-comment-2" };
    },
    async updateComment(commentId, input) {
      calls.push({ kind: "update_comment", comment_id: commentId, input });
      return { success: true, commentId };
    },
    async comment({ id }) {
      calls.push({ kind: "read_comment", comment_id: id });
      return { body: commentBody, user: Promise.resolve({ id: commentAuthorId }) };
    },
    async issue(issueId) {
      calls.push({ kind: "read_issue", issue_id: issueId });
      return issueId === "action-1" ? humanAction : plan;
    },
    async commentResolve(commentId) {
      calls.push({ kind: "resolve_thread", comment_id: commentId });
      return { success: true, commentId };
    },
    async commentUnresolve(commentId) {
      calls.push({ kind: "reopen_thread", comment_id: commentId });
      return { success: true, commentId };
    },
  };
}

function connection(nodes) {
  return {
    nodes,
    pageInfo: { hasNextPage: false },
    async fetchNext() {},
  };
}

function projectIssue({ id, parentId, stateName, activeIssues, calls }) {
  return {
    id,
    parentId,
    state: Promise.resolve({ name: stateName }),
    async archive() {
      calls.push({ kind: "archive_issue", issue_id: id });
      activeIssues.delete(id);
      return { success: true };
    },
    async children() {
      calls.push({ kind: "read_issue_children", issue_id: id });
      throw new Error("Project reset must not traverse Issue children");
    },
  };
}
