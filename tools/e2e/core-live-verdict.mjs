const REQUIRED_STEPS = Object.freeze([
  "project_created",
  "conductor_handshake",
  "profile_active",
  "root_created",
  "blocker_order_verified",
  "human_yield_verified",
  "priority_refresh_verified",
  "single_turn_lane_verified",
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
  const evidence = new Map(
    Array.isArray(result?.evidence)
      ? result.evidence.map((item) => [item?.step, item])
      : [],
  );
  const missing = REQUIRED_STEPS.filter(
    (step) => evidence.get(step)?.status !== "passed",
  );
  const converged = result?.performerResumed === true &&
    result?.rootState === "In Review" &&
    result?.phase === "in-review" &&
    typeof result?.deliveryBranch === "string" && result.deliveryBranch.length > 0;
  const commentEvidence = evidence.get("root_comments_verified");
  const eventKeys = commentEvidence?.eventKeys;
  const eventKinds = commentEvidence?.eventKinds;
  const rootCommentsVerified =
    Number.isSafeInteger(commentEvidence?.rootCount) &&
    commentEvidence.rootCount >= 3 &&
    commentEvidence?.primaryCommentCount === commentEvidence.rootCount &&
    Number.isSafeInteger(commentEvidence?.timelineEventCount) &&
    commentEvidence.timelineEventCount >= 3 &&
    Number.isSafeInteger(commentEvidence?.completionEventCount) &&
    commentEvidence.completionEventCount >= commentEvidence.rootCount + 2 &&
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
  const blocker = evidence.get("blocker_order_verified");
  const humanYield = evidence.get("human_yield_verified");
  const priorityRefresh = evidence.get("priority_refresh_verified");
  const lane = evidence.get("single_turn_lane_verified");
  const multiRootSchedulingVerified =
    blocker?.blockerPlanned === true &&
    blocker?.dependentUntouched === true &&
    humanYield?.waitingRootUnchanged === true &&
    humanYield?.yieldedRootPlanned === true &&
    priorityRefresh?.newWinnerSelected === true &&
    priorityRefresh?.previousWinnerUntouched === true &&
    Number.isSafeInteger(lane?.observedTurnCount) &&
    lane.observedTurnCount >= 5 &&
    lane?.maxActiveTurns === 1;
  return Object.freeze({
    verdict:
      missing.length === 0 &&
      converged &&
      rootCommentsVerified &&
      multiRootSchedulingVerified
        ? "passed"
        : "failed",
    missingSteps: Object.freeze(missing),
    converged,
    rootCommentsVerified,
    multiRootSchedulingVerified,
  });
}

export function coreLiveStepIds() {
  return [...REQUIRED_STEPS];
}
