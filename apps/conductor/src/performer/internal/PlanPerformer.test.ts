import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../../contracts/identity.js";
import type { PlanRequest } from "../../contracts/stage-interaction.js";
import {
  CodexPlanSessionFactory,
  PlanPerformer,
  type PlanSession,
  type PlanSessionFactory,
} from "./PlanPerformer.js";
import type { CodexProcessOptions } from "../../codex-app-server/internal/CodexProcess.js";

const request: PlanRequest = {
  schema_version: 1,
  root_id: parseRootIssueId("LIN-1"),
  runtime_generation: parseRuntimeGeneration(3),
  correlation_id: parseCorrelationId("plan:1"),
  cycle_issue_id: parseCycleIssueId("LIN-2"),
  role: "plan",
};

test("PlanPerformer uses one isolated session and a closed PlanHandoff schema", async () => {
  const events: string[] = [];
  let prompt = "";
  let schema: Readonly<Record<string, unknown>> | undefined;
  const session: PlanSession = {
    turn: (input, outputSchema) => {
      events.push("turn");
      prompt = input;
      schema = outputSchema;
      return Promise.resolve({
        status: "completed",
        output: {
          ...request,
          plan_issue_id: "LIN-3",
          work_issue_ids: ["LIN-4", "LIN-5"],
          verify_issue_id: "LIN-6",
          outcome: "completed",
        },
      });
    },
    close: () => { events.push("close"); return Promise.resolve(); },
  };
  const factory: PlanSessionFactory = {
    start: (received) => {
      events.push("start");
      assert.deepEqual(received, request);
      return Promise.resolve(session);
    },
  };

  const handoff = await new PlanPerformer(factory).executePlan(request);

  assert.deepEqual(events, ["start", "turn", "close"]);
  assert.equal(handoff.role, "plan");
  assert.equal(handoff.outcome, "completed");
  assert.match(prompt, /Root LIN-1/u);
  assert.match(prompt, /Cycle LIN-2/u);
  assert.equal(prompt.includes("token"), false);
  assert.equal(prompt.includes("credential"), false);
  assert.deepEqual([...(schema?.required as readonly string[])].sort(), [
    "correlation_id", "cycle_issue_id", "outcome", "plan_issue_id", "role",
    "root_id", "runtime_generation", "schema_version", "verify_issue_id", "work_issue_ids",
  ].sort());
  assert.equal(schema?.additionalProperties, false);
});

test("PlanPerformer closes the isolated session and fails closed on non-completed turns", async () => {
  for (const status of ["failed", "interrupted"] as const) {
    let closed = false;
    const factory: PlanSessionFactory = {
      start: () => Promise.resolve({
        turn: () => Promise.resolve({ status }),
        close: () => { closed = true; return Promise.resolve(); },
      }),
    };
    await assert.rejects(new PlanPerformer(factory).executePlan(request), /plan_turn_not_completed/u);
    assert.equal(closed, true);
  }
});

test("PlanPerformer rejects prose and foreign structured output without repairing it", async () => {
  for (const output of [
    "Plan LIN-3 then do LIN-4",
    { ...request, root_id: "LIN-9", plan_issue_id: "LIN-3", work_issue_ids: ["LIN-4"], verify_issue_id: "LIN-5", outcome: "completed" },
  ]) {
    const factory: PlanSessionFactory = {
      start: () => Promise.resolve({
        turn: () => Promise.resolve({ status: "completed", output }),
        close: () => Promise.resolve(),
      }),
    };
    await assert.rejects(new PlanPerformer(factory).executePlan(request));
  }
});

test("Codex Plan session binds the request to the user-supplied Performer Home", async () => {
  const received: CodexProcessOptions[] = [];
  const factory = new CodexPlanSessionFactory({
    executable: "/opt/codex",
    performerHome: "/performer/home",
    cwd: "/repository",
    startupTimeoutMs: 1,
    requestTimeoutMs: 1,
    turnTimeoutMs: 1,
    shutdownTimeoutMs: 1,
    apiKey: "test-api-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5",
    spawner: (options) => {
      received.push(options);
      throw new Error("controlled_spawn_stop");
    },
  });

  await assert.rejects(factory.start(request), /controlled_spawn_stop/u);
  assert.equal(received[0]?.codexHome, "/performer/home");
  assert.equal(received[0]?.rootId, request.root_id);
  assert.equal(received[0]?.runtimeGeneration, request.runtime_generation);
});
