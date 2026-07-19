import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  createChildEnvironment,
  isMissingInputConfiguration,
  loadE2EConfig,
} from "./config.mjs";
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
const DEFAULT_RUN_TIMEOUT_MS = 20 * 60_000;

export function createTurnLaneTracker(log) {
  const active = new Set();
  const observed = new Set();
  const turnOwners = new Map();
  const completed = new Set();
  const firstConversationByRoot = new Map();
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
        if (typeof value.root_issue_id === "string" && typeof value.performer_id === "string" &&
          !turnOwners.has(value.turn_id)) {
          turnOwners.set(value.turn_id, Object.freeze({
            rootIssueId: value.root_issue_id,
            performerId: value.performer_id,
          }));
        }
        if (typeof value.root_issue_id === "string" && typeof value.performer_id === "string"
          && !firstConversationByRoot.has(value.root_issue_id)) {
          firstConversationByRoot.set(value.root_issue_id, value.performer_id);
        }
        active.add(value.turn_id);
        maxActiveTurns = Math.max(maxActiveTurns, active.size);
      } else if (value.event_kind === "turn_completed") {
        active.delete(value.turn_id);
        if (turnOwners.has(value.turn_id)) completed.add(value.turn_id);
      }
    },
    evidence() {
      return Object.freeze({
        observedTurnCount: observed.size,
        maxActiveTurns,
        activeTurnCount: active.size,
      });
    },
    observedConversation(rootIssueId, performerId) {
      return firstConversationByRoot.get(rootIssueId) === performerId;
    },
    completedTurn(rootIssueId, performerId, turnId) {
      const owner = turnOwners.get(turnId);
      return completed.has(turnId) && owner?.rootIssueId === rootIssueId &&
        owner?.performerId === performerId;
    },
  });
}

export function createRuntimeEvidenceTracker(log, now = Date.now) {
  const started = new Map();
  const stepDurationsMs = {};
  const requestCounts = {};
  const stepRequestCounts = {};
  const brokerResults = [];
  let discoveryObservations = 0;
  let maxRootHeaderCount = 0;
  let totalDiscoveryListPages = 0;
  let discoveryTreeRequests = 0;
  let activeStep;
  let totalRequests = 0;
  return Object.freeze({
    log(event) {
      log(event);
      if (event?.event === "e2e_step_started" && typeof event.step === "string") {
        started.set(event.step, now());
        activeStep = event.step;
      } else if (event?.event === "e2e_step_completed" && typeof event.step === "string") {
        const value = started.get(event.step);
        if (value !== undefined) {
          stepDurationsMs[event.step] = Math.max(0, Math.round(now() - value));
          started.delete(event.step);
        }
        if (activeStep === event.step) activeStep = undefined;
      } else if (event?.event === "e2e_conductor_request"
        && typeof event.request_kind === "string") {
        totalRequests += 1;
        requestCounts[event.request_kind] = (requestCounts[event.request_kind] ?? 0) + 1;
        if (activeStep) {
          const counts = stepRequestCounts[activeStep] ?? {};
          counts[event.request_kind] = (counts[event.request_kind] ?? 0) + 1;
          stepRequestCounts[activeStep] = counts;
        }
      } else if (event?.event === "e2e_child_log" && event.component === "conductor"
        && typeof event.message === "string") {
        try {
          const value = JSON.parse(event.message);
          if (value?.event === "agent_broker_result"
            && typeof value.command === "string" && typeof value.status === "string"
            && typeof value.root_issue_id === "string" && typeof value.turn_id === "string"
            && typeof value.performer_id === "string") {
            brokerResults.push(Object.freeze({ command: value.command, status: value.status,
              rootIssueId: value.root_issue_id, turnId: value.turn_id,
              performerId: value.performer_id }));
          } else if (value?.event === "root_discovery_evidence") {
            const counts = [value.root_header_count, value.list_page_count,
              value.get_issue_tree_count].map(nonNegativeInteger);
            if (counts.every((item) => item !== undefined)) {
              discoveryObservations += 1;
              maxRootHeaderCount = Math.max(maxRootHeaderCount, counts[0]);
              totalDiscoveryListPages += counts[1];
              discoveryTreeRequests += counts[2];
            }
          }
        } catch {
          // Non-JSON child output is not evidence.
        }
      }
    },
    evidence() {
      return Object.freeze({
        stepDurationsMs: Object.freeze({ ...stepDurationsMs }),
        requestCounts: Object.freeze({ ...requestCounts }),
        stepRequestCounts: Object.freeze(Object.fromEntries(
          Object.entries(stepRequestCounts).map(([step, counts]) =>
            [step, Object.freeze({ ...counts })]),
        )),
        brokerResults: Object.freeze([...brokerResults]),
        discoveryObservations,
        maxRootHeaderCount,
        totalDiscoveryListPages,
        discoveryTreeRequests,
        totalRequests,
      });
    },
  });
}

