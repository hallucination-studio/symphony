import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../contracts/identity.js";
import {
  parseGitSnapshot,
  parseTaskObservationEvent,
} from "../contracts/observation.js";
import {
  canonicalTaskRevision,
  parseTaskSnapshot,
  type TaskSnapshot,
} from "../contracts/task-management.js";
import type { RootTurnOutcome } from "../contracts/runtime.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import type { CycleMachineHostInterface } from "../cycle/internal/CycleMachine.js";
import { taskSnapshotDigest } from "../observation/TaskFacts.js";
import type { RootReconcillInterface } from "../root-reconcill/api/RootReconcillInterface.js";
import {
  RootRuntime,
  type DeliveryFinalizerResult,
  type RootRuntimeBinding,
} from "./RootRuntime.js";

const rootId = parseRootIssueId("LIN-1");
const generation = parseRuntimeGeneration(1);

const workflowStateFields = {
  team_id: "team:runtime",
  todo_state_id: "state:todo",
  draft_state_id: "state:draft",
  in_progress_state_id: "state:in-progress",
  awaiting_acceptance_state_id: "state:awaiting-acceptance",
  in_review_state_id: "state:in-review",
  done_state_id: "state:done",
  succeeded_state_id: "state:succeeded",
  rejected_state_id: "state:rejected",
  failed_state_id: "state:failed",
  canceled_state_id: "state:canceled",
} as const;
const workflowStateMap = Object.freeze({
  ...workflowStateFields,
  revision: canonicalTaskRevision(workflowStateFields),
});

function task(revision: string, title: string): TaskSnapshot {
  const fields = {
    issue_id: rootId,
    provider_created_at: "2026-07-30T10:00:00.000Z",
    provider_updated_at: "2026-07-30T10:00:00.000Z",
    creation_actor_id: "actor:agent",
    kind: "root" as const,
    status_id: "state:todo",
    status: "Todo" as const,
    title,
    description_markdown: `# ${title}`,
    parent_issue_id: null,
    label_ids: ["symphony:kind:root"],
    delegate_id: "actor:agent",
    priority: 1,
    archived: false,
    trashed: false,
  };
  return parseTaskSnapshot({
    root_id: rootId,
    workflow_state_map: workflowStateMap,
    issues: [{
      ...fields,
      provider_updated_at: revision.endsWith(":2")
        ? "2026-07-30T10:00:01.000Z"
        : "2026-07-30T10:00:00.000Z",
      revision: canonicalTaskRevision({
        ...fields,
        provider_updated_at: revision.endsWith(":2")
          ? "2026-07-30T10:00:01.000Z"
          : "2026-07-30T10:00:00.000Z",
      }),
    }],
    relations: [],
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
  });
}

function event(snapshot: TaskSnapshot, correlationId: string, before: TaskSnapshot | null = null) {
  return parseTaskObservationEvent({
    schema_version: 1,
    root_id: rootId,
    correlation_id: correlationId,
    observed_at: "2026-07-30T10:00:00.000Z",
    from_task_digest: before === null ? null : taskSnapshotDigest(before),
    to_task_digest: taskSnapshotDigest(snapshot),
    task: snapshot,
    task_changes: [],
    task_change_origins: [],
  });
}

function binding(run: RootReconcillInterface["run"]): RootRuntimeBinding {
  const workspace = Object.freeze({
    root_id: rootId,
    repository_id: parseRepositoryId("repo:1"),
    base_branch: "main",
    head_branch: createRootHeadBranch(rootId),
  });
  const turn: RootReconcillInterface = Object.freeze({
    rootId,
    runtimeGeneration: generation,
    run,
    close: () => Promise.resolve(),
  });
  return Object.freeze({
    target: Object.freeze({ root_id: rootId, runtime_generation: generation }),
    workspace,
    cycle: rootAvailableCycle(),
    git: {
      readRoot: async () => parseGitSnapshot({
        repository_id: workspace.repository_id,
        base_branch: workspace.base_branch,
        head_branch: workspace.head_branch,
        head_revision: "1111111111111111111111111111111111111111",
        workspace_state: "clean",
        diff_digest: "sha256:clean",
        pull_request: null,
      }),
    },
    turn,
  });
}

