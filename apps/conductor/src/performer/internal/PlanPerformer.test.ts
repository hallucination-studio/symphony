import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, readdir } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";

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
  parsePlanRequest,
  type PlanRequest,
  type PlanRequestTarget,
} from "../api/StagePerformerInterface.js";
import { PlanPerformer } from "./PlanPerformer.js";

interface FakeAppServer extends SpawnedCodexProcess {
  readonly input: PassThrough;
  readonly output: PassThrough;
  send(message: Record<string, unknown>): void;
}

function fakeAppServer(
  handle: (message: Record<string, unknown>, server: FakeAppServer) => void,
): {
  readonly spawner: CodexSpawner;
  readonly requests: Record<string, unknown>[];
  readonly launch: () => CodexProcessLaunch | undefined;
} {
  const requests: Record<string, unknown>[] = [];
  let capturedLaunch: CodexProcessLaunch | undefined;
  const spawner: CodexSpawner = (_options, launch) => {
    capturedLaunch = launch;
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    let running = true;
    events.once("exit", () => { running = false; });
    const decoder = new JsonlFrameDecoder();
    const server: FakeAppServer = {
      stdin: input,
      stdout: output,
      stderr,
      events,
      input,
      output,
      isRunning: () => running,
      kill: () => {
        queueMicrotask(() => events.emit("exit", 0, null));
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
        if (message.method === "config/read") {
          server.send({ id: message.id, result: { config: policy?.expectedConfig, origins: {} } });
        } else if (message.method === "remoteControl/status/read") {
          server.send({
            id: message.id,
            result: {
              status: "disabled",
              serverName: "symphony-plan-test",
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
        } else {
          handle(message, server);
        }
      }
    });
    return server;
  };
  return { spawner, requests, launch: () => capturedLaunch };
}

function initialize(message: Record<string, unknown>, server: FakeAppServer): boolean {
  if (message.method !== "initialize") return false;
  server.send({
    id: message.id,
    result: {
      codexHome: "/tmp/performer-home",
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "symphony/0.146.0 (Mac OS; arm64)",
    },
  });
  return true;
}

const target: PlanRequestTarget = Object.freeze({
  root_id: parseRootIssueId("LIN-ROOT"),
  runtime_generation: parseRuntimeGeneration(7),
  cycle_id: parseCycleIssueId("LIN-CYCLE"),
  cycle_revision: parseTaskRevision("revision:cycle:approved"),
});

const rootAdrMarkdown = "## Root ADR\n\nKeep every semantic decision in the sealed Cycle.";
const cycleDescriptionMarkdown = [
  "## Root Definition Revision",
  "",
  "`revision:root:approved`",
  "",
  "## Requirement",
  "",
  "Compile the approved design into one execution graph.",
  "",
  "## Domain Knowledge",
  "",
  "Local Plan keys are not Task Manager identities.",
  "",
  rootAdrMarkdown,
  "",
  "## Acceptance",
  "",
  "- Plan receives only sealed Markdown.",
  "- Every acceptance criterion maps to Work and Verify evidence.",
  "",
  "## Architecture",
  "",
  "Conductor owns materialization; Plan only compiles the design.",
  "",
  "## Feature Design",
  "",
  "Return a complete Work DAG and Verify intent.",
  "",
  "## Code Design",
  "",
  "Use the canonical Plan graph contract without repository access.",
  "",
  "## Boundaries",
  "",
  "Do not mutate Task Manager or invent provider identities.",
  "",
  "## Acceptance Mapping",
  "",
  "Map both criteria to local Work keys and Verify evidence.",
  "",
  "## Failure Strategy",
  "",
  "Return failed when the sealed design cannot be compiled without invention.",
].join("\n");

const request: PlanRequest = parsePlanRequest({
  schema_version: 1,
  ...target,
  correlation_id: "corr:plan:7",
  cycle_description_markdown: cycleDescriptionMarkdown.replace(
    "Compile the approved design",
    "Compile the approved $linear plugin://task-provider design",
  ),
  root_adr_markdown: rootAdrMarkdown,
  approved_work_groups: [{
    work_group_id: "plan-boundary",
    depends_on_work_group_ids: [],
  }],
}, target);

const completedModelOutput = {
  outcome: "completed",
  ordered_work_group_ids: ["plan-boundary"],
  sanitized_reason: null,
};

const completed = {
  schema_version: 1,
  ...target,
  correlation_id: request.correlation_id,
  ...completedModelOutput,
};

function performerOptions(spawner: CodexSpawner) {
  return {
    executable: "codex",
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    apiKey: "codex-secret-never-prompt",
    baseUrl: "https://api.openai.com/v1",
    model: "codex-test",
    turnTimeoutMs: 2_000,
    spawner,
  };
}

function performerInput() {
  return {
    ...target,
    performer_home: "/tmp/performer-home",
  };
}

function completeTurn(
  server: FakeAppServer,
  output: unknown = completedModelOutput,
  status: "completed" | "interrupted" | "failed" = "completed",
): void {
  server.send({
    method: "turn/completed",
    params: {
      threadId: "thread-plan",
      turn: status === "completed"
        ? {
            id: "turn-plan",
            status,
            error: null,
            items: [{ id: "answer", type: "agentMessage", text: JSON.stringify(output) }],
          }
        : { id: "turn-plan", status, error: null, items: [] },
    },
  });
}

function assertNoPlanOrder(result: Awaited<ReturnType<PlanPerformer["plan"]>>): void {
  assert.deepEqual(result.ordered_work_group_ids, []);
}

test("Plan performer exposes a tool-free Markdown compiler with no code mount or identity context", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (initialize(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-plan" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-plan" } } });
      server.send({
        method: "turn/started",
        params: {
          threadId: "thread-plan",
          turn: { id: "turn-plan", status: "inProgress", items: [], error: null },
        },
      });
      completeTurn(server);
    }
  });
  const performer = await PlanPerformer.create(performerInput(), performerOptions(appServer.spawner));
  let planWorkspace = "";
  try {
    assert.deepEqual(await performer.plan(request), completed);
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

    const threadStart = appServer.requests.find(({ method }) => method === "thread/start");
    const threadParams = threadStart?.params as Record<string, unknown>;
    const policy = appServer.launch()?.localOnly;
    assert.ok(policy);
    planWorkspace = policy.workspaceRoot;
    assert.notEqual(planWorkspace, "/tmp/root-repository");
    assert.notEqual(planWorkspace, "/tmp/performer-home");
    assert.deepEqual(await readdir(planWorkspace), []);
    assert.equal(threadParams.sandbox, undefined);
    assert.equal(threadParams.permissions, policy.readPermissionProfile);
    assert.deepEqual(threadParams.dynamicTools, []);
    assert.equal(threadParams.ephemeral, true);
    assert.deepEqual(threadParams.environments, [{
      environmentId: "local",
      cwd: planWorkspace,
      runtimeWorkspaceRoots: [planWorkspace],
    }]);
    assert.deepEqual(threadParams.runtimeWorkspaceRoots, [planWorkspace]);
    assert.deepEqual(threadParams.selectedCapabilityRoots, []);
    const config = threadParams.config as { readonly features?: Record<string, boolean> };
    assert.ok(Object.values(config.features ?? {}).every((enabled) => enabled === false));

    const turnStart = appServer.requests.find(({ method }) => method === "turn/start");
    const turnParams = turnStart?.params as {
      readonly input: readonly [{ readonly text: string }];
      readonly permissions: unknown;
      readonly sandboxPolicy?: unknown;
      readonly outputSchema: Record<string, unknown>;
    };
    assert.equal(turnParams.sandboxPolicy, undefined);
    assert.equal(turnParams.permissions, policy.readPermissionProfile);
    const promptText = turnParams.input[0].text;
    const prompt = JSON.parse(promptText) as Record<string, unknown>;
    assert.deepEqual(Object.keys(prompt).sort(), ["context", "instruction", "role"]);
    assert.equal(prompt.role, "Plan");
    assert.deepEqual(prompt.context, {
      cycle_description_markdown: request.cycle_description_markdown,
      root_adr_markdown: request.root_adr_markdown,
      approved_work_groups: request.approved_work_groups,
    });
    assert.equal(promptText.includes("$linear"), false);
    assert.equal(promptText.includes("plugin://"), false);
    for (const forbidden of [
      "codex-secret-never-prompt",
      "/tmp/performer-home",
      planWorkspace,
      "LINEAR_API_KEY",
      "authorization",
      request.root_id,
      request.cycle_id,
      request.cycle_revision,
      request.correlation_id,
    ]) assert.equal(promptText.toLowerCase().includes(forbidden.toLowerCase()), false);

    const instruction = String(prompt.instruction);
    for (const required of [
      "already-approved Work groups",
      "Every dependency",
      "outcome failed",
      "do not ask to revise",
      "do not invent",
    ]) assert.equal(instruction.includes(required), true, required);

    const schemaText = JSON.stringify(turnParams.outputSchema);
    for (const forbidden of [
      "root_id", "runtime_generation", "cycle_id", "cycle_revision", "correlation_id",
      "issue_id", "relation_id", "provider_receipt", "claimed_effects",
    ]) {
      assert.equal(schemaText.includes(`"${forbidden}":`), false);
    }
    const properties = turnParams.outputSchema.properties as Record<string, { readonly const?: unknown }>;
    assert.deepEqual(Object.keys(properties).sort(), [
      "ordered_work_group_ids",
      "outcome",
      "sanitized_reason",
    ]);
  } finally {
    await performer.close();
  }
  await assert.rejects(lstat(planWorkspace), { code: "ENOENT" });
});

