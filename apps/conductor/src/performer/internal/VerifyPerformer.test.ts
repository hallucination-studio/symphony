import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { after, before } from "node:test";

import {
  CodexProcess,
  type CodexProcessLaunch,
  type CodexSpawner,
  type SpawnedCodexProcess,
} from "../../codex-app-server/internal/CodexProcess.js";
import { JsonlFrameDecoder } from "../../codex-app-server/internal/JsonlPeer.js";
import { scanSensitiveWorkspacePaths } from "../../codex-app-server/internal/SensitiveWorkspacePaths.js";
import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
  parseTaskRevision,
} from "../../contracts/identity.js";
import {
  parseVerifyRequest,
  type VerifyRequest,
  type VerifyTarget,
} from "../api/StagePerformerInterface.js";
import { VerifyPerformer } from "./VerifyPerformer.js";

async function runNativeCommand(
  codex: CodexProcess,
  permissionProfile: string,
  command: readonly string[],
  cwd: string,
  correlationId: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const result = await codex.request(
    "command/exec",
    {
      command,
      cwd,
      permissionProfile,
      timeoutMs: 20_000,
    },
    parseCorrelationId(correlationId),
    25_000,
  );
  const response = result as {
    readonly exitCode?: unknown;
    readonly stdout?: unknown;
    readonly stderr?: unknown;
  };
  if (
    typeof response.exitCode !== "number"
    || !Number.isSafeInteger(response.exitCode)
    || typeof response.stdout !== "string"
    || typeof response.stderr !== "string"
  ) throw new Error("invalid_codex_command_exec_response");
  return {
    exitCode: response.exitCode,
    stdout: response.stdout,
    stderr: response.stderr,
  };
}

interface FakeAppServer extends SpawnedCodexProcess {
  readonly output: PassThrough;
  send(message: Record<string, unknown>): void;
}

let temporary = "";
let revisionWorktree = "";
let performerHome = "";

before(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-verify-performer-"));
  revisionWorktree = path.join(temporary, "revision");
  performerHome = path.join(temporary, "performer-home");
  await Promise.all([mkdir(revisionWorktree), mkdir(performerHome)]);
});

after(async () => {
  await rm(temporary, { recursive: true, force: true });
});

function fakeAppServer(
  handle: (message: Record<string, unknown>, server: FakeAppServer) => void,
  autoExitOnKill = true,
) {
  const requests: Record<string, unknown>[] = [];
  const launches: CodexProcessLaunch[] = [];
  const killSignals: NodeJS.Signals[] = [];
  const spawner: CodexSpawner = (_options, launch) => {
    launches.push(launch);
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    const decoder = new JsonlFrameDecoder();
    let running = true;
    events.once("exit", () => { running = false; });
    const server: FakeAppServer = {
      stdin: input,
      stdout: output,
      stderr,
      events,
      output,
      isRunning: () => running,
      kill: (signal) => {
        killSignals.push(signal);
        if (autoExitOnKill) queueMicrotask(() => events.emit("exit", 0, null));
        return true;
      },
      send: (message) => {
        const result = message.result as Record<string, unknown> | undefined;
        const policy = launch.localOnly;
        const enriched = policy !== undefined && result?.thread !== undefined
          ? {
              ...message,
              result: {
                ...result,
                cwd: policy.workspaceRoot,
                approvalPolicy: "never",
                approvalsReviewer: "user",
                activePermissionProfile: { id: policy.readPermissionProfile, extends: null },
                instructionSources: [],
                runtimeWorkspaceRoots: [policy.workspaceRoot],
              },
            }
          : message;
        output.write(`${JSON.stringify(enriched)}\n`);
      },
    };
    input.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        requests.push(message);
        const policy = launch.localOnly;
        if (message.method === "initialize") {
          server.send({
            id: message.id,
            result: {
              codexHome: launch.env.CODEX_HOME,
              platformFamily: "unix",
              platformOs: "macos",
              userAgent: "symphony/0.146.0 (Mac OS; arm64)",
            },
          });
        } else if (message.method === "config/read") {
          server.send({ id: message.id, result: { config: policy?.expectedConfig, origins: {} } });
        } else if (message.method === "remoteControl/status/read") {
          server.send({
            id: message.id,
            result: {
              status: "disabled",
              serverName: "symphony-verify-test",
              installationId: "installation-local",
              environmentId: null,
            },
          });
        } else if (message.method === "configRequirements/read") {
          server.send({
            id: message.id,
            error: { code: -32_601, message: "unexpected managed requirements request" },
          });
        } else if (message.method === "permissionProfile/list") {
          server.send({
            id: message.id,
            result: {
              data: [
                { id: policy?.readPermissionProfile, allowed: true },
                { id: policy?.writePermissionProfile, allowed: true },
              ],
              nextCursor: null,
            },
          });
        } else if (message.method === "mcpServerStatus/list") {
          server.send({ id: message.id, result: { data: [], nextCursor: null } });
        } else if (message.method !== "initialized") {
          handle(message, server);
        }
      }
    });
    return server;
  };
  return { spawner, requests, launches, killSignals };
}

