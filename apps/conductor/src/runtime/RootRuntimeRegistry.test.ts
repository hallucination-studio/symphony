import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
  type RootIssueId,
} from "../contracts/identity.js";
import { parseGitSnapshot, parseTaskObservationEvent, parseTaskSnapshot } from "../contracts/observation.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import type { CycleMachineHostInterface } from "../cycle/internal/CycleMachine.js";
import { taskSnapshotDigest } from "../observation/TaskFacts.js";
import type { RootReconcillInterface } from "../root-reconcill/api/RootReconcillInterface.js";
import {
  RootRuntimeRegistry,
  type RootRuntimeBinding,
} from "./RootRuntimeRegistry.js";

const rootId = parseRootIssueId("LIN-1");

function taskEvent() {
  const task = parseTaskSnapshot({
    root_id: rootId,
    issues: [{
      issue_id: rootId,
      revision: "revision:root:1",
      status: "Todo",
      title: "Build the runtime",
      description: null,
      parent_id: null,
      labels: ["symphony:kind/root"],
      delegate_id: "actor:agent",
      priority: 1,
    }],
    relations: [],
  });
  return parseTaskObservationEvent({
    schema_version: 1,
    root_id: rootId,
    correlation_id: "corr:poll:1",
    observed_at: "2026-07-30T10:00:00.000Z",
    from_task_digest: null,
    to_task_digest: taskSnapshotDigest(task),
    task,
    task_changes: [],
  });
}

function binding(
  run: RootReconcillInterface["run"],
  close: RootReconcillInterface["close"] = () => Promise.resolve(),
): RootRuntimeBinding {
  const workspace = Object.freeze({
    root_id: rootId,
    repository_id: parseRepositoryId("repo:1"),
    base_branch: "main",
    head_branch: createRootHeadBranch(rootId),
  });
  return Object.freeze({
    target: Object.freeze({ root_id: rootId, runtime_generation: parseRuntimeGeneration(1) }),
    workspace,
    cycle: rootAvailableCycle(rootId),
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
    turn: Object.freeze({
      rootId,
      runtimeGeneration: parseRuntimeGeneration(1),
      run,
      close,
    }),
  });
}

function rootAvailableCycle(cycleRootId: RootIssueId): CycleMachineHostInterface {
  const target = Object.freeze({
    root_id: cycleRootId,
    runtime_generation: parseRuntimeGeneration(1),
  });
  return {
    target,
    prepare: async () => Object.freeze({ kind: "root_available" }),
    prepareContinuation: async () => Object.freeze({ kind: "root_available" }),
    run: async () => { throw new Error("unexpected_cycle_action"); },
    retire: () => undefined,
  };
}

test("registry creates one identity-bound runtime under concurrent lookup", async () => {
  let creations = 0;
  const registry = new RootRuntimeRegistry({
    create: async () => {
      creations += 1;
      await Promise.resolve();
      return binding(async (input) => ({
        schema_version: 1,
        root_id: input.root_id,
        runtime_generation: input.runtime_generation,
        correlation_id: input.correlation_id,
        outcome: "quiescent",
      }));
    },
  });

  const [first, second] = await Promise.all([
    registry.getOrCreate(rootId),
    registry.getOrCreate(rootId),
  ]);

  assert.equal(first, second);
  assert.equal(creations, 1);
  assert.equal(registry.size, 1);
  assert.equal(registry.has(rootId), true);
});

test("runtime validates turn correlation before accepting an observation", async () => {
  const outputCorrelation = parseCorrelationId("corr:stale");
  const registry = new RootRuntimeRegistry({
    create: async () => binding(async (input) => ({
      schema_version: 1,
      root_id: input.root_id,
      runtime_generation: input.runtime_generation,
      correlation_id: outputCorrelation,
      outcome: "quiescent",
    })),
  });
  const runtime = await registry.getOrCreate(rootId);
  const prepared = await runtime.prepare(taskEvent());
  assert.equal(prepared.kind, "bootstrap");
  if (prepared.kind !== "bootstrap") return;

  await assert.rejects(runtime.run(prepared), /turn_correlation_mismatch/u);
  assert.throws(() => runtime.accept(prepared), /root_runtime_turn_not_completed/u);
});

