import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, constants, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { bootstrapDevelopmentTokenInstallation } from "@symphony/podium";

import {
  isForwardableConductorRuntimeEvent,
  isKnownConductorRuntimeLogEvent,
} from "./reporter.mjs";

const execFile = promisify(execFileCallback);
const REPOSITORY_COUNT = 3;
const MAX_FRAME_BYTES = 1_048_576;
const PROFILE_READINESS_ATTEMPTS = 10;
const GRACEFUL_STOP_TIMEOUT_MS = 5_000;
const PROJECT_ROOT_INDEX_OPERATION = "SymphonyProjectRootIndex";
const PROJECT_ROOT_INDEX_CONTINUATION_OPERATION = "SymphonyProjectRootIndexContinuation";
const BINDING_FENCE_READY_FD = 4;
const BINDING_FENCE_HOLDER = String.raw`
import fcntl, os, sys
lock_path, ready_fd_text = sys.argv[1:3]
ready_fd = int(ready_fd_text)
lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    os.write(ready_fd, b"locked\n")
    sys.exit(73)
os.write(ready_fd, b"ready\n")
os.close(ready_fd)
while os.read(0, 1):
    pass
`;
const BINDING_FENCE_EXEC = String.raw`
import fcntl, os, sys
lock_path, ready_fd_text, executable, *arguments = sys.argv[1:]
ready_fd = int(ready_fd_text)
lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    os.write(ready_fd, b"locked\n")
    sys.exit(73)
os.set_inheritable(lock_fd, True)
os.environ["SYMPHONY_BINDING_FENCE_FD"] = str(lock_fd)
os.write(ready_fd, b"ready\n")
os.close(ready_fd)
os.execvpe(executable, [executable, *arguments], os.environ)
`;

export function createProjectRootIndexRequestBudget({ installationId, projectId } = {}) {
  if (!identifier(installationId) || !identifier(projectId)) {
    throw stableError("foreground_e2e_project_root_index_request_budget_input_invalid");
  }
  let normalPhysicalRequests = 0;
  let fallbackPhysicalRequests = 0;
  let observationInvalid = false;
  const correlations = new Set();
  return Object.freeze({
    observe(value) {
      if (!value || typeof value !== "object" || Array.isArray(value) || value.event !== "linear_physical_request") return;
      if (value.operation !== PROJECT_ROOT_INDEX_OPERATION && value.operation !== PROJECT_ROOT_INDEX_CONTINUATION_OPERATION) return;
      if (!identifier(value.correlation_id) || !identifier(value.installation_id) || !identifier(value.project_id)) {
        observationInvalid = true;
        return;
      }
      if (value.installation_id !== installationId || value.project_id !== projectId) return;
      if (correlations.has(value.correlation_id)) {
        observationInvalid = true;
        return;
      }
      correlations.add(value.correlation_id);
      if (value.operation === PROJECT_ROOT_INDEX_OPERATION) normalPhysicalRequests += 1;
      else fallbackPhysicalRequests += 1;
    },
    snapshot() {
      return Object.freeze({ normalPhysicalRequests, fallbackPhysicalRequests });
    },
    assertWithinBudget() {
      if (observationInvalid || normalPhysicalRequests === 0) {
        throw stableError("foreground_e2e_project_root_index_request_observation_incomplete");
      }
      if (normalPhysicalRequests > 1 || fallbackPhysicalRequests > 1) {
        throw stableError("foreground_e2e_project_root_index_request_budget_exceeded");
      }
      return this.snapshot();
    },
  });
}

export function createPodiumEnvironment({ config, resources, environment = process.env } = {}) {
  assertRuntimeInput({ config, resources });
  return Object.freeze({
    ...baseChildEnvironment(environment),
    SYMPHONY_PODIUM_DATA_ROOT: resources.podiumDataRoot,
    SYMPHONY_CONDUCTOR_IPC_FD: "3",
    SYMPHONY_HOST_IPC_FD: "4",
    SYMPHONY_LINEAR_CLIENT_ID: config.linear.clientId,
    SYMPHONY_LINEAR_CLIENT_SECRET: config.secrets.linearClientSecret,
  });
}

export function createConductorEnvironment({ config, resources, conductor, environment = process.env } = {}) {
  assertRuntimeInput({ config, resources });
  if (!conductor || !identifier(conductor.bindingId) || !identifier(conductor.conductorId) ||
      !shortHash(conductor.conductorShortHash) || !identifier(conductor.linearInstallationId) ||
      !identifier(conductor.organizationId) || !identifier(conductor.repositoryHandle) ||
      typeof conductor.repositoryIdentity !== "string" || conductor.repositoryIdentity.length === 0 ||
      !boundedPath(conductor.repositoryRoot) || !branch(conductor.baseBranch) ||
      !boundedPath(conductor.dataRoot) || !identifier(conductor.instanceId)) {
    throw stableError("foreground_e2e_conductor_environment_invalid");
  }
  return Object.freeze({
    ...baseChildEnvironment(environment),
    SYMPHONY_PRIVATE_IPC_FD: "3",
    SYMPHONY_INSTANCE_ID: conductor.instanceId,
    SYMPHONY_BINDING_ID: conductor.bindingId,
    SYMPHONY_CONDUCTOR_ID: conductor.conductorId,
    SYMPHONY_CONDUCTOR_SHORT_HASH: conductor.conductorShortHash,
    SYMPHONY_LINEAR_INSTALLATION_ID: conductor.linearInstallationId,
    SYMPHONY_ORGANIZATION_ID: conductor.organizationId,
    SYMPHONY_REPOSITORY_HANDLE: conductor.repositoryHandle,
    SYMPHONY_REPOSITORY_IDENTITY: conductor.repositoryIdentity,
    SYMPHONY_REPOSITORY_ROOT: conductor.repositoryRoot,
    SYMPHONY_BASE_BRANCH: conductor.baseBranch,
    SYMPHONY_CONDUCTOR_DATA_ROOT: conductor.dataRoot,
    SYMPHONY_PERFORMER_EXECUTABLE: resources.performer,
    SYMPHONY_CODEX_BASE_URL: config.codex.baseUrl,
    SYMPHONY_ROOT_DEADLINE_DURATION_MS: "300000",
    SYMPHONY_ROOT_MAX_CYCLES_PER_ROOT: "3",
    SYMPHONY_ROOT_MAX_SAME_OPEN_FINDING_CYCLES: "2",
    SYMPHONY_ROOT_MAX_CONSECUTIVE_NO_PROGRESS: "3",
    SYMPHONY_ROOT_MAX_CYCLE_REPAIR_ATTEMPTS: "0",
  });
}

