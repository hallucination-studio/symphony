import { createReadStream, createWriteStream } from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  decodeDesktopHostMessage,
  decodePodiumConductorMessage,
  type JsonValue,
} from "@symphony/contracts";
import {
  createPodiumClientServices,
  createPodiumConductorServices,
  createConductorPresence,
  PodiumClientProtocolHandler,
  PodiumConductorProtocolHandler,
  type PodiumDesktopHostPorts,
  type PodiumClientServices,
  type PodiumConductorServices,
  type PodiumConductorChannel,
  type LinearPhysicalRequestObservation,
  type LinearRequestCoalescingObservation,
} from "@symphony/podium";
import { FramedProtocolPeer } from "./FramedProtocolPeer.js";

const MAX_FRAME_BYTES = 1_048_576;

export interface PodiumBackendComposition {
  conductorServices: PodiumConductorServices;
  createClientServices(
    host: PodiumDesktopHostPorts,
  ): PodiumClientServices | Promise<PodiumClientServices>;
  close(): void;
}

export type PodiumBackendCompositionFactory = (input: {
  environment: NodeJS.ProcessEnv;
  dataRoot: string;
}) => PodiumBackendComposition | Promise<PodiumBackendComposition>;

export async function servePodiumClient(
  services: PodiumClientServices,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  const handler = new PodiumClientProtocolHandler(services);
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([
      buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    while (buffer.byteLength > 0) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > MAX_FRAME_BYTES) {
        await writeClientResponse(
          output,
          frameFailure("podium_client_frame_too_large"),
        );
        buffer.fill(0);
        buffer = Buffer.alloc(0);
        break;
      }
      let value: JsonValue;
      try {
        value = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        await writeClientResponse(
          output,
          frameFailure("podium_client_json_invalid"),
        );
        buffer = buffer.subarray(newline + 1);
        continue;
      }
      const secretLength = clientSecretLength(value);
      const consumed = newline + 1 + secretLength;
      if (buffer.byteLength < consumed) break;
      const secret =
        secretLength > 0
          ? Buffer.from(buffer.subarray(newline + 1, consumed))
          : undefined;
      buffer = buffer.subarray(consumed);
      const response = await handler.handle(value, secret);
      await writeClientResponse(output, response as JsonValue);
      secret?.fill(0);
    }
  }
  if (buffer.byteLength > 0) {
    buffer.fill(0);
    await writeClientResponse(
      output,
      frameFailure("podium_client_frame_incomplete"),
    );
  }
}

export async function runPodiumBackend(
  environment = process.env,
  createComposition: PodiumBackendCompositionFactory =
    createProductionComposition,
) {
  const dataRoot = required(environment.SYMPHONY_PODIUM_DATA_ROOT, "podium_data_root_missing");
  const conductorSocketPath = required(
    environment.SYMPHONY_CONDUCTOR_SOCKET_PATH,
    "conductor_socket_path_missing",
  );
  const hostFd = positiveInteger(
    environment.SYMPHONY_HOST_IPC_FD,
    "host_ipc_fd_invalid",
  );
  const hostInput = streamInput(hostFd);
  const hostOutput = streamOutput(hostFd);
  const composition = await createComposition({ environment, dataRoot });
  const conductorChannels = new ConductorChannelRegistry();
  const conductorServer = await serveConductorChannels(
    conductorSocketPath,
    composition.conductorServices,
    conductorChannels,
  );
  const clientServices: { current?: PodiumClientServices } = {};
  const hostPeer = new FramedProtocolPeer(hostInput, hostOutput, {
    decode: decodeDesktopHostMessage,
    secretLength: () => 0,
    async handleRequest(body) {
      const event = object(body, "host_event_invalid");
      if (event.kind === "process_observed_exit") {
        const bindingId = requiredString(event.binding_id, "binding_id_missing");
        const instanceId = requiredString(event.instance_id, "instance_id_missing");
        composition.conductorServices.observeExit({
          bindingId,
          instanceId,
          observedAt: requiredString(event.observed_at, "observed_at_missing"),
          ...(typeof event.sanitized_reason === "string"
            ? { sanitizedReason: event.sanitized_reason }
            : {}),
        });
        conductorChannels.revoke(bindingId, instanceId);
        return event;
      }
      if (event.kind !== "oauth_return" || !clientServices.current) {
        throw new Error("host_event_unsupported");
      }
      await clientServices.current.completeOAuth({
        state: requiredString(event.state, "oauth_state_missing"),
        authorizationCode: requiredString(
          event.authorization_code,
          "oauth_authorization_code_missing",
        ),
      });
      return event;
    },
  });
  const host = hostPorts(hostPeer, conductorChannels, dataRoot);
  try {
    clientServices.current = await composition.createClientServices(host);
    await servePodiumClient(
      clientServices.current,
      process.stdin,
      process.stdout,
    );
  } finally {
    await closeServer(conductorServer);
    composition.close();
  }
}

