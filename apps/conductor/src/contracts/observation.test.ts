import assert from "node:assert/strict";
import test from "node:test";

import { parseRootBootstrap, parseRootObservationDiff } from "./observation.js";
import { parseRootRuntimeState } from "./runtime.js";

const bootstrap = {
  schema_version: 1,
  root_id: "LIN-1",
  runtime_generation: 1,
  correlation_id: "corr:1",
  observed_at: "2026-07-29T00:00:00.000Z",
  linear: {
    root_id: "LIN-1",
    root_status: "In Progress",
    active_cycle: {
      issue_id: "LIN-2",
      status: "Executing",
      stages: [
        { issue_id: "LIN-3", kind: "work", status: "Todo", dependency_issue_ids: [] },
      ],
    },
  },
  git: {
    repository_id: "repo:1",
    base_branch: "main",
    head_branch: "symphony/root-LIN-1",
    head_revision: "a".repeat(40),
    workspace_state: "dirty",
    diff_digest: "digest:1",
    pull_request: null,
  },
};

test("bootstrap validates only approved current Linear and Git facts", () => {
  const parsed = parseRootBootstrap(bootstrap);
  assert.equal(parsed.linear.active_cycle?.stages[0]?.issue_id, "LIN-3");
  assert.equal(parsed.git.head_revision, "a".repeat(40));
  assert.ok(Object.isFrozen(parsed));
  assert.throws(() => parseRootBootstrap({ ...bootstrap, next_action: "work" }), /invalid_contract_keys/u);
  assert.throws(() => parseRootBootstrap({ ...bootstrap, linear: { ...bootstrap.linear, root_id: "LIN-9" } }), /bootstrap_root_mismatch/u);
});

test("continuity state rejects workflow mirrors and unknown fields", () => {
  const state = {
    schema_version: 1,
    root_id: "LIN-1",
    runtime_generation: 2,
    thread_id: "thread:2",
    accepted_observation_digest: "digest:2",
    in_flight_correlation: null,
  };
  assert.deepEqual(parseRootRuntimeState(state), state);
  for (const forbidden of ["dag", "handoff", "next_action", "metadata", "linear"]) {
    assert.throws(() => parseRootRuntimeState({ ...state, [forbidden]: {} }), /invalid_contract_keys/u);
  }
});

test("observation diff accepts only closed scalar fact changes", () => {
  const diff = {
    schema_version: 1,
    root_id: "LIN-1",
    runtime_generation: 2,
    correlation_id: "corr:2",
    from_observation_digest: "digest:1",
    to_observation_digest: "digest:2",
    changed_linear_facts: [
      { kind: "stage_changed", stage_id: "LIN-3", before: "Todo", after: "In Progress" },
    ],
    changed_git_facts: [],
  };
  assert.equal(parseRootObservationDiff(diff).changed_linear_facts.length, 1);
  assert.throws(
    () => parseRootObservationDiff({ ...diff, changed_linear_facts: [{ kind: "full_observation", value: bootstrap }] }),
    /invalid_contract_variant/u,
  );
  assert.throws(
    () => parseRootObservationDiff({ ...diff, to_observation_digest: "digest:1" }),
    /unchanged_observation_diff/u,
  );
});