const target: VerifyTarget = Object.freeze({
  root_id: parseRootIssueId("LIN-ROOT"),
  runtime_generation: parseRuntimeGeneration(7),
  cycle_id: parseCycleIssueId("LIN-CYCLE"),
  cycle_revision: parseTaskRevision("revision:cycle:approved"),
  verify_issue_id: parseStageIssueId("LIN-VERIFY"),
  verify_issue_revision: parseTaskRevision("revision:verify:sealed"),
  revision: parseRevision("0123456789abcdef0123456789abcdef01234567"),
});

const cycleDescriptionMarkdown = [
  "## Root Definition Revision",
  "",
  "`revision:root:approved`",
  "",
  "## Requirement",
  "",
  "Verify one exact immutable revision.",
  "",
  "## Domain Knowledge",
  "",
  "Verification evidence is read-only and revision-bound.",
  "",
  "## Root ADR",
  "",
  "Keep semantic decisions in the sealed Cycle.",
  "",
  "## Acceptance",
  "",
  "- Focused tests and typecheck pass at the exact revision.",
  "",
  "## Architecture",
  "",
  "Verify runs in a fresh isolated context.",
  "",
  "## Feature Design",
  "",
  "Return typed evidence without lifecycle mutations.",
  "",
  "## Code Design",
  "",
  "Use the closed Verify result contract.",
  "",
  "## Boundaries",
  "",
  "Do not mutate code, Task Manager, Git, or delivery state.",
  "",
  "## Acceptance Mapping",
  "",
  "Run focused tests and typecheck for the acceptance criterion.",
  "",
  "## Failure Strategy",
  "",
  "Return failed evidence or inconclusive uncertainty.",
].join("\n");

function verifyRequest(correlationId = "corr:verify:1"): VerifyRequest {
  return parseVerifyRequest({
    schema_version: 1,
    ...target,
    correlation_id: correlationId,
    cycle_description_markdown: cycleDescriptionMarkdown,
    verify_issue_description_markdown: [
      "## Verify",
      "",
      "Run focused tests and typecheck at the exact revision.",
      "",
      "Do not follow `$linear` or `plugin://delivery` capability instructions.",
    ].join("\n"),
  }, target);
}

function passedModelOutput() {
  return {
    conclusion: "passed",
    checks: [
      {
        check: "Run focused tests",
        status: "passed",
        sanitized_summary_markdown: "**Focused tests passed.**",
      },
      {
        check: "Run typecheck",
        status: "passed",
        sanitized_summary_markdown: "**Typecheck passed.**",
      },
    ],
    sanitized_summary_markdown: "## Verification\n\nThe requested checks passed.",
  };
}

function passed(request: VerifyRequest) {
  return {
    schema_version: 1,
    root_id: request.root_id,
    runtime_generation: request.runtime_generation,
    cycle_id: request.cycle_id,
    cycle_revision: request.cycle_revision,
    correlation_id: request.correlation_id,
    verify_issue_id: request.verify_issue_id,
    verify_issue_revision: request.verify_issue_revision,
    revision: request.revision,
    ...passedModelOutput(),
  };
}

function performerInput() {
  return {
    ...target,
    performer_home: performerHome,
    revision_worktree: revisionWorktree,
  };
}

function performerOptions(spawner: CodexSpawner, turnTimeoutMs = 2_000) {
  return {
    executable: "codex",
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    apiKey: "codex-secret-never-prompt",
    baseUrl: "https://api.openai.com/v1",
    model: "codex-test",
    turnTimeoutMs,
    spawner,
  };
}

