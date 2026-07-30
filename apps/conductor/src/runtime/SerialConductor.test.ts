import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
  type RootIssueId,
} from "../contracts/identity.js";
import {
  parseGitSnapshot,
  parseTaskObservationEvent,
  parseTaskSnapshot,
  type TaskObservationEvent,
  type TaskSnapshot,
} from "../contracts/observation.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import { taskSnapshotDigest } from "../observation/TaskFacts.js";
import { RootRuntimeRegistry, type RootTurnInput } from "./RootRuntimeRegistry.js";
import { SerialConductor, type SerialConductorLog } from "./SerialConductor.js";

const agentActor = "actor:agent";

interface TaskOptions {
  readonly delegateId?: string | null;
  readonly label?: string;
  readonly revision?: string;
  readonly status?: string;
  readonly title?: string;
}

function task(rootId: RootIssueId, options: TaskOptions = {}): TaskSnapshot {
  return parseTaskSnapshot({
    root_id: rootId,
    issues: [{
      issue_id: rootId,
      revision: options.revision ?? "revision:root:1",
      status: options.status ?? "Todo",
      title: options.title ?? `Root ${rootId}`,
      description: null,
      parent_id: null,
      labels: [options.label ?? "symphony:kind/root"],
      delegate_id: options.delegateId === undefined ? agentActor : options.delegateId,
      priority: 1,
    }],
    relations: [],
  });
}

function event(
  snapshot: TaskSnapshot,
  correlationId: string,
  from: TaskSnapshot | null = null,
): TaskObservationEvent {
  return parseTaskObservationEvent({
    schema_version: 1,
    root_id: snapshot.root_id,
    correlation_id: correlationId,
    observed_at: "2026-07-30T10:00:00.000Z",
    from_task_digest: from === null ? null : taskSnapshotDigest(from),
    to_task_digest: taskSnapshotDigest(snapshot),
    task: snapshot,
    task_changes: [],
  });
}

interface Harness {
  readonly conductor: SerialConductor;
  readonly creations: RootIssueId[];
  readonly inputs: RootTurnInput[];
  readonly logs: SerialConductorLog[];
  readonly maxActive: () => number;
  readonly registry: RootRuntimeRegistry;
}

function harness(run?: (input: RootTurnInput) => Promise<unknown>): Harness {
  const creations: RootIssueId[] = [];
  const inputs: RootTurnInput[] = [];
  const logs: SerialConductorLog[] = [];
  let active = 0;
  let maximum = 0;
  const registry = new RootRuntimeRegistry({
    create: async (rootId) => {
      creations.push(rootId);
      const workspace = Object.freeze({
        root_id: rootId,
        repository_id: parseRepositoryId(`repo:${rootId}`),
        base_branch: "main",
        head_branch: createRootHeadBranch(rootId),
      });
      return Object.freeze({
        target: Object.freeze({ root_id: rootId, runtime_generation: parseRuntimeGeneration(1) }),
        workspace,
        git: {
          read: async () => parseGitSnapshot({
            repository_id: workspace.repository_id,
            base_branch: workspace.base_branch,
            head_branch: workspace.head_branch,
            head_revision: "1111111111111111111111111111111111111111",
            workspace_state: "clean",
            diff_digest: "sha256:clean",
            pull_request: null,
          }),
        },
        turn: {
          run: async (input: RootTurnInput) => {
            inputs.push(input);
            active += 1;
            maximum = Math.max(maximum, active);
            try {
              return run === undefined ? {
                schema_version: 1,
                root_id: input.root_id,
                runtime_generation: input.runtime_generation,
                correlation_id: input.correlation_id,
                outcome: "quiescent",
              } : await run(input);
            } finally {
              active -= 1;
            }
          },
        },
      });
    },
  });
  return {
    conductor: new SerialConductor(registry, { agent_actor_id: agentActor, log: (entry) => logs.push(entry) }),
    creations,
    inputs,
    logs,
    maxActive: () => maximum,
    registry,
  };
}

test("undelegated Roots stay idle until a fresh delegated observation arrives", async () => {
  const rootId = parseRootIssueId("LIN-1");
  const f = harness();
  const undelegated = task(rootId, { delegateId: null });
  f.conductor.admit([event(undelegated, "corr:poll:1")]);

  assert.deepEqual(await f.conductor.runNext(), { kind: "idle" });
  assert.deepEqual(f.creations, []);
  assert.equal(f.inputs.length, 0);

  const delegated = task(rootId, { revision: "revision:root:2" });
  f.conductor.admit([event(delegated, "corr:poll:2", undelegated)]);

  assert.deepEqual(await f.conductor.runNext(), {
    kind: "turn_completed",
    root_id: rootId,
    outcome: "quiescent",
  });
  assert.deepEqual(f.creations, [rootId]);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0]?.correlation_id, "corr:poll:2");
  assert.equal("task" in f.inputs[0]! ? f.inputs[0].task.issues[0]?.delegate_id : null, agentActor);
  assert.deepEqual(f.logs.find(({ event: name }) => name === "root_admission_parked"), {
    event: "root_admission_parked",
    root_id: rootId,
    correlation_id: "corr:poll:1",
    reason_code: "not_delegated",
  });
});

