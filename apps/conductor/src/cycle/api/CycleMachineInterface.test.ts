import assert from "node:assert/strict";
import test from "node:test";

import type { CycleAdvanceResult } from "../../contracts/cycle.js";
import type { CycleMachineInterface } from "./CycleMachineInterface.js";

test("Cycle machine public boundary exposes only one closed advance operation", () => {
  const machine = {
    advance: (): Promise<CycleAdvanceResult> => Promise.reject(new Error("inert_fixture")),
  } satisfies CycleMachineInterface;

  assert.deepEqual(Object.keys(machine), ["advance"]);
});
