import assert from "node:assert/strict";
import test from "node:test";

import type {
  CycleCompletionRecord,
  DeliveryCompletionRecord,
  DeliveryInvalidationRecord,
} from "../contracts/cycle-records.js";
import {
  parseDeliveryCompletionRecord,
  parseDeliveryInvalidationRecord,
} from "../contracts/cycle-records.js";
import {
  parseCorrelationId,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskIssueId,
  parseTaskLabelId,
  parseTaskStateId,
} from "../contracts/identity.js";
import type { PullRequestSnapshot } from "../contracts/observation.js";
import {
  canonicalTaskRevision,
  parseTaskIssueSnapshotChange,
  type TaskIssueSnapshot,
  type TaskSnapshot,
} from "../contracts/task-management.js";
import { parseMarkdownText } from "../contracts/validation.js";
import type {
  DeliverRevisionRequest,
  DeliveryIdentity,
  DeliveryInterface,
  DeliveryObservation,
} from "../delivery/api/DeliveryInterface.js";
import { createDeliveryIdentity } from "../delivery/api/DeliveryInterface.js";
import type { MutationResult, MutationOutcome } from "../contracts/mutation.js";
import type {
  TaskManageCommandInterface,
  TaskManageExecution,
} from "../task-management/api/TaskManageCommandInterface.js";
import { createTaskManageCallerAuthority } from "../task-management/api/TaskManageCapability.js";
import {
  TASK_MCP_CAPABILITIES,
  parseTaskMcpResult,
  type GetIssueCall,
  type UpdateIssueCall,
} from "../task-management/mcp/TaskMcpSchemas.js";
import { AcceptedRevisionDeliveryCoordinator } from "./AcceptedRevisionDelivery.js";
import type {
  DeliveryCompletionWriteInput,
  DeliveryRecordState,
  DeliveryInvalidationWriteInput,
  DeliveryTerminalRecordStore,
} from "./DeliveryTerminalRecord.js";
import {
  createAcceptedRevisionAuthority,
  type AcceptedRevisionAuthorization,
} from "./RootAcceptedRevision.js";
import { parseRootAcceptanceView } from "./RootToolBoundary.js";

const rootId = parseRootIssueId("ROOT-D5");
const generation = parseRuntimeGeneration(5);
const correlationId = parseCorrelationId("delivery:d5");
const revision = parseRevision("a".repeat(40));
const otherRevision = parseRevision("b".repeat(40));
const rootLabel = parseTaskLabelId("label:root");
const rootInProgress = parseTaskStateId("state:root-in-progress");
const rootInReview = parseTaskStateId("state:root-in-review");
const rootDone = parseTaskStateId("state:root-done");
const rootFailed = parseTaskStateId("state:cycle-failed");
const identity = createDeliveryIdentity({
  provider: "github",
  root_id: rootId,
  repository_id: parseRepositoryId("repo:d5"),
  base_branch: "main",
});
const acceptanceView = parseRootAcceptanceView({
  schema_version: 1,
  cycle_id: "CYCLE-D5",
  cycle_revision: "revision:cycle:succeeded",
  cycle_seal_digest: "1".repeat(64),
  graph_seal_digest: "2".repeat(64),
  repository_id: identity.repository_id,
  base_branch: identity.base_branch,
  head_branch: identity.head_branch,
  exact_revision: revision,
  workspace_state: "clean",
  diff_digest: "sha256:d5-verified-diff",
  verify_issue_id: "VERIFY-D5",
  verify_issue_revision: "revision:verify:done",
});

function pullRequest(
  headRevision = revision,
  state: PullRequestSnapshot["state"] = "open",
): PullRequestSnapshot {
  return {
    provider: identity.provider,
    repository_id: identity.repository_id,
    base_branch: identity.base_branch,
    head_branch: identity.head_branch,
    state,
    head_revision: headRevision,
    url: "https://github.example/pull/5",
  };
}

function mutation(
  request: DeliverRevisionRequest,
  outcome: MutationOutcome,
): MutationResult {
  return outcome === "applied"
    ? {
        schema_version: 1,
        outcome,
        target_id: request.identity.root_id,
        correlation_id: request.correlation_id,
      }
    : {
        schema_version: 1,
        outcome,
        target_id: request.identity.root_id,
        correlation_id: request.correlation_id,
        reason: "provider_outcome",
      };
}

