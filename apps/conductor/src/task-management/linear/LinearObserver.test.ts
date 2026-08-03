import assert from "node:assert/strict";
import test from "node:test";

import { parseRootIssueId, parseTaskIssueId, type RootIssueId } from "../../contracts/identity.js";
import type { TaskChangeOriginEvidence } from "../../contracts/observation.js";
import { canonicalTaskRevision, parseTaskSnapshot, type TaskIssueSnapshot, type TaskSnapshot } from "../../contracts/task-management.js";
import { LinearObserver, type TaskObservationLog } from "./LinearObserver.js";
import type { RootInventoryItem } from "./LinearQueries.js";

function inventory(rootId: string): RootInventoryItem {
  return {
    root_id: parseRootIssueId(rootId),
    revision: `revision:${rootId}` as RootInventoryItem["revision"],
    status: "In Progress",
    priority: 1,
    created_at: "2026-07-30T00:00:00.000Z",
  };
}

function snapshot(rootId: string, options: {
  readonly childStatus?: string;
  readonly delegateId?: string | null;
  readonly relationId?: string;
  readonly includeVerify?: boolean;
  readonly reordered?: boolean;
} = {}): TaskSnapshot {
  const childId = `${rootId}:cycle`;
  const verifyId = `${rootId}:verify`;
  const delegateId = options.delegateId === undefined ? "actor:1" : options.delegateId;
  const states = {
    team_id: "team:observer", revision: `symphony:v1:${"0".repeat(64)}`,
    todo_state_id: "state:todo", draft_state_id: "state:draft",
    in_progress_state_id: "state:in-progress", awaiting_acceptance_state_id: "state:awaiting-acceptance",
    in_review_state_id: "state:in-review", done_state_id: "state:done",
    succeeded_state_id: "state:succeeded", rejected_state_id: "state:rejected",
    failed_state_id: "state:failed", canceled_state_id: "state:canceled",
  } as const;
  const canonicalIssue = (input: {
    readonly issue_id: string; readonly kind: TaskIssueSnapshot["kind"];
    readonly status: TaskIssueSnapshot["status"]; readonly status_id: string;
    readonly title: string; readonly parent_issue_id: string | null;
    readonly label_ids: readonly string[]; readonly delegate_id: string | null; readonly priority: number;
  }) => {
    const fields = {
      ...input, label_ids: [...input.label_ids].sort(), description_markdown: `# ${input.title}`,
      provider_created_at: "2026-08-03T00:00:00.000Z",
      provider_updated_at: "2026-08-03T00:00:00.000Z",
      creation_actor_id: "actor:1", archived: false, trashed: false,
    };
    return { ...fields, revision: canonicalTaskRevision(fields) };
  };
  const childStatus = (options.childStatus ?? "Todo") as TaskIssueSnapshot["status"];
  const childStateId = childStatus === "Done" ? states.done_state_id : states.todo_state_id;
  const issues = [
    canonicalIssue({
      issue_id: rootId,
      kind: "root", status: "In Progress", status_id: states.in_progress_state_id,
      title: `Root ${rootId}`,
      parent_issue_id: null,
      label_ids: options.reordered ? ["label:queued", "label:root"] : ["label:root", "label:queued"],
      delegate_id: delegateId,
      priority: 1,
    }),
    canonicalIssue({
      issue_id: childId,
      kind: "cycle", status: childStatus, status_id: childStateId,
      title: `Cycle ${rootId}`,
      parent_issue_id: rootId,
      label_ids: ["label:cycle"],
      delegate_id: "actor:1",
      priority: 2,
    }),
    ...(options.includeVerify ? [canonicalIssue({
      issue_id: verifyId,
      kind: "verify", status: "Todo", status_id: states.todo_state_id,
      title: `Verify ${rootId}`,
      parent_issue_id: childId,
      label_ids: ["label:verify"],
      delegate_id: delegateId,
      priority: 2,
    })] : []),
  ];
  const relationId = options.relationId ?? "relation:old";
  const relationFields = {
    relation_id: relationId,
    provider_created_at: "2026-08-03T00:00:00.000Z",
    provider_updated_at: "2026-08-03T00:00:00.000Z",
    creation_actor_id: "actor:1",
    creation_evidence_id: `evidence:${relationId}`,
    type: "blocks",
    source_issue_id: childId,
    target_issue_id: options.includeVerify ? verifyId : rootId,
  };
  const relations = [{ ...relationFields, revision: canonicalTaskRevision(relationFields) }];
  return parseTaskSnapshot({
    root_id: rootId,
    workflow_state_map: states,
    issues: options.reordered ? [...issues].reverse() : issues,
    relations: options.reordered ? [...relations].reverse() : relations,
    resource_creation_evidence: [], issue_history: [], issue_record_observations: [],
  });
}

