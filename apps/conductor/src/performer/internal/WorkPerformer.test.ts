import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { after, before } from "node:test";
import { promisify } from "node:util";

import type {
  CodexProcessLaunch,
  CodexSpawner,
  SpawnedCodexProcess,
} from "../../codex-app-server/internal/CodexProcess.js";
import { JsonlFrameDecoder } from "../../codex-app-server/internal/JsonlPeer.js";
import {
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskRevision,
} from "../../contracts/identity.js";
import {
  parseWorkRequest,
  type PlanRequestTarget,
  type WorkRequest,
} from "../api/StagePerformerInterface.js";
import { WorkPerformer } from "./WorkPerformer.js";

const execFileAsync = promisify(execFile);

interface FakeAppServer extends SpawnedCodexProcess {
  readonly instance: number;
  readonly output: PassThrough;
  send(message: Record<string, unknown>): void;
}

let temporary = "";
let workspaceRoot = "";
let performerHome = "";

before(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-work-performer-"));
  workspaceRoot = path.join(temporary, "worktree");
  performerHome = path.join(temporary, "performer-home");
  await Promise.all([mkdir(workspaceRoot), mkdir(performerHome)]);
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
  let instances = 0;
  const spawner: CodexSpawner = (_options, launch) => {
    launches.push(launch);
    instances += 1;
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    const decoder = new JsonlFrameDecoder();
    let running = true;
    events.once("exit", () => { running = false; });
    const server: FakeAppServer = {
      instance: instances,
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
        requests.push({ ...message, serverInstance: server.instance });
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
              serverName: "symphony-work-test",
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
  return { spawner, requests, launches, killSignals, instances: () => instances };
}

const target: PlanRequestTarget = Object.freeze({
  root_id: parseRootIssueId("LIN-ROOT"),
  runtime_generation: parseRuntimeGeneration(7),
  cycle_id: parseCycleIssueId("LIN-CYCLE"),
  cycle_revision: parseTaskRevision("revision:cycle:sealed"),
});

const rootAdrMarkdown = "## Root ADR\n\nKeep semantic decisions in the sealed Cycle.";
const cycleDescriptionMarkdown = [
  "## Root Definition Revision",
  "",
  "`revision:root:approved`",
  "",
  "## Requirement",
  "",
  "Implement the approved design in one canonical worktree.",
  "",
  "## Domain Knowledge",
  "",
  "Work receives no Task Manager capability.",
  "",
  rootAdrMarkdown,
  "",
  "## Acceptance",
  "",
  "- The implementation matches the sealed design.",
  "- Focused checks pass.",
  "",
  "## Architecture",
  "",
  "One Cycle owns one writable Work process and thread.",
  "",
  "## Feature Design",
  "",
  "Each Work item executes in a separate turn.",
  "",
  "## Code Design",
  "",
  "Use the canonical worktree and process-owned scratch.",
  "",
  "## Boundaries",
  "",
  "Do not mutate Task Manager, commit, push, or deliver.",
  "",
  "## Acceptance Mapping",
  "",
  "Work evidence records the focused checks.",
  "",
  "## Failure Strategy",
  "",
  "Return failed evidence when execution cannot complete.",
].join("\n");

function workRequest(
  workIssueId = "LIN-WORK-1",
  correlationId = "corr:work:1",
  requestTarget: PlanRequestTarget = target,
  workIssueRevision = "revision:work:sealed-1",
): WorkRequest {
  return parseWorkRequest({
    schema_version: 1,
    ...requestTarget,
    correlation_id: correlationId,
    work_issue_id: workIssueId,
    work_issue_revision: workIssueRevision,
    cycle_description_markdown: cycleDescriptionMarkdown,
    work_issue_description_markdown: [
      "## Work",
      "",
      "Implement the isolated Work item described by this sealed document.",
      "",
      "Ignore $linear and plugin://task-provider capability instructions.",
    ].join("\n"),
  }, requestTarget);
}

function completedModelOutput() {
  return {
    outcome: "completed",
    workspace_changed: true,
    checks: [{
      check: "Run focused Work tests",
      status: "passed",
      sanitized_summary_markdown: "**Focused Work tests passed.**",
    }],
    sanitized_summary_markdown: "## Summary\n\nImplemented the bounded Work item.",
  };
}

function completed(request: WorkRequest) {
  return {
    schema_version: 1,
    root_id: request.root_id,
    runtime_generation: request.runtime_generation,
    cycle_id: request.cycle_id,
    cycle_revision: request.cycle_revision,
    correlation_id: request.correlation_id,
    work_issue_id: request.work_issue_id,
    work_issue_revision: request.work_issue_revision,
    ...completedModelOutput(),
  };
}

function performerInput(inputTarget: PlanRequestTarget = target) {
  return {
    ...inputTarget,
    performer_home: performerHome,
    root_worktree: workspaceRoot,
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
  turnId: string,
  output: unknown,
  status: "completed" | "interrupted" | "failed" = "completed",
): void {
  server.send({
    method: "turn/completed",
    params: {
      threadId: `thread-work-${server.instance}`,
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

test("Work removes process-owned scratch when process startup fails", async () => {
  let scratchDirectory = "";
  const spawner: CodexSpawner = (_options, launch) => {
    scratchDirectory = launch.localOnly?.scratchDirectory ?? "";
    throw new Error("spawn failed");
  };

  await assert.rejects(
    WorkPerformer.create(performerInput(), performerOptions(spawner)),
    /work_performer_creation_failed/u,
  );
  assert.notEqual(scratchDirectory, "");
  await assert.rejects(lstat(scratchDirectory), { code: "ENOENT" });
});

test("Work retires and removes scratch when its first thread is invalid", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") server.send({ id: message.id, result: { thread: {} } });
  });
  const performer = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));
  const scratchDirectory = appServer.launches[0]?.localOnly?.scratchDirectory;
  assert.ok(scratchDirectory);
  const result = await performer.work(workRequest());
  assert.equal(result.outcome, "failed");
  assert.equal(result.workspace_changed, null);
  await assert.rejects(performer.work(workRequest()), /work_performer_retired/u);
  await assert.rejects(lstat(scratchDirectory), { code: "ENOENT" });
  await performer.close();
});

test("the first Work turn reports when an invalid thread cannot terminate its process", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") server.send({ id: message.id, result: { thread: {} } });
  }, false);

  const performer = await WorkPerformer.create(performerInput(), {
    ...performerOptions(appServer.spawner),
    shutdownTimeoutMs: 2,
  });
  assert.equal(appServer.requests.some(({ method }) => method === "thread/start"), false);
  await assert.rejects(performer.work(workRequest()), /work_performer_termination_failed/u);
  assert.deepEqual(appServer.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("Work closes before its first turn without creating a thread", async () => {
  const appServer = fakeAppServer(() => undefined);
  const performer = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));
  const scratchDirectory = appServer.launches[0]?.localOnly?.scratchDirectory;
  assert.ok(scratchDirectory);
  await lstat(scratchDirectory);
  await performer.close();
  assert.equal(appServer.requests.some(({ method }) => method === "thread/start"), false);
  await assert.rejects(lstat(scratchDirectory), { code: "ENOENT" });
});