class FakeDelivery implements DeliveryInterface {
  remoteRevision: DeliveryObservation["remote_revision"] = null;
  pullRequests: PullRequestSnapshot[] = [];
  pushOutcome: MutationOutcome = "applied";
  createOutcome: MutationOutcome = "applied";
  materializePush = true;
  materializePullRequest = true;
  readonly effects: string[] = [];

  read(received: DeliveryIdentity): Promise<DeliveryObservation> {
    assert.deepEqual(received, identity);
    this.effects.push("delivery:read");
    return Promise.resolve({
      identity: received,
      remote_revision: this.remoteRevision,
      matching_pull_requests: [...this.pullRequests],
    });
  }

  push(request: DeliverRevisionRequest): Promise<MutationResult> {
    this.effects.push("delivery:push");
    assert.equal(request.verified_revision, revision);
    assert.equal(request.expected_remote_revision, null);
    if (this.materializePush) this.remoteRevision = request.verified_revision;
    return Promise.resolve(mutation(request, this.pushOutcome));
  }

  createPullRequest(request: DeliverRevisionRequest): Promise<MutationResult> {
    this.effects.push("delivery:create_pull_request");
    assert.equal(request.verified_revision, revision);
    assert.equal(request.expected_remote_revision, revision);
    if (this.materializePullRequest) this.pullRequests = [pullRequest(request.verified_revision)];
    return Promise.resolve(mutation(request, this.createOutcome));
  }
}

function rootIssue(
  statusId = rootInProgress,
  title = "D5 Root",
): TaskIssueSnapshot {
  const status: TaskIssueSnapshot["status"] = statusId === rootInReview
    ? "In Review"
    : statusId === rootDone ? "Done" : statusId === rootFailed ? "Failed" : "In Progress";
  const fields = {
    issue_id: parseTaskIssueId(rootId),
    provider_created_at: "2026-08-03T00:00:00.000Z",
    provider_updated_at: "2026-08-03T00:00:00.000Z",
    creation_actor_id: "actor:symphony",
    kind: "root",
    status_id: statusId,
    status,
    title,
    description_markdown: parseMarkdownText("# Root\n\nDeliver the accepted revision."),
    parent_issue_id: null,
    label_ids: [rootLabel],
    delegate_id: "agent:symphony",
    priority: 1,
    archived: false,
    trashed: false,
  };
  return parseTaskIssueSnapshotChange({
    ...fields,
    revision: canonicalTaskRevision(fields),
  });
}

class FakeTaskManager implements TaskManageCommandInterface {
  current = rootIssue();
  updateOutcome: "applied" | "conflict_observed" = "applied";
  materializeUpdate = true;
  substituteAppliedReceipt = false;
  readonly effects: string[] = [];
  readonly callerAuthority = createTaskManageCallerAuthority();

  get_issue(call: GetIssueCall, execution: TaskManageExecution) {
    this.callerAuthority.verifier.assert(execution.caller, call);
    this.effects.push("task:get_issue");
    return Promise.resolve(parseTaskMcpResult({
      schema_version: 1,
      function: "get_issue",
      root_id: rootId,
      runtime_generation: generation,
      correlation_id: correlationId,
      capability: TASK_MCP_CAPABILITIES.get_issue,
      output: { issue: this.current },
    }, call));
  }

  update_issue(call: UpdateIssueCall, execution: TaskManageExecution) {
    this.callerAuthority.verifier.assert(execution.caller, call);
    this.effects.push("task:update_issue");
    assert.equal(call.input.issue_id, rootId);
    assert.equal(call.input.expected_revision, this.current.revision);
    assert.ok(call.input.desired.state_id === rootInReview || call.input.desired.state_id === rootFailed);
    const before = this.current;
    if (this.materializeUpdate) {
      this.current = rootIssue(call.input.desired.state_id);
    }
    const receiptResource = this.substituteAppliedReceipt
      ? rootIssue(call.input.desired.state_id, "Substituted Root")
      : this.current;
    return Promise.resolve(parseTaskMcpResult({
      schema_version: 1,
      function: "update_issue",
      root_id: rootId,
      runtime_generation: generation,
      correlation_id: correlationId,
      capability: TASK_MCP_CAPABILITIES.update_issue,
      output: {
        outcome: this.updateOutcome,
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: rootId },
        fresh_resource: this.updateOutcome === "applied" ? receiptResource : null,
        concrete_diff: this.updateOutcome === "applied" ? [{
          kind: "field_changed",
          issue_id: rootId,
          field: "status",
          before: before.status_id,
          after: this.current.status_id,
        }] : [],
        sanitized_reason: this.updateOutcome === "applied" ? null : "provider_outcome",
      },
    }, call));
  }

  list_issues = unexpected("list_issues");
  list_children = unexpected("list_children");
  create_issue = unexpected("create_issue");
  archive_issue = unexpected("archive_issue");
  list_relations = unexpected("list_relations");
  create_relation = unexpected("create_relation");
  delete_relation = unexpected("delete_relation");
  list_states = unexpected("list_states");
  list_labels = unexpected("list_labels");
}

