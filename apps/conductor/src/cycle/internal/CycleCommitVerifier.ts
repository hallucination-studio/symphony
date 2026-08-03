import { createHash } from "node:crypto";

import type {
  CycleAdvanceRequest,
  StageExecutionSnapshot,
} from "../../contracts/cycle.js";
import type { SealedCycleBasis } from "../../contracts/cycle-records.js";
import {
  parseTaskIssueId,
  type StageIssueId,
  type TaskStateId,
} from "../../contracts/identity.js";
import { parseMutationResult } from "../../contracts/mutation.js";
import type { GitSnapshot, TaskIssueSnapshot } from "../../contracts/observation.js";
import type {
  GitCommitProof,
  GitWorkspaceInterface,
  RootWorkspaceIdentity,
} from "../../git/api/GitWorkspaceInterface.js";
import {
  parseVerifyRequest,
  parseVerifyResult,
  type VerifyPerformerInterface,
  type VerifyTarget,
} from "../../performer/api/StagePerformerInterface.js";
import type {
  TaskManageCallerIssuer,
  TaskWorkflowIdentities,
} from "../../task-management/api/TaskManageCapability.js";
import { parseTaskWorkflowIdentities } from "../../task-management/api/TaskManageCapability.js";
import type { TaskManageCommandInterface } from "../../task-management/api/TaskManageCommandInterface.js";
import {
  TASK_MCP_CAPABILITIES,
  type TaskMutationOutput,
  type UpdateIssueCall,
} from "../../task-management/mcp/TaskMcpSchemas.js";
import { bindCycleTaskManageCommand } from "../../runtime/CycleTaskManageCommand.js";
import {
  bindCycleAdvanceRequest,
  type FreshCycleExecutionReader,
} from "./CycleMachine.js";
import type { CycleTransition } from "./CycleTransition.js";
import type { BuiltPlanGraphManifest } from "./PlanGraphManifest.js";
import type { PersistedCommitBasis } from "./PlanCompletionRecord.js";

type CommitAndVerifyTransition = Extract<CycleTransition, { readonly action: "commit_and_verify" }>;

const usedVerifyPerformers = new WeakSet<VerifyPerformerInterface>();

export interface CycleVerifyPerformerFactory {
  create(target: VerifyTarget): Promise<VerifyPerformerInterface>;
}

export interface CycleCommitVerifierOptions {
  readonly workflow: TaskWorkflowIdentities;
  readonly caller_issuer: TaskManageCallerIssuer;
  readonly task_manager: TaskManageCommandInterface;
  readonly reader: FreshCycleExecutionReader;
  readonly git_workspace: GitWorkspaceInterface;
  readonly performer_factory: CycleVerifyPerformerFactory;
  readonly completion_writer: {
    readCommitBasis(
      snapshot: CycleAdvanceRequest,
      basis: SealedCycleBasis,
      built: BuiltPlanGraphManifest,
    ): Promise<PersistedCommitBasis>;
    persistVerify(
      snapshot: CycleAdvanceRequest,
      basis: SealedCycleBasis,
      built: BuiltPlanGraphManifest,
      result: ReturnType<typeof parseVerifyResult>,
      execution: { assertActive(): void },
    ): Promise<unknown>;
  };
}

export interface CycleCommitVerificationResult {
  readonly snapshot: CycleAdvanceRequest;
  readonly outcome: "awaiting_acceptance" | "failed";
}

export class CycleCommitVerificationError extends Error {
  constructor(readonly snapshot: CycleAdvanceRequest) {
    super("cycle_commit_verification_failed");
    this.name = "CycleCommitVerificationError";
  }
}

function statusCall(
  request: CycleAdvanceRequest,
  issueId: StageIssueId | CycleAdvanceRequest["cycle_id"],
  expectedRevision: UpdateIssueCall["input"]["expected_revision"],
  stateId: TaskStateId,
): UpdateIssueCall {
  return Object.freeze({
    schema_version: 1,
    function: "update_issue",
    root_id: request.root_id,
    runtime_generation: request.runtime_generation,
    correlation_id: request.correlation_id,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: Object.freeze({
      issue_id: parseTaskIssueId(issueId),
      expected_revision: expectedRevision,
      desired: Object.freeze({ state_id: stateId }),
    }),
  });
}

