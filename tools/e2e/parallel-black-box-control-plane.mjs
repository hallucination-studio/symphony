import {
  provisionApiKeyProfiles,
  provisionConductorBindings,
  startConductorProcesses,
  stopConductorProcesses,
} from "./podium-control-plane.mjs";
import { createPublicE2EPodiumClient } from "./podium-client-owner.mjs";
import { createE2EProcessHost } from "./podium-process-host.mjs";
import { createProductionE2EProcessStarter } from "./podium-production-starter.mjs";
import { provisionParallelE2ERepositories } from "./parallel-repository-pool.mjs";

const CONDUCTOR_SHORT_HASH = /^[a-f0-9]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const E2E_LINEAR_REDIRECT_URI = "http://127.0.0.1/e2e";
const CONTROL_PLANE_PODIUM_FAILURES = new Map([
  [
    "e2e_podium_client_conductor_project_invalid",
    "parallel_black_box_control_plane_binding_project_invalid",
  ],
  [
    "e2e_podium_client_linear_project_pool_root_routing_conflict",
    "parallel_black_box_control_plane_binding_project_pool_routing_conflict",
  ],
  [
    "e2e_podium_client_linear_project_label_create_failed",
    "parallel_black_box_control_plane_binding_project_label_failed",
  ],
  [
    "e2e_podium_client_linear_project_label_ambiguous",
    "parallel_black_box_control_plane_binding_project_label_failed",
  ],
  [
    "e2e_podium_client_linear_label_organization_mismatch",
    "parallel_black_box_control_plane_binding_label_organization_mismatch",
  ],
  [
    "e2e_podium_client_linear_issue_label_create_failed",
    "parallel_black_box_control_plane_binding_issue_label_failed",
  ],
  [
    "e2e_podium_client_linear_issue_label_ambiguous",
    "parallel_black_box_control_plane_binding_issue_label_failed",
  ],
]);
const PROFILE_PROVISION_FAILURES = new Map([
  ["e2e_podium_profile_create_request_failed", "parallel_black_box_control_plane_profile_create_failed"],
  ["e2e_podium_profile_create_invalid", "parallel_black_box_control_plane_profile_create_failed"],
  ["e2e_podium_profile_set_api_key_request_failed", "parallel_black_box_control_plane_profile_set_api_key_failed"],
  ["e2e_podium_profile_secret_invalid", "parallel_black_box_control_plane_profile_set_api_key_failed"],
  ["e2e_podium_profile_status_request_failed", "parallel_black_box_control_plane_profile_status_failed"],
  ["e2e_podium_profile_status_invalid", "parallel_black_box_control_plane_profile_status_failed"],
  ["e2e_podium_profile_not_ready", "parallel_black_box_control_plane_profile_not_ready"],
  ["e2e_podium_profile_activate_request_failed", "parallel_black_box_control_plane_profile_activate_failed"],
  ["e2e_podium_profile_activate_invalid", "parallel_black_box_control_plane_profile_activate_failed"],
]);

