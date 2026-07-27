import { randomUUID } from "node:crypto";
import path from "node:path";

import { FOREGROUND_E2E_CASES } from "./cases.mjs";
import { loadForegroundE2EConfig, PUBLIC_CONFIGURATION_ISSUES } from "./campaign-config.mjs";
import { runApprovedHappyPathCase } from "./approved-happy-path.mjs";
import { runConductorRestartRecoveryCase } from "./conductor-restart-recovery.mjs";
import { createForegroundE2EEnvironment, installForegroundE2ESignalCleanup } from "./environment.mjs";
import { readForegroundE2EFinalEvidence } from "./evidence.mjs";
import { createForegroundE2EHumanActor } from "./human.mjs";
import { runInformationRequestedAndAnsweredCase } from "./information-requested-and-answered.mjs";
import { runMissingWorktreeRecoveryCase } from "./missing-worktree-recovery.mjs";
import { runParallelMultiConductorCase } from "./parallel-multi-conductor.mjs";
import { runRejectedPlanAndReplannedCase } from "./rejected-plan-and-replanned.mjs";
import { createForegroundReporter } from "./reporter.mjs";
import { runRootRevisionAndCommentCase } from "./root-revision-and-comment.mjs";
import { runSameConductorPreemptionCase } from "./same-conductor-preemption.mjs";
import { runForegroundE2ECases } from "./verdict.mjs";

const CAMPAIGN_DEADLINE_MS = 15 * 60_000;
const INTERRUPTED_CASE_SETTLE_GRACE_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const CONDUCTOR_REFERENCES = Object.freeze(["conductor-a", "conductor-b", "conductor-c"]);

const DEFAULT_DEPENDENCIES = Object.freeze({
  loadConfig: loadForegroundE2EConfig,
  createReporter: createForegroundReporter,
  createEnvironment: createForegroundE2EEnvironment,
  createHuman: createForegroundE2EHumanActor,
  runCases: runForegroundE2ECases,
  readFinalEvidence: readForegroundE2EFinalEvidence,
  installSignalCleanup: installForegroundE2ESignalCleanup,
  runCaseDriver,
  randomUUID,
  now: () => performance.now(),
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
});

const publicReasonCodes = new Set([
  "e2e_configuration_invalid",
  "foreground_e2e_campaign_input_invalid",
  "foreground_e2e_campaign_interrupted",
  "foreground_e2e_case_bindings_invalid",
  "foreground_e2e_case_root_identity_incomplete",
  "foreground_e2e_project_label_read_failed",
]);

export async function runForegroundE2ECampaign({
  environment = process.env,
  dependencies = {},
  signals = process,
  campaignDeadlineMs = CAMPAIGN_DEADLINE_MS,
} = {}) {
  const operations = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  assertInput({ environment, operations, signals, campaignDeadlineMs });
  const config = operations.loadConfig({ environment });
  const startedAt = operations.now();
  const reporter = operations.createReporter({
    campaignId: operations.randomUUID(),
    secrets: Object.values(config.secrets ?? {}),
    elapsedMs: () => elapsedMilliseconds(startedAt, operations.now()),
  });
  const abortController = new AbortController();
  let activeEnvironment;
  let signalCleanup;
  let summary;
  try {
    reporter.startHeartbeat(HEARTBEAT_INTERVAL_MS);
    signalCleanup = operations.installSignalCleanup({
      signals,
      abortController,
      reporter,
      // Final Linear/Git reads must happen before owned local resources are removed.
      cleanup: async () => undefined,
    });
    reporter.phase("starting");
    activeEnvironment = await operations.createEnvironment({
      config,
      reporter,
      signal: abortController.signal,
    });
    assertEnvironment(activeEnvironment);
    if (abortController.signal.aborted) throw stableError("foreground_e2e_campaign_interrupted");

    const human = await operations.createHuman({
      apiKey: config.secrets.linearHumanApiKey,
      expectedActorId: activeEnvironment.actors.humanActorId,
      delegateActorId: activeEnvironment.project.delegateActorId,
    });
    assertHuman(human);
    const rootCreationsByRootKey = await human.resolveRootCreationBindings({
      teamId: activeEnvironment.project.teamId,
      projectId: activeEnvironment.project.projectId,
      conductors: conductorBindings(activeEnvironment.runtime.conductors),
    });
    assertRootCreationBindings(rootCreationsByRootKey);

    const createCaseScope = createCampaignCaseScopeFactory({
      parentSignal: abortController.signal,
      now: operations.now,
      setTimeout: operations.setTimeout,
      clearTimeout: operations.clearTimeout,
      deadlineMs: campaignDeadlineMs,
      rootCreationsByRootKey,
      subscribeUnexpectedExit: activeEnvironment.runtime.subscribeUnexpectedExit,
    });
    reporter.phase("running");
    const candidateSummary = await settleInterruptedCases({
      signal: abortController.signal,
      setTimeout: operations.setTimeout,
      clearTimeout: operations.clearTimeout,
      run: () => operations.runCases({
        definitions: FOREGROUND_E2E_CASES,
        reporter,
        createCaseScope,
        runCase: ({ definition, scope }) => operations.runCaseDriver({
          definition,
          human,
          runtime: activeEnvironment.runtime,
          rootCreationsByRootKey,
          signal: scope.signal,
        }),
        readFinalEvidence: async ({ definition, driverResult }) => readCaseFinalEvidence({
          definition,
          driverResult,
          human,
          rootCreationsByRootKey,
          accessToken: config.secrets.linearDevToken,
          readFinalEvidence: operations.readFinalEvidence,
        }),
      }),
    });
    activeEnvironment.runtime.assertProjectRootIndexRequestBudget();
    summary = candidateSummary;
    return summary;
  } finally {
    let cleanupError;
    try {
      await activeEnvironment?.close?.();
    } catch (error) {
      cleanupError = error;
      reportCleanupFailure(reporter, error);
    } finally {
      try {
        signalCleanup?.dispose?.();
      } finally {
        if (summary) reporter.summary?.(summary);
        reporter.close();
      }
    }
    if (cleanupError) throw cleanupError;
  }
}

