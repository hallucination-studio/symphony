import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const CASE_ASSERTION_INDEX = Object.freeze({
  approved_happy_path: Object.freeze([
    ["plan_approval_precedes_work", "required", "ordered"],
    ["stage_chain_delivered", "required", "linked"],
    ["turn_usage_aggregated", "required", "aggregate"],
    ["boundary_in_review_delivery", "boundary", "linked"],
    ["work_before_approval", "prohibited", "ordered"],
    ["duplicate_or_synthetic_completion", "prohibited", "unique"],
    ["usage_missing_or_double_counted", "prohibited", "aggregate"],
  ]),
  plan_rejected_and_replanned: Object.freeze([
    ["rejection_consumed_and_replied", "required", "linked"],
    ["rejected_lineage_retained", "required", "archived"],
    ["rejected_contract_superseded", "required", "linked"],
    ["boundary_fresh_plan_review", "boundary", "linked"],
    ["work_against_rejected_contract", "prohibited", "linked"],
    ["contract_overwritten_or_history_deleted", "prohibited", "archived"],
    ["test_created_replacement", "prohibited", "equals"],
  ]),
  information_requested_and_answered: Object.freeze([
    ["information_action_actionable", "required", "linked"],
    ["answer_consumed_and_receipted", "required", "linked"],
    ["answer_drives_fresh_plan", "required", "linked"],
    ["boundary_fresh_plan_review", "boundary", "linked"],
    ["missing_answer_assumed", "prohibited", "equals"],
    ["test_unblocks_or_mutates_stage", "prohibited", "equals"],
  ]),
  root_revision_and_comment: Object.freeze([
    ["ordinary_inputs_consumed_once", "required", "unique"],
    ["thread_transitions_receipted", "required", "thread-state"],
    ["revision_supersedes_cycle", "required", "archived"],
    ["boundary_successor_plan_review", "boundary", "linked"],
    ["system_comment_treated_as_input", "prohibited", "equals"],
    ["thread_history_lost", "prohibited", "thread-state"],
    ["undeclared_revision_or_conductor_interpretation", "prohibited", "equals"],
  ]),
  parallel_multi_conductor: Object.freeze([
    ["root_ownership_and_workspace_isolated", "required", "unique"],
    ["independent_delivery_chains", "required", "linked"],
    ["cross_conductor_stage_overlap", "required", "interval-overlap"],
    ["boundary_all_roots_delivered", "boundary", "aggregate"],
    ["cross_conductor_takeover", "prohibited", "equals"],
    ["shared_workspace_writer", "prohibited", "unique"],
    ["telemetry_substitutes_overlap", "prohibited", "equals"],
  ]),
  same_conductor_preemption: Object.freeze([
    ["inflight_stage_completes", "required", "ordered"],
    ["latest_ready_root_runs_next", "required", "ordered"],
    ["remaining_ready_root_progresses", "required", "ordered"],
    ["boundary_all_roots_delivered", "boundary", "aggregate"],
    ["inflight_turn_interrupted", "prohibited", "equals"],
    ["test_selects_next_root", "prohibited", "equals"],
    ["semantic_requirement_touch", "prohibited", "equals"],
  ]),
  conductor_restart_recovery: Object.freeze([
    ["old_execution_terminal_once", "required", "unique"],
    ["recovery_uses_fresh_execution", "required", "linked"],
    ["ownership_persists", "required", "equals"],
    ["unaffected_root_continues", "required", "linked"],
    ["boundary_recovered_and_continuous_delivered", "boundary", "aggregate"],
    ["late_old_session_success", "prohibited", "unique"],
    ["checkpoint_or_linear_rewrite", "prohibited", "equals"],
    ["unaffected_conductor_reconfigured", "prohibited", "equals"],
  ]),
});

const COMMON_ASSERTIONS = Object.freeze([
  ["case_scope_isolated", "required", "equals"],
  ["requirement_input_preserved", "required", "equals"],
  ["durable_facts_correlated", "required", "linked"],
  ["final_evidence_complete", "required", "aggregate"],
  ["no_e2e_control_facts", "prohibited", "equals"],
]);

const TERMINAL_HUMAN_STATUSES = new Set(["Approved", "Rejected", "Answered", "Canceled"]);
const TERMINAL_STAGE_OUTCOMES = new Set(["canceled", "execution_failed"]);
const RECORD_KINDS = new Set([
  "root_ownership", "workflow_issue", "root_convergence_policy", "root_directive", "root_reconciler_failure",
  "root_reconciler_reply", "delivery", "workflow_timeline", "plan_contract", "plan_contract_supersession",
  "stage_execution", "stage_result", "human_action_request", "human_action_resolution", "finding",
  "finding_disposition", "verify_result", "progress_assessment", "cycle_outcome", "convergence",
]);

/**
 * The index mirrors only IDs, kinds and vocabulary selectors from architecture
 * section 9.2.  The condition implementations below consume final facts only.
 */
export function validateForegroundE2EAssertionCatalog(definitions) {
  if (!Array.isArray(definitions) || definitions.length !== Object.keys(CASE_ASSERTION_INDEX).length) {
    throw stableError("foreground_e2e_assertion_catalog_invalid");
  }
  const seenCases = new Set();
  for (const definition of definitions) {
    if (!definition || typeof definition.caseId !== "string" || seenCases.has(definition.caseId)) {
      throw stableError("foreground_e2e_assertion_catalog_invalid");
    }
    seenCases.add(definition.caseId);
    validateDefinition(definition);
  }
  if (seenCases.size !== Object.keys(CASE_ASSERTION_INDEX).length) {
    throw stableError("foreground_e2e_assertion_catalog_invalid");
  }
}

export function evaluateForegroundE2EAssertions({ definition, evidence, context } = {}) {
  validateDefinition(definition);
  const facts = createFacts(definition, evidence, context);
  return Object.freeze(definition.assertions.map((assertion) => evaluateAssertion(assertion, facts)));
}

export function deriveForegroundE2EVerdict(assertions, { deadlineExceeded = false } = {}) {
  if (!Array.isArray(assertions) || assertions.length === 0 || assertions.some((item) => !validAssertionOutcome(item))) {
    throw stableError("foreground_e2e_verdict_input_invalid");
  }
  if (assertions.some(({ outcome }) => outcome === "contradicted")) {
    return Object.freeze({ verdict: "failed", reasonCodes: failureCodes(assertions, "contradicted") });
  }
  if (deadlineExceeded || assertions.some(({ outcome }) => outcome === "coverage_missing")) {
    return Object.freeze({ verdict: "incomplete", reasonCodes: failureCodes(assertions, "coverage_missing") });
  }
  return Object.freeze({ verdict: "passed", reasonCodes: Object.freeze([]) });
}