test("Work close reports final scratch cleanup failure", {
  skip: process.platform === "win32",
}, async () => {
  const cleanupWorktree = await mkdtemp(path.join(temporary, "cleanup-worktree-"));
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-work-cleanup" } } });
    }
  });
  const performer = await WorkPerformer.create({
    ...performerInput(),
    root_worktree: cleanupWorktree,
  }, performerOptions(appServer.spawner));
  const scratchDirectory = appServer.launches[0]?.localOnly?.scratchDirectory;
  assert.ok(scratchDirectory);
  await lstat(scratchDirectory);
  assert.equal(appServer.requests.some(({ method }) => method === "thread/start"), false);
  await chmod(cleanupWorktree, 0o500);
  try {
    await assert.rejects(performer.close(), /work_performer_close_failed/u);
    await lstat(scratchDirectory);
  } finally {
    await chmod(cleanupWorktree, 0o700);
    await rm(cleanupWorktree, { recursive: true, force: true });
  }
});

test("Work lazily creates one writable thread with Markdown-only context and host-bound evidence", async () => {
  const request = workRequest();
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: `thread-work-${server.instance}` } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-work-1" } } });
      completeTurn(server, "turn-work-1", completedModelOutput());
    }
  });
  const performer = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));
  let scratchDirectory = "";
  try {
    assert.equal(appServer.requests.some(({ method }) => method === "thread/start"), false);
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
    assert.deepEqual(await performer.work(request), completed(request));
    const policy = appServer.launches[0]?.localOnly;
    assert.ok(policy);
    assert.equal(policy.workspaceRoot, await import("node:fs/promises").then(({ realpath }) => realpath(workspaceRoot)));
    assert.ok(policy.scratchDirectory?.startsWith(`${policy.workspaceRoot}${path.sep}`));
    scratchDirectory = policy.scratchDirectory as string;
    await lstat(scratchDirectory);

    const thread = appServer.requests.find(({ method }) => method === "thread/start")?.params as Record<string, unknown>;
    assert.equal(thread.permissions, policy.readPermissionProfile);
    assert.deepEqual(thread.dynamicTools, []);
    assert.deepEqual(thread.selectedCapabilityRoots, []);
    const turn = appServer.requests.find(({ method }) => method === "turn/start")?.params as {
      readonly permissions: unknown;
      readonly sandboxPolicy?: unknown;
      readonly input: readonly [{ readonly text: string }];
      readonly outputSchema: Record<string, unknown>;
    };
    assert.equal(turn.permissions, policy.writePermissionProfile);
    assert.equal(turn.sandboxPolicy, undefined);
    const promptText = turn.input[0].text;
    const prompt = JSON.parse(promptText) as Record<string, unknown>;
    assert.deepEqual(Object.keys(prompt).sort(), ["context", "instruction", "role"]);
    assert.equal(prompt.role, "Work");
    assert.deepEqual(prompt.context, {
      cycle_description_markdown: request.cycle_description_markdown,
      work_issue_description_markdown: request.work_issue_description_markdown,
    });
    for (const forbidden of [
      performerHome,
      workspaceRoot,
      scratchDirectory,
      "codex-secret-never-prompt",
      "LINEAR_API_KEY",
      request.root_id,
      request.cycle_id,
      request.cycle_revision,
      request.correlation_id,
      request.work_issue_id,
      request.work_issue_revision,
    ]) assert.equal(promptText.includes(String(forbidden)), false);
    const schema = JSON.stringify(turn.outputSchema);
    for (const forbidden of [
      "root_id", "runtime_generation", "cycle_id", "cycle_revision", "correlation_id",
      "work_issue_id", "work_issue_revision", "provider_receipt", "commit", "push",
    ]) {
      assert.equal(schema.includes(`"${forbidden}":`), false);
    }
    assert.equal(turn.outputSchema.type, "object");
    assert.equal(turn.outputSchema.oneOf, undefined);
    const outputProperties = turn.outputSchema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(outputProperties).sort(), [
      "checks",
      "outcome",
      "sanitized_summary_markdown",
      "workspace_changed",
    ]);
    assert.deepEqual(outputProperties.outcome?.enum, ["completed", "failed", "canceled"]);
  } finally {
    await performer.close();
  }
  await assert.rejects(lstat(scratchDirectory), { code: "ENOENT" });
});

