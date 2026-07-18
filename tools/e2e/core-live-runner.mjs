import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createChildEnvironment, loadE2EConfig } from "./config.mjs";
import { createProductionPodiumConductorOwner, startConductorHarness } from "./conductor-harness.mjs";
import { provisionApiKeyProfile } from "./conductor-profile.mjs";
import { coreLiveStepIds, evaluateCoreLiveEvidence } from "./core-live-verdict.mjs";
import { acquireGlobalLock, lockPathForConfig } from "./global-lock.mjs";
import {
  cleanupRunScope,
  createRunScope,
  createRunScopedGitFixture,
  createRunScopedLinearOperator,
} from "./run-fixtures.mjs";

const execute = promisify(execFile);

export async function runCoreLiveE2E({
  environment = process.env,
  runId = `run-${randomUUID()}`,
  timeoutMs = 30 * 60_000,
  pollIntervalMs = 2_000,
} = {}) {
  const config = loadE2EConfig({ environment });
  const linear = createRunScopedLinearOperator({
    developmentToken: config.secrets.linearDevToken,
  });
  const preflight = await linear.preflight();
  const lockRoot = path.join(os.tmpdir(), "symphony-core-live-global");
  const lock = await acquireGlobalLock(
    { paths: { lock: lockPathForConfig(lockRoot) } },
    { runId },
  );
  let scope;
  let project;
  let fixture;
  let harness;
  const evidence = [];
  const ids = runIdentifiers(runId);
  try {
    scope = await createRunScope({ runId });
    const git = await createRunScopedGitFixture({ runId, parentDirectory: scope.root });
    await linear.reconcileStaleRuns({ lock, currentRunId: runId });
    project = await linear.createProject({
      lock,
      runId,
      conductorShortHash: ids.conductorShortHash,
      preflight,
    });
    evidence.push({ step: "project_created", status: "passed" });

    const databasePath = path.join(scope.appDataRoot, "podium.db");
    const installation = await bootstrapPodiumState({
      databasePath,
      developmentToken: config.secrets.linearDevToken,
      preflight,
      project,
      git,
      ids,
    });
    const podium = await createProductionPodiumConductorOwner({ databasePath });
    harness = await startConductorHarness({
      podium,
      environment: createConductorEnvironment({ environment, config, scope, git, installation, ids }),
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 5_000,
    });
    evidence.push({ step: "conductor_handshake", status: "passed" });

    const apiKey = new TextEncoder().encode(config.secrets.codexApiKey);
    const profile = await provisionApiKeyProfile({
      harness,
      conductorId: ids.conductorId,
      model: config.codex.model,
      apiKey,
    });
    evidence.push({ step: "profile_active", status: "passed" });

    fixture = await linear.createRoot({
      lock,
      runId,
      preflight,
      project,
      rootInstruction: [
        "Create a file named e2e-result.txt at the repository root.",
        `Its content must be exactly ${JSON.stringify(`${runId}\n`)}.`,
        "Make no other changes.",
      ].join(" "),
    });
    evidence.push({ step: "root_created", status: "passed", rootIdentifier: fixture.rootIdentifier });

    const plan = await pollUntil(
      () => linear.readRunState({ fixture }),
      (state) => state.phase === "awaiting-human" &&
        state.approvalState === "In Progress" &&
        state.planApprovalCount === 1 &&
        state.treeMatches === true &&
        state.workStates.length > 0 &&
        state.workStates.every((workState) => ["Todo", "Canceled"].includes(workState)) &&
        Boolean(state.performerId),
      { timeoutMs, pollIntervalMs, code: "e2e_plan_timeout" },
    );
    evidence.push({ step: "plan_ready", status: "passed" });
    await linear.approvePlan({
      lock,
      runId,
      fixture,
      preflight,
      approvalId: plan.approvalId,
    });
    evidence.push({ step: "plan_approved", status: "passed" });

    const completed = await pollUntil(
      () => linear.readRunState({ fixture }),
      (state) => state.rootState === "In Review" && state.phase === "in-review" && Boolean(state.deliveryBranch),
      { timeoutMs, pollIntervalMs, code: "e2e_root_completion_timeout" },
    );
    if (completed.performerId !== plan.performerId) throw stableError("e2e_performer_resume_mismatch");
    if (completed.reworkCount !== 0 || completed.workStates.some((state) => state !== "Done")) {
      throw stableError("e2e_workflow_incomplete");
    }
    const delivered = await readDeliveredMarker(git.repositoryRoot, completed.deliveryBranch);
    if (delivered !== `${runId}\n`) throw stableError("e2e_delivery_marker_mismatch");
    evidence.push(
      { step: "work_completed", status: "passed" },
      { step: "root_gate_passed", status: "passed" },
      { step: "branch_delivered", status: "passed", branch: completed.deliveryBranch },
      { step: "linear_in_review", status: "passed" },
    );

    const result = Object.freeze({
      status: "passed",
      runId,
      rootIdentifier: fixture.rootIdentifier,
      profileId: profile.profileId,
      performerResumed: true,
      rootState: completed.rootState,
      phase: completed.phase,
      deliveryBranch: completed.deliveryBranch,
      evidence,
    });
    if (evaluateCoreLiveEvidence(result).verdict !== "passed") {
      throw stableError("e2e_evidence_verdict_failed");
    }
    await writeEvidence(runId, result, config.secrets);
    return result;
  } catch (error) {
    const result = { status: "failed", runId, reason: sanitize(error), evidence };
    await writeEvidence(runId, result, config.secrets).catch(() => {});
    throw stableError(result.reason);
  } finally {
    await harness?.close().catch(() => {});
    if (project) await linear.cleanup({ lock, runId, projectId: project.projectId, marker: project.marker }).catch(() => {});
    if (scope) await cleanupRunScope(scope).catch(() => {});
    await lock.release().catch(() => {});
  }
}