/**
 * Starts every frozen Case before waiting for any outcome.  A rejected worker
 * still receives a fresh final read and therefore cannot bypass verdict rules.
 */
export async function runForegroundE2ECases({ definitions, runCase, readFinalEvidence, reporter, createCaseScope = defaultCaseScope, now = () => new Date().toISOString() } = {}) {
  validateForegroundE2EAssertionCatalog(definitions);
  if (typeof runCase !== "function" || typeof readFinalEvidence !== "function" ||
      reporter !== undefined && typeof reporter.caseObservation !== "function" || typeof createCaseScope !== "function" ||
      typeof now !== "function") {
    throw stableError("foreground_e2e_scheduler_input_invalid");
  }
  const startedAt = new Map();
  const settlements = await Promise.allSettled(definitions.map(async (definition) => {
    const started = timestamp(now());
    startedAt.set(definition.caseId, started);
    const scope = createCaseScope({ definition });
    if (!scope || scope.caseId !== definition.caseId || !scope.signal || typeof scope.signal.aborted !== "boolean") {
      throw stableError("foreground_e2e_case_scope_invalid");
    }
    observe(reporter, { caseId: definition.caseId, observation: "creating-root" });
    let driverResult;
    try {
      observe(reporter, { caseId: definition.caseId, observation: "running" });
      driverResult = await runCase({ definition, scope });
    } catch {}
    observe(reporter, { caseId: definition.caseId, observation: "final-reading" });
    let evidence;
    let finalReadError;
    try {
      evidence = await readFinalEvidence({ definition, scope });
    } catch (error) {
      finalReadError = error;
    }
    const assertions = finalReadError
      ? missingCoverageAssertions(definition)
      : evaluateForegroundE2EAssertions({ definition, evidence, context: driverResult?.context });
    const outcome = deriveForegroundE2EVerdict(assertions, {
      deadlineExceeded: driverResult?.deadlineExceeded === true,
    });
    observe(reporter, { caseId: definition.caseId, observation: outcome.verdict });
    return Object.freeze({
      caseId: definition.caseId,
      verdict: outcome.verdict,
      reasonCodes: outcome.reasonCodes,
      assertions,
      elapsedMs: elapsedMilliseconds(started, timestamp(now())),
    });
  }));
  const cases = settlements.map((settlement, index) => {
    if (settlement.status === "fulfilled") return settlement.value;
    const definition = definitions[index];
    const assertions = missingCoverageAssertions(definition);
    const outcome = deriveForegroundE2EVerdict(assertions);
    return Object.freeze({
      caseId: definition.caseId,
      verdict: outcome.verdict,
      reasonCodes: outcome.reasonCodes,
      assertions,
      elapsedMs: elapsedMilliseconds(startedAt.get(definition.caseId) ?? timestamp(now()), timestamp(now())),
    });
  });
  return Object.freeze({
    exitCode: cases.every(({ verdict }) => verdict === "passed") ? 0 : 1,
    cases: Object.freeze(cases),
  });
}

function evaluateAssertion(assertion, facts) {
  const result = facts.coverageMissing(assertion) ? "coverage_missing" : evaluateCoveredAssertion(assertion, facts);
  return Object.freeze({
    assertionId: assertion.assertionId,
    outcome: result,
    reasonCodePrefix: assertion.reasonCode,
    ...(result === "satisfied" ? {} : { reasonCode: `${assertion.reasonCode}.${result}` }),
    evidenceReferences: Object.freeze(facts.references(assertion)),
  });
}

function evaluateCoveredAssertion(assertion, facts) {
  const common = COMMON_HANDLERS[assertion.assertionId];
  if (common) return common(facts);
  const handler = CASE_HANDLERS[facts.definition.caseId]?.[assertion.assertionId];
  if (!handler) throw stableError("foreground_e2e_assertion_catalog_invalid");
  return handler(facts);
}

const COMMON_HANDLERS = Object.freeze({
  case_scope_isolated: (facts) => facts.scopeIsolated() ? "satisfied" : "contradicted",
  requirement_input_preserved: (facts) => facts.requirementsPreserved() ? "satisfied" : "contradicted",
  durable_facts_correlated: (facts) => facts.durableFactsCorrelated() ? "satisfied" : "contradicted",
  final_evidence_complete: (facts) => {
    if (facts.evidence.coverage?.isComplete !== true) return "coverage_missing";
    return facts.finalEvidenceComplete() ? "satisfied" : "contradicted";
  },
  no_e2e_control_facts: (facts) => facts.hasHumanManagedWrite() ? "contradicted" : "satisfied",
});