const cycleId = parseTaskIssueId(acceptanceView.cycle_id);
const acceptedCycle = Object.freeze({
  record_id: "record:cycle:accepted:d5",
  revision: `symphony:v1:${"3".repeat(64)}`,
  issue_id: cycleId,
  cycle_id: cycleId,
  actor_id: "actor:symphony",
  created_at: "2026-08-03T00:00:00.000Z",
  updated_at: "2026-08-03T00:00:00.000Z",
  archived_at: null,
  basis_issue_revision: `symphony:v1:${"4".repeat(64)}`,
  basis_status: "Awaiting Acceptance" as const,
  basis_document_digest: "5".repeat(64),
  record_kind: "cycle_completion" as const,
  successor_policy: "not_applicable" as const,
  completion: {
    outcome: "accepted" as const,
    specification_seal_digest: acceptanceView.cycle_seal_digest,
    graph_seal_digest: acceptanceView.graph_seal_digest,
    acceptance_basis_digest: "6".repeat(64),
    stage_revisions: [{
      issue_id: "STAGE-D5",
      revision: `symphony:v1:${"7".repeat(64)}`,
      terminal_record_digest: "8".repeat(64),
    }],
    stage_completion_digests: [{ issue_id: "STAGE-D5", digest: "9".repeat(64) }],
    exact_revision: "a".repeat(64),
    acceptance_convergence_proof: {
      proof_scope: "acceptance",
      first_round: {
        linear_snapshot_digest: "1".repeat(64),
        linear_observed_at: "2026-08-03T00:00:00.000Z",
        git_exact_revision: "a".repeat(64),
        git_observed_at: "2026-08-03T00:00:00.000Z",
        root_revision: `symphony:v1:${"4".repeat(64)}`,
      },
      second_round: {
        linear_snapshot_digest: "1".repeat(64),
        linear_observed_at: "2026-08-03T00:00:01.000Z",
        git_exact_revision: "a".repeat(64),
        git_observed_at: "2026-08-03T00:00:01.000Z",
        root_revision: `symphony:v1:${"4".repeat(64)}`,
      },
      observation_order: "linear -> git -> linear -> git",
      stable_decision_basis_digest: "2".repeat(64),
    },
    acceptance_markdown: "Accepted.",
  },
} as unknown as Extract<CycleCompletionRecord, { readonly successor_policy: "not_applicable" }>);

const approval = Object.freeze({
  record_id: "record:cycle:approval:d5",
  revision: `symphony:v1:${"1".repeat(64)}`,
  issue_id: cycleId,
  cycle_id: cycleId,
  actor_id: "actor:symphony",
  created_at: "2026-08-03T00:00:00.000Z",
  updated_at: "2026-08-03T00:00:00.000Z",
  archived_at: null,
  basis_issue_revision: `symphony:v1:${"2".repeat(64)}`,
  basis_status: "Draft" as const,
  basis_document_digest: "3".repeat(64),
  record_kind: "cycle_approval" as const,
  identity_derivation_version: "symphony-identity:v1",
  predecessor_cycle_issue_id: null,
  predecessor_terminal_record_id: "record:cycle:first",
  plan_issue_id: "PLAN-D5",
  plan_completion_record_id: "record:plan:completion:d5",
  plan_invalidation_record_id: "record:plan:invalidation:d5",
  cycle_completion_record_id: acceptedCycle.record_id,
  cycle_invalidation_record_id: "record:cycle:invalidation:d5",
  delivery_completion_record_id: "record:delivery:completion:d5",
  delivery_invalidation_record_id: "record:delivery:invalidation:d5",
  specification_seal_digest: acceptanceView.cycle_seal_digest,
  workspace_base_revision: "4".repeat(64),
} as const);