function appliedUpdatedIssue(output: TaskMutationOutput): TaskIssueSnapshot {
  if (
    output.outcome !== "applied"
    || output.fresh_resource === null
    || !("issue_id" in output.fresh_resource)
  ) throw new Error("commit_verify_status_mutation_not_applied");
  return output.fresh_resource;
}

function samePullRequest(left: GitSnapshot["pull_request"], right: GitSnapshot["pull_request"]): boolean {
  if (left === null || right === null) return left === right;
  return left.provider === right.provider
    && left.repository_id === right.repository_id
    && left.base_branch === right.base_branch
    && left.head_branch === right.head_branch
    && left.state === right.state
    && left.head_revision === right.head_revision
    && left.url === right.url;
}

function sameGit(left: GitSnapshot, right: GitSnapshot): boolean {
  return left.repository_id === right.repository_id
    && left.base_branch === right.base_branch
    && left.head_branch === right.head_branch
    && left.head_revision === right.head_revision
    && left.workspace_state === right.workspace_state
    && left.diff_digest === right.diff_digest
    && samePullRequest(left.pull_request, right.pull_request);
}

function sameStage(left: StageExecutionSnapshot, right: StageExecutionSnapshot): boolean {
  return left.issue_id === right.issue_id
    && left.revision === right.revision
    && left.sealed_revision === right.sealed_revision
    && left.kind === right.kind
    && left.title === right.title
    && left.description_markdown === right.description_markdown
    && left.parent_cycle_id === right.parent_cycle_id
    && left.status === right.status;
}

function sameStages(
  left: readonly StageExecutionSnapshot[],
  right: readonly StageExecutionSnapshot[],
): boolean {
  if (left.length !== right.length) return false;
  const byId = new Map(right.map((stage) => [stage.issue_id, stage]));
  return left.every((stage) => {
    const candidate = byId.get(stage.issue_id);
    return candidate !== undefined && sameStage(stage, candidate);
  });
}

function sameRelations(left: CycleAdvanceRequest, right: CycleAdvanceRequest): boolean {
  if (left.sealed_relations.length !== right.sealed_relations.length) return false;
  const byId = new Map(right.sealed_relations.map((relation) => [relation.relation_id, relation]));
  return left.sealed_relations.every((relation) => {
    const candidate = byId.get(relation.relation_id);
    return candidate !== undefined
      && candidate.revision === relation.revision
      && candidate.prerequisite_issue_id === relation.prerequisite_issue_id
      && candidate.dependent_issue_id === relation.dependent_issue_id;
  });
}

function sameSpecification(left: CycleAdvanceRequest, right: CycleAdvanceRequest): boolean {
  const a = left.specification;
  const b = right.specification;
  return a.schema_version === b.schema_version
    && a.root_id === b.root_id
    && a.cycle_id === b.cycle_id
    && a.root_definition_revision === b.root_definition_revision
    && a.cycle_revision === b.cycle_revision
    && a.correlation_id === b.correlation_id
    && a.cycle_description_markdown === b.cycle_description_markdown
    && a.root_adr_markdown === b.root_adr_markdown
    && a.status === b.status
    && a.seal_digest === b.seal_digest;
}

function sameCommon(left: CycleAdvanceRequest, right: CycleAdvanceRequest): boolean {
  return left.schema_version === right.schema_version
    && left.root_id === right.root_id
    && left.cycle_id === right.cycle_id
    && left.runtime_generation === right.runtime_generation
    && left.correlation_id === right.correlation_id
    && left.sealed_graph_digest === right.sealed_graph_digest
    && sameSpecification(left, right)
    && sameRelations(left, right);
}