function deliveryRoute(routeId: "WF-ROUTE-010" | "WF-ROUTE-012" = "WF-ROUTE-010") {
  return Object.freeze({
    route_id: routeId,
    priority: routeId === "WF-ROUTE-010" ? 70 : 30,
    consumer: "delivery_finalizer" as const,
    cycle_id: parseCycleIssueId("CYCLE-1"),
  });
}

function rootAvailableCycle(): CycleMachineHostInterface {
  return {
    target: Object.freeze({ root_id: rootId, runtime_generation: generation }),
    prepare: async () => Object.freeze({ kind: "root_available" }),
    prepareContinuation: async () => Object.freeze({ kind: "root_available" }),
    run: async () => { throw new Error("unexpected_cycle_action"); },
    retire: async () => undefined,
  };
}

function outcome(
  correlationId: string,
  value: RootTurnOutcome["outcome"],
): RootTurnOutcome {
  const envelope = {
    schema_version: 1 as const,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: parseCorrelationId(correlationId),
  };
  return value === "quiescent"
    ? Object.freeze({ ...envelope, outcome: value })
    : Object.freeze({ ...envelope, outcome: value, sanitized_reason: `Root turn ${value}` });
}

test("runtime accepts observations only after quiescent or stopped Root outcomes", async () => {
  for (const acceptedOutcome of ["quiescent", "stopped"] as const) {
    const initial = task("revision:root:1", "Initial");
    const latest = task("revision:root:2", "Latest");
    const runtime = new RootRuntime(binding(async (input) => outcome(input.correlation_id, acceptedOutcome)));

    const prepared = await runtime.prepare(event(initial, `corr:${acceptedOutcome}:1`));
    assert.equal(prepared.kind, "bootstrap");
    if (prepared.kind !== "bootstrap") continue;
    assert.equal((await runtime.run(prepared)).outcome, acceptedOutcome);
    runtime.accept(prepared);

    const adjacent = await runtime.prepare(event(latest, `corr:${acceptedOutcome}:2`, initial));
    assert.equal(adjacent.kind, "diff");
    if (adjacent.kind !== "diff") continue;
    assert.equal(adjacent.root_input.from_observation_digest, prepared.observation_digest);
  }
});

test("root-boundary routes receive a complete semantic snapshot with accepted continuity", async () => {
  const initial = task("revision:root:1", "Initial");
  const latest = task("revision:root:2", "Latest");
  const runtime = new RootRuntime(binding(async (input) => outcome(input.correlation_id, "quiescent")));

  const bootstrap = await runtime.prepare(event(initial, "corr:root-boundary:1"));
  assert.equal(bootstrap.kind, "bootstrap");
  if (bootstrap.kind !== "bootstrap") return;
  await runtime.run(bootstrap);
  runtime.accept(bootstrap);

  const snapshot = await runtime.prepare(
    event(latest, "corr:root-boundary:2", initial),
    "root_boundary",
  );
  assert.equal(snapshot.kind, "semantic_snapshot");
  if (snapshot.kind !== "semantic_snapshot") return;
  assert.deepEqual(snapshot.root_input.task, latest);
  assert.deepEqual(snapshot.root_input.routing, {
    disposition: "root_boundary",
    selected_route: "WF-ROUTE-001",
    active_cycle_id: null,
  });
});

test("external terminal routing forwards the exact Cycle identity to the Cycle host", async () => {
  let selectedCycleId: string | undefined;
  const created = binding(async (input) => outcome(input.correlation_id, "quiescent"));
  const runtime = new RootRuntime({
    ...created,
    cycle: {
      ...rootAvailableCycle(),
      prepare: async (_task, _correlationId, _previous, _closure, cycleId) => {
        selectedCycleId = cycleId;
        return Object.freeze({ kind: "root_available" });
      },
    },
  });

  const preparation = await runtime.prepare(event(task("revision:root:1", "Terminal"), "corr:external-terminal"), {
    route_id: "WF-ROUTE-018",
    priority: 15,
    consumer: "cycle_machine",
    cycle_id: parseCycleIssueId("CYCLE-1"),
  });

  assert.equal(preparation.kind, "paused");
  assert.equal(selectedCycleId, "CYCLE-1");
});