async function createProductionComposition({
  environment,
  dataRoot,
}: {
  environment: NodeJS.ProcessEnv;
  dataRoot: string;
}): Promise<PodiumBackendComposition> {
  const presence = createConductorPresence();
  const conductorOwner = createPodiumConductorServices({
    databasePath: path.join(dataRoot, "podium.db"),
    presence,
    observeLinearRequest: (observation) => {
      process.stderr.write(`${JSON.stringify(linearPhysicalRequestLog(observation))}\n`);
    },
    observeLinearRequestCoalesced: (observation) => {
      process.stderr.write(`${JSON.stringify(linearLogicalRequestCoalescedLog(observation))}\n`);
    },
  });
  let clientOwner: ReturnType<typeof createPodiumClientServices> | undefined;
  return {
    conductorServices: conductorOwner.services,
    createClientServices(host) {
      clientOwner = createPodiumClientServices({
        databasePath: path.join(dataRoot, "podium.db"),
        linearClientId: required(
          environment.SYMPHONY_LINEAR_CLIENT_ID,
          "linear_client_id_missing",
        ),
        linearClientSecret: required(
          environment.SYMPHONY_LINEAR_CLIENT_SECRET,
          "linear_client_secret_missing",
        ),
        linearRedirectUri: "symphony://oauth/linear/callback",
        host,
        presence,
      });
      return clientOwner.services;
    },
    close() {
      clientOwner?.close();
      conductorOwner.close();
    },
  };
}

function frameFailure(code: string) {
  return {
    protocol_version: "1",
    request_id: "invalid-request",
    body: {
      code,
      category: "podium_client",
      sanitized_reason: code,
      retryable: false,
      action_required: "retry_request",
      next_action: "Send one valid bounded Podium Client frame.",
    },
  };
}

function writeClientResponse(
  output: NodeJS.WritableStream,
  response: JsonValue,
): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(`${JSON.stringify(response)}\n`, (error) => {
      if (error) reject(new Error("podium_client_write_failed"));
      else resolve();
    });
  });
}

