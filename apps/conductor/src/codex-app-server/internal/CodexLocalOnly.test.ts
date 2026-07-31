import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import { parseCorrelationId } from "../../contracts/identity.js";
import type { RootToolSpec } from "../../runtime/RootToolBoundary.js";
import {
  assertCodexLocalOnlyConfig,
  createCodexLocalOnlyRuntime,
} from "./CodexLocalOnly.js";
import {
  CodexProcess,
  testCodexOptions,
  type CodexProcessOptions,
  type CodexProcessLaunch,
  type CodexSpawner,
  type SpawnedCodexProcess,
} from "./CodexProcess.js";
import { CodexThread } from "./CodexThread.js";
import { JsonlFrameDecoder } from "./JsonlPeer.js";

const execFileAsync = promisify(execFile);

interface FakeServer extends SpawnedCodexProcess {
  readonly output: PassThrough;
  send(message: Record<string, unknown>): void;
}

const workspaceRoot = "/tmp/symphony-root-worktree";
const codexHome = "/tmp/symphony-performer-home";
const rootHome = "/tmp/symphony-root-home";
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

function rootLocalOnlyOptions(
  dynamicTools: readonly RootToolSpec[] = [],
  codexHomeValue = rootHome,
): CodexProcessOptions {
  return {
    ...testCodexOptions(codexHomeValue),
    capabilityMode: {
      kind: "root_local_only",
      workspaceRoot,
      dynamicTools,
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
              codexHome: resolvedLaunch.env.CODEX_HOME,
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
              data: [policy?.readPermissionProfile, policy?.writePermissionProfile]
                .filter((id): id is string => typeof id === "string")
                .map((id) => ({ id, allowed: true })),
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

test("Root local-only authority exposes no native filesystem access and repeats every turn boundary", async (context) => {
  const testRootHome = await mkdtemp(path.join(os.tmpdir(), "symphony-root-policy-"));
  context.after(async () => rm(testRootHome, { recursive: true, force: true }));
  const tool = Object.freeze({
    type: "function" as const,
    name: "get_issue",
    description: "Read one bounded issue.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        capability: Object.freeze({ const: "task_manage:get_issue" }),
      }),
    }),
  });
  const fake = fakeSpawner();
  const process = await CodexProcess.start(rootLocalOnlyOptions([tool], testRootHome), fake.spawner);
  const policy = fake.launch()?.localOnly;
  assert.ok(policy);
  assert.equal((policy as { readonly role?: unknown }).role, "root");

  const permissions = policy.expectedConfig.permissions as Record<
    string,
    { readonly filesystem: Readonly<Record<string, unknown>>; readonly network: { readonly enabled: boolean } }
  >;
  const profile = permissions[policy.readPermissionProfile];
  assert.ok(profile);
  assert.equal(Object.keys(permissions).length, 1);
  assert.deepEqual(profile.filesystem, {
    glob_scan_max_depth: null,
    ":root": "deny",
    ":slash_tmp": "deny",
    ":tmpdir": "deny",
  });
  assert.equal(Object.hasOwn(profile.filesystem, workspaceRoot), false);
  assert.equal(Object.hasOwn(profile.filesystem, testRootHome), false);
  assert.equal(profile.network.enabled, false);
  const shellEnvironment = policy.expectedConfig.shell_environment_policy as {
    readonly inherit: string;
    readonly ignore_default_excludes: boolean;
    readonly exclude: readonly string[];
    readonly set: Readonly<Record<string, string>>;
    readonly include_only: readonly string[];
    readonly filters: null;
    readonly experimental_use_profile: boolean;
  };
  assert.equal(shellEnvironment.inherit, "none");
  assert.equal(shellEnvironment.ignore_default_excludes, false);
  assert.deepEqual(shellEnvironment.exclude, []);
  assert.deepEqual(shellEnvironment.include_only, []);
  assert.equal(shellEnvironment.filters, null);
  assert.equal(shellEnvironment.experimental_use_profile, false);
  assert.deepEqual(
    Object.values(policy.expectedConfig.features as Readonly<Record<string, boolean>>),
    Object.values(policy.expectedConfig.features as Readonly<Record<string, boolean>>).map(() => false),
  );
  for (const credentialName of [
    "AWS_ACCESS_KEY_ID", "GITHUB_TOKEN", "HOME", "LINEAR_API_KEY", "OPENAI_API_KEY",
    "SSH_AUTH_SOCK", "SYMPHONY_CODEX_API_KEY", "SYMPHONY_LINEAR_TOKEN",
  ]) {
    assert.equal(credentialName in shellEnvironment.set, false, credentialName);
  }

  const contaminatedConfig = structuredClone(policy.expectedConfig);
  const contaminatedShell = contaminatedConfig.shell_environment_policy as {
    set: Record<string, string>;
  };
  contaminatedShell.set.AWS_SECRET_ACCESS_KEY = "must-not-survive-layer-merging";
  assert.throws(
    () => assertCodexLocalOnlyConfig({ config: contaminatedConfig }, policy),
    /codex_local_only_preflight_failed/u,
  );

  const forbiddenTool = Object.freeze({
    ...tool,
    name: "plan",
    inputSchema: Object.freeze({
      ...tool.inputSchema,
      properties: Object.freeze({ capability: Object.freeze({ const: "performer:plan" }) }),
    }),
  });
  await assert.rejects(CodexThread.create(process, {
    cwd: workspaceRoot,
    tools: [forbiddenTool],
    correlationId: parseCorrelationId("thread:root-tool-expansion"),
    access: { kind: "read_only" },
    toolMode: "local_only",
  }), /codex_local_only_capability_mismatch/u);
  assert.equal(fake.requests.some(({ method }) => method === "thread/start"), false);

  await assert.rejects(CodexThread.create(process, {
    cwd: workspaceRoot,
    tools: policy.dynamicTools,
    correlationId: parseCorrelationId("thread:root-native-tools"),
    access: { kind: "read_only" },
    toolMode: "local_only",
    nativeTools: true,
  }), /codex_local_only_capability_mismatch/u);
  assert.equal(fake.requests.some(({ method }) => method === "thread/start"), false);

  const thread = await CodexThread.create(process, {
    cwd: workspaceRoot,
    tools: policy.dynamicTools,
    correlationId: parseCorrelationId("thread:root-local-only"),
    access: { kind: "read_only" },
    toolMode: "local_only",
    nativeTools: false,
  });
  try {
    await thread.turn("inspect", parseCorrelationId("turn:root-local-only"), 2_000);
    assert.deepEqual(
      fake.requests.find(({ method }) => method === "thread/start")?.params,
      {
        cwd: workspaceRoot,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: policy.readPermissionProfile,
        dynamicTools: [tool],
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
        input: [{ type: "text", text: "inspect" }],
        cwd: workspaceRoot,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: policy.readPermissionProfile,
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

test("installed Codex app-server exposes only declared Root tools or rejects before model effects", {
  skip: process.platform === "win32",
  timeout: 30_000,
}, async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-root-app-server-probe-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const rootHome = path.join(temporary, "root-home");
  const workspace = path.join(temporary, "workspace");
  await Promise.all([mkdir(rootHome), mkdir(workspace)]);
  await Promise.all([
    writeFile(path.join(rootHome, "auth.json"), "root-auth-secret\n", "utf8"),
    writeFile(path.join(workspace, "code.ts"), "export const answer = 42;\n", "utf8"),
    writeFile(path.join(workspace, ".env.production"), "TOKEN=repository-secret\n", "utf8"),
  ]);
  const canonicalRootHome = await realpath(rootHome);
  const canonicalWorkspace = await realpath(workspace);
  const declaredTool: RootToolSpec = Object.freeze({
    type: "function",
    name: "read_code_file",
    description: "Read one bounded non-sensitive code file.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        capability: Object.freeze({ const: "code_inspection:read_file" }),
      }),
      required: Object.freeze(["capability"]),
    }),
  });
  const sse = (events: readonly Record<string, unknown>[]): string => events.map((event) => (
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
  )).join("");
  const finalResponse = (responseId: string, messageId: string): string => sse([
    { type: "response.created", response: { id: responseId } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: messageId,
        content: [{ type: "output_text", text: "done" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]);
  const responses = [
    finalResponse("response-1", "message-1"),
    finalResponse("response-2", "message-2"),
  ];
  const requests: string[] = [];
  const apiServer = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push(body);
      const next = responses.shift();
      if (request.method !== "POST" || request.url !== "/v1/responses" || next === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unexpected probe request" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(next);
    });
  });
  await new Promise<void>((resolve, reject) => {
    apiServer.once("error", reject);
    apiServer.listen(0, "127.0.0.1", resolve);
  });
  const address = apiServer.address() as AddressInfo;
  let codex: CodexProcess | undefined;
  try {
    try {
      codex = await CodexProcess.start({
        ...testCodexOptions(canonicalRootHome),
        apiKey: "probe-api-key",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        startupTimeoutMs: 5_000,
        requestTimeoutMs: 5_000,
        shutdownTimeoutMs: 2_000,
        capabilityMode: {
          kind: "root_local_only",
          workspaceRoot: canonicalWorkspace,
          dynamicTools: [declaredTool],
          deploymentPolicy,
        },
      });
    } catch (error) {
      assert.equal((error as Error).message, "codex_local_only_preflight_failed:requirements");
    }
    if (codex !== undefined) {
      try {
        const rootRuntime = codex.localOnly;
        assert.ok(rootRuntime);
        assert.equal(rootRuntime.role, "root");
        const thread = await CodexThread.create(codex, {
          cwd: canonicalWorkspace,
          tools: rootRuntime.dynamicTools,
          correlationId: parseCorrelationId("thread:installed-root"),
          access: { kind: "read_only" },
          toolMode: "local_only",
          nativeTools: false,
        });
        try {
          for (const correlationId of ["turn:installed-root:1", "turn:installed-root:2"] as const) {
            const turn = await thread.turn("Run the requested probe.", parseCorrelationId(correlationId), 10_000);
            assert.equal(turn.status, "completed");
          }
        } finally {
          thread.close();
        }
      } finally {
        await codex.shutdown();
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
  }

  if (codex === undefined) {
    assert.equal(requests.length, 0);
    assert.equal(responses.length, 2);
    assert.equal(await readFile(path.join(canonicalWorkspace, "code.ts"), "utf8"), "export const answer = 42;\n");
    assert.equal(await readFile(path.join(canonicalRootHome, "auth.json"), "utf8"), "root-auth-secret\n");
    return;
  }

  assert.equal(responses.length, 0);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const body = JSON.parse(request) as { readonly tools?: readonly Record<string, unknown>[] };
    assert.ok(Array.isArray(body.tools));
    assert.deepEqual(
      body.tools.map((entry) => ({ type: entry.type, name: entry.name })),
      [{ type: "function", name: "read_code_file" }],
    );
    assert.equal(request.includes("exec_command"), false);
    assert.equal(request.includes("apply_patch"), false);
    assert.equal(request.includes("repository-secret"), false);
    assert.equal(request.includes("root-auth-secret"), false);
  }
  assert.equal(await readFile(path.join(canonicalWorkspace, "code.ts"), "utf8"), "export const answer = 42;\n");
  assert.equal(await readFile(path.join(canonicalRootHome, "auth.json"), "utf8"), "root-auth-secret\n");
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

test("installed Codex sandbox enforces the Root filesystem profile without partial write effects", { timeout: 30_000 }, async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-root-profile-probe-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const slashTmp = path.join("/tmp", path.basename(temporary));
  await mkdir(slashTmp);
  context.after(async () => rm(slashTmp, { recursive: true, force: true }));
  const rootHome = path.join(temporary, "root-home");
  const workspace = path.join(temporary, "workspace");
  const outside = path.join(temporary, "outside");
  const deeplyNested = path.join(workspace, ...Array.from({ length: 70 }, (_, index) => `d${index}`));
  await Promise.all([
    mkdir(path.join(rootHome, ".symphony-root-authority"), { recursive: true }),
    mkdir(path.join(rootHome, ".tmp"), { recursive: true }),
    mkdir(path.join(rootHome, "db-backups"), { recursive: true }),
    mkdir(path.join(rootHome, "memories"), { recursive: true }),
    mkdir(path.join(rootHome, "symphony"), { recursive: true }),
    mkdir(path.join(rootHome, "thread-writer-locks"), { recursive: true }),
    mkdir(path.join(rootHome, "rules"), { recursive: true }),
    mkdir(path.join(workspace, "src"), { recursive: true }),
    mkdir(path.join(workspace, "nested", "certs"), { recursive: true }),
    mkdir(path.join(workspace, "nested", "auth"), { recursive: true }),
    mkdir(path.join(workspace, "nested", ".config", "git"), { recursive: true }),
    mkdir(path.join(workspace, "nested", ".terraform.d"), { recursive: true }),
    mkdir(deeplyNested, { recursive: true }),
    mkdir(outside),
  ]);
  await Promise.all([
    writeFile(path.join(rootHome, "auth.json"), "root-auth-secret\n", "utf8"),
    writeFile(path.join(rootHome, "review.config.toml"), "model = \"secret-model\"\n", "utf8"),
    writeFile(path.join(rootHome, "state_5.sqlite"), "root-runtime-state\n", "utf8"),
    writeFile(path.join(rootHome, "thread_history_1.sqlite"), "root-thread-state\n", "utf8"),
    writeFile(path.join(rootHome, "models_cache.json"), "root-model-state\n", "utf8"),
    writeFile(path.join(rootHome, "installation_id"), "root-installation-state\n", "utf8"),
    writeFile(path.join(rootHome, "external_agent_session_imports.json"), "root-import-state\n", "utf8"),
    writeFile(path.join(rootHome, "AGENTS.md"), "root-instructions\n", "utf8"),
    writeFile(path.join(rootHome, ".tmp", "plugins.sha"), "root-plugin-state\n", "utf8"),
    writeFile(path.join(rootHome, "db-backups", "state.sqlite"), "root-db-backup\n", "utf8"),
    writeFile(path.join(rootHome, "memories", "memory.md"), "root-memory-state\n", "utf8"),
    writeFile(path.join(rootHome, "thread-writer-locks", "thread.lock"), "root-lock-state\n", "utf8"),
    writeFile(path.join(rootHome, ".codex-global-state.json"), "root-global-state\n", "utf8"),
    writeFile(path.join(rootHome, "rules", "default.rules"), "root-rules\n", "utf8"),
    writeFile(path.join(rootHome, "symphony", "continuity.json"), "root-state-secret\n", "utf8"),
    writeFile(path.join(workspace, "src", "code.ts"), "export const exact = 21 * 2;\n", "utf8"),
    writeFile(path.join(workspace, "obsolete.txt"), "keep me\n", "utf8"),
    writeFile(path.join(workspace, "nested", ".env.production"), "TOKEN=repository-secret\n", "utf8"),
    writeFile(
      path.join(workspace, "notes.txt"),
      "-----BEGIN PRIVATE KEY-----\narbitrary-name-secret\n-----END PRIVATE KEY-----\n",
      "utf8",
    ),
    writeFile(path.join(workspace, "nested", "certs", "deploy.pem"), "private-key-secret\n", "utf8"),
    writeFile(path.join(workspace, "nested", "certs", "identity.ppk"), "putty-key-secret\n", "utf8"),
    writeFile(path.join(workspace, "nested", "certs", "keystore.jks"), "java-key-secret\n", "utf8"),
    writeFile(path.join(workspace, "nested", "certs", "key.pk8"), "pkcs-key-secret\n", "utf8"),
    writeFile(path.join(workspace, "nested", "certs", "id_rsa.bak"), "backup-key-secret\n", "utf8"),
    writeFile(path.join(workspace, "nested", "auth", "credentials.json"), "credential-secret\n", "utf8"),
    writeFile(
      path.join(workspace, "nested", "auth", "application_default_credentials.json"),
      "gcloud-credential-secret\n",
      "utf8",
    ),
    writeFile(path.join(workspace, "nested", ".gitconfig"), "remote-auth-config\n", "utf8"),
    writeFile(path.join(workspace, "nested", ".config", "git", "config"), "git-config-secret\n", "utf8"),
    writeFile(
      path.join(workspace, "nested", ".terraform.d", "credentials.tfrc.json"),
      "terraform-credential-secret\n",
      "utf8",
    ),
    writeFile(path.join(deeplyNested, ".env.deep"), "DEEP_TOKEN=repository-secret\n", "utf8"),
    writeFile(path.join(outside, "existing.txt"), "outside\n", "utf8"),
  ]);
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.name", "Symphony Test"],
    ["config", "user.email", "symphony@example.invalid"],
    ["add", "-f", "src/code.ts", "obsolete.txt", "nested/.env.production"],
    ["commit", "--no-gpg-sign", "-m", "probe revision"],
  ]) {
    await execFileAsync("git", args, { cwd: workspace, encoding: "utf8" });
  }
  const secretObjectId = (await execFileAsync("git", ["hash-object", "nested/.env.production"], {
    cwd: workspace,
    encoding: "utf8",
  })).stdout.trim();
  const [canonicalRootHome, canonicalWorkspace, canonicalOutside, canonicalSlashTmp] = await Promise.all([
    realpath(rootHome),
    realpath(workspace),
    realpath(outside),
    realpath(slashTmp),
  ]);
  const originalMode = (await stat(path.join(canonicalWorkspace, "src", "code.ts"))).mode & 0o777;
  const runtime = createCodexLocalOnlyRuntime({
    kind: "root_local_only",
    workspaceRoot: canonicalWorkspace,
    deploymentPolicy,
  }, canonicalRootHome, "01234567-89ab-cdef-0123-456789abcdef");
  const sandboxArguments = [
    "sandbox",
    ...runtime.configArguments,
    "--permission-profile",
    runtime.readPermissionProfile,
    "--cd",
    canonicalWorkspace,
  ];
  const sandboxEnvironment = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    CODEX_HOME: canonicalRootHome,
    OPENSSL_CONF: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  const probeScript = String.raw`
    const fs = require("node:fs/promises");
    const path = require("node:path");
    const [workspace, rootHome, outside, slashTmp, deeplyNested, secretObject] = process.argv.slice(1);
    const results = {};
    async function attempt(name, operation) {
      try { results[name] = { ok: true, value: await operation() }; }
      catch (error) { results[name] = { ok: false, code: error && error.code || null }; }
    }
    (async () => {
      const code = path.join(workspace, "src", "code.ts");
      await attempt("code_read", () => fs.readFile(code, "utf8"));
      await attempt("code_search", async () => (await fs.readdir(path.join(workspace, "src"))).sort());
      await attempt("create", () => fs.writeFile(path.join(workspace, "created.txt"), "created\n"));
      await attempt("update", () => fs.appendFile(code, "changed\n"));
      await attempt("delete", () => fs.unlink(path.join(workspace, "obsolete.txt")));
      await attempt("chmod", () => fs.chmod(code, 0o600));
      await attempt("env_read", () => fs.readFile(path.join(workspace, "nested", ".env.production"), "utf8"));
      await attempt("arbitrary_private_key_read", () => fs.readFile(path.join(workspace, "notes.txt"), "utf8"));
      await attempt("key_read", () => fs.readFile(path.join(workspace, "nested", "certs", "deploy.pem"), "utf8"));
      await attempt("putty_key_read", () => fs.readFile(path.join(workspace, "nested", "certs", "identity.ppk"), "utf8"));
      await attempt("java_keystore_read", () => fs.readFile(path.join(workspace, "nested", "certs", "keystore.jks"), "utf8"));
      await attempt("pk8_key_read", () => fs.readFile(path.join(workspace, "nested", "certs", "key.pk8"), "utf8"));
      await attempt("backup_key_read", () => fs.readFile(path.join(workspace, "nested", "certs", "id_rsa.bak"), "utf8"));
      await attempt("credentials_read", () => fs.readFile(path.join(workspace, "nested", "auth", "credentials.json"), "utf8"));
      await attempt("gcloud_credentials_read", () => fs.readFile(path.join(workspace, "nested", "auth", "application_default_credentials.json"), "utf8"));
      await attempt("nested_gitconfig_read", () => fs.readFile(path.join(workspace, "nested", ".gitconfig"), "utf8"));
      await attempt("nested_git_config_read", () => fs.readFile(path.join(workspace, "nested", ".config", "git", "config"), "utf8"));
      await attempt("terraform_credentials_read", () => fs.readFile(path.join(workspace, "nested", ".terraform.d", "credentials.tfrc.json"), "utf8"));
      await attempt("deep_env_read", () => fs.readFile(path.join(deeplyNested, ".env.deep"), "utf8"));
      await attempt("git_config_read", () => fs.readFile(path.join(workspace, ".git", "config"), "utf8"));
      await attempt("git_head_read", () => fs.readFile(path.join(workspace, ".git", "HEAD"), "utf8"));
      await attempt("git_object_read", async () => require("node:zlib").inflateSync(
        await fs.readFile(secretObject),
      ).toString("utf8"));
      await attempt("root_auth_read", () => fs.readFile(path.join(rootHome, "auth.json"), "utf8"));
      await attempt("root_profile_read", () => fs.readFile(path.join(rootHome, "review.config.toml"), "utf8"));
      await attempt("root_profile_overwrite", () => fs.writeFile(path.join(rootHome, "review.config.toml"), "changed\n"));
      await attempt("root_profile_create", () => fs.writeFile(path.join(rootHome, "new.config.toml"), "created\n"));
      await attempt("root_sqlite_read", () => fs.readFile(path.join(rootHome, "state_5.sqlite"), "utf8"));
      await attempt("root_thread_history_read", () => fs.readFile(path.join(rootHome, "thread_history_1.sqlite"), "utf8"));
      await attempt("root_models_cache_read", () => fs.readFile(path.join(rootHome, "models_cache.json"), "utf8"));
      await attempt("root_installation_read", () => fs.readFile(path.join(rootHome, "installation_id"), "utf8"));
      await attempt("root_import_state_read", () => fs.readFile(path.join(rootHome, "external_agent_session_imports.json"), "utf8"));
      await attempt("root_agents_read", () => fs.readFile(path.join(rootHome, "AGENTS.md"), "utf8"));
      await attempt("root_tmp_read", () => fs.readFile(path.join(rootHome, ".tmp", "plugins.sha"), "utf8"));
      await attempt("root_db_backup_read", () => fs.readFile(path.join(rootHome, "db-backups", "state.sqlite"), "utf8"));
      await attempt("root_memory_read", () => fs.readFile(path.join(rootHome, "memories", "memory.md"), "utf8"));
      await attempt("root_writer_lock_read", () => fs.readFile(path.join(rootHome, "thread-writer-locks", "thread.lock"), "utf8"));
      await attempt("root_authority_write", () => fs.writeFile(path.join(rootHome, ".symphony-root-authority", "claim"), "changed\n"));
      await attempt("root_authority_rename", () => fs.rename(
        path.join(rootHome, ".symphony-root-authority"),
        path.join(rootHome, "moved-authority"),
      ));
      await attempt("root_authority_delete", () => fs.rmdir(path.join(rootHome, ".symphony-root-authority")));
      await attempt("root_global_state_read", () => fs.readFile(path.join(rootHome, ".codex-global-state.json"), "utf8"));
      await attempt("root_rules_read", () => fs.readFile(path.join(rootHome, "rules", "default.rules"), "utf8"));
      await attempt("root_state_read", () => fs.readFile(path.join(rootHome, "symphony", "continuity.json"), "utf8"));
      await attempt("code_link_create", () => fs.symlink(code, path.join(rootHome, "code-link")));
      await attempt("outside_link_create", () => fs.symlink(path.join(outside, "existing.txt"), path.join(rootHome, "outside-link")));
      await attempt("code_write_via_root_link", () => fs.appendFile(path.join(rootHome, "code-link"), "changed\n"));
      await attempt("outside_read_via_root_link", () => fs.readFile(path.join(rootHome, "outside-link"), "utf8"));
      await attempt("root_home_write", () => fs.writeFile(path.join(rootHome, "result.md"), "allowed\n"));
      await attempt("outside_write", () => fs.writeFile(path.join(outside, "created.txt"), "outside\n"));
      await attempt("slash_tmp_write", () => fs.writeFile(path.join(slashTmp, "created.txt"), "temporary\n"));
      process.stdout.write(JSON.stringify(results));
    })().catch(() => process.exit(2));
  `;
  await assert.rejects(
    execFileAsync("codex", [
      ...sandboxArguments,
      "--",
      process.execPath,
      "--openssl-config=/dev/null",
      "-e",
      probeScript,
      canonicalWorkspace,
      canonicalRootHome,
      canonicalOutside,
      canonicalSlashTmp,
      deeplyNested,
      path.join(
        canonicalWorkspace,
        ".git",
        "objects",
        secretObjectId.slice(0, 2),
        secretObjectId.slice(2),
      ),
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
      env: sandboxEnvironment,
    }),
    (error: unknown) => {
      const failure = error as { readonly code?: unknown; readonly stdout?: unknown };
      if (process.platform === "darwin") assert.equal(failure.code, 134);
      else assert.notEqual(failure.code, 0);
      assert.equal(failure.stdout, "");
      return true;
    },
  );
  await assert.rejects(readFile(path.join(canonicalWorkspace, "created.txt"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(path.join(canonicalWorkspace, "src", "code.ts"), "utf8"), "export const exact = 21 * 2;\n");
  assert.equal(await readFile(path.join(canonicalWorkspace, "obsolete.txt"), "utf8"), "keep me\n");
  assert.equal((await stat(path.join(canonicalWorkspace, "src", "code.ts"))).mode & 0o777, originalMode);
  await assert.rejects(readFile(path.join(canonicalRootHome, "result.md"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(path.join(canonicalRootHome, "review.config.toml"), "utf8"), "model = \"secret-model\"\n");
  await assert.rejects(readFile(path.join(canonicalRootHome, "new.config.toml"), "utf8"), { code: "ENOENT" });
  assert.equal((await stat(path.join(canonicalRootHome, ".symphony-root-authority"))).isDirectory(), true);
  await assert.rejects(readFile(path.join(canonicalRootHome, ".symphony-root-authority", "claim"), "utf8"), { code: "ENOENT" });
  await assert.rejects(stat(path.join(canonicalRootHome, "moved-authority")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(canonicalRootHome, "code-link")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(canonicalRootHome, "outside-link")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(canonicalOutside, "created.txt"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(canonicalSlashTmp, "created.txt"), "utf8"), { code: "ENOENT" });
});
