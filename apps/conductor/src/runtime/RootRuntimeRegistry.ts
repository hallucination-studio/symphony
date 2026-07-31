import {
  parseRootIssueId,
  type RootIssueId,
  type RuntimeGeneration,
} from "../contracts/identity.js";
import type { RootReconcillInterface } from "../root-reconcill/api/RootReconcillInterface.js";
import type { CycleMachineHostInterface } from "../cycle/internal/CycleMachine.js";
import {
  RootRuntime,
  type RegisteredRootRuntime,
  type RootRuntimeFactory,
} from "./RootRuntime.js";

export type {
  RegisteredRootRuntime,
  RootRuntimeBinding,
  RootRuntimeFactory,
  RootTurnInput,
} from "./RootRuntime.js";

export interface RootRuntimeCleanup {
  delete(rootId: RootIssueId, isLive: (rootId: RootIssueId) => boolean): Promise<void>;
}

export type RootRuntimeRetirementResult =
  | {
    readonly outcome: "completed";
    readonly runtime_generation: RuntimeGeneration | null;
  }
  | {
    readonly outcome: "failed";
    readonly runtime_generation: RuntimeGeneration | null;
    readonly reason_code: "root_home_cleanup_failed" | "runtime_shutdown_failed";
  };

const NO_ROOT_HOME_CLEANUP: RootRuntimeCleanup = Object.freeze({
  delete: async () => undefined,
});

interface RuntimeResources {
  readonly cycle: CycleMachineHostInterface;
  readonly turn: RootReconcillInterface;
}

export class RootRuntimeRegistry {
  readonly #cycles = new Set<CycleMachineHostInterface>();
  readonly #creating = new Map<RootIssueId, Promise<RegisteredRootRuntime>>();
  readonly #resources = new Map<RootIssueId, RuntimeResources>();
  readonly #retiring = new Map<RootIssueId, Promise<RootRuntimeRetirementResult>>();
  readonly #runtimes = new Map<RootIssueId, RegisteredRootRuntime>();
  readonly #turns = new Set<RootReconcillInterface>();

  constructor(
    private readonly factory: RootRuntimeFactory,
    private readonly cleanup: RootRuntimeCleanup = NO_ROOT_HOME_CLEANUP,
  ) {}

  get size(): number { return this.#runtimes.size; }

  has(rootId: RootIssueId): boolean { return this.#runtimes.has(rootId); }

  generation(rootId: RootIssueId): RuntimeGeneration | null {
    return this.#runtimes.get(rootId)?.target.runtime_generation ?? null;
  }

  async getOrCreate(rootId: RootIssueId): Promise<RegisteredRootRuntime> {
    const normalizedRootId = parseRootIssueId(rootId);
    if (this.#retiring.has(normalizedRootId)) throw new Error("root_runtime_retiring");
    const existing = this.#runtimes.get(normalizedRootId);
    if (existing !== undefined) return existing;
    let creation = this.#creating.get(normalizedRootId);
    if (creation === undefined) {
      creation = this.#create(normalizedRootId);
      this.#creating.set(normalizedRootId, creation);
    }
    try {
      const runtime = await creation;
      if (this.#retiring.has(normalizedRootId)) throw new Error("root_runtime_retiring");
      return runtime;
    } finally {
      if (this.#creating.get(normalizedRootId) === creation) this.#creating.delete(normalizedRootId);
    }
  }

  async #create(rootId: RootIssueId): Promise<RegisteredRootRuntime> {
    const binding = await this.factory.create(rootId);
    const turnAliased = this.#turns.has(binding.turn);
    const cycleAliased = this.#cycles.has(binding.cycle);
    if (turnAliased || cycleAliased) {
      const cleanup: Promise<void>[] = [];
      if (!cycleAliased) cleanup.push(this.#begin(() => binding.cycle.retire()));
      if (!turnAliased) cleanup.push(this.#begin(() => binding.turn.close()));
      await Promise.allSettled(cleanup);
      throw new Error("root_runtime_resource_alias");
    }

    let runtime: RootRuntime;
    try {
      runtime = new RootRuntime(binding);
      if (parseRootIssueId(runtime.target.root_id) !== rootId) {
        throw new Error("root_runtime_identity_mismatch");
      }
    } catch (error) {
      await Promise.allSettled([
        this.#begin(() => binding.cycle.retire()),
        this.#begin(() => binding.turn.close()),
      ]);
      throw error;
    }
    this.#cycles.add(binding.cycle);
    this.#turns.add(binding.turn);
    this.#resources.set(rootId, Object.freeze({ cycle: binding.cycle, turn: binding.turn }));
    this.#runtimes.set(rootId, runtime);
    return runtime;
  }

  retire(rootId: RootIssueId): Promise<RootRuntimeRetirementResult> {
    const normalizedRootId = parseRootIssueId(rootId);
    const existing = this.#retiring.get(normalizedRootId);
    if (existing !== undefined) return existing;
    const retirement = this.#retire(normalizedRootId);
    this.#retiring.set(normalizedRootId, retirement);
    return retirement;
  }

  async #retire(rootId: RootIssueId): Promise<RootRuntimeRetirementResult> {
    const creating = this.#creating.get(rootId);
    if (creating !== undefined) await creating.catch(() => undefined);
    const runtime = this.#runtimes.get(rootId);
    const runtimeGeneration = runtime?.target.runtime_generation ?? null;
    if (runtime !== undefined) {
      try {
        await runtime.retire();
      } catch {
        return Object.freeze({
          outcome: "failed",
          runtime_generation: runtimeGeneration,
          reason_code: "runtime_shutdown_failed",
        });
      }
      if (this.#runtimes.get(rootId) === runtime) this.#runtimes.delete(rootId);
      const resources = this.#resources.get(rootId);
      if (resources !== undefined) {
        this.#cycles.delete(resources.cycle);
        this.#turns.delete(resources.turn);
        this.#resources.delete(rootId);
      }
    }
    try {
      await this.cleanup.delete(rootId, (candidate) => (
        this.#runtimes.has(candidate) || this.#creating.has(candidate)
      ));
    } catch {
      return Object.freeze({
        outcome: "failed",
        runtime_generation: runtimeGeneration,
        reason_code: "root_home_cleanup_failed",
      });
    }
    return Object.freeze({ outcome: "completed", runtime_generation: runtimeGeneration });
  }

  #begin(action: () => Promise<void>): Promise<void> {
    try {
      return action();
    } catch {
      return Promise.reject(new Error("root_runtime_cleanup_failed"));
    }
  }
}