export async function provisionParallelBlackBoxE2EControlPlane({
  config,
  runtime,
  sourceRepositoryRoot,
  podium: suppliedPodium,
  provisionRepositories = provisionParallelE2ERepositories,
  createProcessHost = createE2EProcessHost,
  createProcessStarter = createProductionE2EProcessStarter,
  createPodiumClient = createPublicE2EPodiumClient,
}) {
  assertInput({ config, runtime, sourceRepositoryRoot, provisionRepositories, createProcessHost, createProcessStarter, createPodiumClient });
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
    });
    let closed = false;
    return Object.freeze({
      project_id: controlPlane.project_id,
      conductors: controlPlane.conductors,
      repository_contexts: repositoryContexts(repositoryOwner.repositories),
      restartConductor: controlPlane.restartConductor,
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
}) {
  const podium = suppliedPodium ?? await import("@symphony/podium");
  if (typeof podium?.createTargetWorkflowSetup !== "function" ||
      typeof podium?.bootstrapDevelopmentTokenInstallation !== "function") {
    throw stableError("parallel_black_box_control_plane_podium_invalid");
  }

  const setup = podium.createTargetWorkflowSetup();
  if (!setup || typeof setup.initialize !== "function") {
    throw stableError("parallel_black_box_control_plane_setup_invalid");
  }
  const initialSetup = await setup.initialize({
    developmentToken: config.secrets.linearDevToken,
    clientId: config.linear.clientId,
    projectSlugId: config.linear.projectSlugId,
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
      linearPhysicalRequestGate: runtime.linearPhysicalRequestGate,
    }),
  });
  if (!processHost || !processHost.host || typeof processHost.close !== "function") {
    throw stableError("parallel_black_box_control_plane_process_host_invalid");
  }
  let client;
  let startedConductors = [];
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
    const conductors = await controlPlaneOperation(
      "parallel_black_box_control_plane_binding_provision_failed",
      () => provisionConductorBindings({
        client,
        projectId: initialProject.projectId,
        repositories,
      }),
    );
    const conductorShortHashes = conductors.map(({ conductor_short_hash }) => conductor_short_hash);
    if (conductorShortHashes.some((hash) => !CONDUCTOR_SHORT_HASH.test(hash))) {
      throw stableError("parallel_black_box_control_plane_binding_hash_invalid");
    }
    const finalSetup = await setup.initialize({
      developmentToken: config.secrets.linearDevToken,
      clientId: config.linear.clientId,
      projectSlugId: config.linear.projectSlugId,
      authorized: true,
    });
    if (!sameReadyProject(finalSetup, initialProject) || !containsMembers(finalSetup.projectPool?.members, conductorShortHashes)) {
      throw stableError("parallel_black_box_control_plane_pool_read_back_invalid");
    }

    await controlPlaneOperation(
      "parallel_black_box_control_plane_conductor_start_failed",
      () => startConductorProcesses({ client, conductors }),
    );
    startedConductors = conductors;
    const apiKey = Buffer.from(config.secrets.codexApiKey, "utf8");
    try {
      await controlPlaneOperation(
        "parallel_black_box_control_plane_profile_provision_failed",
        () => provisionApiKeyProfiles({
          client,
          conductors,
          model: config.codex.model,
          apiKey,
        }),
      );
    } finally {
      apiKey.fill(0);
    }

    let closed = false;
    return Object.freeze({
      project_id: initialProject.projectId,
      conductors,
      async restartConductor(conductorId) {
        if (!identifier(conductorId) || !conductors.some((conductor) => conductor.conductor_id === conductorId)) {
          throw stableError("parallel_black_box_control_plane_restart_invalid");
        }
        if (typeof processHost.host.restartConductor !== "function") {
          throw stableError("parallel_black_box_control_plane_restart_unavailable");
        }
        try {
          await processHost.host.restartConductor(conductorId);
        } catch {
          throw stableError("parallel_black_box_control_plane_restart_failed");
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        let stopFailure;
        try {
          await stopConductorProcesses({ client, conductors: startedConductors });
        } catch {
          stopFailure = stableError("parallel_black_box_control_plane_conductor_stop_failed");
        }
        try {
          await client.close();
        } finally {
          if (stopFailure) throw stopFailure;
        }
      },
    });
  } catch (error) {
    try {
      if (startedConductors.length > 0) await stopConductorProcesses({ client, conductors: startedConductors });
    } catch {
      // The setup failure remains authoritative; host close is still required.
    } finally {
      if (typeof client?.close === "function") await client.close();
      else await processHost.close();
    }
    throw error;
  }
}

async function controlPlaneOperation(code, operation) {
  try {
    return await operation();
  } catch (error) {
    const specificCode = CONTROL_PLANE_PODIUM_FAILURES.get(error?.code);
    if (specificCode !== undefined && code === "parallel_black_box_control_plane_binding_provision_failed") {
      throw stableError(specificCode);
    }
    const profileCode = PROFILE_PROVISION_FAILURES.get(error?.code);
    if (profileCode !== undefined && code === "parallel_black_box_control_plane_profile_provision_failed") {
      throw stableError(profileCode);
    }
    throw stableError(code);
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
}) {
  if (!config || typeof config !== "object" || !runtime || typeof runtime !== "object" ||
      typeof sourceRepositoryRoot !== "string" || sourceRepositoryRoot.length === 0 ||
      typeof provisionRepositories !== "function" ||
      typeof createProcessHost !== "function" || typeof createProcessStarter !== "function" ||
      typeof createPodiumClient !== "function" ||
      config.linear?.setupAuthorized !== true || !identifier(config.linear?.clientId) ||
      !identifier(config.linear?.projectSlugId) || !secret(config.secrets?.linearDevToken) ||
      !secret(config.secrets?.linearClientSecret) || !secret(config.secrets?.codexApiKey) ||
      !validUrl(config.codex?.baseUrl) || !secret(config.codex?.model) ||
      !pathValue(runtime.databasePath) || !pathValue(runtime.conductorDataRoot) ||
      !pathValue(runtime.performerExecutable) || !validTimestamp(runtime.rootDeadlineAt) ||
      !convergencePolicy(runtime.convergencePolicy) ||
      !runtime.environment || typeof runtime.environment !== "object" ||
      runtime.linearPhysicalRequestGate !== undefined &&
      (!runtime.linearPhysicalRequestGate || typeof runtime.linearPhysicalRequestGate.beforePhysicalRequest !== "function")) {
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

function repositoryContexts(repositories) {
  return Object.freeze(repositories.map((repository) => Object.freeze({
    repository_identity: repository.repository_identity,
    repository_root: repository.repository_root,
    base_branch: repository.base_branch,
  })));
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

function containsMembers(actual, expected) {
  return Array.isArray(actual) && new Set(actual).size === actual.length &&
    actual.every((member) => CONDUCTOR_SHORT_HASH.test(member)) &&
    expected.every((member) => actual.includes(member));
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