export async function startForegroundProductionRuntime({
  config,
  project,
  resources,
  reporter,
  environment = process.env,
  bootstrap = bootstrapDevelopmentTokenInstallation,
  spawn = spawnProcess,
  wait = delay,
} = {}) {
  assertRuntimeInput({ config, resources });
  if (!project || !identifier(project.projectId) || !identifier(project.delegateActorId) ||
      typeof project.name !== "string" || project.name.length === 0 || !timestamp(project.updatedAt) ||
      typeof bootstrap !== "function" || typeof spawn !== "function" || typeof wait !== "function" ||
      reporter !== undefined && (typeof reporter.childExit !== "function" || typeof reporter.failure !== "function")) {
    throw stableError("foreground_e2e_runtime_input_invalid");
  }
  const databasePath = path.join(resources.podiumDataRoot, "podium.db");
  let podium;
  let host;
  let conductors = [];
  let closed = false;
  const unexpectedExits = createUnexpectedExitRegistry();
  try {
    const installation = await bootstrap({
      databasePath,
      developmentToken: config.secrets.linearDevToken,
      delegateActorId: project.delegateActorId,
      targetProject: {
        projectId: project.projectId,
        name: project.name,
        updatedAt: project.updatedAt,
      },
    });
    if (!installation || !identifier(installation.installationId) || !identifier(installation.organizationId)) {
      throw stableError("foreground_e2e_installation_invalid");
    }
    podium = await startPodiumBackend({
      config,
      project,
      installation,
      resources,
      environment,
      spawn,
      reporter,
      onUnexpectedExit: unexpectedExits.report,
    });
    host = createDesktopHost({
      podiumChannel: podium.conductorChannel,
      hostChannel: podium.hostChannel,
      config,
      resources,
      installation,
      environment,
      spawn,
      reporter,
      onUnexpectedExit: unexpectedExits.report,
    });
    podium.hostChannel.setHandler(host.handle);
    conductors = await startConfiguredConductors({
      repositories: resources.repositories,
      client: podium.client,
      host,
      projectId: project.projectId,
      installation,
      config,
      wait,
      onRunning: (conductor) => conductors.push(conductor),
    });
    return Object.freeze({
      conductors: Object.freeze(conductors),
      assertProjectRootIndexRequestBudget() {
        return podium.requestBudget.assertWithinBudget();
      },
      subscribeUnexpectedExit(listener) {
        return unexpectedExits.subscribe(listener);
      },
      async killAndRestartConductor({ conductorId } = {}) {
        if (!identifier(conductorId)) throw stableError("foreground_e2e_recovery_restart_input_invalid");
        await host.killAndObserveConductor({ conductorId });
        const result = await podium.client.command({ kind: "start_conductor", conductor_id: conductorId });
        if (result?.kind !== "conductor_command_completed" || result.conductor_id !== conductorId || result.command_kind !== "start_conductor") {
          throw stableError("foreground_e2e_recovery_restart_failed");
        }
        return Object.freeze({ conductorId });
      },
      async removeRootWorktreesAndRestart({ faults } = {}) {
        return removeExactRootWorktreesAndRestart({
          faults,
          runtimeRoot: path.join(resources.podiumDataRoot, "runtime"),
          stopConductor: (input) => host.killAndObserveConductor(input),
          async restartConductor({ conductorId: stoppedConductorId }) {
            const result = await podium.client.command({ kind: "start_conductor", conductor_id: stoppedConductorId });
            if (result?.kind !== "conductor_command_completed" || result.conductor_id !== stoppedConductorId ||
                result.command_kind !== "start_conductor") {
              throw stableError("foreground_e2e_missing_worktree_fault_restart_failed");
            }
            return Object.freeze({ conductorId: stoppedConductorId });
          },
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        await closeForegroundProductionRuntime({ podium, host, conductors, reporter });
      },
    });
  } catch (error) {
    reporter?.failure({ component: "runtime", reasonCode: runtimeFailureReason(error) });
    await closeForegroundProductionRuntime({ podium, host, conductors, reporter });
    if (error?.code?.startsWith("foreground_e2e_")) throw error;
    throw stableError("foreground_e2e_runtime_start_failed");
  }
}

export async function startConfiguredConductors({
  repositories,
  client,
  host,
  projectId,
  installation,
  config,
  wait = delay,
  provision = provisionProfile,
  onRunning,
} = {}) {
  if (!Array.isArray(repositories) || repositories.length !== REPOSITORY_COUNT ||
      !repositories.every((repository) => repository && identifier(repository.repositoryHandle) &&
        typeof repository.repositoryIdentity === "string" && boundedPath(repository.repositoryRoot) &&
        branch(repository.baseBranch) && typeof repository.repositoryDisplayName === "string") ||
      !client || typeof client.command !== "function" || !host || typeof host.runningConductor !== "function" ||
      !identifier(projectId) || !installation || !identifier(installation.installationId) ||
      !identifier(installation.organizationId) || !config || typeof config !== "object" ||
      typeof wait !== "function" || typeof provision !== "function" ||
      onRunning !== undefined && typeof onRunning !== "function") {
    throw stableError("foreground_e2e_conductor_start_input_invalid");
  }

  const bindings = [];
  for (const repository of repositories) {
    const created = await client.command({
      kind: "create_conductor",
      project_id: projectId,
      repository: {
        repository_handle: repository.repositoryHandle,
        display_name: repository.repositoryDisplayName,
        base_branch: repository.baseBranch,
      },
    });
    bindings.push(createdConductor(created, repository, installation));
  }

  const running = await Promise.all(bindings.map(async (conductor) => {
    const started = await client.command({ kind: "start_conductor", conductor_id: conductor.conductorId });
    if (!started || typeof started !== "object" || started.kind !== "conductor_command_completed" ||
        started.conductor_id !== conductor.conductorId || started.command_kind !== "start_conductor") {
      throw stableError("foreground_e2e_conductor_start_invalid");
    }
    const active = host.runningConductor({ conductorId: conductor.conductorId });
    if (!active || !boundedPath(active.dataRoot)) {
      throw stableError("foreground_e2e_conductor_start_invalid");
    }
    const value = Object.freeze({ ...conductor, dataRoot: active.dataRoot });
    onRunning?.(value);
    return value;
  }));
  const profiles = await Promise.all(running.map((conductor) => provision({ client, conductor, config, wait })));
  return Object.freeze(running.map((conductor, index) => {
    const profile = profiles[index];
    if (!profile || !identifier(profile.profileId)) {
      throw stableError("foreground_e2e_profile_activation_invalid");
    }
    return Object.freeze({ ...conductor, profileId: profile.profileId });
  }));
}

export async function closeOwnedProcess(child, { timeoutMs = 5_000 } = {}) {
  if (!child || typeof child !== "object" || child.pid === undefined || child.pid === null) return;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw stableError("foreground_e2e_process_timeout_invalid");
  if (child.exitCode !== null || child.signalCode !== null) return;
  terminate(child, "SIGTERM");
  if (await exited(child, timeoutMs)) return;
  terminate(child, "SIGKILL");
  if (!await exited(child, timeoutMs)) {
    throw stableError("foreground_e2e_process_cleanup_failed");
  }
}

export async function forceKillOwnedProcess(child, { timeoutMs = 5_000 } = {}) {
  if (!child || typeof child !== "object" || child.pid === undefined || child.pid === null) return;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw stableError("foreground_e2e_process_timeout_invalid");
  if (child.exitCode !== null || child.signalCode !== null) return;
  terminate(child, "SIGKILL");
  if (!await exited(child, timeoutMs)) throw stableError("foreground_e2e_process_kill_failed");
}

export async function acquireForegroundBindingProcessFence({
  runtimeRoot,
  bindingId,
  spawn = spawnProcess,
} = {}) {
  if (process.platform === "win32" || !boundedPath(runtimeRoot) || !identifier(bindingId) || typeof spawn !== "function") {
    throw stableError("foreground_e2e_binding_process_fence_input_invalid");
  }
  const lockPath = await bindingProcessFencePath(runtimeRoot, bindingId);
  const child = spawn("python3", ["-c", BINDING_FENCE_HOLDER, lockPath, "3"], {
    env: baseChildEnvironment(process.env),
    stdio: ["pipe", "ignore", "ignore", "pipe"],
  });
  try {
    await bindingFenceReady(child, child.stdio?.[3]);
  } catch (error) {
    await closeOwnedProcess(child).catch(() => undefined);
    throw error;
  }
  let closed = false;
  return Object.freeze({
    bindingId,
    async close() {
      if (closed) return;
      closed = true;
      child.stdin?.end();
      await closeOwnedProcess(child);
    },
  });
}

export async function removeExactRootWorktreesAndRestart({
  faults,
  runtimeRoot,
  stopConductor,
  restartConductor,
  runGit = git,
  acquireFence = acquireForegroundBindingProcessFence,
  now = () => new Date().toISOString(),
} = {}) {
  if (!validMissingWorktreeFaults(faults) || !boundedPath(runtimeRoot) ||
      typeof stopConductor !== "function" || typeof restartConductor !== "function" ||
      typeof runGit !== "function" || typeof acquireFence !== "function" || typeof now !== "function") {
    throw stableError("foreground_e2e_missing_worktree_fault_input_invalid");
  }
  const conductors = await Promise.all(faults.map(({ conductorId }) => stopConductor({ conductorId })));
  if (conductors.some((conductor, index) => !conductor || conductor.conductorId !== faults[index].conductorId ||
      !identifier(conductor.bindingId) || !boundedPath(conductor.repositoryRoot) || !boundedPath(conductor.dataRoot)) ||
      new Set(conductors.map(({ bindingId }) => bindingId)).size !== faults.length) {
    throw stableError("foreground_e2e_missing_worktree_fault_stop_invalid");
  }
  const fences = [];
  let evidence = [];
  try {
    for (const conductor of conductors) {
      fences.push(await acquireFence({ runtimeRoot, bindingId: conductor.bindingId }));
    }
    evidence = await Promise.all(faults.map((fault, index) => removeExactRootWorktree({
      repositoryRoot: conductors[index].repositoryRoot,
      worktreeRoot: path.join(conductors[index].dataRoot, "worktrees"),
      rootIssueId: fault.rootIssueId,
      rootIdentifier: fault.rootIdentifier,
      invalidateExecutionBranch: fault.invalidateExecutionBranch,
      runGit,
    })));
    const removedAt = now();
    if (!timestamp(removedAt)) throw stableError("foreground_e2e_missing_worktree_fault_observation_invalid");
    evidence = evidence.map((item) => Object.freeze({ ...item, removedAt }));
  } finally {
    await Promise.allSettled(fences.map((fence) => fence.close()));
  }
  const restarted = await Promise.all(faults.map(({ conductorId }) => restartConductor({ conductorId })));
  if (restarted.some((result, index) => result?.conductorId !== faults[index].conductorId)) {
    throw stableError("foreground_e2e_missing_worktree_fault_restart_invalid");
  }
  return Object.freeze({
    faults: Object.freeze(faults.map((fault, index) => Object.freeze({ ...fault, ...evidence[index] }))),
  });
}

function validMissingWorktreeFaults(faults) {
  return Array.isArray(faults) && faults.length === 2 &&
    faults.every((fault) => fault && identifier(fault.conductorId) && safePathSegment(fault.rootIssueId) &&
      safeRootIdentifier(fault.rootIdentifier) && typeof fault.invalidateExecutionBranch === "boolean") &&
    new Set(faults.map(({ conductorId }) => conductorId)).size === faults.length &&
    new Set(faults.map(({ rootIssueId }) => rootIssueId)).size === faults.length &&
    faults.filter(({ invalidateExecutionBranch }) => invalidateExecutionBranch).length === 1;
}

async function removeExactRootWorktree({
  repositoryRoot,
  worktreeRoot,
  rootIssueId,
  rootIdentifier,
  invalidateExecutionBranch,
  runGit,
}) {
  const expectedRepository = await canonicalExistingPath(repositoryRoot, "foreground_e2e_missing_worktree_repository_invalid");
  const canonicalWorktreeRoot = await canonicalExistingPath(worktreeRoot, "foreground_e2e_missing_worktree_identity_invalid");
  const expectedWorktree = path.join(canonicalWorktreeRoot, rootIssueId);
  const canonicalWorktree = await canonicalExistingPath(expectedWorktree, "foreground_e2e_missing_worktree_identity_invalid");
  if (canonicalWorktree !== expectedWorktree) {
    throw stableError("foreground_e2e_missing_worktree_identity_invalid");
  }
  const branchName = `symphony/runs/${rootIdentifier.toLowerCase()}`;
  let topLevel;
  let commonDirectory;
  let actualBranch;
  let headRevision;
  let status;
  try {
    [topLevel, commonDirectory, actualBranch, headRevision, status] = await Promise.all([
      runGit(["-C", canonicalWorktree, "rev-parse", "--show-toplevel"]),
      runGit(["-C", canonicalWorktree, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
      runGit(["-C", canonicalWorktree, "branch", "--show-current"]),
      runGit(["-C", canonicalWorktree, "rev-parse", "--verify", "HEAD^{commit}"]),
      runGit(["-C", canonicalWorktree, "status", "--porcelain=v1"]),
    ]);
  } catch {
    throw stableError("foreground_e2e_missing_worktree_identity_invalid");
  }
  const canonicalTopLevel = await canonicalExistingPath(topLevel, "foreground_e2e_missing_worktree_identity_invalid");
  const canonicalCommon = await canonicalExistingPath(commonDirectory, "foreground_e2e_missing_worktree_identity_invalid");
  if (canonicalTopLevel !== canonicalWorktree || path.dirname(canonicalCommon) !== expectedRepository ||
      actualBranch !== branchName || !gitRevision(headRevision) || status !== "") {
    throw stableError("foreground_e2e_missing_worktree_identity_invalid");
  }
  await runGit(["-C", expectedRepository, "worktree", "remove", canonicalWorktree]);
  if (await existingPath(canonicalWorktree)) {
    throw stableError("foreground_e2e_missing_worktree_remove_unconfirmed");
  }
  const worktreeList = await runGit(["-C", expectedRepository, "worktree", "list", "--porcelain"]);
  if (worktreeList.split("\n").some((line) => line === `worktree ${canonicalWorktree}`)) {
    throw stableError("foreground_e2e_missing_worktree_remove_unconfirmed");
  }
  if (invalidateExecutionBranch) {
    await runGit(["-C", expectedRepository, "worktree", "prune"]);
    await runGit(["-C", expectedRepository, "branch", "-D", branchName]);
    try {
      await runGit(["-C", expectedRepository, "rev-parse", "--verify", `${branchName}^{commit}`]);
    } catch {
      return Object.freeze({ branch: branchName, headRevision, invalidated: true });
    }
    throw stableError("foreground_e2e_missing_worktree_branch_remove_unconfirmed");
  }
  const preservedHead = await runGit(["-C", expectedRepository, "rev-parse", "--verify", `${branchName}^{commit}`]);
  if (preservedHead !== headRevision) {
    throw stableError("foreground_e2e_missing_worktree_branch_changed");
  }
  return Object.freeze({ branch: branchName, headRevision, invalidated: false });
}

async function canonicalExistingPath(candidate, code) {
  try {
    return await realpath(candidate);
  } catch {
    throw stableError(code);
  }
}

async function existingPath(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function gitRevision(value) {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/u.test(value);
}

function safePathSegment(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && value !== "." && value !== "..";
}

function safeRootIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

export async function createForegroundLocalResources({
  sourceRepositoryRoot = process.cwd(),
  temporaryDirectory = (prefix) => mkdtemp(prefix),
  removeDirectory = (directory) => rm(directory, { recursive: true, force: true }),
  runGit = git,
} = {}) {
  if (typeof sourceRepositoryRoot !== "string" || sourceRepositoryRoot.length === 0 ||
      typeof temporaryDirectory !== "function" || typeof removeDirectory !== "function" || typeof runGit !== "function") {
    throw stableError("foreground_e2e_local_resources_input_invalid");
  }
  const sourceRoot = await canonicalGitRoot(sourceRepositoryRoot, runGit);
  const baseBranch = await runGit(["-C", sourceRoot, "branch", "--show-current"]);
  if (!branch(baseBranch)) throw stableError("foreground_e2e_repository_branch_invalid");
  const directory = await temporaryDirectory(path.join(os.tmpdir(), "symphony-foreground-e2e-"));
  if (typeof directory !== "string" || directory.length === 0) {
    throw stableError("foreground_e2e_local_resources_invalid");
  }
  try {
    const podiumDataRoot = path.join(directory, "podium");
    await mkdir(podiumDataRoot, { recursive: true });
    const remotes = path.join(directory, "remotes");
    await mkdir(remotes, { recursive: true });
    const repositories = [];
    for (let index = 1; index <= REPOSITORY_COUNT; index += 1) {
      repositories.push(await cloneRepository({
        sourceRoot,
        baseBranch,
        remoteRoot: remotes,
        directory,
        index,
        runGit,
      }));
    }
    const runtimePaths = await productionRuntimePaths(sourceRoot);
    let closed = false;
    return Object.freeze({
      directory,
      podiumDataRoot,
      repositories: Object.freeze(repositories),
      ...runtimePaths,
      async close() {
        if (closed) return;
        closed = true;
        await removeDirectory(directory);
      },
    });
  } catch (error) {
    await removeDirectory(directory);
    throw error;
  }
}

async function startPodiumBackend({
  config,
  project,
  installation,
  resources,
  environment,
  spawn,
  reporter,
  onUnexpectedExit,
}) {
  const child = spawn(process.execPath, [resources.podiumBackend], {
    cwd: resources.sourceRoot,
    env: createPodiumEnvironment({ config, resources, environment }),
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout || !child.stdio?.[3] || !child.stdio?.[4]) {
    await closeOwnedProcess(child);
    throw stableError("foreground_e2e_podium_process_invalid");
  }
  const requestBudget = createProjectRootIndexRequestBudget({
    installationId: installation.installationId,
    projectId: project.projectId,
  });
  const stderrReason = collectSanitizedChildReason(
    child.stderr,
    "process_exited",
    (observation) => requestBudget.observe(observation),
  );
  let closing = false;
  const close = async () => {
    closing = true;
    client.close();
    hostChannel.close();
    conductorChannel.close();
    await closeOwnedProcess(child);
  };
  const client = createPodiumClient({ input: child.stdout, output: child.stdin });
  const hostChannel = createFramedChannel({ stream: child.stdio[4] });
  const conductorChannel = createConductorMultiplexer({
    stream: child.stdio[3],
    onFailure: (reasonCode) => reporter?.failure({ component: "conductor-multiplexer", reasonCode }),
  });
  child.once("exit", () => {
    const reasonCode = stderrReason();
    reporter?.childExit({ component: "podium", reasonCode });
    if (!closing) onUnexpectedExit?.({ component: "podium", reasonCode });
  });
  child.once("error", () => {
    reporter?.childExit({ component: "podium", reasonCode: "process_start_failed" });
    if (!closing) onUnexpectedExit?.({ component: "podium", reasonCode: "process_start_failed" });
  });
  return Object.freeze({ child, client, hostChannel, conductorChannel, requestBudget, close });
}

function createDesktopHost({
  podiumChannel,
  hostChannel,
  config,
  resources,
  installation,
  environment,
  spawn,
  reporter,
  onUnexpectedExit,
}) {
  const repositories = new Map(resources.repositories.map((repository) => [repository.repositoryHandle, repository]));
  const conductors = new Map();
  let closing = false;
  const sendExit = async ({ conductor, instanceId, reasonCode }) => {
    if (closing) return;
    await hostChannel.request({
      kind: "process_observed_exit",
      binding_id: conductor.bindingId,
      instance_id: instanceId,
      observed_at: new Date().toISOString(),
      sanitized_reason: reasonCode,
    });
  };
  const reportExit = async (active, reasonCode) => {
    if (!active.exitReportPromise) {
      active.exitReported = true;
      active.exitReportPromise = sendExit({ conductor: active.conductor, instanceId: active.instanceId, reasonCode });
    }
    await active.exitReportPromise;
  };
  const handle = async (body) => {
      if (!body || typeof body !== "object" || Array.isArray(body)) return protocolFailure("host_command_invalid");
      switch (body.kind) {
        case "resolve_repository": {
          const repository = repositories.get(body.repository_handle);
          if (!repository || body.base_branch !== repository.baseBranch) return protocolFailure("repository_not_found");
          return {
            kind: "repository_context",
            repository_handle: repository.repositoryHandle,
            canonical_path: repository.repositoryRoot,
            display_name: repository.repositoryDisplayName,
            remote_display: repository.repositoryIdentity,
            base_branches: [repository.baseBranch],
          };
        }
        case "start_conductor": {
          const conductor = hostConductor(body, installation.organizationId);
          if (!repositories.has(conductor.repositoryHandle) || conductors.has(conductor.conductorId)) {
            return protocolFailure("conductor_start_invalid");
          }
          const instanceId = `e2e-${randomUUID()}`;
          let child;
          try {
            child = await spawnFencedConductor({
              runtimeRoot: path.join(resources.podiumDataRoot, "runtime"),
              bindingId: conductor.bindingId,
              executable: process.execPath,
              arguments_: [resources.conductor],
              cwd: resources.sourceRoot,
              environment: createConductorEnvironment({
              config,
              resources,
              conductor: {
                ...conductor,
                instanceId,
              },
              environment,
            }),
              spawn,
            });
          } catch {
            return protocolFailure("conductor_fence_unavailable");
          }
          const channel = child.stdio?.[3];
          if (!channel || !child.stdout || !child.stderr) {
            await closeOwnedProcess(child);
            return protocolFailure("conductor_start_invalid");
          }
          const runtimeLogs = createConductorRuntimeLogForwarder({
            conductorId: conductor.conductorId,
            stdout: child.stdout,
            stderr: child.stderr,
            reporter,
            onUnexpectedExit,
          });
          const active = {
            conductor,
            instanceId,
            child,
            channel,
            runtimeLogs,
            expectedExit: false,
            exitReported: false,
            exitReportPromise: undefined,
            exitReason: undefined,
          };
          conductors.set(conductor.conductorId, active);
          podiumChannel.add(active);
          child.once("exit", () => {
            podiumChannel.remove(active);
            conductors.delete(conductor.conductorId);
            reporter?.childExit({ component: "conductor", reasonCode: "process_exited" });
            if (!active.expectedExit) {
              onUnexpectedExit?.({
                component: "conductor",
                conductorId: conductor.conductorId,
                reasonCode: active.exitReason ?? "conductor_process_exited",
              });
            }
            void reportExit(active, active.exitReason ?? "conductor_process_exited").catch(() => undefined);
          });
          child.once("close", () => runtimeLogs.close());
          child.once("error", () => reporter?.childExit({ component: "conductor", reasonCode: "process_start_failed" }));
          return { kind: "host_operation_completed", operation: "start_conductor" };
        }
        case "stop_conductor": {
          const active = conductors.get(body.conductor_id);
          if (!active) return protocolFailure("conductor_not_running");
          await stop(active, "conductor_process_stopped");
          return { kind: "host_operation_completed", operation: "stop_conductor" };
        }
        case "restart_conductor": {
          const active = conductors.get(body.conductor_id);
          if (!active) return protocolFailure("conductor_not_running");
          const request = active.conductor;
          await stop(active, "conductor_process_restarted");
          return handle({
            kind: "start_conductor",
            binding_id: request.bindingId,
            conductor_id: request.conductorId,
            conductor_short_hash: request.conductorShortHash,
            linear_installation_id: request.linearInstallationId,
            organization_id: request.organizationId,
            repository_handle: request.repositoryHandle,
            repository_root: request.repositoryRoot,
            base_branch: request.baseBranch,
            conductor_data_root: request.dataRoot,
          });
        }
        case "open_external_url":
          return protocolFailure("external_authorization_unsupported");
        default:
          return protocolFailure("host_command_unsupported");
      }
  };
  const close = async () => {
    if (closing) return;
    closing = true;
    const active = [...conductors.values()];
    conductors.clear();
    await Promise.allSettled(active.map((entry) => stop(entry, "conductor_process_cleanup")));
  };
  return Object.freeze({ handle, close, killAndObserveConductor, runningConductor });

  function runningConductor({ conductorId } = {}) {
    if (!identifier(conductorId)) throw stableError("foreground_e2e_runtime_conductor_lookup_invalid");
    const active = conductors.get(conductorId);
    if (!active) throw stableError("foreground_e2e_runtime_conductor_lookup_invalid");
    return active.conductor;
  }

  async function stop(active, reasonCode) {
    podiumChannel.remove(active);
    conductors.delete(active.conductor.conductorId);
    active.exitReason ??= reasonCode;
    active.expectedExit = true;
    await closeOwnedProcess(active.child);
    await reportExit(active, active.exitReason);
  }

  async function killAndObserveConductor({ conductorId } = {}) {
    if (!identifier(conductorId)) throw stableError("foreground_e2e_recovery_restart_input_invalid");
    const active = conductors.get(conductorId);
    if (!active) throw stableError("foreground_e2e_recovery_restart_unavailable");
    podiumChannel.remove(active);
    conductors.delete(conductorId);
    active.exitReason ??= "conductor_process_sigkill";
    active.expectedExit = true;
    await forceKillOwnedProcess(active.child);
    await reportExit(active, active.exitReason);
    return active.conductor;
  }
}

async function spawnFencedConductor({ runtimeRoot, bindingId, executable, arguments_, cwd, environment, spawn }) {
  if (process.platform === "win32" || !boundedPath(runtimeRoot) || !identifier(bindingId) ||
      !boundedPath(executable) || !Array.isArray(arguments_) || !arguments_.every((value) => typeof value === "string") ||
      !boundedPath(cwd) || !environment || typeof environment !== "object" || typeof spawn !== "function") {
    throw stableError("foreground_e2e_binding_process_fence_input_invalid");
  }
  const lockPath = await bindingProcessFencePath(runtimeRoot, bindingId);
  const child = spawn("python3", [
    "-c",
    BINDING_FENCE_EXEC,
    lockPath,
    String(BINDING_FENCE_READY_FD),
    executable,
    ...arguments_,
  ], {
    cwd,
    env: environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  try {
    await bindingFenceReady(child, child.stdio?.[BINDING_FENCE_READY_FD]);
    return child;
  } catch (error) {
    await closeOwnedProcess(child).catch(() => undefined);
    throw error;
  }
}

async function bindingProcessFencePath(runtimeRoot, bindingId) {
  const lockRoot = path.join(runtimeRoot, "binding-fences");
  await mkdir(lockRoot, { recursive: true });
  return path.join(lockRoot, `${createHash("sha256").update(bindingId).digest("hex")}.lock`);
}

function bindingFenceReady(child, stream) {
  if (!child || !stream || typeof stream.once !== "function") {
    return Promise.reject(stableError("foreground_e2e_binding_process_fence_unavailable"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, "foreground_e2e_binding_process_fence_unavailable"), 5_000);
    const onData = (chunk) => {
      const result = Buffer.from(chunk).toString("utf8");
      if (result.includes("ready\n")) finish(resolve);
      else if (result.includes("locked\n")) finish(reject, "foreground_e2e_binding_process_fence_unavailable");
    };
    const onExit = () => finish(reject, "foreground_e2e_binding_process_fence_unavailable");
    const onError = () => finish(reject, "foreground_e2e_binding_process_fence_unavailable");
    stream.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);

    function finish(callback, code) {
      clearTimeout(timer);
      stream.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      callback(code ? stableError(code) : undefined);
    }
  });
}

function createPodiumClient({ input, output }) {
  const pending = new Map();
  let closed = false;
  const reader = createFrameReader(input, async (frame) => {
    const request = pending.get(frame.message.request_id);
    if (!request) throw stableError("foreground_e2e_podium_client_response_invalid");
    pending.delete(frame.message.request_id);
    clearTimeout(request.timer);
    request.resolve(frame.message.body);
  }, fail);
  return Object.freeze({
    command(body, secret) {
      if (closed) return Promise.reject(stableError("foreground_e2e_podium_client_closed"));
      const requestId = `e2e-${randomUUID()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(stableError("foreground_e2e_podium_client_timeout"));
        }, 120_000);
        pending.set(requestId, { resolve, reject, timer });
        writeFrame(output, { protocol_version: "1", request_id: requestId, body }, secret)
          .catch((error) => {
            clearTimeout(timer);
            pending.delete(requestId);
            reject(error);
          });
      }).then((response) => {
        if (response && typeof response === "object" && typeof response.code === "string") {
          const command = safeReasonCode(body?.kind) ? body.kind : "unknown";
          const reason = safeReasonCode(response.sanitized_reason)
            ? response.sanitized_reason
            : safeReasonCode(response.code)
              ? response.code
              : "podium_command_failed";
          throw stableError(`foreground_e2e_podium_${command}_${reason}`.slice(0, 121));
        }
        return response;
      });
    },
    close() {
      if (closed) return;
      reader.close();
      fail(stableError("foreground_e2e_podium_client_closed"));
    },
  });

  function fail(error) {
    if (closed) return;
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }
}

export function createFramedChannel({ stream }) {
  let handler;
  let closed = false;
  const pending = new Map();
  const reader = createFrameReader(stream, async (frame) => {
    const request = pending.get(frame.message.request_id);
    if (request) {
      pending.delete(frame.message.request_id);
      clearTimeout(request.timer);
      request.resolve(frame.message.body);
      return;
    }
    const body = handler ? await handler(frame.message.body) : protocolFailure("host_handler_unavailable");
    await writeFrame(stream, {
      protocol_version: "1",
      request_id: frame.message.request_id,
      body,
    });
  }, fail);
  return Object.freeze({
    setHandler(value) {
      if (typeof value !== "function" || handler) throw stableError("foreground_e2e_host_handler_invalid");
      handler = value;
    },
    request(body) {
      if (closed) return Promise.reject(stableError("foreground_e2e_host_channel_closed"));
      const requestId = `host-${randomUUID()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(stableError("foreground_e2e_host_channel_timeout"));
        }, 30_000);
        pending.set(requestId, { resolve, reject, timer });
        writeFrame(stream, { protocol_version: "1", request_id: requestId, body }).catch((error) => {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(error);
        });
      });
    },
    close() {
      if (closed) return;
      reader.close();
      fail(stableError("foreground_e2e_host_channel_closed"));
    },
  });

  function fail(error) {
    if (closed) return;
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }
}

export function createConductorMultiplexer({ stream, onFailure } = {}) {
  const byConductorId = new Map();
  const pendingConductorRequests = new Map();
  const pendingPodiumRequests = new Map();
  const serial = createSerialWriter(stream);
  let closed = false;
  let podiumReader;
  const fail = (error) => {
    if (closed) return;
    closed = true;
    onFailure?.(multiplexerFailureReason(error));
    podiumReader?.close();
    for (const active of byConductorId.values()) active.reader.close();
    byConductorId.clear();
    pendingConductorRequests.clear();
    pendingPodiumRequests.clear();
  };
  podiumReader = createFrameReader(stream, async (frame) => {
    const pending = pendingConductorRequests.get(frame.message.request_id);
    const target = pending?.active ??
      (typeof frame.message.body?.conductor_id === "string"
        ? byConductorId.get(frame.message.body.conductor_id)
        : undefined);
    if (!target) throw stableError("foreground_e2e_conductor_route_missing");
    if (pending) {
      pendingConductorRequests.delete(frame.message.request_id);
      await writeFrame(target.channel, {
        ...frame.message,
        request_id: pending.conductorRequestId,
      }, frame.secret);
      return;
    }
    pendingPodiumRequests.set(conductorRouteKey(target.conductor.conductorId, frame.message.request_id), target);
    await writeFrame(target.channel, frame.message, frame.secret);
  }, fail);
  return Object.freeze({
    add(active) {
      if (closed || !active || !identifier(active.conductor.conductorId) || !active.channel ||
          byConductorId.has(active.conductor.conductorId)) {
        throw stableError("foreground_e2e_conductor_route_invalid");
      }
      const reader = createFrameReader(active.channel, async (frame) => {
        const responseRoute = conductorRouteKey(active.conductor.conductorId, frame.message.request_id);
        if (pendingPodiumRequests.delete(responseRoute)) {
          await serial.write(frame.message, frame.secret);
          return;
        }
        const transportRequestId = `e2e-route-${randomUUID()}`;
        pendingConductorRequests.set(transportRequestId, {
          active,
          conductorRequestId: frame.message.request_id,
        });
        await serial.write({ ...frame.message, request_id: transportRequestId }, frame.secret);
      }, fail);
      byConductorId.set(active.conductor.conductorId, { ...active, reader });
    },
    remove(active) {
      const current = byConductorId.get(active?.conductor?.conductorId);
      if (!current) return;
      current.reader.close();
      byConductorId.delete(active.conductor.conductorId);
      for (const [requestId, pending] of pendingConductorRequests) {
        if (pending.active === active || pending.active.child === active.child) {
          pendingConductorRequests.delete(requestId);
        }
      }
      for (const [route, target] of pendingPodiumRequests) {
        if (target === active || target.child === active.child) pendingPodiumRequests.delete(route);
      }
    },
    close() {
      fail();
    },
  });
}

function conductorRouteKey(conductorId, requestId) {
  return `${conductorId}\u0000${requestId}`;
}

function multiplexerFailureReason(error) {
  return error?.code?.startsWith("foreground_e2e_")
    ? error.code
    : "foreground_e2e_conductor_multiplexer_failed";
}

function createFrameReader(stream, onFrame, onFailure = () => {}) {
  if (!stream || typeof stream.on !== "function" || typeof onFrame !== "function" ||
      typeof onFailure !== "function") {
    throw stableError("foreground_e2e_frame_reader_input_invalid");
  }
  let buffer = Buffer.alloc(0);
  let processing = Promise.resolve();
  let closed = false;
  const onData = (chunk) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    processing = processing.then(drain).catch((error) => fail(error));
  };
  const onError = () => fail(stableError("foreground_e2e_frame_read_failed"));
  const onEnd = () => fail(stableError("foreground_e2e_frame_closed"));
  stream.on("data", onData);
  stream.once("error", onError);
  stream.once("end", onEnd);
  return Object.freeze({
    close() {
      if (closed) return;
      closed = true;
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
      buffer.fill(0);
      buffer = Buffer.alloc(0);
    },
  });

  async function drain() {
    while (!closed) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.byteLength > MAX_FRAME_BYTES) throw stableError("foreground_e2e_frame_too_large");
        return;
      }
      if (newline > MAX_FRAME_BYTES) throw stableError("foreground_e2e_frame_too_large");
      let message;
      try {
        message = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        throw stableError("foreground_e2e_frame_invalid");
      }
      if (!message || typeof message !== "object" || message.protocol_version !== "1" ||
          !identifier(message.request_id) || !Object.hasOwn(message, "body")) {
        throw stableError("foreground_e2e_frame_invalid");
      }
      const secretLength = secretLengthFor(message.body);
      if (buffer.byteLength < newline + 1 + secretLength) return;
      const secret = secretLength > 0
        ? Buffer.from(buffer.subarray(newline + 1, newline + 1 + secretLength))
        : undefined;
      buffer = buffer.subarray(newline + 1 + secretLength);
      try {
        await onFrame({ message, secret });
      } finally {
        secret?.fill(0);
      }
    }
  }

  function fail(error) {
    if (closed) return;
    closed = true;
    stream.removeListener("data", onData);
    stream.removeListener("error", onError);
    stream.removeListener("end", onEnd);
    buffer.fill(0);
    buffer = Buffer.alloc(0);
    onFailure(error?.code?.startsWith("foreground_e2e_")
      ? error
      : stableError("foreground_e2e_frame_read_failed"));
  }
}

