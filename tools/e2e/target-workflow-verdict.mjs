const TARGET_WORKFLOW_SCENARIOS = Object.freeze([
  "success",
  "repair_escalation",
  "restart_recovery",
  "delivery",
  "scheduling",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/iu;

export { TARGET_WORKFLOW_SCENARIOS };

export function evaluateTargetWorkflowEvidence(input, { secrets = [] } = {}) {
  const failures = new Set();
  const evidence = input && typeof input === "object" ? input : {};
  const scenarioMap = new Map(
    Array.isArray(evidence.scenarios)
      ? evidence.scenarios.map((item) => [item?.scenario, item])
      : [],
  );
  const missingScenarios = TARGET_WORKFLOW_SCENARIOS.filter((scenario) =>
    scenarioMap.get(scenario)?.status !== "passed");

  if (missingScenarios.length > 0) failures.add("scenario_evidence_missing");
  if (!validRoot(evidence.root)) failures.add("root_evidence_invalid");
  if (!validStageExecutions(evidence, failures)) failures.add("stage_evidence_invalid");
  if (!validPlan(evidence, failures)) failures.add("plan_evidence_invalid");
  if (!validRecovery(evidence.recovery)) failures.add("stale_result_accepted");
  if (!validProgress(evidence, failures)) failures.add("progress_evidence_invalid");
  if (!validRepairEscalation(evidence)) failures.add("repair_escalation_evidence_invalid");
  if (!validBreaker(evidence.repairEscalation?.breaker)) failures.add("convergence_breaker_bypassed");
  if (!validDelivery(evidence)) failures.add("delivery_evidence_invalid");
  if (!deliveryRevisionMatches(evidence)) failures.add("delivery_revision_mismatch");
  if (!validScheduling(evidence.scheduling)) failures.add("scheduling_evidence_invalid");
  if (evidence.cleanup?.completed !== true) failures.add("cleanup_evidence_missing");
  if (containsSecret(evidence, secrets)) failures.add("secret_leaked");

  const scenarios = TARGET_WORKFLOW_SCENARIOS.map((scenario) => ({
    scenario,
    verdict: scenarioMap.get(scenario)?.status === "passed" &&
      !scenarioFailure(scenario, failures)
      ? "passed"
      : "failed",
  }));
  return Object.freeze({
    verdict: failures.size === 0 ? "passed" : "failed",
    missingScenarios: Object.freeze(missingScenarios),
    failures: Object.freeze([...failures].sort()),
    scenarios: Object.freeze(scenarios),
  });
}

function validRoot(root) {
  return root && typeof root === "object" &&
    SAFE_ID.test(root.projectId ?? "") && SAFE_ID.test(root.rootIssueId ?? "") &&
    SAFE_ID.test(root.cycleIssueId ?? "") && SAFE_ID.test(root.planIssueId ?? "") &&
    DIGEST.test(root.planContractDigest ?? "") && SAFE_ID.test(root.finalVerifyId ?? "") &&
    root.stageContextDigests && typeof root.stageContextDigests === "object" &&
    DIGEST.test(root.stageContextDigests.plan ?? "") &&
    DIGEST.test(root.stageContextDigests.verify ?? "") &&
    root.stageContextDigests.work && typeof root.stageContextDigests.work === "object" &&
    Object.keys(root.stageContextDigests.work).length > 0 &&
    Object.entries(root.stageContextDigests.work).every(([nodeIssueId, digest]) =>
      SAFE_ID.test(nodeIssueId) && DIGEST.test(digest));
}

function validStageExecutions(evidence, failures) {
  const stages = evidence.stageExecutions;
  if (!Array.isArray(stages) || stages.length < 3) return false;
  const root = evidence.root;
  const seenExecutionIds = new Set();
  const seenContexts = new Set();
  for (const execution of stages) {
    if (!execution || typeof execution !== "object" ||
        !SAFE_ID.test(execution.executionId ?? "") ||
        seenExecutionIds.has(execution.executionId) ||
        execution.rootIssueId !== root?.rootIssueId ||
        execution.cycleIssueId !== root?.cycleIssueId ||
        !SAFE_ID.test(execution.nodeIssueId ?? "") ||
        !["plan", "work", "verify"].includes(execution.stage) ||
        !DIGEST.test(execution.contextDigest ?? "") ||
        !DIGEST.test(execution.resultDigest ?? "") ||
        !SHA.test(execution.gitHead ?? "") || execution.result !== "completed" ||
        !SAFE_ID.test(execution.freshContextId ?? "") ||
        seenContexts.has(execution.freshContextId)) {
      return false;
    }
    seenExecutionIds.add(execution.executionId);
    seenContexts.add(execution.freshContextId);
  }
  const plan = stages.filter((stage) => stage.stage === "plan");
  const work = stages.filter((stage) => stage.stage === "work");
  const verify = stages.filter((stage) => stage.stage === "verify");
  const correlated = plan.length === 1 && verify.length === 1 && work.length > 0 &&
    plan[0].contextDigest === root?.stageContextDigests?.plan &&
    verify[0].contextDigest === root?.stageContextDigests?.verify &&
    work.every((stage) => stage.contextDigest === root?.stageContextDigests?.work?.[stage.nodeIssueId]);
  if (!correlated) failures.add("stage_context_correlation_invalid");
  if (verify[0]?.executionId !== root?.finalVerifyId) failures.add("verify_result_correlation_invalid");
  return plan.length === 1 && work.length > 0 && verify.length === 1 &&
    correlated && verify[0].executionId === root?.finalVerifyId;
}

function validPlan(evidence, failures) {
  const plan = evidence.plan;
  const root = evidence.root;
  const work = Array.isArray(plan?.workNodeIds) ? plan.workNodeIds : [];
  const verify = Array.isArray(plan?.verifyNodeIds) ? plan.verifyNodeIds : [];
  if (plan?.approved !== true || plan?.dagSealed !== true || work.length === 0 || verify.length === 0 ||
      new Set([...work, ...verify]).size !== work.length + verify.length ||
      !work.every((id) => SAFE_ID.test(id)) || !verify.every((id) => SAFE_ID.test(id))) return false;
  const stages = evidence.stageExecutions ?? [];
  return stages.some((stage) => stage.stage === "work" && work.includes(stage.nodeIssueId)) &&
    stages.some((stage) => stage.stage === "verify" && verify.includes(stage.nodeIssueId)) &&
    stages.some((stage) => stage.stage === "plan" && stage.nodeIssueId === root?.planIssueId);
}

function validRecovery(recovery) {
  return recovery?.staleResultRejected === true &&
    recovery?.rebuiltFromLinearAndGit === true && recovery?.freshContextUsed === true &&
    SAFE_ID.test(recovery?.recoveredExecutionId ?? "");
}

function validProgress(evidence, failures) {
  const progress = evidence.progress;
  const workIds = new Set((evidence.plan?.workNodeIds ?? []).filter((id) => SAFE_ID.test(id)));
  const sourceIds = Array.isArray(progress?.sourceExecutionIds) ? progress.sourceExecutionIds : [];
  const completed = (evidence.stageExecutions ?? []).filter((stage) =>
    stage.stage === "work" && stage.result === "completed" && workIds.has(stage.nodeIssueId));
  if (!Number.isSafeInteger(progress?.completedWorkNodes) ||
      progress.completedWorkNodes !== completed.length ||
      sourceIds.length !== completed.length ||
      new Set(sourceIds).size !== sourceIds.length ||
      !sourceIds.every((id) => completed.some((stage) => stage.executionId === id))) {
    failures.add("progress_evidence_invalid");
    return false;
  }
  return true;
}

function validRepairEscalation(evidence) {
  const repair = evidence.repairEscalation;
  const breaker = repair?.breaker;
  const verify = (evidence.stageExecutions ?? []).find((stage) => stage.stage === "verify");
  const valid = SAFE_ID.test(repair?.findingId ?? "") &&
    repair?.sourceVerifyId === verify?.nodeIssueId &&
    repair?.disposition === "escalated" && breaker?.checked === true &&
    breaker?.decision === "escalate" &&
    Number.isSafeInteger(breaker?.cycleCount) && Number.isSafeInteger(breaker?.maxCycles) &&
    breaker.cycleCount >= breaker.maxCycles &&
    Number.isSafeInteger(breaker?.openFindingCount) && breaker.openFindingCount > 0;
  return valid;
}

function validDelivery(evidence) {
  const delivery = evidence.delivery;
  const verify = (evidence.stageExecutions ?? []).find((stage) => stage.stage === "verify");
  const valid = ["local_branch", "remote_branch", "pull_request"].includes(delivery?.kind) &&
    SAFE_ID.test(delivery?.branch ?? "") && SHA.test(delivery?.head ?? "") &&
    delivery?.verifiedAgainst === verify?.nodeIssueId &&
    delivery?.readBack === true;
  return valid;
}

function validBreaker(breaker) {
  return breaker?.checked === true && breaker?.decision === "escalate" &&
    Number.isSafeInteger(breaker?.cycleCount) && Number.isSafeInteger(breaker?.maxCycles) &&
    breaker.cycleCount >= breaker.maxCycles &&
    Number.isSafeInteger(breaker?.openFindingCount) && breaker.openFindingCount > 0;
}

function deliveryRevisionMatches(evidence) {
  const verify = (evidence.stageExecutions ?? []).find((stage) => stage.stage === "verify");
  return SHA.test(evidence.delivery?.head ?? "") && evidence.delivery?.head === verify?.gitHead;
}

function validScheduling(scheduling) {
  return Array.isArray(scheduling?.selectedRootIds) && scheduling.selectedRootIds.length > 0 &&
    scheduling.selectedRootIds.every((id) => SAFE_ID.test(id)) &&
    Array.isArray(scheduling?.waitingRootIds) &&
    scheduling.waitingRootIds.every((id) => SAFE_ID.test(id)) &&
    Number.isSafeInteger(scheduling.maxConcurrentRoots) && scheduling.maxConcurrentRoots === 1 &&
    scheduling.blockerRespected === true;
}

function scenarioFailure(scenario, failures) {
  const scenarioFailures = {
    success: ["root_evidence_invalid", "plan_evidence_invalid", "stage_evidence_invalid"],
    repair_escalation: ["repair_escalation_evidence_invalid", "convergence_breaker_bypassed"],
    restart_recovery: ["stale_result_accepted"],
    delivery: ["delivery_evidence_invalid", "delivery_revision_mismatch"],
    scheduling: ["scheduling_evidence_invalid"],
  };
  return (scenarioFailures[scenario] ?? []).some((failure) => failures.has(failure));
}

function containsSecret(value, secrets) {
  const serialized = JSON.stringify(value);
  if (secrets.some((secret) => typeof secret === "string" && secret.length > 0 && serialized.includes(secret))) {
    return true;
  }
  return hasSecretKey(value);
}

function hasSecretKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasSecretKey);
  return Object.entries(value).some(([key, child]) => SECRET_KEY.test(key) || hasSecretKey(child));
}
