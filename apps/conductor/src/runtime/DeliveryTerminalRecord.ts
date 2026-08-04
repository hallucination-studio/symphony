import { createHash } from "node:crypto";

import {
  parseCycleCompletionRecord,
  parseDeliveryCompletionRecord,
  parseDeliveryInvalidationRecord,
  type CycleApprovalRecord,
  type CycleCompletionRecord,
  type DeliveryInvalidationEvidence,
} from "../contracts/cycle-records.js";
import { renderTaskIssueRecordProjectionMarkdown } from "../contracts/cycle-record-markdown.js";
import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskIssueId,
  type CorrelationId,
  type Revision,
  type RootIssueId,
  type TaskIssueId,
  type TaskRevision,
} from "../contracts/identity.js";
import type { PullRequestSnapshot } from "../contracts/observation.js";
import {
  canonicalTaskRevision,
  type TaskIssueRecordObservation,
  type TaskIssueSnapshot,
  type TaskSnapshot,
} from "../contracts/task-management.js";
import type {
  TaskManageBoundaryExecution,
  TaskManageCommandInterface,
  TaskManageExecution,
} from "../task-management/api/TaskManageCommandInterface.js";
import type { TaskManageCallerIssuer } from "../task-management/api/TaskManageCapability.js";
import type { LinearIssueRecordComment } from "../task-management/linear/LinearQueries.js";
import {
  parseTaskMcpResult,
  type CreateIssueCommentCall,
  type CreateIssueCommentResult,
} from "../task-management/mcp/TaskMcpSchemas.js";
import type { AcceptedRevisionAuthorization } from "./RootAcceptedRevision.js";
import {
  appliedTaskIssueRecord,
  createTaskIssueRecordCall,
  readExactTaskIssueRecord,
} from "../cycle/internal/CycleRecords.js";
import { taskSnapshotDigest } from "../observation/TaskFacts.js";
import type { DeliveryObservation } from "../delivery/api/DeliveryInterface.js";

type AcceptedCycleCompletionRecord = Extract<CycleCompletionRecord, {
  readonly successor_policy: "not_applicable";
}>;

const DIGEST_PREFIX = "sha256:";

export interface DeliveryObservationRound {
  readonly linear_snapshot_digest: string;
  readonly linear_observed_at: string;
  readonly root_revision: TaskRevision;
  readonly git_exact_revision: string;
  readonly git_observed_at: string;
  readonly remote_ref_revision: string | null;
  readonly pull_request_identity: string | null;
  readonly pull_request_revision: TaskRevision | null;
  readonly pull_request_head: string | null;
  readonly pull_request_state: PullRequestSnapshot["state"] | null;
  readonly delivery_provider_observed_at: string;
}

export interface DeliveryConvergenceProof {
  readonly proof_scope: "delivery";
  readonly first_round: DeliveryObservationRound;
  readonly second_round: DeliveryObservationRound;
  readonly observation_order: "linear -> git -> delivery -> linear -> git -> delivery";
  readonly stable_decision_basis_digest: string;
}

export interface DeliveryRecordSnapshotReader {
  readRootSnapshot(rootId: RootIssueId): Promise<TaskSnapshot>;
  readIssueRecordComments(issueId: TaskIssueId): Promise<readonly LinearIssueRecordComment[]>;
}

export interface DeliveryRecordBasis {
  readonly root: TaskIssueSnapshot;
  readonly cycle: TaskIssueSnapshot;
  readonly approval_record: CycleApprovalRecord;
  readonly accepted_record: CycleCompletionRecord;
  readonly accepted_record_digest: string;
  readonly acceptance_basis_digest: string;
  readonly delivery_completion_record_id: string;
  readonly delivery_invalidation_record_id: string;
  readonly root_document_digest: string;
  readonly linear_snapshot_digest: string;
}

export type DeliveryTerminalRecordSlot =
  | { readonly state: "empty" }
  | { readonly state: "completion"; readonly record: ReturnType<typeof parseDeliveryCompletionRecord> }
  | { readonly state: "invalidation"; readonly record: ReturnType<typeof parseDeliveryInvalidationRecord> }
  | { readonly state: "invalid"; readonly observation_digest: string };

