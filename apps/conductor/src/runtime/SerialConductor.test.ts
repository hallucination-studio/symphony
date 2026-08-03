import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
  parseTaskIssueId,
  parseTaskRevision,
  type RootIssueId,
} from "../contracts/identity.js";
import type { CycleAdvanceRequest, CycleAdvanceResult } from "../contracts/cycle.js";
import {
  parseGitSnapshot,
  parseTaskObservationEvent,
  type TaskChangeOriginEvidence,
  type TaskObservationEvent,
} from "../contracts/observation.js";
import { canonicalTaskRevision, parseTaskSnapshot, type TaskIssueSnapshot, type TaskSnapshot } from "../contracts/task-management.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import type {
  CycleMachineHostInterface,
  PreparedCycleAction,
} from "../cycle/internal/CycleMachine.js";
import { taskSnapshotDigest } from "../observation/TaskFacts.js";
import type { RootReconcillInterface } from "../root-reconcill/api/RootReconcillInterface.js";
import { RootRuntimeRegistry, type RootTurnInput } from "./RootRuntimeRegistry.js";
import { SerialConductor, type SerialConductorLog } from "./SerialConductor.js";

const agentActor = "actor:agent";
const rootLabelId = "label:root";
const rootStates = Object.freeze({
  todo: "state:root:todo",
  in_progress: "state:root:in-progress",
  in_review: "state:root:in-review",
  done: "state:root:done",
});
const workflow = Object.freeze({
  labels: {
    root: rootLabelId,
    cycle: "label:cycle",
    plan: "label:plan",
    work: "label:work",
    verify: "label:verify",
  },
  cycle_states: {
    draft: "state:cycle:draft",
    in_progress: rootStates.in_progress,
    awaiting_acceptance: "state:cycle:awaiting-acceptance",
    succeeded: "state:cycle:succeeded",
    rejected: "state:cycle:rejected",
    failed: "state:failed",
    canceled: "state:canceled",
  },
  stage_states: {
    todo: rootStates.todo,
    in_progress: rootStates.in_progress,
    done: rootStates.done,
    failed: "state:failed",
    canceled: "state:canceled",
  },
});

interface TaskOptions {
  readonly delegateId?: string | null;
  readonly label?: string;
  readonly revision?: string;
  readonly status?: string;
  readonly title?: string;
}

const workflowStateMap = {
  team_id: "team:serial", revision: `symphony:v1:${"0".repeat(64)}`,
  todo_state_id: rootStates.todo, draft_state_id: workflow.cycle_states.draft,
  in_progress_state_id: rootStates.in_progress,
  awaiting_acceptance_state_id: workflow.cycle_states.awaiting_acceptance,
  in_review_state_id: rootStates.in_review, done_state_id: rootStates.done,
  succeeded_state_id: workflow.cycle_states.succeeded, rejected_state_id: workflow.cycle_states.rejected,
  failed_state_id: workflow.cycle_states.failed, canceled_state_id: workflow.cycle_states.canceled,
} as const;

function issue(fields: {
  readonly issue_id: string;
  readonly kind: TaskIssueSnapshot["kind"];
  readonly status_id: string;
  readonly status: TaskIssueSnapshot["status"];
  readonly title: string;
  readonly description_markdown: string;
  readonly parent_issue_id: string | null;
  readonly label_ids: readonly string[];
  readonly delegate_id: string | null;
  readonly priority: number | null;
  readonly revision_marker?: string;
}) {
  const { revision_marker, ...input } = fields;
  const canonicalFields = {
    ...input,
    provider_created_at: "2026-08-03T00:00:00.000Z",
    provider_updated_at: revision_marker === undefined
      ? "2026-08-03T00:00:00.000Z"
      : `2026-08-03T00:00:${revision_marker.endsWith("3") ? "03" : revision_marker.endsWith("2") ? "02" : "01"}.000Z`,
    creation_actor_id: "actor:agent",
    archived: false,
    trashed: false,
  };
  return { ...canonicalFields, revision: canonicalTaskRevision(canonicalFields) };
}

function snapshot(rootId: RootIssueId, issues: readonly unknown[]): TaskSnapshot {
  return parseTaskSnapshot({
    root_id: rootId, workflow_state_map: workflowStateMap, issues, relations: [],
    resource_creation_evidence: [], issue_history: [], issue_record_observations: [],
  });
}

