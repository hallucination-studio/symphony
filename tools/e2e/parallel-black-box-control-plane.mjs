import { randomBytes } from "node:crypto";

import {
  provisionApiKeyProfiles,
  provisionConductorBindings,
  startConductorProcesses,
} from "./podium-control-plane.mjs";
import { createPublicE2EPodiumClient } from "./podium-client-owner.mjs";
import { createE2EProcessHost } from "./podium-process-host.mjs";
import { createProductionE2EProcessStarter } from "./podium-production-starter.mjs";
import { provisionParallelE2ERepositories } from "./parallel-repository-pool.mjs";

const CONDUCTOR_SHORT_HASH = /^[a-f0-9]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const E2E_LINEAR_REDIRECT_URI = "http://127.0.0.1/e2e";

export async function provisionParallelBlackBoxE2EControlPlane({
  config,
  runtime,
  sourceRepositoryRoot,
  podium: suppliedPodium,
  provisionRepositories = provisionParallelE2ERepositories,
  createProcessHost = createE2EProcessHost,
  createProcessStarter = createProductionE2EProcessStarter,
  createPodiumClient = createPublicE2EPodiumClient,
  createSetupShortHash = () => randomBytes(6).toString("hex"),
}) {
  assertInput({ config, runtime, sourceRepositoryRoot, provisionRepositories, createProcessHost, createProcessStarter, createPodiumClient, createSetupShortHash });
  const repositoryOwner = await provisionRepositories({ sourceRepositoryRoot });
  if (!repositoryOwner || !validRepositories(repositoryOwner.repositories) || typeof repositoryOwner.close !== "function") {
    await repositoryOwner?.close?.();
    throw stableError("parallel_black_box_control_plane_repositories_invalid");
  }
  try {
    const controlPlane = await provisionWithRepositories({
      config,
      runtime,
      repositories: repositoryOwner.repositories,
      suppliedPodium,
      createProcessHost,
      createProcessStarter,
      createPodiumClient,
      createSetupShortHash,
    });
    let closed = false;
    return Object.freeze({
      project_id: controlPlane.project_id,
      conductors: controlPlane.conductors,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await controlPlane.close();
        } finally {
          await repositoryOwner.close();
        }
      },
    });
  } catch (error) {
    await repositoryOwner.close();
    throw error;
  }
}

async function provisionWithRepositories({
  config,
  runtime,
  repositories,
  suppliedPodium,
  createProcessHost,
  createProcessStarter,
  createPodiumClient,
  createSetupShortHash,
}) {
  const podium = suppliedPodium ?? await import("@symphony/podium");
  if (typeof podium?.createTargetWorkflowSetup !== "function" ||
      typeof podium?.bootstrapDevelopmentTokenInstallation !== "function") {
    throw stableError("parallel_black_box_control_plane_podium_invalid");
  }

  const temporarySetupShortHash = createSetupShortHash();
  if (!CONDUCTOR_SHORT_HASH.test(temporarySetupShortHash)) {
    throw stableError("parallel_black_box_control_plane_setup_hash_invalid");
  }
  const setup = podium.createTargetWorkflowSetup();
  if (!setup || typeof setup.initialize !== "function") {
    throw stableError("parallel_black_box_control_plane_setup_invalid");
  }
  const initialSetup = await setup.initialize({
    developmentToken: config.secrets.linearDevToken,
    clientId: config.linear.clientId,
    projectSlugId: config.linear.projectSlugId,
    conductorShortHash: temporarySetupShortHash,
    authorized: true,
  });
  const initialProject = readyProject(initialSetup, "parallel_black_box_control_plane_initial_setup_invalid");
  const installation = await podium.bootstrapDevelopmentTokenInstallation({
    databasePath: runtime.databasePath,
    developmentToken: config.secrets.linearDevToken,
    delegateActorId: initialSetup.delegateActorId,
    targetProject: initialProject,
  });
  if (!installation || installation.organizationId !== initialSetup.organizationId) {
    throw stableError("parallel_black_box_control_plane_installation_invalid");
  }

  const processHost = createProcessHost({
    repositories,
    startProcess: createProcessStarter({
      databasePath: runtime.databasePath,
      conductorDataRoot: runtime.conductorDataRoot,
      performerExecutable: runtime.performerExecutable,
      codexBaseUrl: config.codex.baseUrl,
      rootDeadlineAt: runtime.rootDeadlineAt,
      convergencePolicy: runtime.convergencePolicy,
      environment: runtime.environment,
    }),
  });
  if (!processHost || !processHost.host || typeof processHost.close !== "function") {
    throw stableError("parallel_black_box_control_plane_process_host_invalid");
  }
  let client;
  try {
    client = await createPodiumClient({
      databasePath: runtime.databasePath,
      linearClientId: config.linear.clientId,
      linearClientSecret: config.secrets.linearClientSecret,
      linearRedirectUri: E2E_LINEAR_REDIRECT_URI,
      processHost,
    });
    if (!client || typeof client.command !== "function" || typeof client.close !== "function") {
      throw stableError("parallel_black_box_control_plane_client_invalid");
    }
    const conductors = await provisionConductorBindings({
      client,
      projectId: initialProject.projectId,
      repositories,
    });
    const conductorShortHashes = conductors.map(({ conductor_short_hash }) => conductor_short_hash);
    if (conductorShortHashes.some((hash) => !CONDUCTOR_SHORT_HASH.test(hash))) {
      throw stableError("parallel_black_box_control_plane_binding_hash_invalid");
    }
    if (conductorShortHashes.includes(temporarySetupShortHash)) {
      throw stableError("parallel_black_box_control_plane_setup_hash_collision");
    }
    const finalSetup = await setup.initialize({
      developmentToken: config.secrets.linearDevToken,
      clientId: config.linear.clientId,
      projectSlugId: config.linear.projectSlugId,
      conductorShortHash: conductorShortHashes[0],
      conductorShortHashes,
      authorized: true,
    });
    if (!sameReadyProject(finalSetup, initialProject) || !sameMembers(finalSetup.projectPool?.members, conductorShortHashes)) {
      throw stableError("parallel_black_box_control_plane_pool_read_back_invalid");
    }

    await startConductorProcesses({ client, conductors });
    const apiKey = Buffer.from(config.secrets.codexApiKey, "utf8");
    try {
      await provisionApiKeyProfiles({
        client,
        conductors,
        model: config.codex.model,
        apiKey,
      });
    } finally {
      apiKey.fill(0);
    }

    let closed = false;
    return Object.freeze({
      project_id: initialProject.projectId,
      conductors,
      async close() {
        if (closed) return;
        closed = true;
        await client.close();
      },
    });
  } catch (error) {
    if (typeof client?.close === "function") await client.close();
    else await processHost.close();
    throw error;
  }
}

