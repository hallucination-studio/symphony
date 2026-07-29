import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
} from "../../contracts/identity.js";
import type { VerifyRequest } from "../../contracts/stage-interaction.js";
import {
  CodexVerifySessionFactory,
  VerifyPerformer,
  type VerifySessionFactory,
} from "./VerifyPerformer.js";
import type { CodexProcessOptions } from "../../codex-app-server/internal/CodexProcess.js";

const request: VerifyRequest = {
  schema_version: 1,
  root_id: parseRootIssueId("LIN-1"),
  runtime_generation: parseRuntimeGeneration(3),
  correlation_id: parseCorrelationId("verify:1"),
  cycle_issue_id: parseCycleIssueId("LIN-2"),
  role: "verify",
  verify_issue_id: parseStageIssueId("LIN-6"),
  revision: parseRevision("a".repeat(40)),
};

test("VerifyPerformer checks one exact revision in one isolated session", async () => {
  const events: string[] = [];
  let prompt = "";
  let schema: Readonly<Record<string, unknown>> | undefined;
  const sessions: VerifySessionFactory = {
    start: () => Promise.resolve({
      turn: (input, outputSchema) => {
        events.push("turn");
        prompt = input;
        schema = outputSchema;
        return Promise.resolve({ status: "completed", output: { ...request, conclusion: "passed" } });
      },
      close: () => { events.push("close"); return Promise.resolve(); },
    }),
  };

  const handoff = await new VerifyPerformer(sessions).executeVerify(request);

  assert.equal(handoff.conclusion, "passed");
  assert.deepEqual(events, ["turn", "close"]);
  assert.match(prompt, new RegExp(request.revision, "u"));
  assert.match(prompt, /read-only/u);
  assert.match(prompt, /must not modify or repair/u);
  assert.equal(schema?.additionalProperties, false);
  assert.deepEqual([...(schema?.required as readonly string[])].sort(), [
    "schema_version", "root_id", "runtime_generation", "correlation_id", "cycle_issue_id",
    "role", "verify_issue_id", "revision", "conclusion",
  ].sort());
});

test("VerifyPerformer closes its session and rejects incomplete or foreign output", async () => {
  for (const result of [
    { status: "interrupted" as const },
    { status: "failed" as const },
    { status: "completed" as const, output: { ...request, revision: "b".repeat(40), conclusion: "passed" } },
  ]) {
    let closed = false;
    const sessions: VerifySessionFactory = {
      start: () => Promise.resolve({
        turn: () => Promise.resolve(result),
        close: () => { closed = true; return Promise.resolve(); },
      }),
    };
    await assert.rejects(new VerifyPerformer(sessions).executeVerify(request));
    assert.equal(closed, true);
  }
});

test("Codex Verify session binds the read-only turn to the exact Root worktree and Performer Home", async () => {
  const received: CodexProcessOptions[] = [];
  const factory = new CodexVerifySessionFactory({
    executable: "/opt/codex",
    performerHome: "/performer/home",
    worktreePath: () => Promise.resolve(process.cwd()),
    startupTimeoutMs: 1,
    requestTimeoutMs: 1,
    turnTimeoutMs: 1,
    shutdownTimeoutMs: 1,
    spawner: (options) => {
      received.push(options);
      throw new Error("controlled_spawn_stop");
    },
  });

  await assert.rejects(factory.start(request), /controlled_spawn_stop/u);
  assert.equal(received[0]?.codexHome, "/performer/home");
  assert.equal(received[0]?.rootId, request.root_id);
});
