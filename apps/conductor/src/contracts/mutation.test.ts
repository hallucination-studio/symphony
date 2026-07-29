import assert from "node:assert/strict";
import test from "node:test";

import { MUTATION_OUTCOMES, parseMutationResult } from "./mutation.js";

test("mutation result supports exactly five outcomes without implied acceptance", () => {
  for (const outcome of MUTATION_OUTCOMES) {
    const result = parseMutationResult(outcome === "applied"
      ? { schema_version: 1, outcome, target_id: "LIN-2", correlation_id: "corr:1" }
      : { schema_version: 1, outcome, target_id: "LIN-2", correlation_id: "corr:1", reason: "fresh read required" });
    assert.equal(result.outcome, outcome);
  }
  assert.throws(() => parseMutationResult({
    schema_version: 1, outcome: "applied", target_id: "LIN-2", correlation_id: "corr:1", accepted: true,
  }), /invalid_contract_keys/u);
  assert.throws(() => parseMutationResult({
    outcome: "applied", target_id: "LIN-2", correlation_id: "corr:1",
  }), /unsupported_schema_version/u);
});
