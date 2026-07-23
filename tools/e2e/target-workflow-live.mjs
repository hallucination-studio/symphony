import path from "node:path";

import { createChildEnvironment } from "./config.mjs";
import {
  cleanupTargetRunScope,
  createTargetGitFixture,
  createTargetRunScope,
  readTargetGitObservation,
} from "./target-workflow-fixtures.mjs";
import { runTargetRepairBoundary } from "./target-workflow-repair-boundary.mjs";
import { runTargetDeliveryBoundary } from "./target-workflow-delivery-boundary.mjs";
import { runTargetRestartBoundary } from "./target-workflow-restart-boundary.mjs";
import { runTargetSuccessBoundary } from "./target-workflow-success-boundary.mjs";
import { runTargetSchedulingScenarioLive } from "./target-workflow-scheduling-live.mjs";
import { prepareTargetWorkflowSetup } from "./target-workflow-setup.mjs";
import {
  createTargetWorkflowDeadline,
  remainingTargetWorkflowTimeout,
  rootWorkflowDeadlineAt,
  TARGET_E2E_TIMEOUT_MS,
  withTargetWorkflowDeadline,
} from "./target-workflow-deadline.mjs";

export async function runTargetSuccessLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  observer,
  timeoutMs = TARGET_E2E_TIMEOUT_MS,
  deadlineAtMs: suppliedDeadlineAtMs,
  signal: suppliedSignal,
  dependencies = {},
} = {}) {
  const runId = environment?.SYMPHONY_E2E_RUN_ID;
  validateLiveInput({ config, environment, runId, fetch, log });
  const deadline = suppliedDeadlineAtMs ?? createTargetWorkflowDeadline(timeoutMs);
  const signal = suppliedSignal ?? AbortSignal.timeout(remainingTargetWorkflowTimeout(deadline));
  const services = {
    createScope: dependencies.createScope ?? createTargetRunScope,
    createGitFixture: dependencies.createGitFixture ?? createTargetGitFixture,
    prepareSetup: dependencies.prepareSetup ?? prepareTargetWorkflowSetup,
    runSuccessBoundary: dependencies.runSuccessBoundary ?? runTargetSuccessBoundary,
    cleanupScope: dependencies.cleanupScope ?? cleanupTargetRunScope,
    readGitObservation: dependencies.readGitObservation ?? readTargetGitObservation,
  };
  let scope;
  let failure;
  let result;
  try {
    const prepared = await withTargetWorkflowDeadline(
      () => services.prepareSetup({ config, runId, fetch, log, observer, signal }), deadline,
    );
    const { setup, ids, rootInput } = prepared;
    scope = await withTargetWorkflowDeadline(() => services.createScope({ runId }), deadline);
    const fixture = await withTargetWorkflowDeadline(() => services.createGitFixture({ scope }), deadline);
    const binding = {
      bindingId: ids.bindingId,
      conductorId: ids.conductorId,
      conductorShortHash: ids.conductorShortHash,
      repositoryHandle: ids.repositoryHandle,
      repositoryRoot: fixture.repositoryRoot,
      baseBranch: fixture.baseBranch,
    };
    const childEnvironment = createChildEnvironment({ environment, additions: {
      SYMPHONY_PRIVATE_IPC_FD: "3",
      SYMPHONY_INSTANCE_ID: ids.instanceId,
      SYMPHONY_BINDING_ID: binding.bindingId,
      SYMPHONY_CONDUCTOR_ID: binding.conductorId,
      SYMPHONY_CONDUCTOR_SHORT_HASH: binding.conductorShortHash,
      SYMPHONY_LINEAR_INSTALLATION_ID: `development-token:${setup.organizationId}`,
      SYMPHONY_ORGANIZATION_ID: setup.organizationId,
      SYMPHONY_REPOSITORY_HANDLE: binding.repositoryHandle,
      SYMPHONY_REPOSITORY_ROOT: fixture.repositoryRoot,
      SYMPHONY_BASE_BRANCH: fixture.baseBranch,
      SYMPHONY_CONDUCTOR_DATA_ROOT: scope.conductorDataRoot,
      SYMPHONY_PERFORMER_EXECUTABLE: path.resolve(".venv/bin/performer"),
      SYMPHONY_CODEX_BASE_URL: config.codex.baseUrl,
      SYMPHONY_CYCLE_DELAY_MS: "250",
      SYMPHONY_CYCLE_IDLE_DELAY_MS: "250",
      SYMPHONY_ROOT_DEADLINE_AT: rootWorkflowDeadlineAt(deadline),
    } });
    const observed = await withTargetWorkflowDeadline(() => services.runSuccessBoundary({
      boundaryInput: {
        developmentToken: config.secrets.linearDevToken,
        codexApiKey: config.secrets.codexApiKey,
        databasePath: path.join(scope.appDataRoot, "podium.db"),
        project: setup.project,
        binding,
        delegateActorId: setup.delegateActorId,
        environment: childEnvironment,
        model: config.codex.model,
        fetch,
        log,
        observer,
      },
      successInput: {
        timeoutMs: remainingTargetWorkflowTimeout(deadline),
        onProgress: (event) => log({ event: "target_live_success_progress", ...event }),
        rootInput,
        observationInput: { git: { head: fixture.initialCommit, branch: fixture.baseBranch } },
        pollIntervalMs: 5_000,
        humanResponseBody: "Approved for implementation.",
        readObservationInput: async ({ rootIssueId, phase }) => {
          let git;
          try {
            git = await services.readGitObservation({
              repositoryRoot: fixture.repositoryRoot,
              worktreePath: path.join(scope.conductorDataRoot, "worktrees", rootIssueId),
              requireClean: false,
            });
          } catch (error) {
            if (phase !== "pending_human" ||
                !["target_git_command_failed", "target_git_observation_read_failed"].includes(stableReason(error))) {
              throw error;
            }
            return { git: { head: fixture.initialCommit, branch: fixture.baseBranch } };
          }
          return { git: { head: git.head, branch: git.branch } };
        },
      },
      deadlineAtMs: deadline,
    }), deadline);
    if (!observed?.facts?.root || observed.facts.root.projectId !== setup.project.projectId) {
      throw stableError("target_live_success_result_invalid");
    }
    await withTargetWorkflowDeadline(() => services.readGitObservation({
      repositoryRoot: fixture.repositoryRoot,
      worktreePath: path.join(scope.conductorDataRoot, "worktrees", observed.facts.root.rootIssueId),
      requireClean: true,
    }), deadline);
    result = Object.freeze({
      status: "passed",
      scenario: "success",
      runId,
      rootIssueId: observed.facts.root.rootIssueId,
      projectId: observed.facts.root.projectId,
      facts: observed.facts,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (scope) {
      try {
        await withTargetWorkflowDeadline(() => services.cleanupScope(scope), deadline);
      } catch (error) {
        if (!failure) failure = stableError("target_live_cleanup_failed");
        log({ event: "target_live_cleanup_failed", reason: stableReason(error) });
      }
    }
  }
  if (failure) throw stableError(stableReason(failure));
  return result;
}

export async function runTargetDeliveryLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  observer,
  timeoutMs = TARGET_E2E_TIMEOUT_MS,
  deadlineAtMs: suppliedDeadlineAtMs,
  signal: suppliedSignal,
  dependencies = {},
} = {}) {
  const runId = environment?.SYMPHONY_E2E_RUN_ID;
  validateLiveInput({ config, environment, runId, fetch, log });
  const deadline = suppliedDeadlineAtMs ?? createTargetWorkflowDeadline(timeoutMs);
  const signal = suppliedSignal ?? AbortSignal.timeout(remainingTargetWorkflowTimeout(deadline));
  const services = {
    createScope: dependencies.createScope ?? createTargetRunScope,
    createGitFixture: dependencies.createGitFixture ?? createTargetGitFixture,
    prepareSetup: dependencies.prepareSetup ?? prepareTargetWorkflowSetup,
    runDeliveryBoundary: dependencies.runDeliveryBoundary ?? runTargetDeliveryBoundary,
    cleanupScope: dependencies.cleanupScope ?? cleanupTargetRunScope,
    readGitObservation: dependencies.readGitObservation ?? readTargetGitObservation,
  };
  let scope;
  let failure;
  let result;
  try {
    const prepared = await withTargetWorkflowDeadline(
      () => services.prepareSetup({ config, runId, fetch, log, observer, signal }), deadline,
    );
    const { setup, ids, rootInput } = prepared;
    scope = await withTargetWorkflowDeadline(() => services.createScope({ runId }), deadline);
    const fixture = await withTargetWorkflowDeadline(() => services.createGitFixture({ scope }), deadline);
    const binding = {
      bindingId: ids.bindingId,
      conductorId: ids.conductorId,
      conductorShortHash: ids.conductorShortHash,
      repositoryHandle: ids.repositoryHandle,
      repositoryRoot: fixture.repositoryRoot,
      baseBranch: fixture.baseBranch,
    };
    const childEnvironment = createChildEnvironment({ environment, additions: {
      SYMPHONY_PRIVATE_IPC_FD: "3",
      SYMPHONY_INSTANCE_ID: ids.instanceId,
      SYMPHONY_BINDING_ID: binding.bindingId,
      SYMPHONY_CONDUCTOR_ID: binding.conductorId,
      SYMPHONY_CONDUCTOR_SHORT_HASH: binding.conductorShortHash,
      SYMPHONY_LINEAR_INSTALLATION_ID: `development-token:${setup.organizationId}`,
      SYMPHONY_ORGANIZATION_ID: setup.organizationId,
      SYMPHONY_REPOSITORY_HANDLE: binding.repositoryHandle,
      SYMPHONY_REPOSITORY_ROOT: fixture.repositoryRoot,
      SYMPHONY_BASE_BRANCH: fixture.baseBranch,
      SYMPHONY_CONDUCTOR_DATA_ROOT: scope.conductorDataRoot,
      SYMPHONY_PERFORMER_EXECUTABLE: path.resolve(".venv/bin/performer"),
      SYMPHONY_CODEX_BASE_URL: config.codex.baseUrl,
      SYMPHONY_CYCLE_DELAY_MS: "250",
      SYMPHONY_CYCLE_IDLE_DELAY_MS: "250",
      SYMPHONY_ROOT_DEADLINE_AT: rootWorkflowDeadlineAt(deadline),
    } });
    const observed = await withTargetWorkflowDeadline(() => services.runDeliveryBoundary({
      deadlineAtMs: deadline,
      boundaryInput: {
        developmentToken: config.secrets.linearDevToken,
        codexApiKey: config.secrets.codexApiKey,
        databasePath: path.join(scope.appDataRoot, "podium.db"),
        project: setup.project,
        binding,
        delegateActorId: setup.delegateActorId,
        environment: childEnvironment,
        model: config.codex.model,
        fetch,
        log,
        observer,
      },
      successInput: {
        rootInput: scenarioRootInput(rootInput, "Target live delivery", [
          "Delivery scenario: keep the same single-Work README.md scope and acceptance criteria from the base Root instructions.",
          "After Verify succeeds, leave the verified revision and branch ready for the delivery read-back.",
        ]),
        observationInput: { git: { head: fixture.initialCommit, branch: fixture.baseBranch } },
        humanResponseBody: "Approved for delivery.",
        readObservationInput: async ({ rootIssueId, phase }) => readLiveGitObservation({
          services, fixture, scope, rootIssueId, phase,
        }),
      },
      deliveryInput: ({ success }) => {
        const verify = success?.facts?.stageExecutions?.find((stage) => stage.stage === "verify");
        if (!verify) throw stableError("target_live_delivery_verify_missing");
        return {
          rootIssueId: success.facts.root.rootIssueId,
          projectId: setup.project.projectId,
          verifyIssueId: verify.nodeIssueId,
          verifiedRevision: verify.gitHead,
          observationInput: { git: { head: verify.gitHead, branch: fixture.baseBranch } },
        };
      },
      deadlineAtMs: deadline,
    }), deadline);
    if (!observed?.success?.facts?.root || !observed.delivery?.delivery) {
      throw stableError("target_live_delivery_result_invalid");
    }
    result = Object.freeze({
      status: "passed",
      scenario: "delivery",
      runId,
      rootIssueId: observed.success.facts.root.rootIssueId,
      projectId: setup.project.projectId,
      facts: observed.success.facts,
      delivery: observed.delivery.delivery,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (scope) {
      try {
        await withTargetWorkflowDeadline(() => services.cleanupScope(scope), deadline);
      } catch (error) {
        if (!failure) failure = stableError("target_live_cleanup_failed");
        log({ event: "target_live_cleanup_failed", reason: stableReason(error) });
      }
    }
  }
  if (failure) throw stableError(stableReason(failure));
  return result;
}

export async function runTargetRepairLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  observer,
  timeoutMs = TARGET_E2E_TIMEOUT_MS,
  deadlineAtMs: suppliedDeadlineAtMs,
  signal: suppliedSignal,
  dependencies = {},
} = {}) {
  const runId = environment?.SYMPHONY_E2E_RUN_ID;
  validateLiveInput({ config, environment, runId, fetch, log });
  const deadline = suppliedDeadlineAtMs ?? createTargetWorkflowDeadline(timeoutMs);
  const signal = suppliedSignal ?? AbortSignal.timeout(remainingTargetWorkflowTimeout(deadline));
  const services = {
    createScope: dependencies.createScope ?? createTargetRunScope,
    createGitFixture: dependencies.createGitFixture ?? createTargetGitFixture,
    prepareSetup: dependencies.prepareSetup ?? prepareTargetWorkflowSetup,
    runRepairBoundary: dependencies.runRepairBoundary ?? runTargetRepairBoundary,
    cleanupScope: dependencies.cleanupScope ?? cleanupTargetRunScope,
    readGitObservation: dependencies.readGitObservation ?? readTargetGitObservation,
  };
  let scope;
  let failure;
  let result;
  try {
    const prepared = await withTargetWorkflowDeadline(
      () => services.prepareSetup({ config, runId, fetch, log, observer, signal }), deadline,
    );
    const { setup, ids, rootInput } = prepared;
    scope = await withTargetWorkflowDeadline(() => services.createScope({ runId }), deadline);
    const fixture = await withTargetWorkflowDeadline(() => services.createGitFixture({ scope }), deadline);
    const binding = {
      bindingId: ids.bindingId,
      conductorId: ids.conductorId,
      conductorShortHash: ids.conductorShortHash,
      repositoryHandle: ids.repositoryHandle,
      repositoryRoot: fixture.repositoryRoot,
      baseBranch: fixture.baseBranch,
    };
    const childEnvironment = createChildEnvironment({ environment, additions: {
      SYMPHONY_PRIVATE_IPC_FD: "3",
      SYMPHONY_INSTANCE_ID: ids.instanceId,
      SYMPHONY_BINDING_ID: binding.bindingId,
      SYMPHONY_CONDUCTOR_ID: binding.conductorId,
      SYMPHONY_CONDUCTOR_SHORT_HASH: binding.conductorShortHash,
      SYMPHONY_LINEAR_INSTALLATION_ID: `development-token:${setup.organizationId}`,
      SYMPHONY_ORGANIZATION_ID: setup.organizationId,
      SYMPHONY_REPOSITORY_HANDLE: binding.repositoryHandle,
      SYMPHONY_REPOSITORY_ROOT: fixture.repositoryRoot,
      SYMPHONY_BASE_BRANCH: fixture.baseBranch,
      SYMPHONY_CONDUCTOR_DATA_ROOT: scope.conductorDataRoot,
      SYMPHONY_PERFORMER_EXECUTABLE: path.resolve(".venv/bin/performer"),
      SYMPHONY_CODEX_BASE_URL: config.codex.baseUrl,
      SYMPHONY_CYCLE_DELAY_MS: "250",
      SYMPHONY_CYCLE_IDLE_DELAY_MS: "250",
      SYMPHONY_ROOT_DEADLINE_AT: rootWorkflowDeadlineAt(deadline),
    } });
    const observed = await withTargetWorkflowDeadline(() => services.runRepairBoundary({
      boundaryInput: {
        developmentToken: config.secrets.linearDevToken,
        codexApiKey: config.secrets.codexApiKey,
        databasePath: path.join(scope.appDataRoot, "podium.db"),
        project: setup.project,
        binding,
        delegateActorId: setup.delegateActorId,
        environment: childEnvironment,
        model: config.codex.model,
        fetch,
        log,
        observer,
      },
      repairInput: {
        timeoutMs: remainingTargetWorkflowTimeout(deadline),
        rootInput: scenarioRootInput(rootInput, "Target live repair escalation", [
          "Repair scenario: Plan exactly one Work node for README.md, but deliberately leave its acceptance criterion unmet by not adding the evidence line.",
          "Verify must record one open Finding that the required README.md evidence line is absent. Do not resolve that Finding or change the repository to satisfy it; preserve the same open Finding through repeated approved repair cycles so Conductor's convergence limit escalates it.",
        ], { stripSuccessInstruction: true, prepend: true }),
        observationInput: { git: { head: fixture.initialCommit, branch: fixture.baseBranch } },
        humanResponseBody: "Approved for repair escalation.",
        readObservationInput: async ({ rootIssueId, phase }) => {
          let git;
          try {
            git = await services.readGitObservation({
              repositoryRoot: fixture.repositoryRoot,
              worktreePath: path.join(scope.conductorDataRoot, "worktrees", rootIssueId),
              requireClean: false,
            });
          } catch (error) {
            if (!["pending_human", "durable_facts"].includes(phase) ||
                !["target_git_command_failed", "target_git_observation_read_failed"].includes(stableReason(error))) {
              throw error;
            }
            return { git: { head: fixture.initialCommit, branch: fixture.baseBranch } };
          }
          return { git: { head: git.head, branch: git.branch } };
        },
      },
      deadlineAtMs: deadline,
    }), deadline);
    if (!observed?.facts?.root || observed.facts.root.projectId !== setup.project.projectId ||
        !observed.facts.repairEscalation) {
      throw stableError("target_live_repair_result_invalid");
    }
    result = Object.freeze({
      status: "passed",
      scenario: "repair_escalation",
      runId,
      rootIssueId: observed.facts.root.rootIssueId,
      projectId: observed.facts.root.projectId,
      facts: observed.facts,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (scope) {
      try {
        await withTargetWorkflowDeadline(() => services.cleanupScope(scope), deadline);
      } catch (error) {
        if (!failure) failure = stableError("target_live_cleanup_failed");
        log({ event: "target_live_cleanup_failed", reason: stableReason(error) });
      }
    }
  }
  if (failure) throw stableError(stableReason(failure));
  return result;
}

export async function runTargetRestartLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  observer,
  timeoutMs = TARGET_E2E_TIMEOUT_MS,
  deadlineAtMs: suppliedDeadlineAtMs,
  signal: suppliedSignal,
  dependencies = {},
} = {}) {
  const runId = environment?.SYMPHONY_E2E_RUN_ID;
  validateLiveInput({ config, environment, runId, fetch, log });
  const deadline = suppliedDeadlineAtMs ?? createTargetWorkflowDeadline(timeoutMs);
  const signal = suppliedSignal ?? AbortSignal.timeout(remainingTargetWorkflowTimeout(deadline));
  const services = {
    createScope: dependencies.createScope ?? createTargetRunScope,
    createGitFixture: dependencies.createGitFixture ?? createTargetGitFixture,
    prepareSetup: dependencies.prepareSetup ?? prepareTargetWorkflowSetup,
    runRestartBoundary: dependencies.runRestartBoundary ?? runTargetRestartBoundary,
    cleanupScope: dependencies.cleanupScope ?? cleanupTargetRunScope,
    readGitObservation: dependencies.readGitObservation ?? readTargetGitObservation,
  };
  let scope;
  let failure;
  let result;
  try {
    const prepared = await withTargetWorkflowDeadline(
      () => services.prepareSetup({ config, runId, fetch, log, observer, signal }), deadline,
    );
    const { setup, ids, rootInput } = prepared;
    scope = await withTargetWorkflowDeadline(() => services.createScope({ runId }), deadline);
    const fixture = await withTargetWorkflowDeadline(() => services.createGitFixture({ scope }), deadline);
    const binding = {
      bindingId: ids.bindingId,
      conductorId: ids.conductorId,
      conductorShortHash: ids.conductorShortHash,
      repositoryHandle: ids.repositoryHandle,
      repositoryRoot: fixture.repositoryRoot,
      baseBranch: fixture.baseBranch,
    };
    const childEnvironment = createChildEnvironment({ environment, additions: {
      SYMPHONY_PRIVATE_IPC_FD: "3",
      SYMPHONY_INSTANCE_ID: ids.instanceId,
      SYMPHONY_BINDING_ID: binding.bindingId,
      SYMPHONY_CONDUCTOR_ID: binding.conductorId,
      SYMPHONY_CONDUCTOR_SHORT_HASH: binding.conductorShortHash,
      SYMPHONY_LINEAR_INSTALLATION_ID: `development-token:${setup.organizationId}`,
      SYMPHONY_ORGANIZATION_ID: setup.organizationId,
      SYMPHONY_REPOSITORY_HANDLE: binding.repositoryHandle,
      SYMPHONY_REPOSITORY_ROOT: fixture.repositoryRoot,
      SYMPHONY_BASE_BRANCH: fixture.baseBranch,
      SYMPHONY_CONDUCTOR_DATA_ROOT: scope.conductorDataRoot,
      SYMPHONY_PERFORMER_EXECUTABLE: path.resolve(".venv/bin/performer"),
      SYMPHONY_CODEX_BASE_URL: config.codex.baseUrl,
      SYMPHONY_CYCLE_DELAY_MS: "250",
      SYMPHONY_CYCLE_IDLE_DELAY_MS: "250",
      SYMPHONY_ROOT_DEADLINE_AT: rootWorkflowDeadlineAt(deadline),
    } });
    const observed = await withTargetWorkflowDeadline(() => services.runRestartBoundary({
      boundaryInput: {
        developmentToken: config.secrets.linearDevToken,
        codexApiKey: config.secrets.codexApiKey,
        databasePath: path.join(scope.appDataRoot, "podium.db"),
        project: setup.project,
        binding,
        delegateActorId: setup.delegateActorId,
        environment: childEnvironment,
        model: config.codex.model,
        fetch,
        log,
        observer,
      },
      restartInput: {
        timeoutMs: remainingTargetWorkflowTimeout(deadline),
        rootInput: scenarioRootInput(rootInput, "Target live restart recovery", [
          "Restart scenario: use the same single-Work README.md scope and acceptance criteria from the base Root instructions.",
          "The workflow must be recoverable from a Conductor restart and must continue from durable Linear and Git facts using a fresh Performer context.",
        ]),
        observationInput: { git: { head: fixture.initialCommit, branch: fixture.baseBranch } },
        humanResponseBody: "Approved after restart recovery.",
        readObservationInput: async ({ rootIssueId, phase }) => readLiveGitObservation({
          services, fixture, scope, rootIssueId, phase,
        }),
      },
      deadlineAtMs: deadline,
    }), deadline);
    if (!observed?.facts?.root || observed.facts.root.projectId !== setup.project.projectId || !observed.recovery) {
      throw stableError("target_live_restart_result_invalid");
    }
    result = Object.freeze({
      status: "passed",
      scenario: "restart_recovery",
      runId,
      rootIssueId: observed.facts.root.rootIssueId,
      projectId: setup.project.projectId,
      facts: observed.facts,
      recovery: observed.recovery,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (scope) {
      try {
        await withTargetWorkflowDeadline(() => services.cleanupScope(scope), deadline);
      } catch (error) {
        if (!failure) failure = stableError("target_live_cleanup_failed");
        log({ event: "target_live_cleanup_failed", reason: stableReason(error) });
      }
    }
  }
  if (failure) throw stableError(stableReason(failure));
  return result;
}

export async function runTargetSchedulingLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  observer,
  timeoutMs = TARGET_E2E_TIMEOUT_MS,
  deadlineAtMs: suppliedDeadlineAtMs,
  signal: suppliedSignal,
  dependencies = {},
} = {}) {
  const runId = environment?.SYMPHONY_E2E_RUN_ID;
  validateLiveInput({ config, environment, runId, fetch, log });
  const deadline = suppliedDeadlineAtMs ?? createTargetWorkflowDeadline(timeoutMs);
  const signal = suppliedSignal ?? AbortSignal.timeout(remainingTargetWorkflowTimeout(deadline));
  const prepared = await withTargetWorkflowDeadline(
    () => (dependencies.prepareSetup ?? prepareTargetWorkflowSetup)({ config, runId, fetch, log, observer, signal }),
    deadline,
  );
  return withTargetWorkflowDeadline(() => runTargetSchedulingScenarioLive({
    config: {
      ...config,
      linear: {
        ...config.linear,
        projectSlugId: prepared.setup.project.projectId,
        delegateActorId: prepared.setup.delegateActorId,
        conductorId: prepared.ids.conductorId,
      },
    },
    environment,
    fetch,
    log,
    observer,
    signal,
  }), deadline);
}

