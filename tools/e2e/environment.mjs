import { createTargetWorkflowSetup } from "@symphony/podium";

import { resetDedicatedE2EProject, verifyDistinctLinearActors } from "./linear-environment.mjs";
import { createForegroundLocalResources, startForegroundProductionRuntime } from "./runtime-owner.mjs";

export async function createForegroundE2EEnvironment({
  config,
  reporter,
  signal,
  operations = defaultOperations(),
} = {}) {
  assertInput({ config, reporter, signal, operations });
  let resources;
  let runtime;
  let stopWritersPromise;
  let closePromise;
  try {
    reporter.phase("resetting");
    const actors = await operations.verifyActors({ config, signal });
    if (!actors || actors.symphonyActorId === actors.humanActorId) {
      throw stableError("foreground_e2e_actor_identities_not_distinct");
    }
    const project = await operations.initializeProject({ config, signal });
    assertProject(project);
    await operations.resetProject({
      projectId: project.projectId,
      operator: actors.resetClient,
      authorized: config.linear.setupAuthorized,
      signal,
    });
    reporter.phase("starting");
    resources = await operations.createLocalResources({ config, project, signal });
    assertOwner(resources, "foreground_e2e_local_resources_invalid");
    runtime = await operations.startProductionRuntime({ config, project, resources, signal, reporter });
    assertRuntime(runtime, "foreground_e2e_runtime_invalid");
    reporter.phase("ready");
    const stopWriters = () => {
      stopWritersPromise ??= Promise.resolve().then(() => runtime.close()).catch(() => {
        throw stableError("foreground_e2e_environment_writer_stop_failed");
      });
      return stopWritersPromise;
    };
    return Object.freeze({
      project: Object.freeze({ ...project }),
      actors: Object.freeze({ humanActorId: actors.humanActorId }),
      resources: Object.freeze({ directory: resources.directory }),
      runtime: Object.freeze({
        conductors: Object.freeze([...(runtime.conductors ?? [])]),
        assertProjectRootIndexRequestBudget() {
          return runtime.assertProjectRootIndexRequestBudget();
        },
        subscribeUnexpectedExit(listener) {
          return runtime.subscribeUnexpectedExit(listener);
        },
        killAndRestartConductor: runtime.killAndRestartConductor,
        removeRootWorktreesAndRestart: runtime.removeRootWorktreesAndRestart,
      }),
      stopWriters,
      close() {
        closePromise ??= (async () => {
          reporter.phase("cleaning");
          let cleanupFailed = false;
          try {
            await stopWriters();
          } catch {
            cleanupFailed = true;
          }
          try {
            await resources.close();
          } catch {
            cleanupFailed = true;
          }
          if (cleanupFailed) throw stableError("foreground_e2e_environment_cleanup_failed");
        })();
        return closePromise;
      },
    });
  } catch (error) {
    await closeOwners(runtime, resources);
    if (error?.code?.startsWith("foreground_e2e_")) throw error;
    throw stableError("foreground_e2e_environment_start_failed");
  }
}

export function installForegroundE2ESignalCleanup({
  signals = process,
  abortController,
  cleanup,
  reporter,
} = {}) {
  if (!signals || typeof signals.once !== "function" || !abortController ||
      typeof abortController.abort !== "function" || typeof cleanup !== "function" ||
      reporter !== undefined && typeof reporter.signal !== "function") {
    throw stableError("foreground_e2e_signal_cleanup_input_invalid");
  }
  let started = false;
  let resolve;
  const completed = new Promise((resolve_) => { resolve = resolve_; });
  const handle = (signal) => {
    if (started) return;
    started = true;
    reporter?.signal(signal);
    abortController.abort(signal);
    Promise.resolve(cleanup()).catch(() => undefined).finally(resolve);
  };
  const onSigint = () => handle("SIGINT");
  const onSigterm = () => handle("SIGTERM");
  signals.once("SIGINT", onSigint);
  signals.once("SIGTERM", onSigterm);
  return Object.freeze({
    completed,
    dispose() {
      signals.removeListener?.("SIGINT", onSigint);
      signals.removeListener?.("SIGTERM", onSigterm);
      if (!started) resolve();
    },
  });
}

function defaultOperations() {
  return Object.freeze({
    verifyActors: ({ config }) => verifyDistinctLinearActors({
      symphonyAccessToken: config.secrets.linearDevToken,
      humanApiKey: config.secrets.linearHumanApiKey,
    }),
    async initializeProject({ config, signal }) {
      const setup = createTargetWorkflowSetup();
      const result = await setup.initialize({
        developmentToken: config.secrets.linearDevToken,
        clientId: config.linear.clientId,
        projectSlugId: config.linear.projectSlugId,
        authorized: config.linear.setupAuthorized,
        signal,
      });
      if (result?.kind !== "ready") throw stableError("foreground_e2e_project_setup_not_ready");
      return {
        projectId: result.project.projectId,
        teamId: result.teamId,
        delegateActorId: result.delegateActorId,
        organizationId: result.organizationId,
        name: result.project.name,
        updatedAt: result.project.updatedAt,
      };
    },
    resetProject: ({ projectId, operator, authorized }) => resetDedicatedE2EProject({
      projectId,
      client: operator,
      authorized,
    }),
    createLocalResources: () => createForegroundLocalResources(),
    startProductionRuntime: (input) => startForegroundProductionRuntime(input),
  });
}

async function closeOwners(runtime, resources) {
  let runtimeError;
  try {
    await runtime?.close?.();
  } catch (error) {
    runtimeError = error;
  }
  try {
    await resources?.close?.();
  } catch (error) {
    if (!runtimeError) runtimeError = error;
  }
  if (runtimeError) throw stableError("foreground_e2e_environment_cleanup_failed");
}

function assertInput({ config, reporter, signal, operations }) {
  if (!config || typeof config !== "object" || !reporter || typeof reporter.phase !== "function" ||
      signal !== undefined && typeof signal !== "object" || !operations || typeof operations !== "object" ||
      ["verifyActors", "initializeProject", "resetProject", "createLocalResources", "startProductionRuntime"]
        .some((key) => typeof operations[key] !== "function")) {
    throw stableError("foreground_e2e_environment_input_invalid");
  }
}

function assertProject(value) {
  if (!value || !identifier(value.projectId) || !identifier(value.teamId) || !identifier(value.delegateActorId)) {
    throw stableError("foreground_e2e_project_invalid");
  }
}

function assertOwner(value, code) {
  if (!value || typeof value.close !== "function") throw stableError(code);
}

function assertRuntime(value, code) {
  if (!value || typeof value.close !== "function" ||
      typeof value.assertProjectRootIndexRequestBudget !== "function" ||
      typeof value.subscribeUnexpectedExit !== "function") {
    throw stableError(code);
  }
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
