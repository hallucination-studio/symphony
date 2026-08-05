import assert from "node:assert/strict";
import test from "node:test";

import {
  CYCLE_IDENTITY_DERIVATION_VERSION,
  deriveCycleAnchorIds,
  deriveCycleUuid,
  deriveFirstCycleIssueId,
  FIRST_CYCLE_PREDECESSOR,
} from "./cycle-identities.js";

test("cycle identities are stable UUIDv4 values with length-safe domain separation", () => {
  const first = deriveCycleUuid("symphony-identity:v1", "plan", "cycle:1");
  assert.equal(first, deriveCycleUuid("symphony-identity:v1", "plan", "cycle:1"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(first, deriveCycleUuid("symphony-identity:v1", "work", "cycle:1"));
  assert.notEqual(
    deriveCycleUuid("symphony-identity:v1", "kind", "ab", "c"),
    deriveCycleUuid("symphony-identity:v1", "kind", "a", "bc"),
  );
  assert.notEqual(first, deriveCycleUuid("symphony-identity:v2", "plan", "cycle:1"));
});

test("cycle identity derivation rejects empty, oversized, and malformed inputs", () => {
  assert.throws(() => deriveCycleUuid("", "plan", "cycle:1"), /invalid_identity_derivation_part/u);
  assert.throws(() => deriveCycleUuid("symphony-identity:v1", "", "cycle:1"), /invalid_identity_derivation_part/u);
  assert.throws(
    () => deriveCycleUuid("symphony-identity:v1", "plan", "x".repeat(1_025)),
    /invalid_identity_derivation_part/u,
  );
  assert.throws(
    () => deriveCycleUuid("symphony-identity:v1", "plan", "cycle\0one"),
    /invalid_identity_derivation_part/u,
  );
});

test("cycle identity helpers expose one deterministic first-cycle anchor contract", () => {
  const cycleId = deriveFirstCycleIssueId("ROOT-1");
  const anchors = deriveCycleAnchorIds(CYCLE_IDENTITY_DERIVATION_VERSION, cycleId);
  assert.equal(
    cycleId,
    deriveCycleUuid(
      CYCLE_IDENTITY_DERIVATION_VERSION,
      "cycle_issue",
      "ROOT-1",
      FIRST_CYCLE_PREDECESSOR,
      FIRST_CYCLE_PREDECESSOR,
    ),
  );
  assert.equal(
    anchors.approval_record_id,
    deriveCycleUuid(CYCLE_IDENTITY_DERIVATION_VERSION, "cycle_approval_record", cycleId),
  );
  assert.equal(
    anchors.delivery_invalidation_record_id,
    deriveCycleUuid(CYCLE_IDENTITY_DERIVATION_VERSION, "delivery_invalidation_record", cycleId),
  );
  assert.equal(Object.isFrozen(anchors), true);
});