test("coalescing keeps the newest complete snapshot and diffs it from the accepted baseline", async () => {
  const rootId = parseRootIssueId("LIN-1");
  const f = harness();
  const initial = task(rootId, { title: "Initial" });
  f.conductor.admit([event(initial, "corr:poll:1")]);
  await f.conductor.runNext();

  const intermediate = task(rootId, { revision: "revision:root:2", title: "Intermediate" });
  const latest = task(rootId, { revision: "revision:root:3", title: "Latest" });
  f.conductor.admit([
    event(intermediate, "corr:poll:2", initial),
    event(latest, "corr:poll:3", intermediate),
  ]);

  await f.conductor.runNext();

  assert.equal(f.inputs.length, 2);
  const diff = f.inputs[1];
  assert.ok(diff && "task_changes" in diff);
  if (!diff || !("task_changes" in diff)) return;
  assert.equal(diff.correlation_id, "corr:poll:3");
  assert.deepEqual(diff.task_changes, [{
    kind: "field_changed",
    issue_id: rootId,
    field: "title",
    before: "Initial",
    after: "Latest",
  }]);
});

test("one turn runs globally and an in-flight Root keeps later observations adjacent", async () => {
  const root1 = parseRootIssueId("LIN-1");
  const root2 = parseRootIssueId("LIN-2");
  let releaseFirst: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let turns = 0;
  const f = harness(async (input) => {
    turns += 1;
    if (turns === 1) {
      signalStarted?.();
      await gate;
    }
    return {
      schema_version: 1,
      root_id: input.root_id,
      runtime_generation: input.runtime_generation,
      correlation_id: input.correlation_id,
      outcome: "quiescent",
    };
  });
  const first = task(root1, { title: "First" });
  f.conductor.admit([
    event(first, "corr:root1:1"),
    event(task(root2), "corr:root2:1"),
  ]);

  const firstRun = f.conductor.runNext();
  await started;
  await assert.rejects(f.conductor.runNext(), /serial_conductor_busy/u);
  const latest = task(root1, { revision: "revision:root:2", title: "Latest" });
  f.conductor.admit([event(latest, "corr:root1:2", first)]);
  releaseFirst?.();
  await firstRun;

  await f.conductor.runNext();
  await f.conductor.runNext();

  assert.equal(f.maxActive(), 1);
  assert.deepEqual(f.inputs.map(({ root_id }) => root_id), [root1, root1, root2]);
  const adjacent = f.inputs[1];
  assert.ok(adjacent && "task_changes" in adjacent);
  if (!adjacent || !("task_changes" in adjacent)) return;
  assert.deepEqual(adjacent.task_changes, [{
    kind: "field_changed",
    issue_id: root1,
    field: "title",
    before: "First",
    after: "Latest",
  }]);
});

test("In Review and invalid admission facts park without blocking the next eligible Root", async () => {
  const inReview = parseRootIssueId("LIN-1");
  const wrongKind = parseRootIssueId("LIN-2");
  const eligible = parseRootIssueId("LIN-3");
  const f = harness();
  f.conductor.admit([
    event(task(inReview, { status: "In Review" }), "corr:review"),
    event(task(wrongKind, { label: "symphony:kind/cycle" }), "corr:kind"),
    event(task(eligible), "corr:eligible"),
  ]);

  assert.deepEqual(await f.conductor.runNext(), {
    kind: "turn_completed",
    root_id: eligible,
    outcome: "quiescent",
  });
  assert.deepEqual(f.creations, [eligible]);
  assert.equal(f.logs.some((entry) => entry.event === "root_admission_parked"
    && entry.root_id === inReview && entry.reason_code === "in_review"), true);
  assert.equal(f.logs.some((entry) => entry.event === "root_admission_parked"
    && entry.root_id === wrongKind && entry.reason_code === "invalid_root_kind"), true);
  assert.deepEqual(await f.conductor.runNext(), { kind: "idle" });
});

test("turn boundary failures are sanitized and never advance the accepted baseline", async () => {
  const rootId = parseRootIssueId("LIN-1");
  const f = harness(async () => { throw new Error("secret-provider-payload"); });
  const initial = task(rootId);
  f.conductor.admit([event(initial, "corr:poll:1")]);

  assert.deepEqual(await f.conductor.runNext(), {
    kind: "failed",
    root_id: rootId,
    reason_code: "turn_boundary_failed",
  });
  assert.equal(JSON.stringify(f.logs).includes("secret-provider-payload"), false);
  assert.equal(f.logs.some((entry) => entry.event === "root_turn_failed"
    && entry.reason_code === "turn_boundary_failed"), true);
  const latest = task(rootId, { revision: "revision:root:2", title: "Latest" });
  const prepared = await (await f.registry.getOrCreate(rootId))
    .prepare(event(latest, "corr:poll:2", initial));
  assert.equal(prepared.kind, "bootstrap");
});