function createSerialWriter(stream) {
  let pending = Promise.resolve();
  return Object.freeze({
    write(message, secret) {
      pending = pending.then(() => writeFrame(stream, message, secret));
      return pending;
    },
  });
}

export async function closeForegroundProductionRuntime({
  podium,
  host,
  conductors,
  reporter,
  timeoutMs = GRACEFUL_STOP_TIMEOUT_MS,
} = {}) {
  if (!podium) return;
  if (!podium.client || typeof podium.client.command !== "function" || typeof podium.close !== "function" ||
      host !== undefined && typeof host.close !== "function" || !Array.isArray(conductors) ||
      conductors.some(({ conductorId }) => !identifier(conductorId)) ||
      reporter !== undefined && typeof reporter.childExit !== "function" ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw stableError("foreground_e2e_runtime_cleanup_input_invalid");
  }
  try {
    await bounded(
      Promise.all(conductors.map((conductor) => podium.client.command({
        kind: "stop_conductor",
        conductor_id: conductor.conductorId,
      }))),
      timeoutMs,
    );
  } catch {
    reporter?.childExit({ component: "podium", reasonCode: "graceful_stop_failed" });
  } finally {
    let hostError;
    try {
      await bounded(host?.close?.(), timeoutMs);
    } catch (error) {
      hostError = error;
    }
    let podiumError;
    try {
      await bounded(podium.close(), timeoutMs);
    } catch (error) {
      podiumError = error;
    }
    if (hostError || podiumError) throw stableError("foreground_e2e_runtime_cleanup_failed");
  }
}

