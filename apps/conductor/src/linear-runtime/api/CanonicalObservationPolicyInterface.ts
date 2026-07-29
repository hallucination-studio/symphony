import type { CanonicalFactInput, CanonicalObservation } from "./CanonicalFact.js";

export interface CanonicalObservationPolicyInterface {
  canonicalize(inputs: readonly CanonicalFactInput[]): CanonicalObservation;
}
