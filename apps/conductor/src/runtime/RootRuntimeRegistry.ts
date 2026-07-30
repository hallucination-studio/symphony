import {
  parseRootIssueId,
  parseRuntimeGeneration,
  type RootIssueId,
} from "../contracts/identity.js";
import type { RootBootstrap, RootFactDiff } from "../contracts/observation.js";
import { parseRootTurnOutcome, type RootTurnOutcome, type RuntimeTarget } from "../contracts/runtime.js";
import type { GitWorkspaceInterface, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import {
  AcceptedRootObservation,
  type PreparedRootObservation,
  type RootObservationAttempt,
} from "../observation/AcceptedRootObservation.js";

export type RootTurnInput = RootBootstrap | RootFactDiff;

export interface RootTurnBoundary {
  run(input: RootTurnInput): Promise<unknown>;
}

export interface RootRuntimeBinding {
  readonly target: RuntimeTarget;
  readonly workspace: RootWorkspaceIdentity;
  readonly git: Pick<GitWorkspaceInterface, "read">;
  readonly turn: RootTurnBoundary;
}

export interface RootRuntimeFactory {
  create(rootId: RootIssueId): Promise<RootRuntimeBinding>;
}

export interface RegisteredRootRuntime {
  readonly target: RuntimeTarget;
  readonly workspace: RootWorkspaceIdentity;
  prepare(taskInput: unknown): Promise<RootObservationAttempt>;
  run(prepared: PreparedRootObservation): Promise<RootTurnOutcome>;
  accept(prepared: PreparedRootObservation): void;
}

class BoundRootRuntime implements RegisteredRootRuntime {
  readonly #observations: AcceptedRootObservation;

  constructor(private readonly binding: RootRuntimeBinding) {
    this.#observations = new AcceptedRootObservation(binding.target, binding.git);
  }

  get target(): RuntimeTarget { return this.binding.target; }
  get workspace(): RootWorkspaceIdentity { return this.binding.workspace; }

  prepare(taskInput: unknown): Promise<RootObservationAttempt> {
    return this.#observations.prepare(taskInput, this.workspace);
  }

  async run(prepared: PreparedRootObservation): Promise<RootTurnOutcome> {
    const outcome = parseRootTurnOutcome(
      await this.binding.turn.run(prepared.root_input),
      this.target,
    );
    if (outcome.correlation_id !== prepared.root_input.correlation_id) {
      throw new Error("turn_correlation_mismatch");
    }
    return outcome;
  }

  accept(prepared: PreparedRootObservation): void {
    this.#observations.accept(prepared);
  }
}

export class RootRuntimeRegistry {
  readonly #creating = new Map<RootIssueId, Promise<RegisteredRootRuntime>>();
  readonly #runtimes = new Map<RootIssueId, RegisteredRootRuntime>();
  readonly #turns = new Set<RootTurnBoundary>();

  constructor(private readonly factory: RootRuntimeFactory) {}

  get size(): number { return this.#runtimes.size; }

  has(rootId: RootIssueId): boolean { return this.#runtimes.has(rootId); }

  async getOrCreate(rootId: RootIssueId): Promise<RegisteredRootRuntime> {
    const normalizedRootId = parseRootIssueId(rootId);
    const existing = this.#runtimes.get(normalizedRootId);
    if (existing !== undefined) return existing;
    const pending = this.#creating.get(normalizedRootId);
    if (pending !== undefined) return pending;

    const creation = this.#create(normalizedRootId);
    this.#creating.set(normalizedRootId, creation);
    try {
      return await creation;
    } finally {
      if (this.#creating.get(normalizedRootId) === creation) this.#creating.delete(normalizedRootId);
    }
  }

  async #create(rootId: RootIssueId): Promise<RegisteredRootRuntime> {
    const binding = await this.factory.create(rootId);
    const targetRootId = parseRootIssueId(binding.target.root_id);
    parseRuntimeGeneration(binding.target.runtime_generation);
    const workspaceRootId = parseRootIssueId(binding.workspace.root_id);
    if (targetRootId !== rootId || workspaceRootId !== rootId) {
      throw new Error("root_runtime_identity_mismatch");
    }
    if (this.#turns.has(binding.turn)) throw new Error("root_runtime_resource_alias");

    const runtime = new BoundRootRuntime(binding);
    this.#turns.add(binding.turn);
    this.#runtimes.set(rootId, runtime);
    return runtime;
  }
}