const CASE_HANDLERS = Object.freeze({
  approved_happy_path: Object.freeze({
    plan_approval_precedes_work: (facts) => facts.approvedPlan().everyWorkStartsAfterApproval ? "satisfied" : "contradicted",
    stage_chain_delivered: (facts) => facts.deliveryChain().complete ? "satisfied" : "contradicted",
    turn_usage_aggregated: (facts) => facts.usage().complete ? "satisfied" : "contradicted",
    boundary_in_review_delivery: (facts) => facts.deliveryChain().rootInReview ? "satisfied" : "contradicted",
    work_before_approval: (facts) => facts.approvedPlan().workBeforeApproval ? "contradicted" : "satisfied",
    duplicate_or_synthetic_completion: (facts) => facts.hasDuplicateOrSyntheticCompletion() ? "contradicted" : "satisfied",
    usage_missing_or_double_counted: (facts) => facts.usage().invalid ? "contradicted" : "satisfied",
  }),
  plan_rejected_and_replanned: Object.freeze({
    rejection_consumed_and_replied: (facts) => facts.rejectedPlan().consumedAndReplied ? "satisfied" : "contradicted",
    rejected_lineage_retained: (facts) => facts.rejectedPlan().lineageRetained ? "satisfied" : "contradicted",
    rejected_contract_superseded: (facts) => facts.rejectedPlan().superseded ? "satisfied" : "contradicted",
    boundary_fresh_plan_review: (facts) => facts.freshPlanReview().active ? "satisfied" : "contradicted",
    work_against_rejected_contract: (facts) => facts.rejectedPlan().workAgainstRejected ? "contradicted" : "satisfied",
    contract_overwritten_or_history_deleted: (facts) => facts.rejectedPlan().historyOverwritten ? "contradicted" : "satisfied",
    test_created_replacement: (facts) => facts.rejectedPlan().humanCreatedReplacement ? "contradicted" : "satisfied",
  }),
  information_requested_and_answered: Object.freeze({
    information_action_actionable: (facts) => facts.informationAnswer().actionable ? "satisfied" : "contradicted",
    answer_consumed_and_receipted: (facts) => facts.informationAnswer().consumedAndReceipted ? "satisfied" : "contradicted",
    answer_drives_fresh_plan: (facts) => facts.informationAnswer().drivesFreshPlan ? "satisfied" : "contradicted",
    boundary_fresh_plan_review: (facts) => facts.freshPlanReview().active ? "satisfied" : "contradicted",
    missing_answer_assumed: (facts) => facts.informationAnswer().assumedBeforeAnswer ? "contradicted" : "satisfied",
    test_unblocks_or_mutates_stage: (facts) => facts.hasHumanManagedWrite() ? "contradicted" : "satisfied",
  }),
  root_revision_and_comment: Object.freeze({
    ordinary_inputs_consumed_once: (facts) => facts.revision().inputsConsumedOnce ? "satisfied" : "contradicted",
    thread_transitions_receipted: (facts) => facts.revision().threadTransitionsReceipted ? "satisfied" : "contradicted",
    revision_supersedes_cycle: (facts) => facts.revision().supersedesCycle ? "satisfied" : "contradicted",
    boundary_successor_plan_review: (facts) => facts.revision().freshPlanReview ? "satisfied" : "contradicted",
    system_comment_treated_as_input: (facts) => facts.revision().systemCommentConsumed ? "contradicted" : "satisfied",
    thread_history_lost: (facts) => facts.revision().threadHistoryLost ? "contradicted" : "satisfied",
    undeclared_revision_or_conductor_interpretation: (facts) => facts.revision().undeclaredInputConsumed ? "contradicted" : "satisfied",
  }),
  parallel_multi_conductor: Object.freeze({
    root_ownership_and_workspace_isolated: (facts) => facts.parallel().ownershipIsolated ? "satisfied" : "contradicted",
    independent_delivery_chains: (facts) => facts.parallel().independentDeliveries ? "satisfied" : "contradicted",
    cross_conductor_stage_overlap: (facts) => facts.parallel().hasOverlap ? "satisfied" : "contradicted",
    boundary_all_roots_delivered: (facts) => facts.parallel().allDelivered ? "satisfied" : "contradicted",
    cross_conductor_takeover: (facts) => facts.parallel().takeover ? "contradicted" : "satisfied",
    shared_workspace_writer: (facts) => facts.parallel().sharedWorkspace ? "contradicted" : "satisfied",
    telemetry_substitutes_overlap: (facts) => facts.parallel().telemetrySubstitution ? "contradicted" : "satisfied",
  }),
  same_conductor_preemption: Object.freeze({
    inflight_stage_completes: (facts) => facts.preemption().inflightCompletes ? "satisfied" : "contradicted",
    latest_ready_root_runs_next: (facts) => facts.preemption().latestRunsNext ? "satisfied" : "contradicted",
    remaining_ready_root_progresses: (facts) => facts.preemption().remainingProgresses ? "satisfied" : "contradicted",
    boundary_all_roots_delivered: (facts) => facts.preemption().allDelivered ? "satisfied" : "contradicted",
    inflight_turn_interrupted: (facts) => facts.preemption().inflightInterrupted ? "contradicted" : "satisfied",
    test_selects_next_root: (facts) => facts.preemption().testSelectedNext ? "contradicted" : "satisfied",
    semantic_requirement_touch: (facts) => facts.preemption().semanticTouch ? "contradicted" : "satisfied",
  }),
  conductor_restart_recovery: Object.freeze({
    old_execution_terminal_once: (facts) => facts.recovery().oldTerminalOnce ? "satisfied" : "contradicted",
    recovery_uses_fresh_execution: (facts) => facts.recovery().freshExecution ? "satisfied" : "contradicted",
    ownership_persists: (facts) => facts.recovery().ownershipPersists ? "satisfied" : "contradicted",
    unaffected_root_continues: (facts) => facts.recovery().unaffectedContinues ? "satisfied" : "contradicted",
    boundary_recovered_and_continuous_delivered: (facts) => facts.recovery().allDelivered ? "satisfied" : "contradicted",
    late_old_session_success: (facts) => facts.recovery().lateOldSuccess ? "contradicted" : "satisfied",
    checkpoint_or_linear_rewrite: (facts) => facts.recovery().checkpointOrRewrite ? "contradicted" : "satisfied",
    unaffected_conductor_reconfigured: (facts) => facts.recovery().unaffectedReconfigured ? "contradicted" : "satisfied",
  }),
});

function createFacts(definition, evidence, context) {
  const roots = Array.isArray(evidence?.roots) ? evidence.roots : [];
  const rootIssueIds = Array.isArray(evidence?.rootIssueIds) ? evidence.rootIssueIds : [];
  const rootById = new Map(roots.filter(validRoot).map((root) => [root.rootIssueId, root]));
  const records = roots.flatMap((root) => Array.isArray(root.managedRecords)
    ? root.managedRecords.filter(validManagedRecord).map((entry) => ({ ...entry, root })) : []);
  const issues = roots.flatMap((root) => Array.isArray(root.issues) ? root.issues.map((item) => ({ ...item, root })) : []);
  const comments = roots.flatMap((root) => Array.isArray(root.comments) ? root.comments.map((item) => ({ ...item, root })) : []);
  const activity = roots.flatMap((root) => Array.isArray(root.activity) ? root.activity.map((item) => ({ ...item, root })) : []);
  const sourceById = new Map([...issues, ...comments].filter((item) => identifier(item.id)).map((item) => [item.id, item]));
  const scopeRootIds = new Set(rootIssueIds);
  const humanActorIds = new Set([context?.humanActorId, ...issues.filter(({ depth }) => depth === 0).map(({ creatorId }) => creatorId)]
    .filter(identifier));
  const base = {
    definition, evidence: evidence ?? {}, context: context ?? {}, roots, rootIssueIds, rootById, records, issues, comments,
    activity, sourceById, scopeRootIds, humanActorIds,
    recordsOf(kind, rootIssueId) {
      return records.filter((entry) => entry.record.kind === kind &&
        (rootIssueId === undefined || recordRootIssueId(entry) === rootIssueId));
    },
    issue(id) { return issues.find((item) => item.id === id); },
    comment(id) { return comments.find((item) => item.id === id); },
    rootIssue(rootIssueId) { return issues.find((item) => item.id === rootIssueId && item.depth === 0); },
    source(entry) { return sourceById.get(entry?.source?.id); },
    coverageMissing(assertion) { return assertion.assertionId !== "final_evidence_complete" && !assertionCoverageComplete(assertion, evidence, scopeRootIds); },
    references(assertion) { return referencesFor(assertion, records, issues, comments, scopeRootIds); },
    scopeIsolated() { return scopeIsolated(definition, evidence, roots, rootIssueIds, scopeRootIds); },
    finalEvidenceComplete() {
      return roots.length === rootIssueIds.length && rootIssueIds.every((rootIssueId) => rootById.has(rootIssueId)) &&
        Array.isArray(evidence?.statusCatalog) && evidence.statusCatalog.length > 0 &&
        Array.isArray(evidence?.git) && evidence.git.length === rootIssueIds.length &&
        roots.every((root) => Array.isArray(root.issues) && root.issues.length > 0 && Array.isArray(root.comments) &&
          Array.isArray(root.relations) && Array.isArray(root.activity) && Array.isArray(root.managedRecords));
    },
    requirementsPreserved() { return requirementsPreserved(definition, issues, comments, context, records); },
    durableFactsCorrelated() { return durableFactsCorrelated(records, issues, comments, sourceById, scopeRootIds); },
    hasHumanManagedWrite() { return records.some((entry) => humanActorIds.has(entry.sourceAuthorId ?? base.source(entry)?.authorId)); },
  };
  return Object.freeze({
    ...base,
    approvedPlan: () => approvedPlanFacts(base),
    deliveryChain: () => deliveryChainFacts(base),
    usage: () => usageFacts(base),
    hasDuplicateOrSyntheticCompletion: () => duplicateOrSyntheticCompletion(base),
    rejectedPlan: () => rejectedPlanFacts(base),
    freshPlanReview: () => freshPlanReviewFacts(base),
    informationAnswer: () => informationAnswerFacts(base),
    revision: () => revisionFacts(base),
    parallel: () => parallelFacts(base),
    preemption: () => preemptionFacts(base),
    recovery: () => recoveryFacts(base),
  });
}

