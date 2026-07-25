import { randomUUID } from "node:crypto";
import path from "node:path";

import { createChildEnvironment } from "./config.mjs";
import {
  createProductionPodiumConductorOwner,
  startConductorHarness,
} from "./conductor-harness.mjs";

export function createProductionE2EProcessStarter(input, dependencies = {}) {
  assertRuntime(input);
  const createPodiumOwner = dependencies.createPodiumOwner ?? createProductionPodiumConductorOwner;
  const startHarness = dependencies.startHarness ?? startConductorHarness;
  const createInstanceId = dependencies.createInstanceId ?? randomUUID;
  return async function startProcess(conductor) {
    const instanceId = createInstanceId();
    if (!identifier(instanceId)) throw stableError("e2e_conductor_instance_invalid");
    const podium = await createPodiumOwner({
      databasePath: input.databasePath,
      log: input.log,
    });
    try {
      return await startHarness({
        podium,
        environment: createChildEnvironment({
          environment: input.environment,
          additions: {
            SYMPHONY_PRIVATE_IPC_FD: "3",
            SYMPHONY_INSTANCE_ID: instanceId,
            SYMPHONY_BINDING_ID: conductor.bindingId,
            SYMPHONY_CONDUCTOR_ID: conductor.conductorId,
            SYMPHONY_CONDUCTOR_SHORT_HASH: conductor.conductorShortHash,
            SYMPHONY_LINEAR_INSTALLATION_ID: conductor.linearInstallationId,
            SYMPHONY_ORGANIZATION_ID: conductor.organizationId,
            SYMPHONY_REPOSITORY_HANDLE: conductor.repositoryHandle,
            SYMPHONY_REPOSITORY_ROOT: conductor.repositoryRoot,
            SYMPHONY_BASE_BRANCH: conductor.baseBranch,
            SYMPHONY_CONDUCTOR_DATA_ROOT: path.join(input.conductorDataRoot, conductor.conductorId),
            SYMPHONY_PERFORMER_EXECUTABLE: input.performerExecutable,
            SYMPHONY_CODEX_BASE_URL: input.codexBaseUrl,
            SYMPHONY_ROOT_DEADLINE_AT: input.rootDeadlineAt,
            SYMPHONY_CYCLE_DELAY_MS: "250",
          },
        }),
        log: input.log,
      });
    } catch (error) {
      await podium.close();
      throw error;
    }
  };
}

function assertRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.databasePath !== "string" || value.databasePath.length === 0 ||
      typeof value.conductorDataRoot !== "string" || value.conductorDataRoot.length === 0 ||
      typeof value.performerExecutable !== "string" || value.performerExecutable.length === 0 ||
      !validUrl(value.codexBaseUrl) || !timestamp(value.rootDeadlineAt) ||
      !value.environment || typeof value.environment !== "object") {
    throw stableError("e2e_production_starter_input_invalid");
  }
}

function validUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
