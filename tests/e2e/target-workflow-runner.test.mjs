import assert from "node:assert/strict";
import test from "node:test";

import { createTargetWorkflowRunner } from "../../tools/e2e/target-workflow-runner.mjs";

test("target runner exposes only external inputs and durable-facts observation", async () => {
  const calls = [];
  const snapshot = { rootIssueId: "root-1", projectId: "project-1", comments: [{ body: "private" }] };
  const runner = createTargetWorkflowRunner({
    externalInputs: {
      async createRoot(input) {
        calls.push(["createRoot", input]);
        return { rootIssueId: "root-1", projectId: "project-1" };
      },
      async appendHumanResponse(input) {
        calls.push(["appendHumanResponse", input]);
        return { commentId: "comment-1", issueId: input.issueId, projectId: input.projectId };
      },
    },
    snapshotTransport: {
      async readSnapshot(input) {
        calls.push(["readSnapshot", input]);
        return snapshot;
      },
    },
    projectFacts(value) {
      calls.push(["projectFacts", value]);
      return {
        root: { rootIssueId: value.rootIssueId, projectId: value.projectId },
        plan: {},
        stageExecutions: [],
        progress: {},
      };
    },
  });

  assert.deepEqual(Object.keys(runner).sort(), [
    "appendHumanResponse", "createRoot", "observePendingHuman", "observeRoot",
  ]);
  assert.deepEqual(await runner.createRoot({ title: "Root" }), {
    rootIssueId: "root-1", projectId: "project-1",
  });
  assert.deepEqual(await runner.appendHumanResponse({
    issueId: "work-1", projectId: "project-1", body: "Approved.",
  }), { commentId: "comment-1", issueId: "work-1", projectId: "project-1" });
  const observed = await runner.observeRoot({
    rootIssueId: "root-1",
    projectId: "project-1",
    git: { head: "a".repeat(40), branch: "symphony/runs/root-1" },
  });

  assert.deepEqual(observed, {
    facts: {
      root: { rootIssueId: "root-1", projectId: "project-1" },
      plan: {},
      stageExecutions: [],
      progress: {},
    },
  });
  assert.equal(Object.hasOwn(observed, "snapshot"), false);
  assert.deepEqual(calls.map(([kind]) => kind), [
    "createRoot", "appendHumanResponse", "readSnapshot", "projectFacts",
  ]);
});

test("target runner returns a closed pending Human observation without exposing the snapshot", async () => {
  const runner = createTargetWorkflowRunner({
    externalInputs: { createRoot() {}, appendHumanResponse() {} },
    snapshotTransport: {
      async readSnapshot() {
        return {
          rootIssueId: "root-1", projectId: "project-1", git: { head: "a".repeat(40), branch: "main" },
          issues: [
            { id: "root-1", projectId: "project-1", kind: "root", state: "Needs Approval" },
            { id: "cycle-1", projectId: "project-1", kind: "cycle", state: "Planning", parentIssueId: "root-1" },
            { id: "plan-1", projectId: "project-1", kind: "plan", state: "In Review", parentIssueId: "cycle-1" },
          ],
          relations: [],
          comments: [{
            issueId: "root-1", id: "action-1",
            body: `<!-- symphony managed-record\n${JSON.stringify({
              kind: "human_action", version: 1, action_id: "action-1",
              root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_issue_id: "plan-1",
              request_kind: "needs_approval", context_digest: "b".repeat(64),
            })}\n-->`,
          }],
        };
      },
    },
    projectFacts() { throw new Error("not_used"); },
  });

  const result = await runner.observePendingHuman({
    rootIssueId: "root-1", projectId: "project-1", git: { head: "a".repeat(40), branch: "main" },
  });

  assert.deepEqual(result, {
    pendingHuman: {
      status: "waiting", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "plan-1",
      requestKind: "needs_approval", actionId: "action-1", contextDigest: "b".repeat(64),
    },
  });
  assert.equal(Object.hasOwn(result, "snapshot"), false);
});

test("target runner fails closed when a boundary dependency is missing", () => {
  assert.throws(
    () => createTargetWorkflowRunner(),
    /target_runner_boundary_invalid/u,
  );
  assert.throws(
    () => createTargetWorkflowRunner({
      externalInputs: { createRoot() {}, appendHumanResponse() {} },
      snapshotTransport: { readSnapshot() {} },
      projectFacts: null,
    }),
    /target_runner_boundary_invalid/u,
  );
});

test("target runner rejects an invalid durable-facts projection", async () => {
  for (const facts of [
    {},
    { root: { rootIssueId: "root-1", projectId: "project-1" }, plan: {}, stageExecutions: [], progress: {}, metadata: {} },
    {
      root: { rootIssueId: "root-1", projectId: "project-1" }, plan: {}, stageExecutions: [], progress: {},
      repairEscalation: { findingId: "finding-1", breaker: {}, rawRecord: "must-not-cross" },
    },
  ]) {
    const runner = createTargetWorkflowRunner({
      externalInputs: { createRoot() {}, appendHumanResponse() {} },
      snapshotTransport: { async readSnapshot() { return {}; } },
      projectFacts() { return facts; },
    });

    await assert.rejects(
      runner.observeRoot({ rootIssueId: "root-1", projectId: "project-1" }),
      /target_runner_facts_invalid/u,
    );
  }
});
