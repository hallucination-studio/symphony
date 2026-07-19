import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createChildEnvironment, loadE2EConfig } from "./config.mjs";
import { createProductionPodiumConductorOwner, startConductorHarness } from "./conductor-harness.mjs";
import { provisionApiKeyProfile } from "./conductor-profile.mjs";
import { coreLiveStepIds, evaluateCoreLiveEvidence } from "./core-live-verdict.mjs";
import { acquireGlobalLock, coreLiveLockRoot, lockPathForConfig } from "./global-lock.mjs";
import { createE2ELogger } from "./logging.mjs";
import {
  cleanupRunScope,
  createRunScope,
  createRunScopedGitFixture,
  createRunScopedLinearOperator,
} from "./run-fixtures.mjs";

const execute = promisify(execFile);
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export function createTurnLaneTracker(log) {
  const active = new Set();
  const observed = new Set();
  let maxActiveTurns = 0;
  return Object.freeze({
    log(event) {
      log(event);
      if (
        event?.event !== "e2e_child_log" ||
        event.component !== "conductor" ||
        (event.stream !== "stdout" && event.stream !== "stderr") ||
        typeof event.message !== "string"
      ) return;
      let value;
      try {
        value = JSON.parse(event.message);
      } catch {
        return;
      }
      if (
        value?.event !== "performer_turn_event" ||
        !TURN_ID.test(value.turn_id ?? "")
      ) return;
      if (value.event_kind === "turn_started") {
        observed.add(value.turn_id);
        active.add(value.turn_id);
        maxActiveTurns = Math.max(maxActiveTurns, active.size);
      } else if (value.event_kind === "turn_completed") {
        active.delete(value.turn_id);
      }
    },
    evidence() {
      return Object.freeze({
        observedTurnCount: observed.size,
        maxActiveTurns,
        activeTurnCount: active.size,
      });
    },
  });
}