class ConductorChannelRegistry {
  readonly #channels = new Map<string, {
    conductorId: string;
    instanceId: string;
    peer: FramedProtocolPeer;
    channel: PodiumConductorChannel;
  }>();

  register(
    bindingId: string,
    conductorId: string,
    instanceId: string,
    peer: FramedProtocolPeer,
    channel: PodiumConductorChannel,
  ): void {
    if (this.#channels.has(bindingId) || [...this.#channels.values()].some(
      (channel) => channel.conductorId === conductorId,
    )) {
      throw new Error("conductor_channel_already_active");
    }
    this.#channels.set(bindingId, { conductorId, instanceId, peer, channel });
  }

  remove(bindingId: string, instanceId: string, peer: FramedProtocolPeer): void {
    const current = this.#channels.get(bindingId);
    if (current?.instanceId === instanceId && current.peer === peer) {
      this.#channels.delete(bindingId);
    }
  }

  revoke(bindingId: string, instanceId: string): void {
    const current = this.#channels.get(bindingId);
    if (!current) return;
    if (current.instanceId !== instanceId) {
      throw new Error("conductor_channel_generation_mismatch");
    }
    this.#channels.delete(bindingId);
    current.peer.close("conductor_channel_revoked");
  }

  request(body: JsonValue, secret: Uint8Array | undefined, requestId: string): Promise<JsonValue> {
    const value = object(body, "conductor_profile_request_invalid");
    const conductorId = requiredString(value.conductor_id, "conductor_id_missing");
    const channel = [...this.#channels.values()].find(
      (candidate) => candidate.conductorId === conductorId,
    );
    if (!channel?.channel.isAuthenticated()) throw new Error("conductor_channel_unavailable");
    return channel.peer.request({
      requestId,
      body,
      ...(secret ? { secret } : {}),
      timeoutMs: 120_000,
    });
  }
}

