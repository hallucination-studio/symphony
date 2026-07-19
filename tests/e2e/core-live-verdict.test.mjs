import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  coreLiveStepIds,
  evaluateCoreLiveEvidence,
} from "../../tools/e2e/core-live-verdict.mjs";

test("core live dry-run exposes fixed transitions without mutation or credentials", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    ["tools/e2e/core-live-runner.mjs", "--dry-run"],
    { encoding: "utf8", env: {} },
  ));
  assert.equal(result.status, "dry_run");
  assert.equal(result.mutationAttempted, false);
  assert.deepEqual(result.states, [
    "preflight", "locked", "project-created", "conductor-ready",
    "profile-active", "root-todo", "planning", "awaiting-human",
    "working", "gating", "delivering", "in-review",
  ]);
  assert.deepEqual(result.evidenceSteps, coreLiveStepIds());
});

test("verdict evaluates evidence independently from the claimed runner status", () => {
  const evidence = passingEvidence();
  assert.deepEqual(evaluateCoreLiveEvidence({
    status: "failed",
    performerResumed: true,
    rootState: "In Review",
    phase: "in-review",
    deliveryBranch: "symphony/runs/run-1",
    rootIssueId: "root-1",
    performerId: "conversation-1",
    evidence,
  }), {
    verdict: "passed",
    missingSteps: [],
    converged: true,
    rootCommentsVerified: true,
    multiRootSchedulingVerified: true,
    runtimeBudgetVerified: true,
    v3FactsVerified: true,
  });
  assert.equal(evaluateCoreLiveEvidence({
    status: "passed",
    performerResumed: false,
    rootState: "Done",
    phase: "in-review",
    deliveryBranch: "symphony/runs/run-1",
    rootIssueId: "root-1",
    performerId: "conversation-1",
    evidence,
  }).verdict, "failed");
});

test("cleanup completion is required independent evidence", () => {
  assert.equal(coreLiveStepIds().includes("cleanup_completed"), true);
  const evidence = coreLiveStepIds().map((step) => ({
    step,
    status: step === "cleanup_completed" ? "failed" : "passed",
  }));
  assert.deepEqual(evaluateCoreLiveEvidence({
    status: "passed",
    performerResumed: true,
    rootState: "In Review",
    phase: "in-review",
    deliveryBranch: "symphony/runs/run-1",
    rootIssueId: "root-1",
    performerId: "conversation-1",
    evidence,
  }).missingSteps, ["cleanup_completed"]);
});

test("verdict independently validates sanitized Root comment evidence", () => {
  assert.equal(
    evaluateCoreLiveEvidence({
      performerResumed: true,
      rootState: "In Review",
      phase: "in-review",
      deliveryBranch: "symphony/runs/run-1",
      rootIssueId: "root-1",
      performerId: "conversation-1",
      evidence: passingEvidence().map((item) =>
        item.step === "root_comments_verified"
          ? { ...item, eventKeys: ["duplicate:1", "duplicate:1"] }
          : item),
    }).verdict,
    "failed",
  );
});

test("verdict rejects claimed success when multi-Root lane evidence overlaps", () => {
  assert.equal(
    evaluateCoreLiveEvidence({
      performerResumed: true,
      rootState: "In Review",
      phase: "in-review",
      deliveryBranch: "symphony/runs/run-1",
      rootIssueId: "root-1",
      performerId: "conversation-1",
      evidence: passingEvidence().map((item) =>
        item.step === "single_turn_lane_verified"
          ? { ...item, maxActiveTurns: 2 }
          : item),
    }).verdict,
    "failed",
  );
});

test("verdict rejects missing broker, runtime, and V3 durable evidence", () => {
  const cases = [
    ["broker_writes_verified", { appliedCommands: [] }],
    ["request_budget_verified", { stepDurationsMs: {} }],
    ["request_budget_verified", { stepRequestCounts: {} }],
    ["request_budget_verified", { discoveryTreeRequests: 3 }],
    ["work_completed", { workNodeCount: 0, allWorkDone: false }],
    ["root_gate_passed", { reworkCount: 1, phase: "reworking" }],
    ["branch_delivered", { deliveredMarkerReadBack: false }],
  ];
  for (const [step, replacement] of cases) {
    const evidence = passingEvidence().map((item) =>
      item.step === step ? { ...item, ...replacement } : item);
    assert.equal(evaluateCoreLiveEvidence({
      performerResumed: true,
      rootState: "In Review",
      phase: "in-review",
      deliveryBranch: "symphony/runs/run-1",
      rootIssueId: "root-1",
      performerId: "conversation-1",
      evidence,
    }).verdict, "failed", `accepted invalid ${step} evidence`);
  }
});

