import type { BoundaryErrorCode } from "../contracts/common-outcomes.js";
import {
  parseCycleIssueId,
  parseStageIssueId,
  parseTaskIssueId,
  parseTaskLabelId,
  parseTaskStateId,
  type CorrelationId,
  type CycleIssueId,
  type RootIssueId,
  type RuntimeGeneration,
  type StageIssueId,
  type TaskLabelId,
  type TaskRevision,
  type TaskStateId,
} from "../contracts/identity.js";
import {
  parseTaskObservationEvent,
  type TaskIssueSnapshot,
  type TaskObservationEvent,
} from "../contracts/observation.js";
import type { CycleAdvanceResult } from "../contracts/cycle.js";
import type { RootTurnOutcome } from "../contracts/runtime.js";
import type { PreparedCycleAction } from "../cycle/internal/CycleMachine.js";
import { parseBoundedString } from "../contracts/validation.js";
import {
  parseTaskWorkflowIdentities,
  type TaskWorkflowIdentities,
} from "../task-management/api/TaskManageCapability.js";
import { routeFreshTask, type FreshRouteId } from "./FreshTaskRouter.js";
import type { RegisteredRootRuntime, RootRuntimeRegistry } from "./RootRuntimeRegistry.js";

type AdmissionParkReason =
  | "in_review"
  | "invalid_root_kind"
  | "not_delegated"
  | "runtime_stopped"
  | "status_not_executable";

type RuntimeFailureReason =
  | "cycle_boundary_failed"
  | "cycle_preparation_failed"
  | "root_home_cleanup_failed"
  | "runtime_preparation_failed"
  | "runtime_shutdown_failed"
  | "turn_boundary_failed";

const INTERNAL_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}(?::[a-z][a-z0-9_]{0,31})?$/u;

function deepestInternalCauseCode(error: unknown): string | undefined {
  let current = error;
  let code: string | undefined;
  const seen = new Set<Error>();
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    if (INTERNAL_ERROR_CODE.test(current.message)) code = current.message;
    current = current.cause;
  }
  return code;
}

export interface FamilyGuardInterface {
  isQuarantined(observation: TaskObservationEvent): Promise<boolean>;
  execute(observation: TaskObservationEvent): Promise<"family_invalidated" | "no_action">;
}

interface RootCleanupStageLog {
  readonly stage_id: StageIssueId;
  readonly revision: TaskRevision;
}

interface RootCleanupCycleLog {
  readonly cycle_id: CycleIssueId;
  readonly revision: TaskRevision;
  readonly stages: readonly RootCleanupStageLog[];
}

interface RootCleanupLogIdentity {
  readonly root_id: RootIssueId;
  readonly root_revision: TaskRevision;
  readonly runtime_generation: RuntimeGeneration | null;
  readonly correlation_id: CorrelationId;
  readonly cycles: readonly RootCleanupCycleLog[];
}

export type SerialConductorLog =
  | (RootCleanupLogIdentity & {
    readonly event: "root_cleanup_started" | "root_cleanup_completed";
    readonly reason_code: "root_done";
  })
  | (RootCleanupLogIdentity & {
    readonly event: "root_cleanup_failed";
    readonly reason_code: "root_home_cleanup_failed" | "runtime_shutdown_failed";
  })
  | {
    readonly event: "root_observation_buffered";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly replaced: boolean;
  }
  | {
    readonly event: "fresh_route_selected";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly selected_route: FreshRouteId;
    readonly consumer: "root_boundary" | "cycle_machine" | "family_guard" | "cleanup" | "park";
  }
  | {
    readonly event: "root_admission_parked";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly reason_code: AdmissionParkReason;
  }
  | {
    readonly event: "root_observation_paused";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly reason_code: BoundaryErrorCode;
  }
  | {
    readonly event: "root_observation_unchanged";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
  }
  | {
    readonly event: "root_observation_failed";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly reason_code: "runtime_preparation_failed";
    readonly cause_code?: string;
  }
  | {
    readonly event: "root_turn_started";
    readonly root_id: RootIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
    readonly input_kind: "bootstrap" | "diff";
  }
  | {
    readonly event: "root_turn_completed";
    readonly root_id: RootIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
    readonly outcome: RootTurnOutcome["outcome"];
  }
  | {
    readonly event: "root_turn_failed";
    readonly root_id: RootIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
    readonly reason_code: "turn_boundary_failed";
    readonly cause_code?: string;
  }
  | {
    readonly event: "cycle_action_started";
    readonly root_id: RootIssueId;
    readonly cycle_id: CycleIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
  }
  | {
    readonly event: "cycle_action_completed";
    readonly root_id: RootIssueId;
    readonly cycle_id: CycleIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
    readonly outcome: CycleAdvanceResult["outcome"];
  }
  | {
    readonly event: "cycle_action_paused";
    readonly root_id: RootIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
    readonly reason_code: BoundaryErrorCode;
  }
  | {
    readonly event: "cycle_action_failed";
    readonly root_id: RootIssueId;
    readonly cycle_id: CycleIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
    readonly reason_code: "cycle_boundary_failed";
  }
  | {
    readonly event: "cycle_continuation_failed";
    readonly root_id: RootIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly reason_code: "cycle_preparation_failed";
  };

