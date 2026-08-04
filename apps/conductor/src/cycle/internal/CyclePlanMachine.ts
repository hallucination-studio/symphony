import { createHash } from "node:crypto";

import {
  parseSealedExecutionGraph,
  type CycleAdvanceRequest,
  type CycleAdvanceResult,
  type StageExecutionSnapshot,
} from "../../contracts/cycle.js";
import {
  parseStageCompletionRecord,
  stageCompletionTerminalStatus,
  type SealedCycleBasis,
  type StageCompletionRecord,
} from "../../contracts/cycle-records.js";
import {
  parseStageIssueId,
  parseTaskIssueId,
  type TaskIssueId,
  type TaskStateId,
} from "../../contracts/identity.js";
import type { TaskIssueSnapshot } from "../../contracts/task-management.js";
import type { GitWorkspaceInterface } from "../../git/api/GitWorkspaceInterface.js";
import { parseMarkdownText } from "../../contracts/validation.js";
import {
  deriveLastValidCycleBasisStatus,
  deriveLastValidStageBasisStatus,
} from "../../observation/TaskFacts.js";
import {
  parsePlanRequest,
  parsePlanResult,
  type PlanPerformerInterface,
  type PlanRequestTarget,
} from "../../performer/api/StagePerformerInterface.js";
import type {
  TaskManageCallerIssuer,
  TaskWorkflowIdentities,
} from "../../task-management/api/TaskManageCapability.js";
import { parseTaskWorkflowIdentities } from "../../task-management/api/TaskManageCapability.js";
import type {
  TaskManageBoundaryExecution,
  TaskManageCommandInterface,
} from "../../task-management/api/TaskManageCommandInterface.js";
import {
  TASK_MCP_CAPABILITIES,
  type CreateIssueCall,
  type TaskMutationOutput,
  type UpdateIssueCall,
} from "../../task-management/mcp/TaskMcpSchemas.js";
import { bindCycleTaskManageCommand } from "../../runtime/CycleTaskManageCommand.js";
import type {
  CycleMachineExecution,
  CycleMachineInterface,
} from "../api/CycleMachineInterface.js";
import {
  bindCycleAdvanceRequest,
} from "./CycleMachine.js";
import type { FreshCycleExecutionReader } from "./CycleMachine.js";
import { CycleGraphMaterializer } from "./CycleGraphMaterializer.js";
import {
  buildPlanGraphManifest,
  type BuiltPlanGraphManifest,
} from "./PlanGraphManifest.js";
import type { PlanCompletionRecordWriter } from "./PlanCompletionRecord.js";
import { reduceCycleTransition } from "./CycleTransition.js";
import {
  CycleCommitVerificationError,
  CycleCommitVerifier,
  type CycleVerifyPerformerFactory,
} from "./CycleCommitVerifier.js";
import {
  CycleWorkExecutionError,
  CycleWorkExecutor,
  type CycleWorkPerformerFactory,
} from "./CycleWorkExecutor.js";

const PLAN_TITLE = "Plan approved Cycle";
const PLAN_DESCRIPTION = parseMarkdownText(
  "## Plan\n\nCompile the approved Cycle into one sealed Work and Verify graph.",
  "invalid_plan_issue_description",
);
const usedPlanPerformers = new WeakSet<PlanPerformerInterface>();
type PlanTerminalStatus = "failed" | "canceled";
type CycleExecutionFailureReason =
  | "plan_phase_failed"
  | "work_phase_failed"
  | "verify_phase_failed"
  | "stage_failure_unconfirmed"
  | "lost_execution_context"
  | "lost_work_thread_context"
  | "active_root_admission_lost"
  | "cycle_transition_failed";

export interface CyclePlanPerformerFactory {
  create(target: PlanRequestTarget): Promise<PlanPerformerInterface>;
}

export interface FreshSealedCycleBasisReader {
  readSealedCycleBasis(cycleId: TaskIssueId): Promise<SealedCycleBasis>;
}

interface PlanCompletionRecordPersistence {
  persistCompleted(
    ...args: Parameters<PlanCompletionRecordWriter["persistCompleted"]>
  ): Promise<unknown>;
  persistPlanTerminal(...args: Parameters<PlanCompletionRecordWriter["persistPlanTerminal"]>): Promise<unknown>;
  readCycleTerminalRecord?(
    ...args: Parameters<PlanCompletionRecordWriter["readCycleTerminalRecord"]>
  ): ReturnType<PlanCompletionRecordWriter["readCycleTerminalRecord"]>;
  persistExternalTerminalInvalidation?(
    ...args: Parameters<PlanCompletionRecordWriter["persistExternalTerminalInvalidation"]>
  ): Promise<unknown>;
  persistExternalTerminalCycleInvalidation?(
    ...args: Parameters<PlanCompletionRecordWriter["persistExternalTerminalCycleInvalidation"]>
  ): Promise<unknown>;
  readCompleted(
    request: CycleAdvanceRequest,
    basis: SealedCycleBasis,
  ): Promise<BuiltPlanGraphManifest | null>;
  readStageCompletion(
    request: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
    stageId: TaskIssueId,
  ): Promise<StageCompletionRecord | null>;
  readPlanCompletion(
    request: CycleAdvanceRequest,
    basis: SealedCycleBasis,
  ): Promise<StageCompletionRecord | null>;
  assertAcceptanceEvidence(
    request: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
  ): Promise<void>;
  readCommitBasis(...args: Parameters<PlanCompletionRecordWriter["readCommitBasis"]>): ReturnType<PlanCompletionRecordWriter["readCommitBasis"]>;
  persistStageFailure(
    request: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest | null,
    stageId: TaskIssueId,
    reasonCode: string,
    reasonMarkdown: string,
    execution: TaskManageBoundaryExecution,
    terminalOutcome?: "failed" | "canceled",
  ): Promise<unknown>;
  persistCycleFailure(
    request: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    reasonCode: string,
    reasonMarkdown: string,
    failedStageId: TaskIssueId | null,
    execution: TaskManageBoundaryExecution,
    terminalOutcome?: "failed" | "canceled",
  ): Promise<unknown>;
  persistWork(...args: Parameters<PlanCompletionRecordWriter["persistWork"]>): Promise<unknown>;
  persistVerify(...args: Parameters<PlanCompletionRecordWriter["persistVerify"]>): Promise<unknown>;
  persistPlanInvalidation(...args: Parameters<PlanCompletionRecordWriter["persistPlanInvalidation"]>): Promise<unknown>;
  hasPlanInvalidation(...args: Parameters<PlanCompletionRecordWriter["hasPlanInvalidation"]>): Promise<boolean>;
}