export async function runCoreLiveE2E({
  environment = process.env,
  runId = environment.SYMPHONY_E2E_RUN_ID ?? `run-${randomUUID()}`,
  timeoutMs = 30 * 60_000,
  pollIntervalMs = 2_000,
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    throw stableError("e2e_run_id_invalid");
  }
  const config = loadE2EConfig({ environment });
  const log = createE2ELogger({ runId, secrets: Object.values(config.secrets) });
  const turnLane = createTurnLaneTracker(log);
  log({ event: "e2e_run_started" });
  const linear = createRunScopedLinearOperator({
    developmentToken: config.secrets.linearDevToken,
    applicationClientId: config.linear.clientId,
    log,
  });
  log({ event: "e2e_step_started", step: "preflight" });
  const preflight = await linear.preflight();
  log({ event: "e2e_step_completed", step: "preflight" });
  const lock = await acquireGlobalLock(
    { paths: { lock: lockPathForConfig(coreLiveLockRoot()) } },
    { runId },
  );
  let scope;
  let project;
  let fixtures = [];
  let harness;
  const evidence = [];
  const ids = runIdentifiers(runId);
  let result;
  try {
    scope = await createRunScope({ runId });
    const git = await createRunScopedGitFixture({ runId, parentDirectory: scope.root });
    log({ event: "e2e_step_started", step: "stale_reconciliation" });
    await linear.reconcileStaleRuns({ lock, currentRunId: runId });
    log({ event: "e2e_step_completed", step: "stale_reconciliation" });
    log({ event: "e2e_step_started", step: "project_created" });
    project = await linear.createProject({
      lock,
      runId,
      conductorShortHash: ids.conductorShortHash,
      projectSlugId: config.linear.projectSlugId,
      preflight,
    });
    evidence.push({ step: "project_created", status: "passed" });
    log({
      event: "e2e_step_completed",
      step: "project_created",
      project_mode: project.retainProject ? "retained" : "temporary",
    });

    log({ event: "e2e_step_started", step: "podium_bootstrap" });
    const databasePath = path.join(scope.appDataRoot, "podium.db");
    const installation = await bootstrapPodiumState({
      databasePath,
      developmentToken: config.secrets.linearDevToken,
      preflight,
      project,
      git,
      ids,
    });
    log({ event: "e2e_step_completed", step: "podium_bootstrap" });
    const podium = await createProductionPodiumConductorOwner({ databasePath });

    log({ event: "e2e_step_started", step: "root_created" });
    const blocker = await linear.createRoot({
      lock,
      runId,
      rootName: boundedRootName(runId, "blocker"),
      preflight,
      project,
      priority: 4,
      sortOrder: 20,
      rootInstruction: rootInstruction("e2e-blocker.txt", `${runId}:blocker\n`),
    });
    const dependent = await linear.createRoot({
      lock,
      runId,
      rootName: boundedRootName(runId, "dependent"),
      preflight,
      project,
      priority: 1,
      sortOrder: 10,
      rootInstruction: rootInstruction("e2e-dependent.txt", `${runId}:dependent\n`),
    });
    const yielded = await linear.createRoot({
      lock,
      runId,
      rootName: boundedRootName(runId, "yielded"),
      preflight,
      project,
      priority: 0,
      sortOrder: 30,
      rootInstruction: rootInstruction("e2e-yielded.txt", `${runId}:yielded\n`),
    });
    await linear.createBlockerRelation({ lock, runId, blocker, dependent });
    fixtures = [blocker, yielded, dependent];
    evidence.push({
      step: "root_created",
      status: "passed",
      rootCount: fixtures.length,
      rootIdentifiers: fixtures.map(({ rootIdentifier }) => rootIdentifier),
    });
    log({ event: "e2e_step_completed", step: "root_created", root_count: fixtures.length });

    log({ event: "e2e_step_started", step: "conductor_handshake" });
    harness = await startConductorHarness({
      podium,
      environment: createConductorEnvironment({ environment, config, scope, git, installation, ids }),
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 5_000,
      log: turnLane.log,
    });
    evidence.push({ step: "conductor_handshake", status: "passed" });
    log({ event: "e2e_step_completed", step: "conductor_handshake" });

    const apiKey = new TextEncoder().encode(config.secrets.codexApiKey);
    log({ event: "e2e_step_started", step: "profile_active" });
    const profile = await provisionApiKeyProfile({
      harness,
      conductorId: ids.conductorId,
      model: config.codex.model,
      apiKey,
      log,
    });
    evidence.push({ step: "profile_active", status: "passed" });
    log({ event: "e2e_step_completed", step: "profile_active" });

    log({ event: "e2e_step_started", step: "multi_root_scheduling" });
    const [blockerPlan] = await pollUntil(
      () => readRootStates(linear, [blocker, dependent]),
      ([blockerState, dependentState]) =>
        planReady(blockerState) && rootUntouched(dependentState),
      { timeoutMs, pollIntervalMs, code: "e2e_blocker_order_timeout" },
    );
    evidence.push({
      step: "blocker_order_verified",
      status: "passed",
      blockerPlanned: true,
      dependentUntouched: true,
    });

    const [waitingBlocker, yieldedPlan] = await pollUntil(
      () => readRootStates(linear, [blocker, yielded]),
      ([blockerState, yieldedState]) =>
        planReady(blockerState) && planReady(yieldedState),
      { timeoutMs, pollIntervalMs, code: "e2e_human_yield_timeout" },
    );
    evidence.push({
      step: "human_yield_verified",
      status: "passed",
      waitingRootUnchanged: waitingBlocker.approvalState === "In Progress",
      yieldedRootPlanned: true,
    });

    await linear.updateRootScheduling({
      lock,
      runId,
      fixture: yielded,
      priority: 1,
      sortOrder: -10,
    });
    await Promise.all([
      linear.approvePlan({
        lock,
        runId,
        fixture: blocker,
        preflight,
        approvalId: blockerPlan.approvalId,
      }),
      linear.approvePlan({
        lock,
        runId,
        fixture: yielded,
        preflight,
        approvalId: yieldedPlan.approvalId,
      }),
    ]);
    await pollUntil(
      () => readRootStates(linear, [blocker, yielded]),
      ([blockerState, yieldedState]) =>
        rootWorkUntouched(blockerState) && rootAdvancedPastApproval(yieldedState),
      {
        timeoutMs,
        pollIntervalMs,
        code: "e2e_priority_refresh_timeout",
      },
    );
    evidence.push({
      step: "priority_refresh_verified",
      status: "passed",
      newWinnerSelected: true,
      previousWinnerUntouched: true,
    });

    const yieldedCompleted = await waitForRootCompletion({
      linear,
      fixture: yielded,
      plan: yieldedPlan,
      git,
      filename: "e2e-yielded.txt",
      expected: `${runId}:yielded\n`,
      timeoutMs,
      pollIntervalMs,
    });
    await linear.completeRoot({
      lock,
      runId,
      fixture: blocker,
      doneStateId: preflight.doneStateId,
    });
    const dependentPlan = await pollUntil(
      () => linear.readRunState({ fixture: dependent }),
      planReady,
      { timeoutMs, pollIntervalMs, code: "e2e_dependent_plan_timeout" },
    );
    evidence.push(
      { step: "plan_ready", status: "passed" },
      { step: "plan_approved", status: "passed" },
    );
    const laneEvidence = turnLane.evidence();
    if (
      laneEvidence.activeTurnCount !== 0 ||
      laneEvidence.maxActiveTurns !== 1 ||
      laneEvidence.observedTurnCount < 5
    ) {
      throw stableError("e2e_single_turn_lane_invalid");
    }
    evidence.push({
      step: "single_turn_lane_verified",
      status: "passed",
      observedTurnCount: laneEvidence.observedTurnCount,
      maxActiveTurns: laneEvidence.maxActiveTurns,
    });
    evidence.push(
      { step: "work_completed", status: "passed" },
      { step: "root_gate_passed", status: "passed" },
      {
        step: "branch_delivered",
        status: "passed",
        branchCount: 1,
      },
      { step: "linear_in_review", status: "passed" },
    );
    log({ event: "e2e_step_completed", step: "root_completion" });

    log({ event: "e2e_step_started", step: "root_comments_verified" });
    const rootComments = await Promise.all(
      fixtures.map((candidate) =>
        linear.readRootCommentEvidence({ fixture: candidate })),
    );
    const eventKeys = rootComments.flatMap((item) => item.eventKeys);
    evidence.push({
      step: "root_comments_verified",
      status: "passed",
      rootCount: rootComments.length,
      primaryCommentCount: rootComments.reduce(
        (total, item) => total + item.primaryCommentCount,
        0,
      ),
      timelineEventCount: eventKeys.length,
      completionEventCount: rootComments.reduce(
        (total, item) => total + item.completionEventCount,
        0,
      ),
      eventKinds: [...new Set(rootComments.flatMap((item) => item.eventKinds))],
      eventKeys,
    });
    log({
      event: "e2e_step_completed",
      step: "root_comments_verified",
      root_count: rootComments.length,
      timeline_event_count: eventKeys.length,
    });

    result = Object.freeze({
      status: "passed",
      runId,
      projectMode: project.retainProject ? "retained" : "temporary",
      projectSlugId: project.projectSlugId,
      rootIdentifier: yielded.rootIdentifier,
      profileId: profile.profileId,
      performerResumed: yieldedCompleted.performerId === yieldedPlan.performerId,
      rootState: yieldedCompleted.rootState,
      phase: yieldedCompleted.phase,
      deliveryBranch: yieldedCompleted.deliveryBranch,
      evidence,
    });
  } catch (error) {
    result = { status: "failed", runId, reason: sanitize(error), evidence };
    log({ event: "e2e_run_failed", reason: result.reason });
  }

  if (project?.retainProject && fixtures.length > 0) {
    log({
      event: "e2e_debug_resources_retained",
      project_slug_id: project.projectSlugId,
      root_identifiers: fixtures.map(({ rootIdentifier }) => rootIdentifier),
    });
  }

  const finalResult = await finalizeCoreLiveResult({
    result,
    cleanup: () => cleanupCoreLiveResources({ harness, linear, lock, runId, project, scope }, { log }),
    write: (value) => writeEvidence(runId, value, config.secrets),
  });
  if (finalResult.status === "failed") throw stableError(finalResult.reason);
  log({ event: "e2e_run_completed", status: "passed" });
  return finalResult;
}