test("installed Codex enforces the exact Work workspace-write profile", {
  timeout: 30_000,
}, async (context) => {
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-work-profile-probe-"));
  context.after(async () => rm(probeRoot, { recursive: true, force: true }));
  const probeWorktree = path.join(probeRoot, "worktree");
  const probeHome = path.join(probeRoot, "performer-home");
  const outside = path.join(probeRoot, "outside");
  await Promise.all([
    mkdir(path.join(probeWorktree, ".git"), { recursive: true }),
    mkdir(probeHome),
    mkdir(outside),
  ]);
  await Promise.all([
    writeFile(path.join(probeWorktree, "source.txt"), "before\n", "utf8"),
    writeFile(path.join(probeWorktree, ".git", "config"), "protected\n", "utf8"),
  ]);
  const appServer = fakeAppServer(() => undefined);
  const performer = await WorkPerformer.create({
    ...performerInput(),
    performer_home: probeHome,
    root_worktree: probeWorktree,
  }, performerOptions(appServer.spawner));
  const runtime = appServer.launches[0]?.localOnly;
  assert.ok(runtime);
  const [canonicalWorktree, canonicalOutside] = await Promise.all([
    realpath(probeWorktree),
    realpath(outside),
  ]);
  const scratchDirectory = runtime.scratchDirectory;
  assert.ok(scratchDirectory);
  try {
    const probeScript = String.raw`
      const fs = require("node:fs/promises");
      const path = require("node:path");
      const [workspace, scratch, outside] = process.argv.slice(1);
      const results = {};
      async function attempt(name, operation) {
        try { await operation(); results[name] = { ok: true }; }
        catch (error) { results[name] = { ok: false, code: error && error.code || null }; }
      }
      (async () => {
        await attempt("workspace_create", () => fs.writeFile(path.join(workspace, "created.txt"), "created\n"));
        await attempt("workspace_update", () => fs.appendFile(path.join(workspace, "source.txt"), "after\n"));
        await attempt("scratch_create", () => fs.writeFile(path.join(scratch, "turn-state.txt"), "retained\n"));
        await attempt("git_write", () => fs.writeFile(path.join(workspace, ".git", "config"), "changed\n"));
        await attempt("outside_write", () => fs.writeFile(path.join(outside, "created.txt"), "outside\n"));
        process.stdout.write(JSON.stringify(results));
      })().catch(() => process.exit(2));
    `;
    const executed = await execFileAsync("codex", [
      "sandbox",
      ...runtime.configArguments,
      "--permission-profile",
      runtime.writePermissionProfile,
      "--cd",
      canonicalWorktree,
      "--",
      process.execPath,
      "--openssl-config=/dev/null",
      "-e",
      probeScript,
      canonicalWorktree,
      scratchDirectory,
      canonicalOutside,
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? "C.UTF-8",
        CODEX_HOME: runtime.codexHome,
        OPENSSL_CONF: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
    });
    const evidence = JSON.parse(executed.stdout) as Record<string, { readonly ok: boolean }>;
    assert.deepEqual(Object.keys(evidence).sort(), [
      "git_write",
      "outside_write",
      "scratch_create",
      "workspace_create",
      "workspace_update",
    ]);
    assert.equal(evidence.workspace_create?.ok, true);
    assert.equal(evidence.workspace_update?.ok, true);
    assert.equal(evidence.scratch_create?.ok, true);
    assert.equal(evidence.git_write?.ok, false);
    assert.equal(evidence.outside_write?.ok, false);
    assert.equal(await readFile(path.join(canonicalWorktree, "source.txt"), "utf8"), "before\nafter\n");
    assert.equal(await readFile(path.join(canonicalWorktree, "created.txt"), "utf8"), "created\n");
    assert.equal(await readFile(path.join(scratchDirectory, "turn-state.txt"), "utf8"), "retained\n");
    assert.equal(await readFile(path.join(canonicalWorktree, ".git", "config"), "utf8"), "protected\n");
    await assert.rejects(readFile(path.join(canonicalOutside, "created.txt"), "utf8"), { code: "ENOENT" });
  } finally {
    await performer.close();
  }
  await assert.rejects(lstat(scratchDirectory), { code: "ENOENT" });
});