function approvedPlanFacts(facts) {
  const rootId = onlyRootId(facts);
  const lineages = planReviewLineages(facts, rootId);
  const contracts = lineages.map(({ contract }) => contract);
  const actions = lineages.map(({ action }) => action);
  const resolutions = facts.recordsOf("human_action_resolution", rootId).filter(({ record }) => record.outcome === "approved" && record.terminal_status === "Approved");
  const matching = actions.filter(({ record }) => resolutions.some(({ record: resolution }) => resolution.action_id === record.action_id));
  const approval = matching.length === 1 ? resolutions.find(({ record }) => record.action_id === matching[0].record.action_id)?.record : undefined;
  const work = facts.recordsOf("stage_execution", rootId).filter(({ record }) => record.stage === "work");
  const approvalAt = parseTime(approval?.resolved_at);
  const workBeforeApproval = approvalAt !== undefined && work.some(({ record }) => parseTime(record.started_at) !== undefined && parseTime(record.started_at) < approvalAt);
  const everyWorkStartsAfterApproval = lineages.length === 1 &&
    matching.length === 1 && approvalAt !== undefined && work.length > 0 && !workBeforeApproval &&
    work.every(({ record }) => record.plan_contract_digest === contracts[0].plan_contract_digest && parseTime(record.started_at) > approvalAt);
  return { contracts, work, approval, workBeforeApproval, everyWorkStartsAfterApproval };
}

function deliveryChainFacts(facts, rootIssueId = onlyRootId(facts)) {
  const root = facts.rootIssue(rootIssueId);
  const cycles = facts.recordsOf("workflow_issue", rootIssueId).filter(({ record }) => record.issue_kind === "cycle");
  const workIssues = facts.recordsOf("workflow_issue", rootIssueId).filter(({ record }) => record.issue_kind === "work");
  const workResults = facts.recordsOf("stage_result", rootIssueId).filter(({ record }) => record.stage === "work" && record.outcome_kind === "work_completed");
  const verifies = facts.recordsOf("verify_result", rootIssueId).filter(({ record }) => record.conclusion === "passed");
  const verifyResults = facts.recordsOf("stage_result", rootIssueId).filter(({ record }) => record.stage === "verify" && record.outcome_kind === "verify_passed");
  const deliveries = facts.recordsOf("delivery", rootIssueId);
  const git = Array.isArray(facts.evidence.git) ? facts.evidence.git.filter((entry) => entry.rootIssueId === rootIssueId) : [];
  const matchingDelivery = deliveries.find(({ record }) => verifies.some(({ record: verify }) => verify.stage_execution_id === record.verify_result_id) &&
    verifyResults.some(({ record: result }) => result.verified_revision === record.verified_revision) && git.some(({ headRevision }) => headRevision === record.verified_revision));
  const rootInReview = root?.state?.name === "In Review" && Boolean(matchingDelivery) && verifies.length === 1 &&
    workIssues.every(({ record }) => workResults.some(({ record: result }) => result.node_issue_id === record.issue_key));
  return { complete: cycles.length > 0 && rootInReview, rootInReview, matchingDelivery };
}

function usageFacts(facts) {
  const stageResults = facts.recordsOf("stage_result");
  const stageTurns = stageResults.map(({ record }) => record.model_turn);
  const rootTurns = [
    ...facts.recordsOf("root_directive").map(({ record }) => record.model_turn),
    ...facts.recordsOf("root_reconciler_failure").map(({ record }) => record.model_turn),
  ];
  const allTurns = [...stageTurns, ...rootTurns];
  const malformed = allTurns.some((turn) => !turn || typeof turn.model !== "string" || !measuredUsage(turn.usage));
  const turnIds = allTurns.map((turn) => turn?.turn_record_id).filter(identifier);
  const duplicateTurn = new Set(turnIds).size !== turnIds.length;
  const outcomes = facts.recordsOf("cycle_outcome").map(({ record }) => record);
  const groups = outcomes.flatMap(({ budget_usage: usage }) => Array.isArray(usage?.groups) ? usage.groups : []);
  const groupedTotal = groups.reduce((total, group) => total + numeric(group.total_tokens), 0);
  const measuredTotal = stageTurns.reduce((total, turn) => total + numeric(turn?.usage?.total_tokens), 0);
  const complete = !malformed && !duplicateTurn && outcomes.length > 0 && groupedTotal === measuredTotal &&
    outcomes.every(({ budget_usage: usage }) => usage?.is_complete === true && numeric(usage?.unknown_turn_count) === 0) &&
    rootTurns.length > 0 && allTurns.every((turn) => identifier(turn?.turn_record_id));
  return { complete, invalid: malformed || duplicateTurn || (outcomes.length > 0 && groupedTotal !== measuredTotal) };
}