export interface DeliveryRecordState {
  readonly snapshot: TaskSnapshot;
  readonly basis: DeliveryRecordBasis;
  readonly completion_slot: DeliveryTerminalRecordSlot;
  readonly invalidation_slot: DeliveryTerminalRecordSlot;
}

export interface DeliveryRecordObservationInput {
  readonly remote_revision: Revision | null;
  readonly pull_request: PullRequestSnapshot | null;
}

export interface DeliveryCompletionWriteInput {
  readonly authorization: AcceptedRevisionAuthorization;
  readonly correlation_id: CorrelationId;
  readonly state: DeliveryRecordState;
  readonly observation: DeliveryRecordObservationInput;
  readonly convergence_proof: DeliveryConvergenceProof;
}

export interface DeliveryInvalidationWriteInput {
  readonly authorization: AcceptedRevisionAuthorization;
  readonly correlation_id: CorrelationId;
  readonly state: DeliveryRecordState;
  readonly observation: DeliveryRecordObservationInput;
  readonly invalidation_evidence: DeliveryInvalidationEvidence;
  readonly reason_code: string;
  readonly reason_markdown: string;
}

export interface DeliveryTerminalRecordStore {
  read(
    authorization: AcceptedRevisionAuthorization,
    execution: TaskManageBoundaryExecution,
  ): Promise<DeliveryRecordState>;
  writeCompletion(
    input: DeliveryCompletionWriteInput,
    execution: TaskManageBoundaryExecution,
  ): Promise<ReturnType<typeof parseDeliveryCompletionRecord>>;
  writeInvalidation(
    input: DeliveryInvalidationWriteInput,
    execution: TaskManageBoundaryExecution,
  ): Promise<ReturnType<typeof parseDeliveryInvalidationRecord>>;
}

