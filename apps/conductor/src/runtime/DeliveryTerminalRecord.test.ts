import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  CycleCompletionRecord,
  DeliveryInvalidationEvidence,
} from "../contracts/cycle-records.js";
import {
  parseCorrelationId,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskRevision,
  parseTaskIssueId,
  parseTaskStateId,
  type TaskRevision,
} from "../contracts/identity.js";
import {
  canonicalTaskRevision,
  type TaskIssueSnapshot,
  type TaskSnapshot,
} from "../contracts/task-management.js";
import type { PullRequestSnapshot } from "../contracts/observation.js";
import { parseMarkdownText } from "../contracts/validation.js";
import { createRootHeadBranch } from "../delivery/api/DeliveryInterface.js";
import type {
  CreateIssueCommentCall,
  CreateIssueCommentResult,
} from "../task-management/mcp/TaskMcpSchemas.js";
import { TASK_MCP_CAPABILITIES } from "../task-management/mcp/TaskMcpSchemas.js";
import type {
  TaskManageCommandInterface,
  TaskManageExecution,
} from "../task-management/api/TaskManageCommandInterface.js";
import { createTaskManageCallerAuthority } from "../task-management/api/TaskManageCapability.js";
import type { LinearIssueRecordComment } from "../task-management/linear/LinearQueries.js";
import { createAcceptedRevisionAuthority } from "./RootAcceptedRevision.js";
import { parseRootAcceptanceView } from "./RootToolBoundary.js";
import type {
  DeliveryCompletionWriteInput,
  DeliveryConvergenceProof,
  DeliveryInvalidationWriteInput,
  DeliveryRecordState,
  DeliveryRecordSnapshotReader,
} from "./DeliveryTerminalRecord.js";
import {
  createDeliveryConvergenceProof,
  DeliveryRecordSlotConflict,
  DeliveryTerminalRecordWriter,
} from "./DeliveryTerminalRecord.js";

const rootId = parseRootIssueId("ROOT-RECORD");
const cycleId = parseTaskIssueId("CYCLE-RECORD");
const generation = parseRuntimeGeneration(7);
const correlationId = parseCorrelationId("delivery-record:test");
const exactRevision = parseRevision("a".repeat(40));
const repositoryId = parseRepositoryId("repo:record");
const serviceActorId = "actor:symphony";
const completionRecordId = "record:delivery:completion:record";
const invalidationRecordId = "record:delivery:invalidation:record";
const exactRevisionDigest = createHash("sha256").update(exactRevision, "utf8").digest("hex");
const rootRevision: TaskRevision = parseTaskRevision(`symphony:v1:${"1".repeat(64)}`);
const rootDocumentDigest = "2".repeat(64);
const acceptedRecordDigest = "3".repeat(64);
const acceptanceBasisDigest = "4".repeat(64);
const linearDigest = "5".repeat(64);

const acceptanceView = parseRootAcceptanceView({
  schema_version: 1,
  cycle_id: cycleId,
  cycle_revision: "revision:cycle:record",
  cycle_seal_digest: "6".repeat(64),
  graph_seal_digest: "7".repeat(64),
  repository_id: repositoryId,
  base_branch: "main",
  head_branch: createRootHeadBranch(rootId),
  exact_revision: exactRevision,
  workspace_state: "clean",
  diff_digest: "sha256:record-diff",
  verify_issue_id: "VERIFY-RECORD",
  verify_issue_revision: "revision:verify:record",
});