function duplicateOrSyntheticCompletion(facts) {
  const deliveries = facts.recordsOf("delivery");
  const passed = facts.recordsOf("verify_result").filter(({ record }) => record.conclusion === "passed");
  return deliveries.length > 1 || passed.length > 1 || facts.hasHumanManagedWrite();
}

function rejectedPlanFacts(facts) {
  const rootId = onlyRootId(facts);
  const requests = facts.recordsOf("human_action_request", rootId).filter(({ record }) => record.action_kind === "plan_review");
  const rejected = facts.recordsOf("human_action_resolution", rootId).filter(({ record }) => record.outcome === "rejected" && record.terminal_status === "Rejected");
  const rejection = rejected.find(({ record }) => requests.some(({ record: request }) => request.action_id === record.action_id));
  const oldContract = facts.recordsOf("plan_contract", rootId).find((entry) => facts.recordsOf("plan_contract_supersession", rootId)
    .some(({ record }) => record.superseded_plan_contract_digest === entry.record.plan_contract_digest));
  const supersession = oldContract && facts.recordsOf("plan_contract_supersession", rootId)
    .find(({ record }) => record.superseded_plan_contract_digest === oldContract.record.plan_contract_digest);
  const replacement = supersession && facts.recordsOf("plan_contract", rootId)
    .find(({ record }) => record.plan_contract_digest !== oldContract.record.plan_contract_digest);
  const replies = facts.recordsOf("root_reconciler_reply", rootId);
  const consumed = facts.recordsOf("root_directive", rootId).some(({ record }) => Array.isArray(record.consumed_input_ids) &&
    rejection?.record.source_comment_ids?.every((id) => record.consumed_input_ids.includes(id)));
  const oldAction = rejection && requests.find(({ record }) => record.action_id === rejection.record.action_id);
  const lineageRetained = Boolean(oldContract && oldAction && rejection && oldContract.source && oldAction.source && rejection.source);
  const workAgainstRejected = Boolean(oldContract && facts.recordsOf("stage_execution", rootId)
    .some(({ record }) => record.stage === "work" && record.plan_contract_digest === oldContract.record.plan_contract_digest));
  const historyOverwritten = Boolean(oldContract && !facts.source(oldContract));
  const humanCreatedReplacement = Boolean(replacement && facts.humanActorIds.has(facts.source(replacement)?.authorId));
  return {
    consumedAndReplied: Boolean(rejection && consumed && rejection.record.source_comment_ids?.every((id) => replies.some(({ record }) => record.source_input_id === id))),
    lineageRetained,
    superseded: Boolean(oldContract && supersession && replacement && replacement.record.plan_contract_digest !== oldContract.record.plan_contract_digest),
    workAgainstRejected,
    historyOverwritten,
    humanCreatedReplacement,
  };
}

function freshPlanReviewFacts(facts) {
  const rootId = onlyRootId(facts);
  const lineages = planReviewLineages(facts, rootId).filter(({ action }) => activeHumanAction(facts, action));
  return { active: lineages.length === 1 };
}

function planReviewLineages(facts, rootIssueId) {
  const contracts = facts.recordsOf("plan_contract", rootIssueId).filter((entry) => activeSource(facts, entry));
  const executions = facts.recordsOf("stage_execution", rootIssueId).filter(({ record }) => record.stage === "plan");
  const results = facts.recordsOf("stage_result", rootIssueId)
    .filter(({ record }) => record.stage === "plan" && record.outcome_kind === "plan_completed");
  const actions = facts.recordsOf("human_action_request", rootIssueId)
    .filter(({ record }) => record.action_kind === "plan_review");
  return contracts.flatMap((contractEntry) => {
    const contract = contractEntry.record;
    const planIssueId = contractEntry.issueId;
    const execution = executions.find(({ record }) => record.cycle_issue_id === contract.cycle_issue_id && record.node_issue_id === planIssueId);
    if (!execution) return [];
    const result = results.find(({ record }) =>
      record.cycle_issue_id === contract.cycle_issue_id && record.node_issue_id === planIssueId &&
      record.plan_contract_digest === contract.plan_contract_digest &&
      record.model_turn?.stage_execution_id === execution.record.stage_execution_id,
    );
    if (!result) return [];
    const action = actions.find(({ record }) => record.cycle_issue_id === contract.cycle_issue_id &&
      Array.isArray(record.related_issue_ids) && record.related_issue_ids.includes(planIssueId));
    return action ? [{ contractEntry, contract, execution, result, action }] : [];
  });
}

function informationAnswerFacts(facts) {
  const rootId = onlyRootId(facts);
  const requests = facts.recordsOf("human_action_request", rootId).filter(({ record }) => record.action_kind === "clarification");
  const request = requests[0];
  const issue = request && facts.issue(request.record.action_issue_id);
  const actionable = Boolean(issue && actionableActionDescription(issue.description));
  const answered = facts.recordsOf("human_action_resolution", rootId).find(({ record }) => record.action_id === request?.record.action_id && record.outcome === "answered" && record.terminal_status === "Answered");
  const sourceCommentId = answered?.record.source_comment_ids?.[0];
  const answer = sourceCommentId && facts.comment(sourceCommentId);
  const replies = facts.recordsOf("root_reconciler_reply", rootId).filter(({ record }) => record.source_input_id === sourceCommentId);
  const consumed = facts.recordsOf("root_directive", rootId).some(({ record }) => Array.isArray(record.consumed_input_ids) && record.consumed_input_ids.includes(sourceCommentId));
  const contract = facts.recordsOf("plan_contract", rootId).find(({ record }) => JSON.stringify(record).toLowerCase().includes("colon"));
  const answerAt = parseTime(answered?.record.resolved_at);
  const assumedBeforeAnswer = answerAt !== undefined && facts.recordsOf("stage_execution", rootId)
    .some(({ record }) => record.stage === "plan" && parseTime(record.started_at) < answerAt);
  return {
    actionable,
    consumedAndReceipted: Boolean(answer && answered && consumed && replies.length === 1 && replies[0].record.reaction !== "none"),
    drivesFreshPlan: Boolean(contract && facts.recordsOf("stage_execution", rootId).some(({ record }) => record.stage === "plan" && parseTime(record.started_at) > answerAt)),
    assumedBeforeAnswer,
  };
}

