import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { JsonValue } from "@symphony/contracts";

import { PerformerTurnProcessImpl } from "../internal/PerformerTurnProcessImpl.js";
import type { PerformerInvocation } from "../internal/GlobalPerformerLane.js";
import type { PerformerEventStreamViolation } from "../internal/PerformerEventStreamDecoder.js";

const command = planCommand("turn-1");
type JsonRecord = { [key: string]: JsonValue };

test("Performer process uses stdout events and returns only the closed Result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-turn-"));
  let invocation: PerformerInvocation | undefined;
  const observed: unknown[] = [];
  const process = createProcess(root, {
    async run(value) {
      invocation = value;
      value.onStdout?.(eventFrame("turn-1", 0, { kind: "turn_started" }));
      value.onStdout?.(eventFrame("turn-1", 1, {
        kind: "turn_completed",
        result_kind: "plan_ready",
        sanitized_summary: "Plan ready.",
      }));
      await writeResult(value, planResult("turn-1"));
      return { stdout: "", stderr: "" };
    },
  });

  const output = await process.run({
    turnId: "turn-1",
    profileId: "profile-1",
    workspaceRoot: root,
    command,
    onEvent: (event) => observed.push(event),
  });

  assert.deepEqual(Object.keys(output), ["result"]);
  assert.equal(
    (output.result as { result_kind: string }).result_kind,
    "plan_ready",
  );
  assert.deepEqual(
    observed.map((value) =>
      ((value as { body: { kind: string } }).body.kind)),
    ["turn_started", "turn_completed"],
  );
  assert.equal(invocation?.environment?.CODEX_HOME, "/isolated/profile");
  const requestPath = path.join(root, "turn-1", "turn-request.json");
  const resultPath = path.join(root, "turn-1", "turn-result.json");
  assert.deepEqual(invocation?.arguments, [
    "--turn-request-path",
    requestPath,
    "--turn-result-path",
    resultPath,
    "--event-sequence-start",
    "0",
  ]);
  assert.equal(JSON.parse(await readFile(requestPath, "utf8")).turn_id, "turn-1");
});

test("Performer process delivers an event before the child exits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-turn-"));
  let releaseChild: (() => void) | undefined;
  let eventWritten: (() => void) | undefined;
  const childReleased = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const eventIsWritten = new Promise<void>((resolve) => {
    eventWritten = resolve;
  });
  const process = createProcess(root, {
    async run(value) {
      value.onStdout?.(eventFrame("turn-1", 0, { kind: "turn_started" }));
      eventWritten?.();
      await childReleased;
      await writeResult(value, planResult("turn-1"));
      return { stdout: "", stderr: "" };
    },
  });
  let observed = false;

  const running = process.run({
    turnId: "turn-1",
    profileId: "profile-1",
    workspaceRoot: root,
    command,
    onEvent() {
      observed = true;
    },
  });

  await eventIsWritten;
  const observedBeforeExit = observed;
  releaseChild?.();
  await running;

  assert.equal(observedBeforeExit, true);
});

test("Performer process reports an uncorrelated frame without changing its Result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-turn-"));
  const events: unknown[] = [];
  const violations: PerformerEventStreamViolation[] = [];
  const process = createProcess(root, {
    async run(value) {
      value.onStdout?.(eventFrame("turn-other", 0, { kind: "turn_started" }));
      value.onStdout?.(eventFrame("turn-1", 0, { kind: "turn_started" }));
      await writeResult(value, planResult("turn-1"));
      return { stdout: "", stderr: "" };
    },
  });

  const output = await process.run({
    turnId: "turn-1",
    profileId: "profile-1",
    workspaceRoot: root,
    command,
    onEvent: (event) => events.push(event),
    onEventViolation: (violation) => violations.push(violation),
  });

  assert.equal(
    (output.result as { result_kind: string }).result_kind,
    "plan_ready",
  );
  assert.deepEqual(events.map((value) => (value as { sequence: number }).sequence), [0]);
  assert.deepEqual(violations.map(({ code }) => code), [
    "performer_event_correlation_invalid",
  ]);
});

