import { createHash as createSha256 } from "node:crypto";

import { createTargetWorkflowSetup } from "@symphony/podium";
import { createTargetWorkflowRequestSignal } from "./target-workflow-deadline.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const MUTATION_KINDS = new Set(["applied", "already_applied"]);
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SETUP_TIMEOUT_MS = 5 * 60_000;
const E2E_MARKER = /<!-- symphony e2e-run\s+run_id: ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s+-->/u;
const PARALLEL_SCENARIOS = Object.freeze([
  "success", "repair_escalation", "restart_recovery", "delivery", "scheduling",
]);

export async function prepareTargetWorkflowSetup({
  config,
  runId,
  fetch = globalThis.fetch,
  log = () => {},
  observer,
  signal,
  setup: providedSetup,
  poolMode = "single",
} = {}) {
  const setup = providedSetup ?? createTargetWorkflowSetup(
    observer ? { observeLinearRequest: observer.observe.bind(observer) } : {},
  );
  if (!RUN_ID.test(runId ?? "") || !config?.linear ||
      !SAFE_ID.test(config.linear.clientId ?? "") || !SAFE_ID.test(config.linear.projectSlugId ?? "") ||
      typeof config.linear.setupAuthorized !== "boolean" ||
      typeof config.secrets?.linearDevToken !== "string" || config.secrets.linearDevToken.length === 0 ||
      typeof fetch !== "function" || typeof log !== "function" ||
      !setup || typeof setup.initialize !== "function") {
    throw stableError("target_live_setup_input_invalid");
  }
  if (poolMode !== "single" && poolMode !== "parallel") {
    throw stableError("target_live_setup_pool_mode_invalid");
  }
  const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_SETUP_TIMEOUT_MS);
  const ids = runIdentifiers(runId);
  const scenarioConductorShortHashes = PARALLEL_SCENARIOS.map((scenario) =>
    runIdentifiers(`${runId}-${scenario}`).conductorShortHash,
  );
  const desiredConductorShortHashes = poolMode === "parallel"
    ? scenarioConductorShortHashes
    : [ids.conductorShortHash];
  const activeConductorShortHash = desiredConductorShortHashes[0];
  if (config.linear.setupAuthorized) {
    const projectId = await readTargetProjectId({
      projectSlugId: config.linear.projectSlugId,
      developmentToken: config.secrets.linearDevToken,
      fetch,
      observer,
      signal: effectiveSignal,
    });
    let archivedRootCount;
    try {
      archivedRootCount = await archivePriorE2eRoots({
        developmentToken: config.secrets.linearDevToken,
        projectId,
        currentRunId: runId,
        fetch,
        observer,
        signal: effectiveSignal,
      });
    } catch (error) {
      if (error?.message === "target_live_active_root_present") {
        log({
          event: "target_live_preparation_blocked",
          reason: error.message,
          activeRoots: error.activeRoots,
        });
      }
      throw error;
    }
    log({ event: "target_live_prior_roots_archived", count: archivedRootCount });
  }
  let result;
  try {
    result = await setup.initialize({
      developmentToken: config.secrets.linearDevToken,
      clientId: config.linear.clientId,
      projectSlugId: config.linear.projectSlugId,
      conductorShortHash: activeConductorShortHash,
      conductorShortHashes: desiredConductorShortHashes,
      authorized: config.linear.setupAuthorized,
      fetch,
      signal: effectiveSignal,
    });
  } catch (error) {
    log({ event: "target_live_setup_failed", reason: stableReason(error) });
    throw stableError(stableReason(error));
  }
  const resultValid = Boolean(result && typeof result === "object" &&
    ["dry_run", "ready"].includes(result.kind) &&
    (result.kind === "dry_run"
      ? result.workflow === "dry_run" && result.projectLabel === "dry_run"
      : MUTATION_KINDS.has(result.workflow) && MUTATION_KINDS.has(result.projectLabel)) &&
    SAFE_ID.test(result.organizationId ?? "") && SAFE_ID.test(result.delegateActorId ?? "") &&
    SAFE_ID.test(result.project?.projectId ?? "") && SAFE_ID.test(result.teamId ?? "") &&
    typeof result.identityDigest === "string" && /^[a-f0-9]{16}$/u.test(result.identityDigest) &&
    (result.kind !== "ready" || (
      typeof result.project?.updatedAt === "string" &&
      result.resolution?.kind === "resolved" &&
      result.resolution.projectId === result.project.projectId &&
      typeof result.resolution.updatedAt === "string" &&
      result.resolution.updatedAt === result.project.updatedAt
    )) &&
    Array.isArray(result.projectPool?.members) &&
    desiredConductorShortHashes.length === result.projectPool.members.length &&
    desiredConductorShortHashes.every((hash) => result.projectPool.members.includes(hash)));
  if (!resultValid) {
    throw stableError("target_live_setup_result_invalid");
  }
  log({
    event: "target_live_setup_verdict",
    kind: result.kind,
    workflow: result.workflow,
    projectLabel: result.projectLabel,
    identityDigest: result.identityDigest,
  });
  if (result.kind !== "ready" || !SAFE_ID.test(result.todoStateId ?? "")) {
    throw stableError(result.kind === "dry_run"
      ? "target_live_setup_authorization_required"
      : "target_live_setup_incomplete");
  }
  return Object.freeze({
    setup: result,
    ids,
    rootInput: Object.freeze({
      teamId: result.teamId,
      projectId: result.project.projectId,
      stateId: result.todoStateId,
      delegateId: result.delegateActorId,
      conductorShortHash: activeConductorShortHash,
      title: "Target live success",
      description: `Target live success Root. Plan exactly one minimal Work node that adds one E2E evidence line to README.md, then Verify it. The Plan Contract included_scope must be exactly ["README.md"]. Use only exact repository-relative path prefixes in included_scope and excluded_scope; do not put prose, actions, or rationale in those arrays.\n\n<!-- symphony e2e-run\nrun_id: ${runId}\n-->`,
    }),
  });
}

