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
      return { rootIssueId: value.rootIssueId, projectId: value.projectId };
    },
  });

  assert.deepEqual(Object.keys(runner).sort(), [
    "appendHumanResponse", "createRoot", "observeRoot",
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

  assert.deepEqual(observed, { facts: { rootIssueId: "root-1", projectId: "project-1" } });
  assert.equal(Object.hasOwn(observed, "snapshot"), false);
  assert.deepEqual(calls.map(([kind]) => kind), [
    "createRoot", "appendHumanResponse", "readSnapshot", "projectFacts",
  ]);
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
