import { runTargetSchedulingScenario } from "./target-workflow-scheduling.mjs";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const PAGE_SIZE = 250;
const MAX_ROOTS = 512;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const PRIORITY = Object.freeze({ 0: "no_priority", 1: "urgent", 2: "high", 3: "normal", 4: "low" });

const PROJECT_ROOTS_QUERY = `
  query TargetWorkflowSchedulingRoots($projectId: String!, $after: String) {
    project(id: $projectId) {
      id
      issues(first: 250, after: $after) {
        nodes {
          id identifier title description priority sortOrder updatedAt
          project { id }
          parent { id }
          delegate { id }
          state { name }
          comments(first: 64) {
            nodes { id body issue { id } }
            pageInfo { hasNextPage }
          }
          inverseRelations(first: 250) {
            nodes {
              type
              issue { id state { name } project { id } }
              relatedIssue { id project { id } }
            }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export async function runTargetSchedulingScenarioLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  linearRunBudget,
} = {}) {
  const runId = environment?.SYMPHONY_E2E_RUN_ID;
  if (!SAFE_ID.test(runId ?? "") || !config?.linear?.projectSlugId ||
      typeof config.secrets?.linearDevToken !== "string" || config.secrets.linearDevToken.length === 0 ||
      typeof fetch !== "function" || typeof log !== "function" || !hasRunBudget(linearRunBudget)) {
    throw stableError("target_live_scheduling_input_invalid");
  }
  const scheduling = await readTargetSchedulingEvidence({
    developmentToken: config.secrets.linearDevToken,
    projectId: config.linear.projectSlugId,
    delegateActorId: config.linear.delegateActorId,
    conductorId: config.linear.conductorId,
    fetch,
    log,
    linearRunBudget,
  });
  return Object.freeze({ status: "passed", scenario: "scheduling", runId, scheduling });
}

export async function readTargetSchedulingEvidence({
  developmentToken,
  projectId,
  delegateActorId,
  conductorId = "",
  fetch = globalThis.fetch,
  log = () => {},
  linearRunBudget,
} = {}) {
  if (typeof developmentToken !== "string" || developmentToken.length === 0 ||
      !SAFE_ID.test(projectId ?? "") || !SAFE_ID.test(delegateActorId ?? "") ||
      (conductorId !== "" && !SAFE_ID.test(conductorId)) || typeof fetch !== "function" ||
      typeof log !== "function" || !hasRunBudget(linearRunBudget)) {
    throw stableError("target_scheduling_reader_input_invalid");
  }
  linearRunBudget?.recordLogicalOperation();
  const roots = await readProjectRoots({ developmentToken, projectId, delegateActorId, conductorId, fetch, log, linearRunBudget });
  const current = roots.filter((root) => root.parentIssueId === undefined && root.state !== "Done" &&
    (root.state !== "Canceled" || root.managedConductorId === conductorId) &&
    (root.managedConductorId === conductorId || (!root.managedConductorId && root.isDelegatedToSymphony)));
  if (current.length === 0) throw stableError("target_scheduling_no_current_roots");
  const blocked = new Set(current.filter((root) => root.blockers.some(({ targetState }) => targetState !== "Done"))
    .map(({ issueId }) => issueId));
  const eligible = current.filter(({ issueId }) => !blocked.has(issueId)).sort(compareRoots);
  if (eligible.length === 0) throw stableError("target_scheduling_no_eligible_roots");
  return runTargetSchedulingScenario({
    readScheduling: async () => ({
      selectedRootIds: [eligible[0].issueId],
      waitingRootIds: current.filter(({ issueId }) => issueId !== eligible[0].issueId).map(({ issueId }) => issueId),
      maxConcurrentRoots: 1,
      blockerRespected: !eligible[0].blockers.some(({ targetState }) => targetState !== "Done"),
    }),
  });
}

async function readProjectRoots({ developmentToken, projectId, delegateActorId, conductorId, fetch, log, linearRunBudget }) {
  const roots = [];
  const seenCursors = new Set();
  let after = null;
  while (true) {
    const data = await graphql(PROJECT_ROOTS_QUERY, { projectId, after }, { developmentToken, fetch, log, linearRunBudget });
    const project = data.project;
    if (project?.id !== projectId) throw stableError("target_scheduling_project_scope_invalid");
    const page = project.issues;
    if (!page || !Array.isArray(page.nodes) || page.nodes.length > PAGE_SIZE ||
        !page.pageInfo || typeof page.pageInfo.hasNextPage !== "boolean") {
      throw stableError("target_scheduling_page_invalid");
    }
    for (const node of page.nodes) {
      const root = normalizeRoot(node, projectId, delegateActorId, conductorId);
      if (!root) continue;
      if (roots.some(({ issueId }) => issueId === root.issueId)) throw stableError("target_scheduling_duplicate_root");
      roots.push(root);
      if (roots.length > MAX_ROOTS) throw stableError("target_scheduling_bound_exceeded");
    }
    if (!page.pageInfo.hasNextPage) return roots;
    const cursor = page.pageInfo.endCursor;
    if (typeof cursor !== "string" || cursor.length === 0 || seenCursors.has(cursor)) {
      throw stableError("target_scheduling_cursor_invalid");
    }
    seenCursors.add(cursor);
    after = cursor;
  }
}

function normalizeRoot(node, projectId, delegateActorId, conductorId) {
  if (!node || node.project?.id !== projectId || !SAFE_ID.test(node.id ?? "") ||
      !SAFE_ID.test(node.identifier ?? "")) {
    throw stableError("target_scheduling_root_invalid");
  }
  if (node.parent?.id !== undefined && node.parent?.id !== null) return undefined;
  if (
      !["Todo", "In Progress", "In Review", "Done", "Canceled"].includes(node.state?.name) ||
      !Number.isSafeInteger(node.priority) || PRIORITY[node.priority] === undefined ||
      typeof node.sortOrder !== "number" || !Number.isFinite(node.sortOrder) ||
      !Array.isArray(node.comments?.nodes) || node.comments.nodes.length > 64 || node.comments.pageInfo?.hasNextPage !== false ||
      !Array.isArray(node.inverseRelations?.nodes) || node.inverseRelations.nodes.length > 250 ||
      node.inverseRelations.pageInfo?.hasNextPage !== false) {
    throw stableError("target_scheduling_root_invalid");
  }
  const ownership = node.comments.nodes.map((comment) => readOwnership(comment, node.id)).filter(Boolean);
  if (ownership.length > 1) throw stableError("target_scheduling_ownership_ambiguous");
  const blockers = node.inverseRelations.nodes.flatMap((relation) => {
    if (relation.type !== "blocks") return [];
    if (relation.relatedIssue?.id !== node.id || relation.issue?.project?.id !== projectId ||
        !SAFE_ID.test(relation.issue?.id ?? "") || !["Todo", "In Progress", "In Review", "Done", "Canceled"].includes(relation.issue?.state?.name)) {
      throw stableError("target_scheduling_blocker_invalid");
    }
    return [{ targetIssueId: relation.issue.id, targetState: relation.issue.state.name }];
  });
  return Object.freeze({
    issueId: node.id,
    identifier: node.identifier,
    state: node.state.name,
    projectId,
    parentIssueId: undefined,
    isDelegatedToSymphony: node.delegate?.id === delegateActorId,
    managedConductorId: ownership[0]?.conductorId,
    priority: PRIORITY[node.priority],
    order: node.sortOrder,
    blockers: Object.freeze(blockers),
  });
}

function readOwnership(comment, issueId) {
  if (!comment || comment.issue?.id !== issueId || typeof comment.body !== "string") return undefined;
  const prefix = "<!-- symphony managed-record\n";
  const suffix = "\n-->";
  if (!comment.body.startsWith(prefix) || !comment.body.endsWith(suffix)) return undefined;
  let record;
  try { record = JSON.parse(comment.body.slice(prefix.length, -suffix.length)); } catch { throw stableError("target_scheduling_record_invalid"); }
  if (record?.kind !== "root_ownership" || record.version !== 1 || !SAFE_ID.test(record.conductor_id ?? "") ||
      !SAFE_ID.test(record.root_issue_id ?? "") || record.root_issue_id !== issueId) return undefined;
  return { conductorId: record.conductor_id };
}

function compareRoots(left, right) {
  const priority = { urgent: 0, high: 1, normal: 2, low: 3, no_priority: 4 };
  return priority[left.priority] - priority[right.priority] || left.order - right.order || left.identifier.localeCompare(right.identifier);
}

async function graphql(query, variables, { developmentToken, fetch, log, linearRunBudget }) {
  const reservation = linearRunBudget?.reservePhysicalRequest();
  let observed = false;
  let response;
  try {
    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: developmentToken, "content-type": "application/json" },
      body: JSON.stringify({ query, variables, operationName: "TargetWorkflowSchedulingRoots" }),
    });
    linearRunBudget?.observe({ status: response.status, ...readRateWindows(response.headers) });
    observed = true;
  } catch {
    if (!observed) linearRunBudget?.observe({});
    log({ event: "target_scheduling_request_failed" });
    throw stableError("target_scheduling_request_failed");
  } finally {
    reservation?.release();
  }
  let body;
  try { body = await response.json(); } catch {
    log({ event: "target_scheduling_response_invalid", status: response.status });
    throw stableError("target_scheduling_response_invalid");
  }
  if (!response.ok || body?.errors?.length || !body?.data || typeof body.data !== "object") {
    log({ event: "target_scheduling_graphql_failed", status: response.status, errorCount: Array.isArray(body?.errors) ? body.errors.length : 0 });
    throw stableError("target_scheduling_graphql_failed");
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
    ? undefined
    : { ...(limit === undefined ? {} : { limit }), ...(remaining === undefined ? {} : { remaining }), ...(reset === undefined ? {} : { reset }) };
}

function hasRunBudget(value) {
  return Boolean(value) && typeof value.recordLogicalOperation === "function" &&
    typeof value.reservePhysicalRequest === "function" && typeof value.observe === "function";
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
