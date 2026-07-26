import { LinearClient } from "@linear/sdk";

const CONDUCTOR_LABEL_NAME = /^symphony:conductor\/[a-f0-9]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const PAGE_SIZE = 250;

export async function verifyDistinctLinearActors({
  symphonyAccessToken,
  humanApiKey,
  createClient = (options) => new LinearClient(options),
} = {}) {
  if (!token(symphonyAccessToken) || !token(humanApiKey) || typeof createClient !== "function") {
    throw stableError("foreground_e2e_actor_input_invalid");
  }
  if (symphonyAccessToken === humanApiKey) {
    throw stableError("foreground_e2e_actor_credentials_not_distinct");
  }
  let symphony;
  let human;
  try {
    symphony = createClient({ accessToken: symphonyAccessToken });
    human = createClient({ apiKey: humanApiKey });
  } catch {
    throw stableError("foreground_e2e_actor_client_invalid");
  }
  const [symphonyActorId, humanActorId] = await Promise.all([
    readActorId(symphony),
    readActorId(human),
  ]);
  if (symphonyActorId === humanActorId) {
    throw stableError("foreground_e2e_actor_identities_not_distinct");
  }
  return Object.freeze({ symphonyActorId, humanActorId, client: symphony });
}

export async function resetDedicatedE2EProject({ projectId, client } = {}) {
  if (!identifier(projectId) || !client || typeof client.project !== "function") {
    throw stableError("foreground_e2e_project_reset_input_invalid");
  }
  const project = await readProject(client, projectId);
  const activeIssues = await readAllLinearNodes(
    (after) => project.issues({ first: PAGE_SIZE, ...(after ? { after } : {}) }),
    "foreground_e2e_project_issue_read_failed",
  );
  for (const issue of activeIssues) {
    if (!issue || !identifier(issue.id) || typeof issue.archive !== "function") {
      throw stableError("foreground_e2e_project_issue_invalid");
    }
  }
  for (const issue of activeIssues) {
    const result = await write(() => issue.archive(), "foreground_e2e_project_issue_archive_failed");
    if (result?.success !== true) throw stableError("foreground_e2e_project_issue_archive_failed");
  }
  const baselineProject = await readProject(client, projectId);
  const remaining = await readAllLinearNodes(
    (after) => baselineProject.issues({ first: PAGE_SIZE, ...(after ? { after } : {}) }),
    "foreground_e2e_project_issue_read_back_failed",
  );
  if (remaining.length !== 0) throw stableError("foreground_e2e_project_issue_read_back_failed");
  await resetConductorRoutingLabels({ client, project: baselineProject });
  const finalProject = await readProject(client, projectId);
  const remainingLabels = await activeRoutingLabels(finalProject);
  if (remainingLabels.length !== 0) throw stableError("foreground_e2e_project_label_read_back_failed");
  return Object.freeze({ projectId });
}

async function readActorId(client) {
  if (!client || typeof client !== "object" || !("viewer" in client)) {
    throw stableError("foreground_e2e_actor_client_invalid");
  }
  let viewer;
  try {
    viewer = await client.viewer;
  } catch {
    throw stableError("foreground_e2e_actor_identity_read_failed");
  }
  if (!viewer || !identifier(viewer.id)) throw stableError("foreground_e2e_actor_identity_invalid");
  return viewer.id;
}

async function readProject(client, projectId) {
  let project;
  try {
    project = await client.project(projectId);
  } catch {
    throw stableError("foreground_e2e_project_read_failed");
  }
  if (!project || project.id !== projectId || typeof project.issues !== "function" ||
      typeof project.labels !== "function") {
    throw stableError("foreground_e2e_project_invalid");
  }
  return project;
}