export class DeliveryRecordSlotConflict extends Error {
  constructor(
    readonly slot: "completion" | "invalidation",
    readonly observation_digest: string,
  ) {
    super(`${slot}_record_slot_conflict`);
    this.name = "DeliveryRecordSlotConflict";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestJson(value: unknown): string {
  return digest(JSON.stringify(value));
}

function revisionDigest(value: Revision): string {
  return digest(value);
}

function stripDigestPrefix(value: string): string {
  return value.startsWith(DIGEST_PREFIX) ? value.slice(DIGEST_PREFIX.length) : value;
}

function issueById(snapshot: TaskSnapshot, issueId: TaskIssueId): TaskIssueSnapshot {
  const issue = snapshot.issues.find((entry) => String(entry.issue_id) === String(issueId));
  if (issue === undefined) throw new Error("delivery_record_issue_missing");
  return issue;
}

function isValidRecord(value: TaskIssueRecordObservation): value is Exclude<TaskIssueRecordObservation, {
  readonly observation_kind: string;
}> {
  return !("observation_kind" in value);
}

function recordsForIssue(snapshot: TaskSnapshot, issueId: TaskIssueId): TaskIssueRecordObservation[] {
  return snapshot.issue_record_observations.filter(({ issue_id }) => String(issue_id) === String(issueId));
}

function slotObservation(
  observations: readonly TaskIssueRecordObservation[],
  recordId: string,
  expectedKind: "delivery_completion" | "delivery_invalidation",
): DeliveryTerminalRecordSlot {
  const matches = observations.filter(({ record_id }) => record_id === recordId);
  if (matches.length === 0) return { state: "empty" };
  if (matches.length !== 1) throw new Error("duplicate_delivery_record_identity");
  const match = matches[0]!;
  if (!isValidRecord(match) || match.record_kind !== expectedKind) {
    return { state: "invalid", observation_digest: digestJson(match) };
  }
  try {
    return expectedKind === "delivery_completion"
      ? { state: "completion", record: parseDeliveryCompletionRecord(match) }
      : { state: "invalidation", record: parseDeliveryInvalidationRecord(match) };
  } catch {
    return { state: "invalid", observation_digest: digestJson(match) };
  }
}

function acceptedCycleRecord(
  snapshot: TaskSnapshot,
  authorization: AcceptedRevisionAuthorization,
  approval: CycleApprovalRecord,
): AcceptedCycleCompletionRecord {
  const cycleId = parseTaskIssueId(authorization.acceptance_view.cycle_id);
  const match = recordsForIssue(snapshot, cycleId).find(({ record_id }) => (
    record_id === approval.cycle_completion_record_id
  ));
  if (match === undefined || !isValidRecord(match) || match.record_kind !== "cycle_completion") {
    throw new Error("accepted_cycle_completion_record_missing");
  }
  const record = parseCycleCompletionRecord(match);
  if (record.basis_status !== "Awaiting Acceptance" || record.successor_policy !== "not_applicable") {
    throw new Error("accepted_cycle_completion_record_mismatch");
  }
  if (record.completion.outcome !== "accepted") {
    throw new Error("accepted_cycle_completion_record_mismatch");
  }
  if (
    record.completion.specification_seal_digest !== authorization.acceptance_view.cycle_seal_digest
    || record.completion.graph_seal_digest !== authorization.acceptance_view.graph_seal_digest
    || record.completion.exact_revision !== revisionDigest(authorization.acceptance_view.exact_revision)
  ) throw new Error("accepted_cycle_completion_record_mismatch");
  return record as AcceptedCycleCompletionRecord;
}

export function deriveDeliveryRecordBasis(
  snapshot: TaskSnapshot,
  authorization: AcceptedRevisionAuthorization,
): DeliveryRecordBasis {
  const rootId = parseTaskIssueId(authorization.root_id);
  const cycleId = parseTaskIssueId(authorization.acceptance_view.cycle_id);
  const root = issueById(snapshot, rootId);
  const cycle = issueById(snapshot, cycleId);
  if (
    String(snapshot.root_id) !== String(authorization.root_id)
    || root.kind !== "root"
    || root.parent_issue_id !== null
    || cycle.kind !== "cycle"
    || String(cycle.parent_issue_id) !== String(rootId)
    || cycle.status !== "Succeeded"
  ) throw new Error("delivery_record_family_invalid");
  const approvals = recordsForIssue(snapshot, cycleId).filter((entry): entry is CycleApprovalRecord => (
    isValidRecord(entry) && entry.record_kind === "cycle_approval"
  ));
  if (approvals.length !== 1) throw new Error("delivery_record_approval_invalid");
  const approval = approvals[0]!;
  const accepted = acceptedCycleRecord(snapshot, authorization, approval);
  const cycleRecords = recordsForIssue(snapshot, cycleId);
  slotObservation(
    snapshot.issue_record_observations,
    approval.delivery_completion_record_id,
    "delivery_completion",
  );
  slotObservation(
    snapshot.issue_record_observations,
    approval.delivery_invalidation_record_id,
    "delivery_invalidation",
  );
  if (cycleRecords.length === 0) throw new Error("delivery_record_cycle_records_missing");
  return Object.freeze({
    root,
    cycle,
    approval_record: approval,
    accepted_record: accepted,
    accepted_record_digest: digestJson(accepted),
    acceptance_basis_digest: accepted.completion.acceptance_basis_digest,
    delivery_completion_record_id: approval.delivery_completion_record_id,
    delivery_invalidation_record_id: approval.delivery_invalidation_record_id,
    root_document_digest: digest(root.description_markdown),
    linear_snapshot_digest: stripDigestPrefix(String(taskSnapshotDigest(snapshot))),
  });
}

function terminalSlots(
  snapshot: TaskSnapshot,
  basis: DeliveryRecordBasis,
): Pick<DeliveryRecordState, "completion_slot" | "invalidation_slot"> {
  return Object.freeze({
    completion_slot: slotObservation(
      snapshot.issue_record_observations,
      basis.delivery_completion_record_id,
      "delivery_completion",
    ),
    invalidation_slot: slotObservation(
      snapshot.issue_record_observations,
      basis.delivery_invalidation_record_id,
      "delivery_invalidation",
    ),
  });
}

function normalizedPullRequest(
  observation: DeliveryRecordObservationInput,
): PullRequestSnapshot | null {
  return observation.pull_request;
}

function commonProjection(
  input: DeliveryCompletionWriteInput | DeliveryInvalidationWriteInput,
  recordKind: "delivery_completion" | "delivery_invalidation",
): Record<string, unknown> {
  const { authorization, state } = input;
  const pullRequest = normalizedPullRequest(input.observation);
  return {
    issue_id: String(state.basis.root.issue_id),
    cycle_id: String(state.basis.cycle.issue_id),
    basis_issue_revision: state.basis.root.revision,
    basis_status: state.basis.root.status,
    basis_document_digest: state.basis.root_document_digest,
    record_kind: recordKind,
    root_id: String(authorization.root_id),
    accepted_cycle_id: String(authorization.acceptance_view.cycle_id),
    exact_revision: revisionDigest(authorization.acceptance_view.exact_revision),
    accepted_record_digest: state.basis.accepted_record_digest,
    acceptance_basis_digest: state.basis.acceptance_basis_digest,
    observed_root_status: state.basis.root.status,
    observed_remote_revision: input.observation.remote_revision === null
      ? null : revisionDigest(input.observation.remote_revision),
    observed_pull_request_identity: pullRequest?.url ?? null,
    observed_pull_request_head: pullRequest === null ? null : revisionDigest(pullRequest.head_revision),
  };
}

function completionProjection(input: DeliveryCompletionWriteInput): Record<string, unknown> {
  const pullRequest = normalizedPullRequest(input.observation);
  if (
    input.state.basis.root.status !== "In Review"
    || input.observation.remote_revision !== input.authorization.acceptance_view.exact_revision
    || pullRequest === null
    || pullRequest.head_revision !== input.authorization.acceptance_view.exact_revision
    || pullRequest.state !== "open"
  ) throw new Error("delivery_completion_observation_invalid");
  return {
    ...commonProjection(input, "delivery_completion"),
    observed_root_status: "In Review",
    convergence_proof: input.convergence_proof,
  };
}

function invalidationProjection(input: DeliveryInvalidationWriteInput): Record<string, unknown> {
  return {
    ...commonProjection(input, "delivery_invalidation"),
    invalidation_evidence: input.invalidation_evidence,
    resolution_policy: "permanently_quarantined",
    reason_code: input.reason_code,
    reason_markdown: input.reason_markdown,
  };
}

function slotDigest(
  comments: readonly LinearIssueRecordComment[],
  recordId: string,
): string | null {
  const matches = comments.filter(({ comment_id }) => comment_id === recordId);
  if (matches.length === 0) return null;
  return digestJson(matches.map(({ comment_id, issue_id, body_digest, provider_created_at, provider_updated_at }) => ({
    comment_id, issue_id, body_digest, provider_created_at, provider_updated_at,
  })));
}

function semanticProjection(value: object): Record<string, unknown> {
  const providerFields = new Set(["record_id", "revision", "actor_id", "created_at", "updated_at", "archived_at"]);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !providerFields.has(key)),
  );
}