function revisionFacts(facts) {
  const rootId = onlyRootId(facts);
  const bindings = Array.isArray(facts.context.inputReferences) ? facts.context.inputReferences : undefined;
  if (!bindings) return { inputsConsumedOnce: false, threadTransitionsReceipted: false, supersedesCycle: false, freshPlanReview: false, systemCommentConsumed: false, threadHistoryLost: true, undeclaredInputConsumed: false };
  const replies = facts.recordsOf("root_reconciler_reply", rootId);
  const directives = facts.recordsOf("root_directive", rootId);
  const consumedIds = directives.flatMap(({ record }) => Array.isArray(record.consumed_input_ids) ? record.consumed_input_ids : []);
  const inputsConsumedOnce = bindings.every(({ sourceId }) => identifier(sourceId) && consumedIds.filter((id) => id === sourceId).length === 1 &&
    replies.filter(({ record }) => record.source_input_id === sourceId).length === 1);
  const threadBindings = bindings.filter(({ kind }) => kind === "thread_transition");
  const threadTransitionsReceipted = threadBindings.every(({ sourceId, commentId, expectedThreadState, remoteVersion }) => {
    const comment = facts.comment(commentId);
    return comment && replies.some(({ record }) => record.source_input_id === sourceId &&
      record.source?.kind === "comment_thread_state" && record.source.comment_id === commentId &&
      record.source.comment_remote_version === remoteVersion && record.source.thread_state === expectedThreadState &&
      record.thread_action === expectedThreadState);
  });
  const cycles = facts.recordsOf("workflow_issue", rootId).filter(({ record }) => record.issue_kind === "cycle");
  const cycleIssues = cycles.map(({ record }) => facts.issue(record.issue_key)).filter(Boolean);
  const terminal = cycleIssues.filter(({ state }) => ["Changes Required", "Canceled"].includes(state?.name));
  const successor = cycles.find(({ record }) => !terminal.some(({ id }) => id === record.issue_key));
  const supersedesCycle = terminal.length > 0 && Boolean(successor) && facts.recordsOf("plan_contract", rootId)
    .some(({ record }) => record.cycle_issue_id === successor.record.issue_key);
  const systemCommentConsumed = consumedIds.some((id) => {
    const comment = facts.comment(id);
    return comment && !facts.humanActorIds.has(comment.authorId);
  });
  const declared = new Set(bindings.map(({ sourceId }) => sourceId));
  const undeclaredInputConsumed = consumedIds.some((id) => !declared.has(id));
  const threadHistoryLost = bindings.some(({ sourceId, commentId, kind }) => kind === "comment_edit" && !facts.comment(commentId ?? sourceId)?.editedAt) ||
    threadBindings.some(({ commentId }) => facts.comment(commentId)?.thread?.state === "unknown");
  return {
    inputsConsumedOnce,
    threadTransitionsReceipted,
    supersedesCycle,
    freshPlanReview: supersedesCycle && freshPlanReviewFacts(facts).active,
    systemCommentConsumed,
    threadHistoryLost,
    undeclaredInputConsumed,
  };
}

function parallelFacts(facts) {
  const rootIds = facts.rootIssueIds;
  const ownership = rootIds.map((rootId) => facts.recordsOf("root_ownership", rootId));
  const ownerRecords = ownership.map((entries) => entries[0]?.record);
  const ownershipIsolated = ownership.every((entries) => entries.length === 1) &&
    new Set(ownerRecords.map((record) => record?.delivery_branch)).size === rootIds.length &&
    new Set(ownerRecords.map((record) => record?.conductor_id)).size === rootIds.length;
  const chains = rootIds.map((rootId) => deliveryChainFacts(facts, rootId));
  const intervals = stageIntervals(facts, rootIds);
  const hasOverlap = intervals.some((left, index) => intervals.slice(index + 1).some((right) =>
    left.conductorId !== right.conductorId && Math.max(left.startedAt, right.startedAt) < Math.min(left.completedAt, right.completedAt)));
  const takeover = ownerRecords.some((owner, index) => facts.recordsOf("root_ownership", rootIds[index]).some(({ record }) => record.conductor_id !== owner.conductor_id));
  return {
    ownershipIsolated,
    independentDeliveries: chains.every(({ complete }) => complete),
    hasOverlap,
    allDelivered: chains.every(({ rootInReview }) => rootInReview) && hasOverlap,
    takeover,
    sharedWorkspace: new Set(ownerRecords.map((record) => record?.delivery_branch)).size !== rootIds.length,
    telemetrySubstitution: !hasOverlap,
  };
}

function preemptionFacts(facts) {
  const binding = facts.context.preemption;
  if (!binding || !identifier(binding.inflightRootId) || !identifier(binding.touchedRootId) || !identifier(binding.remainingRootId) || !identifier(binding.inflightExecutionId)) {
    return { inflightCompletes: false, latestRunsNext: false, remainingProgresses: false, allDelivered: false, inflightInterrupted: false, testSelectedNext: false, semanticTouch: false };
  }
  const rootIds = [binding.inflightRootId, binding.touchedRootId, binding.remainingRootId];
  const inflightResult = facts.recordsOf("stage_result", binding.inflightRootId)
    .find(({ record }) => record.model_turn?.stage_execution_id === binding.inflightExecutionId || record.result_id === binding.inflightExecutionId);
  const terminalAt = parseTime(inflightResult?.record.completed_at);
  const touchedRoot = facts.rootIssue(binding.touchedRootId);
  const remainingRoot = facts.rootIssue(binding.remainingRootId);
  const touchActivity = facts.activity.find(({ id }) => id === binding.touchActivityId);
  const candidates = facts.recordsOf("stage_execution").filter(({ record }) => [binding.touchedRootId, binding.remainingRootId].includes(record.root_issue_id) && parseTime(record.started_at) > terminalAt)
    .sort((left, right) => parseTime(left.record.started_at) - parseTime(right.record.started_at));
  const firstCandidate = candidates[0];
  const original = facts.definition.initialRequirements.find(({ rootKey }) => rootKey === binding.touchedRootKey);
  const declaredTouch = facts.definition.declaredUserInteractions.find(({ kind }) => kind === "touch_bound_root_description")?.descriptionsByRootKey?.[binding.touchedRootKey];
  return {
    inflightCompletes: Boolean(inflightResult && !TERMINAL_STAGE_OUTCOMES.has(inflightResult.record.outcome_kind)),
    latestRunsNext: Boolean(touchActivity && terminalAt !== undefined && parseTime(touchActivity.createdAt) < terminalAt &&
      parseTime(touchedRoot?.updatedAt) > parseTime(remainingRoot?.updatedAt) && firstCandidate?.record.root_issue_id === binding.touchedRootId),
    remainingProgresses: deliveryChainFacts(facts, binding.remainingRootId).complete,
    allDelivered: rootIds.every((rootId) => deliveryChainFacts(facts, rootId).rootInReview),
    inflightInterrupted: Boolean(inflightResult && TERMINAL_STAGE_OUTCOMES.has(inflightResult.record.outcome_kind)),
    testSelectedNext: facts.activity.some(({ actorId, issueId, toPriority, toStateId, updatedDescription }) => facts.humanActorIds.has(actorId) &&
      rootIds.includes(issueId) && (toPriority !== null || toStateId !== null || (updatedDescription && issueId !== binding.touchedRootId))),
    semanticTouch: Boolean(original && declaredTouch && touchedRoot?.description !== declaredTouch),
  };
}

