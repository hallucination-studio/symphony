import { createHash } from "node:crypto";

import type { CanonicalFact, CanonicalFactIdentity, CanonicalObservation } from "../api/CanonicalFact.js";
import type {
  CanonicalObservationBatch,
  CanonicalObservationChange,
  CanonicalObservationDiffPolicyInterface,
  CanonicalObservationState,
} from "../api/CanonicalObservationDiffPolicyInterface.js";
import type { CanonicalObservationPolicyInterface } from "../api/CanonicalObservationPolicyInterface.js";
import { CanonicalObservationPolicyImpl } from "./CanonicalObservationPolicyImpl.js";

export class CanonicalObservationDiffPolicyImpl implements CanonicalObservationDiffPolicyInterface {
  constructor(
    private readonly canonicalPolicy: CanonicalObservationPolicyInterface = new CanonicalObservationPolicyImpl(),
  ) {}

  seal(observation: CanonicalObservation): CanonicalObservationState {
    const canonical = this.canonicalPolicy.canonicalize(
      observation.facts.map(({ value, provenance }) => ({ value, provenance })),
    );
    return deepFreeze({
      contentDigest: digest(canonical),
      observation: canonical,
    });
  }

  calculate(
    base: CanonicalObservationState | undefined,
    target: CanonicalObservation,
    expectedBaseDigest?: string,
  ): CanonicalObservationBatch {
    const checkedBase = base === undefined ? undefined : this.checkedState(base);
    if (expectedBaseDigest !== undefined && checkedBase?.contentDigest !== expectedBaseDigest) {
      throw new Error("canonical_observation_base_mismatch");
    }
    const targetState = this.seal(target);
    const baseFacts = factMap(checkedBase?.observation);
    const targetFacts = factMap(targetState.observation);
    const identities = [...new Set([...baseFacts.keys(), ...targetFacts.keys()])].sort(compareCodePoints);
    const changes: CanonicalObservationChange[] = [];

    for (const key of identities) {
      const before = baseFacts.get(key);
      const after = targetFacts.get(key);
      if (before === undefined && after !== undefined) {
        changes.push({ kind: "current_value", fact: after });
      } else if (before !== undefined && after === undefined) {
        changes.push({
          kind: "tombstone",
          identity: before.identity,
          removesContentDigest: factDigest(before),
        });
      } else if (before !== undefined && after !== undefined && factDigest(before) !== factDigest(after)) {
        changes.push({
          kind: "replacement",
          replacesContentDigest: factDigest(before),
          fact: after,
        });
      }
    }
    return deepFreeze({
      baseDigest: checkedBase?.contentDigest ?? null,
      targetDigest: targetState.contentDigest,
      changes,
    });
  }

  applyBatch(
    base: CanonicalObservationState | undefined,
    batch: CanonicalObservationBatch,
  ): CanonicalObservationState {
    const checkedBase = base === undefined ? undefined : this.checkedState(base);
    if ((checkedBase?.contentDigest ?? null) !== batch.baseDigest) {
      throw new Error("canonical_observation_base_mismatch");
    }
    const facts = factMap(checkedBase?.observation);
    const seen = new Set<string>();
    for (const change of batch.changes) {
      const identity = change.kind === "tombstone" ? change.identity : change.fact.identity;
      const key = identityKey(identity);
      if (seen.has(key)) throw new Error(`canonical_observation_change_duplicate:${key}`);
      seen.add(key);
      const current = facts.get(key);

      switch (change.kind) {
        case "current_value":
          if (current !== undefined) throw new Error(`canonical_observation_current_value_exists:${key}`);
          facts.set(key, change.fact);
          break;
        case "replacement":
          if (current === undefined) throw new Error(`canonical_observation_replacement_missing:${key}`);
          if (factDigest(current) !== change.replacesContentDigest) {
            throw new Error(`canonical_observation_replacement_mismatch:${key}`);
          }
          facts.set(key, change.fact);
          break;
        case "tombstone":
          if (current === undefined) throw new Error(`canonical_observation_tombstone_missing:${key}`);
          if (factDigest(current) !== change.removesContentDigest) {
            throw new Error(`canonical_observation_tombstone_mismatch:${key}`);
          }
          facts.delete(key);
          break;
      }
    }
    const state = this.seal({ facts: [...facts.values()] });
    if (state.contentDigest !== batch.targetDigest) {
      throw new Error("canonical_observation_target_mismatch");
    }
    return state;
  }

  private checkedState(state: CanonicalObservationState): CanonicalObservationState {
    const sealed = this.seal(state.observation);
    if (sealed.contentDigest !== state.contentDigest) {
      throw new Error("canonical_observation_state_digest_mismatch");
    }
    return sealed;
  }
}

function factMap(observation: CanonicalObservation | undefined): Map<string, CanonicalFact> {
  return new Map((observation?.facts ?? []).map((fact) => [identityKey(fact.identity), fact]));
}

function identityKey(identity: CanonicalFactIdentity): string {
  return `${identity.sourceKind}:${identity.sourceId}`;
}

function factDigest(fact: CanonicalFact): string {
  return digest(fact);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0)!);
  const rightPoints = [...right].map((value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