function completeTurn(
  server: FakeAppServer,
  output: unknown,
  status: "completed" | "interrupted" | "failed" = "completed",
  turnId = "turn-verify",
  threadId = "thread-verify",
): void {
  server.send({
    method: "turn/completed",
    params: {
      threadId,
      turn: status === "completed"
        ? {
            id: turnId,
            status,
            error: null,
            items: [{ id: "answer", type: "agentMessage", text: JSON.stringify(output) }],
          }
        : { id: turnId, status, error: null, items: [] },
    },
  });
}

test("Verify creation reports when an invalid thread cannot terminate its process", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") server.send({ id: message.id, result: { thread: {} } });
  }, false);
  let scratchDirectory = "";
  let scratchExistedAtLaunch = false;
  const spawner: CodexSpawner = (options, launch) => {
    scratchDirectory = launch.localOnly?.scratchDirectory ?? "";
    scratchExistedAtLaunch = scratchDirectory.length > 0 && existsSync(scratchDirectory);
    return appServer.spawner(options, launch);
  };

  await assert.rejects(VerifyPerformer.create(performerInput(), {
    ...performerOptions(spawner),
    shutdownTimeoutMs: 2,
  }), /verify_performer_termination_failed/u);
  assert.equal(scratchExistedAtLaunch, true);
  await assert.rejects(lstat(scratchDirectory), { code: "ENOENT" });
  assert.deepEqual(appServer.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("Verify creation fails before process allocation when sensitive paths exceed the deny bound", async (context) => {
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-verify-sensitive-limit-"));
  context.after(async () => rm(probeRoot, { recursive: true, force: true }));
  const probeWorktree = path.join(probeRoot, "revision");
  const probeHome = path.join(probeRoot, "performer-home");
  await Promise.all([mkdir(probeWorktree), mkdir(probeHome)]);
  await Promise.all(Array.from(
    { length: 257 },
    (_, index) => writeFile(path.join(probeWorktree, `.env.${index}`), "secret\n", "utf8"),
  ));
  const appServer = fakeAppServer(() => undefined);

  await assert.rejects(VerifyPerformer.create({
    ...performerInput(),
    performer_home: probeHome,
    revision_worktree: probeWorktree,
  }, performerOptions(appServer.spawner)), /verify_performer_creation_failed/u);
  assert.equal(appServer.launches.length, 0);
});

test("Verify close reports final scratch cleanup failure", {
  skip: process.platform === "win32",
}, async () => {
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-verify-cleanup" } } });
    }
  });
  const performer = await VerifyPerformer.create(performerInput(), performerOptions(appServer.spawner));
  const scratchDirectory = appServer.launches[0]?.localOnly?.scratchDirectory;
  assert.ok(scratchDirectory);
  await mkdir(path.join(scratchDirectory, "blocked"), { recursive: true });
  await chmod(scratchDirectory, 0o500);
  try {
    await assert.rejects(performer.close(), /verify_performer_close_failed/u);
    await lstat(scratchDirectory);
  } finally {
    await chmod(scratchDirectory, 0o700);
    await rm(scratchDirectory, { recursive: true, force: true });
  }
});

