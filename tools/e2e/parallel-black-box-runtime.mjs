import { access, constants } from "node:fs/promises";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createChildEnvironment } from "./config.mjs";
import {
  assertParallelBlackBoxE2ECampaignCommand,
  createMandatoryParallelBlackBoxCases,
} from "./parallel-black-box-contract.mjs";
import { provisionParallelBlackBoxE2EControlPlane } from "./parallel-black-box-control-plane.mjs";
import { createRequiredWriteOutageController } from "./required-write-outage.mjs";

export const PARALLEL_BLACK_BOX_CAMPAIGN_DEADLINE_MS = 300_000;

const CONDUCTOR_SHORT_HASH = /^[a-f0-9]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const TARGET_TRIPLE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/u;
const CONTROL_PLANE_FAILURE_CODES = new Set([
  "parallel_black_box_control_plane_binding_provision_failed",
  "parallel_black_box_control_plane_binding_project_invalid",
  "parallel_black_box_control_plane_binding_project_pool_routing_conflict",
  "parallel_black_box_control_plane_conductor_start_failed",
  "parallel_black_box_control_plane_profile_activate_failed",
  "parallel_black_box_control_plane_profile_create_failed",
  "parallel_black_box_control_plane_profile_not_ready",
  "parallel_black_box_control_plane_profile_provision_failed",
  "parallel_black_box_control_plane_profile_set_api_key_failed",
  "parallel_black_box_control_plane_profile_status_failed",
]);

export async function createConfiguredParallelBlackBoxRuntime({
  config,
  sourceRepositoryRoot = process.cwd(),
  environment = process.env,
  deadlineMs = PARALLEL_BLACK_BOX_CAMPAIGN_DEADLINE_MS,
  now = () => new Date(),
  createCampaignId = () => `campaign-${randomUUID()}`,
  makeTemporaryDirectory = (prefix) => mkdtemp(prefix),
  makeDirectory = (directory) => mkdir(directory, { recursive: true }),
  checkExecutable = (executable) => access(executable, constants.X_OK),
  removeTemporaryDirectory = (directory) => rm(directory, { recursive: true, force: true }),
  resolveTargetTriple = targetTripleFromEnvironment,
  provisionControlPlane = provisionParallelBlackBoxE2EControlPlane,
} = {}) {
  assertInput({
    config,
    sourceRepositoryRoot,
    environment,
    deadlineMs,
    now,
    createCampaignId,
    makeTemporaryDirectory,
    makeDirectory,
    checkExecutable,
    removeTemporaryDirectory,
    resolveTargetTriple,
    provisionControlPlane,
  });

  const startedAt = timestamp(now());
  const deadlineAt = timestamp(new Date(Date.parse(startedAt) + deadlineMs));
  const targetTriple = await resolveTargetTriple({ environment });
  if (!TARGET_TRIPLE.test(targetTriple)) throw stableError("parallel_black_box_runtime_target_invalid");
  const performerExecutable = path.join(
    sourceRepositoryRoot,
    "apps/podium-desktop/src-tauri/binaries",
    `performer-${targetTriple}`,
  );
  try {
    await checkExecutable(performerExecutable);
  } catch {
    throw stableError("parallel_black_box_runtime_performer_unavailable");
  }

  let temporaryDirectory;
  let controlPlane;
  try {
    temporaryDirectory = await makeTemporaryDirectory(path.join(os.tmpdir(), "symphony-parallel-black-box-"));
    if (!directory(temporaryDirectory)) throw stableError("parallel_black_box_runtime_temporary_directory_invalid");
    const conductorDataRoot = path.join(temporaryDirectory, "conductors");
    await makeDirectory(conductorDataRoot);
    const requiredWriteOutage = createRequiredWriteOutageController();
    const runtime = Object.freeze({
      databasePath: path.join(temporaryDirectory, "podium.db"),
      conductorDataRoot,
      performerExecutable,
      rootDeadlineAt: deadlineAt,
      convergencePolicy: convergencePolicy(),
      environment: createChildEnvironment({ environment }),
      linearPhysicalRequestGate: requiredWriteOutage,
    });
    controlPlane = await provisionControlPlane({ config, runtime, sourceRepositoryRoot });
    assertControlPlane(controlPlane);
    const command = assertParallelBlackBoxE2ECampaignCommand({
      version: 1,
      campaign_id: createCampaignId(),
      project_id: controlPlane.project_id,
      started_at: startedAt,
      deadline_at: deadlineAt,
      conductors: controlPlane.conductors,
      cases: createMandatoryParallelBlackBoxCases({
        conductor_ids: controlPlane.conductors.map(({ conductor_id: conductorId }) => conductorId),
        deadline_at: deadlineAt,
      }),
    });
    let closed = false;
    return Object.freeze({
      command,
      control_plane: controlPlane,
      required_write_outage: requiredWriteOutage,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await controlPlane.close();
        } finally {
          await removeTemporaryDirectory(temporaryDirectory);
        }
      },
    });
  } catch (error) {
    try {
      await controlPlane?.close?.();
    } catch {
      // The setup failure remains authoritative; cleanup still must run.
    } finally {
      if (temporaryDirectory !== undefined) await removeTemporaryDirectory(temporaryDirectory);
    }
    if (error?.code?.startsWith("parallel_black_box_runtime_")) throw error;
    if (CONTROL_PLANE_FAILURE_CODES.has(error?.code)) throw stableError(error.code);
    throw stableError("parallel_black_box_runtime_control_plane_failed");
  }
}