export async function cleanupCoreLiveResources(
  { harness, linear, lock, runId, project, scope },
  { cleanupScope = cleanupRunScope, log = () => {} } = {},
) {
  const failures = [];
  const actions = [
    [Boolean(harness), "conductor", "e2e_conductor_cleanup_failed", () => harness.close()],
    [Boolean(project), "linear", "e2e_linear_cleanup_failed", () => linear.cleanup({
      lock,
      runId,
      projectId: project.projectId,
      labelId: project.labelId,
      marker: project.marker,
      ...(typeof project.retainProject === "boolean"
        ? { retainProject: project.retainProject }
        : {}),
    })],
    [Boolean(scope), "run_scope", "e2e_run_scope_cleanup_failed", () => cleanupScope(scope)],
    [Boolean(lock), "lock", "e2e_lock_release_failed", () => lock.release()],
  ];
  for (const [enabled, resource, code, action] of actions) {
    if (!enabled) continue;
    log({ event: "e2e_cleanup_started", resource });
    try {
      await action();
      log({ event: "e2e_cleanup_completed", resource });
    } catch {
      failures.push(code);
      log({ event: "e2e_cleanup_failed", resource, reason: code });
    }
  }
  return Object.freeze(failures);
}

export async function finalizeCoreLiveResult({ result, cleanup, write }) {
  const cleanupFailures = await cleanup();
  const cleanupPassed = cleanupFailures.length === 0;
  let finalResult = {
    ...result,
    evidence: [
      ...result.evidence,
      { step: "cleanup_completed", status: cleanupPassed ? "passed" : "failed" },
    ],
  };
  if (!cleanupPassed) {
    finalResult.status = "failed";
    finalResult.cleanupFailures = [...cleanupFailures];
    if (result.status === "passed") finalResult.reason = cleanupFailures[0];
  }
  if (finalResult.status === "passed" && evaluateCoreLiveEvidence(finalResult).verdict !== "passed") {
    finalResult = { ...finalResult, status: "failed", reason: "e2e_evidence_verdict_failed" };
  }
  await write(finalResult);
  return Object.freeze(finalResult);
}