function bounded(operation, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(stableError("foreground_e2e_graceful_stop_timeout")), timeoutMs);
    Promise.resolve(operation).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createdConductor(value, repository, installation) {
  if (!value || typeof value !== "object" || value.kind !== "conductor_created" ||
      !identifier(value.binding_id) || !identifier(value.conductor_id) || !shortHash(value.conductor_short_hash) ||
      value.repository_identity !== repository.repositoryIdentity) {
    throw stableError("foreground_e2e_conductor_creation_invalid");
  }
  return Object.freeze({
    bindingId: value.binding_id,
    conductorId: value.conductor_id,
    conductorShortHash: value.conductor_short_hash,
    linearInstallationId: installation.installationId,
    organizationId: installation.organizationId,
    repositoryHandle: repository.repositoryHandle,
    repositoryIdentity: repository.repositoryIdentity,
    repositoryRoot: repository.repositoryRoot,
    baseBranch: repository.baseBranch,
  });
}

function hostConductor(value, expectedOrganizationId) {
  if (!value || typeof value !== "object" || !identifier(value.binding_id) || !identifier(value.conductor_id) ||
      !shortHash(value.conductor_short_hash) || !identifier(value.linear_installation_id) ||
      !identifier(value.organization_id) || value.organization_id !== expectedOrganizationId ||
      !identifier(value.repository_handle) || typeof value.repository_identity !== "string" || value.repository_identity.length === 0 ||
      !boundedPath(value.repository_root) || !branch(value.base_branch) ||
      !boundedPath(value.conductor_data_root)) {
    throw stableError("foreground_e2e_host_conductor_invalid");
  }
  return Object.freeze({
    bindingId: value.binding_id,
    conductorId: value.conductor_id,
    conductorShortHash: value.conductor_short_hash,
    linearInstallationId: value.linear_installation_id,
    organizationId: value.organization_id,
    repositoryHandle: value.repository_handle,
    repositoryIdentity: value.repository_identity,
    repositoryRoot: value.repository_root,
    baseBranch: value.base_branch,
    dataRoot: value.conductor_data_root,
  });
}

