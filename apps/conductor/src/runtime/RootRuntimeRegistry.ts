import {
  parseCycleIssueId,
  parseRootIssueId,
  type RootIssueId,
  type CycleIssueId,
  type RuntimeGeneration,
} from "../contracts/identity.js";
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
  delete(
    rootId: RootIssueId,
    cycleIds: readonly CycleIssueId[],
    isLive: (rootId: RootIssueId) => boolean,
  ): Promise<void>;
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

export class RootRuntimeRegistry {
  readonly #boundRootId: RootIssueId;
  #creating: Promise<RegisteredRootRuntime> | null = null;
  #retirement: Promise<RootRuntimeRetirementResult> | null = null;
  #runtime: RegisteredRootRuntime | null = null;

  constructor(
    boundRootId: RootIssueId,
    private readonly factory: RootRuntimeFactory,
    private readonly cleanup: RootRuntimeCleanup = NO_ROOT_HOME_CLEANUP,
  ) {
    this.#boundRootId = parseRootIssueId(boundRootId);
  }

  get size(): number { return this.#runtime === null ? 0 : 1; }

  has(rootId: RootIssueId): boolean {
    return parseRootIssueId(rootId) === this.#boundRootId && this.#runtime !== null;
  }

  generation(rootId: RootIssueId): RuntimeGeneration | null {
    return parseRootIssueId(rootId) === this.#boundRootId
      ? this.#runtime?.target.runtime_generation ?? null
      : null;
  }

  async getOrCreate(rootId: RootIssueId): Promise<RegisteredRootRuntime> {
    const normalizedRootId = this.#assertBoundRoot(rootId);
    if (this.#retirement !== null) throw new Error("root_runtime_retiring");
    const existing = this.#runtime;
    if (existing !== null) return existing;
    let creation = this.#creating;
    if (creation === null) {
      creation = this.#create(normalizedRootId);
      this.#creating = creation;
    }
    try {
      const runtime = await creation;
      if (this.#retirement !== null) throw new Error("root_runtime_retiring");
      return runtime;
    } finally {
      if (this.#creating === creation) this.#creating = null;
    }
  }

  async #create(rootId: RootIssueId): Promise<RegisteredRootRuntime> {
    const binding = await this.factory.create(rootId);
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
    this.#runtime = runtime;
    return runtime;
  }

  retire(
    rootId: RootIssueId,
    cycleIds: readonly CycleIssueId[] = [],
  ): Promise<RootRuntimeRetirementResult> {
    const normalizedRootId = this.#assertBoundRoot(rootId);
    const normalizedCycleIds = Object.freeze(cycleIds.map(parseCycleIssueId));
    const existing = this.#retirement;
    if (existing !== null) return existing;
    const retirement = this.#retire(normalizedRootId, normalizedCycleIds);
    this.#retirement = retirement;
    return retirement;
  }

  async #retire(
    rootId: RootIssueId,
    cycleIds: readonly CycleIssueId[],
  ): Promise<RootRuntimeRetirementResult> {
    const creating = this.#creating;
    if (creating !== null) await creating.catch(() => undefined);
    const runtime = this.#runtime;
    const runtimeGeneration = runtime?.target.runtime_generation ?? null;
    if (runtime !== null) {
      try {
        await runtime.retire();
      } catch {
        return Object.freeze({
          outcome: "failed",
          runtime_generation: runtimeGeneration,
          reason_code: "runtime_shutdown_failed",
        });
      }
      if (this.#runtime === runtime) this.#runtime = null;
    }
    try {
      await this.cleanup.delete(rootId, cycleIds, (candidate) => (
        parseRootIssueId(candidate) === this.#boundRootId
        && (this.#runtime !== null || this.#creating !== null)
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

  #assertBoundRoot(rootId: RootIssueId): RootIssueId {
    const normalizedRootId = parseRootIssueId(rootId);
    if (normalizedRootId !== this.#boundRootId) throw new Error("bound_root_identity_mismatch");
    return normalizedRootId;
  }

  #begin(action: () => Promise<void>): Promise<void> {
    try {
      return action();
    } catch {
      return Promise.reject(new Error("root_runtime_cleanup_failed"));
    }
  }
}
