import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { parseCorrelationId } from "../../contracts/identity.js";
import {
  CodexProcess,
  testCodexOptions,
  type CodexProcessLaunch,
  type CodexSpawner,
  type SpawnedCodexProcess,
} from "./CodexProcess.js";
import { CodexThread } from "./CodexThread.js";
import { JsonlFrameDecoder } from "./JsonlPeer.js";

interface FakeServer extends SpawnedCodexProcess {
  readonly output: PassThrough;
  send(message: Record<string, unknown>): void;
}

const workspaceRoot = "/tmp/symphony-root-worktree";
const codexHome = "/tmp/symphony-performer-home";
const deploymentPolicy = Object.freeze({
  managedMcpDenyAll: true as const,
  managedRemoteControlDisabled: true as const,
  remoteEnvironmentsAbsent: true as const,
  configurationImmutable: true as const,
});

function localOnlyOptions() {
  return {
    ...testCodexOptions(codexHome),
    capabilityMode: {
      kind: "local_only" as const,
      workspaceRoot,
      deploymentPolicy,
    },
  };
}

function fakeSpawner(
  mutate?: (method: string, response: Record<string, unknown>) => Record<string, unknown>,
) {
  const requests: Record<string, unknown>[] = [];
  let launch: CodexProcessLaunch | undefined;
  let kills = 0;
  const spawner: CodexSpawner = (_options, resolvedLaunch) => {
    launch = resolvedLaunch;
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    let running = true;
    events.once("exit", () => { running = false; });
    const decoder = new JsonlFrameDecoder();
    const server: FakeServer = {
      stdin: input,
      stdout: output,
      stderr,
      events,
      output,
      isRunning: () => running,
      kill: () => {
        kills += 1;
        queueMicrotask(() => events.emit("exit", 0, null));
        return true;
      },
      send: (message) => output.write(`${JSON.stringify(message)}\n`),
    };
    const send = (message: Record<string, unknown>, response: Record<string, unknown>) => {
      const method = String(message.method);
      server.send({ id: message.id, ...(mutate?.(method, response) ?? response) });
    };
    input.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        requests.push(message);
        const policy = resolvedLaunch.localOnly;
        if (message.method === "initialize") {
          send(message, {
            result: {
              codexHome,
              platformFamily: "unix",
              platformOs: "macos",
              userAgent: "symphony/0.146.0 (Mac OS; arm64)",
            },
          });
        } else if (message.method === "config/read") {
          send(message, { result: { config: policy?.expectedConfig, origins: {} } });
        } else if (message.method === "configRequirements/read") {
          send(message, { result: { requirements: { allowRemoteControl: false } } });
        } else if (message.method === "permissionProfile/list") {
          send(message, {
            result: {
              data: [
                { id: policy?.readPermissionProfile, allowed: true },
                { id: policy?.writePermissionProfile, allowed: true },
              ],
              nextCursor: null,
            },
          });
        } else if (message.method === "mcpServerStatus/list") {
          send(message, { result: { data: [], nextCursor: null } });
        } else if (message.method === "thread/start") {
          send(message, {
            result: {
              thread: { id: "thread-local" },
              cwd: workspaceRoot,
              approvalPolicy: "never",
              approvalsReviewer: "user",
              activePermissionProfile: {
                id: policy?.readPermissionProfile,
                extends: null,
              },
              instructionSources: [],
              runtimeWorkspaceRoots: [workspaceRoot],
            },
          });
        } else if (message.method === "turn/start") {
          send(message, { result: { turn: { id: "turn-local" } } });
          server.send({
            method: "turn/completed",
            params: {
              threadId: "thread-local",
              turn: {
                id: "turn-local",
                status: "completed",
                error: null,
                items: [{ id: "answer", type: "agentMessage", text: "{}" }],
              },
            },
          });
        }
      }
    });
    return server;
  };
  return { spawner, requests, launch: () => launch, kills: () => kills };
}

test("local-only process launch pins and preflights one isolated Codex capability boundary", async () => {
  const fake = fakeSpawner();
  const process = await CodexProcess.start(localOnlyOptions(), fake.spawner);
  try {
    const launch = fake.launch();
    assert.ok(launch?.localOnly);
    assert.equal(launch.cwd, workspaceRoot);
    assert.equal(launch.args[0], "app-server");
    assert.equal(launch.args.includes("--strict-config"), true);
    assert.equal(launch.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, "1");
    assert.equal("HOME" in launch.env, false);
    assert.equal("LINEAR_API_KEY" in launch.env, false);

    const policy = launch.localOnly;
    assert.notEqual(policy.readPermissionProfile, policy.writePermissionProfile);
    assert.match(policy.readPermissionProfile, /^symphony_read_[a-f0-9]{32}$/u);
    assert.match(policy.writePermissionProfile, /^symphony_write_[a-f0-9]{32}$/u);
    const permissions = policy.expectedConfig.permissions as Record<
      string,
      { readonly filesystem: Record<string, string>; readonly network: { readonly enabled: boolean } }
    >;
    assert.equal(permissions[policy.readPermissionProfile]?.filesystem["/"], undefined);
    assert.equal(permissions[policy.readPermissionProfile]?.filesystem[os.homedir()], "deny");
    assert.equal(permissions[policy.readPermissionProfile]?.filesystem[workspaceRoot], "read");
    assert.equal(permissions[policy.writePermissionProfile]?.filesystem[workspaceRoot], "write");
    assert.equal(
      permissions[policy.writePermissionProfile]?.filesystem[path.join(workspaceRoot, ".git")],
      "read",
    );
    for (const profile of Object.values(permissions)) {
      assert.equal(profile.filesystem[":minimal"], "read");
      assert.equal(profile.filesystem[":slash_tmp"], "deny");
      assert.equal(profile.filesystem[":tmpdir"], "deny");
      assert.equal(profile.network.enabled, false);
    }

    assert.deepEqual(
      fake.requests.map(({ method }) => method).slice(0, 6),
      [
        "initialize",
        "initialized",
        "config/read",
        "configRequirements/read",
        "permissionProfile/list",
        "mcpServerStatus/list",
      ],
    );
    assert.deepEqual(
      fake.requests.find(({ method }) => method === "config/read")?.params,
      { cwd: workspaceRoot, includeLayers: false },
    );
    assert.deepEqual(
      fake.requests.find(({ method }) => method === "permissionProfile/list")?.params,
      { cwd: workspaceRoot, limit: 1_000 },
    );
  } finally {
    await process.shutdown();
  }
});