test("Plan performer preserves a valid failed outcome when the sealed design is insufficient", async () => {
  const failedModelOutput = {
    outcome: "failed",
    ordered_work_group_ids: [],
    sanitized_reason: "Sealed design is insufficient to compile without inventing architecture",
  };
  const appServer = fakeAppServer((message, server) => {
    if (initialize(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-plan" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-plan" } } });
      completeTurn(server, failedModelOutput);
    }
  });
  const performer = await PlanPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
    const result = await performer.plan(request);
    assert.deepEqual(result, {
      schema_version: 1,
      ...target,
      correlation_id: request.correlation_id,
      ...failedModelOutput,
    });
    assertNoPlanOrder(result);
  } finally {
    await performer.close();
  }
});

test("Plan performer denies an unsolicited tool call and returns no graph", async () => {
  let denial: { readonly success?: boolean; readonly text?: string } | undefined;
  const appServer = fakeAppServer((message, server) => {
    if (initialize(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-plan" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-plan" } } });
      server.send({
        id: "tool-request",
        method: "item/tool/call",
        params: {
          threadId: "thread-plan",
          turnId: "turn-plan",
          callId: "call:create-issue",
          tool: "create_issue",
          arguments: { title: "Must never execute" },
        },
      });
      server.send({
        method: "turn/started",
        params: {
          threadId: "thread-plan",
          turn: { id: "turn-plan", status: "inProgress", items: [], error: null },
        },
      });
    } else if (message.id === "tool-request") {
      const result = message.result as {
        readonly success: boolean;
        readonly contentItems: readonly [{ readonly text: string }];
      };
      denial = { success: result.success, text: result.contentItems[0].text };
      setImmediate(() => completeTurn(server));
    }
  });
  const performer = await PlanPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
    const result = await performer.plan(request);
    assert.deepEqual(denial, { success: false, text: "capability_denied" });
    assert.equal(result.outcome, "failed");
    assertNoPlanOrder(result);
    assert.equal(result.sanitized_reason, "Plan requested an unavailable capability");
    assert.equal(appServer.requests.some(({ method }) => method === "task/create"), false);
  } finally {
    await performer.close();
  }
});

