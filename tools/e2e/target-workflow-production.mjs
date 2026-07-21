import { bootstrapDevelopmentTokenInstallation } from "@symphony/podium";

import { createProductionPodiumConductorOwner, startConductorHarness } from "./conductor-harness.mjs";
import { provisionApiKeyProfile } from "./conductor-profile.mjs";
import { projectTargetWorkflowFacts } from "./target-workflow-facts.mjs";
import { createTargetWorkflowExternalInputs } from "./target-workflow-inputs.mjs";
import { createTargetWorkflowRunner } from "./target-workflow-runner.mjs";
import { createTargetWorkflowSnapshotTransport } from "./target-workflow-transport.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SECRET_ENVIRONMENT_KEYS = new Set([
  "SYMPHONY_E2E_LINEAR_DEV_TOKEN", "SYMPHONY_E2E_CODEX_API_KEY",
]);

export async function startTargetProductionBoundary({
  developmentToken,
  codexApiKey,
  databasePath,
  project,
  binding,
  delegateActorId,
  environment,
  model = "target-model",
  fetch = globalThis.fetch,
  log = () => {},
  dependencies = {},
  createRunner = createTargetWorkflowRunner,
} = {}) {
  validateInput({ developmentToken, codexApiKey, databasePath, project, binding, delegateActorId, environment, model, fetch, log });
  const services = {
    bootstrapInstallation: dependencies.bootstrapInstallation ?? bootstrapDevelopmentTokenInstallation,
    savePodiumState: dependencies.savePodiumState ?? savePodiumState,
    createPodiumOwner: dependencies.createPodiumOwner ?? createProductionPodiumConductorOwner,
    startConductor: dependencies.startConductor ?? startConductorHarness,
    provisionProfile: dependencies.provisionProfile ?? provisionApiKeyProfile,
  };
  let installation;
  let podium;
  let harness;
  let restartCount = 0;
  try {
    installation = validateInstallation(await services.bootstrapInstallation({
      databasePath,
      developmentToken,
      delegateActorId,
      observeLinearRequest: (observation) => log({ event: "linear_physical_request", ...observation }),
    }));
    await services.savePodiumState({ databasePath, installation, project, binding });
    podium = await services.createPodiumOwner({ databasePath, log });
    harness = await services.startConductor({ podium, environment, log });
    const apiKey = new TextEncoder().encode(codexApiKey);
    try {
      await services.provisionProfile({
        harness,
        conductorId: binding.conductorId,
        model,
        apiKey,
        displayName: "Target workflow E2E",
        log,
      });
    } finally {
      apiKey.fill(0);
    }
    const externalInputs = createTargetWorkflowExternalInputs({ developmentToken, fetch, log });
    const snapshotTransport = createTargetWorkflowSnapshotTransport({ developmentToken, fetch, log });
    const runner = createRunner({
      externalInputs,
      snapshotTransport,
      projectFacts: projectTargetWorkflowFacts,
    });
    let closed = false;
    return Object.freeze({
      runner,
      async restart(input) {
        if (closed) throw new Error("target_production_closed");
        validateRestartInput(input);
        const previous = harness;
        const exit = await previous.terminateAbruptly?.();
        if (exit && typeof exit !== "object") throw new Error("target_production_restart_exit_invalid");
        restartCount += 1;
        const instanceId = `${environment.SYMPHONY_INSTANCE_ID ?? binding.bindingId}-restart-${restartCount}`;
        const nextEnvironment = { ...environment, SYMPHONY_INSTANCE_ID: instanceId };
        try {
          harness = await services.startConductor({ podium, environment: nextEnvironment, log });
        } catch (error) {
          await closeQuietly(() => podium.close(), log);
          throw stableError(error);
        }
        return Object.freeze({ restarted: true, instanceId });
      },
      async close() {
        if (closed) return;
        closed = true;
        await harness.close();
      },
    });
  } catch (error) {
    if (harness) {
      await closeQuietly(() => harness.close(), log);
    } else if (podium) {
      await closeQuietly(() => podium.close(), log);
    }
    throw stableError(error);
  }
}

