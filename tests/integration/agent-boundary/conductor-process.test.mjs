import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const EVIDENCE_DEADLINE_MS = 10_000;

test("production Conductor completes its closed process boundary before agent admission", {
  timeout: EVIDENCE_DEADLINE_MS,
}, async (context) => {
  assert.equal(existsSync("apps/conductor/dist/main.js"), true, "build Conductor before running process evidence");
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-agent-boundary-"));
  const child = spawn(process.execPath, [path.resolve("apps/conductor/dist/main.js")], {
    cwd: process.cwd(),
    env: conductorEnvironment(root),
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  context.after(async () => {
    child.kill("SIGTERM");
    await waitForExit(child);
    await rm(root, { recursive: true, force: true });
  });
  const podium = linePeer(child.stdio[3]);

  const handshake = await podium.next();
  assert.equal(handshake.body.kind, "conductor_handshake");
  podium.reply(handshake, {
    kind: "conductor_handshake_ack",
    binding_id: "agent-boundary-binding",
    instance_id: "agent-boundary-instance",
    observed_at: new Date().toISOString(),
  });

  const projectResolution = await podium.next();
  assert.equal(projectResolution.body.kind, "resolve_conductor_project");
  podium.reply(projectResolution, { kind: "unbound" });
});

function conductorEnvironment(root) {
  return {
    ...baseChildEnvironment(),
    SYMPHONY_PRIVATE_IPC_FD: "3",
    SYMPHONY_INSTANCE_ID: "agent-boundary-instance",
    SYMPHONY_BINDING_ID: "agent-boundary-binding",
    SYMPHONY_CONDUCTOR_ID: "agent-boundary-conductor",
    SYMPHONY_CONDUCTOR_SHORT_HASH: "abc123def456",
    SYMPHONY_LINEAR_INSTALLATION_ID: "development-token:organization-1",
    SYMPHONY_ORGANIZATION_ID: "organization-1",
    SYMPHONY_REPOSITORY_HANDLE: "repository-1",
    SYMPHONY_REPOSITORY_IDENTITY: "repository-identity-1",
    SYMPHONY_REPOSITORY_ROOT: path.join(root, "repository"),
    SYMPHONY_BASE_BRANCH: "main",
    SYMPHONY_CONDUCTOR_DATA_ROOT: path.join(root, "conductor"),
    SYMPHONY_ROOT_DEADLINE_DURATION_MS: String(EVIDENCE_DEADLINE_MS),
    SYMPHONY_ROOT_MAX_CYCLES_PER_ROOT: "3",
    SYMPHONY_ROOT_MAX_SAME_OPEN_FINDING_CYCLES: "2",
    SYMPHONY_ROOT_MAX_CYCLE_REPAIR_ATTEMPTS: "0",
  };
}

function baseChildEnvironment() {
  return Object.fromEntries(
    ["HOME", "LANG", "LC_ALL", "PATH", "TMP", "TMPDIR", "TEMP", "USERPROFILE"]
      .flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]]] : []),
  );
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
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const message = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      buffer = buffer.subarray(newline + 1);
      waiters.shift().resolve(message);
    }
  }
  return {
    next() {
      return new Promise((resolve) => {
        waiters.push({ resolve });
        drain();
      });
    },
    reply(message, body) {
      stream.write(`${JSON.stringify({ protocol_version: "1", request_id: message.request_id, body })}\n`);
    },
  };
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await waitForExitSignal(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExitSignal(child);
}

function waitForExitSignal(child) {
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}
