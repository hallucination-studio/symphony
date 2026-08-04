import { randomUUID } from "node:crypto";

import {
  boundaryError,
  type BoundaryError,
  type BoundaryErrorCode,
} from "../../contracts/common-outcomes.js";
import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskIssueId,
  parseTaskRevision,
  type CorrelationId,
  type CycleIssueId,
} from "../../contracts/identity.js";
import {
  parseCycleAdvanceResult,
  parseCycleExecutionSnapshot,
  parseSealedExecutionGraph,
  type CycleAdvanceRequest,
  type CycleAdvanceResult,
  type CycleSealDigest,
  type StageExecutionSnapshot,
} from "../../contracts/cycle.js";
import {
  parseTaskSnapshot,
  type TaskIssueSnapshot,
  type TaskSnapshot,
} from "../../contracts/task-management.js";
import type { RuntimeTarget } from "../../contracts/runtime.js";
import {
  parseTaskWorkflowIdentities,
  type TaskWorkflowIdentities,
} from "../../task-management/api/TaskManageCapability.js";
import type {
  CycleMachineExecution,
  CycleMachineInterface,
  SealedFactMutationObservation,
} from "../api/CycleMachineInterface.js";
import { parseSealedFactMutationObservation } from "../api/CycleMachineInterface.js";

export interface CycleMachineReadRequest extends RuntimeTarget {
  readonly cycle_id: CycleIssueId;
  readonly correlation_id: CorrelationId;
}

export interface FreshCycleExecutionReader {
  read(request: CycleMachineReadRequest): Promise<CycleAdvanceRequest | null>;
  readSealedFactMutation?(
    request: CycleMachineReadRequest,
    task: TaskSnapshot | null,
  ): Promise<SealedFactMutationObservation | null>;
}

export interface PreparedCycleAction {
  readonly kind: "cycle_action";
  readonly request: CycleAdvanceRequest;
}

export type CycleMachinePreparation =
  | { readonly kind: "root_available" }
  | { readonly kind: "paused"; readonly error: BoundaryError }
  | PreparedCycleAction;

export interface CycleMachineHostInterface {
  readonly target: RuntimeTarget;
  prepare(
    task: TaskSnapshot,
    correlationId: CorrelationId,
    previousAcceptedTask: TaskSnapshot | null,
    closure?: CycleMachineExecution["closure"],
    selectedCycleId?: CycleIssueId,
  ): Promise<CycleMachinePreparation>;
  prepareContinuation(): Promise<CycleMachinePreparation>;
  run(prepared: PreparedCycleAction): Promise<CycleAdvanceResult>;
  retire(): Promise<void>;
}

export interface CycleMachineLifecycle {
  retire(): Promise<void>;
}

export interface CycleMachineHostOptions {
  readonly target: RuntimeTarget;
  readonly workflow: TaskWorkflowIdentities;
  readonly reader: FreshCycleExecutionReader;
  readonly machine: CycleMachineInterface;
  readonly machine_lifecycle?: CycleMachineLifecycle;
  readonly identity_factory?: () => string;
}

interface ActiveCycle {
  readonly cycle_id: CycleIssueId;
  readonly seal_digest: CycleSealDigest;
  readonly ownership: CycleMachineExecution["ownership"];
}

const ROOT_AVAILABLE = Object.freeze({ kind: "root_available" as const });

function sealedStage(stage: StageExecutionSnapshot) {
  return {
    issue_id: stage.issue_id,
    sealed_revision: stage.sealed_revision,
    kind: stage.kind,
    title: stage.title,
    description_markdown: stage.description_markdown,
    parent_cycle_id: stage.parent_cycle_id,
  };
}

function executionStage(stage: StageExecutionSnapshot) {
  return {
    issue_id: stage.issue_id,
    revision: stage.revision,
    kind: stage.kind,
    title: stage.title,
    description_markdown: stage.description_markdown,
    parent_cycle_id: stage.parent_cycle_id,
    status: stage.status,
  };
}