async function bootstrapPodiumState({ databasePath, developmentToken, preflight, project, git, ids }) {
  const { bootstrapDevelopmentTokenInstallation } = await import("@symphony/podium");
  const installation = await bootstrapDevelopmentTokenInstallation({
    databasePath,
    developmentToken,
    delegateActorId: preflight.actorId,
  });
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
    SYMPHONY_CYCLE_DELAY_MS: "5000",
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

function rootInstruction(filename, content) {
  return [
    `Create a file named ${filename} at the repository root.`,
    `Its content must be exactly ${JSON.stringify(content)}.`,
    "Make no other changes.",
    "Create a plan with exactly one Work node that performs this change; do not add a separate verification Work node.",
  ].join(" ");
}

function boundedRootName(runId, role) {
  return `${runId.slice(0, 48)} ${role}`;
}

function readRootStates(linear, fixtures) {
  return Promise.all(
    fixtures.map((fixture) => linear.readRunState({ fixture })),
  );
}

function planReady(state) {
  return state?.phase === "awaiting-human" &&
    state.approvalState === "In Progress" &&
    state.planApprovalCount === 1 &&
    state.treeMatches === true &&
    rootWorkUntouched(state) &&
    Boolean(state.performerId);
}

function rootUntouched(state) {
  return state?.rootState === "Todo" &&
    state.phase === undefined &&
    state.planApprovalCount === 0 &&
    state.performerId === undefined;
}

function rootWorkUntouched(state) {
  return Array.isArray(state?.workStates) &&
    state.workStates.length > 0 &&
    state.workStates.every((value) => value === "Todo" || value === "Canceled");
}

function rootAdvancedPastApproval(state) {
  return state?.phase === "working" ||
    state?.phase === "gating" ||
    state?.phase === "delivering" ||
    state?.phase === "in-review" ||
    state?.workStates?.some((value) => value !== "Todo" && value !== "Canceled");
}

async function waitForRootCompletion({
  linear,
  fixture,
  plan,
  git,
  filename,
  expected,
  timeoutMs,
  pollIntervalMs,
}) {
  const completed = await pollUntil(
    () => linear.readRunState({ fixture }),
    (state) =>
      state.rootState === "In Review" &&
      state.phase === "in-review" &&
      Boolean(state.deliveryBranch),
    { timeoutMs, pollIntervalMs, code: "e2e_root_completion_timeout" },
  );
  if (completed.performerId !== plan.performerId) {
    throw stableError("e2e_performer_resume_mismatch");
  }
  if (
    completed.reworkCount !== 0 ||
    completed.workStates.some((state) => state !== "Done")
  ) {
    throw stableError("e2e_workflow_incomplete");
  }
  const delivered = await readDeliveredMarker(
    git.repositoryRoot,
    completed.deliveryBranch,
    filename,
  );
  if (delivered !== expected) throw stableError("e2e_delivery_marker_mismatch");
  return completed;
}

async function readDeliveredMarker(repositoryRoot, branch, filename) {
  if (!/^e2e-[a-z]+\.txt$/u.test(filename)) {
    throw stableError("e2e_delivery_marker_invalid");
  }
  try {
    const { stdout } = await execute("git", ["-C", repositoryRoot, "show", `${branch}:${filename}`], {
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