function sameRecordProjection(record: object, projection: Record<string, unknown>): boolean {
  try {
    return renderTaskIssueRecordProjectionMarkdown(semanticProjection(record))
      === renderTaskIssueRecordProjectionMarkdown(projection);
  } catch {
    return false;
  }
}

export class DeliveryTerminalRecordWriter implements DeliveryTerminalRecordStore {
  readonly #serviceActorId: string;

  constructor(private readonly options: {
    readonly task_manager: TaskManageCommandInterface;
    readonly task_caller_issuer: TaskManageCallerIssuer;
    readonly record_reader: DeliveryRecordSnapshotReader;
    readonly service_actor_id: string;
  }) {
    this.#serviceActorId = options.service_actor_id;
  }

  async read(
    authorization: AcceptedRevisionAuthorization,
    execution: TaskManageBoundaryExecution,
  ): Promise<DeliveryRecordState> {
    execution.assertActive();
    const snapshot = await this.options.record_reader.readRootSnapshot(authorization.root_id);
    execution.assertActive();
    const basis = deriveDeliveryRecordBasis(snapshot, authorization);
    return Object.freeze({
      snapshot,
      basis,
      ...terminalSlots(snapshot, basis),
    });
  }

  async writeCompletion(
    input: DeliveryCompletionWriteInput,
    execution: TaskManageBoundaryExecution,
  ): Promise<ReturnType<typeof parseDeliveryCompletionRecord>> {
    const projection = completionProjection(input);
    const recordId = input.state.basis.delivery_completion_record_id;
    const issueId = parseTaskIssueId(input.authorization.root_id);
    execution.assertActive();
    const before = await this.options.record_reader.readIssueRecordComments(issueId);
    execution.assertActive();
    const occupied = slotDigest(before, recordId);
    if (occupied !== null) throw new DeliveryRecordSlotConflict("completion", occupied);
    const call = this.#recordCall(input, recordId, issueId, projection);
    const result = await this.#create(call, input, execution);
    const after = await this.options.record_reader.readIssueRecordComments(issueId);
    execution.assertActive();
    return this.#readBack(
      after,
      issueId,
      recordId,
      this.#serviceActorId,
      projection,
      call,
      result,
      parseDeliveryCompletionRecord,
      "delivery_completion",
    );
  }

  async writeInvalidation(
    input: DeliveryInvalidationWriteInput,
    execution: TaskManageBoundaryExecution,
  ): Promise<ReturnType<typeof parseDeliveryInvalidationRecord>> {
    const projection = invalidationProjection(input);
    const recordId = input.state.basis.delivery_invalidation_record_id;
    const issueId = parseTaskIssueId(input.authorization.root_id);
    execution.assertActive();
    const before = await this.options.record_reader.readIssueRecordComments(issueId);
    execution.assertActive();
    const occupied = slotDigest(before, recordId);
    if (occupied !== null) throw new DeliveryRecordSlotConflict("invalidation", occupied);
    const call = this.#recordCall(input, recordId, issueId, projection);
    const result = await this.#create(call, input, execution);
    const after = await this.options.record_reader.readIssueRecordComments(issueId);
    execution.assertActive();
    return this.#readBack(
      after,
      issueId,
      recordId,
      this.#serviceActorId,
      projection,
      call,
      result,
      parseDeliveryInvalidationRecord,
      "delivery_invalidation",
    );
  }

  #readBack<T extends { readonly revision: string }>(
    comments: readonly LinearIssueRecordComment[],
    issueId: TaskIssueId,
    recordId: string,
    expectedActorId: string,
    projection: Record<string, unknown>,
    call: CreateIssueCommentCall,
    result: CreateIssueCommentResult,
    parser: (value: unknown) => T,
    recordKind: "delivery_completion" | "delivery_invalidation",
  ): T {
    const projected = readExactTaskIssueRecord(comments, issueId, recordId, expectedActorId);
    if (projected === null) throw new Error(`${recordKind}_record_readback_missing`);
    const fresh = parser(projected);
    if (!sameRecordProjection(fresh, projection)) {
      throw new Error(`${recordKind}_record_readback_mismatch`);
    }
    if (result.output.outcome === "applied") {
      const applied = parser(appliedTaskIssueRecord(call, result, expectedActorId));
      if (fresh.revision !== applied.revision) {
        throw new Error(`${recordKind}_record_readback_mismatch`);
      }
    }
    return fresh;
  }

  #recordCall(
    input: DeliveryCompletionWriteInput | DeliveryInvalidationWriteInput,
    recordId: string,
    issueId: TaskIssueId,
    projection: Record<string, unknown>,
  ): CreateIssueCommentCall {
    return createTaskIssueRecordCall({
      root_id: parseRootIssueId(input.authorization.root_id),
      runtime_generation: parseRuntimeGeneration(input.authorization.runtime_generation),
      correlation_id: parseCorrelationId(input.correlation_id),
    }, {
      record_id: recordId,
      issue_id: issueId,
      expected_issue_revision: input.state.basis.root.revision,
      projection,
    });
  }

  async #create(
    call: CreateIssueCommentCall,
    input: DeliveryCompletionWriteInput | DeliveryInvalidationWriteInput,
    execution: TaskManageBoundaryExecution,
  ): Promise<CreateIssueCommentResult> {
    if (this.options.task_manager.create_issue_comment === undefined) {
      throw new Error("delivery_record_mutation_capability_missing");
    }
    execution.assertActive();
    const result = await this.options.task_manager.create_issue_comment(
      call,
      this.#taskExecution(input, call, execution),
    );
    execution.assertActive();
    return parseTaskMcpResult(result, call);
  }

  #taskExecution(
    input: DeliveryCompletionWriteInput | DeliveryInvalidationWriteInput,
    call: CreateIssueCommentCall,
    execution: TaskManageBoundaryExecution,
  ): TaskManageExecution {
    return Object.freeze({
      assertActive: () => execution.assertActive(),
      caller: this.options.task_caller_issuer.issue({
        caller: "cycle_machine",
        root_id: input.authorization.root_id,
        cycle_id: input.authorization.acceptance_view.cycle_id,
        runtime_generation: input.authorization.runtime_generation,
        correlation_id: input.correlation_id,
        cycle_seal_digest: input.authorization.acceptance_view.cycle_seal_digest,
        graph_seal_digest: input.authorization.acceptance_view.graph_seal_digest,
      }, call),
    });
  }
}