class FakeObserverQueries {
  readonly readCalls: RootIssueId[] = [];
  readonly snapshots = new Map<RootIssueId, Array<TaskSnapshot | Error>>();
  inventories: Array<readonly RootInventoryItem[] | Error> = [];
  readonly origins = new Map<string, TaskChangeOriginEvidence>();

  async inventoryRoots(): Promise<readonly RootInventoryItem[]> {
    const result = this.inventories.shift();
    if (result instanceof Error) throw result;
    return result ?? [];
  }

  async readRootSnapshot(rootId: RootIssueId): Promise<TaskSnapshot> {
    this.readCalls.push(rootId);
    const result = this.snapshots.get(rootId)?.shift();
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error("missing_fake_snapshot");
    return result;
  }

  async readLatestIssueChangeOrigin(issueId: TaskSnapshot["issues"][number]["issue_id"]) {
    return this.origins.get(issueId) ?? null;
  }
}

function observer(
  queries: FakeObserverQueries,
  logs: TaskObservationLog[],
  correlations: string[],
): LinearObserver {
  let tick = 0;
  return new LinearObserver(queries, {
    log: (entry) => logs.push(entry),
    identity_factory: () => correlations.shift() ?? "corr:fallback",
    now: () => new Date(`2026-07-30T10:00:0${tick++}.000Z`),
  });
}