async function resetConductorRoutingLabels({ client, project }) {
  const labels = await activeRoutingLabels(project);
  if (labels.length === 0) return;
  if (new Set(labels.map(({ name }) => name)).size !== labels.length) {
    throw stableError("foreground_e2e_project_label_ownership_invalid");
  }
  const teamId = await soleProjectTeamId(project);
  const members = [];
  for (const projectLabel of labels) {
    await assertExclusiveProjectLabel(projectLabel, project.id);
    const issueLabel = await matchingIssueLabel(client, teamId, projectLabel.name);
    if (issueLabel) await assertNoActiveIssueUsesLabel(issueLabel);
    members.push({ projectLabel, issueLabel });
  }
  for (const { projectLabel, issueLabel } of members) {
    if (issueLabel && activeLabel(issueLabel)) {
      const result = await write(() => client.issueLabelRetire(issueLabel.id), "foreground_e2e_project_label_mutation_failed");
      if (result?.success !== true) throw stableError("foreground_e2e_project_label_mutation_failed");
    }
    if (activeLabel(projectLabel)) {
      const result = await write(() => client.projectLabelRetire(projectLabel.id), "foreground_e2e_project_label_mutation_failed");
      if (result?.success !== true) throw stableError("foreground_e2e_project_label_mutation_failed");
    }
    const result = await write(
      () => client.projectRemoveLabel(project.id, projectLabel.id),
      "foreground_e2e_project_label_mutation_failed",
    );
    if (result?.success !== true) throw stableError("foreground_e2e_project_label_mutation_failed");
  }
}

async function activeRoutingLabels(project) {
  const labels = await readAllLinearNodes(
    (after) => project.labels({ first: PAGE_SIZE, ...(after ? { after } : {}) }),
    "foreground_e2e_project_label_read_failed",
  );
  return labels.filter((label) => activeLabel(label) && CONDUCTOR_LABEL_NAME.test(label.name));
}

async function soleProjectTeamId(project) {
  if (typeof project.teams !== "function") throw stableError("foreground_e2e_project_invalid");
  const teams = await readAllLinearNodes(
    (after) => project.teams({ first: 32, ...(after ? { after } : {}) }),
    "foreground_e2e_project_label_read_failed",
  );
  if (teams.length !== 1 || !identifier(teams[0]?.id)) {
    throw stableError("foreground_e2e_project_label_ownership_invalid");
  }
  return teams[0].id;
}

async function assertExclusiveProjectLabel(label, projectId) {
  if (typeof label.projects !== "function") throw stableError("foreground_e2e_project_label_ownership_invalid");
  const projects = await readAllLinearNodes(
    (after) => label.projects({ first: 32, ...(after ? { after } : {}) }),
    "foreground_e2e_project_label_read_failed",
  );
  if (projects.length !== 1 || projects[0]?.id !== projectId) {
    throw stableError("foreground_e2e_project_label_ownership_invalid");
  }
}

async function matchingIssueLabel(client, teamId, name) {
  if (typeof client.issueLabels !== "function") throw stableError("foreground_e2e_project_label_read_failed");
  const labels = await readAllLinearNodes((after) => client.issueLabels({
    first: PAGE_SIZE,
    includeArchived: false,
    filter: { name: { eq: name }, isGroup: { eq: false } },
    ...(after ? { after } : {}),
  }), "foreground_e2e_project_label_read_failed");
  const matches = labels.filter((label) => activeLabel(label) && label.name === name &&
    (label.teamId === undefined || label.teamId === teamId));
  if (matches.length > 1) throw stableError("foreground_e2e_project_label_ownership_invalid");
  return matches[0];
}

async function assertNoActiveIssueUsesLabel(label) {
  if (typeof label.issues !== "function") throw stableError("foreground_e2e_project_label_ownership_invalid");
  const issues = await readAllLinearNodes(
    (after) => label.issues({ first: PAGE_SIZE, ...(after ? { after } : {}) }),
    "foreground_e2e_project_label_read_failed",
  );
  if (issues.some((issue) => issue?.archivedAt === null || issue?.archivedAt === undefined)) {
    throw stableError("foreground_e2e_project_label_ownership_invalid");
  }
}

export async function readAllLinearNodes(readPage, code) {
  const nodes = [];
  const cursors = new Set();
  let cursor;
  do {
    let page;
    try {
      page = await readPage(cursor);
    } catch {
      throw stableError(code);
    }
    if (!page || !Array.isArray(page.nodes) || !page.pageInfo || typeof page.pageInfo.hasNextPage !== "boolean") {
      throw stableError(code);
    }
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    cursor = page.pageInfo.endCursor;
    if (typeof cursor !== "string" || cursor.length === 0 || cursors.has(cursor)) {
      throw stableError(code);
    }
    cursors.add(cursor);
  } while (cursor);
  throw stableError(code);
}

function activeLabel(label) {
  return label && identifier(label.id) && typeof label.name === "string" && label.isGroup === false &&
    (label.archivedAt === null || label.archivedAt === undefined) &&
    (label.retiredById === null || label.retiredById === undefined);
}

async function write(operation, code) {
  try {
    return await operation();
  } catch {
    throw stableError(code);
  }
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