function assertVerifyStatusReadback(
  before: CycleAdvanceRequest,
  after: CycleAdvanceRequest,
  selected: StageExecutionSnapshot,
  fresh: TaskIssueSnapshot,
  expectedStatus: "in_progress" | "done" | "failed",
  workflow: TaskWorkflowIdentities,
): void {
  const verify = after.verify_issue;
  if (
    !sameCommon(before, after)
    || before.cycle_revision !== after.cycle_revision
    || before.cycle_status !== after.cycle_status
    || !sameGit(before.git, after.git)
    || (before.plan_issue === null) !== (after.plan_issue === null)
    || (
      before.plan_issue !== null
      && after.plan_issue !== null
      && !sameStage(before.plan_issue, after.plan_issue)
    )
    || !sameStages(before.sealed_work_issues, after.sealed_work_issues)
    || verify === null
    || verify.issue_id !== selected.issue_id
    || verify.revision !== fresh.revision
    || verify.sealed_revision !== selected.sealed_revision
    || verify.kind !== "verify"
    || verify.title !== selected.title
    || verify.description_markdown !== selected.description_markdown
    || verify.parent_cycle_id !== selected.parent_cycle_id
    || verify.status !== expectedStatus
    || fresh.issue_id !== parseTaskIssueId(selected.issue_id)
    || fresh.status !== workflow.stage_states[expectedStatus]
    || fresh.title !== selected.title
    || fresh.description !== selected.description_markdown
    || fresh.parent_id !== parseTaskIssueId(selected.parent_cycle_id)
    || fresh.labels.length !== 1
    || fresh.labels[0] !== workflow.labels.verify
    || fresh.delegate_id !== null
    || fresh.priority !== null
  ) throw new Error("verify_status_readback_mismatch");
}

function assertCycleStatusReadback(
  before: CycleAdvanceRequest,
  after: CycleAdvanceRequest,
  fresh: TaskIssueSnapshot,
  expectedStatus: "awaiting_acceptance" | "failed",
  workflow: TaskWorkflowIdentities,
): void {
  if (
    !sameCommon(before, after)
    || after.cycle_revision !== fresh.revision
    || after.cycle_revision === before.cycle_revision
    || after.cycle_status !== expectedStatus
    || !sameGit(before.git, after.git)
    || (before.plan_issue === null) !== (after.plan_issue === null)
    || (
      before.plan_issue !== null
      && after.plan_issue !== null
      && !sameStage(before.plan_issue, after.plan_issue)
    )
    || !sameStages(before.sealed_work_issues, after.sealed_work_issues)
    || (before.verify_issue === null) !== (after.verify_issue === null)
    || (
      before.verify_issue !== null
      && after.verify_issue !== null
      && !sameStage(before.verify_issue, after.verify_issue)
    )
    || fresh.issue_id !== parseTaskIssueId(before.cycle_id)
    || fresh.status !== workflow.cycle_states[expectedStatus]
    || fresh.description !== before.specification.cycle_description_markdown
    || fresh.parent_id !== parseTaskIssueId(before.root_id)
    || fresh.labels.length !== 1
    || fresh.labels[0] !== workflow.labels.cycle
    || fresh.delegate_id !== null
    || fresh.priority !== null
  ) throw new Error("cycle_status_readback_mismatch");
}

function assertTransition(
  request: CycleAdvanceRequest,
  transition: CommitAndVerifyTransition,
): StageExecutionSnapshot {
  const verify = request.verify_issue;
  if (
    transition.root_id !== request.root_id
    || transition.cycle_id !== request.cycle_id
    || transition.runtime_generation !== request.runtime_generation
    || transition.correlation_id !== request.correlation_id
    || transition.cycle_revision !== request.cycle_revision
    || transition.seal_digest !== request.specification.seal_digest
    || transition.sealed_graph_digest !== request.sealed_graph_digest
    || transition.repository_id !== request.git.repository_id
    || transition.base_branch !== request.git.base_branch
    || transition.head_branch !== request.git.head_branch
    || transition.expected_head_revision !== request.git.head_revision
    || transition.expected_workspace_state !== request.git.workspace_state
    || transition.expected_diff_digest !== request.git.diff_digest
    || verify === null
    || verify.kind !== "verify"
    || verify.status !== "todo"
    || transition.verify_issue_id !== verify.issue_id
    || transition.verify_issue_revision !== verify.revision
  ) throw new Error("commit_verify_transition_mismatch");
  return verify;
}

