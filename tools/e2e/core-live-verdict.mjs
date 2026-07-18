const REQUIRED_STEPS = Object.freeze([
  "project_created",
  "conductor_handshake",
  "profile_active",
  "root_created",
  "plan_ready",
  "plan_approved",
  "work_completed",
  "root_gate_passed",
  "branch_delivered",
  "linear_in_review",
  "cleanup_completed",
]);

export function evaluateCoreLiveEvidence(result) {
  const observed = new Map(
    Array.isArray(result?.evidence)
      ? result.evidence.map((item) => [item?.step, item?.status])
      : [],
  );
  const missing = REQUIRED_STEPS.filter((step) => observed.get(step) !== "passed");
  const converged = result?.performerResumed === true &&
    result?.rootState === "In Review" &&
    result?.phase === "in-review" &&
    typeof result?.deliveryBranch === "string" && result.deliveryBranch.length > 0;
  return Object.freeze({
    verdict: missing.length === 0 && converged ? "passed" : "failed",
    missingSteps: Object.freeze(missing),
    converged,
  });
}

export function coreLiveStepIds() {
  return [...REQUIRED_STEPS];
}