test("Performer process continues one Turn sequence in memory and resets a new Turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-turn-"));
  const starts: Array<{ turnId: string; sequence: number }> = [];
  const observed: number[] = [];
  const process = createProcess(root, {
    async run(value) {
      const request = JSON.parse(await readFile(argument(value, "--turn-request-path"), "utf8"));
      const start = Number(argument(value, "--event-sequence-start"));
      starts.push({ turnId: request.turn_id, sequence: start });
      value.onStdout?.(eventFrame(request.turn_id, start, { kind: "turn_started" }));
      value.onStdout?.(eventFrame(request.turn_id, start + 1, {
        kind: "error_raised",
        error_code: "provider_turn_failed",
        sanitized_summary: "Retryable provider failure.",
        retryable: true,
      }));
      await writeResult(value, failedResult(request.turn_id));
      return { stdout: "", stderr: "" };
    },
  });

  for (const turnId of ["turn-1", "turn-1", "turn-2"]) {
    await process.run({
      turnId,
      profileId: "profile-1",
      workspaceRoot: root,
      command: planCommand(turnId),
      onEvent: (event) => observed.push(event.sequence as number),
    });
  }

  assert.deepEqual(starts, [
    { turnId: "turn-1", sequence: 0 },
    { turnId: "turn-1", sequence: 2 },
    { turnId: "turn-2", sequence: 0 },
  ]);
  assert.deepEqual(observed, [0, 1, 2, 3, 0, 1]);
});

test("Performer process blocks on a missing Result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-turn-"));
  const process = createProcess(root, {
    async run() {
      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    process.run({
      turnId: "turn-1",
      profileId: "profile-1",
      workspaceRoot: root,
      command,
    }),
    /performer_result_missing/u,
  );
});

test("Performer process does not expose raw child errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-turn-"));
  const process = createProcess(root, {
    async run() {
      throw new Error("sensitive upstream failure detail");
    },
  });

  await assert.rejects(
    process.run({
      turnId: "turn-1",
      profileId: "profile-1",
      workspaceRoot: root,
      command,
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "performer_turn_process_failed",
  );
});

function createProcess(
  runtimeRoot: string,
  lane: { run(value: PerformerInvocation): Promise<{ stdout: string; stderr: string }> },
): PerformerTurnProcessImpl {
  return new PerformerTurnProcessImpl(lane, {
    runtimeRoot,
    executable: "performer",
    environment: () => ({ CODEX_HOME: "/isolated/profile" }),
    deadlineMs: 1_000,
  });
}

async function writeResult(
  invocation: PerformerInvocation,
  result: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    argument(invocation, "--turn-result-path"),
    JSON.stringify(result),
  );
}

function argument(invocation: PerformerInvocation, name: string): string {
  return invocation.arguments[invocation.arguments.indexOf(name) + 1]!;
}

function eventFrame(
  turnId: string,
  sequence: number,
  body: Record<string, unknown>,
): Uint8Array {
  return Buffer.from(`${JSON.stringify({
    protocol_version: "1",
    turn_id: turnId,
    root_issue_id: "root-1",
    sequence,
    occurred_at: "2026-07-17T00:00:01Z",
    body,
  })}\n`);
}

function planCommand(turnId: string): JsonRecord {
  return {
    protocol_version: "1",
    turn_id: turnId,
    turn_kind: "plan",
    root_issue_id: "root-1",
    performer_profile_id: "profile-1",
    codex_turn_settings: {
      model: "gpt-5",
      reasoning_effort: "high",
      is_fast_mode_enabled: true,
    },
    turn_input_hash: "hash-1",
    workspace_root: "/bounded/worktree",
    started_at: "2026-07-17T00:00:00Z",
    hard_deadline_at: "2026-07-17T00:10:00Z",
    body: {
      root_issue: { title: "Root", description: "Build V1" },
      current_tree: [],
    },
  };
}

function planResult(turnId: string): JsonRecord {
  return {
    protocol_version: "1",
    turn_id: turnId,
    turn_kind: "plan",
    result_kind: "plan_ready",
    root_issue_id: "root-1",
    performer_profile_id: "profile-1",
    performer_id: "conversation-1",
    turn_input_hash: "hash-1",
    completed_at: "2026-07-17T00:01:00Z",
    body: { summary: "Plan", nodes: [] },
  };
}

function failedResult(turnId: string): JsonRecord {
  return {
    protocol_version: "1",
    turn_id: turnId,
    turn_kind: "plan",
    result_kind: "turn_failed",
    root_issue_id: "root-1",
    performer_profile_id: "profile-1",
    turn_input_hash: "hash-1",
    completed_at: "2026-07-17T00:01:00Z",
    body: {
      error_code: "provider_turn_failed",
      sanitized_reason: "Retryable provider failure.",
      retryable: true,
      action_required: "Retry the Turn.",
    },
  };
}
