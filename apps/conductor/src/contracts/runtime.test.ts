import assert from "node:assert/strict";
import test from "node:test";

import { BOUNDARY_ERROR_CODES, parseBoundaryError } from "./common-outcomes.js";
import { parseRootIssueId, parseRuntimeGeneration } from "./identity.js";
import { parseRootRuntimeState, parseRootTurnOutcome } from "./runtime.js";

const state = {
  schema_version: 1,
  root_id: "LIN-1",
  runtime_generation: 3,
  thread_id: "thread:3",
  accepted_observation_digest: "digest:3",
  in_flight_correlation: null,
};

const target = {
  root_id: parseRootIssueId("LIN-1"),
  runtime_generation: parseRuntimeGeneration(3),
};

test("RootRuntimeState persists only the closed continuity payload", () => {
  const parsed = parseRootRuntimeState(state);

  assert.deepEqual(parsed, state);
  assert.ok(Object.isFrozen(parsed));
  for (const forbidden of ["snapshot", "diff", "next_action", "tool_result", "metadata"]) {
    assert.throws(
      () => parseRootRuntimeState({ ...state, [forbidden]: {} }),
      /invalid_contract_keys/u,
    );
  }
});

test("boundary errors use exactly the architecture-owned closed codes", () => {
  assert.deepEqual(BOUNDARY_ERROR_CODES, [
    "invalid_contract",
    "stale_generation",
    "capability_denied",
    "timed_out",
    "canceled",
    "boundary_unavailable",
    "acceptance_unknown",
    "readback_mismatch",
  ]);

  const error = parseBoundaryError({
    schema_version: 1,
    code: "capability_denied",
    root_id: "LIN-1",
    runtime_generation: 3,
    correlation_id: "corr:3",
    reason: "requested capability is not declared",
  });
  assert.equal(error.code, "capability_denied");
  assert.ok(Object.isFrozen(error));
  assert.throws(
    () => parseBoundaryError({ ...error, code: "precondition_failed" }),
    /invalid_contract_variant/u,
  );
  assert.throws(
    () => parseBoundaryError({ ...error, metadata: {} }),
    /invalid_contract_keys/u,
  );
  assert.throws(
    () => parseBoundaryError({ ...error, reason: "token\nsecret" }),
    /invalid_boundary_reason/u,
  );
});

test("RootTurnOutcome contains only mechanical control outcomes", () => {
  const envelope = {
    schema_version: 1,
    root_id: "LIN-1",
    runtime_generation: 3,
    correlation_id: "corr:3",
  };
  assert.equal(parseRootTurnOutcome({ ...envelope, outcome: "quiescent" }, target).outcome, "quiescent");
  for (const outcome of ["stopped", "timed_out", "canceled"] as const) {
    assert.equal(parseRootTurnOutcome({
      ...envelope,
      outcome,
      sanitized_reason: "turn ended without changing external facts",
    }, target).outcome, outcome);
  }
  assert.throws(
    () => parseRootTurnOutcome({ ...envelope, outcome: "continue_cycle" }, target),
    /invalid_contract_variant/u,
  );
  assert.throws(
    () => parseRootTurnOutcome({ ...envelope, runtime_generation: 2, outcome: "quiescent" }, target),
    /stale_generation/u,
  );
  assert.throws(
    () => parseRootTurnOutcome({ ...envelope, outcome: "quiescent", next_action: "work" }, target),
    /invalid_contract_keys/u,
  );
});