async function provisionProfile({ client, conductor, config, wait }) {
  const created = profile(await client.command({
    kind: "create_performer_profile",
    conductor_id: conductor.conductorId,
    display_name: "Foreground E2E",
    backend_kind: "codex",
    authentication_method: "api_key",
    codex_turn_settings: {
      model: config.codex.model,
      reasoning_effort: "minimal",
      is_fast_mode_enabled: false,
    },
    execution_policy: {
      sandbox_mode: "workspace_write",
      command_allowlist: [],
      command_denylist: [],
    },
  }));
  const secret = Buffer.from(config.secrets.codexApiKey, "utf8");
  let current = profile(await client.command({
    kind: "set_codex_api_key",
    conductor_id: conductor.conductorId,
    profile_id: created.profileId,
    secret_frame_length: secret.byteLength,
  }, secret));
  for (let attempt = 1; current.readiness !== "ready" && attempt < PROFILE_READINESS_ATTEMPTS; attempt += 1) {
    await wait(250);
    current = profile(await client.command({
      kind: "get_performer_profile_status",
      conductor_id: conductor.conductorId,
      profile_id: created.profileId,
    }));
  }
  if (current.readiness !== "ready") throw stableError("foreground_e2e_profile_not_ready");
  const activated = profile(await client.command({
    kind: "activate_performer_profile",
    conductor_id: conductor.conductorId,
    profile_id: created.profileId,
  }));
  if (!activated.isActive || activated.profileId !== created.profileId || activated.readiness !== "ready") {
    throw stableError("foreground_e2e_profile_activation_invalid");
  }
  return activated;
}

