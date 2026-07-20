const REQUIRED_STEPS = Object.freeze([
  "project_created",
  "conductor_handshake",
  "profile_active",
  "conversation_pointer_verified",
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
  "broker_writes_verified",
  "root_comments_verified",
  "request_budget_verified",
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
    commentEvidence.timelineEventCount >= 0 &&
    Number.isSafeInteger(commentEvidence?.completionEventCount) &&
    commentEvidence.completionEventCount >= 0 &&
    commentEvidence.completionEventCount <= commentEvidence.timelineEventCount &&
    Array.isArray(eventKeys) &&
    eventKeys.length === commentEvidence.timelineEventCount &&
    eventKeys.every((key) =>
      typeof key === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}:(?:0|[1-9][0-9]{0,15})$/u.test(key)) &&
    new Set(eventKeys).size === eventKeys.length &&
    Array.isArray(eventKinds) &&
    eventKinds.every((kind) =>
      kind === "warning_raised" ||
      kind === "error_raised" ||
      kind === "turn_completed");
  const blocker = evidence.get("blocker_order_verified");
  const humanYield = evidence.get("human_yield_verified");
  const priorityRefresh = evidence.get("priority_refresh_verified");
  const lane = evidence.get("single_turn_lane_verified");
  const runtimeBudget = evidence.get("request_budget_verified");
  const conversation = evidence.get("conversation_pointer_verified");
  const brokerWrites = evidence.get("broker_writes_verified");
  const work = evidence.get("work_completed");
  const gate = evidence.get("root_gate_passed");
  const delivery = evidence.get("branch_delivered");
  const linearReview = evidence.get("linear_in_review");
  const correlatedTurnGroups = Array.isArray(brokerWrites?.turnCommands)
    ? brokerWrites.turnCommands
    : [];
  const deliveryTurnGroup = correlatedTurnGroups.find(
    (group) => group?.turnId === brokerWrites?.deliveryTurnId,
  );
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
  const runtimeBudgetVerified =
    Number.isSafeInteger(runtimeBudget?.totalRequests) && runtimeBudget.totalRequests > 0 &&
    Number.isSafeInteger(runtimeBudget?.requestCounts?.list_root_issues) &&
    runtimeBudget.requestCounts.list_root_issues > 0 &&
    Number.isSafeInteger(runtimeBudget?.requestCounts?.get_issue_tree) &&
    runtimeBudget.requestCounts.get_issue_tree > 0 &&
    Number.isSafeInteger(runtimeBudget?.discoveryObservations) &&
    runtimeBudget.discoveryObservations > 0 &&
    Number.isSafeInteger(runtimeBudget?.maxRootHeaderCount) &&
    runtimeBudget.maxRootHeaderCount >= 3 &&
    Number.isSafeInteger(runtimeBudget?.totalDiscoveryListPages) &&
    runtimeBudget.totalDiscoveryListPages > 0 &&
    runtimeBudget?.discoveryTreeRequests === 0 &&
    Number.isSafeInteger(runtimeBudget?.physicalRequestCount) &&
    runtimeBudget.physicalRequestCount > 0 && runtimeBudget.physicalRequestCount < 500 &&
    runtimeBudget?.physicalRequest429Count === 0 &&
    physicalRequestCountsValid(runtimeBudget) &&
    rateWindowValid(runtimeBudget?.requestWindowStart) &&
    rateWindowValid(runtimeBudget?.requestWindowEnd) &&
    rateWindowValid(runtimeBudget?.complexityWindowStart) &&
    rateWindowValid(runtimeBudget?.complexityWindowEnd) &&
    runtimeBudget?.stepDurationsMs &&
    ["conductor_handshake", "multi_root_scheduling", "root_completion"]
      .every((step) => Number.isSafeInteger(runtimeBudget.stepDurationsMs[step])
        && runtimeBudget.stepDurationsMs[step] >= 0) &&
    runtimeBudget?.stepRequestCounts &&
    ["multi_root_scheduling", "root_completion"].every((step) =>
      runtimeBudget.stepRequestCounts[step]
      && Object.values(runtimeBudget.stepRequestCounts[step]).some((count) =>
        Number.isSafeInteger(count) && count > 0));
  const v3FactsVerified = conversation?.pointerReadBack === true &&
    conversation?.firstTurnUsedPointer === true &&
    brokerWrites?.rootIssueId === result?.rootIssueId &&
    brokerWrites?.performerId === result?.performerId &&
    brokerWrites?.linearReadBack === true && brokerWrites?.gitReadBack === true &&
    brokerWrites?.deliveryReadBack === true &&
    Array.isArray(brokerWrites?.correlatedTurnIds) &&
    brokerWrites.correlatedTurnIds.length > 0 &&
    brokerWrites.correlatedTurnIds.every((turnId) =>
      typeof turnId === "string" && brokerWrites.correlatedTurnIds.indexOf(turnId) ===
        brokerWrites.correlatedTurnIds.lastIndexOf(turnId)) &&
    typeof brokerWrites?.deliveryTurnId === "string" &&
    brokerWrites.correlatedTurnIds.includes(brokerWrites.deliveryTurnId) &&
    correlatedTurnGroups.length === brokerWrites.correlatedTurnIds.length &&
    correlatedTurnGroups.every((group) =>
      typeof group?.turnId === "string" &&
      brokerWrites.correlatedTurnIds.includes(group.turnId) &&
      Array.isArray(group.commands)) &&
    deliveryTurnGroup?.commands.includes("git.commit") &&
    deliveryTurnGroup?.commands.includes("root.deliver") &&
    Array.isArray(brokerWrites?.appliedCommands) &&
    brokerWrites.appliedCommands.includes("git.commit") &&
    brokerWrites.appliedCommands.includes("root.deliver") &&
    brokerWrites.appliedCommands.some((command) =>
      typeof command === "string" && command.startsWith("linear.")) &&
    Number.isSafeInteger(work?.workNodeCount) && work.workNodeCount > 0 &&
    work?.allWorkDone === true && gate?.reworkCount === 0 &&
    gate?.phase === "in-review" && delivery?.branchCount === 1 &&
    delivery?.deliveredMarkerReadBack === true &&
    typeof delivery?.deliveryBranch === "string" &&
    linearReview?.rootState === "In Review" && linearReview?.phase === "in-review";
  return Object.freeze({
    verdict:
      missing.length === 0 &&
      converged &&
      rootCommentsVerified &&
      multiRootSchedulingVerified &&
      runtimeBudgetVerified &&
      v3FactsVerified
        ? "passed"
        : "failed",
    missingSteps: Object.freeze(missing),
    converged,
    rootCommentsVerified,
    multiRootSchedulingVerified,
    runtimeBudgetVerified,
    v3FactsVerified,
  });
}

function physicalRequestCountsValid(runtimeBudget) {
  const counts = runtimeBudget?.physicalRequestCounts;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) return false;
  const entries = Object.entries(counts);
  return entries.length > 0 && entries.every(([operation, count]) =>
    /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(operation) &&
    Number.isSafeInteger(count) && count > 0) &&
    entries.reduce((total, [, count]) => total + count, 0) ===
      runtimeBudget.physicalRequestCount;
}

function rateWindowValid(value) {
  return value !== null && typeof value === "object" &&
    Number.isSafeInteger(value.limit) && value.limit > 0 &&
    Number.isSafeInteger(value.remaining) && value.remaining >= 0 &&
    value.remaining <= value.limit &&
    Number.isSafeInteger(value.reset) && value.reset >= 0;
}

export function coreLiveStepIds() {
  return [...REQUIRED_STEPS];
}