export interface CyclePlanMachineOptions {
  readonly workflow: TaskWorkflowIdentities;
  readonly caller_issuer: TaskManageCallerIssuer;
  readonly task_manager: TaskManageCommandInterface;
  readonly reader: FreshCycleExecutionReader;
  readonly sealed_basis_reader: FreshSealedCycleBasisReader;
  readonly plan_completion_record_writer: PlanCompletionRecordPersistence;
  readonly git_workspace: GitWorkspaceInterface;
  readonly plan_performer_factory: CyclePlanPerformerFactory;
  readonly work_performer_factory: CycleWorkPerformerFactory;
  readonly verify_performer_factory: CycleVerifyPerformerFactory;
}

function result(
  request: CycleAdvanceRequest,
  outcome: "advanced" | "awaiting_acceptance" | "no_action",
  toCycleRevision = request.cycle_revision,
): CycleAdvanceResult {
  return Object.freeze({
    schema_version: 1,
    root_id: request.root_id,
    cycle_id: request.cycle_id,
    runtime_generation: request.runtime_generation,
    correlation_id: request.correlation_id,
    seal_digest: request.specification.seal_digest,
    from_cycle_revision: request.cycle_revision,
    to_cycle_revision: toCycleRevision,
    outcome,
    reason_markdown: null,
  });
}

function failedResult(
  request: CycleAdvanceRequest,
  outcome: "terminal_failed" | "precondition_failed",
  toCycleRevision: CycleAdvanceResult["to_cycle_revision"],
  reason: CycleExecutionFailureReason,
): CycleAdvanceResult {
  const reasonMarkdown = failureReasonMarkdown(reason);
  return Object.freeze({
    schema_version: 1,
    root_id: request.root_id,
    cycle_id: request.cycle_id,
    runtime_generation: request.runtime_generation,
    correlation_id: request.correlation_id,
    seal_digest: request.specification.seal_digest,
    from_cycle_revision: request.cycle_revision,
    to_cycle_revision: toCycleRevision,
    outcome,
    reason_markdown: reasonMarkdown,
  });
}

function failureReasonMarkdown(reason: CycleExecutionFailureReason) {
  return parseMarkdownText(
    reason === "lost_execution_context"
      ? "Cycle failed because the live Plan execution context was lost."
      : reason === "lost_work_thread_context"
        ? "Cycle failed because the shared Work thread was lost before the next Work Item."
      : reason === "active_root_admission_lost"
        ? "Cycle was canceled because the active Root lost admission."
      : reason === "verify_phase_failed"
        ? "Cycle failed during exact commit or Verify execution."
      : reason === "work_phase_failed"
        ? "Cycle failed during Work execution or Work status confirmation."
      : reason === "cycle_transition_failed"
        ? "Cycle failure could not be confirmed from the current exact revision."
        : reason === "stage_failure_unconfirmed"
          ? "Cycle failed, but an active Stage terminal status could not be confirmed."
        : "Cycle failed during Plan execution or graph materialization.",
    "invalid_cycle_plan_failure_reason",
  );
}

function stageList(request: CycleAdvanceRequest): readonly StageExecutionSnapshot[] {
  return [
    ...(request.plan_issue === null ? [] : [request.plan_issue]),
    ...request.sealed_work_issues,
    ...(request.verify_issue === null ? [] : [request.verify_issue]),
  ];
}

function stageTaskStatus(stage: StageExecutionSnapshot): "Todo" | "In Progress" | "Done" | "Failed" | "Canceled" {
  switch (stage.status) {
    case "todo": return "Todo";
    case "in_progress": return "In Progress";
    case "done": return "Done";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
  }
}

function cycleTaskStatus(
  status: CycleAdvanceRequest["cycle_status"],
): "Draft" | "In Progress" | "Awaiting Acceptance" | "Succeeded" | "Rejected" | "Failed" | "Canceled" {
  switch (status) {
    case "in_progress": return "In Progress";
    case "awaiting_acceptance": return "Awaiting Acceptance";
    case "succeeded": return "Succeeded";
    case "rejected": return "Rejected";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
  }
}

function hasFreshExternalTerminalHistory(
  request: CycleAdvanceRequest,
  stage: StageExecutionSnapshot,
): boolean {
  const terminalStatus = stageTaskStatus(stage);
  return request.issue_history.some((entry) => (
    entry.issue_id === parseTaskIssueId(stage.issue_id)
    && entry.change_origin === "external"
    && entry.changed_fields.includes("status")
    && entry.to_status === terminalStatus
  ));
}

function hasFreshExternalCycleTerminalHistory(request: CycleAdvanceRequest): boolean {
  const cycleStatus = cycleTaskStatus(request.cycle_status);
  if (
    cycleStatus !== "Succeeded"
    && cycleStatus !== "Rejected"
    && cycleStatus !== "Failed"
    && cycleStatus !== "Canceled"
  ) return false;
  const cycleId = parseTaskIssueId(request.cycle_id);
  return request.issue_history.some((entry) => (
    entry.issue_id === cycleId
    && entry.change_origin === "external"
    && entry.changed_fields.includes("status")
    && entry.to_status === cycleStatus
  ));
}