function validateInstallation(value) {
  if (!value || typeof value !== "object" || !SAFE_ID.test(value.installationId ?? "") ||
      !SAFE_ID.test(value.organizationId ?? "")) {
    throw new Error("target_production_installation_invalid");
  }
  return value;
}

async function savePodiumState({ databasePath, installation, project, binding }) {
  const { SqlitePodiumStoreImpl } = await import(
    "../../packages/podium/dist/internal/storage/SqlitePodiumStoreImpl.js"
  );
  const store = new SqlitePodiumStoreImpl(databasePath);
  try {
    store.saveProject({
      projectId: project.projectId,
      installationId: installation.installationId,
      organizationId: installation.organizationId,
      name: project.name,
      updatedAt: project.updatedAt,
    });
    store.saveConductorBinding({
      bindingId: binding.bindingId,
      conductorId: binding.conductorId,
      conductorShortHash: binding.conductorShortHash,
      linearInstallationId: installation.installationId,
      organizationId: installation.organizationId,
      repositoryContext: {
        repositoryHandle: binding.repositoryHandle,
        repositoryIdentity: binding.repositoryHandle,
        repositoryDisplayName: binding.repositoryDisplayName ?? "target-workflow-e2e",
        repositoryRoot: binding.repositoryRoot,
        baseBranch: binding.baseBranch,
      },
      desiredState: "running",
    });
  } finally {
    store.close();
  }
}

function validateInput({ developmentToken, codexApiKey, databasePath, project, binding, delegateActorId, environment, model, fetch, log }) {
  if (typeof developmentToken !== "string" || developmentToken.length === 0 ||
      typeof codexApiKey !== "string" || codexApiKey.length === 0 ||
      typeof databasePath !== "string" || databasePath.length === 0 ||
      typeof delegateActorId !== "string" || !SAFE_ID.test(delegateActorId) ||
      typeof model !== "string" || !SAFE_ID.test(model) || typeof fetch !== "function" || typeof log !== "function") {
    throw new Error("target_production_input_invalid");
  }
  if (!project || !SAFE_ID.test(project.projectId ?? "") || typeof project.name !== "string" ||
      project.name.length === 0 || typeof project.updatedAt !== "string") {
    throw new Error("target_production_project_invalid");
  }
  if (!binding || !SAFE_ID.test(binding.bindingId ?? "") || !SAFE_ID.test(binding.conductorId ?? "") ||
      !SAFE_ID.test(binding.conductorShortHash ?? "") || !SAFE_ID.test(binding.repositoryHandle ?? "") ||
      typeof binding.repositoryRoot !== "string" || binding.repositoryRoot.length === 0 ||
      !SAFE_ID.test(binding.baseBranch ?? "")) {
    throw new Error("target_production_binding_invalid");
  }
  if (!environment || typeof environment !== "object" ||
      [...SECRET_ENVIRONMENT_KEYS].some((key) => environment[key] !== undefined)) {
    throw new Error("target_production_secret_environment_forbidden");
  }
}

function validateRestartInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !SAFE_ID.test(value.rootIssueId ?? "") || !SAFE_ID.test(value.cycleIssueId ?? "") ||
      !SAFE_ID.test(value.nodeIssueId ?? "") || !SAFE_ID.test(value.actionId ?? "") ||
      !/^[0-9a-f]{64}$/u.test(value.contextDigest ?? "")) {
    throw new Error("target_production_restart_input_invalid");
  }
}

async function closeQuietly(action, log) {
  try {
    await action();
  } catch (error) {
    log({ event: "target_production_cleanup_failed", reason: stableError(error).message });
  }
}

function stableError(error) {
  const message = error instanceof Error ? error.message : "target_production_start_failed";
  return new Error(/^[a-z][a-z0-9_]{1,120}$/u.test(message) ? message : "target_production_start_failed");
}
