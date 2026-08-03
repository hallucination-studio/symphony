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
import type { GitSnapshot } from "../../contracts/observation.js";
import type { TaskIssueSnapshot } from "../../contracts/task-management.js";
import {
  parseWorkRequest,
  parseWorkResult,
  type PlanRequestTarget,
  type WorkPerformerInterface,
  type WorkResult,
} from "../../performer/api/StagePerformerInterface.js";
import type {
  TaskManageCallerIssuer,
  TaskWorkflowIdentities,
} from "../../task-management/api/TaskManageCapability.js";
import { parseTaskWorkflowIdentities } from "../../task-management/api/TaskManageCapability.js";
import type {
  TaskManageCommandInterface,
} from "../../task-management/api/TaskManageCommandInterface.js";
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
import type { BuiltPlanGraphManifest } from "./PlanGraphManifest.js";

interface PerformerOwner {
  readonly cycle: string;
  readonly executor: object;
}

const performerOwners = new WeakMap<WorkPerformerInterface, PerformerOwner>();

export interface CycleWorkPerformerFactory {
  create(target: PlanRequestTarget): Promise<WorkPerformerInterface>;
}

export interface CycleWorkExecutorOptions {
  readonly workflow: TaskWorkflowIdentities;
  readonly caller_issuer: TaskManageCallerIssuer;
  readonly task_manager: TaskManageCommandInterface;
  readonly reader: FreshCycleExecutionReader;
  readonly performer_factory: CycleWorkPerformerFactory;
  readonly completion_writer: {
    persistWork(
      snapshot: CycleAdvanceRequest,
      basis: SealedCycleBasis,
      built: BuiltPlanGraphManifest,
      result: WorkResult,
      execution: { assertActive(): void },
    ): Promise<unknown>;
  };
}

export interface CycleWorkExecutionResult {
  readonly snapshot: CycleAdvanceRequest;
  readonly outcome: WorkResult["outcome"];
}

export class CycleWorkExecutionError extends Error {
  constructor(readonly snapshot: CycleAdvanceRequest) {
    super("cycle_work_execution_failed");
    this.name = "CycleWorkExecutionError";
  }
}

function statusCall(
  request: CycleAdvanceRequest,
  stage: StageExecutionSnapshot,
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
      issue_id: parseTaskIssueId(stage.issue_id),
      expected_revision: stage.revision,
      desired: Object.freeze({ state_id: stateId }),
    }),
  });
}

function appliedUpdatedIssue(output: TaskMutationOutput): TaskIssueSnapshot {
  if (
    output.outcome !== "applied"
    || output.fresh_resource === null
    || !("issue_id" in output.fresh_resource)
  ) throw new Error("work_status_mutation_not_applied");
  return output.fresh_resource;
}

function performerOwner(target: PlanRequestTarget): string {
  return `${target.root_id}\0${target.runtime_generation}\0${target.cycle_id}`;
}

