import {
  parseSealedExecutionGraph,
  type CycleAdvanceRequest,
  type CycleAdvanceResult,
  type ExecutionGraphSealDigest,
  type StageExecutionSnapshot,
} from "../../contracts/cycle.js";
import type { SealedCycleBasis } from "../../contracts/cycle-records.js";
import {
  parseStageIssueId,
  parseTaskIssueId,
  type TaskIssueId,
  type TaskStateId,
} from "../../contracts/identity.js";
import type { TaskIssueSnapshot } from "../../contracts/observation.js";
import type { GitWorkspaceInterface } from "../../git/api/GitWorkspaceInterface.js";
import { parseMarkdownText } from "../../contracts/validation.js";
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
  readCompleted(
    request: CycleAdvanceRequest,
    basis: SealedCycleBasis,
  ): Promise<BuiltPlanGraphManifest | null>;
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
  const reasonMarkdown = parseMarkdownText(
    reason === "lost_execution_context"
      ? "Cycle failed because the live Plan execution context was lost."
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

function stageList(request: CycleAdvanceRequest): readonly StageExecutionSnapshot[] {
  return [
    ...(request.plan_issue === null ? [] : [request.plan_issue]),
    ...request.sealed_work_issues,
    ...(request.verify_issue === null ? [] : [request.verify_issue]),
  ];
}

function executionFacts(request: CycleAdvanceRequest): string {
  return JSON.stringify({
    ...request,
    correlation_id: null,
    git: request.cycle_status === "awaiting_acceptance" ? request.git : null,
  });
}

function parseExecution(value: CycleMachineExecution): CycleMachineExecution {
  if (
    typeof value !== "object"
    || value === null
    || Object.keys(value).length !== 1
    || (value.ownership !== "live" && value.ownership !== "lost")
  ) throw new Error("cycle_machine_execution_invalid");
  return Object.freeze({ ownership: value.ownership });
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
  #acceptedExecution: CycleAdvanceRequest | null = null;
  #activeCycleKey: string | null = null;
  #activeCycleId: CycleAdvanceRequest["cycle_id"] | null = null;
  readonly #callerIssuer: TaskManageCallerIssuer;
  readonly #commitVerifier: CycleCommitVerifier;
  readonly #materializer: CycleGraphMaterializer;
  readonly #pendingFailures = new Map<string, {
    readonly reason: CycleExecutionFailureReason;
    readonly plan_status: PlanTerminalStatus;
  }>();
  readonly #planCreations = new Set<string>();
  readonly #planAttempts = new Set<string>();
  #planPerformer: PlanPerformerInterface | null = null;
  readonly #planPerformerFactory: CyclePlanPerformerFactory;
  readonly #planCompletionRecordWriter: PlanCompletionRecordPersistence;
  readonly #sealedBasisReader: FreshSealedCycleBasisReader;
  #sealedGraphDigest: ExecutionGraphSealDigest | null = null;
  readonly #stageOwners = new Map<StageExecutionSnapshot["issue_id"], CycleAdvanceRequest["cycle_id"]>();
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
    const cycleKey = this.#cycleKey(request);
    if (this.#activeCycleId === request.cycle_id && this.#activeCycleKey !== cycleKey) {
      return this.#failCycle(request, "cycle_transition_failed", "failed", epoch);
    }
    if (this.#activeCycleKey !== cycleKey) {
      this.#activeCycleKey = cycleKey;
      this.#activeCycleId = request.cycle_id;
      this.#acceptedExecution = null;
      this.#pendingFailures.clear();
      this.#planCreations.clear();
      this.#planAttempts.clear();
      this.#sealedGraphDigest = null;
    }
    const pending = this.#pendingFailures.get(cycleKey);
    if (pending !== undefined) {
      return this.#failCycle(request, pending.reason, pending.plan_status, epoch);
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
    if (execution.ownership === "lost") {
      return this.#failCycle(request, "lost_execution_context", "failed", epoch);
    }
    if (
      this.#acceptedExecution !== null
      && executionFacts(request) !== executionFacts(this.#acceptedExecution)
    ) return this.#failCycle(request, "cycle_transition_failed", "failed", epoch);
    for (const stage of stageList(request)) {
      const owner = this.#stageOwners.get(stage.issue_id);
      if (owner !== undefined && owner !== request.cycle_id) {
        return this.#failCycle(request, "cycle_transition_failed", "failed", epoch);
      }
    }
    this.#remember(request);
    if (
      this.#sealedGraphDigest !== null
      && request.sealed_graph_digest !== this.#sealedGraphDigest
    ) return this.#failCycle(request, "cycle_transition_failed", "failed", epoch);
    const transition = reduceCycleTransition(request, {
      cycle_seal_digest: request.specification.seal_digest,
      graph_seal_digest: request.sealed_graph_digest,
    });
    if (transition.action === "plan_and_materialize") {
      if (this.#planAttempts.has(cycleKey)) {
        return this.#failCycle(request, "lost_execution_context", "failed", epoch);
      }
      this.#planAttempts.add(cycleKey);
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
        const execution = await this.#workExecutor.execute(request, workIssueId, basis, built);
        this.#assertActive(epoch);
        if (execution.outcome === "completed") {
          this.#remember(execution.snapshot);
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
        this.#remember(execution.snapshot);
        return execution.outcome === "awaiting_acceptance"
          ? result(request, "awaiting_acceptance", execution.snapshot.cycle_revision)
          : failedResult(
            request,
            "terminal_failed",
            execution.snapshot.cycle_revision,
            "verify_phase_failed",
          );
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

    if (this.#planCreations.has(cycleKey)) {
      return this.#failCycle(request, "cycle_transition_failed", "failed", epoch);
    }
    this.#planCreations.add(cycleKey);

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
        createdPlan.description,
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
      const createdSnapshot = bindCycleAdvanceRequest({
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
      this.#sealedGraphDigest = planGraph.seal_digest;
      this.#remember(createdSnapshot);
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
      this.#sealedGraphDigest = readback.sealed_graph_digest;
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
      this.#remember(bindCycleAdvanceRequest({
        ...readback,
        plan_issue: { ...plan, revision: finishedPlan.revision, status: "done" },
      }));
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
      if (parseTaskIssueId(planStage.issue_id) !== basis.specification.plan_issue_id) {
        throw new Error("plan_issue_identity_mismatch");
      }
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
      this.#remember(startedSnapshot);

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
      this.#sealedGraphDigest = readback.sealed_graph_digest;
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
      const finishedSnapshot = bindCycleAdvanceRequest({
        ...readback,
        plan_issue: {
          ...readback.plan_issue!,
          revision: finishedPlan.revision,
          status: "done",
        },
      });
      this.#remember(finishedSnapshot);
      return result(request, "advanced");
    } catch {
      this.#assertActive(epoch);
      return this.#failCycle(failureSnapshot, "plan_phase_failed", planTerminalStatus, epoch);
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

  async #failCycle(
    request: CycleAdvanceRequest,
    reason: CycleExecutionFailureReason,
    planStatus: PlanTerminalStatus,
    epoch: number,
  ): Promise<CycleAdvanceResult> {
    this.#assertActive(epoch);
    const cycleKey = this.#cycleKey(request);
    this.#pendingFailures.set(cycleKey, Object.freeze({ reason, plan_status: planStatus }));
    if (request.cycle_status === "failed" || request.cycle_status === "canceled") {
      this.#pendingFailures.delete(cycleKey);
      return failedResult(request, "terminal_failed", request.cycle_revision, reason);
    }

    let terminalReason = reason;
    for (const stage of stageList(request).filter(({ status }) => status === "in_progress")) {
      const stageStatus = stage.kind === "plan" ? planStatus : "failed";
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
        this.#pendingFailures.set(cycleKey, Object.freeze({
          reason: terminalReason,
          plan_status: planStatus,
        }));
      }
    }

    const cycleCall = statusCall(
      request,
      parseTaskIssueId(request.cycle_id),
      request.cycle_revision,
      this.#workflow.cycle_states.failed,
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
      this.#pendingFailures.delete(cycleKey);
      this.#acceptedExecution = null;
      return failedResult(request, "terminal_failed", failedCycle.revision, terminalReason);
    } catch {
      this.#assertActive(epoch);
      return failedResult(request, "precondition_failed", request.cycle_revision, "cycle_transition_failed");
    }
  }

  #cycleKey(request: CycleAdvanceRequest): string {
    return `${request.cycle_id}\0${request.specification.seal_digest}`;
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

  #remember(request: CycleAdvanceRequest): void {
    this.#acceptedExecution = request;
    for (const stage of stageList(request)) this.#stageOwners.set(stage.issue_id, request.cycle_id);
  }

  #assertActive(epoch: number): void {
    if (this.#retired || epoch !== this.#epoch) throw new Error("cycle_machine_late_output");
  }
}
