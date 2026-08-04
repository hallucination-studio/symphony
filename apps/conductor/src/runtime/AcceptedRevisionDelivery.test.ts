import assert from "node:assert/strict";
import test from "node:test";

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
    : statusId === rootDone ? "Done" : "In Progress";
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
    assert.deepEqual(call.input.desired, { state_id: rootInReview });
    const before = this.current;
    if (this.materializeUpdate) {
      this.current = rootIssue(rootInReview);
    }
    const receiptResource = this.substituteAppliedReceipt
      ? rootIssue(rootInReview, "Substituted Root")
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
          before: before.status,
          after: this.current.status,
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
  const coordinator = new AcceptedRevisionDeliveryCoordinator({
    provider: "github",
    root_label_id: rootLabel,
    root_in_progress_state: rootInProgress,
    root_in_review_state: rootInReview,
    accepted_revision_verifier: acceptedRevision.verifier,
    task_caller_issuer: task.callerAuthority.issuer,
    task_manager: task,
    delivery,
  });
  return { authorization, acceptedRevision, delivery, task, coordinator };
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
  ]);
  assert.deepEqual(f.task.effects, ["task:get_issue", "task:update_issue", "task:get_issue"]);
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
  assert.equal(result.reason_code, "root_status_conflict");
  assert.deepEqual(f.task.effects, ["task:get_issue"]);
});