async function serveConductorChannels(
  socketPath: string,
  services: PodiumConductorServices,
  registry: ConductorChannelRegistry,
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let channel: PodiumConductorChannel | undefined;
    let bindingId: string | undefined;
    let conductorId: string | undefined;
    let instanceId: string | undefined;
    const peer = new FramedProtocolPeer(socket, socket, {
      decode: decodePodiumConductorMessage,
      secretLength: profileSecretLength,
      async handleRequest(body, secret, context) {
        const request = object(body, "conductor_channel_request_invalid");
        if (!channel) {
          if (request.kind !== "conductor_channel_registration") {
            throw new Error("conductor_channel_registration_required");
          }
          bindingId = requiredString(request.binding_id, "conductor_binding_missing");
          conductorId = requiredString(request.conductor_id, "conductor_id_missing");
          instanceId = requiredString(request.instance_id, "conductor_instance_missing");
          channel = services.openChannel({ bindingId, conductorId, instanceId });
          registry.register(bindingId, conductorId, instanceId, peer, channel);
          return {
            kind: "conductor_channel_registered",
            binding_id: bindingId,
            conductor_id: conductorId,
            instance_id: instanceId,
          };
        }
        if (request.kind === "conductor_channel_registration") {
          throw new Error("conductor_channel_registration_duplicate");
        }
        const response = await new PodiumConductorProtocolHandler(channel).handle({
          protocol_version: "1",
          request_id: requiredString(context?.requestId, "conductor_channel_request_id_missing"),
          body,
        }, secret);
        return (response as { body: JsonValue }).body;
      },
      onClose(error) {
        if (bindingId && instanceId) registry.remove(bindingId, instanceId, peer);
        channel?.close({ sanitizedReason: error.message });
      },
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function hostPorts(
  host: FramedProtocolPeer,
  conductor: ConductorChannelRegistry,
  dataRoot: string,
): PodiumDesktopHostPorts {
  let sequence = 0;
  const requestHost = (body: JsonValue) =>
    host.request({
      requestId: `host-${++sequence}`,
      body,
      timeoutMs: 30_000,
    });
  return {
    async openLinearAuthorization({ attemptId, authorizationUrl }) {
      await requestHost({
        kind: "open_external_url",
        attempt_id: attemptId,
        url: authorizationUrl,
      });
    },
    async resolveRepository(repositoryHandle, baseBranch) {
      const result = object(
        await requestHost({
          kind: "resolve_repository",
          repository_handle: repositoryHandle,
          base_branch: baseBranch,
        }),
        "repository_context_invalid",
      );
      const branches = Array.isArray(result.base_branches)
        ? result.base_branches
        : [];
      if (!branches.includes(baseBranch)) {
        throw new Error("repository_base_branch_missing");
      }
      return {
        repositoryHandle,
        repositoryIdentity: requiredString(
          result.remote_display,
          "repository_identity_missing",
        ),
        repositoryDisplayName: requiredString(
          result.display_name,
          "repository_display_name_missing",
        ),
        repositoryRoot: requiredString(
          result.canonical_path,
          "repository_root_missing",
        ),
        baseBranch,
      };
    },
    async startConductor(input) {
      await requestHost({
        kind: "start_conductor",
        binding_id: input.bindingId,
        conductor_id: input.conductorId,
        conductor_short_hash: input.conductorShortHash,
        linear_installation_id: input.linearInstallationId,
        organization_id: input.organizationId,
        repository_handle: input.repositoryHandle,
        repository_identity: input.repositoryIdentity,
        repository_root: input.repositoryRoot,
        base_branch: input.baseBranch,
        conductor_data_root: path.join(dataRoot, "conductors", input.conductorId),
      });
    },
    async stopConductor(conductorId) {
      await requestHost({
        kind: "stop_conductor",
        conductor_id: conductorId,
        deadline_at: new Date(Date.now() + 5_000).toISOString(),
      });
    },
    async restartConductor(conductorId) {
      await requestHost({
        kind: "restart_conductor",
        conductor_id: conductorId,
      });
    },
    relayProfile(body, secret) {
      return conductor.request(body, secret, `profile-${++sequence}`);
    },
  };
}

export function linearPhysicalRequestLog(
  observation: LinearPhysicalRequestObservation,
): Record<string, unknown> {
  const {
    correlationId,
    durationMs,
    installationId,
    logicalRequestId,
    projectId,
    requestClass,
    ...physical
  } = observation;
  return {
    event: "linear_physical_request",
    ...physical,
    correlation_id: correlationId,
    duration_ms: durationMs,
    ...(installationId ? { installation_id: installationId } : {}),
    ...(logicalRequestId ? { request_id: logicalRequestId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(requestClass ? { request_class: requestClass } : {}),
  };
}

export function linearLogicalRequestCoalescedLog(
  observation: LinearRequestCoalescingObservation,
): Record<string, unknown> {
  return {
    event: "linear_logical_request_coalesced",
    request_id: observation.requestId,
    coalesced_into_request_id: observation.coalescedIntoRequestId,
    request_class: observation.requestClass,
  };
}

function streamInput(fd: number) {
  return createReadStream("", { fd, autoClose: false });
}

function streamOutput(fd: number) {
  return createWriteStream("", { fd, autoClose: false });
}

function profileSecretLength(body: JsonValue): number {
  const value = object(body, "profile_frame_invalid");
  return value.kind === "set_api_key" &&
    typeof value.secret_frame_length === "number"
    ? value.secret_frame_length
    : 0;
}

function clientSecretLength(message: JsonValue): number {
  if (!message || typeof message !== "object" || Array.isArray(message)) return 0;
  const body = message.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  return body.kind === "set_codex_api_key" &&
    typeof body.secret_frame_length === "number"
    ? body.secret_frame_length
    : 0;
}

function object(
  value: JsonValue,
  code: string,
): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

function requiredString(value: JsonValue | undefined, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function required(value: string | undefined, code: string) {
  if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error(code);
  return value;
}

function positiveInteger(value: string | undefined, code: string) {
  if (!value || !/^\d+$/.test(value)) throw new Error(code);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(code);
  return number;
}

export function runPodiumBackendEntrypoint(
  createComposition?: PodiumBackendCompositionFactory,
): void {
  runPodiumBackend(process.env, createComposition).catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "podium_backend_start_failed",
        error_code: "podium_backend_start_failed",
        sanitized_reason:
          error instanceof Error && /^[a-z][a-z0-9_]{1,120}$/.test(error.message)
            ? error.message
            : "podium_backend_start_failed",
        action_required: "restart_desktop",
        retryable: false,
        next_action: "Restart the packaged Desktop runtime after resolving its local configuration.",
      })}\n`,
    );
    process.exitCode = 1;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPodiumBackendEntrypoint();
}
