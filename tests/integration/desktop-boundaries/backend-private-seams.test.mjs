import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("Desktop Backend closes Client, Host, Profile, and binary secret seams", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "symphony-backend-seam-"));
  const child = spawn("node", ["apps/podium-desktop/dist-backend/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SYMPHONY_PODIUM_DATA_ROOT: dataRoot,
      SYMPHONY_LINEAR_CLIENT_ID: "client-id",
      SYMPHONY_LINEAR_CLIENT_SECRET: "client-secret",
      SYMPHONY_HOST_IPC_FD: "3",
      SYMPHONY_CONDUCTOR_IPC_FD: "4",
    },
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  context.after(async () => {
    child.kill("SIGTERM");
    await rm(dataRoot, { recursive: true, force: true });
  });
  const client = linePeer(child.stdout);
  const host = linePeer(child.stdio[3]);
  const conductor = linePeer(child.stdio[4]);

  child.stdin.write(frame("overview-1", { kind: "get_desktop_overview" }));
  const overview = await client.next();
  assert.equal(overview.body.linear_connection.status, "disconnected");
  assert.deepEqual(overview.body.projects, []);

  child.stdin.write(frame("connect-1", { kind: "connect_linear" }));
  const open = await host.next();
  assert.equal(open.body.kind, "open_external_url");
  assert.match(open.body.url, /^https:\/\/linear\.app\/oauth\/authorize\?/);
  assert.equal(new URL(open.body.url).searchParams.get("code_challenge_method"), "S256");
  child.stdio[3].write(frame(open.request_id, {
    kind: "host_command_accepted",
    command_kind: "open_external_url",
  }));
  const accepted = await client.next();
  assert.equal(accepted.body.kind, "command_accepted");

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
  child.stdio[4].write(frame(profileRequest.message.request_id, {
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
});

function frame(requestId, body) {
  return `${JSON.stringify({
    protocol_version: "1",
    request_id: requestId,
    body,
  })}\n`;
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
