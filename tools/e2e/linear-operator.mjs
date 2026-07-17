const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const MAX_TEXT_LENGTH = 16_384;
const ROOT_PHASES = new Set([
  "planning",
  "awaiting-human",
  "working",
  "gating",
  "delivering",
  "in-review",
  "blocked",
  "failed",
]);
const ROOT_STATES = new Set(["Todo", "In Progress", "In Review", "Done", "Canceled"]);
const ROOT_MANAGED_FIELDS = new Set([
  "conductor_id",
  "performer_profile_id",
  "performer_id",
  "planned_root_input_hash",
  "usage_input_tokens",
  "usage_cached_input_tokens",
  "usage_output_tokens",
  "usage_reasoning_output_tokens",
  "usage_total_tokens",
  "last_usage_turn_id",
  "delivery_branch",
  "pull_request",
  "last_error",
]);
const REQUIRED_ROOT_MANAGED_FIELDS = [
  "conductor_id",
  "performer_profile_id",
  "usage_input_tokens",
  "usage_cached_input_tokens",
  "usage_output_tokens",
  "usage_reasoning_output_tokens",
  "usage_total_tokens",
  "delivery_branch",
];

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

const ROOT_CLAIM_FACTS_QUERY = `
  query e2eRootClaimFacts($rootId: String!, $projectId: String!) {
    issue(id: $rootId) {
      id
      identifier
      project { id }
      parent { id }
      state { name }
      labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
      comments(first: 64) { nodes { body } pageInfo { hasNextPage } }
    }
    project(id: $projectId) {
      issues(first: 250) {
        nodes {
          id
          parent { id }
          state { name }
          delegate { id }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

const ROOT_PLAN_FACTS_QUERY = `
  query e2eRootPlanFacts($rootId: String!, $projectId: String!) {
    issue(id: $rootId) {
      id
      project { id }
      parent { id }
      state { name }
      labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
      comments(first: 64) { nodes { body } pageInfo { hasNextPage } }
    }
    project(id: $projectId) {
      issues(first: 250) {
        nodes {
          id
          identifier
          title
          description
          parent { id }
          state { name }
          sortOrder
          subIssueSortOrder
        }
        pageInfo { hasNextPage }
      }
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

    async readRootClaimFacts(input) {
      const rootId = required(input?.rootId, "linear_operator_root_id_invalid");
      const project = await readProjectContext(input?.projectSlugId);
      const appActorId = await readAppActorId();
      const data = await graphql(operatorApiKey, ROOT_CLAIM_FACTS_QUERY, {
        rootId,
        projectId: project.projectId,
      });
      const issue = data.issue;
      const projectIssues = connectionNodes(data.project?.issues);
      const labels = connectionNodes(issue?.labels);
      const comments = connectionNodes(issue?.comments);
      if (!isRootIssueShape(issue, rootId, project.projectId)) {
        throw new Error("linear_operator_root_response_invalid");
      }
      if (!labels.every((label) => isNamedObject(label)) ||
        !comments.every((comment) => isBodyObject(comment)) ||
        !projectIssues.every(isProjectIssueShape)) {
        throw new Error("linear_operator_root_response_invalid");
      }

      const phaseLabels = labels
        .map((label) => label.name)
        .filter((name) => name.startsWith("symphony:run/"));
      const phase = phaseLabels.length === 1
        ? phaseLabels[0].slice("symphony:run/".length)
        : undefined;
      if (phase !== undefined && !ROOT_PHASES.has(phase)) {
        throw new Error("linear_operator_root_response_invalid");
      }
      const managedComments = comments
        .map((comment) => comment.body)
        .filter(isRootManagedComment);
      const activeDelegatedRoots = projectIssues.filter((candidate) =>
        !candidate?.parent?.id &&
        candidate?.state?.name === "In Progress" &&
        candidate?.delegate?.id === appActorId,
      );
      const managedComment = managedComments[0];
      const managedCommentReady = managedComments.length === 1 && managedCommentFields(managedComment);

      return {
        rootId,
        state: issue.state?.name,
        phase,
        singletonCount: activeDelegatedRoots.length,
        managedCommentCount: managedComments.length,
        managedCommentReady,
        ...(managedCommentReady ? { deliveryBranch: deliveryBranch(managedComment) } : {}),
      };
    },

    async readRootPlanFacts(input) {
      const rootId = required(input?.rootId, "linear_operator_root_id_invalid");
      const project = await readProjectContext(input?.projectSlugId);
      const data = await graphql(operatorApiKey, ROOT_PLAN_FACTS_QUERY, {
        rootId,
        projectId: project.projectId,
      });
      const issue = data.issue;
      const projectIssues = connectionNodes(
        data.project?.issues,
        "linear_operator_plan_response_invalid",
      );
      const labels = connectionNodes(
        issue?.labels,
        "linear_operator_plan_response_invalid",
      );
      const comments = connectionNodes(
        issue?.comments,
        "linear_operator_plan_response_invalid",
      );
      if (!isRootPlanIssueShape(issue, rootId, project.projectId)) {
        throw new Error("linear_operator_plan_response_invalid");
      }
      if (
        !labels.every(isNamedObject) ||
        !comments.every(isBodyObject) ||
        !projectIssues.every(isPlanIssueShape)
      ) {
        throw new Error("linear_operator_plan_response_invalid");
      }

      const phaseLabels = labels
        .map((label) => label.name)
        .filter((name) => name.startsWith("symphony:run/"));
      const phase = phaseLabels.length === 1
        ? phaseLabels[0].slice("symphony:run/".length)
        : undefined;
      if (phase !== undefined && !ROOT_PHASES.has(phase)) {
        throw new Error("linear_operator_plan_response_invalid");
      }

      const tree = rootPlanTree(projectIssues, rootId);
      const planNodes = tree.map(planNode);
      const approvalNodes = planNodes.filter(
        (node) => node.humanKind === "plan_approval",
      );
      const approval = approvalNodes[0];
      const managedComments = comments
        .map((comment) => comment.body)
        .filter(isRootManagedComment);
      const planApprovalReady = approvalNodes.length === 1 &&
        approval.parentId === rootId &&
        !planNodes.some((node) => node.parentId === approval.id) &&
        approval.title === "[Human Action] Approve Plan" &&
        approval.state === "In Progress" &&
        approval.managedMarker === `${rootId}:plan-approval`;

      return {
        rootId,
        state: issue.state.name,
        phase,
        treeMatches: treeMatches(planNodes, rootId),
        planApprovalCount: approvalNodes.length,
        ...(approval ? { planApprovalState: approval.state } : {}),
        planApprovalReady,
        plannedRootInputReady: managedComments.length === 1 &&
          managedCommentFields(managedComments[0]) &&
          plannedRootInputHash(managedComments[0]),
        workStarted: planNodes.some((node) =>
          node.id !== rootId &&
          node.humanKind !== "plan_approval" &&
          !["Todo", "Canceled"].includes(node.state),
        ),
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

function isRootManagedComment(body) {
  return typeof body === "string" &&
    body.startsWith("Symphony Root Run\n") &&
    body.endsWith("<!-- symphony root marker -->");
}

function connectionNodes(connection, errorCode = "linear_operator_root_response_invalid") {
  if (!connection || !Array.isArray(connection.nodes) || connection.pageInfo?.hasNextPage !== false) {
    throw new Error(errorCode);
  }
  return connection.nodes;
}

function isRootIssueShape(issue, rootId, projectId) {
  return isObject(issue) &&
    issue.id === rootId &&
    issue.project?.id === projectId &&
    issue.parent === null &&
    typeof issue.state?.name === "string";
}

function isProjectIssueShape(issue) {
  return isObject(issue) &&
    typeof issue.id === "string" &&
    isNullableRelation(issue.parent) &&
    isNullableRelation(issue.delegate) &&
    typeof issue.state?.name === "string";
}

function isRootPlanIssueShape(issue, rootId, projectId) {
  return isObject(issue) &&
    issue.id === rootId &&
    issue.project?.id === projectId &&
    issue.parent === null &&
    ROOT_STATES.has(issue.state?.name);
}

function isPlanIssueShape(issue) {
  return isObject(issue) &&
    typeof issue.id === "string" &&
    typeof issue.identifier === "string" &&
    typeof issue.title === "string" &&
    (typeof issue.description === "string" || issue.description === null) &&
    isNullableRelation(issue.parent) &&
    ROOT_STATES.has(issue.state?.name) &&
    Number.isFinite(issue.sortOrder) &&
    (issue.subIssueSortOrder === null || Number.isFinite(issue.subIssueSortOrder));
}

function isNamedObject(value) {
  return isObject(value) && typeof value.name === "string";
}

function isBodyObject(value) {
  return isObject(value) && typeof value.body === "string";
}

function isNullableRelation(value) {
  return value === null || (isObject(value) && typeof value.id === "string");
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function rootPlanTree(issues, rootId) {
  const byId = new Map();
  for (const issue of issues) {
    if (byId.has(issue.id)) throw new Error("linear_operator_plan_tree_invalid");
    byId.set(issue.id, issue);
  }
  if (!byId.has(rootId)) throw new Error("linear_operator_plan_tree_root_missing");

  const childrenByParent = new Map();
  for (const issue of issues) {
    if (!issue.parent?.id) continue;
    const children = childrenByParent.get(issue.parent.id) ?? [];
    children.push(issue);
    childrenByParent.set(issue.parent.id, children);
  }
  const result = [];
  const visiting = new Set();
  function visit(issueId) {
    if (visiting.has(issueId)) throw new Error("linear_operator_plan_tree_cycle");
    const issue = byId.get(issueId);
    if (!issue) throw new Error("linear_operator_plan_parent_missing");
    visiting.add(issueId);
    result.push(issue);
    const children = [...(childrenByParent.get(issueId) ?? [])].sort(comparePlanIssue);
    for (const child of children) visit(child.id);
    visiting.delete(issueId);
  }
  visit(rootId);
  return result;
}

function comparePlanIssue(left, right) {
  return (left.subIssueSortOrder ?? left.sortOrder) -
    (right.subIssueSortOrder ?? right.sortOrder) ||
    left.identifier.localeCompare(right.identifier);
}

function planNode(issue) {
  const metadata = parsePlanNodeMetadata(issue.description ?? "");
  if (metadata.invalid) throw new Error("linear_operator_plan_metadata_invalid");
  return {
    id: issue.id,
    parentId: issue.parent?.id,
    title: issue.title,
    state: issue.state.name,
    order: issue.subIssueSortOrder ?? issue.sortOrder,
    ...(metadata.humanKind ? { humanKind: metadata.humanKind } : {}),
    ...(metadata.managedMarker ? { managedMarker: metadata.managedMarker } : {}),
  };
}

function treeMatches(nodes, rootId) {
  const byId = new Set(nodes.map((node) => node.id));
  const root = nodes.find((node) => node.id === rootId);
  return root?.parentId === undefined && nodes.every((node) =>
    node.id === rootId ||
    (typeof node.parentId === "string" && byId.has(node.parentId) && Number.isFinite(node.order)),
  );
}

function parsePlanNodeMetadata(description) {
  const human = description.match(/\n*<!-- symphony managed marker\nmanaged_marker: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\nkind: human\nhuman_kind: (plan_approval|planned_input|runtime_input)\ntarget_issue_id: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}|none)\n-->\s*$/u);
  if (human) {
    if ((human[2] === "plan_approval") !== (human[3] === "none")) return { invalid: true };
    return { managedMarker: human[1], humanKind: human[2] };
  }
  const work = description.match(/\n*<!-- symphony managed marker\nmanaged_marker: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\n-->\s*\n*<!-- symphony work metadata\nkind: work\norigin: (?:user|symphony)\ncompleted_input_hash: (?:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}|none)\n-->\s*$/u);
  if (work) return { managedMarker: work[1] };
  if (description.includes("symphony managed marker") || description.includes("symphony work metadata")) {
    return { invalid: true };
  }
  return {};
}

function plannedRootInputHash(body) {
  return /^planned_root_input_hash: [A-Za-z0-9._:/-]{1,128}$/mu.test(body);
}

function managedCommentFields(body) {
  const values = new Map();
  for (const line of body.split("\n").slice(1, -1)) {
    const separator = line.indexOf(":");
    if (separator < 1) return false;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (
      !ROOT_MANAGED_FIELDS.has(key) ||
      values.has(key) ||
      !value ||
      value.length > MAX_TEXT_LENGTH ||
      /[\r\0]/u.test(value)
    ) {
      return false;
    }
    values.set(key, value);
  }

  if (!REQUIRED_ROOT_MANAGED_FIELDS.every((key) => {
    const value = values.get(key);
    return value && value !== "none";
  })) {
    return false;
  }
  if (!/^delivery_branch: [A-Za-z0-9._/-]{1,128}$/mu.test(body)) return false;
  return [
    "usage_input_tokens",
    "usage_cached_input_tokens",
    "usage_output_tokens",
    "usage_reasoning_output_tokens",
    "usage_total_tokens",
  ].every((key) => {
    const value = values.get(key);
    return /^\d+$/u.test(value) && Number.isSafeInteger(Number(value));
  });
}

function deliveryBranch(body) {
  const match = body.match(/^delivery_branch: ([A-Za-z0-9._/-]{1,128})$/mu);
  return match?.[1];
}

function required(value, code) {
  if (typeof value !== "string" || !value || value.length > MAX_TEXT_LENGTH || /[\r\n\0]/u.test(value)) {
    throw new Error(code);
  }
  return value;
}