test("same-Cycle Work items reuse one thread across serialized turns", async () => {
  let turns = 0;
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: `thread-work-${server.instance}` } } });
    } else if (message.method === "turn/start") {
      turns += 1;
      const turnId = `turn-work-${turns}`;
      if (turns === 2) {
        server.send({
          id: "late-tool-request",
          method: "item/tool/call",
          params: {
            threadId: `thread-work-${server.instance}`,
            turnId: "turn-work-1",
            callId: "late-call",
            tool: "update_issue",
            arguments: {},
          },
        });
      }
      server.send({ id: message.id, result: { turn: { id: turnId } } });
      completeTurn(server, turnId, completedModelOutput());
    }
  });
  const performer = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));
  const scratchDirectory = appServer.launches[0]?.localOnly?.scratchDirectory;
  assert.ok(scratchDirectory);
  try {
    assert.equal(appServer.requests.some(({ method }) => method === "thread/start"), false);
    const first = workRequest("LIN-WORK-1", "corr:work:1", target, "revision:work:sealed-1");
    const second = workRequest(
      "LIN-WORK-2",
      "corr:work:2",
      target,
      "revision:work:sealed-2",
    );
    assert.deepEqual(await performer.work(first), completed(first));
    const scratchMarker = path.join(scratchDirectory, "same-process.txt");
    await writeFile(scratchMarker, "first turn\n", "utf8");
    assert.deepEqual(await performer.work(second), completed(second));
    assert.equal(await readFile(scratchMarker, "utf8"), "first turn\n");
    assert.equal(appServer.instances(), 1);
    assert.equal(appServer.requests.filter(({ method }) => method === "thread/start").length, 1);
    assert.equal(appServer.requests.filter(({ method }) => method === "turn/start").length, 2);
  } finally {
    await performer.close();
  }
  await assert.rejects(lstat(scratchDirectory), { code: "ENOENT" });
});