function profile(value) {
  if (!value || typeof value !== "object" || !identifier(value.profile_id) ||
      !["login-required", "ready", "invalid"].includes(value.readiness) || typeof value.is_active !== "boolean") {
    throw stableError("foreground_e2e_profile_invalid");
  }
  return Object.freeze({ profileId: value.profile_id, readiness: value.readiness, isActive: value.is_active });
}

function protocolFailure(code) {
  return {
    code,
    category: "foreground_e2e",
    sanitized_reason: code,
    retryable: false,
    action_required: "stop_campaign",
    next_action: "Stop the foreground E2E Campaign and inspect its sanitized logs.",
  };
}

function writeFrame(stream, message, secret) {
  const metadata = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
  const secretBytes = secret ? Buffer.from(secret) : undefined;
  if (metadata.byteLength > MAX_FRAME_BYTES || secretLengthFor(message.body) !== (secretBytes?.byteLength ?? 0)) {
    secretBytes?.fill(0);
    secret?.fill?.(0);
    return Promise.reject(stableError("foreground_e2e_frame_invalid"));
  }
  const payload = secretBytes ? Buffer.concat([metadata, secretBytes]) : metadata;
  return new Promise((resolve, reject) => {
    stream.write(payload, (error) => {
      payload.fill(0);
      secretBytes?.fill(0);
      secret?.fill?.(0);
      if (error) reject(stableError("foreground_e2e_frame_write_failed"));
      else resolve();
    });
  });
}