test("Verify binds one exact revision to a read-only local turn and typed evidence", async () => {
  const request = verifyRequest();
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-verify" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-verify" } } });
      completeTurn(server, passedModelOutput());
    }
  });
  const performer = await VerifyPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
    assert.deepEqual(
      appServer.requests.map(({ method }) => method).slice(0, 6),
      [
        "initialize",
        "initialized",
        "config/read",
        "remoteControl/status/read",
        "permissionProfile/list",
        "mcpServerStatus/list",
      ],
    );
    assert.deepEqual(await performer.verify(request), passed(request));
    const policy = appServer.launches[0]?.localOnly;
    assert.ok(policy);
    const profiles = policy.expectedConfig.permissions as Record<
      string,
      { readonly filesystem: Record<string, string> }
    >;
    assert.equal(profiles[policy.readPermissionProfile]?.filesystem[policy.workspaceRoot], "read");
    assert.equal(profiles[policy.readPermissionProfile]?.filesystem[policy.scratchDirectory as string], "write");

    const thread = appServer.requests.find(({ method }) => method === "thread/start")?.params as Record<string, unknown>;
    const turn = appServer.requests.find(({ method }) => method === "turn/start")?.params as {
      readonly permissions: unknown;
      readonly sandboxPolicy?: unknown;
      readonly input: readonly [{ readonly text: string }];
      readonly outputSchema: Record<string, unknown>;
    };
    assert.equal(thread.permissions, policy.readPermissionProfile);
    assert.deepEqual(thread.dynamicTools, []);
    assert.deepEqual(thread.selectedCapabilityRoots, []);
    assert.equal(turn.permissions, policy.readPermissionProfile);
    assert.equal(turn.sandboxPolicy, undefined);
    assert.equal(
      appServer.requests.some(({ params }) =>
        JSON.stringify(params)?.includes(policy.writePermissionProfile) === true),
      false,
    );
    const promptText = turn.input[0].text;
    const prompt = JSON.parse(promptText) as Record<string, unknown>;
    assert.equal(prompt.role, "Verify");
    assert.deepEqual(prompt.context, {
      cycle_description_markdown: request.cycle_description_markdown,
      verify_issue_description_markdown: request.verify_issue_description_markdown,
      revision: request.revision,
    });
    assert.equal("request" in prompt, false);
    for (const forbidden of [
      "$linear",
      "plugin://",
      performerHome,
      revisionWorktree,
      "codex-secret-never-prompt",
      "repair the code",
      request.root_id,
      request.cycle_id,
      request.cycle_revision,
      request.correlation_id,
      request.verify_issue_id,
      request.verify_issue_revision,
    ]) assert.equal(promptText.toLowerCase().includes(String(forbidden).toLowerCase()), false);
    assert.equal(promptText.includes(request.revision), true);
    const schema = JSON.stringify(turn.outputSchema);
    for (const forbidden of [
      "schema_version", "root_id", "runtime_generation", "cycle_id", "cycle_revision",
      "correlation_id", "verify_issue_id", "verify_issue_revision", "revision", "provider_receipt",
      "commit", "push",
    ]) {
      assert.equal(schema.includes(`"${forbidden}":`), false);
    }
    assert.deepEqual(
      Object.keys(turn.outputSchema.properties as Record<string, unknown>).sort(),
      ["checks", "conclusion", "sanitized_summary_markdown"],
    );
    assert.deepEqual(appServer.killSignals, ["SIGTERM"]);
    await assert.rejects(lstat(policy.scratchDirectory as string), { code: "ENOENT" });
    await assert.rejects(performer.verify(request), /verify_performer_retired/u);
  } finally {
    await performer.close();
  }
});