test("Work rejects concurrency and successor-Cycle input without allocating another turn", async () => {
  let activeServer: FakeAppServer | undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const request = workRequest();
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: `thread-work-${server.instance}` } } });
    } else if (message.method === "turn/start") {
      activeServer = server;
      server.send({ id: message.id, result: { turn: { id: "turn-work-active" } } });
      server.send({
        method: "turn/started",
        params: {
          threadId: `thread-work-${server.instance}`,
          turn: { id: "turn-work-active", status: "inProgress", items: [], error: null },
        },
      });
      markStarted();
    }
  });
  const performer = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
    const active = performer.work(request);
    await started;
    await assert.rejects(performer.work(workRequest("LIN-WORK-2", "corr:work:2")), /work_performer_busy/u);
    const successor = {
      ...target,
      cycle_id: parseCycleIssueId("LIN-CYCLE-2"),
      cycle_revision: parseTaskRevision("revision:cycle:successor"),
    };
    await assert.rejects(
      performer.work(workRequest("LIN-WORK-3", "corr:work:3", successor)),
      /work_performer_busy/u,
    );
    assert.equal(appServer.requests.filter(({ method }) => method === "turn/start").length, 1);
    completeTurn(activeServer as FakeAppServer, "turn-work-active", completedModelOutput());
    await active;
    await assert.rejects(
      performer.work(workRequest("LIN-WORK-3", "corr:work:3", successor)),
      /work_performer_invalid_request/u,
    );
    const changedRevision = {
      ...target,
      cycle_revision: parseTaskRevision("revision:cycle:changed"),
    };
    await assert.rejects(
      performer.work(workRequest("LIN-WORK-4", "corr:work:4", changedRevision)),
      /work_performer_invalid_request/u,
    );
    const changedRoot = {
      ...target,
      root_id: parseRootIssueId("LIN-ROOT-OTHER"),
    };
    await assert.rejects(
      performer.work(workRequest("LIN-WORK-5", "corr:work:5", changedRoot)),
      /work_performer_invalid_request/u,
    );
  } finally {
    await performer.close();
  }
});

