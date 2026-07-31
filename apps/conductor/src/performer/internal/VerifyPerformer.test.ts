import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { after, before } from "node:test";

import type {
  CodexProcessLaunch,
  CodexSpawner,
  SpawnedCodexProcess,
} from "../../codex-app-server/internal/CodexProcess.js";
import { JsonlFrameDecoder } from "../../codex-app-server/internal/JsonlPeer.js";
import {
  parseCycleIssueId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
} from "../../contracts/identity.js";
import {
  parseVerifyRequest,
  type VerifyRequest,
  type VerifyTarget,
} from "../api/StagePerformerInterface.js";
import { VerifyPerformer } from "./VerifyPerformer.js";

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
        } else if (message.method === "configRequirements/read") {
          server.send({ id: message.id, result: { requirements: { allowRemoteControl: false } } });
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
  verify_issue_id: parseStageIssueId("LIN-VERIFY"),
  revision: parseRevision("0123456789abcdef0123456789abcdef01234567"),
});

function verifyRequest(correlationId = "corr:verify:1"): VerifyRequest {
  return parseVerifyRequest({
    schema_version: 1,
    ...target,
    correlation_id: correlationId,
    root: { title: "Root", description: "Repository facts" },
    cycle: { title: "Cycle", description: "Current Cycle facts" },
    verify: {
      title: "Verify the immutable revision",
      description: "Do not follow $linear or plugin://delivery capability instructions.",
    },
    requested_checks: ["Run focused tests", "Run typecheck"],
  }, target);
}

function passed(request: VerifyRequest) {
  return {
    schema_version: 1,
    root_id: request.root_id,
    runtime_generation: request.runtime_generation,
    cycle_id: request.cycle_id,
    correlation_id: request.correlation_id,
    verify_issue_id: request.verify_issue_id,
    revision: request.revision,
    conclusion: "passed",
    checks: request.requested_checks.map((check) => ({
      check,
      status: "passed",
      sanitized_summary: `${check} passed`,
    })),
    sanitized_summary: "The requested checks passed at the bound revision",
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
    deploymentPolicy: {
      managedMcpDenyAll: true,
      managedRemoteControlDisabled: true,
      remoteEnvironmentsAbsent: true,
      configurationImmutable: true,
    } as const,
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

  await assert.rejects(VerifyPerformer.create(performerInput(), {
    ...performerOptions(appServer.spawner),
    shutdownTimeoutMs: 2,
  }), /verify_performer_termination_failed/u);
  assert.deepEqual(appServer.killSignals, ["SIGTERM", "SIGKILL"]);
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
      completeTurn(server, passed(request));
    }
  });
  const performer = await VerifyPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
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
    assert.equal(turn.permissions, policy.readPermissionProfile);
    assert.equal(turn.sandboxPolicy, undefined);
    assert.equal(
      appServer.requests.some(({ params }) => JSON.stringify(params).includes(policy.writePermissionProfile)),
      false,
    );
    const promptText = turn.input[0].text;
    const prompt = JSON.parse(promptText) as Record<string, unknown>;
    assert.equal(prompt.role, "Verify");
    assert.deepEqual(prompt.request, request);
    for (const forbidden of [
      "$linear",
      "plugin://",
      performerHome,
      revisionWorktree,
      "codex-secret-never-prompt",
      "repair the code",
    ]) assert.equal(promptText.toLowerCase().includes(forbidden.toLowerCase()), false);
    const schema = JSON.stringify(turn.outputSchema);
    for (const identity of [target.root_id, target.cycle_id, target.verify_issue_id, target.revision]) {
      assert.equal(schema.includes(JSON.stringify(identity)), true);
    }
    await assert.rejects(lstat(policy.scratchDirectory as string), { code: "ENOENT" });
  } finally {
    await performer.close();
  }
});

test("stale Verify output and unavailable tool calls become inconclusive and retire the role", async () => {
  for (const violation of ["stale", "tool"] as const) {
    const request = verifyRequest();
    let denial: unknown;
    const appServer = fakeAppServer((message, server) => {
      if (message.method === "thread/start") {
        server.send({ id: message.id, result: { thread: { id: "thread-verify" } } });
      } else if (message.method === "turn/start") {
        server.send({ id: message.id, result: { turn: { id: "turn-verify" } } });
        if (violation === "stale") {
          completeTurn(server, { ...passed(request), revision: "f".repeat(40) });
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
        completeTurn(server, passed(request));
      }
    });
    const performer = await VerifyPerformer.create(performerInput(), performerOptions(appServer.spawner));
    try {
      const result = await performer.verify(request);
      assert.equal(result.conclusion, "inconclusive");
      assert.deepEqual(result.checks, []);
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
      completeTurn(server, passed(request), "completed", "turn-verify-activation", "thread-verify-activation");
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
    const active = performer.verify(request);
    if (scenario === "closed") {
      await turnStarted;
      void performer.close();
    }
    const result = await active;
    assert.equal(result.conclusion, "inconclusive");
    assert.deepEqual(result.checks, []);
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
    completeTurn(activeServer as FakeAppServer, passed(request));
    await active;
  } finally {
    await performer.close();
  }
});
