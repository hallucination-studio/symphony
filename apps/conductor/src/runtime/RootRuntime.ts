import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
  type CorrelationId,
  type CycleIssueId,
  type RootIssueId,
  type RuntimeGeneration,
} from "../contracts/identity.js";
import type { CycleAdvanceResult } from "../contracts/cycle.js";
import { parseTaskObservationEvent } from "../contracts/observation.js";
import { parseRootTurnOutcome, type RootTurnOutcome, type RuntimeTarget } from "../contracts/runtime.js";
import type {
  CycleMachineHostInterface,
  CycleMachinePreparation,
  PreparedCycleAction,
} from "../cycle/internal/CycleMachine.js";
import { parseBoundedString } from "../contracts/validation.js";
import type { GitRootReadInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import {
  AcceptedRootObservation,
  type PreparedRootObservation,
  type RootObservationAttempt,
} from "../observation/AcceptedRootObservation.js";
import { taskSnapshotDigest } from "../observation/TaskFacts.js";
import type {
  RootReconcillInput,
  RootReconcillInterface,
} from "../root-reconcill/api/RootReconcillInterface.js";
import { boundaryError } from "../contracts/common-outcomes.js";
import type { FreshRouteConsumer, FreshRouteId, FreshRouteMatch } from "./FreshTaskRouter.js";
import type { RootBoundaryRouting } from "../contracts/observation.js";
import type { TaskSnapshot } from "../contracts/task-management.js";

export type RootTurnInput = RootReconcillInput;

export type DeliveryFinalizerRouteId = Extract<FreshRouteId, "WF-ROUTE-010" | "WF-ROUTE-012">;

export interface PreparedDeliveryFinalizer {
  readonly kind: "delivery_finalizer";
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly selected_route: DeliveryFinalizerRouteId;
  readonly cycle_id: CycleIssueId;
}

export type DeliveryFinalizerOutcome =
  | "delivery_completed"
  | "delivery_invalidated"
  | "root_projected"
  | "no_action"
  | "effect_unknown";

export interface DeliveryFinalizerResult {
  readonly kind: "delivery_finalizer_result";
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly selected_route: DeliveryFinalizerRouteId;
  readonly cycle_id: CycleIssueId;
  readonly outcome: DeliveryFinalizerOutcome;
  readonly reason_code?: string;
}

export interface DeliveryFinalizerHostInterface {
  prepare(input: Readonly<{
    readonly task: TaskSnapshot;
    readonly route: FreshRouteMatch;
    readonly correlation_id: CorrelationId;
    readonly runtime_generation: RuntimeGeneration;
  }>): Promise<PreparedDeliveryFinalizer>;
  run(prepared: PreparedDeliveryFinalizer): Promise<DeliveryFinalizerResult>;
}

export interface RootRuntimeBinding {
  readonly target: RuntimeTarget;
  readonly workspace: RootWorkspaceIdentity;
  readonly cycle: CycleMachineHostInterface;
  readonly git: GitRootReadInterface;
  readonly delivery_finalizer?: DeliveryFinalizerHostInterface;
  readonly turn: RootReconcillInterface;
}

export interface RootRuntimeFactory {
  create(rootId: RootIssueId): Promise<RootRuntimeBinding>;
}

export interface RegisteredRootRuntime {
  readonly target: RuntimeTarget;
  readonly workspace: RootWorkspaceIdentity;
  prepare(taskInput: unknown, selectedRoute?: FreshRouteMatch | FreshRouteConsumer | "auto"): Promise<RootRuntimePreparation>;
  prepareCycleContinuation(): Promise<CycleMachinePreparation>;
  prepareDeliveryFinalizer(
    task: TaskSnapshot,
    route: FreshRouteMatch,
    correlationId: CorrelationId,
  ): Promise<PreparedDeliveryFinalizer>;
  run(prepared: PreparedRootObservation): Promise<RootTurnOutcome>;
  runCycle(prepared: PreparedCycleAction): Promise<CycleAdvanceResult>;
  runDeliveryFinalizer(prepared: PreparedDeliveryFinalizer): Promise<DeliveryFinalizerResult>;
  accept(prepared: PreparedRootObservation): void;
  retire(): Promise<void>;
}

export type RootRuntimePreparation = RootObservationAttempt | PreparedCycleAction | PreparedDeliveryFinalizer;

function rootBoundaryRouting(selectedRoute: FreshRouteMatch | FreshRouteConsumer | "auto"): RootBoundaryRouting {
  if (typeof selectedRoute !== "object" || selectedRoute.consumer !== "root_boundary") {
    return Object.freeze({ disposition: "root_boundary", selected_route: "WF-ROUTE-001", active_cycle_id: null });
  }
  if (selectedRoute.route_id === "WF-ROUTE-001") {
    return Object.freeze({ disposition: "root_boundary", selected_route: selectedRoute.route_id, active_cycle_id: null });
  }
  if (selectedRoute.route_id === "WF-ROUTE-008") {
    if (selectedRoute.cycle_id === null) throw new Error("root_successor_predecessor_missing");
    return Object.freeze({
      disposition: "root_boundary",
      selected_route: selectedRoute.route_id,
      active_cycle_id: null,
      predecessor_cycle_id: parseCycleIssueId(selectedRoute.cycle_id),
    });
  }
  if (
    selectedRoute.route_id !== "WF-ROUTE-002"
    && selectedRoute.route_id !== "WF-ROUTE-005"
    && selectedRoute.route_id !== "WF-ROUTE-007"
  ) throw new Error("root_boundary_route_invalid");
  if (selectedRoute.cycle_id === null) throw new Error("root_active_cycle_missing");
  return Object.freeze({
    disposition: "root_boundary",
    selected_route: selectedRoute.route_id,
    active_cycle_id: parseCycleIssueId(selectedRoute.cycle_id),
  });
}

function selectedExternalTerminalCycleId(
  selectedRoute: FreshRouteMatch | FreshRouteConsumer | "auto",
): ReturnType<typeof parseCycleIssueId> | undefined {
  if (typeof selectedRoute !== "object" || selectedRoute.route_id !== "WF-ROUTE-018") return undefined;
  if (selectedRoute.cycle_id === null) throw new Error("external_terminal_cycle_missing");
  return parseCycleIssueId(selectedRoute.cycle_id);
}

function deliveryFinalizerRoute(route: FreshRouteMatch): Readonly<{
  readonly route_id: DeliveryFinalizerRouteId;
  readonly cycle_id: CycleIssueId;
}> {
  if (
    route.consumer !== "delivery_finalizer"
    || (route.route_id !== "WF-ROUTE-010" && route.route_id !== "WF-ROUTE-012")
    || route.cycle_id === null
  ) throw new Error("delivery_finalizer_route_invalid");
  return Object.freeze({
    route_id: route.route_id,
    cycle_id: parseCycleIssueId(route.cycle_id),
  });
}

function assertPreparedDeliveryFinalizer(
  prepared: PreparedDeliveryFinalizer,
  target: RuntimeTarget,
): void {
  if (
    prepared.kind !== "delivery_finalizer"
    || parseRootIssueId(prepared.root_id) !== target.root_id
    || parseRuntimeGeneration(prepared.runtime_generation) !== target.runtime_generation
    || parseCorrelationId(prepared.correlation_id) !== prepared.correlation_id
    || parseCycleIssueId(prepared.cycle_id) !== prepared.cycle_id
    || (prepared.selected_route !== "WF-ROUTE-010" && prepared.selected_route !== "WF-ROUTE-012")
  ) throw new Error("delivery_finalizer_preparation_invalid");
}

function assertDeliveryFinalizerResult(
  result: DeliveryFinalizerResult,
  prepared: PreparedDeliveryFinalizer,
): DeliveryFinalizerResult {
  if (
    result.kind !== "delivery_finalizer_result"
    || parseRootIssueId(result.root_id) !== prepared.root_id
    || parseRuntimeGeneration(result.runtime_generation) !== prepared.runtime_generation
    || parseCorrelationId(result.correlation_id) !== prepared.correlation_id
    || parseCycleIssueId(result.cycle_id) !== prepared.cycle_id
    || result.selected_route !== prepared.selected_route
    || ![
      "delivery_completed",
      "delivery_invalidated",
      "root_projected",
      "no_action",
      "effect_unknown",
    ].includes(result.outcome)
  ) throw new Error("delivery_finalizer_result_invalid");
  if (result.reason_code !== undefined) {
    parseBoundedString(result.reason_code, "invalid_delivery_finalizer_reason", 128);
  }
  return Object.freeze(result);
}

export class RootRuntime implements RegisteredRootRuntime {
  readonly #cycle: CycleMachineHostInterface;
  readonly #deliveryFinalizer: DeliveryFinalizerHostInterface | null;
  readonly #git: GitRootReadInterface;
  readonly #observations: AcceptedRootObservation;
  readonly #prepared = new WeakSet<PreparedRootObservation>();
  readonly #preparedDeliveryFinalizers = new WeakSet<PreparedDeliveryFinalizer>();
  readonly #started = new WeakSet<PreparedRootObservation>();
  readonly #startedDeliveryFinalizers = new WeakSet<PreparedDeliveryFinalizer>();
  readonly #outcomes = new WeakMap<PreparedRootObservation, RootTurnOutcome>();
  readonly #target: RuntimeTarget;
  readonly #turn: RootReconcillInterface;
  readonly #workspace: RootWorkspaceIdentity;
  #retirement: Promise<void> | null = null;

  constructor(binding: RootRuntimeBinding) {
    const target = Object.freeze({
      root_id: parseRootIssueId(binding.target.root_id),
      runtime_generation: parseRuntimeGeneration(binding.target.runtime_generation),
    });
    const workspace = Object.freeze({
      root_id: parseRootIssueId(binding.workspace.root_id),
      repository_id: parseRepositoryId(binding.workspace.repository_id),
      base_branch: parseBoundedString(binding.workspace.base_branch, "invalid_base_branch", 255),
      head_branch: parseBoundedString(binding.workspace.head_branch, "invalid_head_branch", 255),
    });
    if (
      workspace.root_id !== target.root_id
      || parseRootIssueId(binding.turn.rootId) !== target.root_id
      || parseRootIssueId(binding.cycle.target.root_id) !== target.root_id
    ) throw new Error("root_runtime_identity_mismatch");
    if (
      parseRuntimeGeneration(binding.turn.runtimeGeneration) !== target.runtime_generation
      || parseRuntimeGeneration(binding.cycle.target.runtime_generation) !== target.runtime_generation
    ) {
      throw new Error("root_runtime_generation_mismatch");
    }
    this.#target = target;
    this.#workspace = workspace;
    this.#git = binding.git;
    this.#cycle = binding.cycle;
    this.#deliveryFinalizer = binding.delivery_finalizer ?? null;
    this.#turn = binding.turn;
    this.#observations = new AcceptedRootObservation(this.#target, this.#git);
  }

  get target(): RuntimeTarget { return this.#target; }
  get workspace(): RootWorkspaceIdentity { return this.#workspace; }

  async prepare(
    taskInput: unknown,
    selectedRoute: FreshRouteMatch | FreshRouteConsumer | "auto" = "auto",
  ): Promise<RootRuntimePreparation> {
    let observation;
    try {
      observation = parseTaskObservationEvent(taskInput);
    } catch {
      return this.#observations.prepare(taskInput, this.#workspace);
    }
    if (
      observation.root_id !== this.#target.root_id
      || taskSnapshotDigest(observation.task) !== observation.to_task_digest
    ) return this.#observations.prepare(observation, this.#workspace);

    const selectedConsumer = typeof selectedRoute === "object" ? selectedRoute.consumer : selectedRoute;
    if (selectedConsumer === "delivery_finalizer") {
      if (typeof selectedRoute !== "object") throw new Error("delivery_finalizer_route_required");
      return this.prepareDeliveryFinalizer(
        observation.task,
        selectedRoute,
        observation.correlation_id,
      );
    }
    if (selectedConsumer === "cycle_machine") {
      const cycle = await this.#cycle.prepare(
        observation.task,
        observation.correlation_id,
        null,
        typeof selectedRoute === "object" && selectedRoute.route_id === "WF-ROUTE-015"
          ? "admission_lost"
          : undefined,
        selectedExternalTerminalCycleId(selectedRoute),
      );
      if (cycle.kind !== "root_available") return cycle;
      return Object.freeze({
        kind: "paused",
        error: boundaryError({
          schema_version: 1,
          code: "readback_mismatch",
          root_id: this.#target.root_id,
          runtime_generation: this.#target.runtime_generation,
          correlation_id: observation.correlation_id,
          reason: "selected_cycle_route_not_actionable",
        }),
      });
    }
    if (selectedConsumer === "auto") {
      const cycle = await this.#cycle.prepare(
        observation.task,
        observation.correlation_id,
        null,
      );
      if (cycle.kind !== "root_available") return cycle;
    }
    const attempt = selectedConsumer === "root_boundary"
      ? await this.#observations.prepareFresh(taskInput, this.#workspace, rootBoundaryRouting(selectedRoute))
      : await this.#observations.prepare(taskInput, this.#workspace);
    if (attempt.kind === "bootstrap" || attempt.kind === "diff" || attempt.kind === "semantic_snapshot") {
      this.#prepared.add(attempt);
    }
    return attempt;
  }

  async prepareDeliveryFinalizer(
    task: TaskSnapshot,
    route: FreshRouteMatch,
    correlationId: CorrelationId,
  ): Promise<PreparedDeliveryFinalizer> {
    const finalizer = this.#deliveryFinalizer;
    if (finalizer === null) throw new Error("delivery_finalizer_unavailable");
    if (task.root_id !== this.#target.root_id) throw new Error("delivery_finalizer_root_mismatch");
    const selected = deliveryFinalizerRoute(route);
    const prepared = await finalizer.prepare(Object.freeze({
      task,
      route,
      correlation_id: parseCorrelationId(correlationId),
      runtime_generation: this.#target.runtime_generation,
    }));
    assertPreparedDeliveryFinalizer(prepared, this.#target);
    if (
      prepared.selected_route !== selected.route_id
      || prepared.cycle_id !== selected.cycle_id
      || prepared.correlation_id !== correlationId
    ) throw new Error("delivery_finalizer_preparation_mismatch");
    this.#preparedDeliveryFinalizers.add(prepared);
    return prepared;
  }

  prepareCycleContinuation(): Promise<CycleMachinePreparation> {
    return this.#cycle.prepareContinuation();
  }

  runCycle(prepared: PreparedCycleAction): Promise<CycleAdvanceResult> {
    return this.#cycle.run(prepared);
  }

  async runDeliveryFinalizer(prepared: PreparedDeliveryFinalizer): Promise<DeliveryFinalizerResult> {
    if (!this.#preparedDeliveryFinalizers.has(prepared)) {
      throw new Error("invalid_delivery_finalizer_candidate");
    }
    if (this.#startedDeliveryFinalizers.has(prepared)) {
      throw new Error("delivery_finalizer_already_started");
    }
    assertPreparedDeliveryFinalizer(prepared, this.#target);
    const finalizer = this.#deliveryFinalizer;
    if (finalizer === null) throw new Error("delivery_finalizer_unavailable");
    this.#startedDeliveryFinalizers.add(prepared);
    try {
      return assertDeliveryFinalizerResult(await finalizer.run(prepared), prepared);
    } finally {
      this.#preparedDeliveryFinalizers.delete(prepared);
    }
  }

  async run(prepared: PreparedRootObservation): Promise<RootTurnOutcome> {
    if (!this.#prepared.has(prepared)) throw new Error("invalid_root_observation_candidate");
    if (this.#started.has(prepared)) throw new Error("root_runtime_turn_already_started");
    this.#started.add(prepared);

    const outcome = parseRootTurnOutcome(
      await this.#turn.run(prepared.root_input),
      this.#target,
    );
    if (outcome.correlation_id !== prepared.root_input.correlation_id) {
      throw new Error("turn_correlation_mismatch");
    }
    this.#outcomes.set(prepared, outcome);
    return outcome;
  }

  accept(prepared: PreparedRootObservation): void {
    if (!this.#prepared.has(prepared)) throw new Error("invalid_root_observation_candidate");
    const outcome = this.#outcomes.get(prepared);
    if (outcome === undefined) throw new Error("root_runtime_turn_not_completed");
    if (outcome.outcome !== "quiescent" && outcome.outcome !== "stopped") {
      throw new Error("root_runtime_outcome_not_acceptable");
    }
    this.#observations.accept(prepared);
    this.#prepared.delete(prepared);
    this.#outcomes.delete(prepared);
  }

  retire(): Promise<void> {
    if (this.#retirement !== null) return this.#retirement;
    const retirements: Promise<void>[] = [];
    try {
      retirements.push(this.#cycle.retire());
    } catch {
      retirements.push(Promise.reject(new Error("root_runtime_retirement_failed")));
    }
    try {
      retirements.push(this.#turn.close());
    } catch {
      retirements.push(Promise.reject(new Error("root_runtime_retirement_failed")));
    }
    this.#retirement = Promise.allSettled(retirements).then((results) => {
      if (results.some(({ status }) => status === "rejected")) {
        throw new Error("root_runtime_retirement_failed");
      }
    });
    return this.#retirement;
  }
}
