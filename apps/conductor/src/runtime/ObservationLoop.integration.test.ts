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
  parseTaskSnapshot,
  type TaskSnapshot,
} from "../contracts/observation.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import type { CycleMachineHostInterface } from "../cycle/internal/CycleMachine.js";
import { rootObservationDigest } from "../observation/RootObservationFacts.js";
import { LinearObserver } from "../task-management/linear/LinearObserver.js";
import { RootRuntimeRegistry, type RootTurnInput } from "./RootRuntimeRegistry.js";
import { SerialConductor } from "./SerialConductor.js";

const agentActor = "actor:agent";

function task(
  rootId: RootIssueId,
  revision: string,
  title: string,
  delegateId: string | null,
): TaskSnapshot {
  const cycleId = `${rootId}:cycle`;
  return parseTaskSnapshot({
    root_id: rootId,
    issues: [
      {
        issue_id: rootId,
        revision,
        status: "state:root:todo",
        title,
        description: null,
        parent_id: null,
        labels: ["label:root"],
        delegate_id: delegateId,
        priority: 1,
      },
      {
        issue_id: cycleId,
        revision: "revision:cycle:1",
        status: "state:cycle:draft",
        title: "Cycle",
        description: null,
        parent_id: rootId,
        labels: ["label:cycle"],
        delegate_id: agentActor,
        priority: 2,
      },
    ],
    relations: [{
      relation_id: "relation:cycle-blocks-root",
      revision: "revision:relation:1",
      type: "blocks",
      source_issue_id: cycleId,
      target_issue_id: rootId,
    }],
  });
}

test("polling drives undelegated idle, bootstrap, and an accepted-baseline diff", async () => {
  const rootId = parseRootIssueId("LIN-401");
  const undelegated = task(rootId, "revision:root:1", "Undelegated", null);
  const delegated = task(rootId, "revision:root:2", "Delegated", agentActor);
  const intermediate = task(rootId, "revision:root:3", "Intermediate", agentActor);
  const latest = task(rootId, "revision:root:4", "Latest", agentActor);
  const snapshots = [undelegated, delegated, intermediate, latest];
  const correlations = ["corr:poll:1", "corr:poll:2", "corr:poll:3", "corr:poll:4"];
  const observer = new LinearObserver({
    inventoryRoots: async () => [{ root_id: rootId }],
    readRootSnapshot: async () => {
      const snapshot = snapshots.shift();
      if (snapshot === undefined) throw new Error("missing_test_snapshot");
      return snapshot;
    },
  }, {
    log: () => undefined,
    identity_factory: () => correlations.shift() ?? "corr:unexpected",
    now: () => new Date("2026-07-30T10:00:00.000Z"),
  });

  let creations = 0;
  let gitReads = 0;
  const turnInputs: RootTurnInput[] = [];
  const gitSnapshot = parseGitSnapshot({
    repository_id: parseRepositoryId("repo:observation-loop"),
    base_branch: "main",
    head_branch: createRootHeadBranch(rootId),
    head_revision: "1111111111111111111111111111111111111111",
    workspace_state: "clean",
    diff_digest: "sha256:clean",
    pull_request: null,
  });
  const registry = new RootRuntimeRegistry({
    create: async (createdRootId) => {
      creations += 1;
      const workspace = Object.freeze({
        root_id: createdRootId,
        repository_id: parseRepositoryId("repo:observation-loop"),
        base_branch: "main",
        head_branch: createRootHeadBranch(createdRootId),
      });
      return Object.freeze({
        target: Object.freeze({
          root_id: createdRootId,
          runtime_generation: parseRuntimeGeneration(1),
        }),
        workspace,
        cycle: {
          target: Object.freeze({
            root_id: createdRootId,
            runtime_generation: parseRuntimeGeneration(1),
          }),
          prepare: async () => Object.freeze({ kind: "root_available" as const }),
          prepareContinuation: async () => Object.freeze({ kind: "root_available" as const }),
          run: async () => { throw new Error("unexpected_cycle_action"); },
          retire: () => undefined,
        } satisfies CycleMachineHostInterface,
        git: {
          read: async () => {
            gitReads += 1;
            return gitSnapshot;
          },
        },
        turn: {
          rootId: createdRootId,
          runtimeGeneration: parseRuntimeGeneration(1),
          run: async (input: RootTurnInput) => {
            turnInputs.push(input);
            return {
              schema_version: 1,
              root_id: input.root_id,
              runtime_generation: input.runtime_generation,
              correlation_id: input.correlation_id,
              outcome: "quiescent",
            } as const;
          },
          close: () => Promise.resolve(),
        },
      });
    },
  });
  const conductor = new SerialConductor(registry, {
    agent_actor_id: agentActor,
    root_kind_label_id: "label:root",
    root_states: {
      todo: "state:root:todo",
      in_progress: "state:root:in-progress",
      in_review: "state:root:in-review",
      done: "state:root:done",
    },
    log: () => undefined,
  });

  conductor.admit(await observer.poll_once());
  assert.deepEqual(await conductor.runNext(), { kind: "idle" });
  assert.equal(creations, 0);
  assert.equal(gitReads, 0);
  assert.equal(turnInputs.length, 0);

  conductor.admit(await observer.poll_once());
  assert.deepEqual(await conductor.runNext(), {
    kind: "turn_completed",
    root_id: rootId,
    outcome: "quiescent",
  });
  assert.equal(creations, 1);
  assert.equal(gitReads, 1);
  const bootstrap = turnInputs[0];
  assert.ok(bootstrap && "task" in bootstrap);
  if (!bootstrap || !("task" in bootstrap)) return;
  assert.deepEqual(bootstrap, {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: parseRuntimeGeneration(1),
    correlation_id: "corr:poll:2",
    observed_at: "2026-07-30T10:00:00.000Z",
    task: delegated,
    git: gitSnapshot,
  });

  conductor.admit(await observer.poll_once());
  const latestEvents = await observer.poll_once();
  assert.deepEqual(latestEvents[0]?.task_changes, [{
    kind: "field_changed",
    issue_id: rootId,
    field: "title",
    before: "Intermediate",
    after: "Latest",
  }]);
  conductor.admit(latestEvents);

  assert.deepEqual(await conductor.runNext(), {
    kind: "turn_completed",
    root_id: rootId,
    outcome: "quiescent",
  });
  assert.equal(creations, 1);
  assert.equal(gitReads, 2);
  assert.equal(turnInputs.length, 2);
  const diff = turnInputs[1];
  assert.ok(diff && "task_changes" in diff);
  if (!diff || !("task_changes" in diff)) return;
  assert.equal(diff.correlation_id, "corr:poll:4");
  assert.equal(diff.from_observation_digest, rootObservationDigest(delegated, gitSnapshot));
  assert.equal(diff.to_observation_digest, rootObservationDigest(latest, gitSnapshot));
  assert.deepEqual(diff.task_changes, [{
    kind: "field_changed",
    issue_id: rootId,
    field: "title",
    before: "Delegated",
    after: "Latest",
  }]);
  assert.deepEqual(diff.git_changes, []);
  assert.deepEqual(await conductor.runNext(), { kind: "idle" });
  assert.equal(gitReads, 2);
  assert.equal(turnInputs.length, 2);
});