test("local-only thread starts read-only and repeats the exact local boundary on every turn", async () => {
  const fake = fakeSpawner();
  const process = await CodexProcess.start(localOnlyOptions(), fake.spawner);
  const thread = await CodexThread.create(process, {
    cwd: workspaceRoot,
    tools: [],
    correlationId: parseCorrelationId("thread:local-only"),
    access: { kind: "workspace_write", writableRoot: workspaceRoot, networkAccess: false },
    toolMode: "local_only",
  });
  try {
    await thread.turn("work", parseCorrelationId("turn:local-only"), 2_000);
    const policy = fake.launch()?.localOnly;
    assert.ok(policy);
    assert.deepEqual(
      fake.requests.find(({ method }) => method === "thread/start")?.params,
      {
        cwd: workspaceRoot,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: policy.readPermissionProfile,
        dynamicTools: [],
        ephemeral: true,
        environments: [{
          environmentId: "local",
          cwd: workspaceRoot,
          runtimeWorkspaceRoots: [workspaceRoot],
        }],
        runtimeWorkspaceRoots: [workspaceRoot],
        selectedCapabilityRoots: [],
        baseInstructions: policy.baseInstructions,
        developerInstructions: policy.developerInstructions,
        config: policy.threadConfig,
      },
    );
    assert.deepEqual(
      fake.requests.find(({ method }) => method === "turn/start")?.params,
      {
        threadId: "thread-local",
        input: [{ type: "text", text: "work" }],
        cwd: workspaceRoot,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: policy.writePermissionProfile,
        environments: [{
          environmentId: "local",
          cwd: workspaceRoot,
          runtimeWorkspaceRoots: [workspaceRoot],
        }],
        runtimeWorkspaceRoots: [workspaceRoot],
      },
    );
  } finally {
    thread.close();
    await process.shutdown();
  }
});

test("local-only startup fails closed on an unattested or mismatched effective boundary", async () => {
  let spawns = 0;
  const neverSpawn: CodexSpawner = () => {
    spawns += 1;
    throw new Error("unexpected_spawn");
  };
  await assert.rejects(
    CodexProcess.start({
      ...localOnlyOptions(),
      capabilityMode: {
        ...localOnlyOptions().capabilityMode,
        deploymentPolicy: { ...deploymentPolicy, managedMcpDenyAll: false as never },
      },
    }, neverSpawn),
    /codex_local_only_policy_unattested/u,
  );
  assert.equal(spawns, 0);

  for (const mutate of [
    (method: string, response: Record<string, unknown>) => method === "initialize"
      ? { result: { codexHome, platformFamily: "unix", platformOs: "macos", userAgent: "symphony/0.147.0" } }
      : response,
    (method: string, response: Record<string, unknown>) => method === "initialize"
      ? {
          result: {
            codexHome: "/tmp/another-performer-home",
            platformFamily: "unix",
            platformOs: "macos",
            userAgent: "symphony/0.146.0 (Mac OS; arm64)",
          },
        }
      : response,
    (method: string, response: Record<string, unknown>) => method === "config/read"
      ? { result: { config: {}, origins: {} } }
      : response,
    (method: string, response: Record<string, unknown>) => method === "mcpServerStatus/list"
      ? { result: { data: [{ name: "linear" }], nextCursor: null } }
      : response,
  ]) {
    const fake = fakeSpawner(mutate);
    await assert.rejects(
      CodexProcess.start(localOnlyOptions(), fake.spawner),
      /codex_local_only_preflight_failed/u,
    );
    assert.equal(fake.kills(), 1);
  }
});

test("installed Codex CLI proves the local-only boundary or fails at the managed-policy precondition", { timeout: 15_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-local-only-probe-"));
  const installedHome = path.join(temporary, "home");
  const installedWorkspace = path.join(temporary, "workspace");
  await Promise.all([mkdir(installedHome), mkdir(installedWorkspace)]);
  const [canonicalHome, canonicalWorkspace] = await Promise.all([
    realpath(installedHome),
    realpath(installedWorkspace),
  ]);
  try {
    let process: CodexProcess;
    try {
      process = await CodexProcess.start({
        ...testCodexOptions(canonicalHome),
        capabilityMode: {
          kind: "local_only",
          workspaceRoot: canonicalWorkspace,
          deploymentPolicy,
        },
      });
    } catch (error) {
      assert.equal((error as Error).message, "codex_local_only_preflight_failed:requirements");
      return;
    }
    try {
      const thread = await CodexThread.create(process, {
        cwd: canonicalWorkspace,
        tools: [],
        correlationId: parseCorrelationId("thread:installed-local-only"),
        access: { kind: "read_only" },
        toolMode: "local_only",
        nativeTools: false,
      });
      thread.close();
    } finally {
      await process.shutdown();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
