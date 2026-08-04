import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

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

interface FakeServer extends SpawnedCodexProcess {
  readonly output: PassThrough;
  send(message: Record<string, unknown>): void;
}

const workspaceRoot = "/tmp/symphony-root-worktree";
const codexHome = "/tmp/symphony-performer-home";
const rootHome = "/tmp/symphony-root-home";
const providerBaseUrl = "https://api.openai.com/v1";
const providerApiKey = "test-api-key";
function localOnlyOptions() {
  return {
    ...testCodexOptions(codexHome),
    capabilityMode: {
      kind: "local_only" as const,
      workspaceRoot,
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
    },
  };
}

async function assertDirectoryExcludes(directory: string, forbidden: string): Promise<void> {
  const forbiddenBytes = Buffer.from(forbidden, "utf8");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertDirectoryExcludes(entryPath, forbidden);
    } else if (entry.isFile()) {
      assert.equal((await readFile(entryPath)).includes(forbiddenBytes), false);
    }
  }
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
          send(message, {
            error: { code: -32_601, message: "unexpected managed requirements request" },
          });
        } else if (message.method === "remoteControl/status/read") {
          send(message, {
            result: {
              status: "disabled",
              serverName: "symphony-test",
              installationId: "installation-local",
              environmentId: null,
            },
          });
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
              runtimeWorkspaceRoots: policy?.role === "root" ? [] : [workspaceRoot],
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
    assert.equal(launch.env.OPENAI_API_KEY, providerApiKey);
    assert.equal("OPENAI_BASE_URL" in launch.env, false);
    assert.equal("HOME" in launch.env, false);
    assert.equal("LINEAR_API_KEY" in launch.env, false);
    assert.equal(launch.args.includes('model_provider="symphony"'), true);
    assert.equal(launch.args.includes('model_providers.symphony.name="Symphony"'), true);
    assert.equal(launch.args.includes(`model_providers.symphony.base_url=${JSON.stringify(providerBaseUrl)}`), true);
    assert.equal(launch.args.includes('model_providers.symphony.env_key="OPENAI_API_KEY"'), true);
    assert.equal(launch.args.includes('model_providers.symphony.wire_api="responses"'), true);
    assert.equal(launch.args.includes("model_providers.symphony.requires_openai_auth=false"), true);
    assert.equal(launch.args.includes("tools.experimental_request_user_input.enabled=false"), true);
    assert.equal(launch.args.includes("tools.update_plan.enabled=false"), true);
    assert.equal(launch.args.includes("orchestrator.skills.enabled=false"), true);
    assert.equal(launch.args.some((argument) => argument.includes(providerApiKey)), false);

    const policy = launch.localOnly;
    assert.equal(policy.expectedConfig.model_provider, "symphony");
    assert.deepEqual(policy.expectedConfig.model_providers, {
      symphony: {
        name: "Symphony",
        base_url: providerBaseUrl,
        env_key: "OPENAI_API_KEY",
        env_key_instructions: null,
        experimental_bearer_token: null,
        auth: null,
        aws: null,
        wire_api: "responses",
        query_params: null,
        http_headers: null,
        env_http_headers: null,
        request_max_retries: null,
        stream_max_retries: null,
        stream_idle_timeout_ms: null,
        websocket_connect_timeout_ms: null,
        requires_openai_auth: false,
        supports_websockets: false,
        supports_standalone_web_search: false,
      },
    });
    assert.equal(Object.hasOwn(policy.expectedConfig, "tools"), false);
    assert.deepEqual(policy.threadConfig.tools, {
      experimental_request_user_input: { enabled: false },
      update_plan: { enabled: false },
    });
    assert.deepEqual(policy.expectedConfig.orchestrator, { skills: { enabled: false } });
    assert.deepEqual(policy.threadConfig.orchestrator, { skills: { enabled: false } });
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
        "remoteControl/status/read",
        "permissionProfile/list",
        "mcpServerStatus/list",
      ],
    );
    assert.deepEqual(
      fake.requests.find(({ method }) => method === "config/read")?.params,
      { cwd: workspaceRoot, includeLayers: false },
    );
    const remoteControlStatusRequest = fake.requests.find(
      ({ method }) => method === "remoteControl/status/read",
    );
    assert.ok(remoteControlStatusRequest);
    assert.equal(Object.hasOwn(remoteControlStatusRequest, "params"), false);
    assert.deepEqual(
      fake.requests.find(({ method }) => method === "permissionProfile/list")?.params,
      { cwd: workspaceRoot, limit: 1_000 },
    );
  } finally {
    await process.shutdown();
  }
});