export function createDeliveryObservationInput(
  observation: DeliveryObservation,
  exactRevision: Revision,
): DeliveryRecordObservationInput {
  const pullRequest = observation.matching_pull_requests.length === 1
    && observation.matching_pull_requests[0]?.head_revision === exactRevision
    ? observation.matching_pull_requests[0]!
    : null;
  return Object.freeze({
    remote_revision: observation.remote_revision,
    pull_request: pullRequest,
  });
}

export function deliveryRoundBasisDigest(round: DeliveryObservationRound): string {
  return digestJson({
    linear_snapshot_digest: round.linear_snapshot_digest,
    root_revision: round.root_revision,
    git_exact_revision: round.git_exact_revision,
    remote_ref_revision: round.remote_ref_revision,
    pull_request_identity: round.pull_request_identity,
    pull_request_revision: round.pull_request_revision,
    pull_request_head: round.pull_request_head,
    pull_request_state: round.pull_request_state,
  });
}

export function createDeliveryObservationRound(input: {
  readonly state: DeliveryRecordState;
  readonly authorization: AcceptedRevisionAuthorization;
  readonly observation: DeliveryObservation;
  readonly now: string;
}): DeliveryObservationRound {
  const exactRevision = input.authorization.acceptance_view.exact_revision;
  if (
    input.state.basis.root.status !== "In Review"
    || input.observation.remote_revision !== exactRevision
    || input.observation.matching_pull_requests.length !== 1
  ) throw new Error("delivery_round_observation_invalid");
  const pullRequest = input.observation.matching_pull_requests[0]!;
  if (
    pullRequest.state !== "open"
    || pullRequest.head_revision !== exactRevision
    || pullRequest.provider !== input.observation.identity.provider
    || pullRequest.repository_id !== input.observation.identity.repository_id
    || pullRequest.base_branch !== input.observation.identity.base_branch
    || pullRequest.head_branch !== input.observation.identity.head_branch
  ) throw new Error("delivery_round_observation_invalid");
  const exactRevisionDigest = revisionDigest(exactRevision);
  return Object.freeze({
    linear_snapshot_digest: input.state.basis.linear_snapshot_digest,
    linear_observed_at: input.now,
    root_revision: input.state.basis.root.revision,
    git_exact_revision: exactRevisionDigest,
    git_observed_at: input.now,
    remote_ref_revision: revisionDigest(input.observation.remote_revision),
    pull_request_identity: pullRequest.url,
    pull_request_revision: canonicalTaskRevision({
      provider: pullRequest.provider,
      repository_id: pullRequest.repository_id,
      base_branch: pullRequest.base_branch,
      head_branch: pullRequest.head_branch,
      url: pullRequest.url,
    }),
    pull_request_head: revisionDigest(pullRequest.head_revision),
    pull_request_state: pullRequest.state,
    delivery_provider_observed_at: input.now,
  });
}

export function createDeliveryConvergenceProof(
  firstRound: DeliveryObservationRound,
  secondRound: DeliveryObservationRound,
): DeliveryConvergenceProof {
  return Object.freeze({
    proof_scope: "delivery",
    first_round: firstRound,
    second_round: secondRound,
    observation_order: "linear -> git -> delivery -> linear -> git -> delivery",
    stable_decision_basis_digest: deliveryRoundBasisDigest(firstRound),
  });
}

export function deliveryRoundsMatch(
  firstRound: DeliveryObservationRound,
  secondRound: DeliveryObservationRound,
): boolean {
  return deliveryRoundBasisDigest(firstRound) === deliveryRoundBasisDigest(secondRound);
}

export function deliveryFactsDigest(observation: DeliveryObservation): string {
  return digestJson({
    identity: observation.identity,
    remote_revision: observation.remote_revision,
    matching_pull_requests: observation.matching_pull_requests,
  });
}