test("Plan performer converts invalid model output into a sanitized failed result", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (initialize(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-plan" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-plan" } } });
      completeTurn(server, { ...completedModelOutput, provider_receipt: "raw-secret-receipt" });
    }
  });
  const performer = await PlanPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
    const result = await performer.plan(request);
    assert.equal(result.outcome, "failed");
    assert.equal(result.sanitized_reason, "Plan returned an invalid Work group order");
    assert.equal(JSON.stringify(result).includes("raw-secret-receipt"), false);
    assertNoPlanOrder(result);
  } finally {
    await performer.close();
  }
});

test("Plan performer rejects envelope identity claimed by model output", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (initialize(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-plan" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-plan" } } });
      completeTurn(server, { ...completedModelOutput, cycle_id: "LIN-CLAIMED" });
    }
  });
  const performer = await PlanPerformer.create(performerInput(), performerOptions(appServer.spawner));
  try {
    const result = await performer.plan(request);
    assert.equal(result.outcome, "failed");
    assert.equal(result.sanitized_reason, "Plan returned an invalid Work group order");
    assertNoPlanOrder(result);
  } finally {
    await performer.close();
  }
});

test("Plan performer maps interrupted and failed turns to non-actionable results", async () => {
  for (const status of ["interrupted", "failed"] as const) {
    const appServer = fakeAppServer((message, server) => {
      if (initialize(message, server) || message.method === "initialized") return;
      if (message.method === "thread/start") {
        server.send({ id: message.id, result: { thread: { id: "thread-plan" } } });
      } else if (message.method === "turn/start") {
        server.send({ id: message.id, result: { turn: { id: "turn-plan" } } });
        completeTurn(server, undefined, status);
      }
    });
    const performer = await PlanPerformer.create(performerInput(), performerOptions(appServer.spawner));
    try {
      const result = await performer.plan(request);
      assert.equal(result.outcome, status === "interrupted" ? "canceled" : "failed");
      assertNoPlanOrder(result);
    } finally {
      await performer.close();
    }
  }
});

