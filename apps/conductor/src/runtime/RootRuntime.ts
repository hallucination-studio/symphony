import {
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
  type RootIssueId,
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
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
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

export type RootTurnInput = RootReconcillInput;

export interface RootRuntimeBinding {
  readonly target: RuntimeTarget;
  readonly workspace: RootWorkspaceIdentity;
  readonly cycle: CycleMachineHostInterface;
  readonly git: Pick<GitWorkspaceInterface, "read">;
  readonly turn: RootReconcillInterface;
}

export interface RootRuntimeFactory {
  create(rootId: RootIssueId): Promise<RootRuntimeBinding>;
}

export interface RegisteredRootRuntime {
  readonly target: RuntimeTarget;
  readonly workspace: RootWorkspaceIdentity;
  prepare(taskInput: unknown): Promise<RootRuntimePreparation>;
  prepareCycleContinuation(): Promise<CycleMachinePreparation>;
  run(prepared: PreparedRootObservation): Promise<RootTurnOutcome>;
  runCycle(prepared: PreparedCycleAction): Promise<CycleAdvanceResult>;
  accept(prepared: PreparedRootObservation): void;
}

export type RootRuntimePreparation = RootObservationAttempt | PreparedCycleAction;

export class RootRuntime implements RegisteredRootRuntime {
  readonly #cycle: CycleMachineHostInterface;
  readonly #git: Pick<GitWorkspaceInterface, "read">;
  readonly #observations: AcceptedRootObservation;
  readonly #prepared = new WeakSet<PreparedRootObservation>();
  readonly #started = new WeakSet<PreparedRootObservation>();
  readonly #outcomes = new WeakMap<PreparedRootObservation, RootTurnOutcome>();
  readonly #target: RuntimeTarget;
  readonly #turn: RootReconcillInterface;
  readonly #workspace: RootWorkspaceIdentity;

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
    this.#turn = binding.turn;
    this.#observations = new AcceptedRootObservation(this.#target, this.#git);
  }

  get target(): RuntimeTarget { return this.#target; }
  get workspace(): RootWorkspaceIdentity { return this.#workspace; }

  async prepare(taskInput: unknown): Promise<RootRuntimePreparation> {
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

    const cycle = await this.#cycle.prepare(observation.task, observation.correlation_id);
    if (cycle.kind !== "root_available") return cycle;
    const attempt = await this.#observations.prepare(taskInput, this.#workspace);
    if (attempt.kind === "bootstrap" || attempt.kind === "diff") this.#prepared.add(attempt);
    return attempt;
  }

  prepareCycleContinuation(): Promise<CycleMachinePreparation> {
    return this.#cycle.prepareContinuation();
  }

  runCycle(prepared: PreparedCycleAction): Promise<CycleAdvanceResult> {
    return this.#cycle.run(prepared);
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
}
