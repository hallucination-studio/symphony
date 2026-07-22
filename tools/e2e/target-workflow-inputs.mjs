const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 16_384;
const MAX_HUMAN_BODY_LENGTH = 8_192;
const MANAGED_RECORD_PREFIX = "<!-- symphony managed-record";
const ROOT_INPUT_FIELDS = new Set(["teamId", "projectId", "stateId", "delegateId", "title", "description"]);
const HUMAN_INPUT_FIELDS = new Set(["projectId", "issueId", "body"]);

const CREATE_ROOT_MUTATION = `
  mutation TargetWorkflowCreateRoot($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier project { id } parent { id } state { name } }
    }
  }
`;

const APPEND_HUMAN_RESPONSE_MUTATION = `
  mutation TargetWorkflowAppendHumanResponse($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id issue { id project { id } } }
    }
  }
`;

export function createTargetWorkflowExternalInputs({
  developmentToken,
  budget,
  fetch = globalThis.fetch,
  log = () => {},
} = {}) {
  if (typeof developmentToken !== "string" || developmentToken.length === 0) {
    throw new Error("target_inputs_token_missing");
  }
  if (typeof fetch !== "function") throw new Error("target_inputs_fetch_invalid");
  if (typeof log !== "function") throw new Error("target_inputs_log_invalid");

  return Object.freeze({
    createRoot,
    appendHumanResponse,
  });

  async function createRoot(input) {
    const root = validateRootInput(input);
    budget?.recordLogicalOperation();
    const data = await graphql(CREATE_ROOT_MUTATION, {
      input: {
        teamId: root.teamId,
        projectId: root.projectId,
        stateId: root.stateId,
        ...(root.delegateId === undefined ? {} : { delegateId: root.delegateId }),
        title: root.title,
        description: root.description,
      },
    });
    const issue = data.issueCreate;
    if (!issue || issue.success !== true || !issue.issue ||
        !isSafeId(issue.issue.id) || typeof issue.issue.identifier !== "string" ||
        !isSafeId(issue.issue.identifier) || issue.issue.project?.id !== root.projectId ||
        issue.issue.parent !== null || typeof issue.issue.state?.name !== "string") {
      throw new Error("target_inputs_root_scope_invalid");
    }
    return Object.freeze({
      rootIssueId: issue.issue.id,
      identifier: issue.issue.identifier,
      projectId: issue.issue.project.id,
      parentIssueId: undefined,
      stateName: issue.issue.state.name,
    });
  }

  async function appendHumanResponse(input) {
    const response = validateHumanInput(input);
    budget?.recordLogicalOperation();
    const data = await graphql(APPEND_HUMAN_RESPONSE_MUTATION, {
      input: { issueId: response.issueId, body: response.body },
    });
    const comment = data.commentCreate;
    if (!comment || comment.success !== true || !comment.comment ||
        !isSafeId(comment.comment.id) || comment.comment.issue?.id !== response.issueId ||
        comment.comment.issue?.project?.id !== response.projectId) {
      throw new Error("target_inputs_human_scope_invalid");
    }
    return Object.freeze({
      commentId: comment.comment.id,
      issueId: comment.comment.issue.id,
      projectId: comment.comment.issue.project.id,
    });
  }

  async function graphql(query, variables) {
    const operation = query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/u)?.[1] ?? "unknown";
    const reservation = budget?.reserve({ requests: 1, complexity: 0 });
    let observed = false;
    let response;
    try {
      response = await fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { authorization: developmentToken, "content-type": "application/json" },
        body: JSON.stringify({ query, variables, operationName: operation }),
      });
      budget?.observe({ status: response.status, ...readRateWindows(response.headers) });
      observed = true;
    } catch {
      if (!observed) budget?.observe({});
      log({ event: "target_inputs_request_failed", operation });
      throw new Error("target_inputs_request_failed");
    } finally {
      reservation?.release();
    }
    let body;
    try {
      body = await response.json();
    } catch {
      log({ event: "target_inputs_response_invalid", operation, status: response.status });
      throw new Error("target_inputs_response_invalid");
    }
    if (!response.ok || (Array.isArray(body?.errors) && body.errors.length > 0) ||
        !body?.data || typeof body.data !== "object") {
      log({
        event: "target_inputs_graphql_failed",
        operation,
        status: response.status,
        errorCount: Array.isArray(body?.errors) ? body.errors.length : 0,
      });
      throw new Error("target_inputs_graphql_failed");
    }
    return body.data;
  }

  function readRateWindows(headers) {
    return {
      ...(readRateWindow(headers, "x-ratelimit-requests") ? { requestWindow: readRateWindow(headers, "x-ratelimit-requests") } : {}),
      ...(readRateWindow(headers, "x-ratelimit-complexity") ? { complexityWindow: readRateWindow(headers, "x-ratelimit-complexity") } : {}),
    };
  }

  function readRateWindow(headers, prefix) {
    const read = (suffix) => {
      const value = headers?.get(`${prefix}-${suffix}`);
      return /^\d{1,16}$/u.test(value ?? "") ? Number(value) : undefined;
    };
    const limit = read("limit");
    const remaining = read("remaining");
    const reset = read("reset");
    return limit === undefined && remaining === undefined && reset === undefined
      ? undefined : { ...(limit === undefined ? {} : { limit }), ...(remaining === undefined ? {} : { remaining }), ...(reset === undefined ? {} : { reset }) };
  }
}

function validateRootInput(input) {
  assertClosedObject(input, ROOT_INPUT_FIELDS, "target_inputs_root_input_invalid");
  if (!isSafeId(input.teamId) || !isSafeId(input.projectId) || !isSafeId(input.stateId) ||
      (input.delegateId !== undefined && !isSafeId(input.delegateId)) ||
      !boundedText(input.title, MAX_TITLE_LENGTH) ||
      !boundedText(input.description, MAX_DESCRIPTION_LENGTH)) {
    throw new Error("target_inputs_root_input_invalid");
  }
  return input;
}

function validateHumanInput(input) {
  assertClosedObject(input, HUMAN_INPUT_FIELDS, "target_inputs_human_input_invalid");
  if (!isSafeId(input.projectId) || !isSafeId(input.issueId) ||
      !boundedText(input.body, MAX_HUMAN_BODY_LENGTH) ||
      input.body.includes(MANAGED_RECORD_PREFIX)) {
    throw new Error("target_inputs_human_body_invalid");
  }
  return input;
}

function assertClosedObject(value, fields, errorCode) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Object.keys(value).every((key) => fields.has(key))) {
    throw new Error(errorCode);
  }
}

function boundedText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}
