import assert from "node:assert/strict";
import test from "node:test";

import { conductorCycleDelayMs } from "./ConductorCycleDelayPolicy.js";

test("cycle delay is bounded, jittered, and immediate after progress", () => {
  assert.equal(conductorCycleDelayMs({ disposition: "progress", baseDelayMs: 1_000, random: () => 1 }), 0);
  assert.equal(conductorCycleDelayMs({ disposition: "waiting-human", baseDelayMs: 1_000, random: () => 0 }), 15_000);
  assert.equal(conductorCycleDelayMs({ disposition: "waiting-human", baseDelayMs: 1_000, random: () => 1 }), 18_000);
  assert.equal(conductorCycleDelayMs({ disposition: "empty", baseDelayMs: 1_000, random: () => 0 }), 60_000);
  assert.equal(conductorCycleDelayMs({ disposition: "needs-attention", baseDelayMs: 1_000, random: () => 1 }), 72_000);
});
