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
} from "../contracts/observation.js";
import {
  canonicalTaskRevision,
  parseTaskSnapshot,
  type TaskSnapshot,
} from "../contracts/task-management.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import type { CycleMachineHostInterface } from "../cycle/internal/CycleMachine.js";
import { LinearObserver } from "../task-management/linear/LinearObserver.js";
import { RootRuntimeRegistry, type RootTurnInput } from "./RootRuntimeRegistry.js";
import { SerialConductor } from "./SerialConductor.js";

const agentActor = "actor:agent";

const workflowStateFields = {
  team_id: "team:observation-loop",
  todo_state_id: "state:root:todo",
  draft_state_id: "state:cycle:draft",
  in_progress_state_id: "state:root:in-progress",
  awaiting_acceptance_state_id: "state:cycle:awaiting-acceptance",
  in_review_state_id: "state:root:in-review",
  done_state_id: "state:root:done",
  succeeded_state_id: "state:cycle:succeeded",
  rejected_state_id: "state:cycle:rejected",
  failed_state_id: "state:cycle:failed",
  canceled_state_id: "state:cycle:canceled",
} as const;
const workflowStateMap = Object.freeze({
  ...workflowStateFields,
  revision: canonicalTaskRevision(workflowStateFields),
});

function task(
  rootId: RootIssueId,
  revision: string,
  title: string,
  delegateId: string | null,
): TaskSnapshot {
  const cycleId = `${rootId}:cycle`;
  const issue = (fields: {
    readonly issue_id: string;
    readonly kind: "root" | "cycle";
    readonly status_id: string;
    readonly status: "Todo" | "Draft";
    readonly title: string;
    readonly parent_issue_id: string | null;
    readonly label_ids: readonly string[];
    readonly delegate_id: string | null;
    readonly priority: number;
  }) => {
    const canonicalFields = {
      ...fields,
      provider_created_at: "2026-07-30T10:00:00.000Z",
      provider_updated_at: "2026-07-30T10:00:00.000Z",
      creation_actor_id: agentActor,
      description_markdown: fields.kind === "root" ? "# Root" : "# Cycle",
      archived: false,
      trashed: false,
    };
    return { ...canonicalFields, revision: canonicalTaskRevision(canonicalFields) };
  };
  return parseTaskSnapshot({
    root_id: rootId,
    workflow_state_map: workflowStateMap,
    issues: [
      issue({
        issue_id: rootId,
        kind: "root",
        status_id: "state:root:todo",
        status: "Todo",
        title,
        parent_issue_id: null,
        label_ids: ["label:root"],
        delegate_id: delegateId,
        priority: 1,
      }),
      issue({
        issue_id: cycleId,
        kind: "cycle",
        status_id: "state:cycle:draft",
        status: "Draft",
        title: "Cycle",
        parent_issue_id: rootId,
        label_ids: ["label:cycle"],
        delegate_id: agentActor,
        priority: 2,
      }),
    ],
    relations: [{
      ...(() => {
        const fields = {
          relation_id: "relation:cycle-blocks-root",
          provider_created_at: "2026-07-30T10:00:00.000Z",
          provider_updated_at: "2026-07-30T10:00:00.000Z",
          creation_actor_id: agentActor,
          creation_evidence_id: "evidence:relation:cycle-blocks-root",
          type: "blocks",
          source_issue_id: cycleId,
          target_issue_id: rootId,
        };
        return { ...fields, revision: canonicalTaskRevision(fields) };
      })(),
    }],
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
  });
}

test("polling drives undelegated idle and complete fresh Root snapshots", async () => {
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
    readLatestIssueChangeOrigin: async () => null,
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
          retire: async () => undefined,
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
    workflow: {
      labels: {
        root: "label:root", cycle: "label:cycle", plan: "label:plan", work: "label:work", verify: "label:verify",
      },
      cycle_states: {
        draft: "state:cycle:draft",
        in_progress: "state:cycle:in-progress",
        awaiting_acceptance: "state:cycle:awaiting-acceptance",
        succeeded: "state:cycle:succeeded",
        rejected: "state:cycle:rejected",
        failed: "state:cycle:failed",
        canceled: "state:cycle:canceled",
      },
      stage_states: {
        todo: "state:stage:todo",
        in_progress: "state:stage:in-progress",
        done: "state:stage:done",
        failed: "state:stage:failed",
        canceled: "state:stage:canceled",
      },
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
  const fresh = turnInputs[1];
  assert.ok(fresh && "task" in fresh);
  if (!fresh || !("task" in fresh)) return;
  assert.equal(fresh.correlation_id, "corr:poll:4");
  assert.deepEqual(fresh.task, latest);
  assert.deepEqual(fresh.git, gitSnapshot);
  assert.deepEqual(await conductor.runNext(), { kind: "idle" });
  assert.equal(gitReads, 2);
  assert.equal(turnInputs.length, 2);
});
