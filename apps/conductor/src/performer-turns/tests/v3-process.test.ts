import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import type { JsonValue } from "@symphony/contracts";

import type { PerformerInvocation } from "../internal/GlobalPerformerLane.js";
import { SubprocessPerformerProcessImpl } from "../internal/SubprocessPerformerProcessImpl.js";
import { GlobalPerformerLane } from "../internal/GlobalPerformerLane.js";

test("Performer bootstrap returns its pointer and stays alive for the first Root Turn", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-v3-open-"));
  let invocation: PerformerInvocation | undefined;
  let processExited = false;
  const deadlines: number[] = [];
  const processBoundary = createProcess(runtimeRoot, {
    async run(value) {
      invocation = value;
      const writes: Uint8Array[] = [];
      let finish: (() => void) | undefined;
      const running = new Promise<void>((resolve) => { finish = resolve; });
      value.onStarted?.({
        extraStreams: [new PassThrough(), new PassThrough()],
        markReady(deadlineMs) { deadlines.push(deadlineMs ?? -1); },
        closeStdin() {},
        writeStdin(bytes) {
          writes.push(bytes);
          if (writes.length === 1) {
            const start = JSON.parse(Buffer.from(bytes).toString("utf8"));
            value.onStdout?.(rootEvent(start, 0, { kind: "protocol_ready" }));
          } else {
            const command = JSON.parse(Buffer.from(bytes).toString("utf8"));
            const start = JSON.parse(Buffer.from(writes[0]!).toString("utf8"));
            void writeFile(start.result_path, JSON.stringify(rootResult(command)))
              .then(() => finish?.());
          }
        },
      });
      const resultIndex = value.arguments.indexOf("--open-conversation-result-path");
      await writeFile(value.arguments[resultIndex + 1]!, JSON.stringify({
        protocol_version: "1",
        request_id: "request-1",
        performer_profile_id: "profile-1",
        performer_id: "conversation-1",
        completed_at: "2026-07-19T00:00:00Z",
      }));
      await running;
      processExited = true;
      return { stdout: "", stderr: "" };
    },
  });

  const output = await processBoundary.openRootConversation({
    profileId: "profile-1",
    command: {
      protocol_version: "1",
      request_id: "request-1",
      performer_profile_id: "profile-1",
      codex_turn_settings: {
        model: "gpt-5.2-codex",
        reasoning_effort: "high",
        is_fast_mode_enabled: false,
      },
      hard_deadline_at: "2026-07-19T00:01:00Z",
    },
  });

  assert.equal((output.result as { performer_id: string }).performer_id, "conversation-1");
  assert.equal(processExited, false);
  assert.equal(processBoundary.hasPendingBootstrap("profile-1"), true);
  assert.equal(processBoundary.hasPendingBootstrap("profile-2"), false);
  assert.deepEqual(deadlines, [300_000]);
  assert.equal(invocation?.workingDirectory, undefined);
  assert.equal(invocation?.extraPipeCount, 2);
  const requestIndex = invocation!.arguments.indexOf("--open-conversation-request-path");
  const request = JSON.parse(await readFile(invocation!.arguments[requestIndex + 1]!, "utf8"));
  assert.equal("root_context" in request, false);
  assert.equal("workspace_root" in request, false);
  assert.equal("command_channel" in request, false);

  const turn = await processBoundary.runRootTurn({
    profileId: "profile-1",
    workspaceRoot: runtimeRoot,
    command: rootCommand(runtimeRoot),
    broker: { execute: async () => ({ status: "read" }) },
  });
  assert.equal((turn.result as { result_kind: string }).result_kind, "root_turn_completed");
  assert.equal(processExited, true);
  assert.equal(processBoundary.hasPendingBootstrap("profile-1"), false);
  assert.deepEqual(deadlines, [300_000, 1_000, 60_000]);
});