test("delivery routes prepare and run an independent finalizer without a Root turn", async () => {
  let turns = 0;
  const preparedInputs: string[] = [];
  const finalizerResults: DeliveryFinalizerResult[] = [];
  const created = binding(async (input) => {
    turns += 1;
    return outcome(input.correlation_id, "quiescent");
  });
  const runtime = new RootRuntime({
    ...created,
    delivery_finalizer: {
      prepare: async ({ task: observedTask, route, correlation_id, runtime_generation }) => {
        preparedInputs.push(`${observedTask.root_id}:${route.route_id}:${correlation_id}`);
        return Object.freeze({
          kind: "delivery_finalizer" as const,
          root_id: rootId,
          runtime_generation,
          correlation_id,
          selected_route: route.route_id as "WF-ROUTE-010" | "WF-ROUTE-012",
          cycle_id: route.cycle_id!,
        });
      },
      run: async (prepared) => {
        const result = Object.freeze({
          kind: "delivery_finalizer_result" as const,
          root_id: prepared.root_id,
          runtime_generation: prepared.runtime_generation,
          correlation_id: prepared.correlation_id,
          selected_route: prepared.selected_route,
          cycle_id: prepared.cycle_id,
          outcome: "delivery_completed" as const,
        });
        finalizerResults.push(result);
        return result;
      },
    },
  });

  const prepared = await runtime.prepare(
    event(task("revision:root:1", "Accepted"), "corr:delivery"),
    deliveryRoute(),
  );

  assert.equal(prepared.kind, "delivery_finalizer");
  if (prepared.kind !== "delivery_finalizer") return;
  assert.deepEqual(preparedInputs, ["LIN-1:WF-ROUTE-010:corr:delivery"]);
  assert.deepEqual(await runtime.runDeliveryFinalizer(prepared), {
    kind: "delivery_finalizer_result",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: "corr:delivery",
    selected_route: "WF-ROUTE-010",
    cycle_id: "CYCLE-1",
    outcome: "delivery_completed",
  });
  assert.equal(turns, 0);
  assert.equal(finalizerResults.length, 1);
});

test("runtime rejects acceptance after timed out or canceled outcomes", async () => {
  for (const rejectedOutcome of ["timed_out", "canceled"] as const) {
    const initial = task("revision:root:1", "Initial");
    const latest = task("revision:root:2", "Latest");
    const runtime = new RootRuntime(binding(async (input) => outcome(input.correlation_id, rejectedOutcome)));

    const prepared = await runtime.prepare(event(initial, `corr:${rejectedOutcome}:1`));
    assert.equal(prepared.kind, "bootstrap");
    if (prepared.kind !== "bootstrap") continue;
    assert.equal((await runtime.run(prepared)).outcome, rejectedOutcome);
    assert.throws(() => runtime.accept(prepared), /root_runtime_outcome_not_acceptable/u);

    assert.equal(
      (await runtime.prepare(event(latest, `corr:${rejectedOutcome}:2`, initial))).kind,
      "bootstrap",
    );
  }
});

test("runtime leaves the baseline unchanged after rejection or mismatched output", async () => {
  const initial = task("revision:root:1", "Initial");
  const latest = task("revision:root:2", "Latest");
  const rejected = new RootRuntime(binding(async () => { throw new Error("turn_rejected"); }));
  const rejectedCandidate = await rejected.prepare(event(initial, "corr:rejected:1"));
  assert.equal(rejectedCandidate.kind, "bootstrap");
  if (rejectedCandidate.kind !== "bootstrap") return;
  await assert.rejects(rejected.run(rejectedCandidate), /turn_rejected/u);
  assert.throws(() => rejected.accept(rejectedCandidate), /root_runtime_turn_not_completed/u);
  assert.equal((await rejected.prepare(event(latest, "corr:rejected:2", initial))).kind, "bootstrap");

  const mismatched = new RootRuntime(binding(async () => outcome("corr:foreign", "quiescent")));
  const mismatchedCandidate = await mismatched.prepare(event(initial, "corr:expected"));
  assert.equal(mismatchedCandidate.kind, "bootstrap");
  if (mismatchedCandidate.kind !== "bootstrap") return;
  await assert.rejects(mismatched.run(mismatchedCandidate), /turn_correlation_mismatch/u);
  assert.throws(() => mismatched.accept(mismatchedCandidate), /root_runtime_turn_not_completed/u);
  assert.equal((await mismatched.prepare(event(latest, "corr:after-mismatch", initial))).kind, "bootstrap");
});