async function bootstrapPodiumState({ databasePath, developmentToken, preflight, project, git, ids }) {
  const { bootstrapDevelopmentTokenInstallation } = await import("@symphony/podium");
  const installation = await bootstrapDevelopmentTokenInstallation({ databasePath, developmentToken });
  if (installation.organizationId !== preflight.organizationId) {
    throw stableError("e2e_linear_organization_mismatch");
  }
  const { SqlitePodiumStoreImpl } = await import(
    "../../packages/podium/dist/internal/storage/SqlitePodiumStoreImpl.js"
  );
  const store = new SqlitePodiumStoreImpl(databasePath);
  try {
    store.saveProject({
      projectId: project.projectId,
      installationId: installation.installationId,
      organizationId: installation.organizationId,
      name: project.projectName,
      slugId: project.projectSlugId,
      updatedAt: project.projectUpdatedAt,
    });
    store.saveConductorBinding({
      bindingId: ids.bindingId,
      conductorId: ids.conductorId,
      conductorShortHash: ids.conductorShortHash,
      linearInstallationId: installation.installationId,
      organizationId: installation.organizationId,
      repositoryContext: {
        repositoryHandle: ids.repositoryHandle,
        repositoryIdentity: ids.repositoryHandle,
        repositoryDisplayName: "core-live-e2e",
        repositoryRoot: git.repositoryRoot,
        baseBranch: git.baseBranch,
      },
      desiredState: "running",
    });
  } finally {
    store.close();
  }
  return installation;
}

function createConductorEnvironment({ environment, config, scope, git, installation, ids }) {
  return createChildEnvironment({ environment, additions: {
    SYMPHONY_PRIVATE_IPC_FD: "3",
    SYMPHONY_INSTANCE_ID: ids.instanceId,
    SYMPHONY_BINDING_ID: ids.bindingId,
    SYMPHONY_CONDUCTOR_ID: ids.conductorId,
    SYMPHONY_CONDUCTOR_SHORT_HASH: ids.conductorShortHash,
    SYMPHONY_LINEAR_INSTALLATION_ID: installation.installationId,
    SYMPHONY_ORGANIZATION_ID: installation.organizationId,
    SYMPHONY_REPOSITORY_HANDLE: ids.repositoryHandle,
    SYMPHONY_REPOSITORY_ROOT: git.repositoryRoot,
    SYMPHONY_BASE_BRANCH: git.baseBranch,
    SYMPHONY_CONDUCTOR_DATA_ROOT: scope.conductorDataRoot,
    SYMPHONY_PERFORMER_EXECUTABLE: path.resolve(".venv/bin/performer"),
    SYMPHONY_CODEX_BASE_URL: config.codex.baseUrl,
    SYMPHONY_CYCLE_DELAY_MS: "1000",
  } });
}

function runIdentifiers(runId) {
  const hash = createHash("sha256").update(runId).digest("hex");
  return Object.freeze({
    conductorShortHash: hash.slice(0, 12),
    conductorId: `conductor-${hash.slice(0, 24)}`,
    bindingId: `binding-${hash.slice(0, 24)}`,
    instanceId: `instance-${hash.slice(0, 24)}`,
    repositoryHandle: `repository-${hash.slice(0, 24)}`,
  });
}

async function pollUntil(read, accepted, { timeoutMs, pollIntervalMs, code }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepted(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw stableError(code);
}

async function readDeliveredMarker(repositoryRoot, branch) {
  try {
    const { stdout } = await execute("git", ["-C", repositoryRoot, "show", `${branch}:e2e-result.txt`], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return stdout;
  } catch {
    throw stableError("e2e_delivery_marker_missing");
  }
}

async function writeEvidence(runId, result, secrets) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  for (const secret of Object.values(secrets)) {
    if (secret && serialized.includes(secret)) throw stableError("e2e_evidence_secret_detected");
  }
  const directory = path.resolve(".test", "e2e-core-live", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "result.json"), serialized, { mode: 0o600 });
}

function sanitize(error) {
  const code = error?.code ?? error?.message;
  return typeof code === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(code)
    ? code
    : "e2e_core_live_failed";
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 1 && arguments_[0] === "--dry-run") {
    process.stdout.write(`${JSON.stringify({
      status: "dry_run",
      mutationAttempted: false,
      states: [
        "preflight", "locked", "project-created", "conductor-ready",
        "profile-active", "root-todo", "planning", "awaiting-human",
        "working", "gating", "delivering", "in-review",
      ],
      evidenceSteps: coreLiveStepIds(),
    }, null, 2)}\n`);
  } else if (arguments_.length !== 0) {
    process.stderr.write('{"status":"failed","reason":"e2e_argument_invalid"}\n');
    process.exitCode = 2;
  } else runCoreLiveE2E()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ status: "failed", reason: sanitize(error) })}\n`);
      process.exitCode = 2;
    });
}