test("verdict rejects commit and delivery evidence split across Turns", () => {
  const evidence = passingEvidence().map((item) =>
    item.step === "broker_writes_verified"
      ? {
          ...item,
          correlatedTurnIds: ["turn-1", "turn-2"],
          deliveryTurnId: "turn-2",
          turnCommands: [
            { turnId: "turn-1", commands: ["linear.status.set", "git.commit"] },
            { turnId: "turn-2", commands: ["root.deliver"] },
          ],
        }
      : item);
  assert.equal(evaluateCoreLiveEvidence({
    performerResumed: true,
    rootState: "In Review",
    phase: "in-review",
    deliveryBranch: "symphony/runs/run-1",
    rootIssueId: "root-1",
    performerId: "conversation-1",
    evidence,
  }).verdict, "failed");
});

function passingEvidence() {
  return coreLiveStepIds().map((step) => {
    if (step === "root_comments_verified") return {
        step,
        status: "passed",
        rootCount: 3,
        primaryCommentCount: 3,
        timelineEventCount: 5,
        completionEventCount: 0,
        eventKinds: ["warning_raised"],
        eventKeys: Array.from({ length: 5 }, (_, index) => `turn-${index}:1`),
      };
    if (step === "blocker_order_verified") return {
      step,
      status: "passed",
      blockerPlanned: true,
      dependentUntouched: true,
    };
    if (step === "human_yield_verified") return {
      step,
      status: "passed",
      waitingRootUnchanged: true,
      yieldedRootPlanned: true,
    };
    if (step === "priority_refresh_verified") return {
      step,
      status: "passed",
      newWinnerSelected: true,
      previousWinnerUntouched: true,
    };
    if (step === "single_turn_lane_verified") return {
      step,
      status: "passed",
      observedTurnCount: 5,
      maxActiveTurns: 1,
    };
    if (step === "request_budget_verified") return {
      step,
      status: "passed",
      totalRequests: 12,
      requestCounts: { list_root_issues: 2, get_issue_tree: 3 },
      discoveryObservations: 1,
      maxRootHeaderCount: 3,
      totalDiscoveryListPages: 1,
      discoveryTreeRequests: 0,
      stepDurationsMs: { conductor_handshake: 25, multi_root_scheduling: 75,
        root_completion: 100 },
      stepRequestCounts: { multi_root_scheduling: { list_root_issues: 2 },
        root_completion: { get_issue_tree: 3 } },
    };
    if (step === "conversation_pointer_verified") return {
      step, status: "passed", pointerReadBack: true, firstTurnUsedPointer: true,
    };
    if (step === "broker_writes_verified") return {
      step, status: "passed", linearReadBack: true, gitReadBack: true,
      deliveryReadBack: true,
      rootIssueId: "root-1", performerId: "conversation-1",
      correlatedTurnIds: ["turn-1"], deliveryTurnId: "turn-1",
      turnCommands: [{ turnId: "turn-1",
        commands: ["linear.status.set", "git.commit", "root.deliver"] }],
      appliedCommands: ["linear.status.set", "git.commit", "root.deliver"],
    };
    if (step === "work_completed") return {
      step, status: "passed", workNodeCount: 1, allWorkDone: true,
    };
    if (step === "root_gate_passed") return {
      step, status: "passed", reworkCount: 0, phase: "in-review",
    };
    if (step === "branch_delivered") return {
      step, status: "passed", branchCount: 1,
      deliveryBranch: "symphony/runs/run-1", deliveredMarkerReadBack: true,
    };
    if (step === "linear_in_review") return {
      step, status: "passed", rootState: "In Review", phase: "in-review",
    };
    return { step, status: "passed" };
  });
}
