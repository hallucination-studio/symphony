const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const PAGE_SIZE = 250;
const COMMENT_PAGE_SIZE = 64;
const RELATION_PAGE_SIZE = 250;
const MAX_ISSUES = 512;
const MAX_COMMENTS = 4_096;
const MAX_RELATIONS = 1_024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const IGNORED_RECORD_KINDS = new Set([
  "root_ownership",
]);

const PROJECT_ISSUES_QUERY = `
  query TargetWorkflowProjectIssues($projectId: String!, $after: String) {
    project(id: $projectId) {
      id
      issues(first: 250, after: $after) {
        nodes {
          id
          project { id }
          parent { id }
          state { name }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const ISSUE_DETAILS_QUERY = `
  query TargetWorkflowIssueDetails($issueId: String!, $commentsAfter: String, $relationsAfter: String) {
    issue(id: $issueId) {
      id
      project { id }
      parent { id }
      state { name }
      comments(first: 64, after: $commentsAfter) {
        nodes { id body issue { id } }
        pageInfo { hasNextPage endCursor }
      }
      inverseRelations(first: 250, after: $relationsAfter) {
        nodes {
          id
          type
          issue { id project { id } }
          relatedIssue { id project { id } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export function createTargetWorkflowSnapshotTransport({
  developmentToken,
  budget,
  fetch = globalThis.fetch,
  log = () => {},
} = {}) {
  if (typeof developmentToken !== "string" || developmentToken.length === 0) {
    throw new Error("target_transport_token_missing");
  }
  if (typeof fetch !== "function") throw new Error("target_transport_fetch_invalid");
  if (typeof log !== "function") throw new Error("target_transport_log_invalid");

  return Object.freeze({
    readSnapshot(input) {
      return readSnapshot(input);
    },
  });

  async function readSnapshot(input) {
    const request = validateInput(input);
    budget?.recordLogicalOperation();
    const projectIssues = await readProjectIssues(request.projectId);
    const issueById = new Map(projectIssues.map((issue) => [issue.id, issue]));
    const root = issueById.get(request.rootIssueId);
    if (!root || root.projectId !== request.projectId || root.parentIssueId !== undefined) {
      throw new Error("target_transport_root_scope_invalid");
    }
    const scopedIssues = scopeRootTree(projectIssues, request.rootIssueId);
    const details = new Map();
    for (const issue of scopedIssues) {
      details.set(issue.id, await readIssueDetails(issue, request.projectId));
    }
    return normalizeSnapshot(request, scopedIssues, details);
  }

  async function readProjectIssues(projectId) {
    const issues = [];
    const cursors = new Set();
    let after = null;
    while (true) {
      const data = await graphql(PROJECT_ISSUES_QUERY, { projectId, after });
      const project = object(data.project, "target_transport_response_invalid");
      if (project.id !== projectId) throw new Error("target_transport_project_scope_invalid");
      const connection = pageConnection(project.issues, "target_transport_response_invalid");
      for (const value of connection.nodes) {
        const issue = issueHeader(value, projectId);
        if (issues.some(({ id }) => id === issue.id)) throw new Error("target_transport_duplicate_issue");
        issues.push(issue);
        if (issues.length > MAX_ISSUES) throw new Error("target_transport_bound_exceeded");
      }
      if (!connection.hasNextPage) return issues;
      after = nextCursor(connection, cursors);
    }
  }

  async function readIssueDetails(expectedIssue, projectId) {
    const issueId = expectedIssue.id;
    const comments = [];
    const markers = [];
    const relations = [];
    const commentCursors = new Set();
    const relationCursors = new Set();
    let commentsAfter = null;
    let relationsAfter = null;
    let commentsDone = false;
    let relationsDone = false;
    while (true) {
      const data = await graphql(ISSUE_DETAILS_QUERY, { issueId, commentsAfter, relationsAfter });
      const issue = object(data.issue, "target_transport_response_invalid");
      if (issue.id !== issueId || issue.project?.id !== projectId ||
          (issue.parent?.id ?? undefined) !== (expectedIssue.parentIssueId ?? undefined) ||
          issue.state?.name !== expectedIssue.state) {
        throw new Error("target_transport_issue_scope_invalid");
      }
      const commentPage = pageConnection(issue.comments, "target_transport_response_invalid");
      const relationPage = pageConnection(issue.inverseRelations, "target_transport_response_invalid");
      if (!commentsDone) {
        for (const value of commentPage.nodes) {
          const normalized = normalizeComment(value, issueId);
          if (normalized?.comment) {
            const comment = normalized.comment;
            if (comments.some(({ id }) => id === comment.id)) throw new Error("target_transport_duplicate_comment");
            comments.push(comment);
          }
          if (normalized?.nodeMarker) {
            markers.push(normalized.nodeMarker);
          }
          if (comments.length + markers.length > MAX_COMMENTS) throw new Error("target_transport_bound_exceeded");
        }
      }
      if (!relationsDone) {
        for (const value of relationPage.nodes) {
          const relation = normalizeRelation(value, issueId, projectId);
          if (!relation) continue;
          if (relations.some(({ id }) => id === relation.id)) throw new Error("target_transport_duplicate_relation");
          relations.push(relation);
          if (relations.length > MAX_RELATIONS) throw new Error("target_transport_bound_exceeded");
        }
      }
      if (!commentsDone) commentsDone = !commentPage.hasNextPage;
      if (!relationsDone) relationsDone = !relationPage.hasNextPage;
      if (commentsDone && relationsDone) return { comments, markers, relations };
      if (!commentsDone) commentsAfter = nextCursor(commentPage, commentCursors);
      if (!relationsDone) relationsAfter = nextCursor(relationPage, relationCursors);
    }
  }

  async function graphql(query, variables) {
    const operation = query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/u)?.[1] ?? "unknown";
    const reservation = budget?.reservePhysicalRequest();
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
      log({ event: "target_transport_request_failed", operation });
      throw new Error("target_transport_request_failed");
    } finally {
      reservation?.release();
    }
    let body;
    try {
      body = await response.json();
    } catch {
      log({ event: "target_transport_response_invalid", operation, status: response.status });
      throw new Error("target_transport_response_invalid");
    }
    if (!response.ok || Array.isArray(body?.errors) && body.errors.length > 0 ||
        !body?.data || typeof body.data !== "object") {
      log({
        event: "target_transport_graphql_failed",
        operation,
        status: response.status,
        errorCount: Array.isArray(body?.errors) ? body.errors.length : 0,
      });
      throw new Error("target_transport_graphql_failed");
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

function validateInput(input) {
  if (!input || typeof input !== "object" || !isSafeId(input.rootIssueId) ||
      !isSafeId(input.projectId) || !input.git || !isSha(input.git.head) ||
      !isSafeId(input.git.branch)) {
    throw new Error("target_transport_input_invalid");
  }
  return Object.freeze({
    rootIssueId: input.rootIssueId,
    projectId: input.projectId,
    git: Object.freeze({ head: input.git.head, branch: input.git.branch }),
  });
}

function issueHeader(value, projectId) {
  const issue = object(value, "target_transport_response_invalid");
  if (!isSafeId(issue.id) || issue.project?.id !== projectId ||
      (issue.parent?.id !== undefined && issue.parent?.id !== null && !isSafeId(issue.parent.id)) ||
      typeof issue.state?.name !== "string") {
    throw new Error("target_transport_issue_invalid");
  }
  return {
    id: issue.id,
    projectId,
    ...(issue.parent?.id ? { parentIssueId: issue.parent.id } : {}),
    state: issue.state.name,
  };
}

function readRecordBody(body) {
  const prefix = "<!-- symphony managed-record\n";
  const suffix = "\n-->";
  if (typeof body !== "string" || !body.startsWith(prefix) || !body.endsWith(suffix)) return undefined;
  try {
    const record = JSON.parse(body.slice(prefix.length, -suffix.length));
    return record && typeof record === "object" && !Array.isArray(record) ? record : undefined;
  } catch {
    return { kind: "__malformed__" };
  }
}

function normalizeComment(value, issueId) {
  const comment = object(value, "target_transport_response_invalid");
  if (!isSafeId(comment.id) || comment.issue?.id !== issueId || typeof comment.body !== "string") {
    throw new Error("target_transport_comment_invalid");
  }
  const record = readRecordBody(comment.body);
  if (!record) return undefined;
  if (record.kind === "node_marker") return { nodeMarker: record };
  if (IGNORED_RECORD_KINDS.has(record.kind)) return undefined;
  return { comment: { id: comment.id, issueId, body: comment.body } };
}

function normalizeRelation(value, issueId, projectId) {
  const relation = object(value, "target_transport_response_invalid");
  if (!isSafeId(relation.id) || !relation.issue || !relation.relatedIssue ||
      relation.relatedIssue.id !== issueId || relation.issue.id === issueId ||
      relation.issue.project?.id !== projectId || relation.relatedIssue.project?.id !== projectId) {
    throw new Error("target_transport_relation_invalid");
  }
  if (relation.type !== "blocks" && relation.type !== "blocked_by") return undefined;
  return {
    id: relation.id,
    relationKind: "blocks",
    sourceIssueId: relation.type === "blocked_by" ? relation.relatedIssue.id : relation.issue.id,
    targetIssueId: relation.type === "blocked_by" ? relation.issue.id : relation.relatedIssue.id,
  };
}

function scopeRootTree(issues, rootIssueId) {
  const children = new Map();
  for (const issue of issues) {
    if (issue.parentIssueId) {
      const siblings = children.get(issue.parentIssueId) ?? [];
      siblings.push(issue);
      children.set(issue.parentIssueId, siblings);
    }
  }
  const scoped = [];
  const queue = [rootIssueId];
  while (queue.length > 0) {
    const issueId = queue.shift();
    const issue = issues.find((candidate) => candidate.id === issueId);
    if (!issue) throw new Error("target_transport_tree_scope_invalid");
    scoped.push(issue);
    queue.push(...(children.get(issueId) ?? []).map(({ id }) => id));
  }
  return scoped;
}

function normalizeSnapshot(request, issues, details) {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const comments = [];
  const nodeMarkers = new Map();
  for (const issue of issues) {
    const issueDetails = details.get(issue.id);
    if (!issueDetails) throw new Error("target_transport_issue_details_missing");
    const rawMarkers = issueDetails.markers;
    if (rawMarkers.length > 1) throw new Error("target_transport_node_marker_ambiguous");
    if (rawMarkers.length === 1) {
      const marker = rawMarkers[0];
    if (marker.version !== 1 || marker.root_issue_id !== request.rootIssueId ||
          !isSafeId(marker.cycle_issue_id) || !isSafeId(marker.node_key) ||
          !["plan", "work", "verify"].includes(marker.node_kind)) {
        throw new Error("target_transport_node_marker_invalid");
      }
      const markerCycle = issueById.get(marker.cycle_issue_id);
      if (!markerCycle || markerCycle.parentIssueId !== request.rootIssueId) {
        throw new Error("target_transport_node_marker_scope_invalid");
      }
      nodeMarkers.set(issue.id, marker);
    }
    comments.push(...issueDetails.comments);
  }
  const normalizedIssues = issues.map((issue) => {
    if (issue.id === request.rootIssueId) return { ...issue, kind: "root" };
    const marker = nodeMarkers.get(issue.id);
    const cycle = issueDetailsFor(issue.id, details).some(({ body }) => readRecordBody(body)?.kind === "cycle_marker");
    if (!marker && !cycle) throw new Error("target_transport_issue_kind_invalid");
    if (marker && (!issueById.has(marker.cycle_issue_id) || issue.parentIssueId !== marker.cycle_issue_id)) {
      throw new Error("target_transport_node_marker_scope_invalid");
    }
    return {
      ...issue,
      kind: marker?.node_kind ?? "cycle",
      ...(marker?.node_key ? { nodeKey: marker.node_key } : {}),
    };
  });
  return Object.freeze({
    rootIssueId: request.rootIssueId,
    projectId: request.projectId,
    git: request.git,
    issues: Object.freeze(normalizedIssues),
    comments: Object.freeze(comments),
    relations: Object.freeze(normalizeRelations(issues, details)),
  });
}

function issueDetailsFor(issueId, details) {
  return details.get(issueId)?.comments ?? [];
}

function normalizeRelations(issues, details) {
  const issueIds = new Set(issues.map(({ id }) => id));
  const relations = [];
  const relationIds = new Set();
  for (const issue of issues) {
    for (const relation of details.get(issue.id)?.relations ?? []) {
      if (!issueIds.has(relation.sourceIssueId) || !issueIds.has(relation.targetIssueId)) continue;
      if (relationIds.has(relation.id)) throw new Error("target_transport_duplicate_relation");
      relationIds.add(relation.id);
      relations.push({ relationKind: "blocks", sourceIssueId: relation.sourceIssueId, targetIssueId: relation.targetIssueId });
    }
  }
  return relations;
}

function pageConnection(value, errorCode) {
  const connection = object(value, errorCode);
  if (!Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") {
    throw new Error(errorCode);
  }
  return {
    nodes: connection.nodes,
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor: connection.pageInfo.endCursor,
  };
}

function nextCursor(connection, cursors) {
  if (!isCursor(connection.endCursor) || cursors.has(connection.endCursor)) {
    throw new Error("target_transport_cursor_invalid");
  }
  cursors.add(connection.endCursor);
  return connection.endCursor;
}

function object(value, errorCode) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  return value;
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isSha(value) {
  return typeof value === "string" && SHA.test(value);
}

function isCursor(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\0\r\n]/u.test(value);
}