function task(rootId: RootIssueId, options: TaskOptions = {}): TaskSnapshot {
  return snapshot(rootId, [issue({
      issue_id: rootId,
      kind: "root",
      status_id: options.status ?? rootStates.todo,
      status: options.status === rootStates.done ? "Done" : options.status === rootStates.in_review ? "In Review" : options.status === rootStates.in_progress ? "In Progress" : "Todo",
      title: options.title ?? `Root ${rootId}`,
      description_markdown: "# Root",
      parent_issue_id: null,
      label_ids: [options.label ?? rootLabelId],
      delegate_id: options.delegateId === undefined ? agentActor : options.delegateId,
      priority: 1,
      ...(options.revision === undefined ? {} : { revision_marker: options.revision }),
    })]);
}

function cycleTask(
  rootId: RootIssueId,
  status: keyof typeof workflow.cycle_states = "in_progress",
  options: TaskOptions = {},
): TaskSnapshot {
  const root = task(rootId, options);
  return snapshot(rootId, [...root.issues, issue({
      issue_id: `${rootId}:CYCLE`,
      kind: "cycle",
      status_id: workflow.cycle_states[status],
      status: status === "draft" ? "Draft" : status === "awaiting_acceptance" ? "Awaiting Acceptance" : status === "succeeded" ? "Succeeded" : status === "rejected" ? "Rejected" : status === "failed" ? "Failed" : status === "canceled" ? "Canceled" : "In Progress",
      title: "Cycle",
      description_markdown: "# Cycle",
      parent_issue_id: rootId,
      label_ids: [workflow.labels.cycle],
      delegate_id: agentActor,
      priority: 2,
      revision_marker: status,
    })]);
}

function doneTask(rootId: RootIssueId): TaskSnapshot {
  const cycleId = parseCycleIssueId(`${rootId}:CYCLE`);
  const stageId = parseStageIssueId(`${rootId}:STAGE`);
  return snapshot(rootId, [
      issue({
        issue_id: rootId,
        kind: "root", status_id: rootStates.done, status: "Done",
        title: `Done ${rootId}`,
        description_markdown: "root-description-secret",
        parent_issue_id: null,
        label_ids: [rootLabelId],
        delegate_id: agentActor,
        priority: 1,
        revision_marker: "done",
      }),
      issue({
        issue_id: cycleId,
        kind: "cycle", status_id: workflow.cycle_states.succeeded, status: "Succeeded",
        title: "Completed Cycle",
        description_markdown: "cycle-handoff-secret",
        parent_issue_id: rootId,
        label_ids: ["label:cycle"],
        delegate_id: null,
        priority: null,
        revision_marker: "done",
      }),
      issue({
        issue_id: stageId,
        kind: "work", status_id: workflow.stage_states.done, status: "Done",
        title: "Completed Work",
        description_markdown: "credential-secret",
        parent_issue_id: cycleId,
        label_ids: ["label:work"],
        delegate_id: null,
        priority: null,
        revision_marker: "done",
      }),
    ]);
}