test("capability violations and invalid output retire Work with unknown workspace state", async () => {
  for (const violation of ["tool", "invalid_output"] as const) {
    const request = workRequest();
    let denial: unknown;
    const appServer = fakeAppServer((message, server) => {
      if (message.method === "thread/start") {
        server.send({ id: message.id, result: { thread: { id: `thread-work-${server.instance}` } } });
      } else if (message.method === "turn/start") {
        server.send({ id: message.id, result: { turn: { id: "turn-work-bad" } } });
        if (violation === "tool") {
          server.send({
            method: "turn/started",
            params: {
              threadId: `thread-work-${server.instance}`,
              turn: { id: "turn-work-bad", status: "inProgress", items: [], error: null },
            },
          });
          server.send({
            id: "tool-request",
            method: "item/tool/call",
            params: {
              threadId: `thread-work-${server.instance}`,
              turnId: "turn-work-bad",
              callId: "call:update-issue",
              tool: "update_issue",
              arguments: { status: "Done" },
            },
          });
        } else {
          completeTurn(server, "turn-work-bad", {
            ...completedModelOutput(),
            correlation_id: "corr:stale",
          });
        }
      } else if (message.id === "tool-request") {
        denial = message.result;
        completeTurn(server, "turn-work-bad", completedModelOutput());
      }
    });
    const performer = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));
    try {
      const result = await performer.work(request);
      assert.equal(result.outcome, "failed");
      assert.equal(result.workspace_changed, null);
      await assert.rejects(performer.work(request), /work_performer_retired/u);
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

test("a forbidden Work tool call before turn activation retires the role", async () => {
  const request = workRequest();
  let denial: unknown;
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: `thread-work-${server.instance}` } } });
    } else if (message.method === "turn/start") {
      server.output.write([
        { id: message.id, result: { turn: { id: "turn-work-activation" } } },
        {
          id: "activation-tool-request",
          method: "item/tool/call",
          params: {
            threadId: `thread-work-${server.instance}`,
            turnId: "turn-work-activation",
            callId: "call:activation",
            tool: "update_issue",
            arguments: {},
          },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    } else if (message.id === "activation-tool-request") {
      denial = message.result;
      completeTurn(server, "turn-work-activation", completedModelOutput());
    }
  });
  const performer = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
    const result = await performer.work(request);
    assert.equal(result.outcome, "failed");
    assert.equal(result.workspace_changed, null);
    assert.deepEqual(denial, {
      success: false,
      contentItems: [{ type: "inputText", text: "capability_denied" }],
    });
    await assert.rejects(performer.work(request), /work_performer_retired/u);
  } finally {
    await performer.close();
  }
});

test("a retired Work result waits for native process exit", async () => {
  const request = workRequest();
  let server: FakeAppServer | undefined;
  const appServer = fakeAppServer((message, activeServer) => {
    server = activeServer;
    if (message.method === "thread/start") {
      activeServer.send({
        id: message.id,
        result: { thread: { id: `thread-work-${activeServer.instance}` } },
      });
    } else if (message.method === "turn/start") {
      activeServer.send({ id: message.id, result: { turn: { id: "turn-work-retire" } } });
      completeTurn(activeServer, "turn-work-retire", { invalid: true });
    }
  }, false);
  const performer = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));

  let settled = false;
  const running = performer.work(request).finally(() => { settled = true; });
  while (appServer.killSignals.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);

  (server as FakeAppServer).events.emit("exit", 0, null);
  const result = await running;
  assert.equal(result.outcome, "failed");
  await performer.close();
});