export function sanitizeForegroundE2ECampaignFailure(error) {
  const reasonCode = publicReasonCodes.has(error?.code)
    ? error.code
    : "foreground_e2e_campaign_failed";
  const issues = error?.code === "e2e_configuration_invalid" && Array.isArray(error?.issues)
    ? error.issues.filter((issue) => PUBLIC_CONFIGURATION_ISSUES.includes(issue))
    : [];
  return Object.freeze({ status: "failed", reason_code: reasonCode, issues: Object.freeze(issues) });
}

async function runCaseDriver({ definition, human, runtime, rootCreationsByRootKey, signal }) {
  const creation = (rootKey) => rootCreationsByRootKey[rootKey];
  switch (definition.caseId) {
    case "approved_happy_path":
      return runApprovedHappyPathCase({ definition, human, rootCreation: creation("approved-root"), signal });
    case "plan_rejected_and_replanned":
      return runRejectedPlanAndReplannedCase({ definition, human, rootCreation: creation("rejected-plan-root"), signal });
    case "information_requested_and_answered":
      return runInformationRequestedAndAnsweredCase({ definition, human, rootCreation: creation("information-root"), signal });
    case "root_revision_and_comment":
      return runRootRevisionAndCommentCase({ definition, human, rootCreation: creation("revision-root"), signal });
    case "parallel_multi_conductor":
      return runParallelMultiConductorCase({ definition, human, rootCreationsByRootKey: selectCreations(definition, rootCreationsByRootKey), signal });
    case "same_conductor_preemption":
      return runSameConductorPreemptionCase({ definition, human, rootCreationsByRootKey: selectCreations(definition, rootCreationsByRootKey), signal });
    case "conductor_restart_recovery":
      return runConductorRestartRecoveryCase({ definition, human, runtime, rootCreationsByRootKey: selectCreations(definition, rootCreationsByRootKey), signal });
    case "missing_worktree_recovery":
      return runMissingWorktreeRecoveryCase({ definition, human, runtime, rootCreationsByRootKey: selectCreations(definition, rootCreationsByRootKey), signal });
    default:
      throw stableError("foreground_e2e_case_bindings_invalid");
  }
}

async function readCaseFinalEvidence({ definition, driverResult, human, rootCreationsByRootKey, accessToken, readFinalEvidence }) {
  const createdRoots = human.createdRootsForCase({ caseId: definition.caseId });
  const rootIssueIdsByKey = exactRootIdentityMap(definition, createdRoots);
  const repositories = definition.rootTopology.map(({ rootKey }) => ({
    rootIssueId: rootIssueIdsByKey[rootKey],
    repositoryRoot: path.join(rootCreationsByRootKey[rootKey].worktreeDirectory, rootIssueIdsByKey[rootKey]),
  }));
  const evidence = await readFinalEvidence({
    accessToken,
    caseId: definition.caseId,
    rootIssueIds: Object.values(rootIssueIdsByKey),
    repositories,
  });
  return Object.freeze({
    evidence,
    context: finalContext({ definition, driverResult, humanActorId: human.actorId, rootIssueIdsByKey, repositories, evidence }),
  });
}