function cycleIssue(): TaskIssueSnapshot {
  const fields = {
    issue_id: cycleId,
    provider_created_at: "2026-08-03T00:00:00.000Z",
    provider_updated_at: "2026-08-03T00:00:00.000Z",
    creation_actor_id: "actor:symphony",
    kind: "cycle" as const,
    status_id: parseTaskStateId("state:cycle-succeeded"),
    status: "Succeeded" as const,
    title: "D5 Cycle",
    description_markdown: parseMarkdownText("# Cycle\n\nAccepted."),
    parent_issue_id: parseTaskIssueId(rootId),
    label_ids: [parseTaskLabelId("label:cycle")],
    delegate_id: "agent:symphony",
    priority: 1,
    archived: false,
    trashed: false,
  };
  return parseTaskIssueSnapshotChange({ ...fields, revision: canonicalTaskRevision(fields) });
}

function deliverySnapshot(root: TaskIssueSnapshot, terminal: readonly unknown[] = []): TaskSnapshot {
  return {
    root_id: parseRootIssueId(rootId),
    workflow_state_map: {} as TaskSnapshot["workflow_state_map"],
    issues: [root, cycleIssue()],
    relations: [],
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [approval, acceptedCycle, ...terminal] as TaskSnapshot["issue_record_observations"],
  };
}

class FakeDeliveryRecordStore implements DeliveryTerminalRecordStore {
  invalidationRecord: DeliveryInvalidationRecord | null = null;
  completionRecord: DeliveryCompletionRecord | null = null;
  completionSlotInvalid = false;
  readCount = 0;
  mismatchAfterFirstRead = false;
  lastCompletionInput: DeliveryCompletionWriteInput | null = null;
  lastInvalidationInput: DeliveryInvalidationWriteInput | null = null;

  constructor(readonly task: FakeTaskManager) {}

  async read(): Promise<DeliveryRecordState> {
    this.readCount += 1;
    const root = this.task.current;
    const basis = {
      root,
      cycle: cycleIssue(),
      approval_record: approval as unknown as DeliveryRecordState["basis"]["approval_record"],
      accepted_record: acceptedCycle,
      accepted_record_digest: "a".repeat(64),
      acceptance_basis_digest: acceptedCycle.completion.acceptance_basis_digest,
      delivery_completion_record_id: approval.delivery_completion_record_id,
      delivery_invalidation_record_id: approval.delivery_invalidation_record_id,
      root_document_digest: "b".repeat(64),
      linear_snapshot_digest: this.mismatchAfterFirstRead && this.readCount >= 3
        ? "c".repeat(64) : "d".repeat(64),
    } as DeliveryRecordState["basis"];
    const completionSlot = this.completionSlotInvalid
      ? { state: "invalid" as const, observation_digest: "e".repeat(64) }
      : this.completionRecord === null
        ? { state: "empty" as const }
        : { state: "completion" as const, record: this.completionRecord };
    const invalidationSlot = this.invalidationRecord === null
      ? { state: "empty" as const }
      : { state: "invalidation" as const, record: this.invalidationRecord };
    return {
      snapshot: deliverySnapshot(root),
      basis,
      completion_slot: completionSlot,
      invalidation_slot: invalidationSlot,
    };
  }

  async writeCompletion(input: DeliveryCompletionWriteInput) {
    this.lastCompletionInput = input;
    this.completionRecord = {
      ...acceptedCycle,
      record_id: input.state.basis.delivery_completion_record_id,
      issue_id: parseTaskIssueId(rootId),
      cycle_id: cycleId,
      basis_issue_revision: input.state.basis.root.revision,
      basis_status: "In Review",
      basis_document_digest: input.state.basis.root_document_digest,
      record_kind: "delivery_completion",
      root_id: rootId,
      accepted_cycle_id: cycleId,
      exact_revision: "a".repeat(64),
      accepted_record_digest: input.state.basis.accepted_record_digest,
      acceptance_basis_digest: input.state.basis.acceptance_basis_digest,
      observed_root_status: "In Review",
      observed_remote_revision: "a".repeat(64),
      observed_pull_request_identity: "https://github.example/pull/5",
      observed_pull_request_head: "a".repeat(64),
      convergence_proof: input.convergence_proof,
    } as unknown as DeliveryCompletionRecord;
    return this.completionRecord as ReturnType<typeof parseDeliveryCompletionRecord>;
  }

