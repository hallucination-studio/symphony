import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, constants, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { bootstrapDevelopmentTokenInstallation } from "@symphony/podium";

const execFile = promisify(execFileCallback);
const REPOSITORY_COUNT = 3;
const MAX_FRAME_BYTES = 1_048_576;
const PROFILE_READINESS_ATTEMPTS = 10;

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
    SYMPHONY_REPOSITORY_ROOT: conductor.repositoryRoot,
    SYMPHONY_BASE_BRANCH: conductor.baseBranch,
    SYMPHONY_CONDUCTOR_DATA_ROOT: conductor.dataRoot,
    SYMPHONY_PERFORMER_EXECUTABLE: resources.performer,
    SYMPHONY_CODEX_BASE_URL: config.codex.baseUrl,
    SYMPHONY_CYCLE_DELAY_MS: "250",
    SYMPHONY_ROOT_DEADLINE_DURATION_MS: "300000",
    SYMPHONY_ROOT_MAX_CYCLES_PER_ROOT: "3",
    SYMPHONY_ROOT_MAX_SAME_OPEN_FINDING_CYCLES: "2",
    SYMPHONY_ROOT_MAX_CONSECUTIVE_NO_PROGRESS: "3",
    SYMPHONY_ROOT_MAX_TOTAL_TOKENS: "1000000",
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
      reporter !== undefined && typeof reporter.childExit !== "function") {
    throw stableError("foreground_e2e_runtime_input_invalid");
  }
  const databasePath = path.join(resources.podiumDataRoot, "podium.db");
  let podium;
  let host;
  let closed = false;
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
    podium = await startPodiumBackend({ config, resources, environment, spawn, reporter });
    host = createDesktopHost({
      podiumChannel: podium.conductorChannel,
      hostChannel: podium.hostChannel,
      config,
      resources,
      installation,
      environment,
      spawn,
      reporter,
    });
    podium.hostChannel.setHandler(host.handle);
    const conductors = [];
    for (const repository of resources.repositories) {
      const created = await podium.client.command({
        kind: "create_conductor",
        project_id: project.projectId,
        repository: {
          repository_handle: repository.repositoryHandle,
          display_name: repository.repositoryDisplayName,
          base_branch: repository.baseBranch,
        },
      });
      const conductor = createdConductor(created, repository, installation);
      await podium.client.command({ kind: "start_conductor", conductor_id: conductor.conductorId });
      await provisionProfile({ client: podium.client, conductor, config, wait });
      conductors.push(conductor);
    }
    return Object.freeze({
      conductors: Object.freeze(conductors),
      async close() {
        if (closed) return;
        closed = true;
        await closeRuntime({ podium, host, conductors, reporter });
      },
    });
  } catch (error) {
    await closeRuntime({ podium, host, conductors: [], reporter });
    if (error?.code?.startsWith("foreground_e2e_")) throw error;
    throw stableError("foreground_e2e_runtime_start_failed");
  }
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