function recoveryFacts(facts) {
  const binding = facts.context.recovery;
  if (!binding || !identifier(binding.affectedRootId) || !identifier(binding.continuousRootId) || !identifier(binding.oldExecutionId) || !identifier(binding.oldRoleSessionId)) {
    return { oldTerminalOnce: false, freshExecution: false, ownershipPersists: false, unaffectedContinues: false, allDelivered: false, lateOldSuccess: false, checkpointOrRewrite: false, unaffectedReconfigured: false };
  }
  const oldResults = facts.recordsOf("stage_result", binding.affectedRootId).filter(({ record }) =>
    record.model_turn?.stage_execution_id === binding.oldExecutionId || record.result_id === binding.oldExecutionId);
  const oldSessionResults = facts.recordsOf("stage_result", binding.affectedRootId)
    .filter(({ record }) => record.role_session_id === binding.oldRoleSessionId);
  const oldTerminal = oldResults.filter(({ record }) => ["execution_failed", "canceled"].includes(record.outcome_kind));
  const replacement = facts.recordsOf("stage_result", binding.affectedRootId).find(({ record }) =>
    record.role_session_id !== binding.oldRoleSessionId && record.outcome_kind === "verify_passed");
  const affectedOwnership = facts.recordsOf("root_ownership", binding.affectedRootId).map(({ record }) => record);
  const continuousOwnership = facts.recordsOf("root_ownership", binding.continuousRootId).map(({ record }) => record);
  return {
    oldTerminalOnce: oldTerminal.length === 1 && !oldResults.some(({ record }) => record.outcome_kind === "verify_passed"),
    freshExecution: Boolean(replacement && deliveryChainFacts(facts, binding.affectedRootId).complete),
    ownershipPersists: affectedOwnership.length === 1,
    unaffectedContinues: deliveryChainFacts(facts, binding.continuousRootId).complete,
    allDelivered: deliveryChainFacts(facts, binding.affectedRootId).rootInReview && deliveryChainFacts(facts, binding.continuousRootId).rootInReview,
    lateOldSuccess: oldSessionResults.some(({ record }) => record.outcome_kind === "verify_passed"),
    checkpointOrRewrite: facts.records.some(({ record }) => String(record.kind).includes("checkpoint")) || facts.hasHumanManagedWrite(),
    unaffectedReconfigured: continuousOwnership.length !== 1,
  };
}

function assertionCoverageComplete(assertion, evidence, rootIds) {
  if (!evidence || evidence.caseId === undefined || !Array.isArray(evidence.roots) || !Array.isArray(evidence.rootIssueIds) ||
      !Array.isArray(evidence.coverage?.omissions)) return false;
  const relevant = evidence.coverage.omissions.filter((omission) => rootIds.has(omission?.rootIssueId));
  if (relevant.length === 0) return true;
  if (assertion.assertionId === "final_evidence_complete") return false;
  const scopes = new Set(relevant.map(({ scope }) => scope));
  if (["root", "tree", "children", "issue", "managed_record"].some((scope) => scopes.has(scope))) return false;
  if (assertion.factScope.includes("git") && scopes.has("git")) return false;
  if (assertion.factScope.some((scope) => ["comments", "reactions", "thread_state"].includes(scope)) &&
      (["comments", "comment_children", "reactions", "thread"].some((scope) => scopes.has(scope)))) return false;
  if (assertion.factScope.some((scope) => ["activity", "root_ownership", "routing"].includes(scope)) && scopes.has("activity")) return false;
  if (assertion.factScope.includes("relations") && scopes.has("relations")) return false;
  return true;
}

function scopeIsolated(definition, evidence, roots, rootIssueIds, scopeRootIds) {
  return evidence?.caseId === definition.caseId && rootIssueIds.length === definition.rootTopology.length &&
    new Set(rootIssueIds).size === rootIssueIds.length && roots.length === rootIssueIds.length &&
    roots.every((root) => scopeRootIds.has(root.rootIssueId) && Array.isArray(root.issues) &&
      root.issues.every((issue) => issue.rootIssueId === root.rootIssueId)) &&
    Array.isArray(evidence.git) && evidence.git.length === rootIssueIds.length &&
    new Set(evidence.git.map(({ rootIssueId }) => rootIssueId)).size === rootIssueIds.length &&
    evidence.git.every(({ rootIssueId }) => scopeRootIds.has(rootIssueId));
}

function requirementsPreserved(definition, issues, comments, context, records) {
  const inputs = definition.rootCreationInputs ?? [];
  if (inputs.length === 0) return false;
  for (const input of inputs) {
    const revision = definition.declaredUserInteractions?.find((interaction) => interaction.kind === "update_root_description" && interaction.rootKey === input.rootKey);
    const touch = definition.declaredUserInteractions?.find((interaction) => interaction.kind === "touch_bound_root_description")
      ?.descriptionsByRootKey?.[context?.preemption?.touchedRootKey === input.rootKey ? input.rootKey : ""];
    const expected = revision?.description ?? touch ?? input.description;
    const rootId = context?.rootIssueIdsByKey?.[input.rootKey];
    const root = (rootId && issues.find((issue) => issue.id === rootId)) ??
      issues.find((issue) => issue.depth === 0 && typeof issue.description === "string" && issue.description.includes(expected));
    if (!root || typeof root.description !== "string" || !root.description.includes(expected)) return false;
  }
  const edits = new Set((definition.declaredUserInteractions ?? [])
    .filter(({ kind }) => kind === "edit_comment").map(({ commentBinding }) => commentBinding));
  const bindings = Array.isArray(context?.inputReferences) ? context.inputReferences : [];
  const declaredComments = definition.declaredUserInteractions?.filter(({ kind }) => kind === "create_comment" || kind === "edit_comment") ?? [];
  return declaredComments.every((interaction) => {
    if (comments.some((comment) => comment.body === interaction.body)) return true;
    if (interaction.kind !== "create_comment" || !edits.has(interaction.commentBinding)) return false;
    const binding = bindings.find(({ kind, binding: inputBinding }) => kind === "comment_create" && inputBinding === interaction.commentBinding);
    return Boolean(binding && records.some(({ record }) => record.kind === "root_reconciler_reply" && record.source_input_id === binding.sourceId));
  });
}