function nonNegativeInteger(value) {
  const parsed = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function runCoreLiveE2E({
  environment = process.env,
  runId = environment.SYMPHONY_E2E_RUN_ID ?? `run-${randomUUID()}`,
  timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  pollIntervalMs = 10_000,
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    throw stableError("e2e_run_id_invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_RUN_TIMEOUT_MS) {
    throw stableError("e2e_run_timeout_invalid");
  }
  const config = loadE2EConfig({ environment });
  const deadline = Date.now() + timeoutMs;
  const baseLog = createE2ELogger({ runId, secrets: Object.values(config.secrets) });
  const runtimeEvidence = createRuntimeEvidenceTracker(baseLog);
  const log = runtimeEvidence.log;
  const turnLane = createTurnLaneTracker(log);
  log({ event: "e2e_run_started" });
  const linear = createRunScopedLinearOperator({
    developmentToken: config.secrets.linearDevToken,
    applicationClientId: config.linear.clientId,
    log,
  });
  log({ event: "e2e_step_started", step: "preflight" });
  const preflight = await linear.preflight();
  assertRunActive(deadline);
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
    assertRunActive(deadline);
    log({ event: "e2e_step_completed", step: "stale_reconciliation" });
    log({ event: "e2e_step_started", step: "project_created" });
    project = await linear.createProject({
      lock,
      runId,
      conductorShortHash: ids.conductorShortHash,
      projectSlugId: config.linear.projectSlugId,
      preflight,
    });
    assertRunActive(deadline);
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
    assertRunActive(deadline);
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
    assertRunActive(deadline);
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
    assertRunActive(deadline);
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
    assertRunActive(deadline);
    evidence.push({ step: "profile_active", status: "passed" });
    log({ event: "e2e_step_completed", step: "profile_active" });

    log({ event: "e2e_step_started", step: "multi_root_scheduling" });
    const [blockerPlan] = await pollUntil(
      () => readRootStates(linear, [blocker, dependent]),
      ([blockerState, dependentState]) =>
        planReady(blockerState) && rootUntouched(dependentState),
      { deadline, pollIntervalMs },
    );
    evidence.push({
      step: "conversation_pointer_verified",
      status: "passed",
      pointerReadBack: Boolean(blockerPlan.performerId),
      firstTurnUsedPointer: turnLane.observedConversation(
        blocker.rootIssueId,
        blockerPlan.performerId,
      ),
    });
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
      { deadline, pollIntervalMs },
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
    assertRunActive(deadline);
    await pollUntil(
      () => readRootStates(linear, [blocker, yielded]),
      ([blockerState, yieldedState]) =>
        rootWorkUntouched(blockerState) && rootAdvancedPastApproval(yieldedState),
      {
        deadline,
        pollIntervalMs,
      },
    );
    evidence.push({
      step: "priority_refresh_verified",
      status: "passed",
      newWinnerSelected: true,
      previousWinnerUntouched: true,
    });
    log({ event: "e2e_step_completed", step: "multi_root_scheduling" });
    log({ event: "e2e_step_started", step: "root_completion" });

    const yieldedCompleted = await waitForRootCompletion({
      linear,
      fixture: yielded,
      plan: yieldedPlan,
      git,
      filename: "e2e-yielded.txt",
      expected: `${runId}:yielded\n`,
      deadline,
      pollIntervalMs,
    });
    assertRunActive(deadline);
    await linear.completeRoot({
      lock,
      runId,
      fixture: blocker,
      doneStateId: preflight.doneStateId,
    });
    const dependentPlan = await pollUntil(
      () => linear.readRunState({ fixture: dependent }),
      planReady,
      { deadline, pollIntervalMs },
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
    const runtimeFacts = runtimeEvidence.evidence();
    const correlatedBrokerResults = runtimeFacts.brokerResults
      .filter(({ status, rootIssueId, performerId, turnId }) =>
        (status === "applied" || status === "already_applied") &&
        rootIssueId === yielded.rootIssueId && performerId === yieldedCompleted.performerId &&
        turnLane.completedTurn(rootIssueId, performerId, turnId));
    const appliedBrokerCommands = correlatedBrokerResults.map(({ command }) => command);
    const commandsByTurn = Map.groupBy(correlatedBrokerResults, ({ turnId }) => turnId);
    const deliveryTurn = [...commandsByTurn.entries()].find(([, commands]) =>
      commands.some(({ command }) => command === "git.commit") &&
      commands.some(({ command }) => command === "root.deliver"));
    const linearReadBack = appliedBrokerCommands.some((command) => command.startsWith("linear."));
    const gitReadBack = deliveryTurn?.[1].some(({ command }) => command === "git.commit") === true;
    const deliveryReadBack = deliveryTurn?.[1].some(({ command }) => command === "root.deliver") === true;
    if (!linearReadBack || !gitReadBack || !deliveryReadBack) {
      throw stableError("e2e_broker_write_evidence_missing");
    }
    evidence.push(
      { step: "work_completed", status: "passed",
        workNodeCount: yieldedCompleted.workStates.length,
        allWorkDone: yieldedCompleted.workStates.every((state) => state === "Done") },
      { step: "root_gate_passed", status: "passed",
        reworkCount: yieldedCompleted.reworkCount,
        phase: yieldedCompleted.phase },
      {
        step: "branch_delivered",
        status: "passed",
        branchCount: 1,
        deliveryBranch: yieldedCompleted.deliveryBranch,
        deliveredMarkerReadBack: true,
      },
      { step: "linear_in_review", status: "passed",
        rootState: yieldedCompleted.rootState, phase: yieldedCompleted.phase },
      { step: "broker_writes_verified", status: "passed",
        linearReadBack, gitReadBack, deliveryReadBack,
        rootIssueId: yielded.rootIssueId,
        performerId: yieldedCompleted.performerId,
        correlatedTurnIds: [...commandsByTurn.keys()],
        deliveryTurnId: deliveryTurn?.[0],
        turnCommands: [...commandsByTurn].map(([turnId, commands]) => ({
          turnId,
          commands: [...new Set(commands.map(({ command }) => command))],
        })),
        appliedCommands: [...new Set(appliedBrokerCommands)] },
    );
    log({ event: "e2e_step_completed", step: "root_completion" });

    log({ event: "e2e_step_started", step: "root_comments_verified" });
    const rootComments = await Promise.all(
      fixtures.map((candidate) =>
        linear.readRootCommentEvidence({ fixture: candidate })),
    );
    assertRunActive(deadline);
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

    const requests = runtimeEvidence.evidence();
    evidence.push({
      step: "request_budget_verified",
      status: "passed",
      ...requests,
    });

    result = Object.freeze({
      status: "passed",
      runId,
      projectMode: project.retainProject ? "retained" : "temporary",
      projectSlugId: project.projectSlugId,
      rootIdentifier: yielded.rootIdentifier,
      rootIssueId: yielded.rootIssueId,
      profileId: profile.profileId,
      performerId: yieldedCompleted.performerId,
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

export async function pollUntil(read, accepted, { deadline, pollIntervalMs }) {
  while (true) {
    const value = await beforeDeadline(read, deadline);
    if (accepted(value)) return value;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw stableError("e2e_run_timeout");
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }
}

function assertRunActive(deadline) {
  if (Date.now() >= deadline) throw stableError("e2e_run_timeout");
}

async function beforeDeadline(action, deadline) {
  assertRunActive(deadline);
  let timer;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(stableError("e2e_run_timeout")),
          deadline - Date.now(),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  deadline,
  pollIntervalMs,
}) {
  const completed = await pollUntil(
    () => linear.readRunState({ fixture }),
    (state) =>
      state.rootState === "In Review" &&
      state.phase === "in-review" &&
      Boolean(state.deliveryBranch),
    { deadline, pollIntervalMs },
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
      process.stderr.write(`${JSON.stringify({
        status: isMissingInputConfiguration(error) ? "unverified" : "failed",
        reason: sanitize(error),
      })}\n`);
      process.exitCode = 2;
    });
}