function finalContext({ definition, driverResult, humanActorId, rootIssueIdsByKey, repositories, evidence }) {
  const context = driverResult?.context && typeof driverResult.context === "object" ? driverResult.context : {};
  const repositoriesByRootId = new Map(repositories.map((repository) => [repository.rootIssueId, repository.repositoryRoot]));
  const base = {
    ...context,
    humanActorId,
    rootIssueIdsByKey: Object.freeze({ ...rootIssueIdsByKey }),
  };
  if (definition.caseId === "parallel_multi_conductor" && Array.isArray(context.parallel?.roots)) {
    base.parallel = {
      ...context.parallel,
      roots: context.parallel.roots.map((root) => ({
        ...root,
        repositoryRoot: repositoriesByRootId.get(root.rootIssueId),
      })),
    };
  }
  if (definition.caseId === "conductor_restart_recovery" && context.recovery) {
    base.recovery = {
      ...context.recovery,
      affectedRepositoryRoot: repositoriesByRootId.get(context.recovery.affectedRootId),
      continuousRepositoryRoot: repositoriesByRootId.get(context.recovery.continuousRootId),
    };
  }
  if (definition.caseId === "missing_worktree_recovery" && context.missingWorktree) {
    const recoveredGit = evidence?.git?.find(({ rootIssueId }) => rootIssueId === context.missingWorktree.recoverableRootId);
    base.missingWorktree = {
      ...context.missingWorktree,
      rematerializedBranch: recoveredGit?.branch,
      afterRevision: recoveredGit?.headRevision,
    };
  }
  return Object.freeze(base);
}

function conductorBindings(conductors) {
  if (!Array.isArray(conductors) || conductors.length !== CONDUCTOR_REFERENCES.length) {
    throw stableError("foreground_e2e_case_bindings_invalid");
  }
  const bindings = conductors.map((conductor, index) => {
    if (!conductor || !identifier(conductor.conductorId) || !shortHash(conductor.conductorShortHash) ||
        !identifier(conductor.profileId) || !directory(conductor.dataRoot)) {
      throw stableError("foreground_e2e_case_bindings_invalid");
    }
    return Object.freeze({
      conductorRef: CONDUCTOR_REFERENCES[index],
      conductorId: conductor.conductorId,
      conductorShortHash: conductor.conductorShortHash,
      performerProfileId: conductor.profileId,
      worktreeDirectory: path.join(conductor.dataRoot, "worktrees"),
    });
  });
  if (new Set(bindings.map(({ conductorId }) => conductorId)).size !== bindings.length ||
      new Set(bindings.map(({ conductorShortHash }) => conductorShortHash)).size !== bindings.length ||
      new Set(bindings.map(({ performerProfileId }) => performerProfileId)).size !== bindings.length ||
      new Set(bindings.map(({ worktreeDirectory }) => worktreeDirectory)).size !== bindings.length) {
    throw stableError("foreground_e2e_case_bindings_invalid");
  }
  return Object.freeze(bindings);
}

function selectCreations(definition, rootCreationsByRootKey) {
  return Object.freeze(Object.fromEntries(definition.rootTopology.map(({ rootKey }) => [rootKey, rootCreationsByRootKey[rootKey]])));
}

function exactRootIdentityMap(definition, createdRoots) {
  if (!Array.isArray(createdRoots) || createdRoots.length !== definition.rootTopology.length) {
    throw stableError("foreground_e2e_case_root_identity_incomplete");
  }
  const byKey = new Map(createdRoots.map((root) => [root?.rootKey, root?.rootIssueId]));
  if (byKey.size !== definition.rootTopology.length ||
      definition.rootTopology.some(({ rootKey }) => !identifier(byKey.get(rootKey)))) {
    throw stableError("foreground_e2e_case_root_identity_incomplete");
  }
  return Object.freeze(Object.fromEntries(definition.rootTopology.map(({ rootKey }) => [rootKey, byKey.get(rootKey)])));
}

