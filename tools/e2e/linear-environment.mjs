import { LinearClient } from "@linear/sdk";

const CONDUCTOR_LABEL_NAME = /^symphony:conductor\/[a-f0-9]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const PAGE_SIZE = 250;
const PROJECT_ROUTING_LABELS_QUERY = `
  query SymphonyE2EProjectRoutingLabels($projectId: String!, $after: String) {
    project(id: $projectId) {
      id
      labels(first: 250, after: $after, includeArchived: false, filter: { name: { startsWith: "symphony:conductor/" } }) {
        nodes { id name isGroup archivedAt retiredBy { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const PROJECT_TEAMS_QUERY = `
  query SymphonyE2EProjectTeams($projectId: String!, $after: String) {
    project(id: $projectId) {
      id
      teams(first: 2, after: $after) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const PROJECT_LABEL_PROJECTS_QUERY = `
  query SymphonyE2EProjectLabelProjects($labelId: String!) {
    projectLabel(id: $labelId) {
      id
      projects(first: 2) {
        nodes { id }
        pageInfo { hasNextPage }
      }
    }
  }
`;
const ISSUE_LABELS_QUERY = `
  query SymphonyE2EIssueLabels($name: String!) {
    issueLabels(first: 2, includeArchived: false, filter: { name: { eq: $name }, isGroup: { eq: false } }) {
      nodes { id name isGroup archivedAt retiredBy { id } team { id } }
      pageInfo { hasNextPage }
    }
  }
`;
const ISSUE_LABEL_ACTIVE_ISSUES_QUERY = `
  query SymphonyE2EIssueLabelActiveIssues($labelId: String!) {
    issueLabel(id: $labelId) {
      id
      issues(first: 1, includeArchived: false) {
        nodes { id }
        pageInfo { hasNextPage }
      }
    }
  }
`;

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
  await resetConductorRoutingLabels({ client, projectId: baselineProject.id });
  const finalProject = await readProject(client, projectId);
  const remainingLabels = await activeRoutingLabels(client, finalProject.id);
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
  if (!project || project.id !== projectId || typeof project.issues !== "function") {
    throw stableError("foreground_e2e_project_invalid");
  }
  return project;
}

async function resetConductorRoutingLabels({ client, projectId }) {
  const labels = await activeRoutingLabels(client, projectId);
  if (labels.length === 0) return;
  if (new Set(labels.map(({ name }) => name)).size !== labels.length) {
    throw stableError("foreground_e2e_project_label_ownership_invalid");
  }
  const teamId = await soleProjectTeamId(client, projectId);
  const members = [];
  for (const projectLabel of labels) {
    await assertExclusiveProjectLabel(client, projectLabel, projectId);
    const issueLabel = await matchingIssueLabel(client, teamId, projectLabel.name);
    if (issueLabel) await assertNoActiveIssueUsesLabel(client, issueLabel);
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
      () => client.projectRemoveLabel(projectId, projectLabel.id),
      "foreground_e2e_project_label_mutation_failed",
    );
    if (result?.success !== true) throw stableError("foreground_e2e_project_label_mutation_failed");
  }
}

async function activeRoutingLabels(client, projectId) {
  const labels = await readCompactProjectConnection({
    client,
    query: PROJECT_ROUTING_LABELS_QUERY,
    projectId,
    connection: "labels",
    code: "foreground_e2e_project_label_read_failed",
  });
  return labels.filter((label) => activeLabel(label) && CONDUCTOR_LABEL_NAME.test(label.name));
}

async function soleProjectTeamId(client, projectId) {
  const teams = await readCompactProjectConnection({
    client,
    query: PROJECT_TEAMS_QUERY,
    projectId,
    connection: "teams",
    code: "foreground_e2e_project_label_read_failed",
  });
  if (teams.length !== 1 || !identifier(teams[0]?.id)) {
    throw stableError("foreground_e2e_project_label_ownership_invalid");
  }
  return teams[0].id;
}

async function assertExclusiveProjectLabel(client, label, projectId) {
  if (!identifier(label?.id)) throw stableError("foreground_e2e_project_label_ownership_invalid");
  const data = await compactRawRequest(client, PROJECT_LABEL_PROJECTS_QUERY, { labelId: label.id }, "foreground_e2e_project_label_read_failed");
  const projects = data.projectLabel?.id === label.id ? data.projectLabel.projects : undefined;
  if (!completeConnection(projects) || projects.nodes.length !== 1 || projects.nodes[0]?.id !== projectId) {
    throw stableError("foreground_e2e_project_label_ownership_invalid");
  }
}

async function matchingIssueLabel(client, teamId, name) {
  const data = await compactRawRequest(client, ISSUE_LABELS_QUERY, { name }, "foreground_e2e_project_label_read_failed");
  const labels = data.issueLabels;
  if (!completeConnection(labels)) throw stableError("foreground_e2e_project_label_read_failed");
  const matches = labels.nodes.filter((label) => activeLabel(label) && label.name === name &&
    (label.team?.id === undefined || label.team.id === teamId));
  if (matches.length > 1) throw stableError("foreground_e2e_project_label_ownership_invalid");
  return matches[0];
}

async function assertNoActiveIssueUsesLabel(client, label) {
  if (!identifier(label?.id)) throw stableError("foreground_e2e_project_label_ownership_invalid");
  const data = await compactRawRequest(client, ISSUE_LABEL_ACTIVE_ISSUES_QUERY, { labelId: label.id }, "foreground_e2e_project_label_read_failed");
  const issues = data.issueLabel?.id === label.id ? data.issueLabel.issues : undefined;
  if (!completeConnection(issues) || issues.nodes.length !== 0) {
    throw stableError("foreground_e2e_project_label_ownership_invalid");
  }
}

async function readCompactProjectConnection({ client, query, projectId, connection, code }) {
  const nodes = [];
  const cursors = new Set();
  let after;
  do {
    const data = await compactRawRequest(client, query, { projectId, after }, code);
    const page = data.project?.id === projectId ? data.project[connection] : undefined;
    if (!pageConnection(page)) throw stableError(code);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    after = page.pageInfo.endCursor;
    if (typeof after !== "string" || after.length === 0 || cursors.has(after)) throw stableError(code);
    cursors.add(after);
  } while (after);
  throw stableError(code);
}

async function compactRawRequest(client, query, variables, code) {
  const request = client?.client?.rawRequest?.bind(client.client);
  if (typeof request !== "function") throw stableError(code);
  let response;
  try {
    response = await request(query, variables);
  } catch {
    throw stableError(code);
  }
  if (!response?.data || typeof response.data !== "object") throw stableError(code);
  return response.data;
}

function completeConnection(connection) {
  return pageConnection(connection) && connection.pageInfo.hasNextPage === false;
}

function pageConnection(connection) {
  return connection && Array.isArray(connection.nodes) && typeof connection.pageInfo?.hasNextPage === "boolean";
}

export async function readAllLinearNodes(readPage, code, classifyFailure = (_error, fallbackCode) => fallbackCode) {
  if (typeof classifyFailure !== "function") throw stableError(code);
  const nodes = [];
  const cursors = new Set();
  let cursor;
  do {
    let page;
    try {
      page = await readPage(cursor);
    } catch (error) {
      throw stableError(classifyFailure(error, code));
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
    (label.retiredById === null || label.retiredById === undefined) &&
    (label.retiredBy === null || label.retiredBy === undefined);
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