function parseExecution(value: CycleMachineExecution): CycleMachineExecution {
  if (
    typeof value !== "object"
    || value === null
    || Object.keys(value).some((key) => key !== "ownership" && key !== "closure")
    || (value.ownership !== "live" && value.ownership !== "lost")
    || (value.closure !== undefined && value.closure !== "admission_lost")
  ) throw new Error("cycle_machine_execution_invalid");
  return Object.freeze({
    ownership: value.ownership,
    ...(value.closure === undefined ? {} : { closure: value.closure }),
  });
}

function createPlanCall(
  request: CycleAdvanceRequest,
  workflow: TaskWorkflowIdentities,
  basis: SealedCycleBasis,
): CreateIssueCall {
  return Object.freeze({
    schema_version: 1,
    function: "create_issue",
    root_id: request.root_id,
    runtime_generation: request.runtime_generation,
    correlation_id: request.correlation_id,
    capability: TASK_MCP_CAPABILITIES.create_issue,
    input: Object.freeze({
      issue_id: basis.specification.plan_issue_id,
      parent_issue_id: parseTaskIssueId(request.cycle_id),
      expected_parent_revision: request.cycle_revision,
      desired: Object.freeze({
        title: PLAN_TITLE,
        description: PLAN_DESCRIPTION,
        state_id: workflow.stage_states.todo,
        label_ids: Object.freeze([workflow.labels.plan]),
        delegate_id: null,
        priority: null,
      }),
    }),
  });
}

function assertExactCreatedPlan(
  request: CycleAdvanceRequest,
  basis: SealedCycleBasis,
  workflow: TaskWorkflowIdentities,
): NonNullable<CycleAdvanceRequest["plan_issue"]> {
  const plan = request.plan_issue;
  const expected = createPlanCall(request, workflow, basis);
  if (
    plan === null
    || plan.status !== "todo"
    || parseTaskIssueId(plan.issue_id) !== expected.input.issue_id
    || parseTaskIssueId(plan.parent_cycle_id) !== expected.input.parent_issue_id
    || plan.kind !== "plan"
    || plan.title !== expected.input.desired.title
    || plan.description_markdown !== expected.input.desired.description
  ) throw new Error("plan_issue_sealed_fact_mismatch");
  return plan;
}

function nextPersistedWorkIssue(
  request: CycleAdvanceRequest,
  built: BuiltPlanGraphManifest,
): StageExecutionSnapshot["issue_id"] {
  const byId = new Map(request.sealed_work_issues.map((stage) => [parseTaskIssueId(stage.issue_id), stage]));
  if (
    byId.size !== built.manifest.ordered_work_nodes.length
    || built.manifest.ordered_work_nodes.some(({ issue_id }) => !byId.has(issue_id))
  ) throw new Error("persisted_work_graph_mismatch");
  let next: StageExecutionSnapshot["issue_id"] | null = null;
  for (const node of built.manifest.ordered_work_nodes) {
    const stage = byId.get(node.issue_id)!;
    if (next === null && stage.status === "done") continue;
    if (next === null && stage.status === "todo") {
      next = stage.issue_id;
      continue;
    }
    if (stage.status !== "todo") throw new Error("persisted_work_order_blocked");
  }
  if (next !== null) return next;
  throw new Error("persisted_work_order_complete");
}

function statusCall(
  request: CycleAdvanceRequest,
  issueId: TaskIssueId,
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
      issue_id: issueId,
      expected_revision: expectedRevision,
      desired: Object.freeze({ state_id: stateId }),
    }),
  });
}

function appliedIssue(
  output: TaskMutationOutput,
): TaskIssueSnapshot {
  if (
    output.outcome !== "applied"
    || output.fresh_resource === null
    || !("issue_id" in output.fresh_resource)
  ) throw new Error("cycle_issue_mutation_not_applied");
  return output.fresh_resource;
}

function appliedUpdatedIssue(
  output: TaskMutationOutput,
): TaskIssueSnapshot {
  if (
    output.outcome !== "applied"
    || output.fresh_resource === null
    || !("issue_id" in output.fresh_resource)
  ) throw new Error("cycle_status_mutation_not_applied");
  return output.fresh_resource;
}

export class CyclePlanMachine implements CycleMachineInterface {
  readonly #callerIssuer: TaskManageCallerIssuer;
  readonly #commitVerifier: CycleCommitVerifier;
  readonly #materializer: CycleGraphMaterializer;
  #planPerformer: PlanPerformerInterface | null = null;
  readonly #planPerformerFactory: CyclePlanPerformerFactory;
  readonly #planCompletionRecordWriter: PlanCompletionRecordPersistence;
  readonly #reader: FreshCycleExecutionReader;
  readonly #sealedBasisReader: FreshSealedCycleBasisReader;
  readonly #taskManager: TaskManageCommandInterface;
  readonly #workflow: TaskWorkflowIdentities;
  readonly #workExecutor: CycleWorkExecutor;
  #epoch = 0;
  #retirement: Promise<void> | null = null;
  #retired = false;