async function startPodiumBackend({ config, resources, environment, spawn, reporter }) {
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
  drain(child.stderr);
  const close = async () => {
    client.close();
    hostChannel.close();
    conductorChannel.close();
    await closeOwnedProcess(child);
  };
  const client = createPodiumClient({ input: child.stdout, output: child.stdin });
  const hostChannel = createFramedChannel({ stream: child.stdio[4] });
  const conductorChannel = createConductorMultiplexer({ stream: child.stdio[3] });
  child.once("exit", () => reporter?.childExit({ component: "podium", reasonCode: "process_exited" }));
  child.once("error", () => reporter?.childExit({ component: "podium", reasonCode: "process_start_failed" }));
  return Object.freeze({ child, client, hostChannel, conductorChannel, close });
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
    if (active.exitReported) return;
    active.exitReported = true;
    await sendExit({ conductor: active.conductor, instanceId: active.instanceId, reasonCode });
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
          const child = spawn(process.execPath, [resources.conductor], {
            cwd: resources.sourceRoot,
            env: createConductorEnvironment({
              config,
              resources,
              conductor: {
                ...conductor,
                instanceId,
              },
              environment,
            }),
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe", "pipe"],
          });
          const channel = child.stdio?.[3];
          if (!channel) {
            await closeOwnedProcess(child);
            return protocolFailure("conductor_start_invalid");
          }
          drain(child.stdout);
          drain(child.stderr);
          const active = { conductor, instanceId, child, channel, exitReported: false, exitReason: undefined };
          conductors.set(conductor.conductorId, active);
          podiumChannel.add(active);
          child.once("exit", () => {
            podiumChannel.remove(active);
            conductors.delete(conductor.conductorId);
            reporter?.childExit({ component: "conductor", reasonCode: "process_exited" });
            void reportExit(active, active.exitReason ?? "conductor_process_exited").catch(() => undefined);
          });
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
  return Object.freeze({ handle, close });

  async function stop(active, reasonCode) {
    podiumChannel.remove(active);
    conductors.delete(active.conductor.conductorId);
    active.exitReason ??= reasonCode;
    await closeOwnedProcess(active.child);
    await reportExit(active, active.exitReason);
  }
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
          throw stableError("foreground_e2e_podium_command_failed");
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

function createConductorMultiplexer({ stream }) {
  const byConductorId = new Map();
  const pending = new Map();
  const serial = createSerialWriter(stream);
  let closed = false;
  let podiumReader;
  const fail = () => {
    if (closed) return;
    closed = true;
    podiumReader?.close();
    for (const active of byConductorId.values()) active.reader.close();
    byConductorId.clear();
    pending.clear();
  };
  podiumReader = createFrameReader(stream, async (frame) => {
    const target = pending.get(frame.message.request_id) ??
      (typeof frame.message.body?.conductor_id === "string"
        ? byConductorId.get(frame.message.body.conductor_id)
        : undefined);
    if (!target) throw stableError("foreground_e2e_conductor_route_missing");
    pending.delete(frame.message.request_id);
    await writeFrame(target.channel, frame.message, frame.secret);
  }, fail);
  return Object.freeze({
    add(active) {
      if (closed || !active || !identifier(active.conductor.conductorId) || !active.channel ||
          byConductorId.has(active.conductor.conductorId)) {
        throw stableError("foreground_e2e_conductor_route_invalid");
      }
      const reader = createFrameReader(active.channel, async (frame) => {
        pending.set(frame.message.request_id, active);
        await serial.write(frame.message, frame.secret);
      }, fail);
      byConductorId.set(active.conductor.conductorId, { ...active, reader });
    },
    remove(active) {
      const current = byConductorId.get(active?.conductor?.conductorId);
      if (!current) return;
      current.reader.close();
      byConductorId.delete(active.conductor.conductorId);
      for (const [requestId, target] of pending) {
        if (target === active || target.child === active.child) pending.delete(requestId);
      }
    },
    close() {
      fail();
    },
  });
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

async function closeRuntime({ podium, host, conductors, reporter }) {
  if (!podium) return;
  try {
    for (const conductor of conductors) {
      await podium.client.command({ kind: "stop_conductor", conductor_id: conductor.conductorId });
    }
  } catch {
    reporter?.childExit({ component: "podium", reasonCode: "graceful_stop_failed" });
  } finally {
    await host?.close?.();
    await podium.close();
  }
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
    repositoryRoot: repository.repositoryRoot,
    baseBranch: repository.baseBranch,
  });
}

function hostConductor(value, expectedOrganizationId) {
  if (!value || typeof value !== "object" || !identifier(value.binding_id) || !identifier(value.conductor_id) ||
      !shortHash(value.conductor_short_hash) || !identifier(value.linear_installation_id) ||
      !identifier(value.organization_id) || value.organization_id !== expectedOrganizationId ||
      !identifier(value.repository_handle) || !boundedPath(value.repository_root) || !branch(value.base_branch) ||
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

function drain(stream) {
  stream?.on?.("data", () => {});
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