function event(
  snapshot: TaskSnapshot,
  correlationId: string,
  from: TaskSnapshot | null = null,
  origins: readonly TaskChangeOriginEvidence[] = [],
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
    task_change_origins: origins,
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

function rootAvailableCycle(rootId: RootIssueId): CycleMachineHostInterface {
  const target = Object.freeze({ root_id: rootId, runtime_generation: parseRuntimeGeneration(1) });
  return {
    target,
    prepare: async () => Object.freeze({ kind: "root_available" }),
    prepareContinuation: async () => Object.freeze({ kind: "root_available" }),
    run: async () => { throw new Error("unexpected_cycle_action"); },
    retire: async () => undefined,
  };
}

function cycleAction(rootId: RootIssueId, correlationValue: string): PreparedCycleAction {
  const request = {
    root_id: rootId,
    cycle_id: parseCycleIssueId(`${rootId}:CYCLE`),
    runtime_generation: parseRuntimeGeneration(1),
    correlation_id: parseCorrelationId(correlationValue),
    cycle_revision: parseTaskRevision("revision:cycle:1"),
    specification: { seal_digest: "a".repeat(64) },
  } as CycleAdvanceRequest;
  return Object.freeze({ kind: "cycle_action", request });
}

function cycleResult(
  prepared: PreparedCycleAction,
  outcome: CycleAdvanceResult["outcome"],
): CycleAdvanceResult {
  const request = prepared.request;
  return {
    schema_version: 1,
    root_id: request.root_id,
    cycle_id: request.cycle_id,
    runtime_generation: request.runtime_generation,
    correlation_id: request.correlation_id,
    seal_digest: request.specification.seal_digest,
    from_cycle_revision: request.cycle_revision,
    to_cycle_revision: request.cycle_revision,
    outcome,
    reason_markdown: outcome === "terminal_failed" || outcome === "precondition_failed"
      ? "Cycle action did not advance."
      : null,
  } as CycleAdvanceResult;
}

function harness(
  run?: RootReconcillInterface["run"],
  cycleFactory: (rootId: RootIssueId) => CycleMachineHostInterface = rootAvailableCycle,
  cleanup?: {
    delete(rootId: RootIssueId, isLive: (candidate: RootIssueId) => boolean): Promise<void>;
  },
): Harness {
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
        cycle: cycleFactory(rootId),
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
          rootId,
          runtimeGeneration: parseRuntimeGeneration(1),
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
              } as const : await run(input);
            } finally {
              active -= 1;
            }
          },
          close: () => Promise.resolve(),
        },
      });
    },
  }, cleanup);
  return {
    conductor: new SerialConductor(registry, {
      agent_actor_id: agentActor,
      root_kind_label_id: rootLabelId,
      root_states: rootStates,
      workflow,
      log: (entry) => logs.push(entry),
    }),
    creations,
    inputs,
    logs,
    maxActive: () => maximum,
    registry,
  };
}

test("Cycle actions park Root turns, own the global slot, and continue before another Root", async () => {
  const root1 = parseRootIssueId("LIN-1");
  const root2 = parseRootIssueId("LIN-2");
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let root1Actions = 0;
  const f = harness(async (input) => {
    order.push(`root:${input.root_id}`);
    return {
      schema_version: 1,
      root_id: input.root_id,
      runtime_generation: input.runtime_generation,
      correlation_id: input.correlation_id,
      outcome: "quiescent",
    };
  }, (rootId) => {
    if (rootId !== root1) return rootAvailableCycle(rootId);
    const target = Object.freeze({ root_id: rootId, runtime_generation: parseRuntimeGeneration(1) });
    return {
      target,
      prepare: async (_task, correlationId) => cycleAction(rootId, correlationId),
      prepareContinuation: async () => cycleAction(rootId, "corr:cycle:continuation"),
      run: async (prepared) => {
        root1Actions += 1;
        order.push(`cycle:${rootId}`);
        if (root1Actions === 1) {
          signalStarted?.();
          await gate;
          return cycleResult(prepared, "advanced");
        }
        return cycleResult(prepared, "no_action");
      },
      retire: async () => undefined,
    };
  });
  f.conductor.admit([
    event(cycleTask(root1), "corr:root1:1"),
    event(task(root2), "corr:root2:1"),
  ]);

  const firstRun = f.conductor.runNext();
  await started;
  await assert.rejects(f.conductor.runNext(), /serial_conductor_busy/u);
  releaseFirst?.();
  assert.deepEqual(await firstRun, {
    kind: "cycle_action_completed",
    root_id: root1,
    outcome: "advanced",
  });
  assert.deepEqual(await f.conductor.runNext(), {
    kind: "cycle_action_completed",
    root_id: root1,
    outcome: "no_action",
  });
  assert.deepEqual(await f.conductor.runNext(), {
    kind: "turn_completed",
    root_id: root2,
    outcome: "quiescent",
  });
  assert.deepEqual(order, [`cycle:${root1}`, `cycle:${root1}`, `root:${root2}`]);
});

