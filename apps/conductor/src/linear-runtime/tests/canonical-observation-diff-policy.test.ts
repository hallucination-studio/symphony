import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFactInput } from "../api/CanonicalFact.js";
import type { CanonicalObservationBatch } from "../api/CanonicalObservationDiffPolicyInterface.js";
import { CanonicalObservationDiffPolicyImpl } from "../internal/CanonicalObservationDiffPolicyImpl.js";
import { CanonicalObservationPolicyImpl } from "../internal/CanonicalObservationPolicyImpl.js";

const canonical = new CanonicalObservationPolicyImpl();
const diff = new CanonicalObservationDiffPolicyImpl();
const provenance = { actorKind: "symphony" as const, observedAt: "2026-07-29T00:00:00.000Z" };

function issue(title: string): CanonicalFactInput {
  return {
    value: {
      kind: "linear_issue",
      issueId: "issue-1",
      identifier: "SYM-1",
      projectId: "project-1",
      statusId: "status-1",
      statusName: "Todo",
      statusCategory: "unstarted",
      statusPosition: 1,
      order: 0,
      depth: 0,
      title,
      description: "Outcome",
      labels: ["Symphony: Root"],
      isArchived: false,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    },
    provenance,
  };
}

function status(): CanonicalFactInput {
  return {
    value: { kind: "linear_status", statusId: "status-1", name: "Todo", category: "unstarted", position: 1 },
    provenance,
  };
}

test("content digest changes when the same identity and provenance has a different value", () => {
  const before = diff.seal(canonical.canonicalize([issue("Before")]));
  const after = diff.seal(canonical.canonicalize([issue("After")]));

  assert.notEqual(before.contentDigest, after.contentDigest);
  const batch = diff.calculate(before, after.observation, before.contentDigest);
  assert.equal(batch.changes.length, 1);
  assert.equal(batch.changes[0]?.kind, "replacement");
  assert.deepEqual(diff.applyBatch(before, batch), after);
});

test("initial, replacement, tombstone and empty batches are canonical and round-trip", () => {
  const initialObservation = canonical.canonicalize([issue("Before"), status()]);
  const initial = diff.seal(initialObservation);
  const initialBatch = diff.calculate(undefined, initialObservation);
  assert.deepEqual(initialBatch.changes.map(({ kind }) => kind), ["current_value", "current_value"]);
  assert.deepEqual(diff.applyBatch(undefined, initialBatch), initial);

  const targetObservation = canonical.canonicalize([issue("After")]);
  const target = diff.seal(targetObservation);
  const changed = diff.calculate(initial, targetObservation, initial.contentDigest);
  assert.deepEqual(changed.changes.map(({ kind }) => kind), ["replacement", "tombstone"]);
  assert.deepEqual(diff.applyBatch(initial, changed), target);

  const empty = diff.calculate(target, targetObservation, target.contentDigest);
  assert.deepEqual(empty.changes, []);
  assert.deepEqual(diff.applyBatch(target, empty), target);
});

test("diff and apply fail closed on base mismatch, duplicate changes and invalid tombstones", () => {
  const base = diff.seal(canonical.canonicalize([issue("Before")]));
  const target = canonical.canonicalize([]);
  const valid = diff.calculate(base, target, base.contentDigest);

  assert.throws(() => diff.calculate(base, target, "sha256:wrong"), /canonical_observation_base_mismatch/u);
  assert.throws(
    () => diff.applyBatch(base, { ...valid, baseDigest: "sha256:wrong" }),
    /canonical_observation_base_mismatch/u,
  );
  assert.throws(
    () => diff.applyBatch(base, { ...valid, changes: [valid.changes[0]!, valid.changes[0]!] }),
    /canonical_observation_change_duplicate:linear_issue:issue-1/u,
  );
  const invalidTombstone: CanonicalObservationBatch = {
    ...valid,
    changes: [{
      kind: "tombstone",
      identity: { sourceKind: "linear_issue", sourceId: "missing" },
      removesContentDigest: valid.changes[0]?.kind === "tombstone" ? valid.changes[0].removesContentDigest : "sha256:missing",
    }],
  };
  assert.throws(() => diff.applyBatch(base, invalidTombstone), /canonical_observation_tombstone_missing:linear_issue:missing/u);
});