  constructor(options: CyclePlanMachineOptions) {
    this.#workflow = parseTaskWorkflowIdentities(options.workflow);
    this.#callerIssuer = options.caller_issuer;
    this.#taskManager = options.task_manager;
    this.#planPerformerFactory = options.plan_performer_factory;
    this.#planCompletionRecordWriter = options.plan_completion_record_writer;
    this.#reader = options.reader;
    this.#sealedBasisReader = options.sealed_basis_reader;
    this.#commitVerifier = new CycleCommitVerifier({
      workflow: this.#workflow,
      caller_issuer: this.#callerIssuer,
      task_manager: this.#taskManager,
      reader: options.reader,
      git_workspace: options.git_workspace,
      performer_factory: options.verify_performer_factory,
      completion_writer: this.#planCompletionRecordWriter,
    });
    this.#materializer = new CycleGraphMaterializer({
      workflow: this.#workflow,
      caller_issuer: this.#callerIssuer,
      task_manager: this.#taskManager,
      reader: options.reader,
    });
    this.#workExecutor = new CycleWorkExecutor({
      workflow: this.#workflow,
      caller_issuer: this.#callerIssuer,
      task_manager: this.#taskManager,
      reader: options.reader,
      performer_factory: options.work_performer_factory,
      completion_writer: this.#planCompletionRecordWriter,
    });
  }

  async advance(
    value: CycleAdvanceRequest,
    executionValue: CycleMachineExecution,
  ): Promise<CycleAdvanceResult> {
    if (this.#retired) throw new Error("cycle_machine_retired");
    const epoch = this.#epoch;
    const execution = parseExecution(executionValue);
    const outcome = await this.#advance(bindCycleAdvanceRequest(value), execution, epoch);
    this.#assertActive(epoch);
    return outcome;
  }

  retire(): Promise<void> {
    if (this.#retirement !== null) return this.#retirement;
    this.#retired = true;
    this.#epoch += 1;
    const planPerformer = this.#planPerformer;
    this.#planPerformer = null;
    const retirements: Promise<void>[] = [];
    try {
      retirements.push(planPerformer?.close() ?? Promise.resolve());
    } catch {
      retirements.push(Promise.reject(new Error("cycle_plan_retirement_failed")));
    }
    retirements.push(this.#workExecutor.retire(), this.#commitVerifier.retire());
    this.#retirement = Promise.allSettled(retirements).then((results) => {
      if (results.some(({ status }) => status === "rejected")) {
        throw new Error("cycle_machine_retirement_failed");
      }
    });
    return this.#retirement;
  }

  async #advance(
    request: CycleAdvanceRequest,
    execution: CycleMachineExecution,
    epoch: number,
  ): Promise<CycleAdvanceResult> {
    const externalCycleTerminal = await this.#handleExternalTerminalCycle(request, epoch);
    if (externalCycleTerminal !== null) return externalCycleTerminal;
    if (execution.closure === "admission_lost") {
      return this.#failCycle(request, "active_root_admission_lost", "canceled", epoch, "canceled");
    }
    const externalTerminal = await this.#handleExternalTerminalStage(request, epoch);
    if (externalTerminal !== null) return externalTerminal;
    if (request.cycle_status === "awaiting_acceptance") {
      try {
        const basis = await this.#readSealedBasis(request);
        const built = await this.#planCompletionRecordWriter.readCompleted(request, basis);
        if (built === null) throw new Error("plan_completion_record_missing");
        await this.#planCompletionRecordWriter.assertAcceptanceEvidence(request, basis, built);
        this.#assertActive(epoch);
        return result(request, "no_action");
      } catch {
        this.#assertActive(epoch);
        return this.#failCycle(request, "verify_phase_failed", "failed", epoch);
      }
    }
    if (request.plan_issue?.status === "in_progress") {
      try {
        const basis = await this.#readSealedBasis(request);
        if (await this.#planCompletionRecordWriter.hasPlanInvalidation(request, basis)) {
          return this.#failCycle(request, "plan_phase_failed", "failed", epoch);
        }
        const persisted = await this.#planCompletionRecordWriter.readCompleted(request, basis);
        this.#assertActive(epoch);
        if (persisted !== null) return this.#materializePersistedPlan(request, basis, persisted, epoch);
      } catch {
        this.#assertActive(epoch);
        return this.#failCycle(request, "plan_phase_failed", "failed", epoch);
      }
    }
    const projected = await this.#projectPersistedActiveStage(request, epoch);
    if (projected !== null) return projected;
    if (execution.ownership === "lost") {
      const completedWorkBeforeTodo = request.sealed_work_issues.some(({ status }) => status === "done")
        && request.sealed_work_issues.some(({ status }) => status === "todo")
        && request.sealed_work_issues.every(({ status }) => status === "done" || status === "todo");
      return this.#failCycle(
        request,
        completedWorkBeforeTodo ? "lost_work_thread_context" : "lost_execution_context",
        "failed",
        epoch,
      );
    }
    const transition = reduceCycleTransition(request, {
      cycle_seal_digest: request.specification.seal_digest,
      graph_seal_digest: request.sealed_graph_digest,
    });
    if (transition.action === "plan_and_materialize") {
      return this.#planAndMaterialize(request, epoch);
    }
    if (transition.action === "mark_failed") {
      return this.#failCycle(request, "cycle_transition_failed", "failed", epoch);
    }
    if (
      transition.action === "no_action"
      && transition.reason === "stage_in_progress"
      && request.plan_issue?.status === "in_progress"
      && request.sealed_work_issues.length === 0
      && request.verify_issue === null
    ) return this.#failCycle(request, "lost_execution_context", "failed", epoch);
    if (transition.action === "run_work") {
      try {
        const basis = await this.#readSealedBasis(request);
        const built = await this.#planCompletionRecordWriter.readCompleted(request, basis);
        if (built === null) throw new Error("plan_completion_record_missing");
        const workIssueId = nextPersistedWorkIssue(request, built);
        const existingCompletion = await this.#planCompletionRecordWriter.readStageCompletion(
          request,
          basis,
          built,
          parseTaskIssueId(workIssueId),
        );
        if (existingCompletion !== null) throw new Error("work_completion_status_regressed");
        const execution = await this.#workExecutor.execute(request, workIssueId, basis, built);
        this.#assertActive(epoch);
        if (execution.outcome === "completed") {
          return result(request, "advanced");
        }
        return this.#failCycle(execution.snapshot, "work_phase_failed", "failed", epoch);
      } catch (error) {
        this.#assertActive(epoch);
        return this.#failCycle(
          error instanceof CycleWorkExecutionError ? error.snapshot : request,
          "work_phase_failed",
          "failed",
          epoch,
        );
      }
    }
    if (transition.action === "commit_and_verify") {
      try {
        const basis = await this.#readSealedBasis(request);
        const built = await this.#planCompletionRecordWriter.readCompleted(request, basis);
        if (built === null) throw new Error("plan_completion_record_missing");
        const execution = await this.#commitVerifier.execute(request, transition, basis, built);
        this.#assertActive(epoch);
        return execution.outcome === "awaiting_acceptance"
          ? result(request, "awaiting_acceptance", execution.snapshot.cycle_revision)
          : this.#failCycle(execution.snapshot, "verify_phase_failed", "failed", epoch);
      } catch (error) {
        this.#assertActive(epoch);
        return this.#failCycle(
          error instanceof CycleCommitVerificationError ? error.snapshot : request,
          "verify_phase_failed",
          "failed",
          epoch,
        );
      }
    }
    if (transition.action !== "create_plan") return result(request, "no_action");

    try {
      const basis = await this.#readSealedBasis(request);
      const call = createPlanCall(request, this.#workflow, basis);
      const command = bindCycleTaskManageCommand({
        snapshot: request,
        workflow: this.#workflow,
        caller_issuer: this.#callerIssuer,
        task_manager: this.#taskManager,
        mutation_manifest: [call],
      });
      const createdPlan = appliedIssue((await command.create_issue(
        call,
        this.#execution(epoch),
      )).output);
      this.#assertActive(epoch);
      const createdPlanDescription = parseMarkdownText(
        createdPlan.description_markdown,
        "created_plan_description_missing",
      );
      const createdPlanId = parseStageIssueId(createdPlan.issue_id);
      const planGraph = parseSealedExecutionGraph({
        plan_issue: {
          issue_id: createdPlanId,
          sealed_revision: createdPlan.revision,
          kind: "plan",
          title: createdPlan.title,
          description_markdown: createdPlanDescription,
          parent_cycle_id: request.cycle_id,
        },
        work_issues: [],
        verify_issue: null,
        relations: [],
      }, request.cycle_id);
      bindCycleAdvanceRequest({
        ...request,
        plan_issue: {
          issue_id: createdPlanId,
          revision: createdPlan.revision,
          sealed_revision: createdPlan.revision,
          kind: "plan",
          title: createdPlan.title,
          description_markdown: createdPlanDescription,
          parent_cycle_id: request.cycle_id,
          status: "todo",
        },
        sealed_graph_digest: planGraph.seal_digest,
      });
      return result(request, "advanced");
    } catch {
      this.#assertActive(epoch);
      return this.#failCycle(request, "plan_phase_failed", "failed", epoch);
    }
  }

  async #materializePersistedPlan(
    request: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
    epoch: number,
  ): Promise<CycleAdvanceResult> {
    try {
      let readback: CycleAdvanceRequest;
      try {
        readback = await this.#materializer.materialize(request, built, this.#execution(epoch));
      } catch {
        await this.#quarantineMaterialization(request, basis, built, epoch);
        throw new Error("partial_graph_materialization");
      }
      this.#assertActive(epoch);
      const plan = readback.plan_issue;
      if (plan === null || plan.status !== "in_progress") throw new Error("persisted_plan_source_invalid");
      const finishCall = statusCall(
        readback,
        parseTaskIssueId(plan.issue_id),
        plan.revision,
        this.#workflow.stage_states.done,
      );
      const command = bindCycleTaskManageCommand({
        snapshot: readback,
        workflow: this.#workflow,
        caller_issuer: this.#callerIssuer,
        task_manager: this.#taskManager,
        mutation_manifest: [finishCall],
      });
      const finishedPlan = appliedUpdatedIssue((await command.update_issue(
        finishCall,
        this.#execution(epoch),
      )).output);
      this.#assertActive(epoch);
      bindCycleAdvanceRequest({
        ...readback,
        plan_issue: { ...plan, revision: finishedPlan.revision, status: "done" },
      });
      return result(request, "advanced");
    } catch {
      this.#assertActive(epoch);
      return this.#failCycle(request, "plan_phase_failed", "failed", epoch);
    }
  }

  async #quarantineMaterialization(
    request: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
    epoch: number,
  ): Promise<CycleAdvanceRequest> {
    const observed = await this.#materializer.readCurrent(request).catch(() => request);
    this.#assertActive(epoch);
    await this.#planCompletionRecordWriter.persistPlanInvalidation(
      observed,
      basis,
      built,
      this.#execution(epoch),
    );
    this.#assertActive(epoch);
    return observed;
  }

  async #planAndMaterialize(
    request: CycleAdvanceRequest,
    epoch: number,
  ): Promise<CycleAdvanceResult> {
    let failureSnapshot = request;
    let planTerminalStatus: PlanTerminalStatus = "failed";
    try {
      const planStage = request.plan_issue;
      if (planStage === null) throw new Error("plan_issue_missing");
      const basis = await this.#readSealedBasis(request);
      assertExactCreatedPlan(request, basis, this.#workflow);
      const startCall = statusCall(
        request,
        parseTaskIssueId(planStage.issue_id),
        planStage.revision,
        this.#workflow.stage_states.in_progress,
      );
      const startCommand = bindCycleTaskManageCommand({
        snapshot: request,
        workflow: this.#workflow,
        caller_issuer: this.#callerIssuer,
        task_manager: this.#taskManager,
        mutation_manifest: [startCall],
      });
      const startedPlan = appliedUpdatedIssue(
        (await startCommand.update_issue(startCall, this.#execution(epoch))).output,
      );
      this.#assertActive(epoch);
      const startedSnapshot = bindCycleAdvanceRequest({
        ...request,
        plan_issue: {
          issue_id: planStage.issue_id,
          revision: startedPlan.revision,
          kind: "plan",
          title: planStage.title,
          description_markdown: planStage.description_markdown,
          parent_cycle_id: planStage.parent_cycle_id,
          status: "in_progress",
          sealed_revision: planStage.sealed_revision,
        },
      });
      failureSnapshot = startedSnapshot;

      const target = Object.freeze({
        root_id: request.root_id,
        runtime_generation: request.runtime_generation,
        cycle_id: request.cycle_id,
        cycle_revision: request.cycle_revision,
      });
      const performer = await this.#planPerformerFactory.create(target);
      try {
        this.#assertActive(epoch);
        if (
          performer.role !== "plan"
          || performer.rootId !== request.root_id
          || performer.runtimeGeneration !== request.runtime_generation
          || performer.cycleId !== request.cycle_id
          || usedPlanPerformers.has(performer)
        ) throw new Error("plan_performer_target_mismatch");
        usedPlanPerformers.add(performer);
        this.#planPerformer = performer;
      } catch (error) {
        await performer.close().catch(() => undefined);
        throw error;
      }
      const planRequest = parsePlanRequest({
        schema_version: 1,
        ...target,
        correlation_id: request.correlation_id,
        cycle_description_markdown: request.specification.cycle_description_markdown,
        root_adr_markdown: request.specification.root_adr_markdown,
        approved_work_groups: basis.specification.approved_work_groups.map((group) => Object.freeze({
          work_group_id: group.work_group_id,
          depends_on_work_group_ids: group.depends_on_work_group_ids,
        })),
      }, target);
      let rawPlanResult;
      try {
        rawPlanResult = await performer.plan(planRequest);
        this.#assertActive(epoch);
      } finally {
        await this.#closePlanPerformer(epoch);
      }
      const planResult = parsePlanResult(rawPlanResult, planRequest);
      if (planResult.outcome !== "completed") {
        planTerminalStatus = planResult.outcome;
        await this.#planCompletionRecordWriter.persistPlanTerminal(
          startedSnapshot,
          basis,
          planResult.outcome,
          planResult.sanitized_reason,
          this.#execution(epoch),
        );
        this.#assertActive(epoch);
        throw new Error(planResult.outcome === "failed" ? "plan_failed" : "plan_canceled");
      }
      const built = buildPlanGraphManifest({
        basis,
        ordered_work_group_ids: planResult.ordered_work_group_ids,
        plan_title: planStage.title,
        plan_instruction_markdown: planStage.description_markdown,
      });
      await this.#planCompletionRecordWriter.persistCompleted(
        startedSnapshot,
        basis,
        built,
        this.#execution(epoch),
      );
      this.#assertActive(epoch);
      let readback: CycleAdvanceRequest;
      try {
        readback = await this.#materializer.materialize(
          startedSnapshot,
          built,
          this.#execution(epoch),
        );
      } catch {
        failureSnapshot = await this.#quarantineMaterialization(startedSnapshot, basis, built, epoch);
        throw new Error("partial_graph_materialization");
      }
      this.#assertActive(epoch);
      failureSnapshot = readback;
      const finishCall = statusCall(
        readback,
        parseTaskIssueId(planStage.issue_id),
        readback.plan_issue!.revision,
        this.#workflow.stage_states.done,
      );
      const finishCommand = bindCycleTaskManageCommand({
        snapshot: readback,
        workflow: this.#workflow,
        caller_issuer: this.#callerIssuer,
        task_manager: this.#taskManager,
        mutation_manifest: [finishCall],
      });
      const finishedPlan = appliedUpdatedIssue((await finishCommand.update_issue(
        finishCall,
        this.#execution(epoch),
      )).output);
      this.#assertActive(epoch);
      bindCycleAdvanceRequest({
        ...readback,
        plan_issue: {
          ...readback.plan_issue!,
          revision: finishedPlan.revision,
          status: "done",
        },
      });
      return result(request, "advanced");
    } catch {
      this.#assertActive(epoch);
      return this.#failCycle(failureSnapshot, "plan_phase_failed", planTerminalStatus, epoch);
    }
  }

  async #handleExternalTerminalStage(
    request: CycleAdvanceRequest,
    epoch: number,
  ): Promise<CycleAdvanceResult | null> {
    if (request.cycle_status !== "in_progress") return null;
    const terminals = stageList(request).filter(({ status }) => (
      status === "done" || status === "failed" || status === "canceled"
    )).filter((stage) => hasFreshExternalTerminalHistory(request, stage));
    if (terminals.length === 0) return null;

    let basis: SealedCycleBasis;
    let built: BuiltPlanGraphManifest | null = null;
    let terminal: StageExecutionSnapshot | null = null;
    try {
      basis = await this.#readSealedBasis(request);
      const plan = request.plan_issue;
      if (plan?.status === "failed" || plan?.status === "canceled") {
        const completion = await this.#planCompletionRecordWriter.readPlanCompletion(request, basis);
        this.#assertActive(epoch);
        if (completion === null) terminal = plan;
      } else {
        built = await this.#planCompletionRecordWriter.readCompleted(request, basis);
        this.#assertActive(epoch);
        if (plan !== null && plan.status === "done" && built === null) terminal = plan;
      }
      if (terminal === null) {
        for (const candidate of terminals) {
          if (candidate.kind === "plan") continue;
          if (built === null) {
            return failedResult(request, "precondition_failed", request.cycle_revision, "cycle_transition_failed");
          }
          const completion = await this.#planCompletionRecordWriter.readStageCompletion(
            request,
            basis,
            built,
            parseTaskIssueId(candidate.issue_id),
          );
          this.#assertActive(epoch);
          if (
            completion === null
            || stageCompletionTerminalStatus(completion.completion) !== stageTaskStatus(candidate)
          ) {
            terminal = candidate;
            break;
          }
        }
      }
    } catch {
      this.#assertActive(epoch);
      return failedResult(request, "precondition_failed", request.cycle_revision, "cycle_transition_failed");
    }
    if (terminal === null) return null;

    const basisStatus = deriveLastValidStageBasisStatus({
      issues: [{ issue_id: parseTaskIssueId(terminal.issue_id), status: stageTaskStatus(terminal) }],
      issue_history: request.issue_history,
    }, parseTaskIssueId(terminal.issue_id));
    if (basisStatus === null) {
      return failedResult(request, "precondition_failed", request.cycle_revision, "cycle_transition_failed");
    }
    const persist = this.#planCompletionRecordWriter.persistExternalTerminalInvalidation;
    if (persist === undefined) {
      return failedResult(request, "precondition_failed", request.cycle_revision, "cycle_transition_failed");
    }
    try {
      await persist.call(
        this.#planCompletionRecordWriter,
        request,
        basis,
        built,
        parseTaskIssueId(terminal.issue_id),
        this.#execution(epoch),
      );
      this.#assertActive(epoch);
    } catch {
      this.#assertActive(epoch);
      return failedResult(request, "precondition_failed", request.cycle_revision, "cycle_transition_failed");
    }
    return this.#failCycle(request, "cycle_transition_failed", "failed", epoch);
  }

  async #handleExternalTerminalCycle(
    request: CycleAdvanceRequest,
    epoch: number,
  ): Promise<CycleAdvanceResult | null> {
    if (
      request.cycle_status !== "succeeded"
      && request.cycle_status !== "rejected"
      && request.cycle_status !== "failed"
      && request.cycle_status !== "canceled"
    ) return null;
    if (!hasFreshExternalCycleTerminalHistory(request)) return null;

    const read = this.#planCompletionRecordWriter.readCycleTerminalRecord;
    const persist = this.#planCompletionRecordWriter.persistExternalTerminalCycleInvalidation;
    if (read === undefined || persist === undefined) {
      return failedResult(request, "precondition_failed", request.cycle_revision, "cycle_transition_failed");
    }

    try {
      const basis = await this.#readSealedBasis(request);
      const terminalRecord = await read.call(this.#planCompletionRecordWriter, request, basis);
      this.#assertActive(epoch);
      if (terminalRecord !== null) return result(request, "no_action");

      const cycleId = parseTaskIssueId(request.cycle_id);
      const basisStatus = deriveLastValidCycleBasisStatus({
        issues: [{ issue_id: cycleId, status: cycleTaskStatus(request.cycle_status) }],
        issue_history: request.issue_history,
      }, cycleId);
      if (basisStatus === null) {
        return failedResult(request, "precondition_failed", request.cycle_revision, "cycle_transition_failed");
      }

      const activeStages = stageList(request).filter(({ status }) => status === "in_progress");
      let built: BuiltPlanGraphManifest | null = null;
      if (activeStages.some(({ kind }) => kind !== "plan")) {
        built = await this.#planCompletionRecordWriter.readCompleted(request, basis);
        if (built === null) throw new Error("cycle_terminal_manifest_missing");
      }

      const terminalOutcome = request.cycle_status === "canceled" ? "canceled" : "failed";
      const closedStages: Array<{
        readonly stage: StageExecutionSnapshot;
        readonly status: "done" | "failed" | "canceled";
        readonly record: StageCompletionRecord;
      }> = [];
      let projectedRequest = request;
      for (const stage of activeStages) {
        const persisted = await this.#planCompletionRecordWriter.persistStageFailure(
          projectedRequest,
          basis,
          built,
          parseTaskIssueId(stage.issue_id),
          "external_cycle_terminal",
          "The Cycle reached a terminal status without a matching Symphony completion record.",
          this.#execution(epoch),
          terminalOutcome,
        );
        const record = parseStageCompletionRecord(persisted, stage.kind, basis);
        const terminalStatus = stageCompletionTerminalStatus(record.completion);
        closedStages.push({
          stage,
          status: terminalStatus === "Done"
            ? "done"
            : terminalStatus === "Canceled" ? "canceled" : "failed",
          record,
        });
        this.#assertActive(epoch);
      }

      for (const { stage, status } of closedStages) {
        projectedRequest = await this.#projectStageStatus(projectedRequest, stage, status, epoch);
        this.#assertActive(epoch);
      }

      await persist.call(
        this.#planCompletionRecordWriter,
        projectedRequest,
        basis,
        closedStages.map(({ record }) => createHash("sha256")
          .update(JSON.stringify(record), "utf8")
          .digest("hex")),
        this.#execution(epoch),
      );
      this.#assertActive(epoch);
      return result(projectedRequest, "no_action");
    } catch {
      this.#assertActive(epoch);
      return failedResult(request, "precondition_failed", request.cycle_revision, "cycle_transition_failed");
    }
  }

  async #readSealedBasis(request: CycleAdvanceRequest): Promise<SealedCycleBasis> {
    const basis = await this.#sealedBasisReader.readSealedCycleBasis(parseTaskIssueId(request.cycle_id));
    if (
      basis.specification.cycle_id !== parseTaskIssueId(request.cycle_id)
      || basis.specification.root_id !== request.root_id
      || basis.specification.specification_seal_digest === null
    ) throw new Error("sealed_cycle_basis_mismatch");
    return basis;
  }

  async #projectPersistedActiveStage(
    request: CycleAdvanceRequest,
    epoch: number,
  ): Promise<CycleAdvanceResult | null> {
    const active = stageList(request).find(
      (stage) => stage.status === "in_progress" && stage.kind !== "plan",
    );
    if (active === undefined) return null;
    try {
      const basis = await this.#readSealedBasis(request);
      const built = await this.#planCompletionRecordWriter.readCompleted(request, basis);
      if (built === null) return null;
      const completion = await this.#planCompletionRecordWriter.readStageCompletion(
        request,
        basis,
        built,
        parseTaskIssueId(active.issue_id),
      );
      this.#assertActive(epoch);
      if (completion === null) return null;
      if (completion.basis_issue_revision !== active.revision) {
        throw new Error("stage_completion_projection_source_mismatch");
      }
      if (active.kind === "work" && "outcome" in completion.completion) {
        const status = completion.completion.outcome === "completed"
          ? "done"
          : completion.completion.outcome;
        const projected = await this.#projectStageStatus(request, active, status, epoch);
        return status === "done"
          ? result(request, "advanced")
          : this.#failCycle(projected, "work_phase_failed", "failed", epoch);
      }
      if (active.kind === "verify" && "conclusion" in completion.completion) {
        const status = completion.completion.conclusion === "passed" ? "done" : "failed";
        const projected = await this.#projectStageStatus(request, active, status, epoch);
        if (status === "failed") {
          return this.#failCycle(projected, "verify_phase_failed", "failed", epoch);
        }
        const awaiting = await this.#projectCycleStatus(projected, "awaiting_acceptance", epoch);
        return result(request, "awaiting_acceptance", awaiting.cycle_revision);
      }
      throw new Error("stage_completion_kind_mismatch");
    } catch {
      this.#assertActive(epoch);
      return this.#failCycle(request, "cycle_transition_failed", "failed", epoch);
    }
  }

  async #projectStageStatus(
    request: CycleAdvanceRequest,
    stage: StageExecutionSnapshot,
    status: "done" | "failed" | "canceled",
    epoch: number,
  ): Promise<CycleAdvanceRequest> {
    const call = statusCall(
      request,
      parseTaskIssueId(stage.issue_id),
      stage.revision,
      this.#workflow.stage_states[status],
    );
    const command = bindCycleTaskManageCommand({
      snapshot: request,
      workflow: this.#workflow,
      caller_issuer: this.#callerIssuer,
      task_manager: this.#taskManager,
      mutation_manifest: [call],
    });
    appliedUpdatedIssue((await command.update_issue(call, this.#execution(epoch))).output);
    this.#assertActive(epoch);
    return this.#readback(request, epoch, "stage_projection_readback_missing");
  }

  async #projectCycleStatus(
    request: CycleAdvanceRequest,
    status: "awaiting_acceptance",
    epoch: number,
  ): Promise<CycleAdvanceRequest> {
    const call = statusCall(
      request,
      parseTaskIssueId(request.cycle_id),
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
    appliedUpdatedIssue((await command.update_issue(call, this.#execution(epoch))).output);
    this.#assertActive(epoch);
    return this.#readback(request, epoch, "cycle_projection_readback_missing");
  }

  async #readback(
    request: CycleAdvanceRequest,
    epoch: number,
    missingCode: string,
  ): Promise<CycleAdvanceRequest> {
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

  async #failCycle(
    request: CycleAdvanceRequest,
    reason: CycleExecutionFailureReason,
    planStatus: PlanTerminalStatus,
    epoch: number,
    terminalStatus: "failed" | "canceled" = "failed",
  ): Promise<CycleAdvanceResult> {
    this.#assertActive(epoch);
    if (request.cycle_status === "failed" || request.cycle_status === "canceled") {
      return failedResult(request, "terminal_failed", request.cycle_revision, reason);
    }

    let terminalReason = reason;
    const activeStages = stageList(request).filter(({ status }) => status === "in_progress");
    let basis: SealedCycleBasis;
    let built: BuiltPlanGraphManifest | null = null;
    try {
      basis = await this.#readSealedBasis(request);
      if (request.plan_issue?.status === "done" || activeStages.some(({ kind }) => kind !== "plan")) {
        built = await this.#planCompletionRecordWriter.readCompleted(request, basis).catch(() => null);
      }
      for (const stage of activeStages) {
        await this.#planCompletionRecordWriter.persistStageFailure(
          request,
          basis,
          built,
          parseTaskIssueId(stage.issue_id),
          reason === "lost_execution_context" ? "lost_execution_context" : `${stage.kind}_execution_failed`,
          failureReasonMarkdown(reason),
          this.#execution(epoch),
          terminalStatus,
        );
        this.#assertActive(epoch);
      }
    } catch {
      this.#assertActive(epoch);
      return failedResult(request, "precondition_failed", request.cycle_revision, "stage_failure_unconfirmed");
    }

    for (const stage of activeStages) {
      const stageStatus = terminalStatus === "canceled" ? "canceled"
        : stage.kind === "plan" ? planStatus : "failed";
      const stageCall = statusCall(
        request,
        parseTaskIssueId(stage.issue_id),
        stage.revision,
        this.#workflow.stage_states[stageStatus],
      );
      try {
        const stageCommand = bindCycleTaskManageCommand({
          snapshot: request,
          workflow: this.#workflow,
          caller_issuer: this.#callerIssuer,
          task_manager: this.#taskManager,
          mutation_manifest: [stageCall],
        });
        appliedUpdatedIssue((await stageCommand.update_issue(
          stageCall,
          this.#execution(epoch),
        )).output);
        this.#assertActive(epoch);
      } catch {
        this.#assertActive(epoch);
        terminalReason = "stage_failure_unconfirmed";
      }
    }

    try {
      await this.#planCompletionRecordWriter.persistCycleFailure(
        request,
        basis,
        reason,
        failureReasonMarkdown(reason),
        activeStages[0] === undefined ? null : parseTaskIssueId(activeStages[0].issue_id),
        this.#execution(epoch),
        terminalStatus,
      );
      this.#assertActive(epoch);
    } catch {
      this.#assertActive(epoch);
      return failedResult(request, "precondition_failed", request.cycle_revision, "cycle_transition_failed");
    }

    const cycleCall = statusCall(
      request,
      parseTaskIssueId(request.cycle_id),
      request.cycle_revision,
      this.#workflow.cycle_states[terminalStatus],
    );
    try {
      const cycleCommand = bindCycleTaskManageCommand({
        snapshot: request,
        workflow: this.#workflow,
        caller_issuer: this.#callerIssuer,
        task_manager: this.#taskManager,
        mutation_manifest: [cycleCall],
      });
      const failedCycle = appliedUpdatedIssue(
        (await cycleCommand.update_issue(cycleCall, this.#execution(epoch))).output,
      );
      this.#assertActive(epoch);
      return failedResult(request, "terminal_failed", failedCycle.revision, terminalReason);
    } catch {
      this.#assertActive(epoch);
      return failedResult(request, "precondition_failed", request.cycle_revision, "cycle_transition_failed");
    }
  }

  async #closePlanPerformer(epoch: number): Promise<void> {
    const performer = this.#planPerformer;
    this.#planPerformer = null;
    if (performer !== null) await performer.close();
    this.#assertActive(epoch);
  }

  #execution(epoch: number): TaskManageBoundaryExecution {
    return Object.freeze({ assertActive: () => this.#assertActive(epoch) });
  }

  #assertActive(epoch: number): void {
    if (this.#retired || epoch !== this.#epoch) throw new Error("cycle_machine_late_output");
  }
}