function assertCommitted(before: GitSnapshot, after: GitSnapshot): void {
  if (
    before.head_revision === null
    || after.repository_id !== before.repository_id
    || after.base_branch !== before.base_branch
    || after.head_branch !== before.head_branch
    || after.head_revision === null
    || after.head_revision === before.head_revision
    || after.workspace_state !== "clean"
    || after.diff_digest === before.diff_digest
    || !samePullRequest(after.pull_request, before.pull_request)
  ) throw new Error("commit_readback_mismatch");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertCommitProof(
  proof: GitCommitProof,
  carryingObjectId: NonNullable<GitSnapshot["head_revision"]>,
  persisted: PersistedCommitBasis,
): void {
  if (
    proof.carrying_object_id !== carryingObjectId
    || digest(proof.parent_revision) !== persisted.workspace_parent_revision_digest
    || digest(proof.diff_digest) !== persisted.workspace_diff_digest
    || proof.cycle_id !== persisted.proof.cycle_id
    || proof.specification_seal_digest !== persisted.proof.specification_seal_digest
    || proof.graph_seal_digest !== persisted.proof.graph_seal_digest
    || proof.work_completion_set_digest !== persisted.proof.work_completion_set_digest
  ) throw new Error("commit_proof_mismatch");
}

function workspaceIdentity(request: CycleAdvanceRequest): RootWorkspaceIdentity {
  return Object.freeze({
    root_id: request.root_id,
    repository_id: request.git.repository_id,
    base_branch: request.git.base_branch,
    head_branch: request.git.head_branch,
  });
}

export class CycleCommitVerifier {
  #active = false;
  readonly #callerIssuer: TaskManageCallerIssuer;
  #epoch = 0;
  readonly #gitWorkspace: GitWorkspaceInterface;
  #performer: VerifyPerformerInterface | null = null;
  readonly #performerFactory: CycleVerifyPerformerFactory;
  readonly #reader: FreshCycleExecutionReader;
  #retirement: Promise<void> | null = null;
  #retired = false;
  readonly #taskManager: TaskManageCommandInterface;
  readonly #workflow: TaskWorkflowIdentities;
  readonly #completionWriter: CycleCommitVerifierOptions["completion_writer"];

  constructor(options: CycleCommitVerifierOptions) {
    this.#workflow = parseTaskWorkflowIdentities(options.workflow);
    this.#callerIssuer = options.caller_issuer;
    this.#taskManager = options.task_manager;
    this.#reader = options.reader;
    this.#gitWorkspace = options.git_workspace;
    this.#performerFactory = options.performer_factory;
    this.#completionWriter = options.completion_writer;
  }

  async execute(
    request: CycleAdvanceRequest,
    transition: CommitAndVerifyTransition,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
  ): Promise<CycleCommitVerificationResult> {
    if (this.#retired || this.#active) throw new CycleCommitVerificationError(request);
    this.#active = true;
    const epoch = this.#epoch;
    let current = request;
    try {
      const verify = assertTransition(request, transition);
      const identity = workspaceIdentity(request);
      const persistedCommitBasis = await this.#completionWriter.readCommitBasis(request, basis, built);
      this.#assertActive(epoch);
      const before = await this.#gitWorkspace.read(identity);
      this.#assertActive(epoch);
      current = bindCycleAdvanceRequest({ ...request, git: before });
      if (!sameGit(before, request.git)) {
        throw new Error("commit_precondition_mismatch");
      }
      let committed: GitSnapshot;
      if (before.workspace_state === "dirty") {
        if (
          before.head_revision === null
          || digest(before.head_revision) !== persistedCommitBasis.workspace_parent_revision_digest
          || digest(before.diff_digest) !== persistedCommitBasis.workspace_diff_digest
        ) throw new Error("work_completion_git_basis_mismatch");
        const rawMutation = await this.#gitWorkspace.commit(Object.freeze({
          ...identity,
          correlation_id: request.correlation_id,
          expected_head_revision: transition.expected_head_revision,
          expected_diff_digest: transition.expected_diff_digest,
          proof: persistedCommitBasis.proof,
        }));
        this.#assertActive(epoch);
        let mutation: ReturnType<typeof parseMutationResult> | null = null;
        try {
          mutation = parseMutationResult(rawMutation);
        } catch {
          mutation = null;
        }
        committed = await this.#gitWorkspace.read(identity);
        this.#assertActive(epoch);
        current = bindCycleAdvanceRequest({ ...current, git: committed });
        if (
          mutation === null
          || mutation.outcome !== "applied"
          || mutation.target_id !== request.root_id
          || mutation.correlation_id !== request.correlation_id
        ) throw new Error("commit_mutation_failed");
        assertCommitted(before, committed);
      } else if (before.workspace_state === "clean" && before.head_revision !== null) {
        committed = before;
      } else {
        throw new Error("commit_precondition_mismatch");
      }
      if (committed.head_revision === null) throw new Error("committed_head_missing");
      const commitProof = await this.#gitWorkspace.readCommitProof(identity, committed.head_revision);
      this.#assertActive(epoch);
      assertCommitProof(commitProof, committed.head_revision, persistedCommitBasis);

      current = await this.#transitionVerify(current, verify, "in_progress", epoch);
      const startedVerify = current.verify_issue;
      if (startedVerify === null || startedVerify.status !== "in_progress") {
        throw new Error("started_verify_missing");
      }
      const target = Object.freeze({
        root_id: current.root_id,
        runtime_generation: current.runtime_generation,
        cycle_id: current.cycle_id,
        cycle_revision: current.cycle_revision,
        verify_issue_id: startedVerify.issue_id,
        verify_issue_revision: startedVerify.revision,
        revision: committed.head_revision!,
      });
      const performer = await this.#createPerformer(target, epoch);
      const verifyRequest = parseVerifyRequest({
        schema_version: 1,
        ...target,
        correlation_id: current.correlation_id,
        cycle_description_markdown: current.specification.cycle_description_markdown,
        verify_issue_description_markdown: startedVerify.description_markdown,
      }, target);
      let rawVerifyResult: unknown = null;
      let verifyFailure: unknown = null;
      try {
        rawVerifyResult = await performer.verify(verifyRequest);
        this.#assertActive(epoch);
      } catch (error) {
        verifyFailure = error;
      }
      try {
        await this.#closePerformer(epoch);
      } catch (error) {
        verifyFailure ??= error;
      }
      this.#assertActive(epoch);
      const afterVerify = await this.#gitWorkspace.read(identity);
      this.#assertActive(epoch);
      if (!sameGit(afterVerify, committed)) {
        current = bindCycleAdvanceRequest({ ...current, git: afterVerify });
        throw new Error("post_verify_git_mismatch");
      }
      if (verifyFailure !== null) throw verifyFailure;
      const verifyResult = parseVerifyResult(rawVerifyResult, verifyRequest);
      current = bindCycleAdvanceRequest({ ...current, git: afterVerify });
      await this.#completionWriter.persistVerify(
        current,
        basis,
        built,
        verifyResult,
        Object.freeze({ assertActive: () => this.#assertActive(epoch) }),
      );
      this.#assertActive(epoch);
      if (verifyResult.conclusion !== "passed") {
        current = await this.#transitionVerify(current, startedVerify, "failed", epoch);
        return Object.freeze({
          snapshot: current,
          outcome: "failed",
        });
      }

      current = await this.#transitionVerify(current, startedVerify, "done", epoch);
      current = await this.#transitionCycle(current, "awaiting_acceptance", epoch);
      return Object.freeze({
        snapshot: current,
        outcome: "awaiting_acceptance",
      });
    } catch {
      if (!this.#isActive(epoch)) throw new CycleCommitVerificationError(current);
      await this.#closePerformerIfCurrent(epoch);
      return Object.freeze({ snapshot: current, outcome: "failed" });
    } finally {
      this.#active = false;
    }
  }

  retire(): Promise<void> {
    if (this.#retirement !== null) return this.#retirement;
    this.#retired = true;
    this.#epoch += 1;
    const performer = this.#performer;
    this.#performer = null;
    let retirement: Promise<void>;
    try {
      retirement = performer?.close() ?? Promise.resolve();
    } catch {
      retirement = Promise.reject(new Error("cycle_verify_retirement_failed"));
    }
    this.#retirement = retirement.catch(() => {
      throw new Error("cycle_verify_retirement_failed");
    });
    return this.#retirement;
  }

  async #transitionVerify(
    request: CycleAdvanceRequest,
    verify: StageExecutionSnapshot,
    status: "in_progress" | "done" | "failed",
    epoch: number,
  ): Promise<CycleAdvanceRequest> {
    const call = statusCall(request, verify.issue_id, verify.revision, this.#workflow.stage_states[status]);
    const command = bindCycleTaskManageCommand({
      snapshot: request,
      workflow: this.#workflow,
      caller_issuer: this.#callerIssuer,
      task_manager: this.#taskManager,
      mutation_manifest: [call],
    });
    const fresh = appliedUpdatedIssue((await command.update_issue(call, Object.freeze({
      assertActive: () => this.#assertActive(epoch),
    }))).output);
    const readback = await this.#readback(request, epoch, "verify_status_readback_missing");
    assertVerifyStatusReadback(request, readback, verify, fresh, status, this.#workflow);
    return readback;
  }

  async #transitionCycle(
    request: CycleAdvanceRequest,
    status: "awaiting_acceptance",
    epoch: number,
  ): Promise<CycleAdvanceRequest> {
    const call = statusCall(
      request,
      request.cycle_id,
      request.cycle_revision,
      this.#workflow.cycle_states[status],
    );
    const command = bindCycleTaskManageCommand({
      snapshot: request,
      workflow: this.#workflow,
      caller_issuer: this.#callerIssuer,
      task_manager: this.#taskManager,
      mutation_manifest: [call],
    });
    const fresh = appliedUpdatedIssue((await command.update_issue(call, Object.freeze({
      assertActive: () => this.#assertActive(epoch),
    }))).output);
    const readback = await this.#readback(request, epoch, "cycle_status_readback_missing");
    assertCycleStatusReadback(request, readback, fresh, status, this.#workflow);
    return readback;
  }

  async #readback(
    request: CycleAdvanceRequest,
    epoch: number,
    missingCode: string,
  ): Promise<CycleAdvanceRequest> {
    this.#assertActive(epoch);
    const raw = await this.#reader.read(Object.freeze({
      root_id: request.root_id,
      cycle_id: request.cycle_id,
      runtime_generation: request.runtime_generation,
      correlation_id: request.correlation_id,
    }));
    this.#assertActive(epoch);
    if (raw === null) throw new Error(missingCode);
    return bindCycleAdvanceRequest(raw);
  }

  async #createPerformer(target: VerifyTarget, epoch: number): Promise<VerifyPerformerInterface> {
    const performer = await this.#performerFactory.create(target);
    try {
      this.#assertActive(epoch);
      if (
        performer.role !== "verify"
        || performer.rootId !== target.root_id
        || performer.runtimeGeneration !== target.runtime_generation
        || performer.cycleId !== target.cycle_id
        || usedVerifyPerformers.has(performer)
      ) throw new Error("verify_performer_target_mismatch");
      usedVerifyPerformers.add(performer);
      this.#performer = performer;
      return performer;
    } catch (error) {
      await performer.close().catch(() => undefined);
      throw error;
    }
  }

  async #closePerformer(epoch: number): Promise<void> {
    this.#assertActive(epoch);
    const performer = this.#performer;
    this.#performer = null;
    if (performer !== null) await performer.close();
    this.#assertActive(epoch);
  }

  async #closePerformerIfCurrent(epoch: number): Promise<void> {
    if (!this.#isActive(epoch)) return;
    try {
      await this.#closePerformer(epoch);
    } catch {
      // Cleanup cannot authorize another Task or Git effect.
    }
  }

  #isActive(epoch: number): boolean {
    return !this.#retired && epoch === this.#epoch;
  }

  #assertActive(epoch: number): void {
    if (!this.#isActive(epoch)) throw new Error("cycle_verify_late_output");
  }
}
