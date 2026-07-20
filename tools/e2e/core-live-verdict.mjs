const REQUIRED_STEPS = Object.freeze([
  "project_created",
  "conductor_handshake",
  "profile_active",
  "conversation_pointer_verified",
  "root_created",
  "first_managed_comment",
  "blocker_order_verified",
  "human_yield_verified",
  "priority_refresh_verified",
  "single_turn_lane_verified",
  "plan_ready",
  "plan_approved",
  "root_completion_evidence",
  "work_completed",
  "root_gate_passed",
  "branch_delivered",
  "linear_in_review",
  "broker_writes_verified",
  "root_comments_verified",
  "request_budget_verified",
  "cleanup_completed",
]);
const ROOT_GATE_CHECK_IDS = Object.freeze([
  "root-facts",
  "work-evidence",
  "git-checks",
  "blockers",
  "delivery",
]);
const ROOT_FILES_BY_PRIORITY = Object.freeze({
  1: "e2e-high.txt",
  2: "e2e-medium.txt",
  3: "e2e-low.txt",
});
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

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
  const rootCompletion = evidence.get("root_completion_evidence");
  const rootCompletionVerified = verifyRootCompletionEvidence(rootCompletion);
  const brokerRootFactsVerified = verifyBrokerRootFacts(
    brokerWrites?.rootFacts,
    rootCompletion?.roots,
  );
  const multiRootSchedulingVerified =
    blocker?.blockerPlanned === true &&
    blocker?.dependentUntouched === true &&
    blocker?.dependentChildCount === 0 &&
    blocker?.dependentManagedCommentAbsent === true &&
    blocker?.dependentPerformerAbsent === true &&
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
    Number.isSafeInteger(runtimeBudget?.firstManagedCommentDurationMs) &&
    runtimeBudget.firstManagedCommentDurationMs >= 0 &&
    runtimeBudget.firstManagedCommentDurationMs <= 30_000 &&
    Number.isSafeInteger(runtimeBudget?.firstPlanningTurnDurationMs) &&
    runtimeBudget.firstPlanningTurnDurationMs >= 0 &&
    runtimeBudget.firstPlanningTurnDurationMs <= 120_000 &&
    Number.isSafeInteger(runtimeBudget?.firstPlanningInputTokens) &&
    runtimeBudget.firstPlanningInputTokens >= 0 &&
    runtimeBudget.firstPlanningInputTokens <= 300_000 &&
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
    work?.planCreatedByBroker === true &&
    work?.allWorkDone === true && gate?.reworkCount === 0 &&
    gate?.gateCount === 3 && gate?.checklistChecked === true &&
    gate?.phase === "in-review" && delivery?.branchCount === 3 &&
    delivery?.deliveredMarkerReadBack === true &&
    typeof delivery?.deliveryBranch === "string" &&
    linearReview?.rootState === "In Review" && linearReview?.phase === "in-review" &&
    rootCompletionVerified && brokerRootFactsVerified;
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
    rootCompletionVerified,
    v3FactsVerified,
  });
}

function verifyRootCompletionEvidence(value) {
  if (value?.status !== "passed" || value.rootCount !== 3 ||
      !Array.isArray(value.roots) || value.roots.length !== 3 ||
      !sameArray(value.planningOrder, value.executionOrder)) return false;
  const roots = [...value.roots].sort((left, right) => (left?.priority ?? 99) - (right?.priority ?? 99));
  const rootIds = roots.map((root) => root?.root_issue_id);
  if (!sameArray(value.planningOrder, rootIds) || !sameArray(value.executionOrder, rootIds) ||
      new Set(rootIds).size !== 3 ||
      !roots.every((root, index) => validRootRecord(root, index + 1))) return false;
  return [
    "workspace_id",
    "delivery_branch",
    "delivery_head",
    "human_issue_id",
    "gate_issue_id",
  ].every((field) => new Set(roots.map((root) => root[field])).size === 3) &&
    new Set(roots.flatMap((root) => root.work_issue_ids)).size ===
      roots.reduce((total, root) => total + root.work_issue_ids.length, 0);
}

function validRootRecord(root, priority) {
  const startedAt = Date.parse(root?.started_at ?? "");
  const completedAt = Date.parse(root?.completed_at ?? "");
  const deliveryUrlValid = root?.delivery_kind === "pull_request"
    ? /^https:\/\/[A-Za-z0-9.-]{1,253}(?:\/[A-Za-z0-9._:/-]{0,512})?$/u.test(root.pull_request_url ?? "")
    : root?.pull_request_url === undefined;
  return root?.priority === priority && SAFE_ID.test(root.root_issue_id ?? "") &&
    SAFE_ID.test(root.root_identifier ?? "") && DIGEST.test(root.input_description_digest ?? "") &&
    Array.isArray(root.planning_turn_ids) && root.planning_turn_ids.length > 0 &&
    root.planning_turn_ids.every((turnId) => SAFE_ID.test(turnId)) &&
    Array.isArray(root.execution_turn_ids) && root.execution_turn_ids.length > 0 &&
    root.execution_turn_ids.every((turnId) => SAFE_ID.test(turnId)) &&
    SAFE_ID.test(root.performer_id ?? "") && SAFE_ID.test(root.workspace_id ?? "") &&
    ["local_branch", "remote_branch", "pull_request"].includes(root.delivery_kind) &&
    SAFE_BRANCH.test(root.delivery_branch ?? "") && SHA.test(root.delivery_head ?? "") &&
    Array.isArray(root.work_issue_ids) && root.work_issue_ids.length > 0 &&
    root.work_issue_ids.every((issueId) => SAFE_ID.test(issueId)) &&
    SAFE_ID.test(root.human_issue_id ?? "") && SAFE_ID.test(root.gate_issue_id ?? "") &&
    sameArray(root.gate_check_ids, ROOT_GATE_CHECK_IDS) && root.gate_all_checked === true &&
    sameArray(root.changed_paths, [ROOT_FILES_BY_PRIORITY[priority]]) &&
    DIGEST.test(root.output_digest ?? "") && root.root_state === "In Review" &&
    root.phase === "in-review" && deliveryUrlValid && Number.isSafeInteger(startedAt) &&
    Number.isSafeInteger(completedAt) && completedAt >= startedAt &&
    Number.isSafeInteger(root.duration_ms) && root.duration_ms === completedAt - startedAt;
}

function verifyBrokerRootFacts(facts, roots) {
  if (!Array.isArray(facts) || facts.length !== 3 || !Array.isArray(roots) || roots.length !== 3) {
    return false;
  }
  const rootById = new Map(roots.map((root) => [root.root_issue_id, root]));
  return new Set(facts.map((fact) => fact?.rootIssueId)).size === 3 && facts.every((fact) => {
    const root = rootById.get(fact?.rootIssueId);
    return root && fact.performerId === root.performer_id &&
      fact.linearReadBack === true && fact.gitReadBack === true &&
      fact.deliveryReadBack === true && fact.planCreatedByBroker === true &&
      Array.isArray(fact.correlatedTurnIds) && fact.correlatedTurnIds.length > 0 &&
      fact.correlatedTurnIds.every((turnId) => SAFE_ID.test(turnId));
  });
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
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