test("closing active Work waits for native exit before result or scratch cleanup", async () => {
  const request = workRequest();
  let server: FakeAppServer | undefined;
  let markTurnStarted: () => void = () => undefined;
  const turnStarted = new Promise<void>((resolve) => { markTurnStarted = resolve; });
  const appServer = fakeAppServer((message, activeServer) => {
    server = activeServer;
    if (message.method === "thread/start") {
      activeServer.send({
        id: message.id,
        result: { thread: { id: `thread-work-${activeServer.instance}` } },
      });
    } else if (message.method === "turn/start") {
      activeServer.send({ id: message.id, result: { turn: { id: "turn-work-close" } } });
      activeServer.send({
        method: "turn/started",
        params: {
          threadId: `thread-work-${activeServer.instance}`,
          turn: { id: "turn-work-close", status: "inProgress", items: [], error: null },
        },
      });
      markTurnStarted();
    } else if (message.method === "turn/interrupt") {
      activeServer.send({ id: message.id, result: {} });
    }
  }, false);
  const performer = await WorkPerformer.create(performerInput(), {
    ...performerOptions(appServer.spawner),
    shutdownTimeoutMs: 1_000,
  });
  const scratchDirectory = appServer.launches[0]?.localOnly?.scratchDirectory;
  assert.ok(scratchDirectory);

  let runningSettled = false;
  let closingSettled = false;
  const running = performer.work(request).finally(() => { runningSettled = true; });
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

test("interruption, close, and timeout never fabricate Work workspace certainty", async () => {
  for (const scenario of ["interrupted", "closed", "timed_out"] as const) {
    const request = workRequest();
    let markTurnStarted: () => void = () => undefined;
    const turnStarted = new Promise<void>((resolve) => { markTurnStarted = resolve; });
    const appServer = fakeAppServer((message, server) => {
      if (message.method === "thread/start") {
        server.send({ id: message.id, result: { thread: { id: `thread-work-${server.instance}` } } });
      } else if (message.method === "turn/start") {
        server.send({ id: message.id, result: { turn: { id: "turn-work-terminal" } } });
        if (scenario === "interrupted") completeTurn(server, "turn-work-terminal", undefined, "interrupted");
        else server.send({
          method: "turn/started",
          params: {
            threadId: `thread-work-${server.instance}`,
            turn: { id: "turn-work-terminal", status: "inProgress", items: [], error: null },
          },
        });
        if (scenario === "closed") markTurnStarted();
      } else if (message.method === "turn/interrupt") {
        server.send({ id: message.id, result: {} });
      }
    });
    const performer = await WorkPerformer.create(
      performerInput(),
      performerOptions(appServer.spawner, scenario === "timed_out" ? 10 : 2_000),
    );
    const active = performer.work(request);
    if (scenario === "closed") {
      await turnStarted;
      void performer.close();
    }
    const result = await active;
    assert.equal(result.outcome, scenario === "closed" || scenario === "interrupted" ? "canceled" : "failed");
    assert.equal(result.workspace_changed, null);
    if (scenario === "closed" || scenario === "timed_out") {
      assert.equal(
        appServer.requests.some(({ method }) => method === "turn/interrupt"),
        true,
        `expected ${scenario} Work to interrupt the active turn`,
      );
    }
    if (scenario === "closed") {
      assert.deepEqual(appServer.killSignals, ["SIGTERM"]);
    }
    if (scenario === "timed_out") {
      await assert.rejects(performer.work(request), /work_performer_retired/u);
    }
    await performer.close();
  }
});

test("a successor Cycle allocates a distinct Work process and thread", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: `thread-work-${server.instance}` } } });
    } else if (message.method === "turn/start") {
      const turnId = `turn-work-${server.instance}`;
      server.send({ id: message.id, result: { turn: { id: turnId } } });
      completeTurn(server, turnId, completedModelOutput());
    }
  });
  const first = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));
  await first.work(workRequest());
  await first.close();
  const successor = {
    ...target,
    cycle_id: parseCycleIssueId("LIN-CYCLE-2"),
    cycle_revision: parseTaskRevision("revision:cycle:successor"),
  };
  const second = await WorkPerformer.create(performerInput(successor), performerOptions(appServer.spawner));
  try {
    await second.work(workRequest("LIN-WORK-2", "corr:work:successor", successor));
    assert.equal(appServer.instances(), 2);
    const starts = appServer.requests.filter(({ method }) => method === "thread/start");
    assert.equal(starts.length, 2);
    assert.notEqual(
      (starts[0]?.serverInstance),
      (starts[1]?.serverInstance),
    );
    await assert.rejects(first.work(workRequest()), /work_performer_closed/u);
  } finally {
    await second.close();
  }
});
