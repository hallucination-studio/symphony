import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
} from "../../contracts/identity.js";
import type { WorkHandoff, WorkRequest } from "../../contracts/stage-interaction.js";
import {
  CodexWorkSessionFactory,
  WorkPerformer,
  type WorkSessionFactory,
} from "./WorkPerformer.js";
import type { CodexProcessOptions } from "../../codex-app-server/internal/CodexProcess.js";

function request(root: string, cycle: string, work: string, correlation: string): WorkRequest {
  return {
    schema_version: 1,
    root_id: parseRootIssueId(root),
    runtime_generation: parseRuntimeGeneration(3),
    correlation_id: parseCorrelationId(correlation),
    cycle_issue_id: parseCycleIssueId(cycle),
    role: "work",
    work_issue_id: parseStageIssueId(work),
  };
}

function handoff(input: WorkRequest, outcome: WorkHandoff["outcome"] = "completed"): WorkHandoff {
  return { ...input, outcome, workspace_changed: true };
}

test("WorkPerformer reuses one Cycle session for distinct Work turns and isolates other Cycles and Roots", async () => {
  const starts: WorkRequest[] = [];
  const turns: Array<{ correlation: string; prompt: string; schema: Readonly<Record<string, unknown>> }> = [];
  const factory: WorkSessionFactory = {
    start: (first) => {
      starts.push(first);
      return Promise.resolve({
        threadId: `thread-${starts.length}`,
        turn: (prompt, correlation, schema) => {
          turns.push({ correlation, prompt, schema });
          const work = prompt.match(/Work (LIN-\d+)/u)?.[1];
          const current = [first, request(first.root_id, first.cycle_issue_id, work ?? "missing", correlation)]
            .find((candidate) => candidate.work_issue_id === work && candidate.correlation_id === correlation);
          assert.ok(current);
          return Promise.resolve({ status: "completed", output: handoff(current) });
        },
        close: () => Promise.resolve(),
      });
    },
  };
  const performer = new WorkPerformer(factory);
  const first = request("LIN-1", "LIN-2", "LIN-3", "work:1");
  const second = request("LIN-1", "LIN-2", "LIN-4", "work:2");
  const otherCycle = request("LIN-1", "LIN-5", "LIN-6", "work:3");
  const otherRoot = request("LIN-7", "LIN-8", "LIN-9", "work:4");

  await performer.executeWork(first);
  await performer.executeWork(second);
  await performer.executeWork(otherCycle);
  await performer.executeWork(otherRoot);

  assert.deepEqual(starts, [first, otherCycle, otherRoot]);
  assert.deepEqual(turns.map(({ correlation }) => correlation), ["work:1", "work:2", "work:3", "work:4"]);
  assert.match(turns[0]?.prompt ?? "", /Root LIN-1.*Cycle LIN-2.*Work LIN-3/su);
  assert.match(turns[0]?.prompt ?? "", /Root worktree/u);
  assert.match(turns[0]?.prompt ?? "", /focused checks/u);
  assert.match(turns[0]?.prompt ?? "", /update and read back only Work Issue LIN-3/u);
  assert.match(turns[0]?.prompt ?? "", /must not modify the Work DAG, commit, push, or create a PR/u);
  assert.equal(turns[0]?.schema.additionalProperties, false);
  assert.deepEqual([...(turns[0]?.schema.required as readonly string[])].sort(), [
    "correlation_id", "cycle_issue_id", "outcome", "role", "root_id", "runtime_generation",
    "schema_version", "work_issue_id", "workspace_changed",
  ].sort());
});

test("WorkPerformer rejects concurrent and repeated Work turns and permanently fences that Cycle", async () => {
  let release: ((value: { status: "completed"; output: WorkHandoff }) => void) | undefined;
  let closed = 0;
  const first = request("LIN-1", "LIN-2", "LIN-3", "work:1");
  const factory: WorkSessionFactory = {
    start: () => Promise.resolve({
      threadId: "thread-1",
      turn: () => new Promise((resolve) => { release = resolve; }),
      close: () => { closed += 1; return Promise.resolve(); },
    }),
  };
  const performer = new WorkPerformer(factory);
  const active = performer.executeWork(first);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(performer.executeWork(request("LIN-1", "LIN-2", "LIN-4", "work:2")), /work_turn_already_active/u);
  assert.ok(release);
  release({ status: "completed", output: handoff(first) });
  await active;
  await assert.rejects(performer.executeWork(first), /work_item_already_executed/u);
  assert.equal(closed, 1);
  await assert.rejects(performer.executeWork(request("LIN-1", "LIN-2", "LIN-4", "work:2")), /work_cycle_closed/u);
});