function executionStages(snapshot: CycleAdvanceRequest): readonly StageExecutionSnapshot[] {
  return [
    ...(snapshot.plan_issue === null ? [] : [snapshot.plan_issue]),
    ...snapshot.sealed_work_issues,
    ...(snapshot.verify_issue === null ? [] : [snapshot.verify_issue]),
  ];
}

function requiresLiveContext(snapshot: CycleAdvanceRequest): boolean {
  if (executionStages(snapshot).some(({ status }) => status === "in_progress")) return true;
  const firstPendingWork = snapshot.sealed_work_issues.findIndex(({ status }) => status === "todo");
  return firstPendingWork > 0
    && snapshot.sealed_work_issues.slice(0, firstPendingWork).some(({ status }) => status === "done");
}

export function bindCycleAdvanceRequest(value: CycleAdvanceRequest): CycleAdvanceRequest {
  const cycleId = parseCycleIssueId(value.cycle_id);
  const graph = parseSealedExecutionGraph({
    plan_issue: value.plan_issue === null ? null : sealedStage(value.plan_issue),
    work_issues: value.sealed_work_issues.map(sealedStage),
    verify_issue: value.verify_issue === null ? null : sealedStage(value.verify_issue),
    relations: value.sealed_relations,
  }, cycleId);
  if (graph.seal_digest !== value.sealed_graph_digest) throw new Error("cycle_snapshot_graph_mismatch");
  return parseCycleExecutionSnapshot({
    schema_version: value.schema_version,
    root_id: value.root_id,
    cycle_id: value.cycle_id,
    runtime_generation: value.runtime_generation,
    correlation_id: value.correlation_id,
    cycle_revision: value.cycle_revision,
    cycle_status: value.cycle_status,
    specification: value.specification,
    plan_issue: value.plan_issue === null ? null : executionStage(value.plan_issue),
    sealed_work_issues: value.sealed_work_issues.map(executionStage),
    verify_issue: value.verify_issue === null ? null : executionStage(value.verify_issue),
    sealed_relations: value.sealed_relations,
    resource_creation_evidence: value.resource_creation_evidence,
    issue_history: value.issue_history,
    issue_record_observations: value.issue_record_observations,
    git: value.git,
  }, {
    root_id: parseRootIssueId(value.root_id),
    cycle_id: cycleId,
    runtime_generation: parseRuntimeGeneration(value.runtime_generation),
    correlation_id: parseCorrelationId(value.correlation_id),
    cycle_revision: parseTaskRevision(value.cycle_revision),
    specification: value.specification,
    sealed_graph: graph,
  });
}

function cycleStatus(
  issue: TaskIssueSnapshot,
  workflow: TaskWorkflowIdentities,
): keyof TaskWorkflowIdentities["cycle_states"] | null {
  for (const [status, identity] of Object.entries(workflow.cycle_states)) {
    if (issue.status_id === identity) return status as keyof TaskWorkflowIdentities["cycle_states"];
  }
  return null;
}

function hasOnlyTaskKind(
  issue: TaskIssueSnapshot,
  expected: keyof TaskWorkflowIdentities["labels"],
  workflow: TaskWorkflowIdentities,
): boolean {
  const kinds = Object.entries(workflow.labels)
    .filter(([, identity]) => issue.label_ids.includes(identity))
    .map(([kind]) => kind);
  return kinds.length === 1 && kinds[0] === expected;
}

export class CycleMachineHost implements CycleMachineHostInterface {
  readonly #identityFactory: () => string;
  readonly #machine: CycleMachineInterface;
  readonly #machineLifecycle: CycleMachineLifecycle | null;
  readonly #executions = new WeakMap<PreparedCycleAction, CycleMachineExecution>();
  readonly #prepared = new WeakSet<PreparedCycleAction>();
  readonly #reader: FreshCycleExecutionReader;
  readonly #started = new WeakSet<PreparedCycleAction>();
  readonly #target: RuntimeTarget;
  readonly #workflow: TaskWorkflowIdentities;
  #active: ActiveCycle | null = null;
  #epoch = 0;
  #inFlight: PreparedCycleAction | null = null;
  #ready: PreparedCycleAction | null = null;
  #retirement: Promise<void> | null = null;
  #retired = false;

