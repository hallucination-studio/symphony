import assert from "node:assert/strict";
import test from "node:test";

import { runTargetRepairEscalationScenario } from "../../tools/e2e/target-workflow-repair.mjs";

test("target repair orchestration processes each approval action once and re-reads Git", async () => {
  const calls = [];
  const pending = [
    waiting("action-1", "cycle-1", "plan-1"),
    waiting("action-1", "cycle-1", "plan-1"),
    waiting("action-2", "cycle-2", "plan-2"),
    waiting("action-2", "cycle-2", "plan-2"),
    { status: "not_waiting" },
  ];
  let gitHead = "a".repeat(40);
  let factsReads = 0;
  const facts = repairFacts();
  const result = await runTargetRepairEscalationScenario({
    runner: {
      async createRoot(input) {
        calls.push(["createRoot", input]);
        return { rootIssueId: "root-1", projectId: "project-1" };
      },
      async observePendingHuman(input) {
        calls.push(["observePendingHuman", input]);
        return { pendingHuman: pending.shift() ?? { status: "not_waiting" } };
      },
      async appendHumanResponse(input) {
        calls.push(["appendHumanResponse", input]);
        gitHead = "b".repeat(40);
        return { commentId: `comment-${input.issueId}`, issueId: input.issueId, projectId: input.projectId };
      },
      async observeRoot(input) {
        calls.push(["observeRoot", input]);
        factsReads += 1;
        if (factsReads < 2) throw new Error("target_facts_stage_shape_invalid");
        return { facts };
      },
    },
    rootInput: { title: "Repair" },
    observationInput: { git: { head: "a".repeat(40), branch: "symphony/runs/root-1" } },
    readObservationInput: async ({ phase }) => {
      calls.push(["readObservationInput", { phase, gitHead }]);
      return { git: { head: gitHead, branch: "symphony/runs/root-1" } };
    },
    humanResponseBody: "Approved for the repair proposal.",
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    sleep: async () => {},
  });

  assert.deepEqual(result, { facts });
  assert.deepEqual(calls.filter(([kind]) => kind === "appendHumanResponse").map(([, input]) => input), [
    { projectId: "project-1", issueId: "plan-1", body: "Approved for the repair proposal." },
    { projectId: "project-1", issueId: "plan-2", body: "Approved for the repair proposal." },
  ]);
  assert.ok(calls.filter(([kind]) => kind === "observeRoot").every(([, input]) => input.git.head === "b".repeat(40)));
  assert.ok(calls.filter(([kind]) => kind === "readObservationInput").length >= 2);
});

test("target repair retries a partially materialized Root during polling", async () => {
  let pendingReads = 0;
  let factsReads = 0;
  const facts = repairFacts();
  const result = await runTargetRepairEscalationScenario({
    runner: {
      async createRoot() { return { rootIssueId: "root-1", projectId: "project-1" }; },
      async observePendingHuman() {
        pendingReads += 1;
        if (pendingReads === 1) throw new Error("target_transport_issue_kind_invalid");
        return { pendingHuman: { status: "not_waiting" } };
      },
      async appendHumanResponse() { throw new Error("must_not_append"); },
      async observeRoot() {
        factsReads += 1;
        if (factsReads === 1) throw new Error("target_transport_issue_kind_invalid");
        return { facts };
      },
    },
    rootInput: { title: "Repair" },
    observationInput: { git: { head: "a".repeat(40), branch: "symphony/runs/root-1" } },
    humanResponseBody: "Approved.",
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    sleep: async () => {},
  });

  assert.deepEqual(result, { facts });
  assert.ok(pendingReads >= 2);
  assert.equal(factsReads, 2);
});

test("target repair orchestration fails closed on a needs-info action", async () => {
  await assert.rejects(
    runTargetRepairEscalationScenario({
      runner: {
        async createRoot() { return { rootIssueId: "root-1", projectId: "project-1" }; },
        async observePendingHuman() {
          return { pendingHuman: { ...waiting("action-1", "cycle-1", "work-1"), requestKind: "needs_info" } };
        },
        async appendHumanResponse() { throw new Error("must_not_append"); },
        async observeRoot() { throw new Error("must_not_observe"); },
      },
      rootInput: { title: "Repair" },
      observationInput: { git: { head: "a".repeat(40), branch: "symphony/runs/root-1" } },
      humanResponseBody: "Approved.",
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      sleep: async () => {},
    }),
    /target_repair_pending_kind_invalid/u,
  );
});

test("target repair orchestration bounds repeated approval actions", async () => {
  let observations = 0;
  await assert.rejects(
    runTargetRepairEscalationScenario({
      runner: {
        async createRoot() { return { rootIssueId: "root-1", projectId: "project-1" }; },
        async observePendingHuman() {
          observations += 1;
          return { pendingHuman: waiting(`action-${observations}`, "cycle-1", "plan-1") };
        },
        async appendHumanResponse() { return { commentId: "comment-1", issueId: "plan-1", projectId: "project-1" }; },
        async observeRoot() { throw new Error("must_not_observe"); },
      },
      rootInput: { title: "Repair" },
      observationInput: { git: { head: "a".repeat(40), branch: "symphony/runs/root-1" } },
      humanResponseBody: "Approved.",
      maxHumanActions: 2,
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      sleep: async () => {},
    }),
    /target_repair_human_action_limit/u,
  );
});

test("target repair orchestration rejects malformed escalation facts", async () => {
  await assert.rejects(
    runTargetRepairEscalationScenario({
      runner: {
        async createRoot() { return { rootIssueId: "root-1", projectId: "project-1" }; },
        async observePendingHuman() { return { pendingHuman: { status: "not_waiting" } }; },
        async appendHumanResponse() { throw new Error("must_not_append"); },
        async observeRoot() {
          return { facts: { root: { rootIssueId: "root-1", projectId: "project-1" }, repairEscalation: null } };
        },
      },
      rootInput: { title: "Repair" },
      observationInput: { git: { head: "a".repeat(40), branch: "symphony/runs/root-1" } },
      humanResponseBody: "Approved.",
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      sleep: async () => {},
    }),
    /target_repair_facts_invalid/u,
  );
});

test("target repair orchestration rejects raw fields at the facts boundary", async () => {
  await assert.rejects(
    runTargetRepairEscalationScenario({
      runner: {
        async createRoot() { return { rootIssueId: "root-1", projectId: "project-1" }; },
        async observePendingHuman() { return { pendingHuman: { status: "not_waiting" } }; },
        async appendHumanResponse() { throw new Error("must_not_append"); },
        async observeRoot() {
          return { facts: { root: { rootIssueId: "root-1", projectId: "project-1" }, rawRecord: "secret" } };
        },
      },
      rootInput: { title: "Repair" },
      observationInput: { git: { head: "a".repeat(40), branch: "symphony/runs/root-1" } },
      humanResponseBody: "Approved.",
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      sleep: async () => {},
    }),
    /target_repair_facts_invalid/u,
  );
});

function waiting(actionId, cycleIssueId, nodeIssueId) {
  return {
    status: "waiting", rootIssueId: "root-1", cycleIssueId, nodeIssueId,
    requestKind: "needs_approval", actionId, contextDigest: "a".repeat(64),
  };
}

function repairFacts() {
  return {
    root: { rootIssueId: "root-1", projectId: "project-1" },
    plan: {},
    stageExecutions: [],
    progress: {},
    repairEscalation: {
      findingId: "finding-1", sourceVerifyId: "verify-2", disposition: "escalated",
      breaker: { checked: true, decision: "escalate", cycleCount: 2, maxCycles: 2, openFindingCount: 1 },
    },
  };
}
