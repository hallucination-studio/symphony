import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseCorrelationId,
  parseObservationDigest,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseThreadId,
} from "../../contracts/identity.js";
import type { RootBootstrap, RootObservationDiff } from "../../contracts/observation.js";
import { RootContinuityStore } from "./RootContinuityStore.js";
import {
  RootReconcillFactory,
  type RootTurnTransport,
  type RootTurnTransportFactory,
} from "./RootReconcill.js";

function bootstrap(root = "LIN-1", generation = 1, correlation = "boot:1"): RootBootstrap {
  return {
    schema_version: 1,
    root_id: parseRootIssueId(root),
    runtime_generation: parseRuntimeGeneration(generation),
    correlation_id: parseCorrelationId(correlation),
    observed_at: "2026-07-29T00:00:00.000Z",
    linear: { root_id: parseRootIssueId(root), root_status: "Todo", active_cycle: null },
    git: {
      repository_id: "repo:1" as never,
      base_branch: "main",
      head_branch: `symphony/${root}`,
      head_revision: null,
      workspace_state: "clean",
      diff_digest: parseObservationDigest("diff:clean"),
      pull_request: null,
    },
  };
}

function diff(from: string, to: string, generation = 1, correlation = "diff:1"): RootObservationDiff {
  return {
    schema_version: 1,
    root_id: parseRootIssueId("LIN-1"),
    runtime_generation: parseRuntimeGeneration(generation),
    correlation_id: parseCorrelationId(correlation),
    from_observation_digest: parseObservationDigest(from),
    to_observation_digest: parseObservationDigest(to),
    changed_linear_facts: [{ kind: "root_status_changed", before: "Todo", after: "In Progress" }],
    changed_git_facts: [],
  };
}

class FakeTransport implements RootTurnTransport {
  readonly inputs: Array<{ input: string; schema: Record<string, unknown> }> = [];
  closed = false;

  constructor(readonly threadId: ReturnType<typeof parseThreadId>, private readonly outputs: unknown[]) {}

  async turn(input: string, _correlation: ReturnType<typeof parseCorrelationId>, schema: Record<string, unknown>) {
    this.inputs.push({ input, schema });
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    return output;
  }

  async close() { this.closed = true; }
}

class FakeTransportFactory implements RootTurnTransportFactory {
  readonly created: FakeTransport[] = [];
  readonly outputs: unknown[][] = [];

  async create() {
    const transport = new FakeTransport(parseThreadId(`thread:${this.created.length + 1}`), this.outputs.shift() ?? []);
    this.created.push(transport);
    return transport;
  }
}

function decision(root = "LIN-1", generation = 1, correlation = "boot:1") {
  return {
    schema_version: 1,
    root_id: root,
    runtime_generation: generation,
    correlation_id: correlation,
    kind: "decision",
    decision: "Wait",
    reason: "No ready work",
  };
}

async function fixture() {
  const rootHome = await mkdtemp(path.join(os.tmpdir(), "symphony-reconcill-"));
  await mkdir(path.join(rootHome, "symphony"));
  const transports = new FakeTransportFactory();
  const factory = new RootReconcillFactory(transports);
  return { rootHome, transports, factory };
}

test("first turn is a complete bootstrap and only an adjacent accepted diff may follow", async () => {
  const f = await fixture();
  f.transports.outputs.push([decision(), decision("LIN-1", 1, "diff:1")]);
  const root = await f.factory.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1), root_home: f.rootHome,
  });
  await assert.rejects(root.advance(diff("sha256:unaccepted", "sha256:next")), /root_bootstrap_required/u);
  await root.bootstrap(bootstrap());
  const state = await new RootContinuityStore(f.rootHome).load();
  assert.match(state.accepted_observation_digest, /^sha256:[0-9a-f]{64}$/u);
  await root.advance(diff(state.accepted_observation_digest, "sha256:next"));
  assert.equal((await new RootContinuityStore(f.rootHome).load()).accepted_observation_digest, "sha256:next");
  assert.equal(JSON.parse(f.transports.created[0]?.inputs[0]?.input ?? "{}").kind, "RootBootstrap");
  assert.equal(JSON.parse(f.transports.created[0]?.inputs[1]?.input ?? "{}").kind, "RootObservationDiff");
  assert.ok(f.transports.created[0]?.inputs.every(({ schema }) => {
    const variants = schema.oneOf as Array<{ additionalProperties?: boolean }>;
    return variants.every(({ additionalProperties }) => additionalProperties === false);
  }));
});