test("runtime starts only its own prepared candidate and starts it once", async () => {
  let turns = 0;
  const runtime = new RootRuntime(binding(async (input) => {
    turns += 1;
    return outcome(input.correlation_id, "quiescent");
  }));
  const prepared = await runtime.prepare(event(task("revision:root:1", "Initial"), "corr:owned"));
  assert.equal(prepared.kind, "bootstrap");
  if (prepared.kind !== "bootstrap") return;

  const foreignRuntime = new RootRuntime(binding(async (input) => outcome(input.correlation_id, "quiescent")));
  const foreign = await foreignRuntime.prepare(
    event(task("revision:root:1", "Initial"), "corr:foreign"),
  );
  assert.equal(foreign.kind, "bootstrap");
  if (foreign.kind !== "bootstrap") return;

  await assert.rejects(runtime.run(foreign), /invalid_root_observation_candidate/u);
  await assert.rejects(
    runtime.run(Object.freeze({ ...prepared })),
    /invalid_root_observation_candidate/u,
  );
  assert.equal(turns, 0);

  assert.equal((await runtime.run(prepared)).outcome, "quiescent");
  await assert.rejects(runtime.run(prepared), /root_runtime_turn_already_started/u);
  assert.equal(turns, 1);
});

test("runtime hard-binds frozen target and workspace identities", async () => {
  const created = binding(async (input) => outcome(input.correlation_id, "quiescent"));
  const target = { ...created.target };
  const workspace = { ...created.workspace };
  const runtime = new RootRuntime({ ...created, target, workspace });

  target.root_id = parseRootIssueId("LIN-2");
  target.runtime_generation = parseRuntimeGeneration(2);
  workspace.root_id = parseRootIssueId("LIN-2");
  workspace.repository_id = parseRepositoryId("repo:2");
  workspace.base_branch = "release";
  workspace.head_branch = createRootHeadBranch(workspace.root_id);

  assert.deepEqual(runtime.target, { root_id: rootId, runtime_generation: generation });
  assert.deepEqual(runtime.workspace, {
    root_id: rootId,
    repository_id: parseRepositoryId("repo:1"),
    base_branch: "main",
    head_branch: createRootHeadBranch(rootId),
  });
  assert.equal(Object.isFrozen(runtime.target), true);
  assert.equal(Object.isFrozen(runtime.workspace), true);
  assert.equal(
    (await runtime.prepare(event(task("revision:root:1", "Initial"), "corr:bound"))).kind,
    "bootstrap",
  );
});

test("runtime never passes an accepted Task cache to fresh Cycle admission", async () => {
  const baselines: (TaskSnapshot | null)[] = [];
  const created = binding(async (input) => outcome(input.correlation_id, "quiescent"));
  const runtime = new RootRuntime({
    ...created,
    cycle: {
      ...rootAvailableCycle(),
      prepare: async (_task, _correlationId, previousAcceptedTask) => {
        baselines.push(previousAcceptedTask);
        return Object.freeze({ kind: "root_available" });
      },
    },
  });
  const initial = task("revision:root:1", "Initial");
  const latest = task("revision:root:2", "Latest");

  const bootstrap = await runtime.prepare(event(initial, "corr:baseline:1"));
  assert.equal(bootstrap.kind, "bootstrap");
  if (bootstrap.kind !== "bootstrap") return;
  await runtime.run(bootstrap);
  runtime.accept(bootstrap);
  await runtime.prepare(event(latest, "corr:baseline:2", initial));

  assert.deepEqual(baselines, [null, null]);
});