test("Root resumes after a Cycle reaches Awaiting Acceptance and a fresh observation arrives", async () => {
  const rootId = parseRootIssueId("LIN-1");
  let active = true;
  let rootTurns = 0;
  const f = harness(async (input) => {
    rootTurns += 1;
    return {
      schema_version: 1,
      root_id: input.root_id,
      runtime_generation: input.runtime_generation,
      correlation_id: input.correlation_id,
      outcome: "quiescent",
    };
  }, (createdRootId) => {
    const target = Object.freeze({
      root_id: createdRootId,
      runtime_generation: parseRuntimeGeneration(1),
    });
    return {
      target,
      prepare: async (_task, correlationId) => active
        ? cycleAction(createdRootId, correlationId)
        : Object.freeze({ kind: "root_available" }),
      prepareContinuation: async () => Object.freeze({ kind: "root_available" }),
      run: async (prepared) => {
        active = false;
        return cycleResult(prepared, "awaiting_acceptance");
      },
      retire: async () => undefined,
    };
  });

  const initial = cycleTask(rootId);
  f.conductor.admit([event(initial, "corr:cycle")]);
  assert.deepEqual(await f.conductor.runNext(), {
    kind: "cycle_action_completed",
    root_id: rootId,
    outcome: "awaiting_acceptance",
  });
  assert.equal(rootTurns, 0);
  assert.deepEqual(await f.conductor.runNext(), { kind: "idle" });

  const fresh = cycleTask(rootId, "awaiting_acceptance", { revision: "revision:root:2" });
  f.conductor.admit([event(fresh, "corr:acceptance", initial)]);
  assert.deepEqual(await f.conductor.runNext(), {
    kind: "turn_completed",
    root_id: rootId,
    outcome: "quiescent",
  });
  assert.equal(rootTurns, 1);
});

test("a Cycle precondition failure refreshes before another Root runs", async () => {
  const root1 = parseRootIssueId("LIN-1");
  const root2 = parseRootIssueId("LIN-2");
  const order: string[] = [];
  let actions = 0;
  const f = harness(async (input) => {
    order.push(`root:${input.root_id}`);
    return {
      schema_version: 1,
      root_id: input.root_id,
      runtime_generation: input.runtime_generation,
      correlation_id: input.correlation_id,
      outcome: "quiescent",
    };
  }, (rootId) => {
    if (rootId !== root1) return rootAvailableCycle(rootId);
    return {
      target: Object.freeze({ root_id: rootId, runtime_generation: parseRuntimeGeneration(1) }),
      prepare: async (_task, correlationId) => cycleAction(rootId, correlationId),
      prepareContinuation: async () => cycleAction(rootId, "corr:precondition:refresh"),
      run: async (prepared) => {
        actions += 1;
        order.push(`cycle:${rootId}`);
        return cycleResult(prepared, actions === 1 ? "precondition_failed" : "no_action");
      },
      retire: async () => undefined,
    };
  });
  f.conductor.admit([
    event(cycleTask(root1), "corr:root1"),
    event(task(root2), "corr:root2"),
  ]);

  assert.equal((await f.conductor.runNext()).kind, "cycle_action_completed");
  assert.equal((await f.conductor.runNext()).kind, "cycle_action_completed");
  assert.equal((await f.conductor.runNext()).kind, "turn_completed");
  assert.deepEqual(order, [`cycle:${root1}`, `cycle:${root1}`, `root:${root2}`]);
});

test("Cycle boundary failures are correlated, sanitized, and stop the Root runtime", async () => {
  const rootId = parseRootIssueId("LIN-1");
  const f = harness(undefined, (createdRootId) => ({
    target: Object.freeze({
      root_id: createdRootId,
      runtime_generation: parseRuntimeGeneration(1),
    }),
    prepare: async (_task, correlationId) => cycleAction(createdRootId, correlationId),
    prepareContinuation: async () => Object.freeze({ kind: "root_available" }),
    run: async () => { throw new Error("secret-provider-cycle-payload"); },
    retire: async () => undefined,
  }));
  const initial = cycleTask(rootId);
  f.conductor.admit([event(initial, "corr:cycle:failed")]);

  assert.deepEqual(await f.conductor.runNext(), {
    kind: "failed",
    root_id: rootId,
    reason_code: "cycle_boundary_failed",
  });
  assert.equal(JSON.stringify(f.logs).includes("secret-provider-cycle-payload"), false);
  assert.deepEqual(f.logs.find(({ event: name }) => name === "cycle_action_failed"), {
    event: "cycle_action_failed",
    root_id: rootId,
    cycle_id: `${rootId}:CYCLE`,
    runtime_generation: parseRuntimeGeneration(1),
    correlation_id: "corr:cycle:failed",
    reason_code: "cycle_boundary_failed",
  });

  const fresh = cycleTask(rootId, "in_progress", { revision: "revision:root:2" });
  f.conductor.admit([event(fresh, "corr:after-failure", initial)]);
  assert.deepEqual(await f.conductor.runNext(), { kind: "idle" });
});

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