test("identity, generation, correlation output, and diff continuity mismatches fail closed", async () => {
  const cases = [
    decision("LIN-2"),
    decision("LIN-1", 2),
    decision("LIN-1", 1, "other:1"),
    { unexpected: true },
  ];
  for (const output of cases) {
    const f = await fixture();
    f.transports.outputs.push([output]);
    const root = await f.factory.create({
      root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1), root_home: f.rootHome,
    });
    await assert.rejects(root.bootstrap(bootstrap()), /root_restart_required/u);
    await assert.rejects(root.bootstrap(bootstrap()), /root_restart_required/u);
    await assert.rejects(new RootContinuityStore(f.rootHome).load(), /unavailable/u);
    await root.close();
  }

  const f = await fixture();
  f.transports.outputs.push([decision()]);
  const root = await f.factory.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1), root_home: f.rootHome,
  });
  await root.bootstrap(bootstrap());
  await assert.rejects(root.advance(diff("sha256:wrong", "sha256:next")), /observation_discontinuity/u);
});

test("restart uses incremented generation, a new thread, and a fresh changed bootstrap", async () => {
  const f = await fixture();
  f.transports.outputs.push([decision()], [decision("LIN-1", 2, "boot:2")]);
  const first = await f.factory.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1), root_home: f.rootHome,
  });
  await first.bootstrap(bootstrap());
  await first.close();

  const restarted = await f.factory.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(2), root_home: f.rootHome,
  });
  const source = bootstrap("LIN-1", 2, "boot:2");
  const changed: RootBootstrap = {
    ...source,
    linear: { ...source.linear, root_status: "In Progress" },
  };
  await restarted.bootstrap(changed);
  const state = await new RootContinuityStore(f.rootHome).load();
  assert.equal(state.runtime_generation, 2);
  assert.equal(state.thread_id, "thread:2");
  assert.notEqual(f.transports.created[0], f.transports.created[1]);
  assert.equal(JSON.parse(f.transports.created[1]?.inputs[0]?.input ?? "{}").observation.linear.root_status, "In Progress");
});

test("failed restart bootstrap preserves the last accepted continuity and Roots never share transport", async () => {
  const f = await fixture();
  f.transports.outputs.push([decision()], [new Error("turn_failed")]);
  const first = await f.factory.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1), root_home: f.rootHome,
  });
  await first.bootstrap(bootstrap());
  const previous = await new RootContinuityStore(f.rootHome).load();
  await first.close();
  const restarted = await f.factory.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(2), root_home: f.rootHome,
  });
  await assert.rejects(restarted.bootstrap(bootstrap("LIN-1", 2, "boot:2")), /root_restart_required/u);
  assert.deepEqual(await new RootContinuityStore(f.rootHome).load(), previous);

  const otherHome = await mkdtemp(path.join(os.tmpdir(), "symphony-reconcill-other-"));
  await mkdir(path.join(otherHome, "symphony"));
  f.transports.outputs.push([decision("LIN-2", 1, "boot:other")]);
  const other = await f.factory.create({
    root_id: parseRootIssueId("LIN-2"), runtime_generation: parseRuntimeGeneration(1), root_home: otherHome,
  });
  await other.bootstrap(bootstrap("LIN-2", 1, "boot:other"));
  assert.notEqual(f.transports.created[1], f.transports.created[2]);
});

test("factory rejects generation gaps and mismatched continuity ownership", async () => {
  const f = await fixture();
  const store = new RootContinuityStore(f.rootHome);
  await store.write({
    schema_version: 1,
    root_id: parseRootIssueId("LIN-2"),
    runtime_generation: parseRuntimeGeneration(1),
    thread_id: parseThreadId("thread:old"),
    accepted_observation_digest: parseObservationDigest("sha256:old"),
    in_flight_correlation: parseCorrelationId("old:inflight"),
  });
  await assert.rejects(f.factory.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(2), root_home: f.rootHome,
  }), /root_home_owner_mismatch/u);
});

test("accepted output followed by continuity failure requires a new generation", async () => {
  const f = await fixture();
  f.transports.outputs.push([decision(), decision()]);
  const root = await f.factory.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1), root_home: f.rootHome,
  });
  await rm(path.join(f.rootHome, "symphony"), { recursive: true });
  await assert.rejects(root.bootstrap(bootstrap()), /root_restart_required/u);
  await assert.rejects(root.bootstrap(bootstrap()), /root_restart_required/u);
  assert.equal(f.transports.created[0]?.inputs.length, 1);
});