function isTargetPerformer(
  performer: WorkPerformerInterface,
  target: PlanRequestTarget,
  executor: object,
): boolean {
  const owner = performerOwners.get(performer);
  return performer.role === "work"
    && performer.rootId === target.root_id
    && performer.runtimeGeneration === target.runtime_generation
    && performer.cycleId === target.cycle_id
    && owner?.cycle === performerOwner(target)
    && owner.executor === executor;
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

function assertExactStatusReadback(
  before: CycleAdvanceRequest,
  after: CycleAdvanceRequest,
  selected: StageExecutionSnapshot,
  fresh: TaskIssueSnapshot,
  expectedStatus: StageExecutionSnapshot["status"],
  workflow: TaskWorkflowIdentities,
): void {
  if (
    after.root_id !== before.root_id
    || after.cycle_id !== before.cycle_id
    || after.runtime_generation !== before.runtime_generation
    || after.correlation_id !== before.correlation_id
    || after.cycle_revision !== before.cycle_revision
    || after.cycle_status !== before.cycle_status
    || after.specification.seal_digest !== before.specification.seal_digest
    || after.sealed_graph_digest !== before.sealed_graph_digest
    || !sameGit(after.git, before.git)
    || !sameRelations(after, before)
    || (after.plan_issue === null) !== (before.plan_issue === null)
    || (
      after.plan_issue !== null
      && before.plan_issue !== null
      && !sameStage(after.plan_issue, before.plan_issue)
    )
    || (after.verify_issue === null) !== (before.verify_issue === null)
    || (
      after.verify_issue !== null
      && before.verify_issue !== null
      && !sameStage(after.verify_issue, before.verify_issue)
    )
    || after.sealed_work_issues.length !== before.sealed_work_issues.length
  ) throw new Error("work_status_readback_mismatch");

  const byId = new Map(after.sealed_work_issues.map((stage) => [stage.issue_id, stage]));
  for (const prior of before.sealed_work_issues) {
    const current = byId.get(prior.issue_id);
    if (current === undefined) throw new Error("work_status_readback_mismatch");
    if (prior.issue_id !== selected.issue_id) {
      if (!sameStage(current, prior)) throw new Error("work_status_readback_mismatch");
      continue;
    }
    if (
      current.revision !== fresh.revision
      || current.status !== expectedStatus
      || current.issue_id !== selected.issue_id
      || current.sealed_revision !== selected.sealed_revision
      || current.kind !== selected.kind
      || current.title !== selected.title
      || current.description_markdown !== selected.description_markdown
      || current.parent_cycle_id !== selected.parent_cycle_id
      || fresh.issue_id !== parseTaskIssueId(selected.issue_id)
      || fresh.status_id !== workflow.stage_states[expectedStatus]
      || fresh.title !== selected.title
      || fresh.description_markdown !== selected.description_markdown
      || fresh.parent_issue_id !== parseTaskIssueId(selected.parent_cycle_id)
      || fresh.label_ids.length !== 1
      || fresh.label_ids[0] !== workflow.labels.work
      || fresh.delegate_id !== null
      || fresh.priority !== null
    ) throw new Error("work_status_readback_mismatch");
  }
}

export class CycleWorkExecutor {
  readonly #callerIssuer: TaskManageCallerIssuer;
  readonly #performerFactory: CycleWorkPerformerFactory;
  readonly #reader: FreshCycleExecutionReader;
  readonly #taskManager: TaskManageCommandInterface;
  readonly #workflow: TaskWorkflowIdentities;
  readonly #completionWriter: CycleWorkExecutorOptions["completion_writer"];
  readonly #owner = Object.freeze({});
  #active = false;
  #epoch = 0;
  #performer: WorkPerformerInterface | null = null;
  #retirement: Promise<void> | null = null;
  #retired = false;

  constructor(options: CycleWorkExecutorOptions) {
    this.#workflow = parseTaskWorkflowIdentities(options.workflow);
    this.#callerIssuer = options.caller_issuer;
    this.#taskManager = options.task_manager;
    this.#reader = options.reader;
    this.#performerFactory = options.performer_factory;
    this.#completionWriter = options.completion_writer;
  }

  async execute(
    request: CycleAdvanceRequest,
    workIssueId: StageIssueId,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
  ): Promise<CycleWorkExecutionResult> {
    if (this.#retired) throw new CycleWorkExecutionError(request);
    if (this.#active) throw new CycleWorkExecutionError(request);
    this.#active = true;
    const epoch = this.#epoch;
    let current = request;
    let started = false;
    let terminalAttempted = false;
    try {
      const work = request.sealed_work_issues.find(({ issue_id }) => issue_id === workIssueId);
      if (work === undefined || work.status !== "todo") throw new Error("ready_work_missing");
      current = await this.#transition(current, work, "in_progress", epoch);
      started = true;
      const startedWork = current.sealed_work_issues.find(({ issue_id }) => issue_id === workIssueId);
      if (startedWork === undefined || startedWork.status !== "in_progress") {
        throw new Error("started_work_missing");
      }
      const target = Object.freeze({
        root_id: current.root_id,
        runtime_generation: current.runtime_generation,
        cycle_id: current.cycle_id,
        cycle_revision: current.cycle_revision,
      });
      const performer = await this.#performerFor(target, epoch);
      const workRequest = parseWorkRequest({
        schema_version: 1,
        ...target,
        correlation_id: current.correlation_id,
        work_issue_id: startedWork.issue_id,
        work_issue_revision: startedWork.revision,
        cycle_description_markdown: current.specification.cycle_description_markdown,
        work_issue_description_markdown: startedWork.description_markdown,
      }, target);
      const rawResult = await performer.work(workRequest);
      this.#assertActive(epoch);
      const workResult = parseWorkResult(rawResult, workRequest);
      const rawCompletionSnapshot = await this.#reader.read(Object.freeze({
        root_id: current.root_id,
        cycle_id: current.cycle_id,
        runtime_generation: current.runtime_generation,
        correlation_id: current.correlation_id,
      }));
      this.#assertActive(epoch);
      if (rawCompletionSnapshot === null) throw new Error("work_completion_readback_missing");
      current = bindCycleAdvanceRequest(rawCompletionSnapshot);
      const completionWork = current.sealed_work_issues.find(({ issue_id }) => issue_id === workIssueId);
      if (completionWork === undefined || completionWork.status !== "in_progress") {
        throw new Error("work_completion_source_changed");
      }
      await this.#completionWriter.persistWork(
        current,
        basis,
        built,
        workResult,
        Object.freeze({ assertActive: () => this.#assertActive(epoch) }),
      );
      this.#assertActive(epoch);
      terminalAttempted = true;
      current = await this.#transition(current, completionWork, workResult.outcome === "completed"
        ? "done"
        : workResult.outcome, epoch);
      if (
        workResult.outcome !== "completed"
        || current.sealed_work_issues.every(({ status }) => status === "done")
      ) await this.#closePerformer(epoch);
      return Object.freeze({ snapshot: current, outcome: workResult.outcome });
    } catch {
      if (started && !terminalAttempted && this.#isActive(epoch)) {
        const activeWork = current.sealed_work_issues.find(({ issue_id }) => issue_id === workIssueId);
        if (activeWork?.status === "in_progress") {
          try {
            current = await this.#transition(current, activeWork, "failed", epoch);
          } catch {
            // The exact Work status is unconfirmed; the Cycle still fails from the last confirmed snapshot.
          }
        }
      }
      await this.#closePerformerIfCurrent(epoch);
      throw new CycleWorkExecutionError(current);
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
      retirement = Promise.reject(new Error("cycle_work_retirement_failed"));
    }
    this.#retirement = retirement.catch(() => {
      throw new Error("cycle_work_retirement_failed");
    });
    return this.#retirement;
  }

  async #transition(
    request: CycleAdvanceRequest,
    work: StageExecutionSnapshot,
    status: "in_progress" | "done" | "failed" | "canceled",
    epoch: number,
  ): Promise<CycleAdvanceRequest> {
    const call = statusCall(request, work, this.#workflow.stage_states[status]);
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
    this.#assertActive(epoch);
    const rawReadback = await this.#reader.read(Object.freeze({
      root_id: request.root_id,
      cycle_id: request.cycle_id,
      runtime_generation: request.runtime_generation,
      correlation_id: request.correlation_id,
    }));
    this.#assertActive(epoch);
    if (rawReadback === null) throw new Error("work_status_readback_missing");
    const readback = bindCycleAdvanceRequest(rawReadback);
    assertExactStatusReadback(request, readback, work, fresh, status, this.#workflow);
    return readback;
  }

  async #performerFor(
    target: PlanRequestTarget,
    epoch: number,
  ): Promise<WorkPerformerInterface> {
    if (this.#performer !== null) {
      if (!isTargetPerformer(this.#performer, target, this.#owner)) {
        await this.#closePerformer(epoch).catch(() => undefined);
        throw new Error("work_performer_cross_cycle_reuse");
      }
      return this.#performer;
    }
    const performer = await this.#performerFactory.create(target);
    try {
      this.#assertActive(epoch);
      if (
        performer.role !== "work"
        || performer.rootId !== target.root_id
        || performer.runtimeGeneration !== target.runtime_generation
        || performer.cycleId !== target.cycle_id
      ) throw new Error("work_performer_target_mismatch");
      const owner = performerOwner(target);
      const existingOwner = performerOwners.get(performer);
      if (existingOwner !== undefined) {
        throw new Error("work_performer_cross_cycle_reuse");
      }
      performerOwners.set(performer, Object.freeze({ cycle: owner, executor: this.#owner }));
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
      // The caller reports the closed Cycle failure; cleanup cannot authorize another Task effect.
    }
  }

  #isActive(epoch: number): boolean {
    return !this.#retired && epoch === this.#epoch;
  }

  #assertActive(epoch: number): void {
    if (!this.#isActive(epoch)) throw new Error("cycle_work_late_output");
  }
}
