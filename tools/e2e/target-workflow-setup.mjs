import { createHash as createSha256 } from "node:crypto";

import { createTargetWorkflowSetup } from "@symphony/podium";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function prepareTargetWorkflowSetup({
  config,
  runId,
  fetch = globalThis.fetch,
  log = () => {},
  setup = createTargetWorkflowSetup(),
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
      !SAFE_ID.test(result.organizationId ?? "") || !SAFE_ID.test(result.delegateActorId ?? "") ||
      !SAFE_ID.test(result.project?.projectId ?? "") || !SAFE_ID.test(result.teamId ?? "") ||
      typeof result.identityDigest !== "string" || !/^[a-f0-9]{16}$/u.test(result.identityDigest)) {
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
      title: "Target live success",
      description: "Target live success Root.",
    }),
  });
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