function durableFactsCorrelated(records, issues, comments, sourceById, scopeRootIds) {
  if (issues.length === 0 || issues.some((issue) => !identifier(issue.id) || !identifier(issue.rootIssueId) || !timestamp(issue.remoteVersion))) return false;
  if (comments.some((comment) => !identifier(comment.id) || !identifier(comment.issueId) || !timestamp(comment.remoteVersion))) return false;
  return records.every((entry) => {
    const record = entry.record;
    const source = sourceById.get(entry.source?.id);
    return RECORD_KINDS.has(record.kind) && source && timestamp(entry.source?.remoteVersion) &&
      identifier(recordRootIssueId(entry)) && scopeRootIds.has(recordRootIssueId(entry)) &&
      entry.root?.rootIssueId === recordRootIssueId(entry);
  });
}

function activeSource(facts, entry) {
  return facts.source(entry)?.archivedAt === null;
}

function activeHumanAction(facts, entry) {
  const issue = facts.issue(entry.record.action_issue_id);
  return Boolean(issue && issue.archivedAt === null && !TERMINAL_HUMAN_STATUSES.has(issue.state?.name));
}

function actionableActionDescription(description) {
  if (typeof description !== "string") return false;
  return ["question", "required", "submit", "next"].every((word) => description.toLowerCase().includes(word));
}

function stageIntervals(facts, rootIssueIds) {
  const ownershipByRoot = new Map(rootIssueIds.map((rootId) => [rootId, facts.recordsOf("root_ownership", rootId)[0]?.record?.conductor_id]));
  return facts.recordsOf("stage_execution").flatMap(({ record }) => {
    const result = facts.recordsOf("stage_result", record.root_issue_id).find(({ record: candidate }) =>
      candidate.node_issue_id === record.node_issue_id && candidate.stage === record.stage && candidate.context_digest === record.context_digest);
    const startedAt = parseTime(record.started_at);
    const completedAt = parseTime(result?.record.completed_at);
    return startedAt !== undefined && completedAt !== undefined
      ? [{ rootIssueId: record.root_issue_id, conductorId: ownershipByRoot.get(record.root_issue_id), startedAt, completedAt }]
      : [];
  });
}

function referencesFor(assertion, records, issues, comments, rootIds) {
  const values = [
    ...issues.filter(({ rootIssueId }) => rootIds.has(rootIssueId)).map(({ id, remoteVersion }) => `issue:${id}@${remoteVersion}`),
    ...comments.filter(({ root }) => rootIds.has(root.rootIssueId)).map(({ id, remoteVersion }) => `comment:${id}@${remoteVersion}`),
    ...records.filter(({ root }) => rootIds.has(root.rootIssueId)).map(({ source }) => `${source.kind}:${source.id}@${source.remoteVersion}`),
  ];
  return [...new Set(values)].sort().slice(0, 64);
}

function missingCoverageAssertions(definition) {
  return Object.freeze(definition.assertions.map((assertion) => Object.freeze({
    assertionId: assertion.assertionId,
    outcome: "coverage_missing",
    reasonCodePrefix: assertion.reasonCode,
    reasonCode: `${assertion.reasonCode}.coverage_missing`,
    evidenceReferences: Object.freeze([]),
  })));
}

function observe(reporter, observation) {
  try {
    reporter?.caseObservation(observation);
  } catch {
    // Reporter output is diagnostic only and cannot suppress a required final read.
  }
}

function validateDefinition(definition) {
  const expected = CASE_ASSERTION_INDEX[definition?.caseId];
  const canonical = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === definition?.caseId);
  if (!expected || !Array.isArray(definition.assertions) || !Array.isArray(definition.rootTopology) ||
      definition.rootTopology.length === 0 || !canonical || !sameContractValue(definition, canonical)) {
    throw stableError("foreground_e2e_assertion_catalog_invalid");
  }
  const expectedById = new Map([...COMMON_ASSERTIONS, ...expected].map((entry) => [entry[0], entry]));
  if (definition.assertions.length !== expectedById.size) throw stableError("foreground_e2e_assertion_catalog_invalid");
  const seenAssertions = new Set();
  for (const assertion of definition.assertions) {
    const expectedAssertion = expectedById.get(assertion?.assertionId);
    if (!expectedAssertion || seenAssertions.has(assertion.assertionId) ||
        assertion.kind !== expectedAssertion[1] || assertion.predicate !== expectedAssertion[2] ||
        assertion.reasonCode !== `e2e.${definition.caseId}.${assertion.assertionId}` ||
        !stringList(assertion.factScope) || !stringList(assertion.correlation) || hasExecutableValue(assertion)) {
      throw stableError("foreground_e2e_assertion_catalog_invalid");
    }
    seenAssertions.add(assertion.assertionId);
  }
}

function hasExecutableValue(value) {
  if (typeof value === "function") return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(hasExecutableValue);
}

function sameContractValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((entry, index) => sameContractValue(entry, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] &&
    sameContractValue(left[key], right[key]));
}

function validRoot(root) { return root && identifier(root.rootIssueId); }
function validManagedRecord(entry) { return entry && entry.record && RECORD_KINDS.has(entry.record.kind) && entry.source && identifier(entry.source.id) && typeof entry.source.kind === "string" && timestamp(entry.source.remoteVersion); }
function recordRootIssueId(entry) { return entry?.record?.root_issue_id ?? entry?.root?.rootIssueId; }
function validAssertionOutcome(item) { return item && ["satisfied", "contradicted", "coverage_missing"].includes(item.outcome) && typeof item.reasonCodePrefix === "string"; }
function stringList(value) { return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0); }
function identifier(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value); }
function timestamp(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function parseTime(value) { return timestamp(value) ? Date.parse(value) : undefined; }
function numeric(value) { return Number.isFinite(value) ? value : Number.NaN; }
function measuredUsage(value) { return value?.status === "measured" && ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"].every((key) => Number.isFinite(value[key]) && value[key] >= 0); }
function onlyRootId(facts) { return facts.rootIssueIds.length === 1 ? facts.rootIssueIds[0] : undefined; }
function elapsedMilliseconds(startedAt, completedAt) { return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)); }
function failureCodes(assertions, outcome) { return Object.freeze(assertions.filter((item) => item.outcome === outcome).map(({ reasonCode }) => reasonCode).filter(Boolean).sort()); }
function stableError(code) { const error = new Error(code); error.code = code; return error; }

function defaultCaseScope({ definition }) {
  return Object.freeze({ caseId: definition.caseId, signal: new AbortController().signal });
}
