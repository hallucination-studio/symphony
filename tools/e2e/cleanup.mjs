import { createHash, randomUUID } from "node:crypto";

import { isMissingInputConfiguration, loadE2EConfig } from "./config.mjs";
import { archivePriorE2eRoots } from "./target-workflow-setup.mjs";
import { createTargetWorkflowRequestSignal } from "./target-workflow-deadline.mjs";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const RUN_DIGEST = /^[a-f0-9]{12}$/u;
const E2E_MARKER = /<!-- symphony e2e-run\s+run_id: ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s+-->/u;
const TERMINAL_ROOT_TYPES = new Set(["completed", "canceled"]);

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const arguments_ = process.argv.slice(2);
  const operation = arguments_[0] === "--quiesce-run-digest"
    ? quiesceRun({ runDigest: arguments_[1], confirmation: arguments_[2] })
    : arguments_.length === 0 ? run() : Promise.reject(stableError("target_live_cleanup_arguments_invalid"));
  operation.then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: isMissingInputConfiguration(error) ? "unverified" : "failed",
      reason: stableReason(error),
      ...(Array.isArray(error?.issues) ? { issues: error.issues } : {}),
    })}\n`);
    process.exitCode = isMissingInputConfiguration(error) ? 2 : 1;
  });
}

export async function run({
  environment = process.env,
  fetch = globalThis.fetch,
  runId = `cleanup-${randomUUID()}`,
} = {}) {
  const config = loadE2EConfig({ environment });
  if (typeof fetch !== "function") throw stableError("target_live_cleanup_fetch_invalid");
  if (!config.linear.setupAuthorized) throw stableError("target_live_cleanup_authorization_required");
  const projectId = await resolveProjectId({
    developmentToken: config.secrets.linearDevToken,
    projectSlugId: config.linear.projectSlugId,
    fetch,
  });
  const archived = await archivePriorE2eRoots({
    developmentToken: config.secrets.linearDevToken,
    projectId,
    currentRunId: runId,
    fetch,
  });
  return Object.freeze({ status: "passed", archived, projectDigest: digestIdentifier(projectId) });
}

export async function quiesceRun({
  environment = process.env,
  fetch = globalThis.fetch,
  runDigest,
  confirmation,
} = {}) {
  const config = loadE2EConfig({ environment });
  if (typeof fetch !== "function") throw stableError("target_live_quiesce_fetch_invalid");
  if (!config.linear.setupAuthorized) throw stableError("target_live_quiesce_authorization_required");
  if (!RUN_DIGEST.test(runDigest ?? "")) throw stableError("target_live_quiesce_run_digest_invalid");
  const projectId = await resolveProjectId({
    developmentToken: config.secrets.linearDevToken,
    projectSlugId: config.linear.projectSlugId,
    fetch,
  });
  return quiesceMarkedE2eRoot({
    developmentToken: config.secrets.linearDevToken,
    projectId,
    runDigest,
    confirmation,
    fetch,
  });
}

export async function quiesceMarkedE2eRoot({
  developmentToken,
  projectId,
  runDigest,
  confirmation,
  fetch = globalThis.fetch,
  signal,
} = {}) {
  if (confirmation !== "QUIESCE") throw stableError("target_live_quiesce_confirmation_required");
  if (typeof developmentToken !== "string" || developmentToken.length === 0 ||
      !SAFE_ID.test(projectId ?? "") || !RUN_DIGEST.test(runDigest ?? "") ||
      typeof fetch !== "function") {
    throw stableError("target_live_quiesce_input_invalid");
  }
  const request = async (query, operationName) => {
    let response;
    try {
      response = await fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { authorization: developmentToken, "content-type": "application/json" },
        body: JSON.stringify({ query, operationName }),
        signal: createTargetWorkflowRequestSignal(signal, 30_000),
      });
    } catch {
      throw stableError("target_live_quiesce_request_failed");
    }
    if (response.status === 429) throw stableError("target_live_quiesce_rate_limited");
    let body;
    try {
      body = await response.json();
    } catch {
      throw stableError("target_live_quiesce_response_invalid");
    }
    if (!response.ok || body?.errors?.length || !body?.data || typeof body.data !== "object") {
      throw stableError("target_live_quiesce_request_failed");
    }
    return body.data;
  };

  const candidates = await request(`query TargetWorkflowListQuiesceCandidates {
    project(id: ${JSON.stringify(projectId)}) {
      id
      issues(first: 250, includeArchived: false) {
        nodes { id description parent { id } project { id } }
        pageInfo { hasNextPage }
      }
    }
  }`, "TargetWorkflowListQuiesceCandidates");
  const connection = candidates.project?.issues;
  if (candidates.project?.id !== projectId || !Array.isArray(connection?.nodes) ||
      connection.pageInfo?.hasNextPage !== false) {
    throw stableError("target_live_quiesce_scope_invalid");
  }
  const matches = connection.nodes.flatMap((issue) => {
    const marker = typeof issue?.description === "string" ? issue.description.match(E2E_MARKER) : undefined;
    return SAFE_ID.test(issue?.id ?? "") && issue.project?.id === projectId && issue.parent === null &&
      marker && digestIdentifier(marker[1]) === runDigest
      ? [{ issueId: issue.id }]
      : [];
  });
  if (matches.length === 0) throw stableError("target_live_quiesce_root_not_found");
  if (matches.length > 1) throw stableError("target_live_quiesce_root_ambiguous");
  const target = matches[0];

  const readRoot = async () => {
    const data = await request(`query TargetWorkflowReadQuiesceRoot {
      issue(id: ${JSON.stringify(target.issueId)}) {
        id description parent { id } project { id } state { type name }
        team { states(first: 64, includeArchived: false) {
          nodes { id name type }
          pageInfo { hasNextPage }
        } }
      }
    }`, "TargetWorkflowReadQuiesceRoot");
    const issue = data.issue;
    const marker = typeof issue?.description === "string" ? issue.description.match(E2E_MARKER) : undefined;
    if (issue?.id !== target.issueId || issue.project?.id !== projectId || issue.parent !== null ||
        !marker || digestIdentifier(marker[1]) !== runDigest ||
        !issue.state || typeof issue.state.type !== "string" || typeof issue.state.name !== "string") {
      throw stableError("target_live_quiesce_scope_changed");
    }
    return issue;
  };
  const before = await readRoot();
  if (TERMINAL_ROOT_TYPES.has(before.state.type)) throw stableError("target_live_quiesce_root_terminal");
  const states = before.team?.states;
  if (!Array.isArray(states?.nodes) || states.pageInfo?.hasNextPage !== false) {
    throw stableError("target_live_quiesce_state_catalog_invalid");
  }
  const canceledStates = states.nodes.filter((state) => state?.name === "Canceled" && state?.type === "canceled");
  if (canceledStates.length !== 1 || !SAFE_ID.test(canceledStates[0]?.id ?? "")) {
    throw stableError("target_live_quiesce_state_invalid");
  }
  const mutation = await request(`mutation TargetWorkflowQuiesceRoot {
    issueUpdate(id: ${JSON.stringify(target.issueId)}, input: { stateId: ${JSON.stringify(canceledStates[0].id)} }) {
      success
    }
  }`, "TargetWorkflowQuiesceRoot");
  if (mutation.issueUpdate?.success !== true) throw stableError("target_live_quiesce_mutation_failed");
  const after = await readRoot();
  if (after.state.type !== "canceled" || after.state.name !== "Canceled") {
    throw stableError("target_live_quiesce_read_back_failed");
  }
  return Object.freeze({
    status: "quiesced",
    rootDigest: digestIdentifier(target.issueId),
    runDigest,
    state: "Canceled",
  });
}

async function resolveProjectId({ developmentToken, projectSlugId, fetch }) {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { authorization: developmentToken, "content-type": "application/json" },
    body: JSON.stringify({
      operationName: "TargetWorkflowResolveProject",
      query: `query TargetWorkflowResolveProject($projectSlugId: String!) {
        project(id: $projectSlugId) { id }
      }`,
      variables: { projectSlugId },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw stableError("target_live_cleanup_project_failed");
  const body = await response.json();
  const projectId = body?.data?.project?.id;
  if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(projectId)) {
    throw stableError("target_live_cleanup_project_invalid");
  }
  return projectId;
}

function stableReason(error) {
  return typeof error?.message === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(error.message)
    ? error.message
    : "target_live_cleanup_failed";
}

function digestIdentifier(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