async function readTargetProjectId({ projectSlugId, developmentToken, fetch, observer, signal }) {
  observer?.recordLogicalOperation();
  let response;
  try {
    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: developmentToken, "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "TargetWorkflowReadProjectId",
        query: `query TargetWorkflowReadProjectId($projectSlugId: String!) {
          project(id: $projectSlugId) { id }
        }`,
        variables: { projectSlugId },
      }),
      signal: createTargetWorkflowRequestSignal(signal, REQUEST_TIMEOUT_MS),
    });
    observer?.observe({ status: response.status, ...rateWindows(response.headers) });
    if (response.status === 429) throw stableError("target_live_rate_limited");
  } catch (error) {
    if (observer?.snapshot?.()?.rateLimited === true) throw stableError("target_live_rate_limited");
    if (error?.message === "target_live_rate_limited") throw error;
    throw stableError("target_live_project_read_failed");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw stableError("target_live_project_read_failed");
  }
  const projectId = body?.data?.project?.id;
  if (!response.ok || body?.errors?.length || !SAFE_ID.test(projectId ?? "")) {
    throw stableError("target_live_project_read_failed");
  }
  return projectId;
}

export async function archivePriorE2eRoots({ developmentToken, projectId, currentRunId, fetch, observer, signal }) {
  const request = async (query, operationName) => {
    observer?.recordLogicalOperation();
    let observed = false;
    try {
      const response = await fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { authorization: developmentToken, "content-type": "application/json" },
        body: JSON.stringify({ query, operationName }),
        signal: createTargetWorkflowRequestSignal(signal, REQUEST_TIMEOUT_MS),
      });
      observer?.observe({ status: response.status, ...rateWindows(response.headers) });
      observed = true;
      if (response.status === 429) throw stableError("target_live_rate_limited");
      const body = await response.json();
      if (!response.ok || body?.errors?.length || !body?.data) throw stableError("target_live_archive_failed");
      return body.data;
    } catch (error) {
      if (!observed) observer?.observe({});
      if (observer?.snapshot?.()?.rateLimited === true) throw stableError("target_live_rate_limited");
      throw error?.message === "target_live_rate_limited" || error?.message === "target_live_archive_failed"
        ? error : stableError("target_live_archive_failed");
    }
  };
  const data = await request(`query TargetWorkflowListPriorRoots {
    project(id: ${JSON.stringify(projectId)}) {
      issues(first: 250, includeArchived: false) { nodes { id description parent { id } project { id } state { type } } pageInfo { hasNextPage } }
    }
  }`, "TargetWorkflowListPriorRoots");
  const connection = data.project?.issues;
  if (!Array.isArray(connection?.nodes) || connection.pageInfo?.hasNextPage !== false) {
    throw stableError("target_live_archive_scope_invalid");
  }
  const activeRoots = [];
  const ids = connection.nodes.flatMap((issue) => {
    const match = typeof issue?.description === "string" ? issue.description.match(E2E_MARKER) : undefined;
    if (!SAFE_ID.test(issue?.id ?? "") || issue.project?.id !== projectId || issue.parent !== null ||
        !match || match[1] === currentRunId) return [];
    if (!isTerminalRootType(issue.state?.type)) {
      activeRoots.push(Object.freeze({
        issueDigest: digestIdentifier(issue.id),
        runDigest: digestIdentifier(match[1]),
        stateType: typeof issue.state?.type === "string" ? issue.state.type : "unknown",
      }));
      return [];
    }
    return [issue.id];
  });
  if (activeRoots.length > 0) {
    throw stableError("target_live_active_root_present", {
      activeRoots: Object.freeze(activeRoots),
    });
  }
  if (ids.length === 0) return 0;
  const aliases = ids.map((id, index) => `a${index}: issueArchive(id: ${JSON.stringify(id)}) { success }`).join("\n");
  const archived = await request(`mutation TargetWorkflowArchivePriorRoots { ${aliases} }`, "TargetWorkflowArchivePriorRoots");
  if (ids.some((_, index) => archived[`a${index}`]?.success !== true)) throw stableError("target_live_archive_failed");
  const readBack = await request(`query TargetWorkflowReadArchivedRoots {
    issues(filter: { id: { in: [${ids.map((id) => JSON.stringify(id)).join(", ")}] } }, first: 250, includeArchived: true) {
      nodes { id archivedAt } pageInfo { hasNextPage }
    }
  }`, "TargetWorkflowReadArchivedRoots");
  if (!Array.isArray(readBack.issues?.nodes) || readBack.issues.pageInfo?.hasNextPage !== false ||
      readBack.issues.nodes.length !== ids.length ||
      readBack.issues.nodes.some((issue) => !ids.includes(issue?.id) || typeof issue.archivedAt !== "string")) {
    throw stableError("target_live_archive_read_back_failed");
  }
  const remaining = await request(`query TargetWorkflowVerifyPriorRoots {
    project(id: ${JSON.stringify(projectId)}) {
      issues(first: 250, includeArchived: false) { nodes { id description parent { id } project { id } } pageInfo { hasNextPage } }
    }
  }`, "TargetWorkflowVerifyPriorRoots");
  const remainingConnection = remaining.project?.issues;
  if (!Array.isArray(remainingConnection?.nodes) || remainingConnection.pageInfo?.hasNextPage !== false ||
      remainingConnection.nodes.some((issue) => {
        const match = typeof issue?.description === "string" ? issue.description.match(E2E_MARKER) : undefined;
        return SAFE_ID.test(issue?.id ?? "") && issue.project?.id === projectId && issue.parent === null &&
          match && match[1] !== currentRunId;
      })) {
    throw stableError("target_live_archive_incomplete");
  }
  return ids.length;
}