const authority = createAcceptedRevisionAuthority();
const authorization = authority.issuer.issue({
  root_id: rootId,
  runtime_generation: generation,
  acceptance_view: acceptanceView,
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function issue(
  issueId: ReturnType<typeof parseTaskIssueId>,
  kind: "root" | "cycle",
  status: "In Review" | "Succeeded",
  parentIssueId: ReturnType<typeof parseTaskIssueId> | null,
): TaskIssueSnapshot {
  return {
    issue_id: issueId,
    provider_created_at: "2026-08-04T00:00:00.000Z",
    provider_updated_at: "2026-08-04T00:00:00.000Z",
    creation_actor_id: serviceActorId,
    kind,
    status_id: parseTaskStateId(`state:${kind}:${status.toLowerCase().replaceAll(" ", "-")}`),
    status,
    title: `${kind} record fixture`,
    description_markdown: parseMarkdownText("# Record fixture"),
    parent_issue_id: parentIssueId,
    label_ids: [],
    delegate_id: "agent:symphony",
    priority: 1,
    archived: false,
    trashed: false,
    revision: kind === "root" ? rootRevision : parseTaskRevision(`symphony:v1:${"8".repeat(64)}`),
  } as TaskIssueSnapshot;
}

const root = issue(parseTaskIssueId(rootId), "root", "In Review", null);
const cycle = issue(cycleId, "cycle", "Succeeded", parseTaskIssueId(rootId));
const acceptedRecord = {} as CycleCompletionRecord;

function round(observedAt: string) {
  const pullRequestRevision = canonicalTaskRevision({
    provider: "github",
    repository_id: repositoryId,
    base_branch: "main",
    head_branch: createRootHeadBranch(rootId),
    url: "https://github.example/pull/record",
  });
  return {
    linear_snapshot_digest: linearDigest,
    linear_observed_at: observedAt,
    root_revision: rootRevision,
    git_exact_revision: exactRevisionDigest,
    git_observed_at: observedAt,
    remote_ref_revision: exactRevisionDigest,
    pull_request_identity: "https://github.example/pull/record",
    pull_request_revision: pullRequestRevision,
    pull_request_head: exactRevisionDigest,
    pull_request_state: "open" as const,
    delivery_provider_observed_at: observedAt,
  };
}

const proof: DeliveryConvergenceProof = createDeliveryConvergenceProof(
  round("2026-08-04T00:00:01.000Z"),
  round("2026-08-04T00:00:02.000Z"),
);

const pullRequest: PullRequestSnapshot = {
  provider: "github",
  repository_id: repositoryId,
  base_branch: "main",
  head_branch: createRootHeadBranch(rootId),
  state: "open",
  head_revision: exactRevision,
  url: "https://github.example/pull/record",
};

const basis: DeliveryRecordState["basis"] = {
  root,
  cycle,
  approval_record: {} as DeliveryRecordState["basis"]["approval_record"],
  accepted_record: acceptedRecord,
  accepted_record_digest: acceptedRecordDigest,
  acceptance_basis_digest: acceptanceBasisDigest,
  delivery_completion_record_id: completionRecordId,
  delivery_invalidation_record_id: invalidationRecordId,
  root_document_digest: rootDocumentDigest,
  linear_snapshot_digest: linearDigest,
};

const state: DeliveryRecordState = {
  snapshot: {} as TaskSnapshot,
  basis,
  completion_slot: { state: "empty" },
  invalidation_slot: { state: "empty" },
};

class FakeRecordReader implements DeliveryRecordSnapshotReader {
  readonly comments: LinearIssueRecordComment[] = [];
  readCount = 0;

  async readRootSnapshot(): Promise<TaskSnapshot> {
    throw new Error("unused_read_root_snapshot");
  }

  async readIssueRecordComments(): Promise<readonly LinearIssueRecordComment[]> {
    this.readCount += 1;
    return [...this.comments];
  }
}

class FakeTaskManager {
  readonly effects: CreateIssueCommentCall[] = [];
  outcome: CreateIssueCommentResult["output"]["outcome"] = "applied";
  materialize = true;

  constructor(private readonly reader: FakeRecordReader) {}

  create_issue_comment = async (
    call: CreateIssueCommentCall,
    execution: TaskManageExecution,
  ): Promise<CreateIssueCommentResult> => {
    execution.assertActive();
    this.effects.push(call);
    const bodyDigest = digest(call.input.body_markdown);
    const comment = {
      comment_id: call.input.comment_id,
      issue_id: String(call.input.issue_id),
      provider_created_at: "2026-08-04T00:00:03.000Z",
      provider_updated_at: "2026-08-04T00:00:03.000Z",
      provider_edited_at: null,
      provider_archived_at: null,
      actor_id: serviceActorId,
      body_digest: bodyDigest,
      body_markdown: call.input.body_markdown,
    };
    if (this.materialize) this.reader.comments.push(comment);
    return {
      schema_version: 1,
      function: "create_issue_comment",
      root_id: rootId,
      runtime_generation: generation,
      correlation_id: correlationId,
      capability: TASK_MCP_CAPABILITIES.create_issue_comment,
      output: {
        outcome: this.outcome,
        effect_may_have_occurred: this.outcome === "applied" || this.outcome === "conflict_observed",
        target: { kind: "comment", comment_id: call.input.comment_id, issue_id: parseTaskIssueId(rootId) },
        fresh_comment: {
          comment_id: call.input.comment_id,
          issue_id: parseTaskIssueId(rootId),
          provider_created_at: comment.provider_created_at,
          provider_updated_at: comment.provider_updated_at,
          provider_edited_at: null,
          provider_archived_at: null,
          actor_id: serviceActorId,
          body_digest: bodyDigest,
        },
        sanitized_reason: this.outcome === "applied" ? null : "provider_outcome",
      },
    };
  };
}

function writerFixture() {
  const reader = new FakeRecordReader();
  const taskManager = new FakeTaskManager(reader);
  const callerAuthority = createTaskManageCallerAuthority();
  const writer = new DeliveryTerminalRecordWriter({
    task_manager: taskManager as unknown as TaskManageCommandInterface,
    task_caller_issuer: callerAuthority.issuer,
    record_reader: reader,
    service_actor_id: serviceActorId,
  });
  return { reader, taskManager, writer };
}

const liveExecution = Object.freeze({ assertActive: () => undefined });

function completionInput(): DeliveryCompletionWriteInput {
  return {
    authorization,
    correlation_id: correlationId,
    state,
    observation: { remote_revision: exactRevision, pull_request: pullRequest },
    convergence_proof: proof,
  };
}

function invalidationInput(): DeliveryInvalidationWriteInput {
  const evidence: DeliveryInvalidationEvidence = {
    kind: "completion_slot_conflict",
    invalid_record_observation_digest: "9".repeat(64),
  };
  return {
    authorization,
    correlation_id: correlationId,
    state,
    observation: { remote_revision: exactRevision, pull_request: pullRequest },
    invalidation_evidence: evidence,
    reason_code: "completion_slot_conflict",
    reason_markdown: "The exact completion slot contains conflicting evidence.",
  };
}

test("delivery terminal writer persists a completion projection and exact reads it back", async () => {
  const f = writerFixture();

  const record = await f.writer.writeCompletion(completionInput(), liveExecution);

  assert.equal(record.record_kind, "delivery_completion");
  assert.equal(record.root_id, rootId);
  assert.equal(record.accepted_cycle_id, cycleId);
  assert.equal(record.exact_revision, exactRevisionDigest);
  assert.equal(f.taskManager.effects.length, 1);
  assert.equal(f.reader.comments.length, 1);
  assert.equal(f.reader.comments[0]?.comment_id, completionRecordId);
  assert.equal(f.reader.comments[0]?.issue_id, String(rootId));
  assert.equal(f.reader.readCount, 2);
});

test("exact terminal read-back resolves an uncertain comment mutation without a retry", async () => {
  const f = writerFixture();
  f.taskManager.outcome = "conflict_observed";

  const record = await f.writer.writeCompletion(completionInput(), liveExecution);

  assert.equal(record.record_kind, "delivery_completion");
  assert.equal(f.taskManager.effects.length, 1);
  assert.equal(f.reader.comments.length, 1);
});

test("delivery terminal writer persists and reads an invalidation projection", async () => {
  const f = writerFixture();

  const record = await f.writer.writeInvalidation(invalidationInput(), liveExecution);

  assert.equal(record.record_kind, "delivery_invalidation");
  assert.equal(record.invalidation_evidence.kind, "completion_slot_conflict");
  assert.equal(record.resolution_policy, "permanently_quarantined");
  assert.equal(f.taskManager.effects.length, 1);
  assert.equal(f.reader.comments[0]?.comment_id, invalidationRecordId);
});

test("delivery terminal writer rejects an occupied exact slot before mutation", async () => {
  const f = writerFixture();
  f.reader.comments.push({
    comment_id: completionRecordId,
    issue_id: String(rootId),
    provider_created_at: "2026-08-04T00:00:03.000Z",
    provider_updated_at: "2026-08-04T00:00:03.000Z",
    provider_edited_at: null,
    provider_archived_at: null,
    actor_id: serviceActorId,
    body_digest: "a".repeat(64),
    body_markdown: "foreign slot evidence",
  });

  await assert.rejects(
    f.writer.writeCompletion(completionInput(), liveExecution),
    (error: unknown) => error instanceof DeliveryRecordSlotConflict && error.slot === "completion",
  );
  assert.equal(f.taskManager.effects.length, 0);
});

test("delivery terminal writer fails closed when the mutation is not read back", async () => {
  const f = writerFixture();
  f.taskManager.materialize = false;

  await assert.rejects(
    f.writer.writeCompletion(completionInput(), liveExecution),
    /delivery_completion_record_readback_missing/u,
  );
  assert.equal(f.taskManager.effects.length, 1);
});