test("WorkPerformer closes and tombstones a Cycle after unsafe turn or handoff results", async () => {
  const cases: ReadonlyArray<{ name: string; result?: unknown; error?: Error }> = [
    { name: "failed turn", result: { status: "failed" } },
    { name: "interrupted turn", result: { status: "interrupted" } },
    { name: "timeout", error: new Error("codex_turn_timed_out") },
    { name: "malformed", result: { status: "completed", output: "done" } },
    { name: "foreign", result: { status: "completed", output: { ...handoff(request("LIN-9", "LIN-2", "LIN-3", "work:1")) } } },
  ];
  for (const [index, entry] of cases.entries()) {
    let closed = 0;
    const current = request("LIN-1", `LIN-${index + 20}`, "LIN-3", `work:${index}`);
    const performer = new WorkPerformer({
      start: () => Promise.resolve({
        threadId: `thread-${entry.name}`,
        turn: () => entry.error ? Promise.reject(entry.error) : Promise.resolve(entry.result as never),
        close: () => { closed += 1; return Promise.resolve(); },
      }),
    });
    await assert.rejects(performer.executeWork(current));
    assert.equal(closed, 1, entry.name);
    await assert.rejects(performer.executeWork(current), /work_cycle_closed/u);
  }
});

test("WorkPerformer returns terminal Work handoffs only after releasing authority, and closeCycle is idempotent", async () => {
  for (const outcome of ["failed", "canceled"] as const) {
    let closed = 0;
    const current = request("LIN-1", outcome === "failed" ? "LIN-20" : "LIN-21", "LIN-3", `work:${outcome}`);
    const performer = new WorkPerformer({
      start: () => Promise.resolve({
        threadId: `thread-${outcome}`,
        turn: () => Promise.resolve({ status: "completed", output: handoff(current, outcome) }),
        close: () => { closed += 1; return Promise.resolve(); },
      }),
    });
    assert.equal((await performer.executeWork(current)).outcome, outcome);
    assert.equal(closed, 1);
    await assert.rejects(performer.executeWork(current), /work_cycle_closed/u);
  }

  let closed = 0;
  const current = request("LIN-1", "LIN-30", "LIN-3", "work:close");
  const performer = new WorkPerformer({
    start: () => Promise.resolve({
      threadId: "thread-close",
      turn: () => Promise.resolve({ status: "completed", output: handoff(current) }),
      close: () => { closed += 1; return Promise.resolve(); },
    }),
  });
  await performer.executeWork(current);
  await performer.closeCycle(current.root_id, current.cycle_issue_id);
  await performer.closeCycle(current.root_id, current.cycle_issue_id);
  assert.equal(closed, 1);
  await assert.rejects(performer.executeWork(request("LIN-1", "LIN-30", "LIN-4", "work:later")), /work_cycle_closed/u);
});

test("Codex Work session binds the request to one real Root worktree and the Performer Home", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-work-session-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const received: CodexProcessOptions[] = [];
  const current = request("LIN-1", "LIN-2", "LIN-3", "work:1");
  const factory = new CodexWorkSessionFactory({
    executable: "/opt/codex",
    performerHome: "/performer/home",
    worktreePath: () => Promise.resolve(directory),
    startupTimeoutMs: 1,
    requestTimeoutMs: 1,
    turnTimeoutMs: 1,
    shutdownTimeoutMs: 1,
    networkAccess: true,
    spawner: (options) => {
      received.push(options);
      throw new Error("controlled_spawn_stop");
    },
  });

  await assert.rejects(factory.start(current), /controlled_spawn_stop/u);
  assert.equal(received[0]?.codexHome, "/performer/home");
  assert.equal(received[0]?.rootId, current.root_id);
  assert.equal(received[0]?.runtimeGeneration, current.runtime_generation);

  const relative = new CodexWorkSessionFactory({
    executable: "/opt/codex",
    performerHome: "/performer/home",
    worktreePath: () => Promise.resolve("relative/worktree"),
    startupTimeoutMs: 1,
    requestTimeoutMs: 1,
    turnTimeoutMs: 1,
    shutdownTimeoutMs: 1,
    networkAccess: false,
  });
  await assert.rejects(relative.start(current), /worktree_path_not_absolute/u);
});