test("closing an active Plan performer returns a non-actionable canceled result", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (initialize(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-plan" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-plan" } } });
      server.send({
        method: "turn/started",
        params: {
          threadId: "thread-plan",
          turn: { id: "turn-plan", status: "inProgress", items: [], error: null },
        },
      });
    } else if (message.method === "turn/interrupt") {
      server.send({ id: message.id, result: {} });
    }
  });
  const performer = await PlanPerformer.create(performerInput(), performerOptions(appServer.spawner));
  const active = performer.plan(request);
  await new Promise((resolve) => setImmediate(resolve));
  const closing = performer.close();
  const result = await active;
  await closing;

  assert.equal(result.outcome, "canceled");
  assertNoPlanOrder(result);
  assert.equal(appServer.requests.some(({ method }) => method === "turn/interrupt"), true);
});

test("a timed-out Plan turn is interrupted and returns no actionable graph", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (initialize(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-plan" } } });
    } else if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-plan" } } });
      server.send({
        method: "turn/started",
        params: {
          threadId: "thread-plan",
          turn: { id: "turn-plan", status: "inProgress", items: [], error: null },
        },
      });
    } else if (message.method === "turn/interrupt") {
      server.send({ id: message.id, result: {} });
      completeTurn(server, undefined, "interrupted");
    }
  });
  const performer = await PlanPerformer.create(
    performerInput(),
    { ...performerOptions(appServer.spawner), turnTimeoutMs: 10 },
  );
  try {
    const result = await performer.plan(request);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.outcome, "failed");
    assert.equal(result.sanitized_reason, "Plan generation exceeded its time budget");
    assertNoPlanOrder(result);
    assert.equal(appServer.requests.some(({ method }) => method === "turn/interrupt"), true);
  } finally {
    await performer.close();
  }
});

test("Plan performer removes its empty workspace when process startup fails", async () => {
  let planWorkspace = "";
  const spawner: CodexSpawner = (_options, launch) => {
    planWorkspace = launch.localOnly?.workspaceRoot ?? "";
    throw new Error("spawn failed");
  };

  await assert.rejects(
    PlanPerformer.create(performerInput(), performerOptions(spawner)),
    /plan_performer_creation_failed/u,
  );
  assert.notEqual(planWorkspace, "");
  await assert.rejects(lstat(planWorkspace), { code: "ENOENT" });
});

test("Plan performer preserves a process termination failure while removing its workspace", async () => {
  let planWorkspace = "";
  const spawner: CodexSpawner = (_options, launch) => {
    planWorkspace = launch.localOnly?.workspaceRoot ?? "";
    throw new Error("codex_process_termination_failed");
  };

  await assert.rejects(
    PlanPerformer.create(performerInput(), performerOptions(spawner)),
    /plan_performer_termination_failed/u,
  );
  assert.notEqual(planWorkspace, "");
  await assert.rejects(lstat(planWorkspace), { code: "ENOENT" });
});

test("Plan performer removes its empty workspace when thread creation fails", async () => {
  const appServer = fakeAppServer((message, server) => {
    if (initialize(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "" } } });
    }
  });

  await assert.rejects(
    PlanPerformer.create(performerInput(), performerOptions(appServer.spawner)),
    /plan_performer_creation_failed/u,
  );
  const planWorkspace = appServer.launch()?.localOnly?.workspaceRoot ?? "";
  assert.notEqual(planWorkspace, "");
  await assert.rejects(lstat(planWorkspace), { code: "ENOENT" });
});
