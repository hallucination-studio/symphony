const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const MAX_TEXT_LENGTH = 16_384;

const PROJECT_CONTEXT_QUERY = `
  query e2eProjectContext {
    projects(first: 250) {
      nodes {
        id
        name
        slugId
        teams(first: 50) {
          nodes {
            id
            states(first: 100) {
              nodes { id name }
            }
          }
        }
      }
    }
  }
`;

const VIEWER_QUERY = `
  query e2eViewer { viewer { id } }
`;

const CREATE_ROOT_MUTATION = `
  mutation e2eIssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id }
    }
  }
`;

const DELEGATE_ROOT_MUTATION = `
  mutation e2eIssueUpdate($issueId: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $issueId, input: $input) {
      success
      issue { id }
    }
  }
`;

const ROOT_QUERY = `
  query e2eIssue($issueId: String!) {
    issue(id: $issueId) {
      id
      identifier
      project { id }
      parent { id }
      state { name }
      delegate { id }
    }
  }
`;

export function createLinearOperator({
  userApiKey,
  clientId,
  clientSecret,
  fetch = globalThis.fetch,
} = {}) {
  const operatorApiKey = required(userApiKey, "linear_operator_user_api_key_invalid");
  const appClientId = required(clientId, "linear_operator_client_id_invalid");
  const appClientSecret = required(clientSecret, "linear_operator_client_secret_invalid");
  if (typeof fetch !== "function") throw new Error("linear_operator_fetch_invalid");

  return Object.freeze({
    async preflight(input) {
      const { project } = await readOperatorContext(input?.projectSlugId);
      return {
        projectId: project.projectId,
        projectName: project.projectName,
        appActorReady: true,
      };
    },

    async createAndDelegateRoot(input) {
      const rootInput = input ?? {};
      const title = required(rootInput.title, "linear_operator_root_title_invalid");
      const description = required(rootInput.description, "linear_operator_root_description_invalid");
      const { project, appActorId } = await readOperatorContext(rootInput.projectSlugId);
      const rootId = await createRoot(project, { title, description });
      const createdRoot = await readRoot(rootId);
      assertRoot(createdRoot, project, "linear_operator_root_create_readback_failed");

      await delegateRoot(rootId, appActorId);
      const delegatedRoot = await readRoot(rootId);
      assertRoot(delegatedRoot, project, "linear_operator_root_delegate_readback_failed");
      if (delegatedRoot.delegateId !== appActorId) {
        throw new Error("linear_operator_root_delegate_readback_failed");
      }

      return {
        rootId: delegatedRoot.id,
        identifier: delegatedRoot.identifier,
        projectId: project.projectId,
        projectName: project.projectName,
        state: delegatedRoot.stateName,
        delegated: true,
        readBack: true,
      };
    },
  });

  async function readOperatorContext(projectSlugId) {
    return {
      project: await readProjectContext(projectSlugId),
      appActorId: await readAppActorId(),
    };
  }

  async function readProjectContext(projectSlugId) {
    const slugId = required(projectSlugId, "linear_operator_project_slug_id_invalid");
    const data = await graphql(operatorApiKey, PROJECT_CONTEXT_QUERY);
    const projects = data.projects?.nodes;
    if (!Array.isArray(projects)) throw new Error("linear_operator_project_response_invalid");
    const matches = projects.filter((project) => project?.slugId === slugId);
    if (matches.length === 0) throw new Error("linear_operator_project_not_found");
    if (matches.length !== 1) throw new Error("linear_operator_project_ambiguous");

    const project = matches[0];
    const todoStates = (project.teams?.nodes ?? []).flatMap((team) =>
      (team?.states?.nodes ?? [])
        .filter((state) => state?.name === "Todo")
        .map((state) => ({ teamId: team.id, stateId: state.id })),
    );
    if (todoStates.length === 0) throw new Error("linear_operator_todo_state_missing");
    if (todoStates.length !== 1) throw new Error("linear_operator_todo_state_ambiguous");
    if (!project.id || typeof project.name !== "string") {
      throw new Error("linear_operator_project_response_invalid");
    }
    return {
      projectId: project.id,
      projectName: project.name,
      teamId: todoStates[0].teamId,
      stateId: todoStates[0].stateId,
    };
  }

  async function readAppActorId() {
    const accessToken = await requestAppToken();
    const data = await graphql(`Bearer ${accessToken}`, VIEWER_QUERY);
    const id = data.viewer?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("linear_operator_app_actor_missing");
    }
    return id;
  }

  async function requestAppToken() {
    let response;
    try {
      response = await fetch(LINEAR_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: appClientId,
          client_secret: appClientSecret,
          grant_type: "client_credentials",
        }),
      });
    } catch {
      throw new Error("linear_operator_app_token_request_failed");
    }
    if (!response.ok) throw new Error(`linear_operator_app_token_http_${response.status}`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("linear_operator_app_token_response_invalid");
    }
    if (
      typeof body?.access_token !== "string" ||
      !body.access_token ||
      body.access_token.length > MAX_TEXT_LENGTH
    ) {
      throw new Error("linear_operator_app_token_response_invalid");
    }
    return body.access_token;
  }

  async function createRoot(project, { title, description }) {
    const data = await graphql(operatorApiKey, CREATE_ROOT_MUTATION, {
      input: {
        teamId: project.teamId,
        projectId: project.projectId,
        stateId: project.stateId,
        title,
        description,
      },
    });
    const payload = data.issueCreate;
    if (payload?.success !== true || typeof payload.issue?.id !== "string") {
      throw new Error("linear_operator_root_create_failed");
    }
    return payload.issue.id;
  }

  async function delegateRoot(issueId, appActorId) {
    const data = await graphql(operatorApiKey, DELEGATE_ROOT_MUTATION, {
      issueId,
      input: { delegateId: appActorId },
    });
    if (data.issueUpdate?.success !== true) {
      throw new Error("linear_operator_root_delegate_failed");
    }
  }

  async function readRoot(issueId) {
    const data = await graphql(operatorApiKey, ROOT_QUERY, { issueId });
    const issue = data.issue;
    if (!issue || typeof issue.id !== "string" || typeof issue.identifier !== "string") {
      throw new Error("linear_operator_root_response_invalid");
    }
    return {
      id: issue.id,
      identifier: issue.identifier,
      projectId: issue.project?.id,
      hasParent: Boolean(issue.parent?.id),
      stateName: issue.state?.name,
      delegateId: issue.delegate?.id,
    };
  }

  async function graphql(authorization, query, variables = {}) {
    let response;
    try {
      response = await fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw new Error("linear_operator_request_failed");
    }
    if (!response.ok) throw new Error(`linear_operator_http_${response.status}`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("linear_operator_response_invalid");
    }
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      throw new Error("linear_operator_graphql_failed");
    }
    if (!body?.data || typeof body.data !== "object") {
      throw new Error("linear_operator_response_invalid");
    }
    return body.data;
  }
}

function assertRoot(root, project, errorCode) {
  if (
    root.projectId !== project.projectId ||
    root.hasParent ||
    root.stateName !== "Todo"
  ) {
    throw new Error(errorCode);
  }
}

function required(value, code) {
  if (typeof value !== "string" || !value || value.length > MAX_TEXT_LENGTH || /[\r\n\0]/u.test(value)) {
    throw new Error(code);
  }
  return value;
}