function secretLengthFor(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  const value = body.secret_frame_length;
  return Number.isSafeInteger(value) && value >= 0 && value <= 16_384 ? value : 0;
}

export function createConductorRuntimeLogForwarder({ conductorId, stdout, stderr, reporter, onUnexpectedExit } = {}) {
  if (!identifier(conductorId) || !readableStream(stdout) || !readableStream(stderr) ||
      reporter !== undefined && typeof reporter.runtimeDiagnostic !== "function" ||
      onUnexpectedExit !== undefined && typeof onUnexpectedExit !== "function") {
    throw stableError("foreground_e2e_conductor_log_forwarder_input_invalid");
  }
  let closed = false;
  let invalidJsonReported = false;
  let invalidFieldsReported = false;
  let unknownEventReported = false;
  const readStdout = createRuntimeLogReader((line) => forward(line));
  const readStderr = createRuntimeLogReader((line) => forward(line));
  stdout.on("data", readStdout);
  stderr.on("data", readStderr);
  return Object.freeze({
    close() {
      if (closed) return;
      closed = true;
      removeDataListener(stdout, readStdout);
      removeDataListener(stderr, readStderr);
    },
  });

  function forward(line) {
    if (closed) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      if (!invalidJsonReported) {
        invalidJsonReported = true;
        reporter?.runtimeDiagnostic({
          component: "conductor",
          conductorId,
          level: "error",
          runtimeEvent: "conductor_runtime_log_invalid_json",
          reason: "invalid_json",
        });
      }
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      reportInvalidFields();
      return;
    }
    if (!isKnownConductorRuntimeLogEvent(value.event)) {
      if (!unknownEventReported) {
        unknownEventReported = true;
        reporter?.runtimeDiagnostic({
          component: "conductor",
          conductorId,
          level: value.level === "error" ? "error" : "warning",
          runtimeEvent: "conductor_runtime_log_unknown_event",
          reason: "unknown_event",
        });
      }
      return;
    }
    if (!isForwardableConductorRuntimeEvent(value.event)) return;
    const diagnostic = {
      component: "conductor",
      conductorId,
      level: value.level,
      runtimeEvent: value.event,
      ...(value.root_issue_id === undefined ? {} : { rootIssueId: value.root_issue_id }),
      ...(value.reason === undefined && value.sanitized_reason === undefined
        ? {}
        : { reason: value.reason ?? value.sanitized_reason }),
      ...(value.failure_code === undefined ? {} : { failureCode: value.failure_code }),
      ...(value.phase === undefined ? {} : { phase: value.phase }),
    };
    if (!runtimeLogDiagnostic(diagnostic)) {
      reportInvalidFields();
      return;
    }
    reporter?.runtimeDiagnostic(diagnostic);
    if (diagnostic.runtimeEvent === "root_reconciliation_failed" &&
        diagnostic.reason === "performer_agent_process_exited") {
      onUnexpectedExit?.({
        component: "performer",
        conductorId,
        ...(diagnostic.rootIssueId ? { rootIssueId: diagnostic.rootIssueId } : {}),
        reasonCode: "performer_agent_process_exited",
      });
    }

    function reportInvalidFields() {
      if (invalidFieldsReported) return;
      invalidFieldsReported = true;
      reporter?.runtimeDiagnostic({
        component: "conductor",
        conductorId,
        level: "error",
        runtimeEvent: "conductor_runtime_log_invalid_fields",
        reason: "invalid_fields",
      });
    }
  }
}

