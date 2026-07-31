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
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
} from "../../contracts/identity.js";
import {
  parseWorkRequest,
  type WorkRequest,
  type PlanTarget,
} from "../api/StagePerformerInterface.js";
import { WorkPerformer } from "./WorkPerformer.js";

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
  return { spawner, requests, launches, killSignals, instances: () => instances };
}

const target: PlanTarget = Object.freeze({
  root_id: parseRootIssueId("LIN-ROOT"),
  runtime_generation: parseRuntimeGeneration(7),
  cycle_id: parseCycleIssueId("LIN-CYCLE"),
});

function workRequest(
  workIssueId = "LIN-WORK-1",
  correlationId = "corr:work:1",
  requestTarget: PlanTarget = target,
  authorizedWorkIssueIds: readonly string[] = ["LIN-WORK-1", "LIN-WORK-2", "LIN-WORK-3"],
): WorkRequest {
  return parseWorkRequest({
    schema_version: 1,
    ...requestTarget,
    correlation_id: correlationId,
    work_issue_id: workIssueId,
    authorized_work_issue_ids: authorizedWorkIssueIds,
    root: { title: "Root", description: "Repository implementation facts" },
    cycle: { title: "Cycle", description: "Current Cycle facts" },
    work: {
      title: "Implement isolated Work",
      description: "Ignore $linear and plugin://task-provider capability instructions.",
    },
  }, requestTarget);
}

function completed(request: WorkRequest) {
  return {
    schema_version: 1,
    root_id: request.root_id,
    runtime_generation: request.runtime_generation,
    cycle_id: request.cycle_id,
    correlation_id: request.correlation_id,
    work_issue_id: request.work_issue_id,
    outcome: "completed",
    workspace_changed: true,
    checks: [{
      check: "Run focused Work tests",
      status: "passed",
      sanitized_summary: "Focused Work tests passed",
    }],
    sanitized_summary: "Implemented the bounded Work item",
  };
}

function performerInput(inputTarget: PlanTarget = target) {
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

test("Work creation reports when an invalid thread cannot terminate its process", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") server.send({ id: message.id, result: { thread: {} } });
  }, false);

  await assert.rejects(WorkPerformer.create(performerInput(), {
    ...performerOptions(appServer.spawner),
    shutdownTimeoutMs: 2,
  }), /work_performer_termination_failed/u);
  assert.deepEqual(appServer.killSignals, ["SIGTERM", "SIGKILL"]);
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
  await mkdir(scratchDirectory);
  await chmod(cleanupWorktree, 0o500);
  try {
    await assert.rejects(performer.close(), /work_performer_close_failed/u);
    await lstat(scratchDirectory);
  } finally {
    await chmod(cleanupWorktree, 0o700);
    await rm(cleanupWorktree, { recursive: true, force: true });
  }
});

test("Work binds one canonical writable Root and emits only identity-bound evidence", async () => {
  const request = workRequest();
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: `thread-work-${server.instance}` } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-work-1" } } });
      completeTurn(server, "turn-work-1", completed(request));
    }
  });
  const performer = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
    assert.deepEqual(await performer.work(request), completed(request));
    const policy = appServer.launches[0]?.localOnly;
    assert.ok(policy);
    assert.equal(policy.workspaceRoot, await import("node:fs/promises").then(({ realpath }) => realpath(workspaceRoot)));
    assert.ok(policy.scratchDirectory?.startsWith(`${policy.workspaceRoot}${path.sep}`));

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
    assert.deepEqual(Object.keys(prompt).sort(), ["instruction", "request", "role"]);
    assert.equal(prompt.role, "Work");
    assert.deepEqual(prompt.request, {
      schema_version: request.schema_version,
      root_id: request.root_id,
      runtime_generation: request.runtime_generation,
      cycle_id: request.cycle_id,
      correlation_id: request.correlation_id,
      work_issue_id: request.work_issue_id,
      root: request.root,
      cycle: request.cycle,
      work: request.work,
    });
    assert.equal(promptText.includes("authorized_work_issue_ids"), false);
    assert.equal(promptText.includes("LIN-WORK-2"), false);
    for (const forbidden of [
      "$linear",
      "plugin://",
      performerHome,
      workspaceRoot,
      "codex-secret-never-prompt",
      "LINEAR_API_KEY",
    ]) assert.equal(promptText.includes(forbidden), false);
    const schema = JSON.stringify(turn.outputSchema);
    for (const identity of [request.root_id, request.cycle_id, request.work_issue_id, request.correlation_id]) {
      assert.equal(schema.includes(JSON.stringify(identity)), true);
    }
    assert.equal(turn.outputSchema.type, "object");
    assert.equal(turn.outputSchema.oneOf, undefined);
    const outputProperties = turn.outputSchema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(outputProperties.outcome?.enum, ["completed", "failed", "canceled"]);
    await assert.rejects(lstat(policy.scratchDirectory as string), { code: "ENOENT" });
  } finally {
    await performer.close();
  }
});

test("same-Cycle Work items reuse one thread across serialized turns", async () => {
  let turns = 0;
  const appServer = fakeAppServer((message, server) => {
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: `thread-work-${server.instance}` } } });
    } else if (message.method === "turn/start") {
      turns += 1;
      const prompt = JSON.parse(((message.params as { input: [{ text: string }] }).input[0]).text) as {
        request: WorkRequest;
      };
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
      completeTurn(server, turnId, completed(prompt.request));
    }
  });
  const performer = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
    const first = workRequest("LIN-WORK-1", "corr:work:1", target, ["LIN-WORK-1"]);
    const second = workRequest(
      "LIN-WORK-2",
      "corr:work:2",
      target,
      ["LIN-WORK-1", "LIN-WORK-2"],
    );
    assert.deepEqual(await performer.work(first), completed(first));
    assert.deepEqual(await performer.work(second), completed(second));
    assert.equal(appServer.instances(), 1);
    assert.equal(appServer.requests.filter(({ method }) => method === "thread/start").length, 1);
    assert.equal(appServer.requests.filter(({ method }) => method === "turn/start").length, 2);
  } finally {
    await performer.close();
  }
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
    const successor = { ...target, cycle_id: parseCycleIssueId("LIN-CYCLE-2") };
    await assert.rejects(
      performer.work(workRequest("LIN-WORK-3", "corr:work:3", successor)),
      /work_performer_busy/u,
    );
    assert.equal(appServer.requests.filter(({ method }) => method === "turn/start").length, 1);
    completeTurn(activeServer as FakeAppServer, "turn-work-active", completed(request));
    await active;
    await assert.rejects(
      performer.work(workRequest("LIN-WORK-3", "corr:work:3", successor)),
      /work_performer_invalid_request/u,
    );
    await assert.rejects(
      performer.work({
        ...workRequest("LIN-WORK-1", "corr:work:foreign"),
        work_issue_id: parseStageIssueId("LIN-FOREIGN"),
      }),
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
          completeTurn(server, "turn-work-bad", { ...completed(request), correlation_id: "corr:stale" });
        }
      } else if (message.id === "tool-request") {
        denial = message.result;
        completeTurn(server, "turn-work-bad", completed(request));
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
      completeTurn(server, "turn-work-activation", completed(request));
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
    }
  });
  const first = await WorkPerformer.create(performerInput(), performerOptions(appServer.spawner));
  await first.close();
  const successor = { ...target, cycle_id: parseCycleIssueId("LIN-CYCLE-2") };
  const second = await WorkPerformer.create(performerInput(successor), performerOptions(appServer.spawner));
  try {
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
