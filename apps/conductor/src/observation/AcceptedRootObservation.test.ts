import assert from "node:assert/strict";
import test from "node:test";

import {
  parseObservationDigest,
  parseCycleIssueId,
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../contracts/identity.js";
import {
  parseGitSnapshot,
  parseTaskObservationEvent,
  type ConcreteTaskChange,
  type GitSnapshot,
} from "../contracts/observation.js";
import { canonicalTaskRevision, parseTaskSnapshot, type TaskIssueSnapshot, type TaskSnapshot } from "../contracts/task-management.js";
import type { RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import { AcceptedRootObservation } from "./AcceptedRootObservation.js";
import { rootObservationDigest } from "./RootObservationFacts.js";
import { taskSnapshotDigest } from "./TaskFacts.js";

const rootId = parseRootIssueId("LIN-1");
const target = Object.freeze({ root_id: rootId, runtime_generation: parseRuntimeGeneration(3) });
const workspace = Object.freeze({
  root_id: rootId,
  repository_id: parseRepositoryId("repo:1"),
  base_branch: "main",
  head_branch: "symphony/root-LIN-1",
}) satisfies RootWorkspaceIdentity;

interface TaskOptions {
  readonly childStatus?: string;
  readonly delegateId?: string | null;
  readonly includeVerify?: boolean;
  readonly relationId?: string;
  readonly rootRevision?: string;
  readonly reordered?: boolean;
}

function task(options: TaskOptions = {}): TaskSnapshot {
  const delegateId = options.delegateId === undefined ? "actor:1" : options.delegateId;
  const states = {
    team_id: "team:accepted", revision: `symphony:v1:${"0".repeat(64)}`,
    todo_state_id: "state:todo", draft_state_id: "state:draft",
    in_progress_state_id: "state:in-progress", awaiting_acceptance_state_id: "state:awaiting-acceptance",
    in_review_state_id: "state:in-review", done_state_id: "state:done",
    succeeded_state_id: "state:succeeded", rejected_state_id: "state:rejected",
    failed_state_id: "state:failed", canceled_state_id: "state:canceled",
  } as const;
  const canonicalIssue = (input: {
    readonly issue_id: string; readonly kind: TaskIssueSnapshot["kind"];
    readonly status: TaskIssueSnapshot["status"]; readonly status_id: string;
    readonly title: string; readonly description_markdown: string;
    readonly parent_issue_id: string | null; readonly label_ids: readonly string[];
    readonly delegate_id: string | null; readonly priority: number; readonly updated?: boolean;
  }) => {
    const { updated, ...rest } = input;
    const fields = {
      ...rest, label_ids: [...rest.label_ids].sort(),
      provider_created_at: "2026-08-03T00:00:00.000Z",
      provider_updated_at: updated === true ? "2026-08-03T00:00:01.000Z" : "2026-08-03T00:00:00.000Z",
      creation_actor_id: "actor:1", archived: false, trashed: false,
    };
    return { ...fields, revision: canonicalTaskRevision(fields) };
  };
  const childStatus = options.childStatus === "Done"
    ? "Done"
    : options.childStatus === "Verifying"
      ? "In Review"
      : "In Progress";
  const issues = [
    canonicalIssue({
      issue_id: rootId,
      kind: "root", status: "In Progress", status_id: states.in_progress_state_id,
      title: "Deliver the requested change",
      description_markdown: "# Root",
      parent_issue_id: null,
      label_ids: options.reordered ? ["label:queue", "label:root"] : ["label:root", "label:queue"],
      delegate_id: delegateId,
      priority: 1,
      updated: options.rootRevision !== undefined,
    }),
    canonicalIssue({
      issue_id: "LIN-2",
      kind: "cycle", status: childStatus,
      status_id: childStatus === "Done" ? states.done_state_id : childStatus === "In Review" ? states.in_review_state_id : states.in_progress_state_id,
      title: "Cycle 1",
      description_markdown: "# Cycle\n\nCurrent attempt",
      parent_issue_id: rootId,
      label_ids: ["label:cycle"],
      delegate_id: "actor:1",
      priority: 2,
    }),
    ...(options.includeVerify ? [canonicalIssue({
      issue_id: "LIN-3",
      kind: "verify", status: "Todo", status_id: states.todo_state_id,
      title: "Verify",
      description_markdown: "# Verify",
      parent_issue_id: "LIN-2",
      label_ids: ["label:verify"],
      delegate_id: null,
      priority: 3,
    })] : []),
  ];
  const relationId = options.relationId ?? "relation:1";
  const relationFields = {
    relation_id: relationId,
    provider_created_at: "2026-08-03T00:00:00.000Z",
    provider_updated_at: "2026-08-03T00:00:00.000Z",
    creation_actor_id: "actor:1",
    creation_evidence_id: `evidence:${relationId}`,
    type: "blocks",
    source_issue_id: "LIN-2",
    target_issue_id: options.includeVerify ? "LIN-3" : rootId,
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

interface GitOptions {
  readonly diffDigest?: string;
  readonly headRevision?: string;
  readonly workspaceState?: "clean" | "dirty";
  readonly withPullRequest?: boolean;
}

function git(options: GitOptions = {}): GitSnapshot {
  const headRevision = options.headRevision ?? "a".repeat(40);
  return parseGitSnapshot({
    repository_id: workspace.repository_id,
    base_branch: workspace.base_branch,
    head_branch: workspace.head_branch,
    head_revision: headRevision,
    workspace_state: options.workspaceState ?? "clean",
    diff_digest: options.diffDigest ?? "sha256:clean",
    pull_request: options.withPullRequest ? {
      provider: "github",
      repository_id: workspace.repository_id,
      base_branch: workspace.base_branch,
      head_branch: workspace.head_branch,
      state: "open",
      head_revision: headRevision,
      url: "https://example.invalid/pull/1",
    } : null,
  });
}

function event(
  snapshot: TaskSnapshot,
  correlationId: string,
  options: {
    readonly fromTaskDigest?: string | null;
    readonly taskChanges?: readonly ConcreteTaskChange[];
  } = {},
) {
  return parseTaskObservationEvent({
    schema_version: 1,
    root_id: rootId,
    correlation_id: correlationId,
    observed_at: "2026-07-30T10:00:00.000Z",
    from_task_digest: options.fromTaskDigest === undefined ? null : options.fromTaskDigest,
    to_task_digest: taskSnapshotDigest(snapshot),
    task: snapshot,
    task_changes: options.taskChanges ?? [],
    task_change_origins: [],
  });
}

class FakeGitReader {
  readonly calls: RootWorkspaceIdentity[] = [];
  readonly results: Array<unknown | Error> = [];

  async readRoot(identity: RootWorkspaceIdentity): Promise<GitSnapshot> {
    this.calls.push(identity);
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error("missing_fake_git_snapshot");
    return result as GitSnapshot;
  }
}

function reconciler(gitReader: FakeGitReader, correlations: string[] = []): AcceptedRootObservation {
  return new AcceptedRootObservation(target, gitReader, {
    identity_factory: () => correlations.shift() ?? "corr:internal",
  });
}

test("canonical combined digests ignore collection order and cover complete Task and Git facts", () => {
  const initialTask = task();
  const initialGit = git();
  const digest = rootObservationDigest(initialTask, initialGit);

  assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(rootObservationDigest(task({ reordered: true }), initialGit), digest);

  const changedFacts = [
    rootObservationDigest(task({ childStatus: "Done" }), initialGit),
    rootObservationDigest(task({ rootRevision: "revision:root:2" }), initialGit),
    rootObservationDigest(initialTask, git({ diffDigest: "sha256:dirty" })),
    rootObservationDigest(initialTask, git({ headRevision: "b".repeat(40) })),
    rootObservationDigest(initialTask, git({ workspaceState: "dirty" })),
    rootObservationDigest(initialTask, git({ withPullRequest: true })),
    rootObservationDigest(initialTask, initialGit, {
      disposition: "root_boundary",
      selected_route: "WF-ROUTE-002",
      active_cycle_id: parseCycleIssueId("LIN-2"),
    }),
  ];
  for (const changed of changedFacts) assert.notEqual(changed, digest);
  assert.equal(new Set(changedFacts).size, changedFacts.length);
});

test("prepare builds a complete bootstrap and only accept advances the in-memory baseline", async () => {
  const gitReader = new FakeGitReader();
  const initialTask = task();
  const initialGit = git();
  gitReader.results.push(initialGit, initialGit, initialGit);
  const observations = reconciler(gitReader);
  const initialEvent = event(initialTask, "corr:poll:1");

  const first = await observations.prepare(initialEvent, workspace);
  const unaccepted = await observations.prepare(initialEvent, workspace);
  assert.equal(first.kind, "bootstrap");
  assert.equal(unaccepted.kind, "bootstrap");
  if (first.kind !== "bootstrap") return;
  assert.deepEqual(first.root_input.task, initialTask);
  assert.deepEqual(first.root_input.git, initialGit);
  assert.equal(first.observation_digest, rootObservationDigest(initialTask, initialGit));
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.root_input));

  observations.accept(first);
  const unchanged = await observations.prepare(initialEvent, workspace);
  assert.deepEqual(unchanged, {
    kind: "unchanged",
    observation_digest: first.observation_digest,
  });
});

test("runtime diffs compare the latest complete snapshot with the accepted baseline, not polling changes", async () => {
  const gitReader = new FakeGitReader();
  const initialTask = task();
  const latestTask = task({ childStatus: "Done", delegateId: null, includeVerify: true, relationId: "relation:2" });
  const initialGit = git();
  const latestGit = git({
    diffDigest: "sha256:dirty",
    headRevision: "b".repeat(40),
    workspaceState: "dirty",
    withPullRequest: true,
  });
  gitReader.results.push(initialGit, latestGit);
  const observations = reconciler(gitReader);
  const bootstrap = await observations.prepare(event(initialTask, "corr:poll:1"), workspace);
  assert.equal(bootstrap.kind, "bootstrap");
  if (bootstrap.kind !== "bootstrap") return;
  observations.accept(bootstrap);

  const misleadingPollingChange: ConcreteTaskChange = {
    kind: "field_changed",
    issue_id: latestTask.issues[0]!.issue_id,
    field: "title",
    before: "polling-only-before",
    after: "polling-only-after",
  };
  const latestEvent = event(latestTask, "corr:poll:3", {
    fromTaskDigest: taskSnapshotDigest(task({ childStatus: "Verifying" })),
    taskChanges: [misleadingPollingChange],
  });
  const prepared = await observations.prepare(latestEvent, workspace);

  assert.equal(prepared.kind, "diff");
  if (prepared.kind !== "diff") return;
  assert.equal(prepared.root_input.from_observation_digest, bootstrap.observation_digest);
  assert.equal(prepared.root_input.to_observation_digest, prepared.observation_digest);
  assert.deepEqual(prepared.root_input.task_changes.map(({ kind }) => kind), [
    "field_changed",
    "field_changed",
    "issue_created",
    "relation_removed",
    "relation_added",
  ]);
  assert.deepEqual(prepared.root_input.task_changes
    .filter((change) => change.kind === "field_changed")
    .map(({ issue_id, field, before, after }) => ({ issue_id, field, before, after })), [
    { issue_id: rootId, field: "delegate", before: "actor:1", after: null },
    { issue_id: "LIN-2", field: "status", before: "In Progress", after: "Done" },
  ]);
  assert.deepEqual(prepared.root_input.git_changes, [
    { kind: "head_changed", before: "a".repeat(40), after: "b".repeat(40) },
    { kind: "workspace_changed", before: "clean", after: "dirty" },
    { kind: "pull_request_changed", before: null, after: "b".repeat(40) },
  ]);
  assert.equal(JSON.stringify(prepared.root_input).includes("polling-only"), false);
});

test("prepareFresh keeps later Root semantic turns on a complete snapshot", async () => {
  const gitReader = new FakeGitReader();
  const initialTask = task();
  const latestTask = task({ childStatus: "Done", includeVerify: true });
  const initialGit = git();
  const latestGit = git({ workspaceState: "dirty", diffDigest: "sha256:dirty" });
  gitReader.results.push(initialGit, latestGit);
  const observations = reconciler(gitReader);

  const bootstrap = await observations.prepareFresh(event(initialTask, "corr:fresh:1"), workspace);
  assert.equal(bootstrap.kind, "bootstrap");
  if (bootstrap.kind !== "bootstrap") return;
  observations.accept(bootstrap);

  const refreshed = await observations.prepareFresh(
    event(latestTask, "corr:fresh:2", { fromTaskDigest: taskSnapshotDigest(initialTask) }),
    workspace,
  );
  assert.equal(refreshed.kind, "semantic_snapshot");
  if (refreshed.kind !== "semantic_snapshot") return;
  assert.deepEqual(refreshed.root_input.task, latestTask);
  assert.deepEqual(refreshed.root_input.git, latestGit);
  assert.deepEqual(refreshed.root_input.routing, {
    disposition: "root_boundary",
    selected_route: "WF-ROUTE-001",
    active_cycle_id: null,
  });
  assert.equal(refreshed.root_input.notification, null);
});

test("prepareFresh emits a semantic snapshot when only routing evidence changes", async () => {
  const gitReader = new FakeGitReader();
  const initialTask = task();
  const initialGit = git();
  gitReader.results.push(initialGit, initialGit, initialGit);
  const observations = reconciler(gitReader);
  const initialEvent = event(initialTask, "corr:routing:1");

  const bootstrap = await observations.prepareFresh(initialEvent, workspace);
  assert.equal(bootstrap.kind, "bootstrap");
  if (bootstrap.kind !== "bootstrap") return;
  observations.accept(bootstrap);

  const routed = await observations.prepareFresh(initialEvent, workspace, {
    disposition: "root_boundary",
    selected_route: "WF-ROUTE-002",
    active_cycle_id: parseCycleIssueId("LIN-2"),
  });
  assert.equal(routed.kind, "semantic_snapshot");
  if (routed.kind !== "semantic_snapshot") return;
  assert.deepEqual(routed.root_input.routing, {
    disposition: "root_boundary",
    selected_route: "WF-ROUTE-002",
    active_cycle_id: "LIN-2",
  });
  assert.notEqual(routed.observation_digest, bootstrap.observation_digest);
  observations.accept(routed);

  const ordinaryCycleTurn = await observations.prepare(initialEvent, workspace);
  assert.deepEqual(ordinaryCycleTurn, {
    kind: "unchanged",
    observation_digest: routed.observation_digest,
  });
});

test("failed preparation is sanitized and leaves the last accepted snapshot adjacent", async () => {
  const gitReader = new FakeGitReader();
  const initialTask = task();
  const latestTask = task({ childStatus: "Done" });
  const initialGit = git();
  const latestGit = git({ workspaceState: "dirty", diffDigest: "sha256:dirty" });
  gitReader.results.push(
    initialGit,
    new Error("Authorization bearer-secret provider-stack"),
    { ...latestGit, repository_id: "repo:foreign" },
    { ...latestGit, head_revision: null },
    latestGit,
  );
  const observations = reconciler(gitReader, ["corr:invalid-task"]);
  const bootstrap = await observations.prepare(event(initialTask, "corr:poll:1"), workspace);
  assert.equal(bootstrap.kind, "bootstrap");
  if (bootstrap.kind !== "bootstrap") return;
  observations.accept(bootstrap);

  const invalidTask = {
    ...event(latestTask, "corr:poll:2", { fromTaskDigest: taskSnapshotDigest(initialTask) }),
    to_task_digest: "sha256:forged",
  };
  const taskFailure = await observations.prepare(invalidTask, workspace);
  assert.equal(taskFailure.kind, "paused");
  if (taskFailure.kind !== "paused") return;
  assert.equal(taskFailure.error.code, "invalid_contract");
  assert.equal(taskFailure.error.reason, "task_digest_mismatch");
  assert.equal(taskFailure.error.correlation_id, "corr:poll:2");

  const gitFailure = await observations.prepare(
    event(latestTask, "corr:poll:3", { fromTaskDigest: taskSnapshotDigest(initialTask) }),
    workspace,
  );
  assert.equal(gitFailure.kind, "paused");
  if (gitFailure.kind !== "paused") return;
  assert.equal(gitFailure.error.code, "boundary_unavailable");
  assert.equal(gitFailure.error.reason, "git_read_unavailable");
  assert.equal(JSON.stringify(gitFailure).includes("bearer-secret"), false);
  assert.equal(JSON.stringify(gitFailure).includes("provider-stack"), false);

  const identityFailure = await observations.prepare(
    event(latestTask, "corr:poll:4", { fromTaskDigest: taskSnapshotDigest(initialTask) }),
    workspace,
  );
  assert.equal(identityFailure.kind, "paused");
  if (identityFailure.kind !== "paused") return;
  assert.equal(identityFailure.error.code, "invalid_contract");
  assert.equal(identityFailure.error.reason, "git_snapshot_identity_mismatch");

  const missingHead = await observations.prepare(
    event(latestTask, "corr:poll:5", { fromTaskDigest: taskSnapshotDigest(initialTask) }),
    workspace,
  );
  assert.equal(missingHead.kind, "paused");
  if (missingHead.kind !== "paused") return;
  assert.equal(missingHead.error.code, "invalid_contract");
  assert.equal(missingHead.error.reason, "git_head_missing");

  const recovered = await observations.prepare(
    event(latestTask, "corr:poll:6", { fromTaskDigest: taskSnapshotDigest(initialTask) }),
    workspace,
  );
  assert.equal(recovered.kind, "diff");
  if (recovered.kind !== "diff") return;
  assert.equal(recovered.root_input.from_observation_digest, bootstrap.observation_digest);
  assert.equal(gitReader.calls.length, 5);
});

test("restart cannot reconstruct accepted snapshots from a digest and emits a fresh complete bootstrap", async () => {
  const initialTask = task();
  const initialGit = git();
  const initialEvent = event(initialTask, "corr:poll:1");
  const firstReader = new FakeGitReader();
  firstReader.results.push(initialGit);
  const firstRuntime = reconciler(firstReader);
  const first = await firstRuntime.prepare(initialEvent, workspace);
  assert.equal(first.kind, "bootstrap");
  if (first.kind !== "bootstrap") return;
  firstRuntime.accept(first);

  const persistedContinuity = Object.freeze({ accepted_observation_digest: first.observation_digest });
  assert.deepEqual(Object.keys(persistedContinuity), ["accepted_observation_digest"]);
  assert.equal(JSON.stringify(persistedContinuity).includes("Deliver the requested change"), false);

  const restartedReader = new FakeGitReader();
  restartedReader.results.push(initialGit);
  const restartedRuntime = reconciler(restartedReader);
  const restarted = await restartedRuntime.prepare(initialEvent, workspace);
  assert.equal(restarted.kind, "bootstrap");
  if (restarted.kind !== "bootstrap") return;
  assert.equal(restarted.observation_digest, persistedContinuity.accepted_observation_digest);
  assert.deepEqual(restarted.root_input.task, initialTask);
  assert.deepEqual(restarted.root_input.git, initialGit);
});

test("accept rejects stale, foreign, and fabricated candidates", async () => {
  const gitReader = new FakeGitReader();
  const initialTask = task();
  const initialGit = git();
  gitReader.results.push(initialGit, initialGit);
  const observations = reconciler(gitReader);
  const first = await observations.prepare(event(initialTask, "corr:poll:1"), workspace);
  const second = await observations.prepare(event(initialTask, "corr:poll:2"), workspace);
  assert.equal(first.kind, "bootstrap");
  assert.equal(second.kind, "bootstrap");
  if (first.kind !== "bootstrap" || second.kind !== "bootstrap") return;
  observations.accept(second);
  assert.throws(() => observations.accept(first), /stale_observation_candidate/u);

  const otherReader = new FakeGitReader();
  otherReader.results.push(initialGit);
  const other = reconciler(otherReader);
  const foreign = await other.prepare(event(initialTask, "corr:poll:3"), workspace);
  assert.equal(foreign.kind, "bootstrap");
  if (foreign.kind !== "bootstrap") return;
  assert.throws(() => observations.accept(foreign), /foreign_observation_candidate/u);
  assert.throws(
    () => observations.accept({
      kind: "bootstrap",
      observation_digest: parseObservationDigest("sha256:fabricated"),
      root_input: second.root_input,
    }),
    /invalid_observation_candidate/u,
  );
});