function createRuntimeLogReader(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer = `${buffer}${Buffer.from(chunk).toString("utf8")}`.slice(-16_384);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) onLine(line);
    }
  };
}

function readableStream(value) {
  return value && typeof value.on === "function" &&
    (typeof value.off === "function" || typeof value.removeListener === "function");
}

function removeDataListener(stream, listener) {
  if (typeof stream.off === "function") stream.off("data", listener);
  else stream.removeListener("data", listener);
}

function runtimeLogDiagnostic(value) {
  return value.component === "conductor" && identifier(value.conductorId) &&
    (value.level === "info" || value.level === "warning" || value.level === "error") &&
    isForwardableConductorRuntimeEvent(value.runtimeEvent) &&
    (value.rootIssueId === undefined || identifier(value.rootIssueId)) &&
    (value.reason === undefined || safeReasonCode(value.reason)) &&
    (value.failureCode === undefined || safeReasonCode(value.failureCode)) &&
    (value.phase === undefined || safeReasonCode(value.phase));
}

function collectSanitizedChildReason(stream, fallback, observe) {
  let reason = fallback;
  let buffer = "";
  stream?.on?.("data", (chunk) => {
    buffer = `${buffer}${Buffer.from(chunk).toString("utf8")}`.slice(-8_192);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        if (safeReasonCode(value?.sanitized_reason)) reason = value.sanitized_reason;
        observe?.(value);
      } catch {}
    }
  });
  return () => reason;
}

function createUnexpectedExitRegistry() {
  const faults = [];
  const listeners = new Set();
  const keys = new Set();
  return Object.freeze({
    report(fault) {
      if (!unexpectedExitFault(fault)) return;
      const key = [fault.component, fault.conductorId ?? "", fault.rootIssueId ?? "", fault.reasonCode].join("\0");
      if (keys.has(key)) return;
      keys.add(key);
      const value = Object.freeze({ ...fault });
      faults.push(value);
      for (const listener of [...listeners]) listener(value);
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw stableError("foreground_e2e_process_fault_listener_invalid");
      for (const fault of faults) listener(fault);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function unexpectedExitFault(value) {
  if (!value || typeof value !== "object" || !["podium", "conductor", "performer"].includes(value.component) ||
      !safeReasonCode(value.reasonCode)) return false;
  if (value.component === "podium") return value.conductorId === undefined && value.rootIssueId === undefined;
  return identifier(value.conductorId) && (value.rootIssueId === undefined || identifier(value.rootIssueId));
}

function baseChildEnvironment(environment) {
  const child = {};
  for (const key of ["HOME", "LANG", "LC_ALL", "PATH", "TMP", "TMPDIR", "TEMP", "USERPROFILE"]) {
    if (typeof environment[key] === "string") child[key] = environment[key];
  }
  return child;
}

function assertRuntimeInput({ config, resources }) {
  if (!config || !identifier(config.linear?.clientId) || typeof config.secrets?.linearDevToken !== "string" ||
      typeof config.secrets?.linearClientSecret !== "string" || typeof config.secrets?.codexApiKey !== "string" ||
      !url(config.codex?.baseUrl) || typeof config.codex?.model !== "string" || !resources ||
      !boundedPath(resources.podiumDataRoot) || !boundedPath(resources.podiumBackend) ||
      !boundedPath(resources.conductor) || !boundedPath(resources.performer)) {
    throw stableError("foreground_e2e_runtime_input_invalid");
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function productionRuntimePaths(sourceRoot) {
  const podiumBackend = path.join(sourceRoot, "apps/podium-desktop/dist-backend/main.js");
  const conductor = path.join(sourceRoot, "apps/conductor/dist/main.js");
  const performer = path.join(sourceRoot, ".venv/bin/performer");
  await requiredReadableFile(podiumBackend);
  await requiredReadableFile(conductor);
  try {
    await access(performer, constants.X_OK);
  } catch {
    throw stableError("foreground_e2e_runtime_binary_unavailable");
  }
  return Object.freeze({ podiumBackend, conductor, performer, sourceRoot });
}

async function requiredReadableFile(entry) {
  try {
    await access(entry, constants.R_OK);
  } catch {
    throw stableError("foreground_e2e_runtime_binary_unavailable");
  }
}

async function cloneRepository({ sourceRoot, baseBranch, remoteRoot, directory, index, runGit }) {
  const remote = path.join(remoteRoot, `repository-${index}.git`);
  const destination = path.join(directory, `repository-${index}`);
  await runGit(["init", "--bare", remote]);
  await runGit(["clone", "--local", "--no-hardlinks", "--branch", baseBranch, sourceRoot, destination]);
  const repositoryRoot = await canonicalGitRoot(destination, runGit);
  await runGit(["-C", repositoryRoot, "remote", "set-url", "origin", remote]);
  await runGit(["-C", repositoryRoot, "push", "--set-upstream", "origin", baseBranch]);
  const commonDirectory = await realpath(await runGit([
    "-C", repositoryRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]));
  const identity = createHash("sha256").update(commonDirectory).digest("hex");
  return Object.freeze({
    repositoryHandle: identity,
    repositoryIdentity: identity,
    repositoryDisplayName: `Foreground E2E Repository ${index}`,
    repositoryRoot,
    baseBranch,
  });
}

async function canonicalGitRoot(candidate, runGit) {
  let expected;
  try {
    expected = await realpath(candidate);
  } catch {
    throw stableError("foreground_e2e_repository_source_invalid");
  }
  let topLevel;
  try {
    topLevel = await runGit(["-C", expected, "rev-parse", "--show-toplevel"]);
  } catch {
    throw stableError("foreground_e2e_repository_source_invalid");
  }
  let root;
  try {
    root = await realpath(topLevel);
  } catch {
    throw stableError("foreground_e2e_repository_source_invalid");
  }
  if (root !== expected) throw stableError("foreground_e2e_repository_source_invalid");
  return root;
}

async function git(arguments_) {
  try {
    const { stdout } = await execFile("git", arguments_, { maxBuffer: 1_048_576 });
    return stdout.trim();
  } catch {
    throw stableError("foreground_e2e_repository_git_failed");
  }
}

function exited(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function terminate(child, signal) {
  if (process.platform !== "win32" && Number.isSafeInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error) || (error.code !== "ESRCH" && error.code !== "EPERM")) throw error;
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function branch(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value);
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function safeReasonCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(value);
}

function runtimeFailureReason(error) {
  return safeReasonCode(error?.code) ? error.code : "foreground_e2e_runtime_start_failed";
}

function shortHash(value) {
  return typeof value === "string" && /^[a-f0-9]{12}$/u.test(value);
}

function boundedPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !/[\r\n\0]/u.test(value);
}

function url(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function timestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