  async writeInvalidation(input: DeliveryInvalidationWriteInput) {
    this.lastInvalidationInput = input;
    this.invalidationRecord = {
      ...acceptedCycle,
      record_id: input.state.basis.delivery_invalidation_record_id,
      issue_id: parseTaskIssueId(rootId),
      cycle_id: cycleId,
      basis_issue_revision: input.state.basis.root.revision,
      basis_status: input.state.basis.root.status,
      basis_document_digest: input.state.basis.root_document_digest,
      record_kind: "delivery_invalidation",
      root_id: rootId,
      accepted_cycle_id: cycleId,
      exact_revision: "a".repeat(64),
      accepted_record_digest: input.state.basis.accepted_record_digest,
      acceptance_basis_digest: input.state.basis.acceptance_basis_digest,
      observed_root_status: input.state.basis.root.status,
      observed_remote_revision: input.observation.remote_revision === null ? null : "a".repeat(64),
      observed_pull_request_identity: input.observation.pull_request?.url ?? null,
      observed_pull_request_head: input.observation.pull_request === null ? null : "a".repeat(64),
      invalidation_evidence: input.invalidation_evidence,
      resolution_policy: "permanently_quarantined",
      reason_code: input.reason_code,
      reason_markdown: input.reason_markdown,
    } as unknown as DeliveryInvalidationRecord;
    return this.invalidationRecord as ReturnType<typeof parseDeliveryInvalidationRecord>;
  }
}

function unexpected(name: string) {
  return async (): Promise<never> => {
    throw new Error(`unexpected_${name}`);
  };
}

function fixture() {
  const acceptedRevision = createAcceptedRevisionAuthority();
  const authorization = acceptedRevision.issuer.issue({
    root_id: rootId,
    runtime_generation: generation,
    acceptance_view: acceptanceView,
  });
  const delivery = new FakeDelivery();
  const task = new FakeTaskManager();
  const recordStore = new FakeDeliveryRecordStore(task);
  const coordinator = new AcceptedRevisionDeliveryCoordinator({
    provider: "github",
    root_label_id: rootLabel,
    root_in_progress_state: rootInProgress,
    root_in_review_state: rootInReview,
    root_failed_state: rootFailed,
    accepted_revision_verifier: acceptedRevision.verifier,
    task_caller_issuer: task.callerAuthority.issuer,
    task_manager: task,
    delivery,
    record_store: recordStore,
  });
  return { authorization, acceptedRevision, delivery, task, recordStore, coordinator };
}

const liveExecution = Object.freeze({ assertActive: () => undefined });

test("accepted revision delivery uses only acceptance-time evidence and fresh exact read-backs", async () => {
  const f = fixture();
  f.delivery.pushOutcome = "acceptance_unknown";
  f.delivery.createOutcome = "acceptance_unknown";
  f.task.updateOutcome = "conflict_observed";

  const result = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);

  assert.equal(result.outcome, "delivered");
  if (result.outcome === "delivered") {
    assert.equal(result.exact_revision, revision);
    assert.equal(result.pull_request.head_revision, revision);
    assert.equal(result.root_revision, f.task.current.revision);
  }
  assert.deepEqual(f.delivery.effects, [
    "delivery:read",
    "delivery:push",
    "delivery:read",
    "delivery:create_pull_request",
    "delivery:read",
    "delivery:read",
    "delivery:read",
    "delivery:read",
  ]);
  assert.deepEqual(f.task.effects, ["task:get_issue", "task:update_issue", "task:get_issue"]);
  assert.equal(f.recordStore.lastCompletionInput?.convergence_proof.proof_scope, "delivery");
  assert.equal(
    f.recordStore.lastCompletionInput?.convergence_proof.observation_order,
    "linear -> git -> delivery -> linear -> git -> delivery",
  );
});

