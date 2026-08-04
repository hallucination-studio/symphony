import {
  parseCorrelationId,
  parseTaskIssueId,
  parseTaskLabelId,
  parseTaskStateId,
  type CorrelationId,
  type Revision,
  type RootIssueId,
  type TaskLabelId,
  type TaskRevision,
  type TaskStateId,
} from "../contracts/identity.js";
import { parseMutationResult } from "../contracts/mutation.js";
import type { PullRequestSnapshot } from "../contracts/observation.js";
import type { TaskIssueSnapshot } from "../contracts/task-management.js";
import {
  createDeliveryIdentity,
  verifiedDelivery,
  type DeliverRevisionRequest,
  type DeliveryIdentity,
  type DeliveryInterface,
  type DeliveryObservation,
} from "../delivery/api/DeliveryInterface.js";
import { taskStringSetsEqual } from "../observation/TaskFacts.js";
import type {
  TaskManageBoundaryExecution,
  TaskManageCommandInterface,
  TaskManageExecution,
} from "../task-management/api/TaskManageCommandInterface.js";
import type { TaskManageCallerIssuer } from "../task-management/api/TaskManageCapability.js";
import {
  TASK_MCP_CAPABILITIES,
  parseTaskMcpResult,
  type GetIssueCall,
  type UpdateIssueCall,
  type UpdateIssueResult,
} from "../task-management/mcp/TaskMcpSchemas.js";
import { parseBoundedString } from "../contracts/validation.js";
import type {
  AcceptedRevisionAuthorization,
  AcceptedRevisionVerifier,
} from "./RootAcceptedRevision.js";
import {
  createDeliveryConvergenceProof,
  createDeliveryObservationInput,
  createDeliveryObservationRound,
  deliveryFactsDigest,
  deliveryRoundsMatch,
  DeliveryRecordSlotConflict,
  type DeliveryRecordState,
  type DeliveryTerminalRecordStore,
} from "./DeliveryTerminalRecord.js";

export type AcceptedRevisionDeliveryFailureCode =
  | "boundary_unavailable"
  | "delivery_identity_mismatch"
  | "invalid_contract"
  | "pull_request_conflict"
  | "pull_request_unconfirmed"
  | "push_unconfirmed"
  | "remote_revision_conflict"
  | "root_status_conflict"
  | "root_update_unconfirmed"
  | "root_failure_projection_unconfirmed"
  | "delivery_invalidated";

export type AcceptedRevisionDeliveryResult =
  | {
    readonly outcome: "delivered";
    readonly root_id: RootIssueId;
    readonly cycle_id: AcceptedRevisionAuthorization["acceptance_view"]["cycle_id"];
    readonly exact_revision: Revision;
    readonly pull_request: PullRequestSnapshot;
    readonly root_revision: TaskRevision;
  }
  | {
    readonly outcome: "not_delivered";
    readonly root_id: RootIssueId;
    readonly cycle_id: AcceptedRevisionAuthorization["acceptance_view"]["cycle_id"];
    readonly exact_revision: Revision;
    readonly reason_code: AcceptedRevisionDeliveryFailureCode;
  };

export interface AcceptedRevisionDeliveryOptions {
  readonly provider: string;
  readonly root_label_id: TaskLabelId;
  readonly root_in_progress_state: TaskStateId;
  readonly root_in_review_state: TaskStateId;
  readonly root_failed_state: TaskStateId;
  readonly accepted_revision_verifier: AcceptedRevisionVerifier;
  readonly task_caller_issuer: TaskManageCallerIssuer;
  readonly task_manager: TaskManageCommandInterface;
  readonly delivery: DeliveryInterface;
  readonly record_store: DeliveryTerminalRecordStore;
  readonly now?: () => string;
}

interface DeliveryContext {
  readonly authorization: AcceptedRevisionAuthorization;
  readonly correlation_id: CorrelationId;
  readonly identity: DeliveryIdentity;
  readonly request: DeliverRevisionRequest;
  readonly execution: TaskManageBoundaryExecution;
}

type EffectReceipt = "valid" | "invalid" | "unavailable";
type TaskEffectReceipt =
  | { readonly state: "valid"; readonly result: UpdateIssueResult }
  | { readonly state: "invalid" | "unavailable"; readonly result: null };

class DeliveryAbort extends Error {
  constructor(readonly code: AcceptedRevisionDeliveryFailureCode) {
    super(code);
    this.name = "DeliveryAbort";
  }
}