test("poll_once emits a complete fresh observation on every scheduled tick", async () => {
  const queries = new FakeObserverQueries();
  const rootId = parseRootIssueId("root-1");
  const initial = snapshot(rootId);
  queries.origins.set(rootId as string, {
    issue_id: parseTaskIssueId(rootId),
    change_origin: "external",
    changed_fields: ["title"],
  });
  const reordered = snapshot(rootId, { reordered: true });
  const changed = snapshot(rootId, {
    childStatus: "Done",
    delegateId: null,
    relationId: "relation:new",
    includeVerify: true,
  });
  queries.inventories = [[inventory(rootId)], [inventory(rootId)], [inventory(rootId)]];
  queries.snapshots.set(rootId, [initial, reordered, changed]);
  const logs: TaskObservationLog[] = [];
  const polls = observer(queries, logs, ["corr:1", "corr:2", "corr:3"]);

  const first = await polls.poll_once();
  assert.equal(first.length, 1);
  assert.equal(first[0]?.from_task_digest, null);
  assert.deepEqual(first[0]?.task_change_origins, [queries.origins.get(rootId as string)]);
  assert.match(first[0]?.to_task_digest ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(first[0]?.task, initial);
  assert.deepEqual(first[0]?.task_changes, []);

  const unchanged = await polls.poll_once();
  assert.equal(unchanged.length, 1);
  assert.equal(unchanged[0]?.from_task_digest, first[0]?.to_task_digest);
  assert.equal(unchanged[0]?.to_task_digest, first[0]?.to_task_digest);
  assert.deepEqual(unchanged[0]?.task, reordered);
  assert.deepEqual(unchanged[0]?.task_changes, []);

  const next = await polls.poll_once();
  assert.equal(next.length, 1);
  assert.equal(next[0]?.from_task_digest, first[0]?.to_task_digest);
  assert.notEqual(next[0]?.to_task_digest, first[0]?.to_task_digest);
  assert.deepEqual(next[0]?.task, changed);
  assert.deepEqual(next[0]?.task_changes.map((change) => change.kind), [
    "field_changed",
    "field_changed",
    "issue_created",
    "relation_added",
    "relation_removed",
  ]);
  assert.deepEqual(next[0]?.task_changes
    .filter((change) => change.kind === "field_changed")
    .map(({ issue_id, field, before, after }) => ({ issue_id, field, before, after })), [
    { issue_id: "root-1", field: "delegate", before: "actor:1", after: null },
    { issue_id: "root-1:cycle", field: "status", before: "Todo", after: "Done" },
  ]);
  assert.deepEqual(logs, [
    { event: "task_observation_poll_completed", correlation_id: "corr:1", roots_polled: 1, events_emitted: 1, failures: 0 },
    { event: "task_observation_poll_completed", correlation_id: "corr:2", roots_polled: 1, events_emitted: 1, failures: 0 },
    { event: "task_observation_poll_completed", correlation_id: "corr:3", roots_polled: 1, events_emitted: 1, failures: 0 },
  ]);
});

test("poll_once retains failed baselines and isolates inventory and Root failures", async () => {
  const queries = new FakeObserverQueries();
  const root1 = parseRootIssueId("root-1");
  const root2 = parseRootIssueId("root-2");
  const root1Initial = snapshot(root1);
  const root1Changed = snapshot(root1, { childStatus: "Done" });
  const root2Initial = snapshot(root2);
  const root2Changed = snapshot(root2, { delegateId: null });
  queries.inventories = [
    [inventory(root1), inventory(root2)],
    new Error("Authorization bearer-secret provider-stack"),
    [],
  ];
  queries.snapshots.set(root1, [
    root1Initial,
    new Error("Authorization bearer-secret provider-stack"),
    root1Changed,
  ]);
  queries.snapshots.set(root2, [root2Initial, root2Changed, root2Changed]);
  const logs: TaskObservationLog[] = [];
  const polls = observer(queries, logs, ["corr:1", "corr:2", "corr:3"]);

  const first = await polls.poll_once();
  const firstRoot1Digest = first.find(({ root_id }) => root_id === root1)?.to_task_digest;
  assert.equal(first.length, 2);

  const second = await polls.poll_once();
  assert.deepEqual(second.map(({ root_id }) => root_id), [root2]);

  const third = await polls.poll_once();
  assert.deepEqual(third.map(({ root_id }) => root_id), [root1, root2]);
  assert.equal(third[0]?.from_task_digest, firstRoot1Digest);
  assert.deepEqual(queries.readCalls, [root1, root2, root1, root2, root1, root2]);
  const failures = logs.filter((entry) => entry.event !== "task_observation_poll_completed");
  assert.deepEqual(failures, [
    { event: "task_observation_inventory_failed", correlation_id: "corr:2", reason_code: "boundary_unavailable" },
    { event: "task_observation_root_failed", correlation_id: "corr:2", root_id: root1, reason_code: "boundary_unavailable" },
  ]);
  assert.deepEqual(logs.filter((entry) => entry.event === "task_observation_poll_completed"), [
    { event: "task_observation_poll_completed", correlation_id: "corr:1", roots_polled: 2, events_emitted: 2, failures: 0 },
    { event: "task_observation_poll_completed", correlation_id: "corr:2", roots_polled: 2, events_emitted: 1, failures: 2 },
    { event: "task_observation_poll_completed", correlation_id: "corr:3", roots_polled: 2, events_emitted: 2, failures: 0 },
  ]);
  assert.equal(JSON.stringify(logs).includes("bearer-secret"), false);
  assert.equal(JSON.stringify(logs).includes("provider-stack"), false);
});