test("installed Codex app-server enforces the exact Verify read-only revision profile", {
  skip: process.platform === "win32",
  timeout: 30_000,
}, async (context) => {
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-verify-profile-probe-"));
  context.after(async () => rm(probeRoot, { recursive: true, force: true }));
  const probeWorktree = path.join(probeRoot, "revision");
  const probeHome = path.join(probeRoot, "performer-home");
  const outside = path.join(probeRoot, "outside");
  await Promise.all([
    mkdir(path.join(probeWorktree, ".git"), { recursive: true }),
    mkdir(path.join(probeWorktree, "nested", "auth"), { recursive: true }),
    mkdir(path.join(probeWorktree, "nested", "certs"), { recursive: true }),
    mkdir(probeHome),
    mkdir(outside),
  ]);
  await Promise.all([
    writeFile(path.join(probeWorktree, "source.txt"), "exact revision\n", "utf8"),
    writeFile(path.join(probeWorktree, ".git", "config"), "remote credential config\n", "utf8"),
    writeFile(path.join(probeWorktree, "nested", ".env.production"), "provider secret\n", "utf8"),
    writeFile(path.join(probeWorktree, "nested", "certs", "deploy.pem"), "private key\n", "utf8"),
    writeFile(
      path.join(probeWorktree, "nested", "auth", "credentials.json"),
      "credential store\n",
      "utf8",
    ),
    symlink(
      path.join("nested", ".env.production"),
      path.join(probeWorktree, "environment-alias"),
    ),
    writeFile(path.join(probeHome, "auth.json"), "performer credential\n", "utf8"),
    writeFile(path.join(outside, "private.txt"), "outside\n", "utf8"),
  ]);
  const [canonicalWorktree, canonicalHome, canonicalOutside] = await Promise.all([
    realpath(probeWorktree),
    realpath(probeHome),
    realpath(outside),
  ]);
  const scratchDirectory = await realpath(await mkdtemp(path.join(probeRoot, "scratch-")));
  const deniedWorkspacePaths = await scanSensitiveWorkspacePaths(canonicalWorktree);
  const codex = await CodexProcess.start({
    executable: "codex",
    codexHome: canonicalHome,
    rootId: target.root_id,
    runtimeGeneration: target.runtime_generation,
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    shutdownTimeoutMs: 2_000,
    apiKey: "test",
    baseUrl: "https://api.openai.com/v1",
    model: "codex-test",
    capabilityMode: {
      kind: "local_only",
      workspaceRoot: canonicalWorktree,
      scratchDirectory,
      deniedWorkspacePaths,
    },
  });
  const runtime = codex.localOnly;
  assert.ok(runtime);
  try {
    const probeScript = String.raw`
      const fs = require("node:fs/promises");
      const path = require("node:path");
      const [workspace, scratch, home, outside] = process.argv.slice(1);
      const results = {};
      async function attempt(name, operation) {
        try { results[name] = { ok: true, value: await operation() }; }
        catch (error) { results[name] = { ok: false, code: error && error.code || null }; }
      }
      (async () => {
        await attempt("workspace_read", () => fs.readFile(path.join(workspace, "source.txt"), "utf8"));
        await attempt("workspace_create", () => fs.writeFile(path.join(workspace, "created.txt"), "created\n"));
        await attempt("workspace_update", () => fs.appendFile(path.join(workspace, "source.txt"), "changed\n"));
        await attempt("scratch_create", () => fs.writeFile(path.join(scratch, "evidence.md"), "evidence\n"));
        await attempt("git_read", () => fs.readFile(path.join(workspace, ".git", "config"), "utf8"));
        await attempt("git_write", () => fs.writeFile(path.join(workspace, ".git", "config"), "changed\n"));
        await attempt("env_read", () => fs.readFile(path.join(workspace, "nested", ".env.production"), "utf8"));
        await attempt("private_key_read", () => fs.readFile(path.join(workspace, "nested", "certs", "deploy.pem"), "utf8"));
        await attempt("credentials_read", () => fs.readFile(path.join(workspace, "nested", "auth", "credentials.json"), "utf8"));
        await attempt("sensitive_alias_read", () => fs.readFile(path.join(workspace, "environment-alias"), "utf8"));
        await attempt("home_read", () => fs.readFile(path.join(home, "auth.json"), "utf8"));
        await attempt("outside_read", () => fs.readFile(path.join(outside, "private.txt"), "utf8"));
        await attempt("outside_write", () => fs.writeFile(path.join(outside, "created.txt"), "outside\n"));
        process.stdout.write(JSON.stringify(results));
      })().catch(() => process.exit(2));
    `;
    const executed = await runNativeCommand(
      codex,
      runtime.readPermissionProfile,
      [
        process.execPath,
        "--openssl-config=/dev/null",
        "-e",
        probeScript,
        canonicalWorktree,
        scratchDirectory,
        canonicalHome,
        canonicalOutside,
      ],
      canonicalWorktree,
      "probe:verify-permissions",
    );
    assert.equal(executed.exitCode, 0);
    assert.equal(executed.stderr, "");
    const evidence = JSON.parse(executed.stdout) as Record<
      string,
      { readonly ok: boolean; readonly value?: unknown }
    >;
    assert.equal(evidence.workspace_read?.ok, true);
    assert.equal(evidence.workspace_read?.value, "exact revision\n");
    assert.equal(evidence.workspace_create?.ok, false);
    assert.equal(evidence.workspace_update?.ok, false);
    assert.equal(evidence.scratch_create?.ok, true);
    assert.equal(evidence.git_read?.ok, false);
    assert.equal(evidence.git_write?.ok, false);
    assert.equal(evidence.env_read?.ok, false);
    assert.equal(evidence.private_key_read?.ok, false);
    assert.equal(evidence.credentials_read?.ok, false);
    assert.equal(evidence.sensitive_alias_read?.ok, false);
    assert.equal(evidence.home_read?.ok, false);
    assert.equal(evidence.outside_read?.ok, false);
    assert.equal(evidence.outside_write?.ok, false);
    assert.equal(await readFile(path.join(canonicalWorktree, "source.txt"), "utf8"), "exact revision\n");
    assert.equal(
      await readFile(path.join(canonicalWorktree, ".git", "config"), "utf8"),
      "remote credential config\n",
    );
    assert.equal(await readFile(path.join(scratchDirectory, "evidence.md"), "utf8"), "evidence\n");
    await assert.rejects(readFile(path.join(canonicalWorktree, "created.txt"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(canonicalOutside, "created.txt"), "utf8"), { code: "ENOENT" });
  } finally {
    await codex.shutdown();
    await rm(scratchDirectory, { recursive: true, force: true });
  }
});

test("Verify rejects every target rebind before a turn and cleans its one-shot context", async () => {
  for (const override of [
    { cycle_id: parseCycleIssueId("LIN-OTHER-CYCLE") },
    { cycle_revision: parseTaskRevision("revision:cycle:other") },
    { verify_issue_id: parseStageIssueId("LIN-OTHER-VERIFY") },
    { verify_issue_revision: parseTaskRevision("revision:verify:other") },
    { revision: parseRevision("f".repeat(40)) },
  ]) {
    const appServer = fakeAppServer((message, server) => {
      if (message.method === "thread/start") {
        server.send({ id: message.id, result: { thread: { id: "thread-verify-rebind" } } });
      }
    });
    const performer = await VerifyPerformer.create(performerInput(), performerOptions(appServer.spawner));
    const scratchDirectory = appServer.launches[0]?.localOnly?.scratchDirectory;
    assert.ok(scratchDirectory);
    await assert.rejects(
      performer.verify({ ...verifyRequest(), ...override }),
      /verify_performer_invalid_request/u,
    );
    assert.equal(appServer.requests.some(({ method }) => method === "turn/start"), false);
    assert.deepEqual(appServer.killSignals, ["SIGTERM"]);
    await assert.rejects(lstat(scratchDirectory), { code: "ENOENT" });
    await assert.rejects(performer.verify(verifyRequest()), /verify_performer_retired/u);
    await performer.close();
  }
});

test("separate Verify instances always create fresh non-forked processes and threads", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-verify" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-verify" } } });
      completeTurn(server, passedModelOutput());
    }
  });
  const first = await VerifyPerformer.create(performerInput(), performerOptions(appServer.spawner));
  const second = await VerifyPerformer.create(performerInput(), performerOptions(appServer.spawner));
  const scratchDirectories = appServer.launches.map(({ localOnly }) => localOnly?.scratchDirectory);
  assert.equal(new Set(scratchDirectories).size, 2);
  try {
    await Promise.all([
      first.verify(verifyRequest("corr:verify:fresh:1")),
      second.verify(verifyRequest("corr:verify:fresh:2")),
    ]);
    assert.equal(appServer.launches.length, 2);
    const threadStarts = appServer.requests.filter(({ method }) => method === "thread/start");
    assert.equal(threadStarts.length, 2);
    for (const { params } of threadStarts) {
      const thread = params as Record<string, unknown>;
      assert.equal(thread.ephemeral, true);
      for (const forbidden of ["fork", "parentThreadId", "sourceThreadId", "threadId"]) {
        assert.equal(forbidden in thread, false);
      }
    }
    assert.deepEqual(appServer.killSignals, ["SIGTERM", "SIGTERM"]);
    for (const scratchDirectory of scratchDirectories) {
      assert.ok(scratchDirectory);
      await assert.rejects(lstat(scratchDirectory), { code: "ENOENT" });
    }
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("identity-bearing Verify output and unavailable tool calls become inconclusive", async () => {
  for (const violation of ["identity", "tool"] as const) {
    const request = verifyRequest();
    let denial: unknown;
    const appServer = fakeAppServer((message, server) => {
      if (message.method === "thread/start") {
        server.send({ id: message.id, result: { thread: { id: "thread-verify" } } });
      } else if (message.method === "turn/start") {
        server.send({ id: message.id, result: { turn: { id: "turn-verify" } } });
        if (violation === "identity") {
          completeTurn(server, { ...passedModelOutput(), revision: "f".repeat(40) });
        } else {
          server.send({
            method: "turn/started",
            params: {
              threadId: "thread-verify",
              turn: { id: "turn-verify", status: "inProgress", items: [], error: null },
            },
          });
          server.send({
            id: "tool-request",
            method: "item/tool/call",
            params: {
              threadId: "thread-verify",
              turnId: "turn-verify",
              callId: "call:repair",
              tool: "apply_patch",
              arguments: {},
            },
          });
        }
      } else if (message.id === "tool-request") {
        denial = message.result;
        completeTurn(server, passedModelOutput());
      }
    });
    const performer = await VerifyPerformer.create(performerInput(), performerOptions(appServer.spawner));
    const scratchDirectory = appServer.launches[0]?.localOnly?.scratchDirectory;
    assert.ok(scratchDirectory);
    try {
      const result = await performer.verify(request);
      assert.equal(result.conclusion, "inconclusive");
      assert.deepEqual(result.checks, []);
      await assert.rejects(lstat(scratchDirectory), { code: "ENOENT" });
      await assert.rejects(performer.verify(request), /verify_performer_retired/u);
      if (violation === "tool") {
        assert.deepEqual(denial, {
          success: false,
          contentItems: [{ type: "inputText", text: "capability_denied" }],
        });
      }
    } finally {
      await performer.close();
    }
  }
});

test("a forbidden Verify tool call before turn activation retires the role", async () => {
  const request = verifyRequest();
  let denial: unknown;
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-verify-activation" } } });
    } else if (message.method === "turn/start") {
      server.output.write([
        { id: message.id, result: { turn: { id: "turn-verify-activation" } } },
        {
          id: "activation-tool-request",
          method: "item/tool/call",
          params: {
            threadId: "thread-verify-activation",
            turnId: "turn-verify-activation",
            callId: "call:activation",
            tool: "apply_patch",
            arguments: {},
          },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    } else if (message.id === "activation-tool-request") {
      denial = message.result;
      completeTurn(
        server,
        passedModelOutput(),
        "completed",
        "turn-verify-activation",
        "thread-verify-activation",
      );
    }
  });
  const performer = await VerifyPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
    const result = await performer.verify(request);
    assert.equal(result.conclusion, "inconclusive");
    assert.deepEqual(result.checks, []);
    assert.deepEqual(denial, {
      success: false,
      contentItems: [{ type: "inputText", text: "capability_denied" }],
    });
    await assert.rejects(performer.verify(request), /verify_performer_retired/u);
  } finally {
    await performer.close();
  }
});