function assertInput({
  config,
  sourceRepositoryRoot,
  environment,
  deadlineMs,
  now,
  createCampaignId,
  makeTemporaryDirectory,
  makeDirectory,
  checkExecutable,
  removeTemporaryDirectory,
  resolveTargetTriple,
  provisionControlPlane,
}) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      typeof sourceRepositoryRoot !== "string" || sourceRepositoryRoot.length === 0 ||
      !environment || typeof environment !== "object" || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 ||
      typeof now !== "function" || typeof createCampaignId !== "function" ||
      typeof makeTemporaryDirectory !== "function" || typeof makeDirectory !== "function" ||
      typeof checkExecutable !== "function" || typeof removeTemporaryDirectory !== "function" ||
      typeof resolveTargetTriple !== "function" ||
      typeof provisionControlPlane !== "function") {
    throw stableError("parallel_black_box_runtime_input_invalid");
  }
}

function assertControlPlane(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !identifier(value.project_id) ||
      !Array.isArray(value.conductors) || value.conductors.length < 3 || typeof value.close !== "function" ||
      new Set(value.conductors.map(({ conductor_id: conductorId }) => conductorId)).size !== value.conductors.length ||
      !value.conductors.every(validConductor)) {
    throw stableError("parallel_black_box_runtime_control_plane_invalid");
  }
}

function validConductor(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    identifier(value.binding_id) && identifier(value.conductor_id) &&
    CONDUCTOR_SHORT_HASH.test(value.conductor_short_hash) && identifier(value.repository_identity);
}

function convergencePolicy() {
  return Object.freeze({
    maxCyclesPerRoot: 3,
    maxSameOpenFindingCycles: 2,
    maxConsecutiveNoProgress: 3,
    maxTotalTokens: 1_000_000,
    maxCycleRepairAttempts: 0,
  });
}

function targetTripleFromEnvironment({ environment }) {
  const configuredTarget = environment.TAURI_ENV_TARGET_TRIPLE;
  if (configuredTarget !== undefined) return configuredTarget;
  try {
    const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    return output.split("\n").find((line) => line.startsWith("host: "))?.slice("host: ".length);
  } catch {
    throw stableError("parallel_black_box_runtime_target_unavailable");
  }
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw stableError("parallel_black_box_runtime_clock_invalid");
  return date.toISOString();
}

function directory(value) {
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
