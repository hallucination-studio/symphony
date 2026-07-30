import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../contracts/identity.js";
import { parseGitSnapshot, parseTaskObservationEvent, parseTaskSnapshot } from "../contracts/observation.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import { taskSnapshotDigest } from "../observation/TaskFacts.js";
import {
  RootRuntimeRegistry,
  type RootRuntimeBinding,
  type RootTurnInput,
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

function binding(run: (input: RootTurnInput) => Promise<unknown>): RootRuntimeBinding {
  const workspace = Object.freeze({
    root_id: rootId,
    repository_id: parseRepositoryId("repo:1"),
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
    turn: Object.freeze({ run }),
  });
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

test("runtime validates turn identity and correlation before accepting an observation", async () => {
  let outputCorrelation = parseCorrelationId("corr:poll:1");
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

  assert.equal((await runtime.run(prepared)).outcome, "quiescent");
  outputCorrelation = parseCorrelationId("corr:stale");
  await assert.rejects(runtime.run(prepared), /turn_correlation_mismatch/u);
});

test("registry rejects wrong-root and aliased turn resources", async () => {
  const wrongRoot = parseRootIssueId("LIN-2");
  const wrongRegistry = new RootRuntimeRegistry({
    create: async () => binding(async () => ({
      schema_version: 1,
      root_id: rootId,
      runtime_generation: 1,
      correlation_id: "corr:1",
      outcome: "quiescent",
    })),
  });
  await assert.rejects(wrongRegistry.getOrCreate(wrongRoot), /root_runtime_identity_mismatch/u);

  const sharedTurn = binding(async (input) => ({
    schema_version: 1,
    root_id: input.root_id,
    runtime_generation: input.runtime_generation,
    correlation_id: input.correlation_id,
    outcome: "quiescent",
  })).turn;
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
});
