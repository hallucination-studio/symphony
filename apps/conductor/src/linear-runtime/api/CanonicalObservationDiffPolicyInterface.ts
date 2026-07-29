import type { CanonicalFact, CanonicalFactIdentity, CanonicalObservation } from "./CanonicalFact.js";

export interface CanonicalObservationState {
  contentDigest: string;
  observation: CanonicalObservation;
}

export type CanonicalObservationChange =
  | {
      kind: "current_value";
      fact: CanonicalFact;
    }
  | {
      kind: "replacement";
      replacesContentDigest: string;
      fact: CanonicalFact;
    }
  | {
      kind: "tombstone";
      identity: CanonicalFactIdentity;
      removesContentDigest: string;
    };

export interface CanonicalObservationBatch {
  baseDigest: string | null;
  targetDigest: string;
  changes: readonly CanonicalObservationChange[];
}

export interface CanonicalObservationDiffPolicyInterface {
  seal(observation: CanonicalObservation): CanonicalObservationState;
  calculate(
    base: CanonicalObservationState | undefined,
    target: CanonicalObservation,
    expectedBaseDigest?: string,
  ): CanonicalObservationBatch;
  applyBatch(
    base: CanonicalObservationState | undefined,
    batch: CanonicalObservationBatch,
  ): CanonicalObservationState;
}