test("local-only profiles apply only bounded workspace-contained deny paths", () => {
  const deniedPath = path.join(workspaceRoot, "nested", ".env.production");
  const runtime = createCodexLocalOnlyRuntime({
    kind: "local_only",
    workspaceRoot,
    deniedWorkspacePaths: [deniedPath, deniedPath],
  }, codexHome, providerBaseUrl);
  const permissions = runtime.expectedConfig.permissions as Record<
    string,
    { readonly filesystem: Record<string, string> }
  >;
  assert.equal(permissions[runtime.readPermissionProfile]?.filesystem[deniedPath], "deny");
  assert.equal(permissions[runtime.writePermissionProfile]?.filesystem[deniedPath], "deny");

  for (const invalid of [
    [workspaceRoot],
    [path.dirname(workspaceRoot)],
    ["relative/.env"],
    [`${workspaceRoot}${path.sep}nested${path.sep}..${path.sep}.env`],
    Array.from({ length: 257 }, (_, index) => path.join(workspaceRoot, `.env.${index}`)),
    Array.from(
      { length: 200 },
      (_, index) => path.join(workspaceRoot, `${String(index).padStart(3, "0")}-${"x".repeat(180)}.pem`),
    ),
  ]) {
    assert.throws(() => createCodexLocalOnlyRuntime({
      kind: "local_only",
      workspaceRoot,
      deniedWorkspacePaths: invalid,
    }, codexHome, providerBaseUrl), /invalid_codex_local_only_denied_path/u);
  }

  const scratchDirectory = path.join(workspaceRoot, "scratch");
  assert.throws(() => createCodexLocalOnlyRuntime({
    kind: "local_only",
    workspaceRoot,
    scratchDirectory,
    deniedWorkspacePaths: [path.join(scratchDirectory, ".env")],
  }, codexHome, providerBaseUrl), /invalid_codex_local_only_scratch/u);
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
    ":minimal": "read",
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
  assert.equal(Object.hasOwn(policy.expectedConfig, "shell_environment_policy"), true);
  assert.equal(Object.hasOwn(policy.threadConfig, "shell_environment_policy"), false);
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
        environments: [],
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
        environments: [],
        runtimeWorkspaceRoots: [workspaceRoot],
      },
    );
  } finally {
    thread.close();
    await process.shutdown();
  }
});

test("installed Codex app-server exposes only declared Root tools without administrator requirements", {
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
  const probeApiKey = "probe-api-key";
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
        content: [{ type: "output_text", text: "{}" }],
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
  try {
    const codex = await CodexProcess.start({
      ...testCodexOptions(canonicalRootHome),
      apiKey: probeApiKey,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      shutdownTimeoutMs: 2_000,
      capabilityMode: {
        kind: "root_local_only",
        workspaceRoot: canonicalWorkspace,
        dynamicTools: [declaredTool],
      },
    });
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
  } finally {
    await new Promise<void>((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
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
    assert.equal(request.includes(probeApiKey), false);
  }
  assert.equal(await readFile(path.join(canonicalWorkspace, "code.ts"), "utf8"), "export const answer = 42;\n");
  assert.equal(await readFile(path.join(canonicalRootHome, "auth.json"), "utf8"), "root-auth-secret\n");
  await assertDirectoryExcludes(canonicalRootHome, probeApiKey);
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

test("local-only startup fails closed on a mismatched effective boundary", async () => {
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
    (method: string, response: Record<string, unknown>) => method === "remoteControl/status/read"
      ? {
          result: {
            status: "connected",
            serverName: "symphony-test",
            installationId: "installation-local",
            environmentId: "remote-environment",
          },
        }
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

test("installed Codex CLI proves the local-only boundary without administrator requirements", { timeout: 15_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-local-only-probe-"));
  const installedHome = path.join(temporary, "home");
  const installedWorkspace = path.join(temporary, "workspace");
  await Promise.all([mkdir(installedHome), mkdir(installedWorkspace)]);
  const [canonicalHome, canonicalWorkspace] = await Promise.all([
    realpath(installedHome),
    realpath(installedWorkspace),
  ]);
  try {
    const process = await CodexProcess.start({
      ...testCodexOptions(canonicalHome),
      capabilityMode: {
        kind: "local_only",
        workspaceRoot: canonicalWorkspace,
      },
    });
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
