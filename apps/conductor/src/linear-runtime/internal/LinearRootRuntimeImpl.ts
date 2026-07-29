import type { CanonicalObservationDiffPolicyInterface, CanonicalObservationState } from "../api/CanonicalObservationDiffPolicyInterface.js";
import type {
  LinearRootRuntimeFailure,
  LinearRootRuntimeInterface,
  LinearRootRuntimeLifecycle,
  LinearRootRuntimeOutput,
  LinearRootRuntimeWakeHint,
  NativeEffectObservationOutcome,
} from "../api/LinearRootRuntimeInterface.js";
import type { RootStateRecoveryInterface } from "../api/RootStateRecoveryInterface.js";
import { CanonicalObservationDiffPolicyImpl } from "./CanonicalObservationDiffPolicyImpl.js";

export class LinearRootRuntimeImpl implements LinearRootRuntimeInterface {
  private lifecycleState: LinearRootRuntimeLifecycle = "recovery_required";
  private currentState: CanonicalObservationState | undefined;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    rootIssueId: string;
    recovery: RootStateRecoveryInterface;
    notifyConvergence(output: Extract<LinearRootRuntimeOutput, { kind: "recovered" | "changed" }>): void | Promise<void>;
    diffPolicy?: CanonicalObservationDiffPolicyInterface;
  }) {}

  lifecycle(): LinearRootRuntimeLifecycle {
    return this.lifecycleState;
  }

  current(): CanonicalObservationState | undefined {
    return this.currentState;
  }

  wake(hint: LinearRootRuntimeWakeHint): Promise<LinearRootRuntimeOutput> {
    void hint;
    return this.enqueue(() => this.refresh());
  }

  observeMutation(outcome: NativeEffectObservationOutcome): Promise<LinearRootRuntimeOutput> {
    return this.enqueue(() => this.acceptMutationOutcome(outcome));
  }

  invalidateForReconnect(): void {
    if (this.lifecycleState === "stopped") return;
    this.generation += 1;
    this.currentState = undefined;
    this.lifecycleState = "recovery_required";
  }

  stop(): void {
    this.generation += 1;
    this.currentState = undefined;
    this.lifecycleState = "stopped";
  }

  private enqueue(operation: () => Promise<LinearRootRuntimeOutput>): Promise<LinearRootRuntimeOutput> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async refresh(): Promise<LinearRootRuntimeOutput> {
    if (this.lifecycleState === "stopped") return recoveryRequired("root_runtime_stopped", false);
    const generation = this.generation;
    this.lifecycleState = "recovering";

    let recovered;
    try {
      recovered = await this.options.recovery.recover(this.options.rootIssueId);
    } catch {
      if (generation !== this.generation) return this.invalidatedOutput();
      return this.requireRecovery("root_runtime_recovery_failed", "runtime", true);
    }
    if (generation !== this.generation) return this.invalidatedOutput();
    if (recovered.kind === "failed") {
      return this.requireRecovery(
        recovered.failure.code,
        recovered.failure.category,
        recovered.failure.retryable,
      );
    }

    const diffPolicy = this.diffPolicy();
    let target: CanonicalObservationState;
    try {
      target = diffPolicy.seal(recovered.state.observation);
    } catch {
      return this.requireRecovery("root_runtime_state_invalid", "schema", false);
    }
    if (target.contentDigest !== recovered.state.contentDigest || recovered.state.rootIssueId !== this.options.rootIssueId) {
      return this.requireRecovery("root_runtime_state_invalid", "schema", false);
    }

    if (this.currentState === undefined) {
      this.currentState = target;
      this.lifecycleState = "ready";
      const output = deepFreeze({ kind: "recovered" as const, state: target });
      return this.notify(output, generation);
    }

    let batch;
    try {
      batch = diffPolicy.calculate(this.currentState, target.observation, this.currentState.contentDigest);
    } catch {
      return this.requireRecovery("root_runtime_diff_failed", "runtime", true);
    }
    if (batch.changes.length === 0) {
      this.lifecycleState = "ready";
      return deepFreeze({ kind: "unchanged", contentDigest: this.currentState.contentDigest });
    }

    let applied: CanonicalObservationState;
    try {
      applied = diffPolicy.applyBatch(this.currentState, batch);
    } catch {
      return this.requireRecovery("root_runtime_batch_apply_failed", "runtime", true);
    }
    if (applied.contentDigest !== target.contentDigest) {
      return this.requireRecovery("root_runtime_batch_target_mismatch", "runtime", true);
    }
    this.currentState = applied;
    this.lifecycleState = "ready";
    return this.notify(deepFreeze({ kind: "changed", batch }), generation);
  }

  private async acceptMutationOutcome(outcome: NativeEffectObservationOutcome): Promise<LinearRootRuntimeOutput> {
    if (this.lifecycleState === "stopped") return recoveryRequired("root_runtime_stopped", false);
    if (outcome.kind !== "applied") {
      if (outcome.kind === "not_applied" && this.currentState !== undefined && this.lifecycleState === "ready") {
        return deepFreeze({ kind: "unchanged", contentDigest: this.currentState.contentDigest });
      }
      return this.forceRecovery();
    }
    if (this.currentState === undefined || this.lifecycleState !== "ready") return this.forceRecovery();
    if (!isTargetedReadBack(outcome)) return this.forceRecovery();

    const base = this.currentState;
    const diffPolicy = this.diffPolicy();
    let applied: CanonicalObservationState;
    try {
      applied = diffPolicy.applyBatch(base, outcome.readBack);
    } catch {
      return this.forceRecovery();
    }
    if (outcome.readBack.changes.length === 0) {
      return deepFreeze({ kind: "unchanged", contentDigest: base.contentDigest });
    }

    let canonicalBatch;
    try {
      canonicalBatch = diffPolicy.calculate(base, applied.observation, base.contentDigest);
      applied = diffPolicy.applyBatch(base, canonicalBatch);
    } catch {
      return this.forceRecovery();
    }
    this.currentState = applied;
    this.lifecycleState = "ready";
    return this.notify(deepFreeze({ kind: "changed", batch: canonicalBatch }), this.generation);
  }

  private forceRecovery(): Promise<LinearRootRuntimeOutput> {
    this.currentState = undefined;
    this.lifecycleState = "recovery_required";
    return this.refresh();
  }

  private diffPolicy(): CanonicalObservationDiffPolicyInterface {
    return this.options.diffPolicy ?? new CanonicalObservationDiffPolicyImpl();
  }

  private async notify(
    output: Extract<LinearRootRuntimeOutput, { kind: "recovered" | "changed" }>,
    generation: number,
  ): Promise<LinearRootRuntimeOutput> {
    try {
      await this.options.notifyConvergence(output);
      if (generation !== this.generation) return this.invalidatedOutput();
      return output;
    } catch {
      if (generation !== this.generation) return this.invalidatedOutput();
      return this.requireRecovery("root_runtime_convergence_notify_failed", "runtime", true);
    }
  }

  private invalidatedOutput(): LinearRootRuntimeOutput {
    if (this.lifecycleState === "stopped") return recoveryRequired("root_runtime_stopped", false);
    return recoveryRequired("root_runtime_generation_invalidated", true);
  }

  private requireRecovery(
    code: string,
    category: LinearRootRuntimeFailure["category"],
    retryable: boolean,
  ): LinearRootRuntimeOutput {
    if (this.lifecycleState !== "stopped") this.lifecycleState = "recovery_required";
    this.currentState = undefined;
    return recoveryRequired(code, retryable, category);
  }
}

function isTargetedReadBack(outcome: Extract<NativeEffectObservationOutcome, { kind: "applied" }>): boolean {
  if (outcome.readBack.changes.length > 1) return false;
  const change = outcome.readBack.changes[0];
  if (change === undefined) return true;
  const identity = change.kind === "tombstone" ? change.identity : change.fact.identity;
  return identity.sourceKind === outcome.targetIdentity.sourceKind
    && identity.sourceId === outcome.targetIdentity.sourceId;
}

function recoveryRequired(
  code: string,
  retryable: boolean,
  category: LinearRootRuntimeFailure["category"] = "runtime",
): LinearRootRuntimeOutput {
  return deepFreeze({ kind: "recovery_required", failure: { code, category, retryable } });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