async function readLiveGitObservation({ services, fixture, scope, rootIssueId, phase }) {
  try {
    const git = await services.readGitObservation({
      repositoryRoot: fixture.repositoryRoot,
      worktreePath: path.join(scope.conductorDataRoot, "worktrees", rootIssueId),
    });
    return { git: { head: git.head, branch: git.branch } };
  } catch (error) {
    if (phase !== "pending_human" || !["target_git_command_failed", "target_git_observation_read_failed"].includes(stableReason(error))) {
      throw error;
    }
    return { git: { head: fixture.initialCommit, branch: fixture.baseBranch } };
  }
}

function validateLiveInput({ config, environment, runId, fetch, log }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId ?? "") || !config?.linear ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(config.linear.clientId ?? "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(config.linear.projectSlugId ?? "") ||
      typeof config.linear.setupAuthorized !== "boolean" ||
      typeof config.secrets?.linearDevToken !== "string" ||
      config.secrets.linearDevToken.length === 0 || typeof config.secrets.codexApiKey !== "string" ||
      config.secrets.codexApiKey.length === 0 || typeof config.codex?.baseUrl !== "string" ||
      typeof config.codex.model !== "string" || typeof fetch !== "function" || typeof log !== "function" ||
      !environment || typeof environment !== "object") {
    throw stableError(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId ?? "")
      ? "target_live_run_id_invalid"
      : "target_live_input_invalid");
  }
}

function scenarioRootInput(rootInput, title, instructions, options = {}) {
  if (!rootInput || typeof rootInput !== "object" || typeof rootInput.description !== "string" ||
      !Array.isArray(instructions) || instructions.some((item) => typeof item !== "string" || item.length === 0)) {
    throw stableError("target_live_root_input_invalid");
  }
  const baseDescription = options.stripSuccessInstruction === true
    ? rootInput.description.replace(
      /Plan exactly one minimal Work node that adds one E2E evidence line to README\.md, then Verify it\.\s*/u,
      "",
    )
    : rootInput.description;
  const scenarioDescription = instructions.join(" ");
  return {
    ...rootInput,
    title,
    description: options.prepend === true
      ? `${scenarioDescription}\n\n${baseDescription}`
      : `${baseDescription}\n\n${scenarioDescription}`,
  };
}

function stableReason(error) {
  const reason = error instanceof Error ? error.message : "target_live_failed";
  return /^[a-z][a-z0-9_]{1,120}$/u.test(reason) ? reason : "target_live_failed";
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
