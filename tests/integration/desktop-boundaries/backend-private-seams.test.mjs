import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqlitePodiumStoreImpl } from "../../../packages/podium/dist/internal/storage/SqlitePodiumStoreImpl.js";

test("Desktop Backend closes Client, Host, Profile, and binary secret seams", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "symphony-backend-seam-"));
  const socketPath = path.join(dataRoot, "conductor.sock");
  const store = new SqlitePodiumStoreImpl(path.join(dataRoot, "podium.db"));
  store.saveLinearInstallation({
    kind: "development_token", installationId: "installation-1", organizationId: "organization-1",
    accessToken: "test-token", delegateActorId: "delegate-1",
  });
  store.saveConductorBinding({
    bindingId: "binding-1", conductorId: "conductor-1", conductorShortHash: "abc123",
    linearInstallationId: "installation-1", organizationId: "organization-1",
    repositoryContext: {
      repositoryHandle: "repo-1", repositoryIdentity: "repository-1",
      repositoryDisplayName: "symphony", repositoryRoot: "/repository", baseBranch: "main",
    },
    desiredState: "running",
  });
  store.close();
  const child = spawn("node", ["apps/podium-desktop/dist-backend/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SYMPHONY_PODIUM_DATA_ROOT: dataRoot,
      SYMPHONY_LINEAR_CLIENT_ID: "client-id",
      SYMPHONY_LINEAR_CLIENT_SECRET: "client-secret",
      SYMPHONY_HOST_IPC_FD: "3",
      SYMPHONY_CONDUCTOR_SOCKET_PATH: socketPath,
    },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const conductorSocket = await connect(socketPath);
  let replacementSocket;
  context.after(async () => {
    conductorSocket.destroy();
    replacementSocket?.destroy();
    child.kill("SIGTERM");
    await rm(dataRoot, { recursive: true, force: true });
  });
  const client = linePeer(child.stdout);
  const host = linePeer(child.stdio[3]);
  const conductor = linePeer(conductorSocket);

  conductorSocket.write(frame("register-1", {
    kind: "conductor_channel_registration", binding_id: "binding-1",
    conductor_id: "conductor-1", instance_id: "instance-1",
  }));
  assert.deepEqual((await conductor.next()).body, {
    kind: "conductor_channel_registered", binding_id: "binding-1",
    conductor_id: "conductor-1", instance_id: "instance-1",
  });
  child.stdin.write(frame("profiles-before-handshake", {
    kind: "get_performer_profiles", conductor_id: "conductor-1",
  }));
  assert.equal((await client.next()).body.code, "podium_client_request_failed");
  conductorSocket.write(frame("handshake-1", {
    kind: "conductor_handshake", binding_id: "binding-1", conductor_id: "conductor-1",
    conductor_short_hash: "abc123", instance_id: "instance-1",
    linear_installation_id: "installation-1", organization_id: "organization-1",
    repository: { repository_handle: "repo-1", canonical_path: "/repository", base_branch: "main" },
  }));
  assert.equal((await conductor.next()).body.kind, "conductor_handshake_ack");

  child.stdin.write(frame("overview-1", { kind: "get_desktop_overview" }));
  const overview = await client.next();
  assert.equal(overview.body.linear_connection.status, "connected");
  assert.deepEqual(overview.body.projects, []);

  child.stdin.write(frame("connect-1", { kind: "connect_linear" }));
  const open = await host.next();
  assert.equal(open.body.kind, "open_external_url");
  assert.match(open.body.url, /^https:\/\/linear\.app\/oauth\/authorize\?/);
  assert.equal(new URL(open.body.url).searchParams.get("code_challenge_method"), "S256");
  child.stdio[3].write(frame(open.request_id, {
    kind: "host_operation_completed",
    operation: "open_external_url",
  }));
  const accepted = await client.next();
  assert.equal(accepted.body.kind, "linear_authorization_started");
  assert.equal(typeof accepted.body.attempt_id, "string");

  const secret = Buffer.from("one-shot-key");
  child.stdin.write(Buffer.concat([
    Buffer.from(frame("secret-1", {
      kind: "set_codex_api_key",
      conductor_id: "conductor-1",
      profile_id: "profile-1",
      secret_frame_length: secret.byteLength,
    })),
    secret,
  ]));
  const profileRequest = await conductor.next(secret.byteLength);
  assert.equal(profileRequest.message.body.kind, "set_api_key");
  assert.equal(profileRequest.secret.toString("utf8"), "one-shot-key");
  assert.equal(JSON.stringify(profileRequest.message).includes("one-shot-key"), false);
  conductorSocket.write(frame(profileRequest.message.request_id, {
    kind: "profile_status",
    profile: {
      profile_id: "profile-1",
      display_name: "API automation",
      authentication_method: "api_key",
      codex_turn_settings: {
        model: "gpt-5",
        reasoning_effort: "high",
        is_fast_mode_enabled: false,
      },
      execution_policy: {
        sandbox_mode: "workspace_write",
        command_allowlist: [],
        command_denylist: [],
      },
      readiness: "ready",
      is_active: false,
      observed_at: "2026-07-17T00:00:00.000Z",
    },
  }));
  const profile = await client.next();
  assert.equal(profile.body.profile_id, "profile-1");
  assert.equal(JSON.stringify(profile).includes("one-shot-key"), false);

  const oldChannelClosed = once(conductorSocket, "close");
  child.stdio[3].write(frame("exit-1", {
    kind: "process_observed_exit", binding_id: "binding-1", instance_id: "instance-1",
    observed_at: "2026-07-17T00:00:01.000Z", sanitized_reason: "conductor_process_exited",
  }));
  assert.equal((await host.next()).body.kind, "process_observed_exit");
  await oldChannelClosed;

  replacementSocket = await connect(socketPath);
  const replacement = linePeer(replacementSocket);
  replacementSocket.write(frame("register-2", {
    kind: "conductor_channel_registration", binding_id: "binding-1",
    conductor_id: "conductor-1", instance_id: "instance-2",
  }));
  assert.deepEqual((await replacement.next()).body, {
    kind: "conductor_channel_registered", binding_id: "binding-1",
    conductor_id: "conductor-1", instance_id: "instance-2",
  });
});

function frame(requestId, body) {
  return `${JSON.stringify({
    protocol_version: "1",
    request_id: requestId,
    body,
  })}\n`;
}

async function connect(socketPath) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function linePeer(stream) {
  let buffer = Buffer.alloc(0);
  const waiters = [];
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });
  function drain() {
    while (waiters.length > 0) {
      const waiter = waiters[0];
      const newline = buffer.indexOf(0x0a);
      if (newline < 0 || buffer.byteLength < newline + 1 + waiter.secretLength) return;
      const message = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      const secret = Buffer.from(
        buffer.subarray(newline + 1, newline + 1 + waiter.secretLength),
      );
      buffer = buffer.subarray(newline + 1 + waiter.secretLength);
      waiters.shift();
      waiter.resolve(
        waiter.secretLength > 0 ? { message, secret } : message,
      );
    }
  }
  return {
    next(secretLength = 0) {
      return new Promise((resolve) => {
        waiters.push({ secretLength, resolve });
        drain();
      });
    },
  };
}
