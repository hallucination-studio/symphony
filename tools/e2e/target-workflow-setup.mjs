import { createHash as createSha256 } from "node:crypto";

import { createTargetWorkflowSetup } from "@symphony/podium";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const MUTATION_KINDS = new Set(["applied", "already_applied"]);
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const E2E_MARKER = /<!-- symphony e2e-run\s+run_id: ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s+-->/u;

export async function prepareTargetWorkflowSetup({
  config,
  runId,
  fetch = globalThis.fetch,
  log = () => {},
  linearRunBudget,
  setup = createTargetWorkflowSetup(linearRunBudget ? { linearRunBudget } : {}),
} = {}) {
  if (!RUN_ID.test(runId ?? "") || !config?.linear ||
      !SAFE_ID.test(config.linear.clientId ?? "") || !SAFE_ID.test(config.linear.projectSlugId ?? "") ||
      typeof config.linear.setupAuthorized !== "boolean" ||
      typeof config.secrets?.linearDevToken !== "string" || config.secrets.linearDevToken.length === 0 ||
      typeof fetch !== "function" || typeof log !== "function" ||
      !setup || typeof setup.initialize !== "function") {
    throw stableError("target_live_setup_input_invalid");
  }
  const ids = runIdentifiers(runId);
  let result;
  try {
    result = await setup.initialize({
      developmentToken: config.secrets.linearDevToken,
      clientId: config.linear.clientId,
      projectSlugId: config.linear.projectSlugId,
      conductorShortHash: ids.conductorShortHash,
      authorized: config.linear.setupAuthorized,
      fetch,
    });
  } catch (error) {
    log({ event: "target_live_setup_failed", reason: stableReason(error) });
    throw stableError(stableReason(error));
  }
  if (!result || typeof result !== "object" ||
      !["dry_run", "ready"].includes(result.kind) ||
      (result.kind === "dry_run"
        ? result.workflow !== "dry_run" || result.projectLabel !== "dry_run"
        : !MUTATION_KINDS.has(result.workflow) || !MUTATION_KINDS.has(result.projectLabel)) ||
      !SAFE_ID.test(result.organizationId ?? "") || !SAFE_ID.test(result.delegateActorId ?? "") ||
      !SAFE_ID.test(result.project?.projectId ?? "") || !SAFE_ID.test(result.teamId ?? "") ||
      typeof result.identityDigest !== "string" || !/^[a-f0-9]{16}$/u.test(result.identityDigest) ||
      (result.kind === "ready" && (
        typeof result.project?.updatedAt !== "string" ||
        result.resolution?.kind !== "resolved" ||
        result.resolution.projectId !== result.project.projectId ||
        typeof result.resolution.updatedAt !== "string" ||
        result.resolution.updatedAt !== result.project.updatedAt
      ))) {
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
  const archivedRootCount = await archivePriorE2eRoots({
    developmentToken: config.secrets.linearDevToken,
    projectId: result.project.projectId,
    currentRunId: runId,
    fetch,
    linearRunBudget,
  });
  log({ event: "target_live_prior_roots_archived", count: archivedRootCount });
  return Object.freeze({
    setup: result,
    ids,
    rootInput: Object.freeze({
      teamId: result.teamId,
      projectId: result.project.projectId,
      stateId: result.todoStateId,
      delegateId: result.delegateActorId,
      title: "Target live success",
      description: `Target live success Root. Plan exactly one minimal Work node that adds one E2E evidence line to README.md, then Verify it.\n\n<!-- symphony e2e-run\nrun_id: ${runId}\n-->`,
    }),
  });
}

export async function archivePriorE2eRoots({ developmentToken, projectId, currentRunId, fetch, linearRunBudget }) {
  const request = async (query, operationName) => {
    linearRunBudget?.recordLogicalOperation();
    const reservation = linearRunBudget?.reservePhysicalRequest();
    let observed = false;
    try {
      const response = await fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { authorization: developmentToken, "content-type": "application/json" },
        body: JSON.stringify({ query, operationName }),
        signal: AbortSignal.timeout(30_000),
      });
      linearRunBudget?.observe({ status: response.status, ...rateWindows(response.headers) });
      observed = true;
      const body = await response.json();
      if (!response.ok || body?.errors?.length || !body?.data) throw stableError("target_live_archive_failed");
      return body.data;
    } catch (error) {
      if (!observed) linearRunBudget?.observe({});
      throw error?.message === "target_live_archive_failed" ? error : stableError("target_live_archive_failed");
    } finally {
      reservation?.release();
    }
  };
  const data = await request(`query TargetWorkflowListPriorRoots {
    project(id: ${JSON.stringify(projectId)}) {
      issues(first: 250, includeArchived: false) { nodes { id description parent { id } project { id } } pageInfo { hasNextPage } }
    }
  }`, "TargetWorkflowListPriorRoots");
  const connection = data.project?.issues;
  if (!Array.isArray(connection?.nodes) || connection.pageInfo?.hasNextPage !== false) {
    throw stableError("target_live_archive_scope_invalid");
  }
  const ids = connection.nodes.flatMap((issue) => {
    const match = typeof issue?.description === "string" ? issue.description.match(E2E_MARKER) : undefined;
    return SAFE_ID.test(issue?.id ?? "") && issue.project?.id === projectId && issue.parent === null &&
      match && match[1] !== currentRunId ? [issue.id] : [];
  });
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
  return ids.length;
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

function stableReason(error) {
  const reason = error instanceof Error ? error.message : "target_live_setup_failed";
  return /^[a-z][a-z0-9_]{1,120}$/u.test(reason) ? reason : "target_live_setup_failed";
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
