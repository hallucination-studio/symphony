import assert from "node:assert/strict";
import test from "node:test";

import { createAdaptivePoller } from "../../tools/e2e/target-workflow-polling.mjs";

test("adaptive polling backs off on unchanged facts and resets after progress", () => {
  const poller = createAdaptivePoller({ baseIntervalMs: 1000, maxIntervalMs: 4000 });
  assert.equal(poller.observe({ state: "Planning" }), 1000);
  assert.equal(poller.observe({ state: "Planning" }), 2000);
  assert.equal(poller.observe({ state: "Planning" }), 4000);
  assert.equal(poller.observe({ state: "Done" }), 1000);
});

import { runTargetSuccessScenario } from "../../tools/e2e/target-workflow-success.mjs";

test("target success orchestration creates, approves, and returns only durable facts", async () => {
  const calls = [];
  let pendingReads = 0;
  let factsReads = 0;
  let gitHead = "a".repeat(40);
  const observationPhases = [];
  const facts = {
    root: { projectId: "project-1", rootIssueId: "root-1" },
    plan: {}, stageExecutions: [], progress: {},
  };
  const runner = {
    async createRoot(input) {
      calls.push(["createRoot", input]);
      return { rootIssueId: "root-1", projectId: "project-1", stateName: "In Progress" };
    },
    async observePendingHuman(input) {
      calls.push(["observePendingHuman", input]);
      pendingReads += 1;
      if (pendingReads === 1) throw new Error("target_transport_issue_kind_invalid");
      return { pendingHuman: {
          status: "waiting", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "plan-1",
          requestKind: "needs_approval", actionId: "action-1", contextDigest: "a".repeat(64),
        } };
    },
    async appendHumanResponse(input) {
      calls.push(["appendHumanResponse", input]);
      gitHead = "b".repeat(40);
      return { commentId: "comment-1", issueId: input.issueId, projectId: input.projectId };
    },
    async observeRoot(input) {
      calls.push(["observeRoot", input]);
      factsReads += 1;
      if (factsReads === 1) throw new Error("target_transport_issue_kind_invalid");
      return { facts };
    },
  };

  const result = await runTargetSuccessScenario({
    runner,
    rootInput: { title: "Target success" },
    observationInput: { git: { head: gitHead, branch: "symphony/runs/root-1" } },
    readObservationInput: async ({ phase }) => {
      observationPhases.push(phase);
      return {
      git: { head: gitHead, branch: "symphony/runs/root-1" },
      };
    },
    humanResponseBody: "Approved for implementation.",
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    sleep: async () => {},
  });

  assert.deepEqual(result, { facts });
  assert.deepEqual(calls.map(([kind]) => kind), [
    "createRoot", "observePendingHuman", "observePendingHuman", "appendHumanResponse",
    "observeRoot", "observeRoot",
  ]);
  assert.deepEqual(calls[3][1], {
    projectId: "project-1", issueId: "plan-1", body: "Approved for implementation.",
  });
  assert.deepEqual(calls.filter(([kind]) => kind === "observeRoot").map(([, input]) => input.git.head), [
    "b".repeat(40), "b".repeat(40),
  ]);
  assert.deepEqual(observationPhases, ["pending_human", "pending_human", "durable_facts", "durable_facts"]);
  assert.equal(Object.hasOwn(result, "snapshot"), false);
});

test("target success orchestration fails closed on a non-approval Human action", async () => {
  const progress = [];
  const runner = {
    async createRoot() { return { rootIssueId: "root-1", projectId: "project-1" }; },
    async observePendingHuman() {
      return { pendingHuman: {
        status: "waiting", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "work-1",
        requestKind: "needs_info", actionId: "action-1", contextDigest: "a".repeat(64),
      } };
    },
    appendHumanResponse() { throw new Error("must_not_write"); },
    observeRoot() { throw new Error("must_not_observe_root"); },
  };

  await assert.rejects(
    runTargetSuccessScenario({
      runner,
      rootInput: { title: "Target success" },
      observationInput: { git: { head: "b".repeat(40), branch: "symphony/runs/root-1" } },
      humanResponseBody: "Approved.",
      onProgress: (event) => progress.push(event),
    }),
    /target_success_pending_kind_invalid/u,
  );
  assert.deepEqual(progress, [{ phase: "pending_human", status: "waiting" }]);
});

test("target success orchestration does not retry malformed durable facts", async () => {
  let factReads = 0;
  const runner = {
    async createRoot() { return { rootIssueId: "root-1", projectId: "project-1" }; },
    async observePendingHuman() {
      return { pendingHuman: {
        status: "waiting", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "plan-1",
        requestKind: "needs_approval", actionId: "action-1", contextDigest: "a".repeat(64),
      } };
    },
    async appendHumanResponse() {},
    async observeRoot() {
      factReads += 1;
      throw new Error("target_facts_record_invalid");
    },
  };

  await assert.rejects(
    runTargetSuccessScenario({
      runner,
      rootInput: { title: "Target success" },
      observationInput: { git: { head: "b".repeat(40), branch: "symphony/runs/root-1" } },
      humanResponseBody: "Approved.",
    }),
    /target_facts_record_invalid/u,
  );
  assert.equal(factReads, 1);
});

test("target success orchestration rejects a pending action for another Root", async () => {
  let writes = 0;
  const runner = {
    async createRoot() { return { rootIssueId: "root-1", projectId: "project-1" }; },
    async observePendingHuman() {
      return { pendingHuman: {
        status: "waiting", rootIssueId: "root-2", cycleIssueId: "cycle-1", nodeIssueId: "plan-1",
        requestKind: "needs_approval", actionId: "action-1", contextDigest: "a".repeat(64),
      } };
    },
    async appendHumanResponse() { writes += 1; },
    async observeRoot() { throw new Error("must_not_observe_root"); },
  };

  await assert.rejects(
    runTargetSuccessScenario({
      runner,
      rootInput: { title: "Target success" },
      observationInput: { git: { head: "b".repeat(40), branch: "symphony/runs/root-1" } },
      humanResponseBody: "Approved.",
    }),
    /target_success_pending_observation_invalid/u,
  );
  assert.equal(writes, 0);
});
