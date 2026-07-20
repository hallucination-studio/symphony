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
    rootCompletionVerified: true,
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
    ["request_budget_verified", { physicalRequestCount: 500 }],
    ["request_budget_verified", { physicalRequest429Count: 1 }],
    ["request_budget_verified", { complexityWindowEnd: undefined }],
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

test("verdict rejects first managed comment and planning Turn budget violations", () => {
  const overCommentBudget = passingEvidence().map((item) =>
    item.step === "request_budget_verified"
      ? { ...item, firstManagedCommentDurationMs: 30_001 }
      : item);
  assert.equal(evaluateCoreLiveEvidence({
    performerResumed: true,
    rootState: "In Review",
    phase: "in-review",
    deliveryBranch: "symphony/runs/run-1",
    rootIssueId: "root-1",
    performerId: "conversation-1",
    evidence: overCommentBudget,
  }).verdict, "failed");

  const overPlanningTimeBudget = passingEvidence().map((item) =>
    item.step === "request_budget_verified"
      ? { ...item, firstPlanningTurnDurationMs: 120_001 }
      : item);
  assert.equal(evaluateCoreLiveEvidence({
    performerResumed: true,
    rootState: "In Review",
    phase: "in-review",
    deliveryBranch: "symphony/runs/run-1",
    rootIssueId: "root-1",
    performerId: "conversation-1",
    evidence: overPlanningTimeBudget,
  }).verdict, "failed");

  const overPlanningTokenBudget = passingEvidence().map((item) =>
    item.step === "request_budget_verified"
      ? { ...item, firstPlanningInputTokens: 300_001 }
      : item);
  assert.equal(evaluateCoreLiveEvidence({
    performerResumed: true,
    rootState: "In Review",
    phase: "in-review",
    deliveryBranch: "symphony/runs/run-1",
    rootIssueId: "root-1",
    performerId: "conversation-1",
    evidence: overPlanningTokenBudget,
  }).verdict, "failed");
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

test("verdict rejects aggregate completion claims without three independent Root records", () => {
  assert.equal(
    evaluateCoreLiveEvidence({
      performerResumed: true,
      rootState: "In Review",
      phase: "in-review",
      deliveryBranch: "symphony/runs/run-1",
      rootIssueId: "root-1",
      performerId: "conversation-1",
      evidence: passingEvidence().filter((item) => item.step !== "root_completion_evidence"),
    }).verdict,
    "failed",
  );
});

test("verdict rejects Root records that borrow another Root workspace", () => {
  const evidence = passingEvidence().map((item) => item.step === "root_completion_evidence"
    ? {
        ...item,
        roots: item.roots.map((root, index) => index === 1
          ? { ...root, workspace_id: item.roots[0].workspace_id }
          : root),
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
      dependentChildCount: 0,
      dependentManagedCommentAbsent: true,
      dependentPerformerAbsent: true,
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
      physicalRequestCount: 499,
      physicalRequestCounts: { CoreLivePreflight: 10, SymphonyRootHeaderFacts: 489 },
      physicalRequest429Count: 0,
      firstManagedCommentDurationMs: 12_000,
      firstPlanningTurnDurationMs: 60_000,
      firstPlanningInputTokens: 100_000,
      requestWindowStart: { limit: 1000, remaining: 999, reset: 60 },
      requestWindowEnd: { limit: 1000, remaining: 500, reset: 60 },
      complexityWindowStart: { limit: 250000, remaining: 249900, reset: 60 },
      complexityWindowEnd: { limit: 250000, remaining: 200000, reset: 60 },
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
      rootFacts: [
        { rootIssueId: "root-1", performerId: "conversation-1",
          linearReadBack: true, gitReadBack: true, deliveryReadBack: true,
          planCreatedByBroker: true, correlatedTurnIds: ["turn-1"] },
        { rootIssueId: "root-2", performerId: "conversation-2",
          linearReadBack: true, gitReadBack: true, deliveryReadBack: true,
          planCreatedByBroker: true, correlatedTurnIds: ["turn-2"] },
        { rootIssueId: "root-3", performerId: "conversation-3",
          linearReadBack: true, gitReadBack: true, deliveryReadBack: true,
          planCreatedByBroker: true, correlatedTurnIds: ["turn-3"] },
      ],
      appliedCommands: ["linear.status.set", "git.commit", "root.deliver"],
    };
    if (step === "work_completed") return {
      step, status: "passed", workNodeCount: 1, planCreatedByBroker: true,
      allWorkDone: true,
    };
    if (step === "root_gate_passed") return {
      step, status: "passed", reworkCount: 0, gateCount: 3,
      checklistChecked: true, phase: "in-review",
    };
    if (step === "branch_delivered") return {
      step, status: "passed", branchCount: 3,
      deliveryBranch: "symphony/runs/run-1", deliveredMarkerReadBack: true,
    };
    if (step === "linear_in_review") return {
      step, status: "passed", rootState: "In Review", phase: "in-review", rootCount: 3,
    };
    if (step === "root_completion_evidence") return {
      step, status: "passed", rootCount: 3,
      planningOrder: ["root-1", "root-2", "root-3"],
      executionOrder: ["root-1", "root-2", "root-3"],
      roots: [1, 2, 3].map((priority) => ({
        root_issue_id: `root-${priority}`,
        root_identifier: `SYM-${priority}`,
        priority,
        input_description_digest: "a".repeat(64),
        started_at: "2026-07-20T00:00:00.000Z",
        completed_at: "2026-07-20T00:00:01.000Z",
        duration_ms: 1000,
        planning_turn_ids: [`plan-${priority}`],
        execution_turn_ids: [`execute-${priority}`],
        performer_id: `conversation-${priority}`,
        workspace_id: `workspace-${priority}`,
        delivery_kind: "local_branch",
        delivery_branch: `symphony/runs/root-${priority}`,
        delivery_head: String(priority).repeat(40),
        work_issue_ids: [`work-${priority}`],
        human_issue_id: `human-${priority}`,
        gate_issue_id: `gate-${priority}`,
        gate_check_ids: ["root-facts", "work-evidence", "git-checks", "blockers", "delivery"],
        gate_all_checked: true,
        changed_paths: [`e2e-${["high", "medium", "low"][priority - 1]}.txt`],
        output_digest: "b".repeat(64),
        root_state: "In Review",
        phase: "in-review",
      })),
    };
    return { step, status: "passed" };
  });
}