function sameDeliveryIdentity(left: DeliveryIdentity, right: DeliveryIdentity): boolean {
  return left.provider === right.provider
    && left.root_id === right.root_id
    && left.repository_id === right.repository_id
    && left.base_branch === right.base_branch
    && left.head_branch === right.head_branch;
}

function sameRootExceptStatusAndRevision(
  before: TaskIssueSnapshot,
  after: TaskIssueSnapshot,
): boolean {
  return before.issue_id === after.issue_id
    && before.title === after.title
    && before.description_markdown === after.description_markdown
    && before.parent_issue_id === after.parent_issue_id
    && taskStringSetsEqual(before.label_ids, after.label_ids)
    && before.delegate_id === after.delegate_id
    && before.priority === after.priority;
}

export class AcceptedRevisionDeliveryCoordinator {
  readonly #provider: string;
  readonly #rootLabelId: TaskLabelId;
  readonly #rootInProgressState: TaskStateId;
  readonly #rootInReviewState: TaskStateId;
  readonly #rootFailedState: TaskStateId;

  constructor(private readonly options: AcceptedRevisionDeliveryOptions) {
    this.#provider = parseBoundedString(options.provider, "invalid_delivery_provider", 64);
    this.#rootLabelId = parseTaskLabelId(options.root_label_id);
    this.#rootInProgressState = parseTaskStateId(options.root_in_progress_state);
    this.#rootInReviewState = parseTaskStateId(options.root_in_review_state);
    this.#rootFailedState = parseTaskStateId(options.root_failed_state);
    if (new Set([
      this.#rootInProgressState,
      this.#rootInReviewState,
      this.#rootFailedState,
    ]).size !== 3) {
      throw new Error("duplicate_root_delivery_state_identity");
    }
  }

