import { LinearClient } from "@linear/sdk";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const CONDUCTOR_SHORT_HASH = /^[a-f0-9]{12}$/u;
const CONDUCTOR_LABEL_NAME = /^symphony:conductor\/[a-f0-9]{12}$/u;
const MANAGED_CODE_BLOCK = /(?:^|\r?\n)[ \t]*(?:```|~~~)[ \t]*symphony[ \t]*(?:\r?\n|$)/iu;
const MAX_ROOT_TITLE_LENGTH = 256;
const MAX_ROOT_DESCRIPTION_LENGTH = 16_384;
const MAX_COMMENT_LENGTH = 16_384;
const MAX_CONNECTION_NODES = 512;
const TERMINAL_ACTION_STATUSES = Object.freeze({
  approved: Object.freeze({ name: "Approved", category: "completed", requiresComment: false }),
  rejected: Object.freeze({ name: "Rejected", category: "canceled", requiresComment: true }),
  answered: Object.freeze({ name: "Answered", category: "completed", requiresComment: true }),
  canceled: Object.freeze({ name: "Canceled", category: "canceled", requiresComment: false }),
});

export async function createVerifiedExternalLinearActors({
  symphonyAccessToken,
  humanApiKey,
  createClient = createLinearClient,
}) {
  if (!token(symphonyAccessToken) || !token(humanApiKey) || typeof createClient !== "function") {
    throw stableError("external_linear_actor_input_invalid");
  }
  if (symphonyAccessToken === humanApiKey) {
    throw stableError("external_linear_actor_credentials_not_distinct");
  }

  const symphony = externalActorClient({ clientOptions: { accessToken: symphonyAccessToken }, createClient });
  const human = externalActorClient({ clientOptions: { apiKey: humanApiKey }, createClient });
  const [symphonyActorId, humanActorId] = await Promise.all([
    symphony.readActorId(),
    human.readActorId(),
  ]);
  if (symphonyActorId === humanActorId) {
    throw stableError("external_linear_actor_identities_not_distinct");
  }

  return Object.freeze({
    symphony_actor_id: symphonyActorId,
    human_actor_id: humanActorId,
    human: human.operations({ humanAuthorId: humanActorId, symphonyActorId }),
  });
}

function externalActorClient({ clientOptions, createClient }) {
  let client;
  try {
    client = createClient(clientOptions);
  } catch {
    throw stableError("external_linear_actor_client_invalid");
  }
  if (!client || typeof client !== "object" || !("viewer" in client)) {
    throw stableError("external_linear_actor_client_invalid");
  }
  return Object.freeze({
    async readActorId() {
      let viewer;
      try {
        viewer = await client.viewer;
      } catch {
        throw stableError("external_linear_actor_identity_read_failed");
      }
      if (!viewer || typeof viewer !== "object" || Array.isArray(viewer) || !identifier(viewer.id)) {
        throw stableError("external_linear_actor_identity_invalid");
      }
      return viewer.id;
    },
    operations({ humanAuthorId, symphonyActorId }) {
      const createdRootIds = new Set();
      return Object.freeze({
        readActorId: this.readActorId,
        async readSymphonyActorId() { return symphonyActorId; },
        async resetE2EProject(input) {
          const reset = e2eProjectResetInput(input);
          const project = await sdkCall("external_linear_e2e_project_reset_read_failed", () => client.project(
            reset.project_slug_id,
          ));
          const issues = await sdkCall("external_linear_e2e_project_reset_issue_read_failed", () => flatActiveProjectIssues(project));
          for (const issue of issues) assertArchivableProjectIssue(issue);
          for (const issue of issues) {
            const payload = await sdkCall("external_linear_e2e_project_reset_issue_archive_failed", () => issue.archive());
            assertWriteSuccess(payload, "external_linear_e2e_project_reset_issue_archive_failed");
          }
          const baselineProject = await sdkCall("external_linear_e2e_project_reset_read_failed", () => client.project(
            reset.project_slug_id,
          ));
          const remaining = await sdkCall("external_linear_e2e_project_reset_issue_read_back_failed", () => flatActiveProjectIssues(baselineProject));
          if (remaining.length !== 0) throw stableError("external_linear_e2e_project_reset_issue_read_back_failed");
          const routingLabels = await resetConductorRoutingLabels({ client, project: baselineProject });
          const finalProject = await sdkCall("external_linear_e2e_project_reset_read_failed", () => client.project(
            reset.project_slug_id,
          ));
          await assertNoActiveConductorRouting({ client, project: finalProject, routingLabels });
          return Object.freeze({ project_id: project.id });
        },
        async discoverProjectRouting(input) {
          const routing = projectRoutingInput(input);
          const project = await sdkCall("external_linear_human_project_routing_read_failed", () => client.project(
            routing.project_id,
          ));
          return projectRouting(project, routing);
        },
        async createRoot(input) {
          const root = rootCreateInput(input);
          const payload = await sdkCall("external_linear_human_root_create_failed", () => client.createIssue({
            teamId: root.team_id,
            projectId: root.project_id,
            labelIds: root.routing_label_ids,
            title: root.title,
            description: root.description,
            ...(root.priority === undefined ? {} : { priority: root.priority }),
            ...(root.status_id === undefined ? {} : { stateId: root.status_id }),
          }));
          if (!payload || payload.success !== true || !identifier(payload.issueId)) {
            throw stableError("external_linear_human_root_create_failed");
          }
          createdRootIds.add(payload.issueId);
          return Object.freeze({ root_issue_id: payload.issueId });
        },
        async updateRoot(input) {
          const root = rootUpdateInput(input);
          if (!createdRootIds.has(root.root_issue_id)) {
            throw stableError("external_linear_human_root_unknown");
          }
          const payload = await sdkCall("external_linear_human_root_update_failed", () => client.updateIssue(
            root.root_issue_id,
            rootUpdatePayload(root),
          ));
          assertWriteSuccess(payload, "external_linear_human_root_update_failed");
        },
        async createComment(input) {
          const comment = commentCreateInput(input);
          const payload = await sdkCall("external_linear_human_comment_create_failed", () => client.createComment({
            issueId: comment.issue_id,
            body: comment.body,
          }));
          if (!payload || payload.success !== true || !identifier(payload.commentId)) {
            throw stableError("external_linear_human_comment_create_failed");
          }
          return Object.freeze({ comment_id: payload.commentId });
        },
        async editComment(input) {
          const comment = commentEditInput(input);
          const existing = await sdkCall("external_linear_human_comment_read_failed", () => client.comment({
            id: comment.comment_id,
          }));
          await assertHumanEditableComment(existing, humanAuthorId);
          const payload = await sdkCall("external_linear_human_comment_update_failed", () => client.updateComment(
            comment.comment_id,
            { body: comment.body },
          ));
          assertWriteSuccess(payload, "external_linear_human_comment_update_failed");
        },
        async resolveHumanAction(input) {
          const action = humanActionInput(input);
          const status = TERMINAL_ACTION_STATUSES[action.terminal_status];
          if (status.requiresComment && action.reason_or_answer === undefined) {
            throw stableError("external_linear_human_action_input_invalid");
          }
          const issue = await sdkCall("external_linear_human_action_read_failed", () => client.issue(action.human_action_issue_id));
          const stateId = await actionTerminalStateId(issue, status);
          if (action.reason_or_answer !== undefined) {
            const payload = await sdkCall("external_linear_human_action_comment_create_failed", () => client.createComment({
              issueId: action.human_action_issue_id,
              body: action.reason_or_answer,
            }));
            assertWriteSuccess(payload, "external_linear_human_action_comment_create_failed");
          }
          const payload = await sdkCall("external_linear_human_action_update_failed", () => client.updateIssue(
            action.human_action_issue_id,
            { stateId },
          ));
          assertWriteSuccess(payload, "external_linear_human_action_update_failed");
        },
        async resolveCommentThread(input) {
          const comment = threadInput(input);
          const payload = await sdkCall("external_linear_human_thread_resolve_failed", () => client.commentResolve(comment.thread_root_comment_id));
          assertWriteSuccess(payload, "external_linear_human_thread_resolve_failed");
        },
        async reopenCommentThread(input) {
          const comment = threadInput(input);
          const payload = await sdkCall("external_linear_human_thread_reopen_failed", () => client.commentUnresolve(comment.thread_root_comment_id));
          assertWriteSuccess(payload, "external_linear_human_thread_reopen_failed");
        },
      });
    },
  });
}

function rootCreateInput(value) {
  const root = record(value, "external_linear_human_root_input_invalid");
  assertKeys(root, ["team_id", "project_id", "routing_label_ids", "title", "description"], ["priority", "status_id"], "external_linear_human_root_input_invalid");
  if (!identifier(root.team_id) || !identifier(root.project_id) ||
      !uniqueIdentifiers(root.routing_label_ids) || !boundedText(root.title, MAX_ROOT_TITLE_LENGTH, { nonempty: true }) ||
      !unmanagedMarkdown(root.description, MAX_ROOT_DESCRIPTION_LENGTH) || !priority(root.priority) ||
      root.status_id !== undefined && !identifier(root.status_id)) {
    throw stableError("external_linear_human_root_input_invalid");
  }
  return root;
}

function e2eProjectResetInput(value) {
  const reset = record(value, "external_linear_e2e_project_reset_input_invalid");
  assertKeys(reset, ["project_slug_id"], [], "external_linear_e2e_project_reset_input_invalid");
  if (!identifier(reset.project_slug_id)) throw stableError("external_linear_e2e_project_reset_input_invalid");
  return reset;
}

async function flatActiveProjectIssues(project) {
  if (!project || typeof project !== "object" || !identifier(project.id) || typeof project.issues !== "function") {
    throw stableError("external_linear_e2e_project_reset_project_invalid");
  }
  return readAllNodes(() => project.issues({ first: 250 }));
}

function assertArchivableProjectIssue(issue) {
  if (!issue || typeof issue !== "object" || !identifier(issue.id) || typeof issue.archive !== "function") {
    throw stableError("external_linear_e2e_project_reset_project_invalid");
  }
}

async function resetConductorRoutingLabels({ client, project }) {
  const labels = await sdkCall("external_linear_e2e_project_reset_label_read_failed", () => activeConductorProjectLabels(project));
  if (labels.length === 0) return [];
  if (new Set(labels.map(({ name }) => name)).size !== labels.length) {
    throw stableError("external_linear_e2e_project_reset_label_ownership_invalid");
  }
  const teamId = await sdkCall("external_linear_e2e_project_reset_label_read_failed", () => soleProjectTeamId(project));
  const members = [];
  for (const projectLabel of labels) {
    await sdkCall("external_linear_e2e_project_reset_label_ownership_invalid", () => assertExclusiveProjectLabel(projectLabel, project.id));
    const issueLabel = await sdkCall("external_linear_e2e_project_reset_label_read_failed", () => matchingIssueLabel({
      client,
      teamId,
      name: projectLabel.name,
    }));
    if (issueLabel !== undefined) {
      await sdkCall("external_linear_e2e_project_reset_label_ownership_invalid", () => assertNoActiveIssueUsesLabel(issueLabel));
    }
    members.push({ projectLabel, issueLabel });
  }
  for (const member of members) {
    // Retiring first makes an interrupted reset leave no active routing surface.
    if (member.issueLabel && activeLabel(member.issueLabel)) {
      const payload = await sdkCall("external_linear_e2e_project_reset_label_mutation_failed", () => retireIssueLabel(client, member.issueLabel.id));
      assertWriteSuccess(payload, "external_linear_e2e_project_reset_label_mutation_failed");
    }
    if (activeLabel(member.projectLabel)) {
      const payload = await sdkCall("external_linear_e2e_project_reset_label_mutation_failed", () => retireProjectLabel(client, member.projectLabel.id));
      assertWriteSuccess(payload, "external_linear_e2e_project_reset_label_mutation_failed");
    }
    const payload = await sdkCall("external_linear_e2e_project_reset_label_mutation_failed", () => removeProjectLabel(
      client,
      project.id,
      member.projectLabel.id,
    ));
    assertWriteSuccess(payload, "external_linear_e2e_project_reset_label_mutation_failed");
  }
  return members.map(({ projectLabel }) => ({ name: projectLabel.name, teamId }));
}

async function assertNoActiveConductorRouting({ client, project, routingLabels }) {
  const labels = await sdkCall("external_linear_e2e_project_reset_label_read_back_failed", () => activeConductorProjectLabels(project));
  if (labels.length !== 0) throw stableError("external_linear_e2e_project_reset_label_read_back_failed");
  for (const { name, teamId } of routingLabels) {
    const issueLabel = await sdkCall("external_linear_e2e_project_reset_label_read_back_failed", () => matchingIssueLabel({
      client,
      teamId,
      name,
    }));
    if (activeLabel(issueLabel)) throw stableError("external_linear_e2e_project_reset_label_read_back_failed");
  }
}

async function activeConductorProjectLabels(project) {
  if (!project || typeof project !== "object" || !identifier(project.id) || typeof project.labels !== "function") {
    throw stableError("external_linear_e2e_project_reset_project_invalid");
  }
  const labels = await readAllNodes(() => project.labels({ first: 250 }));
  return labels.filter((label) => activeLabel(label) && CONDUCTOR_LABEL_NAME.test(label.name));
}

async function soleProjectTeamId(project) {
  if (!project || typeof project !== "object" || typeof project.teams !== "function") {
    throw stableError("external_linear_e2e_project_reset_project_invalid");
  }
  const teams = await readAllNodes(() => project.teams({ first: 32 }));
  if (teams.length !== 1 || !identifier(teams[0]?.id)) {
    throw stableError("external_linear_e2e_project_reset_project_invalid");
  }
  return teams[0].id;
}

async function assertExclusiveProjectLabel(label, projectId) {
  if (!activeLabel(label) || typeof label.projects !== "function") {
    throw stableError("external_linear_e2e_project_reset_label_ownership_invalid");
  }
  const projects = await readAllNodes(() => label.projects({ first: 32 }));
  if (projects.length !== 1 || projects[0]?.id !== projectId) {
    throw stableError("external_linear_e2e_project_reset_label_ownership_invalid");
  }
}

async function matchingIssueLabel({ client, teamId, name }) {
  if (!client || typeof client.issueLabels !== "function") {
    throw stableError("external_linear_e2e_project_reset_label_read_failed");
  }
  const labels = await readAllNodes(() => client.issueLabels({
    first: 3,
    includeArchived: false,
    filter: { name: { eq: name }, isGroup: { eq: false } },
  }));
  const matches = labels.filter((label) => label && typeof label === "object" && identifier(label.id) &&
    label.name === name && label.isGroup === false && (label.teamId === undefined || label.teamId === teamId));
  if (matches.length > 1) throw stableError("external_linear_e2e_project_reset_label_ownership_invalid");
  return matches[0];
}

async function assertNoActiveIssueUsesLabel(label) {
  if (!label || typeof label !== "object" || typeof label.issues !== "function") {
    throw stableError("external_linear_e2e_project_reset_label_ownership_invalid");
  }
  const issues = await readAllNodes(() => label.issues({ first: 250 }));
  if (issues.some((issue) => !issue || typeof issue !== "object" || issue.archivedAt === null || issue.archivedAt === undefined)) {
    throw stableError("external_linear_e2e_project_reset_label_ownership_invalid");
  }
}

function activeLabel(label) {
  return label && typeof label === "object" && identifier(label.id) && typeof label.name === "string" &&
    label.isGroup === false && (label.archivedAt === null || label.archivedAt === undefined) &&
    (label.retiredById === null || label.retiredById === undefined);
}

function retireProjectLabel(client, labelId) {
  if (typeof client.projectLabelRetire !== "function") throw stableError("external_linear_e2e_project_reset_label_mutation_failed");
  return client.projectLabelRetire(labelId);
}

function retireIssueLabel(client, labelId) {
  if (typeof client.issueLabelRetire !== "function") throw stableError("external_linear_e2e_project_reset_label_mutation_failed");
  return client.issueLabelRetire(labelId);
}

function removeProjectLabel(client, projectId, labelId) {
  if (typeof client.projectRemoveLabel !== "function") throw stableError("external_linear_e2e_project_reset_label_mutation_failed");
  return client.projectRemoveLabel(projectId, labelId);
}

function projectRoutingInput(value) {
  const routing = record(value, "external_linear_human_project_routing_input_invalid");
  assertKeys(routing, ["project_id", "conductor_short_hashes"], [], "external_linear_human_project_routing_input_invalid");
  if (!identifier(routing.project_id) || !Array.isArray(routing.conductor_short_hashes) ||
      routing.conductor_short_hashes.length < 3 || routing.conductor_short_hashes.length > 32 ||
      !routing.conductor_short_hashes.every((hash) => CONDUCTOR_SHORT_HASH.test(hash)) ||
      new Set(routing.conductor_short_hashes).size !== routing.conductor_short_hashes.length) {
    throw stableError("external_linear_human_project_routing_input_invalid");
  }
  return routing;
}

async function projectRouting(project, routing) {
  if (!project || typeof project !== "object" || project.id !== routing.project_id ||
      typeof project.teams !== "function" || typeof project.labels !== "function") {
    throw stableError("external_linear_human_project_routing_invalid");
  }
  let teams;
  let labels;
  try {
    [teams, labels] = await Promise.all([
      readAllNodes(() => project.teams({ first: 32 })),
      readAllNodes(() => project.labels({ first: 250 })),
    ]);
  } catch {
    throw stableError("external_linear_human_project_routing_read_failed");
  }
  if (teams.length !== 1 || !identifier(teams[0]?.id)) {
    throw stableError("external_linear_human_project_routing_invalid");
  }
  const routingLabels = routing.conductor_short_hashes.map((conductorShortHash) => {
    const labelName = `symphony:conductor/${conductorShortHash}`;
    const matches = labels.filter((label) => label && typeof label === "object" &&
      identifier(label.id) && label.name === labelName && label.isGroup === false &&
      (label.archivedAt === null || label.archivedAt === undefined) &&
      (label.retiredById === null || label.retiredById === undefined));
    if (matches.length !== 1) throw stableError("external_linear_human_project_routing_invalid");
    return Object.freeze({ conductor_short_hash: conductorShortHash, label_id: matches[0].id });
  });
  return Object.freeze({
    team_id: teams[0].id,
    routing_labels: Object.freeze(routingLabels),
  });
}

function rootUpdateInput(value) {
  const root = record(value, "external_linear_human_root_input_invalid");
  assertKeys(root, ["root_issue_id"], ["description", "priority", "status_id"], "external_linear_human_root_input_invalid");
  if (!identifier(root.root_issue_id) || (root.description === undefined && root.priority === undefined && root.status_id === undefined) ||
      root.description !== undefined && !unmanagedMarkdown(root.description, MAX_ROOT_DESCRIPTION_LENGTH) ||
      !priority(root.priority) || root.status_id !== undefined && !identifier(root.status_id)) {
    throw stableError("external_linear_human_root_input_invalid");
  }
  return root;
}

function rootUpdatePayload(root) {
  return {
    ...(root.description === undefined ? {} : { description: root.description }),
    ...(root.priority === undefined ? {} : { priority: root.priority }),
    ...(root.status_id === undefined ? {} : { stateId: root.status_id }),
  };
}

function commentCreateInput(value) {
  const comment = record(value, "external_linear_human_comment_input_invalid");
  assertKeys(comment, ["issue_id", "body"], [], "external_linear_human_comment_input_invalid");
  if (!identifier(comment.issue_id) || !ordinaryMarkdown(comment.body)) {
    throw stableError("external_linear_human_comment_input_invalid");
  }
  return comment;
}

function commentEditInput(value) {
  const comment = record(value, "external_linear_human_comment_input_invalid");
  assertKeys(comment, ["comment_id", "body"], [], "external_linear_human_comment_input_invalid");
  if (!identifier(comment.comment_id) || !ordinaryMarkdown(comment.body)) {
    throw stableError("external_linear_human_comment_input_invalid");
  }
  return comment;
}

function humanActionInput(value) {
  const action = record(value, "external_linear_human_action_input_invalid");
  assertKeys(action, ["human_action_issue_id", "terminal_status"], ["reason_or_answer"], "external_linear_human_action_input_invalid");
  if (!identifier(action.human_action_issue_id) || !Object.hasOwn(TERMINAL_ACTION_STATUSES, action.terminal_status) ||
      action.reason_or_answer !== undefined && !ordinaryMarkdown(action.reason_or_answer)) {
    throw stableError("external_linear_human_action_input_invalid");
  }
  return action;
}

function threadInput(value) {
  const comment = record(value, "external_linear_human_thread_input_invalid");
  assertKeys(comment, ["thread_root_comment_id"], [], "external_linear_human_thread_input_invalid");
  if (!identifier(comment.thread_root_comment_id)) throw stableError("external_linear_human_thread_input_invalid");
  return comment;
}

async function assertHumanEditableComment(comment, humanAuthorId) {
  if (!comment || typeof comment !== "object" || typeof comment.body !== "string" || MANAGED_CODE_BLOCK.test(comment.body)) {
    throw stableError("external_linear_human_comment_target_invalid");
  }
  let author;
  try {
    author = await comment.user;
  } catch {
    throw stableError("external_linear_human_comment_target_invalid");
  }
  if (!author || typeof author !== "object" || author.id !== humanAuthorId) {
    throw stableError("external_linear_human_comment_target_invalid");
  }
}

async function actionTerminalStateId(issue, status) {
  if (!issue || typeof issue !== "object" || !issue.labels || !issue.state || !issue.team) {
    throw stableError("external_linear_human_action_target_invalid");
  }
  let labels;
  let currentState;
  let team;
  try {
    [labels, currentState, team] = await Promise.all([
      readAllNodes(() => issue.labels({ first: 250 })),
      issue.state,
      issue.team,
    ]);
  } catch {
    throw stableError("external_linear_human_action_target_invalid");
  }
  if (!Array.isArray(labels) || labels.filter((label) => label?.name === "Human Action").length !== 1 ||
      !currentState || typeof currentState !== "object" || !["Todo", "In Progress"].includes(currentState.name) ||
      !team || typeof team.states !== "function") {
    throw stableError("external_linear_human_action_target_invalid");
  }
  let states;
  try {
    states = await readAllNodes(() => team.states({ first: 250 }));
  } catch {
    throw stableError("external_linear_human_action_target_invalid");
  }
  const matches = states.filter((state) => state?.name === status.name && state?.type === status.category && identifier(state?.id));
  if (matches.length !== 1) throw stableError("external_linear_human_action_target_invalid");
  return matches[0].id;
}

async function readAllNodes(readPage) {
  const connection = await readPage();
  if (!connection || typeof connection !== "object" || !Array.isArray(connection.nodes) || !connection.pageInfo ||
      typeof connection.pageInfo.hasNextPage !== "boolean") {
    throw stableError("external_linear_human_collection_invalid");
  }
  while (connection.pageInfo.hasNextPage) {
    if (connection.nodes.length >= MAX_CONNECTION_NODES || typeof connection.fetchNext !== "function") {
      throw stableError("external_linear_human_collection_invalid");
    }
    await connection.fetchNext();
  }
  if (connection.nodes.length > MAX_CONNECTION_NODES) throw stableError("external_linear_human_collection_invalid");
  return connection.nodes;
}

function assertWriteSuccess(payload, code) {
  if (!payload || payload.success !== true) throw stableError(code);
}

function sdkCall(code, operation) {
  return Promise.resolve()
    .then(operation)
    .catch(() => { throw stableError(code); });
}

function ordinaryMarkdown(value) {
  return unmanagedMarkdown(value, MAX_COMMENT_LENGTH, { nonempty: true });
}

function unmanagedMarkdown(value, maximum, { nonempty = false } = {}) {
  if (!boundedText(value, maximum, { nonempty })) return false;
  if (MANAGED_CODE_BLOCK.test(value)) throw stableError("external_linear_human_markdown_managed_forbidden");
  return true;
}

function boundedText(value, maximum, { nonempty = false } = {}) {
  return typeof value === "string" && value.length <= maximum && !value.includes("\u0000") && (!nonempty || value.trim().length > 0);
}

function priority(value) {
  return value === undefined || Number.isInteger(value) && value >= 0 && value <= 4;
}

function uniqueIdentifiers(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(identifier) && new Set(value).size === value.length;
}

function assertKeys(value, required, optional, code) {
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw stableError(code);
  }
}

function record(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw stableError(code);
  return value;
}

function createLinearClient(options) {
  return new LinearClient(options);
}

function token(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