test("Performer process sends Root context only after protocol readiness", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-v3-turn-"));
  const command = rootCommand(runtimeRoot);
  let stdinBeforeReady: Uint8Array | undefined;
  let stdinAfterReady: Uint8Array | undefined;
  const process = createProcess(runtimeRoot, {
    async run(invocation) {
      const writes: Uint8Array[] = [];
      invocation.onStarted?.({
        writeStdin(value) { writes.push(value); },
        closeStdin() {},
        extraStreams: [],
      });
      stdinBeforeReady = writes[0];
      invocation.onStdout?.(rootEvent(command, 0, { kind: "protocol_ready" }));
      stdinAfterReady = writes[0];
      await writeFile(resultPath(invocation), JSON.stringify(rootResult(command)));
      return { stdout: "", stderr: "" };
    },
  });

  const output = await process.runRootTurn({
    profileId: "profile-1",
    workspaceRoot: runtimeRoot,
    command,
    broker: { execute: async () => ({ status: "read" }) },
  });

  assert.equal(stdinBeforeReady, undefined);
  assert.deepEqual(JSON.parse(Buffer.from(stdinAfterReady!).toString("utf8")), command);
  assert.equal((output.result as { result_kind: string }).result_kind, "root_turn_completed");
});

test("Performer process gives only the current Turn a closed broker CLI environment", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-v3-turn-"));
  const command = rootCommand(runtimeRoot);
  let environment: NodeJS.ProcessEnv | undefined;
  const processBoundary = createProcess(runtimeRoot, {
    async run(invocation) {
      environment = invocation.environment;
      invocation.onStarted?.({ writeStdin() {}, closeStdin() {}, extraStreams: [] });
      invocation.onStdout?.(rootEvent(command, 0, { kind: "protocol_ready" }));
      await writeFile(resultPath(invocation), JSON.stringify(rootResult(command)));
      return { stdout: "", stderr: "" };
    },
  });

  await processBoundary.runRootTurn({
    profileId: "profile-1", workspaceRoot: runtimeRoot, command,
    broker: { execute: async () => ({ status: "read" }) },
  });

  assert.equal(environment?.SYMPHONY_TURN_ID, "turn-1");
  assert.equal(environment?.SYMPHONY_ROOT_ISSUE_ID, "root-1");
  assert.equal(environment?.SYMPHONY_PERFORMER_ID, "conversation-1");
  assert.equal(environment?.PATH?.split(path.delimiter)[0], process.cwd());
  assert.deepEqual(
    JSON.parse(environment?.SYMPHONY_AGENT_COMMAND_CATALOG ?? "null")["linear status set"],
    "linear.status.set",
  );
  assert.equal("SYMPHONY_E2E_CODEX_API_KEY" in environment!, false);
});

