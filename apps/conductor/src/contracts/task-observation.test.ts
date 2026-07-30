import assert from "node:assert/strict";
import test from "node:test";

import { parseRootIssueId, parseRuntimeGeneration } from "./identity.js";
import {
  parseRootBootstrap,
  parseTaskSnapshot,
  parseWakeRoot,
} from "./observation.js";

const task = {
  root_id: "LIN-1",
  issues: [
    {
      issue_id: "LIN-1",
      revision: "revision:root:1",
      status: "In Progress",
      title: "Deliver the requested change",
      description: null,
      parent_id: null,
      labels: ["symphony:kind/root"],
      delegate_id: "actor:1",
      priority: 1,
    },
    {
      issue_id: "LIN-2",
      revision: "revision:cycle:1",
      status: "Executing",
      title: "Cycle 1",
      description: "Current attempt",
      parent_id: "LIN-1",
      labels: ["symphony:kind/cycle"],
      delegate_id: "actor:1",
      priority: 2,
    },
  ],
  relations: [
    {
      relation_id: "relation:1",
      revision: "revision:relation:1",
      type: "blocks",
      source_issue_id: "LIN-1",
      target_issue_id: "LIN-2",
    },
  ],
};

const git = {
  repository_id: "repo:1",
  base_branch: "main",
  head_branch: "symphony/root-LIN-1",
  head_revision: "a".repeat(40),
  workspace_state: "dirty",
  diff_digest: "sha256:abc",
  pull_request: null,
};

const target = {
  root_id: parseRootIssueId("LIN-1"),
  runtime_generation: parseRuntimeGeneration(3),
};

test("WakeRoot accepts only the versioned root wake identity", () => {
  const wake = parseWakeRoot({
    schema_version: 1,
    root_id: "LIN-1",
    provider_event_id: "event:1",
    received_at: "2026-07-30T10:00:00.000Z",
  });

  assert.equal(wake.provider_event_id, "event:1");
  assert.ok(Object.isFrozen(wake));
  assert.throws(() => parseWakeRoot({ ...wake, payload: {} }), /invalid_contract_keys/u);
  assert.throws(() => parseWakeRoot({ ...wake, schema_version: 2 }), /unsupported_schema_version/u);
});

test("TaskSnapshot contains only a complete normalized issue and relation graph", () => {
  const snapshot = parseTaskSnapshot(task);

  assert.equal(snapshot.issues[1]?.parent_id, "LIN-1");
  assert.equal(snapshot.relations[0]?.source_issue_id, "LIN-1");
  assert.ok(Object.isFrozen(snapshot.issues));
  assert.throws(
    () => parseTaskSnapshot({ ...task, provider: { sdk: true } }),
    /invalid_contract_keys/u,
  );
  assert.throws(
    () => parseTaskSnapshot({ ...task, issues: [...task.issues, task.issues[0]] }),
    /duplicate_issue_identity/u,
  );
  assert.throws(
    () => parseTaskSnapshot({ ...task, issues: new Array(5_001).fill(task.issues[0]) }),
    /contract_array_limit_exceeded/u,
  );
  assert.throws(
    () => parseTaskSnapshot({ ...task, issues: task.issues.map((issue, index) => index === 1
      ? { ...issue, parent_id: "LIN-99" }
      : issue) }),
    /unknown_parent_identity/u,
  );
});

test("RootBootstrap binds provider-neutral snapshots to the current runtime", () => {
  const bootstrap = {
    schema_version: 1,
    root_id: "LIN-1",
    runtime_generation: 3,
    correlation_id: "corr:3",
    observed_at: "2026-07-30T10:00:00.000Z",
    task,
    git,
  };

  const parsed = parseRootBootstrap(bootstrap, target);
  assert.equal(parsed.task.root_id, "LIN-1");
  assert.equal(parsed.git.repository_id, "repo:1");
  assert.throws(
    () => parseRootBootstrap({ ...bootstrap, runtime_generation: 2 }, target),
    /stale_generation/u,
  );
  assert.throws(
    () => parseRootBootstrap({ ...bootstrap, root_id: "LIN-9" }, target),
    /runtime_root_mismatch/u,
  );
  assert.throws(
    () => parseRootBootstrap({ ...bootstrap, linear: task }, target),
    /invalid_contract_keys/u,
  );
});
