import { parseRootIssueId, type RootIssueId } from "../contracts/identity.js";
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

export class RootRuntimeRegistry {
  readonly #cycles = new Set<CycleMachineHostInterface>();
  readonly #creating = new Map<RootIssueId, Promise<RegisteredRootRuntime>>();
  readonly #runtimes = new Map<RootIssueId, RegisteredRootRuntime>();
  readonly #turns = new Set<RootReconcillInterface>();

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
    const turnAliased = this.#turns.has(binding.turn);
    const cycleAliased = this.#cycles.has(binding.cycle);
    if (turnAliased || cycleAliased) {
      if (!cycleAliased) {
        try { binding.cycle.retire(); } catch { /* Preserve the alias failure. */ }
      }
      if (!turnAliased) {
        try { await binding.turn.close(); } catch { /* Preserve the alias failure. */ }
      }
      throw new Error("root_runtime_resource_alias");
    }

    let runtime: RootRuntime;
    try {
      runtime = new RootRuntime(binding);
      if (parseRootIssueId(runtime.target.root_id) !== rootId) {
        throw new Error("root_runtime_identity_mismatch");
      }
    } catch (error) {
      try {
        binding.cycle.retire();
      } catch {
        // Preserve the sanitized validation failure over private cleanup details.
      }
      try {
        await binding.turn.close();
      } catch {
        // Preserve the sanitized validation failure over private cleanup details.
      }
      throw error;
    }
    this.#cycles.add(binding.cycle);
    this.#turns.add(binding.turn);
    this.#runtimes.set(rootId, runtime);
    return runtime;
  }
}
