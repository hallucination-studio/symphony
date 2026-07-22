import { createHash, randomUUID } from "node:crypto";

import {
  LinearSdkImpl,
  type LinearPhysicalRequestObservation,
} from "../internal/linear-gateway/internal/LinearSdkImpl.js";
import type { TargetWorkflowProjectConfiguration } from "../internal/linear-gateway/api/LinearClientInterface.js";
import type { LinearRunBudgetImpl } from "../internal/linear-gateway/internal/LinearRunBudgetImpl.js";
import type {
  TargetWorkflowSetupInterface,
  TargetWorkflowSetupResult,
} from "./TargetWorkflowSetupInterface.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const CONDUCTOR_SHORT_HASH = /^[a-f0-9]{12}$/u;
const CONDUCTOR_LABEL_PREFIX = "symphony:conductor/";

export function createTargetWorkflowSetup(input: {
  observeLinearRequest?: (observation: LinearPhysicalRequestObservation) => void;
  linearRunBudget?: LinearRunBudgetImpl;
} = {}): TargetWorkflowSetupInterface {
  return {
    initialize: (setupInput) => runWithFetch(
      setupInput.fetch,
      () => initializeTargetWorkflowSetup(setupInput, input.observeLinearRequest, input.linearRunBudget),
    ),
  };
}

async function initializeTargetWorkflowSetup(
  input: Parameters<TargetWorkflowSetupInterface["initialize"]>[0],
  observeLinearRequest?: (observation: LinearPhysicalRequestObservation) => void,
  linearRunBudget?: LinearRunBudgetImpl,
): Promise<TargetWorkflowSetupResult> {
  validateInput(input);
  const organizationId = await LinearSdkImpl.discoverDevelopmentTokenOrganizationId(
    input.developmentToken,
    observeLinearRequest,
    linearRunBudget ? () => linearRunBudget.permitPhysicalRequest() : undefined,
  );
  const createSdk = (delegateActorId: string) => new LinearSdkImpl(
    { kind: "development_token", token: input.developmentToken, delegateActorId },
    organizationId,
    undefined,
    observeLinearRequest
      ? {
          correlationId: randomUUID,
          now: Date.now,
          observe: observeLinearRequest,
          ...(linearRunBudget ? { permit: () => linearRunBudget.permitPhysicalRequest() } : {}),
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
  const labelName = `${CONDUCTOR_LABEL_PREFIX}${input.conductorShortHash}`;
  const labelPlan = await sdk.preflightConductorProjectLabel({
    projectId: initial.project.projectId,
    labelName,
  });
  if (labelPlan.kind !== "ready") throw new Error(`linear_target_setup_${labelPlan.reason}`);
  const projectLabel = await sdk.rebindConductorProjectLabel({
    plan: labelPlan,
    authorized: input.authorized,
  });
  if (!input.authorized) {
    if (workflow.kind !== "dry_run" || projectLabel.kind !== "dry_run") {
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
      projectLabel: "dry_run",
      identityDigest: setupIdentityDigest({
        organizationId,
        projectId: initial.project.projectId,
        teamId: initial.teamId,
        labelName,
      }),
    });
  }
  if (workflow.kind === "dry_run" || projectLabel.kind === "dry_run") {
    throw new Error("linear_target_setup_authorization_invalid");
  }
  const final = await sdk.readTargetProjectConfiguration({
    clientId: input.clientId,
    projectSlugId: input.projectSlugId,
  });
  if (!final.todoStateId || final.teamId !== initial.teamId || final.project.projectId !== initial.project.projectId) {
    throw new Error("linear_target_setup_workflow_read_back_failed");
  }
  const resolution = await sdk.readProjectResolution({
    conductorShortHash: input.conductorShortHash,
  });
  if (resolution.kind !== "resolved" || resolution.projectId !== final.project.projectId ||
      resolution.updatedAt !== final.project.updatedAt) {
    throw new Error("linear_target_setup_project_resolution_failed");
  }
  return Object.freeze({
    kind: "ready",
    organizationId,
    delegateActorId: final.delegateActorId,
    project: projectValue(final),
    teamId: final.teamId,
    todoStateId: final.todoStateId,
    workflow: workflow.kind,
    projectLabel: projectLabel.kind,
    resolution,
    identityDigest: setupIdentityDigest({
      organizationId,
      projectId: final.project.projectId,
      teamId: final.teamId,
      labelName,
    }),
  });
}

function validateInput(input: Parameters<TargetWorkflowSetupInterface["initialize"]>[0]): void {
  if (typeof input.developmentToken !== "string" || input.developmentToken.length === 0 ||
      !SAFE_ID.test(input.clientId) || !SAFE_ID.test(input.projectSlugId) ||
      !CONDUCTOR_SHORT_HASH.test(input.conductorShortHash) ||
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
  labelName: string;
}): string {
  return createHash("sha256")
    .update(`${input.organizationId}\n${input.projectId}\n${input.teamId}\n${input.labelName}`)
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