test("Performer process rejects oversized context before spawn", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-v3-turn-"));
  const command = rootCommand(runtimeRoot);
  command.turn_limits = { ...(command.turn_limits as object), max_context_bytes: 1 };
  let spawned = false;
  const process = createProcess(runtimeRoot, {
    async run() {
      spawned = true;
      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    process.runRootTurn({
      profileId: "profile-1",
      workspaceRoot: runtimeRoot,
      command,
      broker: { execute: async () => ({ status: "read" }) },
    }),
    /performer_context_bytes_exceeded/u,
  );
  assert.equal(spawned, false);
});

test("Performer process drops a stale Root event and Result across every correlation", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-v3-turn-"));
  const command = rootCommand(runtimeRoot);
  const observed: JsonValue[] = [];
  const process = createProcess(runtimeRoot, {
    async run(invocation) {
      invocation.onStarted?.({ writeStdin() {}, closeStdin() {}, extraStreams: [] });
      invocation.onStdout?.(rootEvent(command, 0, { kind: "protocol_ready" }));
      invocation.onStdout?.(rootEvent(
        { ...command, performer_id: "conversation-old" },
        1,
        { kind: "heartbeat" },
      ));
      await writeFile(resultPath(invocation), JSON.stringify({
        ...rootResult(command),
        context_digest: "digest-old",
      }));
      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    process.runRootTurn({
      profileId: "profile-1",
      workspaceRoot: runtimeRoot,
      command,
      broker: { execute: async () => ({ status: "read" }) },
      onEvent: (event) => observed.push(event),
    }),
    /performer_result_correlation_invalid/u,
  );
  assert.deepEqual(
    observed.map((event) => ((event as { body: { kind: string } }).body.kind)),
    ["protocol_ready"],
  );
});

test("Performer process crosses the real readiness and atomic Result boundary", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-v3-real-"));
  const command = rootCommand(runtimeRoot);
  const script = [
    "const fs=require('fs');",
    "const a=process.argv.slice(1);const get=n=>a[a.indexOf(n)+1];",
    "const event={protocol_version:'1',turn_id:get('--turn-id'),root_issue_id:get('--root-issue-id'),performer_profile_id:get('--performer-profile-id'),performer_id:get('--performer-id'),context_digest:get('--context-digest'),sequence:0,occurred_at:'2026-07-19T00:00:01Z',body:{kind:'protocol_ready'}};",
    "process.stdout.write(JSON.stringify(event)+'\\n');",
    "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{",
    "const c=JSON.parse(input);const result={protocol_version:c.protocol_version,turn_id:c.turn_id,root_issue_id:c.root_issue_id,performer_profile_id:c.performer_profile_id,performer_id:c.performer_id,context_digest:c.context_digest,result_kind:'root_turn_completed',completed_at:'2026-07-19T00:00:02Z',turn_usage:{wall_time_ms:1,context_bytes:Buffer.byteLength(c.root_context.json)+Buffer.byteLength(c.root_context.markdown),provider_tokens:0,broker_calls:0,mutations:0}};",
    "const p=get('--root-turn-result-path');fs.writeFileSync(p+'.tmp',JSON.stringify(result));fs.renameSync(p+'.tmp',p);});",
  ].join("");
  // Node needs the inline program before the Performer correlation arguments.
  const lane = new GlobalPerformerLane();
  const wrapped = createProcess(runtimeRoot, {
    run(invocation) {
      return lane.run({
        ...invocation,
        executable: process.execPath,
        arguments: ["-e", script, "--", ...invocation.arguments],
      });
    },
    cancelAndReap: (graceMs) => lane.cancelAndReap(graceMs),
  });
  const output = await wrapped.runRootTurn({
    profileId: "profile-1",
    workspaceRoot: runtimeRoot,
    command,
    broker: { execute: async () => ({ status: "read" }) },
  });
  assert.equal((output.result as { result_kind: string }).result_kind, "root_turn_completed");
});

test("Performer process brokers one framed command on its private pipes", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-v3-broker-"));
  const command = rootCommand(runtimeRoot);
  const requests = new PassThrough();
  const responses = new PassThrough();
  const brokerCalls: unknown[] = [];
  let response: unknown;
  const processBoundary = createProcess(runtimeRoot, {
    async run(invocation) {
      invocation.onStarted?.({
        writeStdin() {}, closeStdin() {}, extraStreams: [requests, responses],
      });
      invocation.onStdout?.(rootEvent(command, 0, { kind: "protocol_ready" }));
      const received = new Promise<void>((resolve) => responses.once("data", (chunk) => {
        response = JSON.parse(chunk.toString("utf8")); resolve();
      }));
      requests.write(`${JSON.stringify({
        protocol_version: "1", request_id: "broker-1", turn_id: "turn-1",
        root_issue_id: "root-1", performer_id: "conversation-1",
        command: "linear.status.set", args: {
          issue_id: "root-1", status: "In Progress",
          expected_remote_version: "version-1", expected_git_head: "abc123",
        },
      })}\n`);
      await received;
      await writeFile(resultPath(invocation), JSON.stringify(rootResult(command)));
      return { stdout: "", stderr: "" };
    },
  });

  const output = await processBoundary.runRootTurn({
    profileId: "profile-1",
    workspaceRoot: runtimeRoot,
    command,
    broker: {
      async execute(value) {
        brokerCalls.push(value);
        const request = value as Record<string, JsonValue>;
        return {
          protocol_version: request.protocol_version!, request_id: request.request_id!,
          turn_id: request.turn_id!, root_issue_id: request.root_issue_id!,
          performer_id: request.performer_id!, status: "applied", summary: "Mutation applied.",
        };
      },
    },
  });
  assert.equal(brokerCalls.length, 1);
  assert.equal((response as { status: string }).status, "applied");
  assert.deepEqual((output.result as { turn_usage: object }).turn_usage, {
    wall_time_ms: 10, context_bytes: 25, provider_tokens: 0,
    broker_calls: 1, mutations: 1,
  });
});