function createCampaignCaseScopeFactory({
  parentSignal,
  now,
  setTimeout,
  clearTimeout,
  deadlineMs,
  rootCreationsByRootKey,
  subscribeUnexpectedExit,
}) {
  return ({ definition }) => {
    const controller = new AbortController();
    let deadlineExceeded = false;
    let processFault;
    const conductorIds = caseConductorIds(definition, rootCreationsByRootKey);
    const onParentAbort = () => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    const deadline = now() + deadlineMs;
    const timer = setTimeout(() => {
      deadlineExceeded = true;
      controller.abort("deadline");
    }, deadlineMs);
    const unsubscribe = subscribeUnexpectedExit((fault) => {
      if (processFault !== undefined || !faultAppliesToCase(fault, conductorIds)) return;
      processFault = fault.reasonCode;
      controller.abort("process_fault");
    });
    if (typeof unsubscribe !== "function") {
      clearTimeout(timer);
      parentSignal.removeEventListener?.("abort", onParentAbort);
      throw stableError("foreground_e2e_process_fault_subscription_invalid");
    }
    return Object.freeze({
      caseId: definition.caseId,
      signal: controller.signal,
      deadlineExceeded: () => deadlineExceeded,
      processFault: () => processFault,
      dispose() {
        clearTimeout(timer);
        parentSignal.removeEventListener?.("abort", onParentAbort);
        unsubscribe();
      },
      deadline,
    });
  };
}

function caseConductorIds(definition, rootCreationsByRootKey) {
  const ids = definition.rootTopology.map(({ rootKey }) => rootCreationsByRootKey[rootKey]?.conductorId);
  if (ids.some((value) => !identifier(value))) {
    throw stableError("foreground_e2e_case_bindings_invalid");
  }
  return new Set(ids);
}

function faultAppliesToCase(fault, conductorIds) {
  if (!fault || typeof fault !== "object" || !identifier(fault.reasonCode)) return false;
  if (fault.component === "podium") return fault.conductorId === undefined && fault.rootIssueId === undefined;
  return (fault.component === "conductor" || fault.component === "performer") && conductorIds.has(fault.conductorId);
}

async function settleInterruptedCases({ signal, setTimeout, clearTimeout, run }) {
  let timer;
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => {
      timer = setTimeout(() => reject(stableError("foreground_e2e_campaign_interrupted")), INTERRUPTED_CASE_SETTLE_GRACE_MS);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(run), interrupted]);
    if (signal.aborted) throw stableError("foreground_e2e_campaign_interrupted");
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertInput({ environment, operations, signals, campaignDeadlineMs }) {
  const required = [
    "loadConfig", "createReporter", "createEnvironment", "createHuman", "runCases", "readFinalEvidence",
    "installSignalCleanup", "runCaseDriver", "randomUUID", "now", "setTimeout", "clearTimeout",
  ];
  if (!environment || typeof environment !== "object" || !operations || typeof operations !== "object" ||
      required.some((key) => typeof operations[key] !== "function") || !signals || typeof signals.once !== "function" ||
      !Number.isSafeInteger(campaignDeadlineMs) || campaignDeadlineMs < 1) {
    throw stableError("foreground_e2e_campaign_input_invalid");
  }
}

function assertEnvironment(value) {
  if (!value || !identifier(value.project?.projectId) || !identifier(value.project?.teamId) || !identifier(value.project?.delegateActorId) ||
      !identifier(value.actors?.humanActorId) || !Array.isArray(value.runtime?.conductors) ||
      typeof value.runtime?.assertProjectRootIndexRequestBudget !== "function" ||
      typeof value.runtime?.subscribeUnexpectedExit !== "function" || typeof value.close !== "function") {
    throw stableError("foreground_e2e_case_bindings_invalid");
  }
}

function assertHuman(value) {
  if (!value || !identifier(value.actorId) || typeof value.resolveRootCreationBindings !== "function" ||
      typeof value.createdRootsForCase !== "function") {
    throw stableError("foreground_e2e_case_bindings_invalid");
  }
}

function assertRootCreationBindings(value) {
  const requiredRoots = FOREGROUND_E2E_CASES.flatMap(({ rootTopology }) => rootTopology.map(({ rootKey }) => rootKey));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== requiredRoots.length || requiredRoots.some((rootKey) => !validCreation(value[rootKey]))) {
    throw stableError("foreground_e2e_case_bindings_invalid");
  }
}

function validCreation(value) {
  return value && identifier(value.teamId) && identifier(value.projectId) && identifier(value.routingLabelId) &&
    identifier(value.rootStatusId) && identifier(value.conductorId) && identifier(value.performerProfileId) &&
    directory(value.worktreeDirectory);
}

function elapsedMilliseconds(startedAt, now) {
  return Number.isFinite(startedAt) && Number.isFinite(now) ? Math.max(0, Math.floor(now - startedAt)) : 0;
}

function reportCleanupFailure(reporter, error) {
  try {
    reporter.failure?.({
      component: "cleanup",
      reasonCode: identifier(error?.code) ? error.code : "foreground_e2e_environment_cleanup_failed",
    });
  } catch {
    // Reporter failures cannot keep an owned test process alive.
  }
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function shortHash(value) {
  return typeof value === "string" && /^[a-f0-9]{12}$/u.test(value);
}

function directory(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\u0000");
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
