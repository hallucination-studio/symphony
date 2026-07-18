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
  "root_comments_verified",
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
  const commentEvidence = Array.isArray(result?.evidence)
    ? result.evidence.find((item) => item?.step === "root_comments_verified")
    : undefined;
  const eventKeys = commentEvidence?.eventKeys;
  const eventKinds = commentEvidence?.eventKinds;
  const rootCommentsVerified =
    commentEvidence?.primaryCommentCount === 1 &&
    Number.isSafeInteger(commentEvidence?.timelineEventCount) &&
    commentEvidence.timelineEventCount >= 3 &&
    Number.isSafeInteger(commentEvidence?.completionEventCount) &&
    commentEvidence.completionEventCount >= 3 &&
    commentEvidence.completionEventCount <= commentEvidence.timelineEventCount &&
    Array.isArray(eventKeys) &&
    eventKeys.length === commentEvidence.timelineEventCount &&
    eventKeys.every((key) =>
      typeof key === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}:(?:0|[1-9][0-9]{0,15})$/u.test(key)) &&
    new Set(eventKeys).size === eventKeys.length &&
    Array.isArray(eventKinds) &&
    eventKinds.includes("turn_completed") &&
    eventKinds.every((kind) =>
      kind === "warning_raised" ||
      kind === "error_raised" ||
      kind === "turn_completed");
  return Object.freeze({
    verdict:
      missing.length === 0 && converged && rootCommentsVerified
        ? "passed"
        : "failed",
    missingSteps: Object.freeze(missing),
    converged,
    rootCommentsVerified,
  });
}

export function coreLiveStepIds() {
  return [...REQUIRED_STEPS];
}