test("delivery conflicts never replace a remote revision or pull request", async (context) => {
  const cases: readonly {
    readonly name: string;
    readonly arrange: (delivery: FakeDelivery) => void;
    readonly reason: string;
  }[] = [
    {
      name: "remote revision differs",
      arrange: (delivery) => { delivery.remoteRevision = otherRevision; },
      reason: "remote_revision_conflict",
    },
    {
      name: "closed pull request exists",
      arrange: (delivery) => {
        delivery.remoteRevision = revision;
        delivery.pullRequests = [pullRequest(revision, "closed")];
      },
      reason: "pull_request_conflict",
    },
    {
      name: "pull request points at another revision",
      arrange: (delivery) => {
        delivery.remoteRevision = revision;
        delivery.pullRequests = [pullRequest(otherRevision)];
      },
      reason: "pull_request_conflict",
    },
    {
      name: "matching pull request identity is ambiguous",
      arrange: (delivery) => {
        delivery.remoteRevision = revision;
        delivery.pullRequests = [pullRequest(), { ...pullRequest(), url: "https://github.example/pull/6" }];
      },
      reason: "pull_request_conflict",
    },
  ];

  for (const entry of cases) await context.test(entry.name, async () => {
    const f = fixture();
    entry.arrange(f.delivery);
    const result = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);
    assert.deepEqual(result, {
      outcome: "not_delivered",
      root_id: rootId,
      cycle_id: acceptanceView.cycle_id,
      exact_revision: revision,
      reason_code: entry.reason,
    });
    assert.deepEqual(f.delivery.effects, ["delivery:read"]);
    assert.deepEqual(f.task.effects, []);
  });
});

test("unknown delivery and Root mutations are read once and never retried", async (context) => {
  await context.test("unconfirmed push", async () => {
    const f = fixture();
    f.delivery.pushOutcome = "acceptance_unknown";
    f.delivery.materializePush = false;
    const result = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);
    assert.equal(result.outcome, "not_delivered");
    assert.equal(result.reason_code, "push_unconfirmed");
    assert.deepEqual(f.delivery.effects, ["delivery:read", "delivery:push", "delivery:read"]);
    assert.deepEqual(f.task.effects, []);
  });

  await context.test("unconfirmed pull request", async () => {
    const f = fixture();
    f.delivery.createOutcome = "acceptance_unknown";
    f.delivery.materializePullRequest = false;
    const result = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);
    assert.equal(result.outcome, "not_delivered");
    assert.equal(result.reason_code, "pull_request_unconfirmed");
    assert.equal(f.delivery.effects.filter((effect) => effect === "delivery:create_pull_request").length, 1);
    assert.deepEqual(f.task.effects, []);
  });

  await context.test("unconfirmed Root transition", async () => {
    const f = fixture();
    f.delivery.remoteRevision = revision;
    f.delivery.pullRequests = [pullRequest()];
    f.task.updateOutcome = "conflict_observed";
    f.task.materializeUpdate = false;
    const result = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);
    assert.equal(result.outcome, "not_delivered");
    assert.equal(result.reason_code, "root_update_unconfirmed");
    assert.equal(f.task.effects.filter((effect) => effect === "task:update_issue").length, 1);
  });
});

test("forged accepted revision evidence is denied before external effects", async () => {
  const f = fixture();
  const forged = Object.freeze({ ...f.authorization }) as AcceptedRevisionAuthorization;

  await assert.rejects(
    f.coordinator.deliver(forged, correlationId, liveExecution),
    /invalid_accepted_revision_authorization/u,
  );
  assert.deepEqual(f.delivery.effects, []);
  assert.deepEqual(f.task.effects, []);
});

test("a substituted Root mutation receipt fails closed even when the later status happens to match", async () => {
  const f = fixture();
  f.delivery.remoteRevision = revision;
  f.delivery.pullRequests = [pullRequest()];
  f.task.substituteAppliedReceipt = true;

  const result = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);

  assert.equal(result.outcome, "not_delivered");
  assert.equal(result.reason_code, "invalid_contract");
  assert.deepEqual(f.task.effects, ["task:get_issue", "task:update_issue", "task:get_issue"]);
});

test("a conflicting Root status cannot be replaced after exact delivery", async () => {
  const f = fixture();
  f.delivery.remoteRevision = revision;
  f.delivery.pullRequests = [pullRequest()];
  f.task.current = rootIssue(rootDone);

  const result = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);

  assert.equal(result.outcome, "not_delivered");
  assert.equal(result.reason_code, "delivery_invalidated");
  assert.deepEqual(f.task.effects, ["task:get_issue"]);
  assert.equal(f.recordStore.invalidationRecord?.reason_code, "root_done_before_completion");
  assert.equal(f.task.current.status, "Done");
});