test("registry rejects wrong-root and aliased turn resources", async () => {
  const wrongRoot = parseRootIssueId("LIN-2");
  let wrongRootCloses = 0;
  const wrongRegistry = new RootRuntimeRegistry({
    create: async () => binding(
      async (input) => ({
        schema_version: 1,
        root_id: input.root_id,
        runtime_generation: input.runtime_generation,
        correlation_id: input.correlation_id,
        outcome: "quiescent",
      }),
      async () => {
        wrongRootCloses += 1;
        throw new Error("private_close_failure");
      },
    ),
  });
  await assert.rejects(wrongRegistry.getOrCreate(wrongRoot), /root_runtime_identity_mismatch/u);
  assert.equal(wrongRootCloses, 1);

  let aliasCloses = 0;
  const sharedTurn = binding(
    async (input) => ({
      schema_version: 1,
      root_id: input.root_id,
      runtime_generation: input.runtime_generation,
      correlation_id: input.correlation_id,
      outcome: "quiescent",
    }),
    async () => { aliasCloses += 1; },
  ).turn;
  const aliasRegistry = new RootRuntimeRegistry({
    create: async (requestedRootId) => {
      const created = binding(sharedTurn.run);
      return Object.freeze({
        ...created,
        target: Object.freeze({ root_id: requestedRootId, runtime_generation: parseRuntimeGeneration(1) }),
        workspace: Object.freeze({ ...created.workspace, root_id: requestedRootId }),
        turn: sharedTurn,
      });
    },
  });
  await aliasRegistry.getOrCreate(rootId);
  await assert.rejects(aliasRegistry.getOrCreate(wrongRoot), /root_runtime_resource_alias/u);
  assert.equal(aliasCloses, 0);

  let uniqueTurnCloses = 0;
  const sharedCycle = rootAvailableCycle(rootId);
  const cycleAliasRegistry = new RootRuntimeRegistry({
    create: async (requestedRootId) => {
      const created = binding(
        async (input) => ({
          schema_version: 1,
          root_id: input.root_id,
          runtime_generation: input.runtime_generation,
          correlation_id: input.correlation_id,
          outcome: "quiescent",
        }),
        async () => { uniqueTurnCloses += 1; },
      );
      return Object.freeze({
        ...created,
        target: Object.freeze({ root_id: requestedRootId, runtime_generation: parseRuntimeGeneration(1) }),
        workspace: Object.freeze({ ...created.workspace, root_id: requestedRootId }),
        cycle: sharedCycle,
        turn: Object.freeze({ ...created.turn, rootId: requestedRootId }),
      });
    },
  });
  await cycleAliasRegistry.getOrCreate(rootId);
  await assert.rejects(cycleAliasRegistry.getOrCreate(wrongRoot), /root_runtime_resource_alias/u);
  assert.equal(uniqueTurnCloses, 1);
});

test("registry closes a unique Reconcill rejected by aggregate validation", async () => {
  let closes = 0;
  const registry = new RootRuntimeRegistry({
    create: async () => {
      const created = binding(
        async (input) => ({
          schema_version: 1,
          root_id: input.root_id,
          runtime_generation: input.runtime_generation,
          correlation_id: input.correlation_id,
          outcome: "quiescent",
        }),
        async () => { closes += 1; },
      );
      return Object.freeze({
        ...created,
        turn: Object.freeze({
          ...created.turn,
          runtimeGeneration: parseRuntimeGeneration(2),
        }),
      });
    },
  });

  await assert.rejects(registry.getOrCreate(rootId), /root_runtime_generation_mismatch/u);
  assert.equal(closes, 1);
});
