import { createHash, randomUUID } from "node:crypto";

import {
  LinearSdkImpl,
  type LinearPhysicalRequestObservation,
} from "../internal/linear-gateway/internal/LinearSdkImpl.js";
import type { TargetWorkflowProjectConfiguration } from "../internal/linear-gateway/api/LinearClientInterface.js";
import type {
  TargetWorkflowSetupInterface,
  TargetWorkflowSetupResult,
} from "./TargetWorkflowSetupInterface.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SETUP_REQUEST_TIMEOUT_MS = 30_000;

export function createTargetWorkflowSetup(input: {
  observeLinearRequest?: (observation: LinearPhysicalRequestObservation) => void;
} = {}): TargetWorkflowSetupInterface {
  return {
    initialize: (setupInput) => runWithFetch(
      setupFetch(setupInput.fetch, setupInput.signal),
      () => initializeTargetWorkflowSetup(setupInput, input.observeLinearRequest),
    ),
  };
}

function setupFetch(
  fetch: typeof globalThis.fetch | undefined,
  signal: AbortSignal | undefined,
): typeof globalThis.fetch | undefined {
  const requestFetch = fetch ?? globalThis.fetch;
  if (!requestFetch) return undefined;
  return (input, init = {}) => requestFetch(input, {
    ...init,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(SETUP_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(SETUP_REQUEST_TIMEOUT_MS),
  });
}

async function initializeTargetWorkflowSetup(
  input: Parameters<TargetWorkflowSetupInterface["initialize"]>[0],
  observeLinearRequest?: (observation: LinearPhysicalRequestObservation) => void,
): Promise<TargetWorkflowSetupResult> {
  validateInput(input);
  const observe = observeLinearRequest;
  const organizationId = await LinearSdkImpl.discoverDevelopmentTokenOrganizationId(
    input.developmentToken,
    observe,
  );
  const createSdk = (delegateActorId: string) => new LinearSdkImpl(
    { kind: "development_token", token: input.developmentToken, delegateActorId },
    organizationId,
    undefined,
    observe
      ? {
          correlationId: randomUUID,
          now: Date.now,
          observe,
        }
      : undefined,
  );
  const sdk = createSdk("setup");
  const initial = await sdk.readTargetProjectConfiguration({
    clientId: input.clientId,
    projectSlugId: input.projectSlugId,
  });
  const workflow = await sdk.initializeTargetTeamWorkflow({
    projectId: initial.project.projectId,
    authorized: input.authorized,
  });
  const initialPool = await sdk.readConductorProjectPool({ projectId: initial.project.projectId });
  if (!input.authorized) {
    if (workflow.kind !== "dry_run") {
      throw new Error("linear_target_setup_dry_run_invalid");
    }
    return Object.freeze({
      kind: "dry_run",
      organizationId,
      delegateActorId: initial.delegateActorId,
      project: projectValue(initial),
      teamId: initial.teamId,
      ...(initial.todoStateId ? { todoStateId: initial.todoStateId } : {}),
      workflow: "dry_run",
      projectPool: { members: initialPool.members },
      identityDigest: setupIdentityDigest({
        organizationId,
        projectId: initial.project.projectId,
        teamId: initial.teamId,
      }),
    });
  }
  if (workflow.kind === "dry_run") {
    throw new Error("linear_target_setup_authorization_invalid");
  }
  const final = await sdk.readTargetProjectConfiguration({
    clientId: input.clientId,
    projectSlugId: input.projectSlugId,
  });
  if (!final.todoStateId || final.teamId !== initial.teamId || final.project.projectId !== initial.project.projectId) {
    throw new Error("linear_target_setup_workflow_read_back_failed");
  }
  const finalPool = await sdk.readConductorProjectPool({ projectId: final.project.projectId });
  return Object.freeze({
    kind: "ready",
    organizationId,
    delegateActorId: final.delegateActorId,
    project: projectValue(final),
    teamId: final.teamId,
    todoStateId: final.todoStateId,
    workflow: workflow.kind,
    projectPool: { members: finalPool.members },
    identityDigest: setupIdentityDigest({
      organizationId,
      projectId: final.project.projectId,
      teamId: final.teamId,
    }),
  });
}

function validateInput(input: Parameters<TargetWorkflowSetupInterface["initialize"]>[0]): void {
  if (typeof input.developmentToken !== "string" || input.developmentToken.length === 0 ||
      !SAFE_ID.test(input.clientId) || !SAFE_ID.test(input.projectSlugId) ||
      typeof input.authorized !== "boolean") {
    throw new Error("linear_target_setup_input_invalid");
  }
}

function projectValue(configuration: TargetWorkflowProjectConfiguration) {
  return Object.freeze({
    projectId: configuration.project.projectId,
    name: configuration.project.name,
    updatedAt: configuration.project.updatedAt,
  });
}

function setupIdentityDigest(input: {
  organizationId: string;
  projectId: string;
  teamId: string;
}): string {
  return createHash("sha256")
    .update(`${input.organizationId}\n${input.projectId}\n${input.teamId}`)
    .digest("hex")
    .slice(0, 16);
}

let fetchQueue = Promise.resolve();

async function runWithFetch<T>(fetch: typeof globalThis.fetch | undefined, operation: () => Promise<T>): Promise<T> {
  if (!fetch || fetch === globalThis.fetch) return operation();
  const previous = fetchQueue;
  let release!: () => void;
  fetchQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = original;
    release();
  }
}