test("active admission loss selects Stage-first Cycle cancellation without a Root turn", async () => {
  const rootId = parseRootIssueId("LIN-ADMISSION-LOSS");
  let closure: string | undefined;
  let rootTurns = 0;
  const f = harness(async (input) => {
    rootTurns += 1;
    return {
      schema_version: 1,
      root_id: input.root_id,
      runtime_generation: input.runtime_generation,
      correlation_id: input.correlation_id,
      outcome: "quiescent",
    };
  }, (createdRootId) => ({
    target: Object.freeze({ root_id: createdRootId, runtime_generation: parseRuntimeGeneration(1) }),
    prepare: async (_task, correlationId, _baseline, selectedClosure) => {
      closure = selectedClosure;
      return cycleAction(createdRootId, correlationId);
    },
    prepareContinuation: async () => Object.freeze({ kind: "root_available" }),
    run: async (prepared) => cycleResult(prepared, "terminal_failed"),
    retire: async () => undefined,
  }));
  const lost = cycleTask(rootId, "in_progress", { delegateId: null });
  f.conductor.admit([event(lost, "corr:admission:lost")]);

  assert.deepEqual(await f.conductor.runNext(), {
    kind: "cycle_action_completed",
    root_id: rootId,
    outcome: "terminal_failed",
  });
  assert.equal(closure, "admission_lost");
  assert.equal(rootTurns, 0);
  assert.equal(f.logs.some((entry) => entry.event === "fresh_route_selected"
    && entry.selected_route === "WF-ROUTE-015"), true);
});

test("a bounded external Root edit selects Root after Cycle mechanics are quiet", async () => {
  const rootId = parseRootIssueId("LIN-EXTERNAL-ROOT");
  const f = harness();
  const snapshot = cycleTask(rootId, "in_progress");
  f.conductor.admit([event(snapshot, "corr:external:root", null, [{
    issue_id: parseTaskIssueId(rootId),
    change_origin: "external",
    changed_fields: ["description"],
  }])]);

  assert.deepEqual(await f.conductor.runNext(), {
    kind: "turn_completed",
    root_id: rootId,
    outcome: "quiescent",
  });
  assert.equal(f.inputs.length, 1);
  assert.equal(f.logs.some((entry) => entry.event === "fresh_route_selected"
    && entry.selected_route === "WF-ROUTE-005"), true);
});

test("coalescing keeps the newest complete snapshot for the next fresh Root turn", async () => {
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
  const fresh = f.inputs[1];
  assert.ok(fresh && "task" in fresh);
  if (!fresh || !("task" in fresh)) return;
  assert.equal(fresh.correlation_id, "corr:poll:3");
  assert.deepEqual(fresh.task, latest);
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
  assert.ok(adjacent && "task" in adjacent);
  if (!adjacent || !("task" in adjacent)) return;
  assert.deepEqual(adjacent.task, latest);
});