export type SerialRunResult =
  | { readonly kind: "idle" }
  | {
    readonly kind: "root_cleanup_completed";
    readonly root_id: RootIssueId;
  }
  | {
    readonly kind: "turn_completed";
    readonly root_id: RootIssueId;
    readonly outcome: RootTurnOutcome["outcome"];
  }
  | {
    readonly kind: "cycle_action_completed";
    readonly root_id: RootIssueId;
    readonly outcome: CycleAdvanceResult["outcome"];
  }
  | {
    readonly kind: "family_guard_completed";
    readonly root_id: RootIssueId;
    readonly outcome: "family_invalidated" | "no_action";
  }
  | {
    readonly kind: "paused";
    readonly root_id: RootIssueId;
    readonly reason_code: BoundaryErrorCode;
  }
  | {
    readonly kind: "failed";
    readonly root_id: RootIssueId;
    readonly reason_code: RuntimeFailureReason;
  };

export interface SerialConductorOptions {
  readonly agent_actor_id: string;
  readonly root_kind_label_id: string;
  readonly root_states: {
    readonly todo: string;
    readonly in_progress: string;
    readonly in_review: string;
    readonly done: string;
  };
  readonly workflow: unknown;
  readonly family_guard?: FamilyGuardInterface;
  readonly log: (entry: SerialConductorLog) => void;
}

function rootIssue(observation: TaskObservationEvent): TaskIssueSnapshot {
  const rootTaskId = parseTaskIssueId(observation.root_id);
  const issue = observation.task.issues.find(({ issue_id }) => issue_id === rootTaskId);
  if (issue === undefined) throw new Error("missing_root_identity");
  return issue;
}

function cleanupCycles(observation: TaskObservationEvent): readonly RootCleanupCycleLog[] {
  const rootTaskId = parseTaskIssueId(observation.root_id);
  return Object.freeze(observation.task.issues
    .filter(({ parent_id }) => parent_id === rootTaskId)
    .sort((left, right) => left.issue_id.localeCompare(right.issue_id))
    .map((cycle) => Object.freeze({
      cycle_id: parseCycleIssueId(cycle.issue_id),
      revision: cycle.revision,
      stages: Object.freeze(observation.task.issues
        .filter(({ parent_id }) => parent_id === cycle.issue_id)
        .sort((left, right) => left.issue_id.localeCompare(right.issue_id))
        .map((stage) => Object.freeze({
          stage_id: parseStageIssueId(stage.issue_id),
          revision: stage.revision,
        }))),
    })));
}

function admissionReason(
  observation: TaskObservationEvent,
  actorId: string,
  rootKindLabelId: TaskLabelId,
  rootStates: Readonly<{
    todo: TaskStateId;
    in_progress: TaskStateId;
    in_review: TaskStateId;
    done: TaskStateId;
  }>,
  stopped: boolean,
): AdmissionParkReason | null {
  if (stopped) return "runtime_stopped";
  const issue = rootIssue(observation);
  if (!issue.labels.includes(rootKindLabelId)) return "invalid_root_kind";
  if (issue.delegate_id !== actorId) return "not_delegated";
  if (issue.status === rootStates.in_review) return "in_review";
  if (issue.status !== rootStates.todo && issue.status !== rootStates.in_progress) {
    return "status_not_executable";
  }
  return null;
}