test("cancellation rejects new broker calls before process termination", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-v3-cancel-"));
  const command = rootCommand(runtimeRoot);
  const requests = new PassThrough();
  const responses = new PassThrough();
  let invocation: PerformerInvocation | undefined;
  let finish: (() => void) | undefined;
  const canFinish = new Promise<void>((resolve) => { finish = resolve; });
  let started: (() => void) | undefined;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  let brokerCalls = 0;
  let rejected: unknown;
  const processBoundary = createProcess(runtimeRoot, {
    async run(value) {
      invocation = value;
      value.onStarted?.({
        writeStdin() {}, closeStdin() {}, extraStreams: [requests, responses],
      });
      value.onStdout?.(rootEvent(command, 0, { kind: "protocol_ready" }));
      started?.();
      await canFinish;
      await writeFile(resultPath(value), JSON.stringify(rootResult(command)));
      return { stdout: "", stderr: "" };
    },
    async cancelAndReap() {
      const received = new Promise<void>((resolve) => responses.once("data", (chunk) => {
        rejected = JSON.parse(chunk.toString("utf8")); resolve();
      }));
      requests.write(`${JSON.stringify({
        protocol_version: "1",
        request_id: "late-1",
        turn_id: "turn-1",
        root_issue_id: "root-1",
        performer_id: "conversation-1",
      })}\n`);
      await received;
      finish?.();
    },
  });
  const running = processBoundary.runRootTurn({
    profileId: "profile-1",
    workspaceRoot: runtimeRoot,
    command,
    broker: { async execute() { brokerCalls += 1; return { status: "read" }; } },
  });
  await didStart;
  await processBoundary.cancelAndReap();
  await running;

  assert.ok(invocation);
  assert.equal(brokerCalls, 0);
  assert.equal((rejected as { status: string }).status, "rejected");
  assert.equal(
    (rejected as { problem: { code: string } }).problem.code,
    "command_channel_canceled",
  );
});

function createProcess(
  runtimeRoot: string,
  lane: {
    run(value: PerformerInvocation): Promise<{ stdout: string; stderr: string }>;
    cancelAndReap?(graceMs: number): Promise<void>;
  },
) {
  return new SubprocessPerformerProcessImpl({
    run: lane.run.bind(lane),
    cancelAndReap: lane.cancelAndReap?.bind(lane) ?? (async () => {}),
  }, {
    runtimeRoot,
    executable: "performer",
    environment: () => ({ CODEX_HOME: "/isolated/profile" }),
    startupDeadlineMs: 1_000,
    cancellationGraceMs: 100,
  });
}

function resultPath(invocation: PerformerInvocation): string {
  const index = invocation.arguments.indexOf("--root-turn-result-path");
  return invocation.arguments[index + 1]!;
}

function rootEvent(command: Record<string, JsonValue>, sequence: number, body: JsonValue) {
  return Buffer.from(`${JSON.stringify({
    protocol_version: command.protocol_version,
    turn_id: command.turn_id,
    root_issue_id: command.root_issue_id,
    performer_profile_id: command.performer_profile_id,
    performer_id: command.performer_id,
    context_digest: command.context_digest,
    sequence,
    occurred_at: "2026-07-19T00:00:01Z",
    body,
  })}\n`);
}

function rootCommand(workspaceRoot: string): Record<string, JsonValue> {
  return {
    protocol_version: "1",
    turn_id: "turn-1",
    root_issue_id: "root-1",
    performer_profile_id: "profile-1",
    performer_id: "conversation-1",
    codex_turn_settings: {
      model: "gpt-5.2-codex",
      reasoning_effort: "high",
      is_fast_mode_enabled: false,
    },
    execution_policy: {
      sandbox_mode: "workspace_write",
      command_allowlist: [],
      command_denylist: [],
    },
    root_context: { json: '{"root":"root-1"}', markdown: "# Root" },
    context_digest: "digest-1",
    command_channel: {
      kind: "workspace_framed_channel",
      metadata_path: ".symphony/agent-command/metadata.json",
      request_path: ".symphony/agent-command/request.fifo",
      response_path: ".symphony/agent-command/response.fifo",
    },
    workspace_root: workspaceRoot,
    started_at: "2026-07-19T00:00:00Z",
    turn_limits: {
      max_wall_time_ms: 60_000,
      max_context_bytes: 1_024,
      max_broker_calls: 10,
      max_mutations: 2,
    },
  };
}

function rootResult(command: Record<string, JsonValue>): Record<string, JsonValue> {
  return {
    protocol_version: command.protocol_version!,
    turn_id: command.turn_id!,
    root_issue_id: command.root_issue_id!,
    performer_profile_id: command.performer_profile_id!,
    performer_id: command.performer_id!,
    context_digest: command.context_digest!,
    result_kind: "root_turn_completed",
    completed_at: "2026-07-19T00:00:02Z",
    turn_usage: {
      wall_time_ms: 10,
      context_bytes: 25,
      provider_tokens: 0,
      broker_calls: 0,
      mutations: 0,
    },
  };
}