test("In Review and invalid admission facts park without blocking the next eligible Root", async () => {
  const inReview = parseRootIssueId("LIN-1");
  const wrongKind = parseRootIssueId("LIN-2");
  const eligible = parseRootIssueId("LIN-3");
  const f = harness();
  f.conductor.admit([
    event(task(inReview, { status: rootStates.in_review }), "corr:review"),
    event(task(wrongKind, { label: "label:cycle" }), "corr:kind"),
    event(task(eligible), "corr:eligible"),
  ]);

  assert.deepEqual(await f.conductor.runNext(), {
    kind: "turn_completed",
    root_id: eligible,
    outcome: "quiescent",
  });
  assert.deepEqual(f.creations, [eligible]);
  assert.deepEqual(await f.conductor.runNext(), { kind: "idle" });
  assert.equal(f.logs.some((entry) => entry.event === "root_admission_parked"
    && entry.root_id === inReview && entry.reason_code === "in_review"), true);
  assert.equal(f.logs.some((entry) => entry.event === "root_admission_parked"
    && entry.root_id === wrongKind && entry.reason_code === "invalid_root_kind"), true);
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

test("turn boundary failures log only the deepest bounded internal cause code", async () => {
  const rootId = parseRootIssueId("LIN-1");
  const f = harness(async () => {
    throw new Error("root_turn_boundary_failed", {
      cause: new Error("root_reconcill_boundary_failed", {
        cause: new Error("codex_thread_turn_failed"),
      }),
    });
  });
  f.conductor.admit([event(task(rootId), "corr:turn:cause")]);

  await f.conductor.runNext();
  assert.deepEqual(f.logs.find(({ event: name }) => name === "root_turn_failed"), {
    event: "root_turn_failed",
    root_id: rootId,
    runtime_generation: parseRuntimeGeneration(1),
    correlation_id: "corr:turn:cause",
    reason_code: "turn_boundary_failed",
    cause_code: "codex_thread_turn_failed",
  });
});

test("runtime preparation logs only the deepest bounded internal cause code", async () => {
  const rootId = parseRootIssueId("LIN-1");
  const logs: SerialConductorLog[] = [];
  const registry = new RootRuntimeRegistry({
    create: async () => {
      throw new Error("root_transport_creation_failed", {
        cause: new Error("codex_local_only_preflight_failed:config"),
      });
    },
  });
  const conductor = new SerialConductor(registry, {
    agent_actor_id: agentActor,
    root_kind_label_id: rootLabelId,
    root_states: rootStates,
    workflow,
    log: (entry) => logs.push(entry),
  });
  conductor.admit([event(task(rootId), "corr:runtime:failed")]);

  assert.deepEqual(await conductor.runNext(), {
    kind: "failed",
    root_id: rootId,
    reason_code: "runtime_preparation_failed",
  });
  assert.deepEqual(logs.find(({ event: name }) => name === "root_observation_failed"), {
    event: "root_observation_failed",
    root_id: rootId,
    correlation_id: "corr:runtime:failed",
    reason_code: "runtime_preparation_failed",
    cause_code: "codex_local_only_preflight_failed:config",
  });

  const untrustedLogs: SerialConductorLog[] = [];
  const untrusted = new SerialConductor(new RootRuntimeRegistry({
    create: async () => {
      throw new Error("root transport exposed secret-provider-payload");
    },
  }), {
    agent_actor_id: agentActor,
    root_kind_label_id: rootLabelId,
    root_states: rootStates,
    workflow,
    log: (entry) => untrustedLogs.push(entry),
  });
  untrusted.admit([event(task(rootId), "corr:runtime:untrusted")]);
  await untrusted.runNext();
  assert.equal(JSON.stringify(untrustedLogs).includes("secret-provider-payload"), false);
  assert.equal("cause_code" in (untrustedLogs.find(
    ({ event: name }) => name === "root_observation_failed",
  ) ?? {}), false);
});

test("fresh Done fences an active Cycle continuation before another action", async () => {
  const rootId = parseRootIssueId("LIN-1");
  let actions = 0;
  let retirements = 0;
  const f = harness(undefined, (requestedRootId) => ({
    ...rootAvailableCycle(requestedRootId),
    prepare: async (_task, correlationId) => cycleAction(requestedRootId, correlationId),
    prepareContinuation: async () => cycleAction(requestedRootId, "corr:cycle:continuation"),
    run: async (prepared) => {
      actions += 1;
      return cycleResult(prepared, "advanced");
    },
    retire: async () => { retirements += 1; },
  }));
  const initial = cycleTask(rootId);
  f.conductor.admit([event(initial, "corr:root:active")]);
  assert.deepEqual(await f.conductor.runNext(), {
    kind: "cycle_action_completed",
    root_id: rootId,
    outcome: "advanced",
  });
  f.conductor.admit([event(doneTask(rootId), "corr:root:done", initial)]);

  assert.deepEqual(await f.conductor.runNext(), {
    kind: "root_cleanup_completed",
    root_id: rootId,
  });
  assert.equal(actions, 1);
  assert.equal(retirements, 1);
});

test("fresh Done retires the Root runtime and logs only correlated cleanup facts", async () => {
  const rootId = parseRootIssueId("LIN-1");
  const lifecycle: string[] = [];
  const f = harness(undefined, (requestedRootId) => ({
    ...rootAvailableCycle(requestedRootId),
    retire: async () => { lifecycle.push("cycle_retired"); },
  }), {
    delete: async (deletedRootId, isLive) => {
      assert.equal(deletedRootId, rootId);
      assert.equal(isLive(rootId), false);
      lifecycle.push("root_home_deleted");
    },
  });
  const initial = task(rootId);
  f.conductor.admit([event(initial, "corr:root:active")]);
  await f.conductor.runNext();
  const done = doneTask(rootId);
  f.conductor.admit([event(done, "corr:root:done", initial)]);

  assert.deepEqual(await f.conductor.runNext(), {
    kind: "root_cleanup_completed",
    root_id: rootId,
  });

  assert.equal(f.registry.has(rootId), false);
  assert.deepEqual(lifecycle, ["cycle_retired", "root_home_deleted"]);
  const started = f.logs.find((entry) => entry.event === "root_cleanup_started");
  const doneRoot = done.issues.find(({ kind }) => kind === "root")!;
  const doneCycle = done.issues.find(({ kind }) => kind === "cycle")!;
  const doneStage = done.issues.find(({ kind }) => kind === "work")!;
  assert.deepEqual(started, {
    event: "root_cleanup_started",
    root_id: rootId,
    root_revision: doneRoot.revision,
    runtime_generation: parseRuntimeGeneration(1),
    correlation_id: parseCorrelationId("corr:root:done"),
    reason_code: "root_done",
    cycles: [{
      cycle_id: parseCycleIssueId(`${rootId}:CYCLE`),
      revision: doneCycle.revision,
      stages: [{
        stage_id: parseStageIssueId(`${rootId}:STAGE`),
        revision: doneStage.revision,
      }],
    }],
  });
  assert.equal(f.logs.some((entry) => entry.event === "root_cleanup_completed"), true);
  const serialized = JSON.stringify(f.logs);
  assert.equal(serialized.includes("root-description-secret"), false);
  assert.equal(serialized.includes("cycle-handoff-secret"), false);
  assert.equal(serialized.includes("credential-secret"), false);
});

test("a first fresh Done observation cleans a persisted Home without creating a runtime", async () => {
  const rootId = parseRootIssueId("LIN-1");
  const deleted: RootIssueId[] = [];
  const f = harness(undefined, rootAvailableCycle, {
    delete: async (deletedRootId, isLive) => {
      assert.equal(isLive(deletedRootId), false);
      deleted.push(deletedRootId);
    },
  });
  f.conductor.admit([event(doneTask(rootId), "corr:root:already-done")]);

  assert.deepEqual(await f.conductor.runNext(), {
    kind: "root_cleanup_completed",
    root_id: rootId,
  });

  assert.deepEqual(f.creations, []);
  assert.deepEqual(deleted, [rootId]);
  const started = f.logs.find((entry) => entry.event === "root_cleanup_started");
  assert.ok(started?.event === "root_cleanup_started");
  assert.equal(started.runtime_generation, null);
});

test("failed process retirement stays visible, blocks Home cleanup, and hides raw errors", async () => {
  const rootId = parseRootIssueId("LIN-1");
  let deletes = 0;
  const f = harness(undefined, (requestedRootId) => ({
    ...rootAvailableCycle(requestedRootId),
    retire: async () => { throw new Error("raw-process-error-with-credential"); },
  }), {
    delete: async () => { deletes += 1; },
  });
  const initial = task(rootId);
  f.conductor.admit([event(initial, "corr:root:active")]);
  await f.conductor.runNext();
  f.conductor.admit([event(doneTask(rootId), "corr:root:done", initial)]);

  assert.deepEqual(await f.conductor.runNext(), {
    kind: "failed",
    root_id: rootId,
    reason_code: "runtime_shutdown_failed",
  });

  assert.equal(f.registry.has(rootId), true);
  assert.equal(deletes, 0);
  assert.equal(f.logs.some((entry) => entry.event === "root_cleanup_failed"
    && entry.reason_code === "runtime_shutdown_failed"), true);
  assert.equal(JSON.stringify(f.logs).includes("raw-process-error-with-credential"), false);
});