function isTerminalRootType(type) {
  return type === "completed" || type === "canceled";
}

function rateWindows(headers) {
  const window = (prefix) => {
    const number = (suffix) => { const value = headers?.get(`${prefix}-${suffix}`); return /^\d{1,16}$/u.test(value ?? "") ? Number(value) : undefined; };
    const limit = number("limit"); const remaining = number("remaining"); const reset = number("reset");
    return [limit, remaining, reset].every(Number.isSafeInteger) ? { limit, remaining, reset } : undefined;
  };
  return { ...(window("x-ratelimit-requests") ? { requestWindow: window("x-ratelimit-requests") } : {}), ...(window("x-ratelimit-complexity") ? { complexityWindow: window("x-ratelimit-complexity") } : {}) };
}

export function runIdentifiers(runId) {
  const hash = createSha256("sha256").update(runId).digest("hex");
  return Object.freeze({
    conductorShortHash: hash.slice(0, 12),
    conductorId: `conductor-${hash.slice(0, 24)}`,
    bindingId: `binding-${hash.slice(0, 24)}`,
    instanceId: `instance-${hash.slice(0, 24)}`,
    repositoryHandle: `repository-${hash.slice(0, 24)}`,
  });
}

function digestIdentifier(value) {
  return createSha256("sha256").update(value).digest("hex").slice(0, 12);
}

function stableReason(error) {
  const reason = error instanceof Error ? error.message : "target_live_setup_failed";
  return /^[a-z][a-z0-9_]{1,120}$/u.test(reason) ? reason : "target_live_setup_failed";
}

function stableError(code, properties = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, properties);
  return error;
}
