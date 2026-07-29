import type { CanonicalObservationBatch, CanonicalObservationState } from "./CanonicalObservationDiffPolicyInterface.js";
import type { CanonicalFactIdentity } from "./CanonicalFact.js";
import type { RootStateRecoveryFailure } from "./RootStateRecoveryInterface.js";

export type LinearRootRuntimeLifecycle = "recovering" | "ready" | "recovery_required" | "stopped";
export type LinearRootRuntimeWakeHint = "poll" | "webhook" | "process";

export interface LinearRootRuntimeFailure {
  code: string;
  category: RootStateRecoveryFailure["category"] | "runtime";
  retryable: boolean;
}

export type NativeEffectObservationOutcome =
  | { kind: "applied"; targetIdentity: CanonicalFactIdentity; readBack: CanonicalObservationBatch }
  | { kind: "not_applied" }
  | { kind: "acceptance_unknown" | "precondition_failed" | "readback_mismatch" };

export type LinearRootRuntimeOutput =
  | { kind: "recovered"; state: CanonicalObservationState }
  | { kind: "changed"; batch: CanonicalObservationBatch }
  | { kind: "unchanged"; contentDigest: string }
  | { kind: "recovery_required"; failure: LinearRootRuntimeFailure };

export interface LinearRootRuntimeInterface {
  lifecycle(): LinearRootRuntimeLifecycle;
  current(): CanonicalObservationState | undefined;
  wake(hint: LinearRootRuntimeWakeHint): Promise<LinearRootRuntimeOutput>;
  observeMutation(outcome: NativeEffectObservationOutcome): Promise<LinearRootRuntimeOutput>;
  invalidateForReconnect(): void;
  stop(): void;
}