export class SerialConductor {
  readonly #actorId: string;
  readonly #rootKindLabelId: TaskLabelId;
  readonly #rootStates: Readonly<{
    todo: TaskStateId;
    in_progress: TaskStateId;
    in_review: TaskStateId;
    done: TaskStateId;
  }>;
  readonly #cycleContinuations = new Map<RootIssueId, RegisteredRootRuntime>();
  readonly #pending = new Map<RootIssueId, TaskObservationEvent>();
  readonly #stopped = new Set<RootIssueId>();
  readonly #workflow: TaskWorkflowIdentities;
  #busy = false;

  constructor(
    private readonly registry: RootRuntimeRegistry,
    private readonly options: SerialConductorOptions,
  ) {
    this.#actorId = parseBoundedString(options.agent_actor_id, "invalid_agent_actor_id", 256);
    this.#rootKindLabelId = parseTaskLabelId(options.root_kind_label_id);
    this.#rootStates = Object.freeze({
      todo: parseTaskStateId(options.root_states.todo),
      in_progress: parseTaskStateId(options.root_states.in_progress),
      in_review: parseTaskStateId(options.root_states.in_review),
      done: parseTaskStateId(options.root_states.done),
    });
    this.#workflow = parseTaskWorkflowIdentities(options.workflow);
    if (new Set(Object.values(this.#rootStates)).size !== Object.keys(this.#rootStates).length) {
      throw new Error("duplicate_root_state_identity");
    }
  }

  admit(inputs: readonly unknown[]): void {
    const observations = inputs.map(parseTaskObservationEvent);
    for (const observation of observations) {
      const replaced = this.#pending.has(observation.root_id);
      this.#pending.set(observation.root_id, observation);
      this.options.log(Object.freeze({
        event: "root_observation_buffered",
        root_id: observation.root_id,
        correlation_id: observation.correlation_id,
        replaced,
      }));
    }
  }

  async runNext(): Promise<SerialRunResult> {
    if (this.#busy) throw new Error("serial_conductor_busy");
    this.#busy = true;
    try {
      return await this.#runNext();
    } finally {
      this.#busy = false;
    }
  }

  async #runNext(): Promise<SerialRunResult> {
    const observations = [];
    for (const observation of this.#pending.values()) {
      const permanentQuarantine = await this.options.family_guard?.isQuarantined(observation) ?? false;
      observations.push({ observation, routing: routeFreshTask({
        task: observation.task,
        task_changes: observation.task_changes,
        task_change_origins: observation.task_change_origins,
        agent_actor_id: this.#actorId,
        root_states: this.#rootStates,
        workflow: this.#workflow,
        permanent_quarantine: permanentQuarantine,
      }) });
    }
    observations.sort((left, right) => left.routing.selected.priority - right.routing.selected.priority
      || left.observation.root_id.localeCompare(right.observation.root_id));

    if ((observations[0]?.routing.selected.priority ?? Number.POSITIVE_INFINITY) > 80) {
      const continuation = await this.#runCycleContinuation();
      if (continuation !== null) return continuation;
    }

    for (const { observation, routing } of observations) {
      if (this.#pending.get(observation.root_id) !== observation) continue;
      const selected = routing.selected;
      this.options.log(Object.freeze({
        event: "fresh_route_selected",
        root_id: observation.root_id,
        correlation_id: observation.correlation_id,
        selected_route: selected.route_id,
        consumer: selected.consumer,
      }));
      if (selected.consumer === "cleanup") {
        this.#pending.delete(observation.root_id);
        return this.#cleanupDoneRoot(observation, rootIssue(observation));
      }
      if (selected.consumer === "family_guard") {
        this.#pending.delete(observation.root_id);
        if (this.options.family_guard === undefined) {
          this.#stopped.add(observation.root_id);
          return Object.freeze({
            kind: "failed",
            root_id: observation.root_id,
            reason_code: "runtime_preparation_failed",
          });
        }
        const outcome = await this.options.family_guard.execute(observation);
        return Object.freeze({ kind: "family_guard_completed", root_id: observation.root_id, outcome });
      }
      const parkReason = admissionReason(
        observation,
        this.#actorId,
        this.#rootKindLabelId,
        this.#rootStates,
        this.#stopped.has(observation.root_id),
      );
      if (
        selected.consumer === "park"
        || parkReason === "runtime_stopped"
        || (selected.consumer === "root_boundary" && parkReason !== null)
      ) {
        this.#pending.delete(observation.root_id);
        this.options.log(Object.freeze({
          event: "root_admission_parked",
          root_id: observation.root_id,
          correlation_id: observation.correlation_id,
          reason_code: parkReason ?? "status_not_executable",
        }));
        continue;
      }

      this.#pending.delete(observation.root_id);
      let runtime;
      let attempt;
      try {
        runtime = await this.registry.getOrCreate(observation.root_id);
        attempt = await runtime.prepare(observation, selected);
      } catch (error) {
        this.#stopped.add(observation.root_id);
        const causeCode = deepestInternalCauseCode(error);
        this.options.log(Object.freeze({
          event: "root_observation_failed",
          root_id: observation.root_id,
          correlation_id: observation.correlation_id,
          reason_code: "runtime_preparation_failed",
          ...(causeCode === undefined ? {} : { cause_code: causeCode }),
        }));
        return Object.freeze({
          kind: "failed",
          root_id: observation.root_id,
          reason_code: "runtime_preparation_failed",
        });
      }

      if (attempt.kind === "paused") {
        this.options.log(Object.freeze({
          event: "root_observation_paused",
          root_id: observation.root_id,
          correlation_id: observation.correlation_id,
          reason_code: attempt.error.code,
        }));
        return Object.freeze({
          kind: "paused",
          root_id: observation.root_id,
          reason_code: attempt.error.code,
        });
      }
      if (attempt.kind === "unchanged") {
        this.options.log(Object.freeze({
          event: "root_observation_unchanged",
          root_id: observation.root_id,
          correlation_id: observation.correlation_id,
        }));
        continue;
      }
      if (attempt.kind === "cycle_action") return this.#runCycleAction(runtime, attempt);

      this.options.log(Object.freeze({
        event: "root_turn_started",
        root_id: observation.root_id,
        runtime_generation: runtime.target.runtime_generation,
        correlation_id: observation.correlation_id,
        input_kind: attempt.kind,
      }));
      let outcome: RootTurnOutcome;
      try {
        outcome = await runtime.run(attempt);
      } catch (error) {
        this.#stopped.add(observation.root_id);
        const causeCode = deepestInternalCauseCode(error);
        this.options.log(Object.freeze({
          event: "root_turn_failed",
          root_id: observation.root_id,
          runtime_generation: runtime.target.runtime_generation,
          correlation_id: observation.correlation_id,
          reason_code: "turn_boundary_failed",
          ...(causeCode === undefined ? {} : { cause_code: causeCode }),
        }));
        return Object.freeze({
          kind: "failed",
          root_id: observation.root_id,
          reason_code: "turn_boundary_failed",
        });
      }

      if (outcome.outcome === "quiescent" || outcome.outcome === "stopped") runtime.accept(attempt);
      if (outcome.outcome !== "quiescent") this.#stopped.add(observation.root_id);
      this.options.log(Object.freeze({
        event: "root_turn_completed",
        root_id: observation.root_id,
        runtime_generation: runtime.target.runtime_generation,
        correlation_id: observation.correlation_id,
        outcome: outcome.outcome,
      }));
      return Object.freeze({
        kind: "turn_completed",
        root_id: observation.root_id,
        outcome: outcome.outcome,
      });
    }
    const continuation = await this.#runCycleContinuation();
    if (continuation !== null) return continuation;
    return Object.freeze({ kind: "idle" });
  }

  async #cleanupDoneRoot(
    observation: TaskObservationEvent,
    issue: TaskIssueSnapshot,
  ): Promise<SerialRunResult> {
    const rootId = observation.root_id;
    this.#cycleContinuations.delete(rootId);
    this.#stopped.add(rootId);
    const identity = Object.freeze({
      root_id: rootId,
      root_revision: issue.revision,
      runtime_generation: this.registry.generation(rootId),
      correlation_id: observation.correlation_id,
      cycles: cleanupCycles(observation),
    });
    this.options.log(Object.freeze({
      event: "root_cleanup_started",
      ...identity,
      reason_code: "root_done",
    }));
    const result = await this.registry.retire(rootId);
    const completedIdentity = result.runtime_generation === identity.runtime_generation
      ? identity
      : Object.freeze({ ...identity, runtime_generation: result.runtime_generation });
    if (result.outcome === "failed") {
      this.options.log(Object.freeze({
        event: "root_cleanup_failed",
        ...completedIdentity,
        reason_code: result.reason_code,
      }));
      return Object.freeze({ kind: "failed", root_id: rootId, reason_code: result.reason_code });
    }
    this.options.log(Object.freeze({
      event: "root_cleanup_completed",
      ...completedIdentity,
      reason_code: "root_done",
    }));
    return Object.freeze({ kind: "root_cleanup_completed", root_id: rootId });
  }

  async #runCycleContinuation(): Promise<SerialRunResult | null> {
    const roots = [...this.#cycleContinuations]
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [rootId, runtime] of roots) {
      let preparation;
      try {
        preparation = await runtime.prepareCycleContinuation();
      } catch {
        this.#cycleContinuations.delete(rootId);
        this.#stopped.add(rootId);
        this.options.log(Object.freeze({
          event: "cycle_continuation_failed",
          root_id: rootId,
          runtime_generation: runtime.target.runtime_generation,
          reason_code: "cycle_preparation_failed",
        }));
        return Object.freeze({ kind: "failed", root_id: rootId, reason_code: "cycle_preparation_failed" });
      }
      if (preparation.kind === "root_available") {
        this.#cycleContinuations.delete(rootId);
        continue;
      }
      if (preparation.kind === "paused") {
        this.#cycleContinuations.delete(rootId);
        this.options.log(Object.freeze({
          event: "cycle_action_paused",
          root_id: rootId,
          runtime_generation: runtime.target.runtime_generation,
          correlation_id: preparation.error.correlation_id,
          reason_code: preparation.error.code,
        }));
        return Object.freeze({ kind: "paused", root_id: rootId, reason_code: preparation.error.code });
      }
      return this.#runCycleAction(runtime, preparation);
    }
    return null;
  }

  async #runCycleAction(
    runtime: RegisteredRootRuntime,
    prepared: PreparedCycleAction,
  ): Promise<SerialRunResult> {
    const { request } = prepared;
    this.options.log(Object.freeze({
      event: "cycle_action_started",
      root_id: request.root_id,
      cycle_id: request.cycle_id,
      runtime_generation: request.runtime_generation,
      correlation_id: request.correlation_id,
    }));
    let result: CycleAdvanceResult;
    try {
      result = await runtime.runCycle(prepared);
    } catch {
      this.#cycleContinuations.delete(runtime.target.root_id);
      this.#stopped.add(runtime.target.root_id);
      this.options.log(Object.freeze({
        event: "cycle_action_failed",
        root_id: runtime.target.root_id,
        cycle_id: request.cycle_id,
        runtime_generation: runtime.target.runtime_generation,
        correlation_id: request.correlation_id,
        reason_code: "cycle_boundary_failed",
      }));
      return Object.freeze({
        kind: "failed",
        root_id: runtime.target.root_id,
        reason_code: "cycle_boundary_failed",
      });
    }

    if (result.outcome === "advanced" || result.outcome === "precondition_failed") {
      this.#cycleContinuations.set(runtime.target.root_id, runtime);
    } else {
      this.#cycleContinuations.delete(runtime.target.root_id);
    }
    this.options.log(Object.freeze({
      event: "cycle_action_completed",
      root_id: result.root_id,
      cycle_id: result.cycle_id,
      runtime_generation: result.runtime_generation,
      correlation_id: result.correlation_id,
      outcome: result.outcome,
    }));
    return Object.freeze({
      kind: "cycle_action_completed",
      root_id: result.root_id,
      outcome: result.outcome,
    });
  }
}