  async deliver(
    authorization: AcceptedRevisionAuthorization,
    correlationValue: CorrelationId,
    execution: TaskManageBoundaryExecution,
  ): Promise<AcceptedRevisionDeliveryResult> {
    this.options.accepted_revision_verifier.assert(authorization);
    const correlationId = parseCorrelationId(correlationValue);
    const view = authorization.acceptance_view;
    const identity = createDeliveryIdentity({
      provider: this.#provider,
      root_id: authorization.root_id,
      repository_id: view.repository_id,
      base_branch: view.base_branch,
    });
    if (identity.head_branch !== view.head_branch) {
      return this.#notDelivered(authorization, "delivery_identity_mismatch");
    }
    const context: DeliveryContext = Object.freeze({
      authorization,
      correlation_id: correlationId,
      identity,
      request: Object.freeze({
        identity,
        verified_revision: view.exact_revision,
        expected_remote_revision: null,
        correlation_id: correlationId,
      }),
      execution,
    });

    try {
      const initialState = await this.#readRecordState(context);
      if (initialState.invalidation_slot.state === "invalidation") {
        try {
          await this.#projectRootFailed(context);
        } catch (error) {
          if (error instanceof DeliveryAbort) {
            return this.#notDelivered(authorization, error.code);
          }
          return this.#notDelivered(authorization, "root_failure_projection_unconfirmed");
        }
        return this.#notDelivered(authorization, "delivery_invalidated");
      }
      if (initialState.completion_slot.state === "completion") {
        return this.#resumeCompletedDelivery(context, initialState);
      }
      if (initialState.completion_slot.state === "invalid") {
        return this.#invalidateAndStop(
          context,
          initialState,
          await this.#readDelivery(context),
          {
            kind: "completion_slot_conflict",
            invalid_record_observation_digest: initialState.completion_slot.observation_digest,
          },
          "completion_slot_conflict",
          "The delivery completion record slot is occupied by invalid evidence.",
        );
      }
      if (initialState.basis.root.status === "Done") {
        const observation = await this.#readDelivery(context);
        return this.#invalidateAndStop(
          context,
          initialState,
          observation,
          {
            kind: "root_done_before_completion",
            observed_root_revision: initialState.basis.root.revision,
            observed_delivery_facts_digest: deliveryFactsDigest(observation),
          },
          "root_done_before_completion",
          "The Root reached Done before delivery completion was recorded.",
        );
      }
      const pullRequest = await this.#deliverExactRevision(context);
      await this.#moveRootToInReview(context);
      const firstState = await this.#readRecordState(context);
      const firstObservation = await this.#readDelivery(context);
      const firstRound = this.#deliveryRound(context, firstState, firstObservation);
      const secondState = await this.#readRecordState(context);
      const secondObservation = await this.#readDelivery(context);
      const secondRound = this.#deliveryRound(context, secondState, secondObservation);
      if (!deliveryRoundsMatch(firstRound, secondRound)) {
        return this.#invalidateAndStop(
          context,
          secondState,
          secondObservation,
          {
            kind: "convergence_mismatch",
            first_round: firstRound,
            second_round: secondRound,
            observation_order: "linear -> git -> delivery -> linear -> git -> delivery",
            mismatched_fields: this.#mismatchedRoundFields(firstRound, secondRound),
            first_basis_digest: firstState.basis.linear_snapshot_digest,
            second_basis_digest: secondState.basis.linear_snapshot_digest,
          },
          "delivery_convergence_mismatch",
          "The two delivery observations did not converge.",
        );
      }
      const proof = createDeliveryConvergenceProof(firstRound, secondRound);
      let completion;
      try {
        completion = await this.options.record_store.writeCompletion({
          authorization,
          correlation_id: correlationId,
          state: secondState,
          observation: createDeliveryObservationInput(secondObservation, view.exact_revision),
          convergence_proof: proof,
        }, execution);
      } catch (error) {
        if (!(error instanceof DeliveryRecordSlotConflict) || error.slot !== "completion") throw error;
        const freshState = await this.#readRecordState(context);
        if (freshState.completion_slot.state === "completion") {
          return this.#resumeCompletedDelivery(context, freshState);
        }
        return this.#invalidateAndStop(
          context,
          freshState,
          secondObservation,
          {
            kind: "completion_slot_conflict",
            invalid_record_observation_digest: error.observation_digest,
          },
          "completion_slot_conflict",
          "The delivery completion record slot was occupied during finalization.",
        );
      }
      return Object.freeze({
        outcome: "delivered",
        root_id: authorization.root_id,
        cycle_id: view.cycle_id,
        exact_revision: view.exact_revision,
        pull_request: pullRequest,
        root_revision: completion.basis_issue_revision,
      });
    } catch (error) {
      if (!(error instanceof DeliveryAbort)) throw error;
      if (error.code === "root_status_conflict") {
        try {
          const state = await this.#readRecordState(context);
          if (state.basis.root.status === "Done" && state.invalidation_slot.state === "empty") {
            const observation = await this.#readDelivery(context);
            return this.#invalidateAndStop(
              context,
              state,
              observation,
              {
                kind: "root_done_before_completion",
                observed_root_revision: state.basis.root.revision,
                observed_delivery_facts_digest: deliveryFactsDigest(observation),
              },
              "root_done_before_completion",
              "The Root reached Done before delivery completion was recorded.",
            );
          }
        } catch {
          // Preserve the original sanitized delivery failure when invalidation cannot be proven.
        }
      }
      return this.#notDelivered(authorization, error.code);
    }
  }

  async #readRecordState(context: DeliveryContext): Promise<DeliveryRecordState> {
    context.execution.assertActive();
    try {
      const state = await this.options.record_store.read(context.authorization, context.execution);
      context.execution.assertActive();
      return state;
    } catch {
      throw new DeliveryAbort("boundary_unavailable");
    }
  }

  #deliveryRound(
    context: DeliveryContext,
    state: DeliveryRecordState,
    observation: DeliveryObservation,
  ) {
    try {
      return createDeliveryObservationRound({
        state,
        authorization: context.authorization,
        observation,
        now: this.options.now?.() ?? new Date().toISOString(),
      });
    } catch {
      throw new DeliveryAbort("invalid_contract");
    }
  }

  #mismatchedRoundFields(
    first: ReturnType<typeof createDeliveryObservationRound>,
    second: ReturnType<typeof createDeliveryObservationRound>,
  ): readonly [string, ...string[]] {
    const fields = [
      "linear_snapshot_digest", "root_revision", "git_exact_revision", "remote_ref_revision",
      "pull_request_identity", "pull_request_revision", "pull_request_head", "pull_request_state",
    ] as const;
    const mismatched = fields.filter((field) => first[field] !== second[field]);
    return (mismatched.length === 0 ? ["stable_decision_basis_digest"] : mismatched) as readonly [string, ...string[]];
  }

  async #resumeCompletedDelivery(
    context: DeliveryContext,
    state: DeliveryRecordState,
  ): Promise<AcceptedRevisionDeliveryResult> {
    if (state.completion_slot.state !== "completion") {
      throw new DeliveryAbort("invalid_contract");
    }
    const observation = await this.#readDelivery(context);
    const pullRequest = this.#exactPullRequest(
      observation,
      context.authorization.acceptance_view.exact_revision,
    );
    return Object.freeze({
      outcome: "delivered",
      root_id: context.authorization.root_id,
      cycle_id: context.authorization.acceptance_view.cycle_id,
      exact_revision: context.authorization.acceptance_view.exact_revision,
      pull_request: pullRequest,
      root_revision: state.completion_slot.record.basis_issue_revision,
    });
  }

  async #invalidateAndStop(
    context: DeliveryContext,
    state: DeliveryRecordState,
    observation: DeliveryObservation,
    evidence: Parameters<DeliveryTerminalRecordStore["writeInvalidation"]>[0]["invalidation_evidence"],
    reasonCode: string,
    reasonMarkdown: string,
  ): Promise<AcceptedRevisionDeliveryResult> {
    if (state.invalidation_slot.state === "invalidation") {
      return this.#notDelivered(context.authorization, "delivery_invalidated");
    }
    if (state.invalidation_slot.state !== "empty") {
      return this.#notDelivered(context.authorization, "invalid_contract");
    }
    try {
      await this.options.record_store.writeInvalidation({
        authorization: context.authorization,
        correlation_id: context.correlation_id,
        state,
        observation: createDeliveryObservationInput(
          observation,
          context.authorization.acceptance_view.exact_revision,
        ),
        invalidation_evidence: evidence,
        reason_code: reasonCode,
        reason_markdown: reasonMarkdown,
      }, context.execution);
    } catch {
      return this.#notDelivered(context.authorization, "boundary_unavailable");
    }
    try {
      await this.#projectRootFailed(context);
    } catch (error) {
      if (error instanceof DeliveryAbort) {
        return this.#notDelivered(context.authorization, error.code);
      }
      return this.#notDelivered(context.authorization, "root_failure_projection_unconfirmed");
    }
    return this.#notDelivered(context.authorization, "delivery_invalidated");
  }

  async #projectRootFailed(context: DeliveryContext): Promise<void> {
    const before = await this.#readRoot(context);
    if (before.status_id === this.#rootFailedState || before.status === "Done") return;
    if (before.status_id !== this.#rootInProgressState && before.status_id !== this.#rootInReviewState) {
      throw new DeliveryAbort("root_status_conflict");
    }
    const rootTaskId = parseTaskIssueId(context.authorization.root_id);
    const call: UpdateIssueCall = Object.freeze({
      schema_version: 1,
      function: "update_issue",
      root_id: context.authorization.root_id,
      runtime_generation: context.authorization.runtime_generation,
      correlation_id: context.correlation_id,
      capability: TASK_MCP_CAPABILITIES.update_issue,
      input: Object.freeze({
        issue_id: rootTaskId,
        expected_revision: before.revision,
        desired: Object.freeze({ state_id: this.#rootFailedState }),
      }),
    });
    const receipt = await this.#taskEffect(context, call);
    const after = await this.#readRoot(context);
    if (after.status === "Done") return;
    if (
      after.status_id !== this.#rootFailedState
      || after.revision === before.revision
      || !sameRootExceptStatusAndRevision(before, after)
    ) throw new DeliveryAbort("root_failure_projection_unconfirmed");
    this.#assertRootUpdateReceipt(receipt, before, after);
  }

  async #deliverExactRevision(context: DeliveryContext): Promise<PullRequestSnapshot> {
    const exactRevision = context.authorization.acceptance_view.exact_revision;
    let observation = await this.#readDelivery(context);
    if (observation.remote_revision !== null && observation.remote_revision !== exactRevision) {
      throw new DeliveryAbort("remote_revision_conflict");
    }
    if (observation.remote_revision === null) {
      if (observation.matching_pull_requests.length !== 0) {
        throw new DeliveryAbort("pull_request_conflict");
      }
      const receipt = await this.#deliveryEffect(
        context,
        () => this.options.delivery.push(context.request),
      );
      observation = await this.#readDelivery(context);
      this.#assertValidReceipt(receipt);
      if (observation.remote_revision !== null && observation.remote_revision !== exactRevision) {
        throw new DeliveryAbort("remote_revision_conflict");
      }
      if (observation.remote_revision !== exactRevision) {
        throw new DeliveryAbort("push_unconfirmed");
      }
      this.#assertUsableReceipt(receipt);
    }

    if (observation.matching_pull_requests.length > 0) {
      return this.#exactPullRequest(observation, exactRevision);
    }
    const request = Object.freeze({
      ...context.request,
      expected_remote_revision: exactRevision,
    });
    const receipt = await this.#deliveryEffect(
      context,
      () => this.options.delivery.createPullRequest(request),
    );
    observation = await this.#readDelivery(context);
    this.#assertValidReceipt(receipt);
    if (observation.remote_revision !== exactRevision) {
      throw new DeliveryAbort(observation.remote_revision === null
        ? "pull_request_unconfirmed"
        : "remote_revision_conflict");
    }
    if (observation.matching_pull_requests.length === 0) {
      throw new DeliveryAbort("pull_request_unconfirmed");
    }
    this.#exactPullRequest(observation, exactRevision);
    this.#assertUsableReceipt(receipt);

    const finalObservation = await this.#readDelivery(context);
    return this.#exactPullRequest(finalObservation, exactRevision);
  }

  async #moveRootToInReview(context: DeliveryContext): Promise<TaskRevision> {
    const before = await this.#readRoot(context);
    const rootTaskId = parseTaskIssueId(context.authorization.root_id);
    if (before.status_id === this.#rootInReviewState) return before.revision;
    if (before.status_id !== this.#rootInProgressState) {
      throw new DeliveryAbort("root_status_conflict");
    }
    const call: UpdateIssueCall = Object.freeze({
      schema_version: 1,
      function: "update_issue",
      root_id: context.authorization.root_id,
      runtime_generation: context.authorization.runtime_generation,
      correlation_id: context.correlation_id,
      capability: TASK_MCP_CAPABILITIES.update_issue,
      input: Object.freeze({
        issue_id: rootTaskId,
        expected_revision: before.revision,
        desired: Object.freeze({ state_id: this.#rootInReviewState }),
      }),
    });
    const receipt = await this.#taskEffect(context, call);
    const after = await this.#readRoot(context);
    if (receipt.state === "invalid") throw new DeliveryAbort("invalid_contract");
    if (
      after.status_id !== this.#rootInReviewState
      || after.revision === before.revision
      || !sameRootExceptStatusAndRevision(before, after)
    ) {
      if (after.status_id === this.#rootInProgressState && sameRootExceptStatusAndRevision(before, after)) {
        throw new DeliveryAbort("root_update_unconfirmed");
      }
      throw new DeliveryAbort("root_status_conflict");
    }
    this.#assertRootUpdateReceipt(receipt, before, after);
    return after.revision;
  }

  async #readDelivery(context: DeliveryContext): Promise<DeliveryObservation> {
    context.execution.assertActive();
    let observation: DeliveryObservation;
    try {
      observation = await this.options.delivery.read(context.identity);
    } catch {
      throw new DeliveryAbort("boundary_unavailable");
    }
    context.execution.assertActive();
    if (
      typeof observation !== "object"
      || observation === null
      || !sameDeliveryIdentity(observation.identity, context.identity)
      || !Array.isArray(observation.matching_pull_requests)
    ) throw new DeliveryAbort("invalid_contract");
    return observation;
  }

  async #deliveryEffect(
    context: DeliveryContext,
    effect: () => Promise<unknown>,
  ): Promise<EffectReceipt> {
    context.execution.assertActive();
    let value: unknown;
    try {
      value = await effect();
    } catch {
      context.execution.assertActive();
      return "unavailable";
    }
    context.execution.assertActive();
    try {
      const result = parseMutationResult(value);
      if (
        result.target_id !== context.authorization.root_id
        || result.correlation_id !== context.correlation_id
      ) return "invalid";
      return "valid";
    } catch {
      return "invalid";
    }
  }

  async #readRoot(context: DeliveryContext): Promise<TaskIssueSnapshot> {
    const rootTaskId = parseTaskIssueId(context.authorization.root_id);
    const call: GetIssueCall = Object.freeze({
      schema_version: 1,
      function: "get_issue",
      root_id: context.authorization.root_id,
      runtime_generation: context.authorization.runtime_generation,
      correlation_id: context.correlation_id,
      capability: TASK_MCP_CAPABILITIES.get_issue,
      input: Object.freeze({ issue_id: rootTaskId }),
    });
    context.execution.assertActive();
    let value: unknown;
    try {
      value = await this.options.task_manager.get_issue(
        call,
        this.#taskExecution(context, call),
      );
    } catch {
      throw new DeliveryAbort("boundary_unavailable");
    }
    context.execution.assertActive();
    try {
      const result = parseTaskMcpResult(value, call);
      if (result.function !== "get_issue") throw new Error("unexpected_task_result");
      const issue = result.output.issue;
      if (
        issue === null
        || issue.issue_id !== rootTaskId
        || issue.parent_issue_id !== null
        || !issue.label_ids.includes(this.#rootLabelId)
      ) throw new DeliveryAbort("root_status_conflict");
      return issue;
    } catch (error) {
      if (error instanceof DeliveryAbort) throw error;
      throw new DeliveryAbort("invalid_contract");
    }
  }

  async #taskEffect(
    context: DeliveryContext,
    call: UpdateIssueCall,
  ): Promise<TaskEffectReceipt> {
    context.execution.assertActive();
    let value: unknown;
    try {
      value = await this.options.task_manager.update_issue(
        call,
        this.#taskExecution(context, call),
      );
    } catch {
      context.execution.assertActive();
      return Object.freeze({ state: "unavailable", result: null });
    }
    context.execution.assertActive();
    try {
      const result = parseTaskMcpResult(value, call);
      const rootTaskId = parseTaskIssueId(context.authorization.root_id);
      const fresh = result.output.fresh_resource;
      if (
        result.function !== "update_issue"
        || result.output.target.kind !== "issue"
        || result.output.target.issue_id !== rootTaskId
        || (
          fresh !== null
          && (!("issue_id" in fresh) || fresh.issue_id !== rootTaskId)
        )
        || result.output.concrete_diff.some((change) => (
          change.kind !== "field_changed" || change.issue_id !== rootTaskId
        ))
      ) return Object.freeze({ state: "invalid", result: null });
      return Object.freeze({ state: "valid", result });
    } catch {
      return Object.freeze({ state: "invalid", result: null });
    }
  }

  #taskExecution(
    context: DeliveryContext,
    call: GetIssueCall | UpdateIssueCall,
  ): TaskManageExecution {
    const view = context.authorization.acceptance_view;
    return Object.freeze({
      assertActive: () => context.execution.assertActive(),
      caller: this.options.task_caller_issuer.issue({
        caller: "cycle_machine",
        root_id: context.authorization.root_id,
        cycle_id: view.cycle_id,
        runtime_generation: context.authorization.runtime_generation,
        correlation_id: context.correlation_id,
        cycle_seal_digest: view.cycle_seal_digest,
        graph_seal_digest: view.graph_seal_digest,
      }, call),
    });
  }

  #exactPullRequest(
    observation: DeliveryObservation,
    revision: Revision,
  ): PullRequestSnapshot {
    try {
      return verifiedDelivery(observation, revision);
    } catch {
      throw new DeliveryAbort("pull_request_conflict");
    }
  }

  #assertUsableReceipt(receipt: EffectReceipt): void {
    if (receipt === "invalid") throw new DeliveryAbort("invalid_contract");
    if (receipt === "unavailable") throw new DeliveryAbort("boundary_unavailable");
  }

  #assertValidReceipt(receipt: EffectReceipt): void {
    if (receipt === "invalid") throw new DeliveryAbort("invalid_contract");
  }

  #assertRootUpdateReceipt(
    receipt: TaskEffectReceipt,
    before: TaskIssueSnapshot,
    after: TaskIssueSnapshot,
  ): void {
    if (receipt.state !== "valid") {
      throw new DeliveryAbort(receipt.state === "invalid"
        ? "invalid_contract"
        : "boundary_unavailable");
    }
    const result = receipt.result;
    if (result.output.outcome !== "applied") return;
    const fresh = result.output.fresh_resource;
    const [change] = result.output.concrete_diff;
    if (
      fresh === null
      || !("issue_id" in fresh)
      || fresh.issue_id !== after.issue_id
      || fresh.revision !== after.revision
      || fresh.status_id !== after.status_id
      || !sameRootExceptStatusAndRevision(fresh, after)
      || result.output.concrete_diff.length !== 1
      || change?.kind !== "field_changed"
      || change.issue_id !== before.issue_id
      || change.field !== "status"
      || change.before !== before.status_id
      || change.after !== after.status_id
      || result.output.sanitized_reason !== null
    ) throw new DeliveryAbort("invalid_contract");
  }

  #notDelivered(
    authorization: AcceptedRevisionAuthorization,
    reasonCode: AcceptedRevisionDeliveryFailureCode,
  ): AcceptedRevisionDeliveryResult {
    return Object.freeze({
      outcome: "not_delivered",
      root_id: authorization.root_id,
      cycle_id: authorization.acceptance_view.cycle_id,
      exact_revision: authorization.acceptance_view.exact_revision,
      reason_code: reasonCode,
    });
  }
}
