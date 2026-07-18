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
    evidence,
  }), {
    verdict: "passed",
    missingSteps: [],
    converged: true,
    rootCommentsVerified: true,
  });
  assert.equal(evaluateCoreLiveEvidence({
    status: "passed",
    performerResumed: false,
    rootState: "Done",
    phase: "in-review",
    deliveryBranch: "symphony/runs/run-1",
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
      evidence: passingEvidence().map((item) =>
        item.step === "root_comments_verified"
          ? { ...item, eventKeys: ["duplicate:1", "duplicate:1"] }
          : item),
    }).verdict,
    "failed",
  );
});

function passingEvidence() {
  return coreLiveStepIds().map((step) => step === "root_comments_verified"
    ? {
        step,
        status: "passed",
        primaryCommentCount: 1,
        timelineEventCount: 3,
        completionEventCount: 3,
        eventKinds: ["turn_completed"],
        eventKeys: ["turn-plan:1", "turn-work:2", "turn-gate:3"],
      }
    : { step, status: "passed" });
}