test("delivery invalidation is followed by an exact Root Failed projection", async () => {
  const f = fixture();
  f.recordStore.mismatchAfterFirstRead = true;

  const result = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);

  assert.equal(result.outcome, "not_delivered");
  assert.equal(result.reason_code, "delivery_invalidated");
  assert.equal(f.recordStore.invalidationRecord?.record_kind, "delivery_invalidation");
  assert.equal(f.task.current.status_id, rootFailed);
  assert.equal(f.task.current.status, "Failed");
  assert.equal(f.task.effects.filter((effect) => effect === "task:update_issue").length, 2);
});

test("a persisted delivery invalidation exposes an unconfirmed Root Failed projection", async () => {
  const f = fixture();
  f.task.current = rootIssue(rootInReview);
  f.delivery.remoteRevision = revision;
  f.delivery.pullRequests = [pullRequest()];
  f.recordStore.mismatchAfterFirstRead = true;
  f.task.materializeUpdate = false;

  const result = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);

  assert.equal(result.outcome, "not_delivered");
  assert.equal(result.reason_code, "root_failure_projection_unconfirmed");
  assert.equal(f.recordStore.invalidationRecord?.record_kind, "delivery_invalidation");
  assert.equal(f.task.current.status, "In Review");
});

test("restart projects a persisted delivery invalidation without repeating delivery effects", async () => {
  const f = fixture();
  f.task.current = rootIssue(rootInReview);
  f.delivery.remoteRevision = revision;
  f.delivery.pullRequests = [pullRequest()];
  f.recordStore.mismatchAfterFirstRead = true;
  f.task.materializeUpdate = false;

  const first = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);
  assert.equal(first.outcome, "not_delivered");
  assert.equal(first.reason_code, "root_failure_projection_unconfirmed");
  const deliveryEffectsBeforeRestart = [...f.delivery.effects];

  f.task.materializeUpdate = true;
  const restarted = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);

  assert.equal(restarted.outcome, "not_delivered");
  assert.equal(restarted.reason_code, "delivery_invalidated");
  assert.equal(f.task.current.status_id, rootFailed);
  assert.deepEqual(f.delivery.effects, deliveryEffectsBeforeRestart);
});

test("delivery convergence mismatch writes one Root-attached invalidation and never retries effects", async () => {
  const f = fixture();
  f.recordStore.mismatchAfterFirstRead = true;

  const result = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);

  assert.equal(result.outcome, "not_delivered");
  assert.equal(result.reason_code, "delivery_invalidated");
  assert.equal(f.recordStore.lastInvalidationInput?.invalidation_evidence.kind, "convergence_mismatch");
  assert.equal(f.recordStore.completionRecord, null);
  assert.equal(f.delivery.effects.filter((effect) => effect === "delivery:push").length, 1);
  assert.equal(f.delivery.effects.filter((effect) => effect === "delivery:create_pull_request").length, 1);

  const effectsBeforeRestart = [...f.delivery.effects];
  const restarted = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);
  assert.equal(restarted.outcome, "not_delivered");
  assert.equal(restarted.reason_code, "delivery_invalidated");
  assert.deepEqual(f.delivery.effects, effectsBeforeRestart);
});

test("an occupied delivery completion slot is invalidated before push or PR creation", async () => {
  const f = fixture();
  f.recordStore.completionSlotInvalid = true;

  const result = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);

  assert.equal(result.outcome, "not_delivered");
  assert.equal(result.reason_code, "delivery_invalidated");
  assert.deepEqual(f.delivery.effects, ["delivery:read"]);
  assert.equal(f.recordStore.lastInvalidationInput?.invalidation_evidence.kind, "completion_slot_conflict");
});

test("restart reads a delivery completion record and never repeats push or PR creation", async () => {
  const f = fixture();
  const first = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);
  assert.equal(first.outcome, "delivered");

  f.delivery.effects.length = 0;
  f.task.effects.length = 0;
  const restarted = await f.coordinator.deliver(f.authorization, correlationId, liveExecution);

  assert.equal(restarted.outcome, "delivered");
  assert.deepEqual(f.delivery.effects, ["delivery:read"]);
  assert.deepEqual(f.task.effects, []);
});