test("a retired Verify result waits for native process exit", async () => {
  const request = verifyRequest();
  let server: FakeAppServer | undefined;
  const appServer = fakeAppServer((message, activeServer) => {
    server = activeServer;
    if (message.method === "thread/start") {
      activeServer.send({ id: message.id, result: { thread: { id: "thread-verify" } } });
    } else if (message.method === "turn/start") {
      activeServer.send({ id: message.id, result: { turn: { id: "turn-verify-retire" } } });
      completeTurn(activeServer, { invalid: true }, "completed", "turn-verify-retire");
    }
  }, false);
  const performer = await VerifyPerformer.create(performerInput(), performerOptions(appServer.spawner));

  let settled = false;
  const running = performer.verify(request).finally(() => { settled = true; });
  while (appServer.killSignals.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);

  (server as FakeAppServer).events.emit("exit", 0, null);
  const result = await running;
  assert.equal(result.conclusion, "inconclusive");
  await performer.close();
});

test("closing active Verify waits for native exit before result or scratch cleanup", async () => {
  const request = verifyRequest();
  let server: FakeAppServer | undefined;
  let markTurnStarted: () => void = () => undefined;
  const turnStarted = new Promise<void>((resolve) => { markTurnStarted = resolve; });
  const appServer = fakeAppServer((message, activeServer) => {
    server = activeServer;
    if (message.method === "thread/start") {
      activeServer.send({ id: message.id, result: { thread: { id: "thread-verify-close" } } });
    } else if (message.method === "turn/start") {
      activeServer.send({ id: message.id, result: { turn: { id: "turn-verify-close" } } });
      activeServer.send({
        method: "turn/started",
        params: {
          threadId: "thread-verify-close",
          turn: { id: "turn-verify-close", status: "inProgress", items: [], error: null },
        },
      });
      markTurnStarted();
    } else if (message.method === "turn/interrupt") {
      activeServer.send({ id: message.id, result: {} });
    }
  }, false);
  const performer = await VerifyPerformer.create(performerInput(), {
    ...performerOptions(appServer.spawner),
    shutdownTimeoutMs: 1_000,
  });
  const scratchDirectory = appServer.launches[0]?.localOnly?.scratchDirectory;
  assert.ok(scratchDirectory);

  let runningSettled = false;
  let closingSettled = false;
  const running = performer.verify(request).finally(() => { runningSettled = true; });
  await turnStarted;
  const closing = performer.close().finally(() => { closingSettled = true; });
  try {
    while (appServer.killSignals.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const scratchExists = await lstat(scratchDirectory).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    assert.deepEqual(
      { runningSettled, closingSettled, scratchExists },
      { runningSettled: false, closingSettled: false, scratchExists: true },
    );
  } finally {
    (server as FakeAppServer).events.emit("exit", 0, null);
    await Promise.allSettled([running, closing]);
  }
});

test("Verify interruption, failure, close, and timeout return no fabricated checks", async () => {
  for (const scenario of ["interrupted", "failed", "closed", "timed_out"] as const) {
    const request = verifyRequest();
    let markTurnStarted: () => void = () => undefined;
    const turnStarted = new Promise<void>((resolve) => { markTurnStarted = resolve; });
    const appServer = fakeAppServer((message, server) => {
      if (message.method === "thread/start") {
        server.send({ id: message.id, result: { thread: { id: "thread-verify" } } });
      } else if (message.method === "turn/start") {
        server.send({ id: message.id, result: { turn: { id: "turn-verify" } } });
        if (scenario === "interrupted" || scenario === "failed") {
          completeTurn(server, undefined, scenario);
        } else {
          server.send({
            method: "turn/started",
            params: {
              threadId: "thread-verify",
              turn: { id: "turn-verify", status: "inProgress", items: [], error: null },
            },
          });
          if (scenario === "closed") markTurnStarted();
        }
      } else if (message.method === "turn/interrupt") {
        server.send({ id: message.id, result: {} });
      }
    });
    const performer = await VerifyPerformer.create(
      performerInput(),
      performerOptions(appServer.spawner, scenario === "timed_out" ? 10 : 2_000),
    );
    const scratchDirectory = appServer.launches[0]?.localOnly?.scratchDirectory;
    assert.ok(scratchDirectory);
    const active = performer.verify(request);
    if (scenario === "closed") {
      await turnStarted;
      void performer.close();
    }
    const result = await active;
    assert.equal(result.conclusion, "inconclusive");
    assert.deepEqual(result.checks, []);
    await assert.rejects(lstat(scratchDirectory), { code: "ENOENT" });
    if (scenario === "closed" || scenario === "timed_out") {
      assert.equal(
        appServer.requests.some(({ method }) => method === "turn/interrupt"),
        true,
        `expected ${scenario} Verify to interrupt the active turn`,
      );
    }
    if (scenario === "closed") {
      assert.deepEqual(appServer.killSignals, ["SIGTERM"]);
    }
    if (scenario === "timed_out") {
      await assert.rejects(performer.verify(request), /verify_performer_retired/u);
    }
    await performer.close();
  }
});

test("Verify serializes calls and never starts a second turn while one is active", async () => {
  let activeServer: FakeAppServer | undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const request = verifyRequest();
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-verify" } } });
    } else if (message.method === "turn/start") {
      activeServer = server;
      server.send({ id: message.id, result: { turn: { id: "turn-verify" } } });
      server.send({
        method: "turn/started",
        params: {
          threadId: "thread-verify",
          turn: { id: "turn-verify", status: "inProgress", items: [], error: null },
        },
      });
      markStarted();
    }
  });
  const performer = await VerifyPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
    const active = performer.verify(request);
    await started;
    await assert.rejects(performer.verify(verifyRequest("corr:verify:2")), /verify_performer_busy/u);
    assert.equal(appServer.requests.filter(({ method }) => method === "turn/start").length, 1);
    completeTurn(activeServer as FakeAppServer, passedModelOutput());
    await active;
    await assert.rejects(performer.verify(request), /verify_performer_retired/u);
  } finally {
    await performer.close();
  }
});