  constructor(options: CycleMachineHostOptions) {
    this.#target = Object.freeze({
      root_id: parseRootIssueId(options.target.root_id),
      runtime_generation: parseRuntimeGeneration(options.target.runtime_generation),
    });
    this.#workflow = parseTaskWorkflowIdentities(options.workflow);
    this.#reader = options.reader;
    this.#machine = options.machine;
    this.#machineLifecycle = options.machine_lifecycle ?? null;
    this.#identityFactory = options.identity_factory ?? randomUUID;
  }

  get target(): RuntimeTarget { return this.#target; }

  async prepare(
    taskValue: TaskSnapshot,
    correlationValue: CorrelationId,
    previousAcceptedTaskValue: TaskSnapshot | null,
    closure: CycleMachineExecution["closure"] = undefined,
    selectedCycleValue: CycleIssueId | undefined = undefined,
  ): Promise<CycleMachinePreparation> {
    this.#assertAvailable();
    const correlationId = parseCorrelationId(correlationValue);
    let task: TaskSnapshot;
    try {
      task = parseTaskSnapshot(taskValue);
    } catch {
      return this.#paused("invalid_contract", "cycle_task_snapshot_invalid", correlationId);
    }
    if (task.root_id !== this.#target.root_id) {
      return this.#paused("invalid_contract", "cycle_task_root_mismatch", correlationId);
    }
    let previousAcceptedTask: TaskSnapshot | null = null;
    if (previousAcceptedTaskValue !== null) {
      try {
        previousAcceptedTask = parseTaskSnapshot(previousAcceptedTaskValue);
      } catch {
        return this.#paused("invalid_contract", "cycle_generation_baseline_invalid", correlationId);
      }
      if (previousAcceptedTask.root_id !== this.#target.root_id) {
        return this.#paused("invalid_contract", "cycle_generation_baseline_root_mismatch", correlationId);
      }
    }
    const rootTaskId = parseTaskIssueId(this.#target.root_id);
    const cycles = task.issues.filter((issue) => issue.label_ids.includes(this.#workflow.labels.cycle));
    for (const cycle of cycles) {
      if (cycle.parent_issue_id !== rootTaskId || !hasOnlyTaskKind(cycle, "cycle", this.#workflow)) {
        return this.#paused("invalid_contract", "cycle_admission_topology_invalid", correlationId);
      }
      if (cycleStatus(cycle, this.#workflow) === null) {
        return this.#paused("invalid_contract", "cycle_admission_state_invalid", correlationId);
      }
    }
    const nonTerminal = cycles.filter((cycle) => {
      const status = cycleStatus(cycle, this.#workflow);
      return status === "draft" || status === "in_progress" || status === "awaiting_acceptance";
    });
    if (nonTerminal.length > 1) {
      return this.#paused("invalid_contract", "multiple_non_terminal_cycles", correlationId);
    }
    const selectedCycleId = selectedCycleValue === undefined
      ? undefined
      : parseTaskIssueId(selectedCycleValue);
    const candidate = nonTerminal[0];
    if (selectedCycleId !== undefined && candidate !== undefined) {
      return this.#paused("readback_mismatch", "external_terminal_cycle_readback_changed", correlationId);
    }
    if (candidate === undefined) {
      if (selectedCycleId !== undefined) {
        const selectedCycle = cycles.find(({ issue_id }) => issue_id === selectedCycleId);
        const selectedStatus = selectedCycle === undefined ? null : cycleStatus(selectedCycle, this.#workflow);
        if (
          selectedCycle === undefined
          || selectedStatus === null
          || selectedStatus === "draft"
          || selectedStatus === "in_progress"
          || selectedStatus === "awaiting_acceptance"
        ) return this.#paused("readback_mismatch", "external_terminal_cycle_missing", correlationId);
        const cycleId = parseCycleIssueId(selectedCycle.issue_id);
        if (this.#active !== null && this.#active.cycle_id !== cycleId) {
          return this.#paused("invalid_contract", "active_cycle_rebound", correlationId);
        }
        const ownership = this.#active?.ownership ?? "live";
        return this.#readAction(
          cycleId,
          correlationId,
          selectedCycle,
          task,
          ownership,
          closure,
          true,
        );
      }
      this.#active = null;
      return ROOT_AVAILABLE;
    }
    const status = cycleStatus(candidate, this.#workflow);
    const cycleId = parseCycleIssueId(candidate.issue_id);
    if (status === "draft") {
      this.#active = null;
      return ROOT_AVAILABLE;
    }
    if (this.#active !== null && this.#active.cycle_id !== cycleId) {
      return this.#paused("invalid_contract", "active_cycle_rebound", correlationId);
    }
    const ownership = this.#active?.ownership ?? "live";
    return this.#readAction(cycleId, correlationId, candidate, task, ownership, closure);
  }

  async prepareContinuation(): Promise<CycleMachinePreparation> {
    this.#assertAvailable();
    if (this.#active === null) return ROOT_AVAILABLE;
    const correlationId = parseCorrelationId(this.#identityFactory());
    return this.#readAction(
      this.#active.cycle_id,
      correlationId,
      null,
      null,
      this.#active.ownership,
      undefined,
    );
  }

  async run(prepared: PreparedCycleAction): Promise<CycleAdvanceResult> {
    if (!this.#prepared.has(prepared)) throw new Error("invalid_cycle_machine_action");
    if (this.#started.has(prepared)) throw new Error("cycle_machine_action_already_started");
    if (this.#retired) throw new Error("cycle_machine_retired");
    if (this.#inFlight !== null) throw new Error("cycle_machine_busy");
    if (this.#ready !== prepared) throw new Error("cycle_machine_action_not_pending");
    this.#started.add(prepared);
    this.#ready = null;
    this.#inFlight = prepared;
    const epoch = this.#epoch;
    let rawResult: CycleAdvanceResult;
    try {
      const execution = this.#executions.get(prepared);
      if (execution === undefined) throw new Error("cycle_machine_execution_missing");
      rawResult = await this.#machine.advance(prepared.request, execution);
    } catch {
      if (this.#retired || epoch !== this.#epoch) throw new Error("cycle_machine_late_output");
      throw new Error("cycle_machine_boundary_failed");
    } finally {
      if (this.#inFlight === prepared) this.#inFlight = null;
    }
    if (this.#retired || epoch !== this.#epoch) throw new Error("cycle_machine_late_output");
    let result: CycleAdvanceResult;
    try {
      result = parseCycleAdvanceResult(rawResult, prepared.request);
    } catch {
      throw new Error("cycle_machine_invalid_result");
    }
    const execution = this.#executions.get(prepared);
    if (
      execution?.ownership === "lost"
      && result.outcome !== "terminal_failed"
      && result.outcome !== "precondition_failed"
    ) throw new Error("cycle_machine_lost_execution_not_failed");
    if (result.outcome === "terminal_failed") {
      this.#active = null;
    }
    return result;
  }

  retire(): Promise<void> {
    if (this.#retirement !== null) return this.#retirement;
    this.#retired = true;
    this.#active = null;
    this.#ready = null;
    this.#epoch += 1;
    let retirement: Promise<void>;
    try {
      retirement = this.#machineLifecycle?.retire() ?? Promise.resolve();
    } catch {
      retirement = Promise.reject(new Error("cycle_machine_retirement_failed"));
    }
    this.#retirement = retirement.catch(() => {
      throw new Error("cycle_machine_retirement_failed");
    });
    return this.#retirement;
  }

  async #readAction(
    cycleId: CycleIssueId,
    correlationId: CorrelationId,
    observedCycle: TaskIssueSnapshot | null,
    task: TaskSnapshot | null,
    requestedOwnership: CycleMachineExecution["ownership"],
    closure: CycleMachineExecution["closure"],
    allowExternalTerminal = false,
  ): Promise<CycleMachinePreparation> {
    let raw: CycleAdvanceRequest | null;
    try {
      raw = await this.#reader.read(Object.freeze({
        root_id: this.#target.root_id,
        cycle_id: cycleId,
        runtime_generation: this.#target.runtime_generation,
        correlation_id: correlationId,
      }));
    } catch {
      return this.#paused("boundary_unavailable", "cycle_snapshot_unavailable", correlationId);
    }
    if (raw === null) return this.#paused("invalid_contract", "approved_cycle_missing", correlationId);
    if (raw.runtime_generation !== this.#target.runtime_generation) {
      return this.#paused("stale_generation", "cycle_snapshot_generation_stale", correlationId);
    }
    let snapshot: CycleAdvanceRequest;
    try {
      snapshot = bindCycleAdvanceRequest(raw);
    } catch {
      return this.#paused("invalid_contract", "cycle_snapshot_invalid", correlationId);
    }
    if (
      snapshot.root_id !== this.#target.root_id
      || snapshot.cycle_id !== cycleId
      || snapshot.correlation_id !== correlationId
    ) return this.#paused("invalid_contract", "cycle_snapshot_target_mismatch", correlationId);
    let sealedFactMutation: SealedFactMutationObservation | null = null;
    if (closure === "sealed_fact_mutated") {
      if (this.#reader.readSealedFactMutation === undefined) {
        return this.#paused("boundary_unavailable", "sealed_fact_observation_unavailable", correlationId);
      }
      let observed: SealedFactMutationObservation | null;
      try {
        observed = await this.#reader.readSealedFactMutation(
          Object.freeze({
            root_id: this.#target.root_id,
            cycle_id: cycleId,
            runtime_generation: this.#target.runtime_generation,
            correlation_id: correlationId,
          }),
          task,
        );
      } catch {
        return this.#paused("boundary_unavailable", "sealed_fact_observation_unavailable", correlationId);
      }
      if (observed === null) {
        return this.#paused("invalid_contract", "sealed_fact_observation_missing", correlationId);
      }
      try {
        sealedFactMutation = parseSealedFactMutationObservation(observed);
      } catch {
        return this.#paused("invalid_contract", "sealed_fact_observation_invalid", correlationId);
      }
    }
    let ownership = requestedOwnership;
    if (this.#active !== null && snapshot.specification.seal_digest !== this.#active.seal_digest) {
      ownership = "lost";
    }
    if (snapshot.cycle_status !== "in_progress" && snapshot.cycle_status !== "awaiting_acceptance") {
      if (allowExternalTerminal) {
        if (
          snapshot.cycle_status !== "succeeded"
          && snapshot.cycle_status !== "rejected"
          && snapshot.cycle_status !== "failed"
          && snapshot.cycle_status !== "canceled"
        ) return this.#paused("readback_mismatch", "external_terminal_cycle_readback_changed", correlationId);
      } else {
        if (snapshot.cycle_status === "succeeded" || snapshot.cycle_status === "rejected") {
          return this.#paused("readback_mismatch", "active_cycle_acceptance_bypassed", correlationId);
        }
        if (observedCycle !== null) {
          return this.#paused("readback_mismatch", "cycle_admission_readback_changed", correlationId);
        }
        this.#active = null;
        return ROOT_AVAILABLE;
      }
    }
    const matchesTask = observedCycle === null
      || task === null
      || this.#matchesFreshTask(snapshot, observedCycle, task);
    if (!matchesTask) ownership = "lost";
    if (
      this.#active === null
      && ownership === "live"
      && requiresLiveContext(snapshot)
    ) ownership = "lost";
    if (
      snapshot.cycle_status === "awaiting_acceptance"
      && matchesTask
    ) {
      this.#active = null;
      return ROOT_AVAILABLE;
    }
    if (this.#active === null) {
      this.#active = Object.freeze({
        cycle_id: snapshot.cycle_id,
        seal_digest: snapshot.specification.seal_digest,
        ownership,
      });
    } else if (ownership === "lost" && this.#active.ownership !== "lost") {
      this.#active = Object.freeze({ ...this.#active, ownership: "lost" });
    }
    const prepared = Object.freeze({ kind: "cycle_action" as const, request: snapshot });
    this.#prepared.add(prepared);
    this.#executions.set(prepared, Object.freeze({
      ownership,
      ...(closure === undefined ? {} : { closure }),
      ...(sealedFactMutation === null || sealedFactMutation === undefined
        ? {}
        : { sealed_fact_mutation: sealedFactMutation }),
    }));
    this.#ready = prepared;
    return prepared;
  }

  #matchesFreshTask(
    snapshot: CycleAdvanceRequest,
    cycle: TaskIssueSnapshot,
    task: TaskSnapshot,
  ): boolean {
    if (
      cycle.issue_id !== parseTaskIssueId(snapshot.cycle_id)
      || cycle.revision !== snapshot.cycle_revision
      || cycle.description_markdown !== snapshot.specification.cycle_description_markdown
      || cycle.status_id !== this.#workflow.cycle_states[snapshot.cycle_status]
    ) return false;
    const stages = [
      ...(snapshot.plan_issue === null ? [] : [snapshot.plan_issue]),
      ...snapshot.sealed_work_issues,
      ...(snapshot.verify_issue === null ? [] : [snapshot.verify_issue]),
    ];
    const taskStages = task.issues.filter(({ parent_issue_id }) => parent_issue_id === cycle.issue_id);
    if (taskStages.length !== stages.length) return false;
    const stageIds = new Set(stages.map(({ issue_id }) => parseTaskIssueId(issue_id)));
    for (const stage of stages) {
      const issue = taskStages.find(({ issue_id }) => issue_id === parseTaskIssueId(stage.issue_id));
      if (
        issue === undefined
        || issue.revision !== stage.revision
        || issue.title !== stage.title
        || issue.description_markdown !== stage.description_markdown
        || issue.status_id !== this.#workflow.stage_states[stage.status]
        || !hasOnlyTaskKind(issue, stage.kind, this.#workflow)
      ) return false;
    }
    const taskRelations = task.relations.filter(({ source_issue_id, target_issue_id }) => (
      stageIds.has(source_issue_id) || stageIds.has(target_issue_id)
    ));
    if (taskRelations.length !== snapshot.sealed_relations.length) return false;
    const byId = new Map(taskRelations.map((relation) => [relation.relation_id, relation]));
    return snapshot.sealed_relations.every((relation) => {
      const taskRelation = byId.get(relation.relation_id);
      return taskRelation !== undefined
        && taskRelation.revision === relation.revision
        && taskRelation.type === "blocks"
        && taskRelation.source_issue_id === parseTaskIssueId(relation.prerequisite_issue_id)
        && taskRelation.target_issue_id === parseTaskIssueId(relation.dependent_issue_id);
    });
  }

  #assertAvailable(): void {
    if (this.#retired) throw new Error("cycle_machine_retired");
    if (this.#inFlight !== null) throw new Error("cycle_machine_busy");
    if (this.#ready !== null) throw new Error("cycle_machine_action_pending");
  }

  #paused(
    code: BoundaryErrorCode,
    reason: string,
    correlationId: CorrelationId,
  ): CycleMachinePreparation {
    return Object.freeze({
      kind: "paused",
      error: boundaryError({
        schema_version: 1,
        code,
        root_id: this.#target.root_id,
        runtime_generation: this.#target.runtime_generation,
        correlation_id: correlationId,
        reason,
      }),
    });
  }
}