function assertInput({
  config,
  runtime,
  sourceRepositoryRoot,
  provisionRepositories,
  createProcessHost,
  createProcessStarter,
  createPodiumClient,
  createSetupShortHash,
}) {
  if (!config || typeof config !== "object" || !runtime || typeof runtime !== "object" ||
      typeof sourceRepositoryRoot !== "string" || sourceRepositoryRoot.length === 0 ||
      typeof provisionRepositories !== "function" ||
      typeof createProcessHost !== "function" || typeof createProcessStarter !== "function" ||
      typeof createPodiumClient !== "function" || typeof createSetupShortHash !== "function" ||
      config.linear?.setupAuthorized !== true || !identifier(config.linear?.clientId) ||
      !identifier(config.linear?.projectSlugId) || !secret(config.secrets?.linearDevToken) ||
      !secret(config.secrets?.linearClientSecret) || !secret(config.secrets?.codexApiKey) ||
      !validUrl(config.codex?.baseUrl) || !secret(config.codex?.model) ||
      !pathValue(runtime.databasePath) || !pathValue(runtime.conductorDataRoot) ||
      !pathValue(runtime.performerExecutable) || !validTimestamp(runtime.rootDeadlineAt) ||
      !convergencePolicy(runtime.convergencePolicy) ||
      !runtime.environment || typeof runtime.environment !== "object") {
    throw stableError("parallel_black_box_control_plane_input_invalid");
  }
}

function convergencePolicy(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    positiveInteger(value.maxCyclesPerRoot) && positiveInteger(value.maxSameOpenFindingCycles) &&
    positiveInteger(value.maxConsecutiveNoProgress) && positiveInteger(value.maxTotalTokens) &&
    nonNegativeInteger(value.maxCycleRepairAttempts);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

function validRepositories(repositories) {
  if (!Array.isArray(repositories) || repositories.length < 3) return false;
  const handles = new Set();
  const identities = new Set();
  for (const repository of repositories) {
    if (!repository || typeof repository !== "object" || Array.isArray(repository) ||
        !identifier(repository.repository_handle) || !identifier(repository.repository_identity) ||
        typeof repository.repository_display_name !== "string" || repository.repository_display_name.length === 0 ||
        !pathValue(repository.repository_root) || typeof repository.base_branch !== "string" ||
        repository.base_branch.length === 0 || handles.has(repository.repository_handle) ||
        identities.has(repository.repository_identity)) {
      return false;
    }
    handles.add(repository.repository_handle);
    identities.add(repository.repository_identity);
  }
  return true;
}

function readyProject(value, code) {
  if (!value || typeof value !== "object" || value.kind !== "ready" || !identifier(value.organizationId) ||
      !identifier(value.delegateActorId) || !project(value.project)) {
    throw stableError(code);
  }
  return Object.freeze({
    projectId: value.project.projectId,
    name: value.project.name,
    updatedAt: value.project.updatedAt,
  });
}

function sameReadyProject(value, expectedProject) {
  return value && typeof value === "object" && value.kind === "ready" && project(value.project) &&
    value.project.projectId === expectedProject.projectId;
}

function sameMembers(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    new Set(actual).size === actual.length && actual.every((member) => CONDUCTOR_SHORT_HASH.test(member)) &&
    actual.every((member) => expected.includes(member));
}

function project(value) {
  return value && typeof value === "object" && identifier(value.projectId) &&
    typeof value.name === "string" && value.name.length > 0 && value.name.length <= 512 &&
    validTimestamp(value.updatedAt);
}

function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function validUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function pathValue(value) {
  return typeof value === "string" && value.length > 0;
}

function secret(value) {
  return typeof value === "string" && value.length > 0;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
