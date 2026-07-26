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
const PARALLEL_ASSERTION_IDS = new Set(CASE_ASSERTION_INDEX.parallel_multi_conductor.map(([assertionId]) => assertionId));

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
    boundary_fresh_plan_review: (facts) => facts.rejectedPlan().freshPlanReviewActive ? "satisfied" : "contradicted",
    work_against_rejected_contract: (facts) => facts.rejectedPlan().workAgainstRejected ? "contradicted" : "satisfied",
    contract_overwritten_or_history_deleted: (facts) => facts.rejectedPlan().historyOverwritten ? "contradicted" : "satisfied",
    test_created_replacement: (facts) => facts.rejectedPlan().humanCreatedReplacement ? "contradicted" : "satisfied",
  }),
  information_requested_and_answered: Object.freeze({
    information_action_actionable: (facts) => facts.informationAnswer().actionable ? "satisfied" : "contradicted",
    answer_consumed_and_receipted: (facts) => facts.informationAnswer().consumedAndReceipted ? "satisfied" : "contradicted",
    answer_drives_fresh_plan: (facts) => facts.informationAnswer().drivesFreshPlan ? "satisfied" : "contradicted",
    boundary_fresh_plan_review: (facts) => facts.informationAnswer().freshPlanReviewActive ? "satisfied" : "contradicted",
    missing_answer_assumed: (facts) => facts.informationAnswer().assumedBeforeAnswer ? "contradicted" : "satisfied",
    test_unblocks_or_mutates_stage: (facts) => facts.informationAnswer().humanCreatedContinuation ? "contradicted" : "satisfied",
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
    coverageMissing(assertion) {
      return assertion.assertionId !== "final_evidence_complete" &&
        (!assertionCoverageComplete(assertion, evidence, scopeRootIds) ||
          definition.caseId === "parallel_multi_conductor" && PARALLEL_ASSERTION_IDS.has(assertion.assertionId) &&
            !parallelFacts(base).coverageComplete ||
          definition.caseId === "same_conductor_preemption" && !preemptionFacts(base).coverageComplete);
    },
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
    approvedPlan: (rootIssueId) => approvedPlanFacts(base, rootIssueId),
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

function approvedPlanFacts(facts, rootId = onlyRootId(facts)) {
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
  return { contracts, actions, work, approval, workBeforeApproval, everyWorkStartsAfterApproval };
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
  const rootId = onlyRootId(facts);
  const stageResults = facts.recordsOf("stage_result", rootId);
  const stageTurns = stageResults.map(({ record }) => record.model_turn);
  const rootTurns = [
    ...facts.recordsOf("root_directive", rootId).map(({ record }) => record.model_turn),
    ...facts.recordsOf("root_reconciler_failure", rootId).map(({ record }) => record.model_turn),
  ];
  const allTurns = [...stageTurns, ...rootTurns];
  const malformed = allTurns.some((turn) => !turn || typeof turn.model !== "string" || !measuredUsage(turn.usage));
  const turnIds = allTurns.map((turn) => turn?.turn_record_id).filter(identifier);
  const duplicateTurn = new Set(turnIds).size !== turnIds.length;
  const outcomes = facts.recordsOf("cycle_outcome", rootId).map(({ record }) => record);
  const stageUsageRendered = stageResults.every(stageUsageReadBack);
  const expectedByCycle = expectedCycleUsage(stageTurns);
  const cycleUsageMatches = expectedByCycle.size > 0 && expectedByCycle.size === outcomes.length &&
    [...expectedByCycle.entries()].every(([cycleIssueId, expected]) => {
      const outcome = outcomes.find(({ cycle_issue_id }) => cycle_issue_id === cycleIssueId);
      return outcome && cycleOutcomeMatches(outcome, expected) && timelineUsageMatches(
        facts.recordsOf("workflow_timeline", rootId),
        { timelineKind: "cycle", targetIssueId: cycleIssueId, label: "Cycle cumulative", expected },
      );
    });
  const rootExpected = aggregateUsageGroups(allTurns);
  const rootUsageMatches = rootTurns.length > 0 && timelineUsageMatches(
    facts.recordsOf("workflow_timeline", rootId),
    { timelineKind: "root", targetIssueId: rootId, label: "Root cumulative", expected: rootExpected },
  );
  const complete = !malformed && !duplicateTurn && stageUsageRendered && cycleUsageMatches && rootUsageMatches &&
    allTurns.every((turn) => identifier(turn?.turn_record_id));
  return { complete, invalid: !complete };
}

function stageUsageReadBack(entry) {
  const turn = entry.record.model_turn;
  return entry.issueId === entry.record.node_issue_id && typeof entry.markdown === "string" &&
    entry.markdown.includes("**Usage**") && entry.markdown.includes(`- Model: \`${turn?.model}\``) &&
    entry.markdown.includes(`- This turn: ${turn?.usage?.total_tokens} tokens`) && entry.markdown.includes("- This Issue:");
}

function expectedCycleUsage(stageTurns) {
  const byCycle = new Map();
  for (const turn of stageTurns) {
    if (!identifier(turn?.cycle_issue_id)) return new Map();
    const turns = byCycle.get(turn.cycle_issue_id) ?? [];
    turns.push(turn);
    byCycle.set(turn.cycle_issue_id, turns);
  }
  return new Map([...byCycle.entries()].map(([cycleIssueId, turns]) => [cycleIssueId, aggregateUsageGroups(turns)]));
}

function aggregateUsageGroups(turns) {
  const groups = new Map();
  for (const turn of turns) {
    const usage = turn?.usage;
    if (!turn || !measuredUsage(usage)) return new Map();
    const key = `${turn.role}\u0000${turn.model}`;
    const group = groups.get(key) ?? {
      role: turn.role,
      model: turn.model,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };
    group.inputTokens += usage.input_tokens;
    group.cachedInputTokens += usage.cached_input_tokens;
    group.outputTokens += usage.output_tokens;
    group.reasoningOutputTokens += usage.reasoning_output_tokens;
    group.totalTokens += usage.total_tokens;
    groups.set(key, group);
  }
  return groups;
}

function cycleOutcomeMatches(outcome, expected) {
  const usage = outcome?.budget_usage;
  if (usage?.is_complete !== true || numeric(usage.unknown_turn_count) !== 0 || !Array.isArray(usage.groups)) return false;
  const actual = new Map();
  for (const group of usage.groups) {
    if (!group || typeof group.role !== "string" || typeof group.model !== "string" || numeric(group.unavailable_turn_count) !== 0) return false;
    const key = `${group.role}\u0000${group.model}`;
    if (actual.has(key)) return false;
    actual.set(key, {
      inputTokens: numeric(group.input_tokens),
      cachedInputTokens: numeric(group.cached_input_tokens),
      outputTokens: numeric(group.output_tokens),
      reasoningOutputTokens: numeric(group.reasoning_output_tokens),
      totalTokens: numeric(group.total_tokens),
    });
  }
  return sameUsageGroups(actual, expected);
}

function timelineUsageMatches(entries, { timelineKind, targetIssueId, label, expected }) {
  return entries.some((entry) => entry.issueId === targetIssueId && entry.record.timeline_kind === timelineKind &&
    entry.record.target_issue_id === targetIssueId && renderedUsageGroups(entry.markdown, label, expected));
}

function renderedUsageGroups(markdown, label, expected) {
  if (typeof markdown !== "string" || expected.size === 0) return false;
  const match = markdown.match(new RegExp(`(?:^|\\n)- ${escapeRegExp(label)} \\(complete\\): ([^\\n]+)`, "u"));
  if (!match) return false;
  const actual = new Map();
  for (const group of match[1].split("; ")) {
    const parsed = group.match(/^(.+) · ([^·]+) · (\d+) tokens$/u);
    if (!parsed) return false;
    const role = parsed[1];
    const model = parsed[2];
    const key = `${role}\u0000${model}`;
    if (actual.has(key)) return false;
    actual.set(key, Number.parseInt(parsed[3], 10));
  }
  if (actual.size !== expected.size) return false;
  return [...expected.values()].every(({ role, model, totalTokens }) => actual.get(`${displayRole(role)}\u0000${model}`) === totalTokens);
}

function sameUsageGroups(actual, expected) {
  if (actual.size !== expected.size) return false;
  return [...expected.entries()].every(([key, expectedGroup]) => {
    const actualGroup = actual.get(key);
    return actualGroup && actualGroup.inputTokens === expectedGroup.inputTokens &&
      actualGroup.cachedInputTokens === expectedGroup.cachedInputTokens &&
      actualGroup.outputTokens === expectedGroup.outputTokens &&
      actualGroup.reasoningOutputTokens === expectedGroup.reasoningOutputTokens &&
      actualGroup.totalTokens === expectedGroup.totalTokens;
  });
}

function displayRole(role) {
  return role === "root_reconciler" ? "Root Reconciler" : role[0]?.toUpperCase() + role.slice(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function duplicateOrSyntheticCompletion(facts) {
  const deliveries = facts.recordsOf("delivery");
  const passed = facts.recordsOf("verify_result").filter(({ record }) => record.conclusion === "passed");
  return deliveries.length > 1 || passed.length > 1 || facts.hasHumanManagedWrite();
}

function rejectedPlanFacts(facts) {
  const rootId = onlyRootId(facts);
  const input = rejectedPlanInput(facts, rootId);
  if (!identifier(rootId) || !input) return rejectedPlanFailureFacts();
  const requests = facts.recordsOf("human_action_request", rootId).filter(({ record }) => record.action_kind === "plan_review");
  const oldRequest = only(requests.filter(({ record }) => record.action_issue_id === input.rejectedActionIssueId));
  const rejected = facts.recordsOf("human_action_resolution", rootId).filter(({ record }) =>
    record.action_issue_id === input.rejectedActionIssueId && record.outcome === "rejected" && record.terminal_status === "Rejected",
  );
  const rejection = only(rejected);
  const oldPlanIssueId = only(oldRequest?.record.related_issue_ids ?? []);
  const oldAction = facts.issue(input.rejectedActionIssueId);
  const reason = facts.comment(input.commentId);
  const replies = facts.recordsOf("root_reconciler_reply", rootId);
  const consumedIds = facts.recordsOf("root_directive", rootId).flatMap(({ record }) =>
    Array.isArray(record.consumed_input_ids) ? record.consumed_input_ids : [],
  );
  const consumed = consumedIds.filter((id) => id === input.sourceId).length === 1;
  const replied = replies.filter(({ record }) => record.source_input_id === input.sourceId &&
    record.target_issue_id === input.rejectedActionIssueId).length === 1;
  const rejectionMatchesInput = Boolean(rejection && oldRequest && reason && reason.issueId === input.rejectedActionIssueId &&
    reason.body === frozenActionCommentBody(facts.definition, "rejection_reason") && facts.humanActorIds.has(reason.authorId) &&
    exactList(rejection.record.source_comment_ids, [input.sourceId]));

  const contracts = facts.recordsOf("plan_contract", rootId);
  const supersessions = facts.recordsOf("plan_contract_supersession", rootId);
  const oldContract = only(contracts.filter((entry) =>
    entry.record.cycle_issue_id === oldRequest?.record.cycle_issue_id && entry.issueId === oldPlanIssueId,
  ));
  const supersession = oldContract && only(supersessions.filter(({ record }) =>
    record.superseded_plan_contract_digest === oldContract.record.plan_contract_digest,
  ));
  const oldExecution = oldContract && only(facts.recordsOf("stage_execution", rootId).filter(({ record }) =>
    record.stage === "plan" && record.cycle_issue_id === oldContract.record.cycle_issue_id &&
    record.node_issue_id === oldPlanIssueId,
  ));
  const oldResult = oldContract && oldExecution && only(facts.recordsOf("stage_result", rootId).filter(({ record }) =>
    record.stage === "plan" && record.cycle_issue_id === oldContract.record.cycle_issue_id &&
    record.node_issue_id === oldPlanIssueId && record.plan_contract_digest === oldContract.record.plan_contract_digest &&
    record.model_turn?.stage_execution_id === oldExecution.record.stage_execution_id,
  ));
  const lineageRetained = Boolean(oldContract && oldRequest && rejection && oldAction && oldExecution && oldResult &&
    facts.source(oldContract) && facts.source(oldRequest) && facts.source(rejection) && facts.source(oldExecution) && facts.source(oldResult));

  const replacement = supersession && only(contracts.filter((entry) =>
    entry.record.plan_contract_digest !== oldContract.record.plan_contract_digest &&
    entry.issueId === supersession.record.fresh_plan_issue_id,
  ));
  const replacementExecution = replacement && only(facts.recordsOf("stage_execution", rootId).filter(({ record }) =>
    record.stage === "plan" && record.cycle_issue_id === replacement.record.cycle_issue_id &&
    record.node_issue_id === supersession.record.fresh_plan_issue_id && record.stage_execution_id !== oldExecution?.record.stage_execution_id,
  ));
  const replacementResult = replacement && replacementExecution && only(facts.recordsOf("stage_result", rootId).filter(({ record }) =>
    record.stage === "plan" && record.cycle_issue_id === replacement.record.cycle_issue_id &&
    record.node_issue_id === supersession.record.fresh_plan_issue_id &&
    record.plan_contract_digest === replacement.record.plan_contract_digest &&
    record.model_turn?.stage_execution_id === replacementExecution.record.stage_execution_id,
  ));
  const replacementAction = replacement && only(requests.filter(({ record }) =>
    record.action_issue_id === input.replacementActionIssueId && record.cycle_issue_id === replacement.record.cycle_issue_id &&
    Array.isArray(record.related_issue_ids) && record.related_issue_ids.includes(supersession.record.fresh_plan_issue_id),
  ));
  const replacementActionIssue = facts.issue(input.replacementActionIssueId);
  const replacementFacts = [replacement, replacementExecution, replacementResult, replacementAction];
  const replacementWrittenByHuman = replacementFacts.some((entry) => entry && facts.humanActorIds.has(facts.source(entry)?.authorId)) ||
    facts.humanActorIds.has(replacementActionIssue?.creatorId);
  const superseded = Boolean(lineageRetained && replacement && replacementExecution && replacementResult && replacementAction &&
    replacement.record.plan_contract_digest !== oldContract.record.plan_contract_digest &&
    input.rejectedActionIssueId !== input.replacementActionIssueId && !replacementWrittenByHuman);
  const workAgainstRejected = Boolean(oldContract && facts.recordsOf("stage_execution", rootId)
    .some(({ record }) => record.stage === "work" && record.plan_contract_digest === oldContract.record.plan_contract_digest));
  const historyOverwritten = !lineageRetained;
  return {
    consumedAndReplied: rejectionMatchesInput && consumed && replied,
    lineageRetained,
    superseded,
    freshPlanReviewActive: Boolean(superseded && replacementAction && activeHumanAction(facts, replacementAction)),
    workAgainstRejected,
    historyOverwritten,
    humanCreatedReplacement: replacementWrittenByHuman,
  };
}

function rejectedPlanInput(facts, rootId) {
  const context = facts.context;
  const bindings = Array.isArray(context?.inputReferences) ? context.inputReferences : [];
  const reason = only(bindings.filter(({ sourceId, kind, binding, commentId }) =>
    kind === "comment_create" && binding === "rejection_reason" && identifier(sourceId) && sourceId === commentId,
  ));
  if (reason && identifier(context?.rejectedActionIssueId) && identifier(context?.replacementActionIssueId) &&
      context.rejectedActionIssueId !== context.replacementActionIssueId) {
    return { ...reason, rejectedActionIssueId: context.rejectedActionIssueId, replacementActionIssueId: context.replacementActionIssueId };
  }
  if (Array.isArray(context?.inputReferences) || context?.rejectedActionIssueId !== undefined ||
      context?.replacementActionIssueId !== undefined) return undefined;

  const rejected = facts.recordsOf("human_action_resolution", rootId).filter(({ record }) =>
    record.outcome === "rejected" && record.terminal_status === "Rejected" && exactList(record.source_comment_ids, [record.source_comment_ids?.[0]]),
  );
  const resolution = only(rejected);
  const sourceId = resolution?.record.source_comment_ids?.[0];
  const requests = facts.recordsOf("human_action_request", rootId).filter(({ record }) => record.action_kind === "plan_review");
  const oldRequest = only(requests.filter(({ record }) => record.action_issue_id === resolution?.record.action_issue_id));
  const replacement = only(requests.filter(({ record }) => record.action_issue_id !== resolution?.record.action_issue_id &&
    activeHumanAction(facts, { record }),
  ));
  if (!resolution || !oldRequest || !replacement || !identifier(sourceId) ||
      facts.comment(sourceId)?.body !== frozenActionCommentBody(facts.definition, "rejection_reason")) return undefined;
  return {
    sourceId,
    kind: "comment_create",
    binding: "rejection_reason",
    commentId: sourceId,
    rejectedActionIssueId: resolution.record.action_issue_id,
    replacementActionIssueId: replacement.record.action_issue_id,
  };
}

function rejectedPlanFailureFacts() {
  return {
    consumedAndReplied: false,
    lineageRetained: false,
    superseded: false,
    freshPlanReviewActive: false,
    workAgainstRejected: false,
    historyOverwritten: true,
    humanCreatedReplacement: false,
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
  const input = informationAnswerInput(facts, rootId);
  if (!identifier(rootId) || !input) {
    return informationAnswerFailureFacts(facts, rootId);
  }
  const requests = facts.recordsOf("human_action_request", rootId).filter(({ record }) =>
    record.action_kind === "clarification" && record.action_issue_id === input.answeredActionIssueId,
  );
  const request = only(requests);
  const issue = facts.issue(input.answeredActionIssueId);
  const resolutions = facts.recordsOf("human_action_resolution", rootId).filter(({ record }) =>
    record.action_id === request?.record.action_id && record.action_issue_id === input.answeredActionIssueId &&
    record.outcome === "answered" && record.terminal_status === "Answered" && exactList(record.source_comment_ids, [input.sourceId]),
  );
  const resolution = only(resolutions);
  const answer = facts.comment(input.commentId);
  const answerAt = parseTime(resolution?.record.resolved_at);
  const actionable = Boolean(request && issue && actionableActionDescription(issue.description) && issue.state?.name === "Answered" &&
    !facts.humanActorIds.has(issue.creatorId) && !facts.humanActorIds.has(facts.source(request)?.authorId));
  const answerMatches = Boolean(request && resolution && answer && answer.issueId === input.answeredActionIssueId &&
    answer.body === frozenActionCommentBody(facts.definition, "separator_answer") && facts.humanActorIds.has(answer.authorId));
  const directives = facts.recordsOf("root_directive", rootId).filter(({ record }) =>
    exactList(record.consumed_input_ids, [input.sourceId]),
  );
  const directive = only(directives);
  const consumed = Boolean(directive && answerAt !== undefined && parseTime(directive.record.accepted_at) > answerAt);
  const replies = facts.recordsOf("root_reconciler_reply", rootId).filter(({ record }) => record.source_input_id === input.sourceId);
  const reply = only(replies);
  const receipted = Boolean(reply && reply.record.target_issue_id === input.answeredActionIssueId &&
    reply.record.disposition === "accepted" && reply.record.reaction === "check");
  const lineage = informationPlanLineage(facts, rootId, input, answerAt);
  const humanCreatedContinuation = informationContinuationWrittenByHuman(facts, rootId);
  const assumedBeforeAnswer = informationAssumedBeforeAnswer(facts, rootId, answerAt);
  return {
    actionable,
    consumedAndReceipted: answerMatches && consumed && receipted,
    drivesFreshPlan: Boolean(answerMatches && consumed && lineage && contractRecordsAnswer(lineage.contract)),
    freshPlanReviewActive: Boolean(answerMatches && consumed && lineage),
    assumedBeforeAnswer,
    humanCreatedContinuation,
  };
}

function informationAnswerInput(facts, rootId) {
  const context = facts.context ?? {};
  const hasDriverContext = context.inputReferences !== undefined || context.answeredActionIssueId !== undefined ||
    context.replacementActionIssueId !== undefined;
  if (hasDriverContext) {
    if (!Array.isArray(context.inputReferences) || context.inputReferences.length !== 1 ||
        !identifier(context.answeredActionIssueId) || !identifier(context.replacementActionIssueId) ||
        context.answeredActionIssueId === context.replacementActionIssueId) {
      return undefined;
    }
    const answer = only(context.inputReferences.filter(({ sourceId, kind, binding, commentId }) =>
      kind === "comment_create" && binding === "separator_answer" && identifier(sourceId) && sourceId === commentId,
    ));
    return answer ? {
      ...answer,
      answeredActionIssueId: context.answeredActionIssueId,
      replacementActionIssueId: context.replacementActionIssueId,
    } : undefined;
  }
  return reconstructInformationAnswerInput(facts, rootId);
}

function reconstructInformationAnswerInput(facts, rootId) {
  const requests = facts.recordsOf("human_action_request", rootId).filter(({ record }) => record.action_kind === "clarification");
  const resolutions = facts.recordsOf("human_action_resolution", rootId).filter(({ record }) =>
    record.outcome === "answered" && record.terminal_status === "Answered" && Array.isArray(record.source_comment_ids) &&
    record.source_comment_ids.length === 1,
  );
  const candidates = [];
  for (const request of requests) {
    for (const resolution of resolutions) {
      const sourceId = resolution.record.source_comment_ids[0];
      const answer = facts.comment(sourceId);
      if (resolution.record.action_id !== request.record.action_id || resolution.record.action_issue_id !== request.record.action_issue_id ||
          !identifier(sourceId) || !answer || answer.issueId !== request.record.action_issue_id ||
          answer.body !== frozenActionCommentBody(facts.definition, "separator_answer") || !facts.humanActorIds.has(answer.authorId)) continue;
      const answerAt = parseTime(resolution.record.resolved_at);
      const lineages = planReviewLineages(facts, rootId).filter((lineage) =>
        lineage.execution.record.stage === "plan" && parseTime(lineage.execution.record.started_at) > answerAt &&
        activeHumanAction(facts, lineage.action) && contractRecordsAnswer(lineage.contract),
      );
      const replacement = only(lineages);
      if (!replacement || replacement.action.record.action_issue_id === request.record.action_issue_id) continue;
      candidates.push({
        sourceId,
        kind: "comment_create",
        binding: "separator_answer",
        commentId: sourceId,
        answeredActionIssueId: request.record.action_issue_id,
        replacementActionIssueId: replacement.action.record.action_issue_id,
      });
    }
  }
  return only(candidates);
}

function informationPlanLineage(facts, rootId, input, answerAt) {
  if (answerAt === undefined) return undefined;
  const lineage = only(planReviewLineages(facts, rootId).filter(({ contractEntry, contract, execution, result, action }) =>
    action.record.action_issue_id === input.replacementActionIssueId && action.record.action_issue_id !== input.answeredActionIssueId &&
    only(action.record.related_issue_ids) === contractEntry.issueId && parseTime(execution.record.started_at) > answerAt &&
    parseTime(result.record.completed_at) > answerAt && activeHumanAction(facts, action) && contractRecordsAnswer(contract),
  ));
  if (!lineage) return undefined;

  const executions = facts.recordsOf("stage_execution", rootId).filter(({ record }) =>
    record.stage === "plan" && record.cycle_issue_id === lineage.contract.cycle_issue_id &&
    record.node_issue_id === lineage.contractEntry.issueId,
  );
  const results = facts.recordsOf("stage_result", rootId).filter(({ record }) =>
    record.stage === "plan" && record.cycle_issue_id === lineage.contract.cycle_issue_id &&
    record.node_issue_id === lineage.contractEntry.issueId && record.plan_contract_digest === lineage.contract.plan_contract_digest &&
    record.model_turn?.stage_execution_id === lineage.execution.record.stage_execution_id,
  );
  const actions = facts.recordsOf("human_action_request", rootId).filter(({ record }) =>
    record.action_kind === "plan_review" && record.action_issue_id === input.replacementActionIssueId &&
    record.cycle_issue_id === lineage.contract.cycle_issue_id && only(record.related_issue_ids) === lineage.contractEntry.issueId,
  );
  return only(executions) === lineage.execution && only(results) === lineage.result && only(actions) === lineage.action
    ? lineage
    : undefined;
}

function contractRecordsAnswer(contract) {
  return Array.isArray(contract?.constraints) && contract.constraints.some((constraint) =>
    typeof constraint === "string" && constraint.toLowerCase().includes("colon"),
  );
}

function informationAssumedBeforeAnswer(facts, rootId, answerAt) {
  const continuation = facts.recordsOf("stage_execution", rootId).filter(({ record }) =>
    ["plan", "work", "verify"].includes(record.stage),
  );
  if (answerAt === undefined) {
    return continuation.length > 0 || facts.recordsOf("plan_contract", rootId).length > 0;
  }
  return continuation.some(({ record }) => parseTime(record.started_at) === undefined || parseTime(record.started_at) < answerAt);
}

function informationContinuationWrittenByHuman(facts, rootId) {
  const stageRecord = ({ record }) => ["stage_execution", "stage_result"].includes(record.kind) &&
    ["plan", "work", "verify"].includes(record.stage);
  const continuationRecords = facts.recordsOf("plan_contract", rootId)
    .concat(facts.recordsOf("stage_execution", rootId).filter(stageRecord))
    .concat(facts.recordsOf("stage_result", rootId).filter(stageRecord))
    .concat(facts.recordsOf("verify_result", rootId))
    .concat(facts.recordsOf("delivery", rootId))
    .concat(facts.recordsOf("human_action_request", rootId).filter(({ record }) => record.action_kind === "plan_review"))
    .concat(facts.recordsOf("workflow_issue", rootId).filter(({ record }) => ["plan", "work", "verify"].includes(record.issue_kind)));
  if (continuationRecords.some((entry) => facts.humanActorIds.has(facts.source(entry)?.authorId))) return true;

  const continuationIssueIds = new Set(continuationRecords.flatMap(({ record }) => [
    record.node_issue_id,
    record.action_issue_id,
    record.issue_key,
  ]).filter(identifier));
  return [...continuationIssueIds].some((issueId) => facts.humanActorIds.has(facts.issue(issueId)?.creatorId));
}

function informationAnswerFailureFacts(facts, rootId) {
  return {
    actionable: false,
    consumedAndReceipted: false,
    drivesFreshPlan: false,
    freshPlanReviewActive: false,
    assumedBeforeAnswer: informationAssumedBeforeAnswer(facts, rootId, undefined),
    humanCreatedContinuation: informationContinuationWrittenByHuman(facts, rootId),
  };
}

function revisionFacts(facts) {
  const rootId = onlyRootId(facts);
  const input = revisionInput(facts, rootId);
  if (!input) return revisionFailureFacts();
  const replies = facts.recordsOf("root_reconciler_reply", rootId);
  const directives = facts.recordsOf("root_directive", rootId);
  const consumedIds = directives.flatMap(({ record }) => Array.isArray(record.consumed_input_ids) ? record.consumed_input_ids : []);
  const descriptionConsumed = consumedIds.filter((id) => id === input.description.sourceId).length === 1;
  const bodyReceipts = input.commentBodies.map((binding) => matchingCommentBodyReply(facts, replies, rootId, binding));
  const latestBody = input.commentBodies.toSorted((left, right) => parseTime(left.remoteVersion) - parseTime(right.remoteVersion)).at(-1);
  const latestReply = latestBody && bodyReceipts.find(({ sourceId }) => sourceId === latestBody.sourceId);
  const inputsConsumedOnce = descriptionConsumed && input.commentBodies.every((binding) =>
    consumedIds.filter((id) => id === binding.sourceId).length === 1) && bodyReceipts.every(({ valid }) => valid) &&
    nativeCommentReceipt(facts.comment(latestBody?.commentId), latestReply?.receiptActorId) === latestReply?.reaction;
  const threadReceipts = input.threadTransitions.map((binding) => matchingThreadReply(replies, rootId, binding));
  const threadTransitionsReceipted = threadReceipts.every(({ valid }) => valid) &&
    facts.comment(input.threadTransitions.at(-1)?.commentId)?.thread?.state === "unresolved";
  const oldGate = planGateFacts(facts, rootId, input.initialPlan, { active: false });
  const successorGate = planGateFacts(facts, rootId, input.successorPlan, { active: true });
  const initialGateBeforeRevision = oldGate.complete && parseTime(oldGate.contractObservedAt) < parseTime(input.description.remoteVersion);
  const successorPlanAfterRevision = successorGate.complete && parseTime(successorGate.executionStartedAt) > parseTime(input.description.remoteVersion);
  const oldCycle = facts.issue(input.initialPlan.cycleIssueId);
  const supersedesCycle = initialGateBeforeRevision && successorPlanAfterRevision &&
    ["Changes Required", "Canceled"].includes(oldCycle?.state?.name) &&
    input.successorPlan.cycleIssueId !== input.initialPlan.cycleIssueId;
  const relevantDirectives = directives.filter(({ record }) =>
    Array.isArray(record.consumed_input_ids) && record.consumed_input_ids.some((id) => input.declaredSourceIds.has(id)));
  const systemCommentConsumed = consumedIds.some((sourceId) => consumedSystemComment(facts, replies, sourceId));
  const undeclaredInputConsumed = relevantDirectives.some(({ record }) =>
    record.consumed_input_ids.some((sourceId) => !input.declaredSourceIds.has(sourceId)));
  const threadHistoryLost = !facts.comment(input.commentId)?.editedAt ||
    input.threadTransitions.some(({ commentId }) => facts.comment(commentId)?.thread?.state === "unknown") ||
    !threadTransitionsRetainDistinctHistory(threadReceipts);
  return {
    inputsConsumedOnce,
    threadTransitionsReceipted,
    supersedesCycle,
    freshPlanReview: supersedesCycle && successorGate.complete,
    systemCommentConsumed,
    threadHistoryLost,
    undeclaredInputConsumed,
  };
}

function revisionInput(facts, rootId) {
  if (!identifier(rootId) || !Array.isArray(facts.context.inputReferences) || facts.context.inputReferences.length !== 5) return undefined;
  const byKind = new Map();
  for (const reference of facts.context.inputReferences) {
    if (!reference || !identifier(reference.sourceId) || byKind.has(reference.sourceId)) return undefined;
    byKind.set(reference.sourceId, reference);
  }
  const description = only([...byKind.values()].filter(({ kind, remoteVersion }) => kind === "description" && timestamp(remoteVersion)));
  const commentBodies = [...byKind.values()].filter(({ kind, commentId, commentBodyDigest, remoteVersion }) =>
    kind === "comment_body" && identifier(commentId) && identifier(commentBodyDigest) && timestamp(remoteVersion));
  const threadTransitions = [...byKind.values()].filter(({ kind, commentId, threadRootCommentId, expectedThreadState, remoteVersion }) =>
    kind === "comment_thread_state" && identifier(commentId) && commentId === threadRootCommentId &&
    ["resolved", "unresolved"].includes(expectedThreadState) && timestamp(remoteVersion));
  const initialPlan = validRevisionPlanGate(facts.context.initialPlan);
  const successorPlan = validRevisionPlanGate(facts.context.successorPlan);
  const commentId = only([...new Set(commentBodies.map(({ commentId }) => commentId))]);
  if (!description || commentBodies.length !== 2 || threadTransitions.length !== 2 || !commentId ||
      !threadTransitions.every((reference) => reference.commentId === commentId) || !initialPlan || !successorPlan ||
      initialPlan.cycleIssueId === successorPlan.cycleIssueId || initialPlan.planIssueId === successorPlan.planIssueId ||
      initialPlan.planContractDigest === successorPlan.planContractDigest ||
      initialPlan.planReviewActionIssueId === successorPlan.planReviewActionIssueId) return undefined;
  return {
    description,
    commentBodies,
    threadTransitions,
    commentId,
    initialPlan,
    successorPlan,
    declaredSourceIds: new Set(byKind.keys()),
  };
}

function validRevisionPlanGate(value) {
  if (!value || !identifier(value.cycleIssueId) || !identifier(value.planIssueId) ||
      !identifier(value.planContractDigest) || !identifier(value.planContractSourceCommentId) ||
      !identifier(value.planReviewActionIssueId)) return undefined;
  return value;
}

function matchingCommentBodyReply(facts, replies, rootId, binding) {
  const records = replies.filter(({ record }) => record.source_input_id === binding.sourceId &&
    record.target_issue_id === rootId && record.source?.kind === "comment_body" &&
    record.source.comment_id === binding.commentId && record.source.comment_body_digest === binding.commentBodyDigest &&
    ["check", "cross", "none"].includes(record.reaction) &&
    ["resolve", "keep_open", "reopen"].includes(record.thread_action));
  const reply = only(records);
  const receiptActorId = reply && (reply.sourceAuthorId ?? facts.source(reply)?.authorId);
  return {
    sourceId: binding.sourceId,
    reaction: reply?.record.reaction,
    receiptActorId,
    valid: Boolean(reply) && identifier(receiptActorId),
  };
}

function matchingThreadReply(replies, rootId, binding) {
  const action = binding.expectedThreadState === "resolved" ? "resolve" : "reopen";
  const records = replies.filter(({ record }) => record.source_input_id === binding.sourceId &&
    record.target_issue_id === rootId && record.source?.kind === "comment_thread_state" &&
    record.source.comment_id === binding.commentId && record.source.comment_remote_version === binding.remoteVersion &&
    record.source.thread_root_comment_id === binding.threadRootCommentId &&
    record.source.thread_state === binding.expectedThreadState && record.reaction === "none" && record.thread_action === action);
  return { sourceId: binding.sourceId, valid: Boolean(only(records)), state: binding.expectedThreadState, remoteVersion: binding.remoteVersion };
}

function nativeCommentReceipt(comment, receiptActorId) {
  if (!comment || !identifier(receiptActorId) || !Array.isArray(comment.reactions)) return undefined;
  const receipts = new Set(comment.reactions
    .filter(({ actorId, emoji }) => actorId === receiptActorId && (emoji === "✅" || emoji === "❌"))
    .map(({ emoji }) => emoji === "✅" ? "check" : "cross"));
  if (receipts.size > 1) return undefined;
  return receipts.values().next().value ?? "none";
}

function planGateFacts(facts, rootId, gate, { active }) {
  const contract = only(facts.recordsOf("plan_contract", rootId).filter((entry) => entry.issueId === gate.planIssueId &&
    entry.source?.id === gate.planContractSourceCommentId && entry.record.cycle_issue_id === gate.cycleIssueId &&
    entry.record.plan_contract_digest === gate.planContractDigest &&
    !facts.humanActorIds.has(entry.sourceAuthorId ?? facts.source(entry)?.authorId)));
  const execution = contract && only(facts.recordsOf("stage_execution", rootId).filter(({ record }) => record.stage === "plan" &&
    record.cycle_issue_id === gate.cycleIssueId && record.node_issue_id === gate.planIssueId));
  const result = execution && only(facts.recordsOf("stage_result", rootId).filter(({ record }) => record.stage === "plan" &&
    record.outcome_kind === "plan_completed" && record.cycle_issue_id === gate.cycleIssueId && record.node_issue_id === gate.planIssueId &&
    record.plan_contract_digest === gate.planContractDigest && record.model_turn?.stage_execution_id === execution.record.stage_execution_id));
  const action = only(facts.recordsOf("human_action_request", rootId).filter(({ record }) => record.action_kind === "plan_review" &&
    record.action_issue_id === gate.planReviewActionIssueId && record.cycle_issue_id === gate.cycleIssueId &&
    exactList(record.related_issue_ids, [gate.planIssueId])));
  const issue = facts.issue(gate.planReviewActionIssueId);
  const actionStateMatches = active
    ? Boolean(issue && issue.archivedAt === null && ["Todo", "In Progress"].includes(issue.state?.name) && !facts.humanActorIds.has(issue.creatorId))
    : Boolean(issue && issue.archivedAt !== null);
  return {
    complete: Boolean(contract && execution && result && action && actionStateMatches),
    contractObservedAt: facts.source(contract)?.createdAt ?? facts.source(contract)?.updatedAt,
    executionStartedAt: execution?.record.started_at,
  };
}

function consumedSystemComment(facts, replies, sourceId) {
  const direct = facts.comment(sourceId);
  if (direct && !facts.humanActorIds.has(direct.authorId)) return true;
  const reply = facts.recordsOf("root_reconciler_reply").find(({ record }) => record.source_input_id === sourceId);
  const comment = reply && facts.comment(reply.record.source?.comment_id);
  return Boolean(comment && !facts.humanActorIds.has(comment.authorId));
}

function threadTransitionsRetainDistinctHistory(receipts) {
  return receipts.length === 2 && receipts[0]?.valid && receipts[1]?.valid &&
    receipts[0].state === "resolved" && receipts[1].state === "unresolved" && receipts[0].remoteVersion !== receipts[1].remoteVersion;
}

function revisionFailureFacts() {
  return { inputsConsumedOnce: false, threadTransitionsReceipted: false, supersedesCycle: false, freshPlanReview: false, systemCommentConsumed: false, threadHistoryLost: true, undeclaredInputConsumed: false };
}

function parallelFacts(facts) {
  const binding = parallelBinding(facts);
  if (!binding) return parallelFailureFacts();
  const ownership = binding.roots.map(({ rootIssueId }) => facts.recordsOf("root_ownership", rootIssueId));
  const ownerRecords = ownership.map((entries) => entries[0]?.record);
  const gitByRoot = new Map((facts.evidence.git ?? []).map((entry) => [entry.rootIssueId, entry]));
  const intervalFacts = stageIntervalFacts(facts, binding.roots.map(({ rootIssueId }) => rootIssueId));
  const rootsHaveCoverage = binding.roots.every(({ rootIssueId }) => {
    const root = facts.rootIssue(rootIssueId);
    const owners = facts.recordsOf("root_ownership", rootIssueId).map(({ record }) => record);
    const git = gitByRoot.get(rootIssueId);
    return root && Array.isArray(root.labels) && root.labels.length > 0 && owners.length > 0 &&
      owners.every(validRootOwnership) && validGitFact(git);
  });
  const coverageComplete = rootsHaveCoverage && intervalFacts.coverageComplete;
  const ownershipIsolated = ownership.every((entries, index) => {
    const expected = binding.roots[index];
    const root = facts.rootIssue(expected.rootIssueId);
    const owner = only(entries)?.record;
    const git = gitByRoot.get(expected.rootIssueId);
    return entries.length === 1 && root?.labels.length === 1 && root.labels[0]?.id === expected.routingLabelId &&
      owner?.conductor_id === expected.conductorId && owner?.performer_profile_id === expected.performerProfileId &&
      git?.repositoryRootCanonical === expected.repositoryRoot;
  }) &&
    new Set(ownerRecords.map((record) => record?.delivery_branch)).size === binding.roots.length &&
    new Set(binding.roots.map(({ rootIssueId }) => gitByRoot.get(rootIssueId)?.repositoryRootCanonical)).size === binding.roots.length;
  const chains = binding.roots.map((expected) => independentDeliveryChainFacts(facts, expected));
  const hasOverlap = intervalFacts.intervals.some((left, index) => intervalFacts.intervals.slice(index + 1).some((right) =>
    left.conductorId !== right.conductorId && Math.max(left.startedAt, right.startedAt) < Math.min(left.completedAt, right.completedAt)));
  const takeover = ownership.some((entries, index) => entries.length !== 1 || entries.some(({ record }) =>
    record.conductor_id !== binding.roots[index].conductorId));
  return {
    coverageComplete,
    ownershipIsolated,
    independentDeliveries: chains.every(({ complete }) => complete),
    hasOverlap,
    allDelivered: chains.every(({ rootInReview, complete }) => rootInReview && complete) && hasOverlap,
    takeover,
    sharedWorkspace: new Set(ownerRecords.map((record) => record?.delivery_branch)).size !== binding.roots.length ||
      new Set(binding.roots.map(({ rootIssueId }) => gitByRoot.get(rootIssueId)?.repositoryRootCanonical)).size !== binding.roots.length,
    telemetrySubstitution: intervalFacts.unmatched || Object.hasOwn(facts.evidence, "telemetry"),
  };
}

function parallelBinding(facts) {
  const roots = facts.context.parallel?.roots;
  const topologyByKey = new Map(facts.definition.rootTopology.map((topology) => [topology.rootKey, topology]));
  if (!Array.isArray(roots) || roots.length !== topologyByKey.size ||
      new Set(roots.map(({ rootKey }) => rootKey)).size !== roots.length) return undefined;
  const normalized = [];
  for (const value of roots) {
    const topology = topologyByKey.get(value?.rootKey);
    if (!topology || !identifier(value.rootIssueId) || !identifier(value.planReviewActionIssueId) ||
        !identifier(value.routingLabelId) || !identifier(value.conductorId) || !identifier(value.performerProfileId) ||
        !repositoryRoot(value.repositoryRoot) || value.conductorRef !== topology.conductorRef ||
        value.repositoryRef !== topology.repositoryRef || facts.context.rootIssueIdsByKey?.[value.rootKey] !== value.rootIssueId) {
      return undefined;
    }
    normalized.push(Object.freeze({ ...value }));
  }
  if (new Set(normalized.map(({ rootIssueId }) => rootIssueId)).size !== normalized.length ||
      new Set(normalized.map(({ planReviewActionIssueId }) => planReviewActionIssueId)).size !== normalized.length ||
      new Set(normalized.map(({ routingLabelId }) => routingLabelId)).size !== normalized.length ||
      new Set(normalized.map(({ conductorId }) => conductorId)).size !== normalized.length ||
      new Set(normalized.map(({ performerProfileId }) => performerProfileId)).size !== normalized.length ||
      new Set(normalized.map(({ repositoryRoot }) => repositoryRoot)).size !== normalized.length ||
      normalized.some(({ rootIssueId }) => !facts.rootIssueIds.includes(rootIssueId))) return undefined;
  return Object.freeze({ roots: Object.freeze(normalized) });
}

function parallelFailureFacts() {
  return {
    coverageComplete: false,
    ownershipIsolated: false,
    independentDeliveries: false,
    hasOverlap: false,
    allDelivered: false,
    takeover: false,
    sharedWorkspace: false,
    telemetrySubstitution: false,
  };
}

function independentDeliveryChainFacts(facts, expected) {
  const chain = deliveryChainFacts(facts, expected.rootIssueId);
  const approval = approvedPlanFacts(facts, expected.rootIssueId);
  const action = only(approval.actions.filter(({ record }) => record.action_issue_id === expected.planReviewActionIssueId));
  const resolution = only(facts.recordsOf("human_action_resolution", expected.rootIssueId).filter(({ record }) =>
    record.action_issue_id === expected.planReviewActionIssueId && record.outcome === "approved" && record.terminal_status === "Approved"));
  const actionIssue = facts.issue(expected.planReviewActionIssueId);
  return {
    ...chain,
    complete: chain.complete && approval.everyWorkStartsAfterApproval && Boolean(action && resolution) &&
      approval.approval?.action_issue_id === expected.planReviewActionIssueId && actionIssue?.state?.name === "Approved",
  };
}

function validRootOwnership(record) {
  return record && identifier(record.conductor_id) && identifier(record.performer_profile_id) && identifier(record.delivery_branch);
}

function validGitFact(value) {
  return value && typeof value.repositoryRootCanonical === "string" && value.repositoryRootCanonical.length > 0 &&
    typeof value.headRevision === "string" && value.headRevision.length > 0;
}

function preemptionFacts(facts) {
  const binding = facts.context.preemption;
  if (!validPreemptionBinding(binding)) return preemptionFailureFacts();
  const rootIds = [binding.inflightRootId, binding.touchedRootId, binding.remainingRootId];
  if (new Set(rootIds).size !== rootIds.length) return preemptionFailureFacts();
  const rootIssues = rootIds.map((rootIssueId) => facts.rootIssue(rootIssueId));
  const executions = facts.recordsOf("stage_execution").filter(({ record }) => rootIds.includes(record.root_issue_id));
  const results = facts.recordsOf("stage_result").filter(({ record }) => rootIds.includes(record.root_issue_id));
  const inflightExecutions = executions.filter(({ record }) => record.stage_execution_id === binding.inflightExecutionId &&
    record.root_issue_id === binding.inflightRootId);
  const inflightResults = matchingStageResults(results, binding.inflightExecutionId, binding.inflightRootId);
  const inflightResult = only(inflightResults);
  const terminalAt = parseTime(inflightResult?.record.completed_at);
  const touchedRoot = facts.rootIssue(binding.touchedRootId);
  const remainingRoot = facts.rootIssue(binding.remainingRootId);
  const touchActivity = facts.activity.find(({ id }) => id === binding.touchActivityId);
  const touchAt = parseTime(touchActivity?.createdAt);
  const candidates = executions.filter(({ record }) => [binding.touchedRootId, binding.remainingRootId].includes(record.root_issue_id) &&
    parseTime(record.started_at) > terminalAt).sort(compareStageStarts);
  const firstCandidate = candidates[0];
  const earliestCandidateStart = parseTime(firstCandidate?.record.started_at);
  const candidateStartTie = candidates.filter(({ record }) => parseTime(record.started_at) === earliestCandidateStart).length !== 1;
  const touchedExecution = only(executions.filter(({ record }) => record.stage_execution_id === binding.touchedExecutionId &&
    record.root_issue_id === binding.touchedRootId));
  const owners = rootIds.map((rootIssueId) => facts.recordsOf("root_ownership", rootIssueId).map(({ record }) => record));
  const ownerCoverageComplete = owners.every((records) => records.length === 1 && validRootOwnership(records[0]));
  const sameOwner = owners.every((records) => records.length === 1 && records[0].conductor_id === binding.conductorId);
  const samePriority = rootIssues.every((root) => Number.isFinite(root?.priority)) &&
    new Set(rootIssues.map(({ priority }) => priority)).size === 1;
  const activeAtTouch = executions.filter(({ record }) => {
    const startedAt = parseTime(record.started_at);
    const result = only(matchingStageResults(results, record.stage_execution_id, record.root_issue_id));
    const completedAt = parseTime(result?.record.completed_at);
    return startedAt !== undefined && touchAt !== undefined && startedAt < touchAt &&
      (completedAt === undefined || completedAt > touchAt);
  });
  const readyBeforeTouch = [binding.touchedRootId, binding.remainingRootId].every((rootIssueId) =>
    executions.every(({ record }) => record.root_issue_id !== rootIssueId || parseTime(record.started_at) > touchAt));
  const readyAtTerminal = [binding.touchedRootId, binding.remainingRootId].every((rootIssueId) =>
    executions.every(({ record }) => record.root_issue_id !== rootIssueId || parseTime(record.started_at) > terminalAt));
  const latestTouchedActivity = latestActivityAtOrBefore(facts.activity, binding.touchedRootId, touchAt);
  const latestRemainingActivity = latestActivityAtOrBefore(facts.activity, binding.remainingRootId, touchAt);
  const touchIsLatest = Boolean(touchActivity && touchActivity.issueId === binding.touchedRootId &&
    touchActivity.actorId === facts.context.humanActorId && touchActivity.updatedDescription === true &&
    latestTouchedActivity?.id === binding.touchActivityId && parseTime(latestRemainingActivity?.createdAt) < touchAt);
  const original = facts.definition.initialRequirements.find(({ rootKey }) => rootKey === binding.touchedRootKey);
  const declaredTouch = facts.definition.declaredUserInteractions.find(({ kind }) => kind === "touch_bound_root_description")?.descriptionsByRootKey?.[binding.touchedRootKey];
  const coverageComplete = rootIssues.every((root) => root && Number.isFinite(root.priority)) && ownerCoverageComplete &&
    inflightExecutions.length === 1 && inflightResults.length === 1 && terminalAt !== undefined && touchAt !== undefined &&
    parseTime(inflightExecutions[0]?.record.started_at) !== undefined && executions
      .filter(({ record }) => [binding.touchedRootId, binding.remainingRootId].includes(record.root_issue_id))
      .every(({ record }) => parseTime(record.started_at) !== undefined) &&
    Boolean(touchActivity && touchedExecution && firstCandidate && earliestCandidateStart !== undefined && latestRemainingActivity);
  return {
    coverageComplete,
    inflightCompletes: inflightResults.length === 1 && !TERMINAL_STAGE_OUTCOMES.has(inflightResult?.record.outcome_kind),
    latestRunsNext: Boolean(sameOwner && samePriority && touchIsLatest && touchAt < terminalAt &&
      activeAtTouch.length === 1 && activeAtTouch[0].record.stage_execution_id === binding.inflightExecutionId && readyBeforeTouch && readyAtTerminal &&
      !candidateStartTie && firstCandidate?.record.stage_execution_id === binding.touchedExecutionId &&
      touchedExecution?.record.stage_execution_id === binding.touchedExecutionId && touchedRoot && remainingRoot),
    remainingProgresses: sameOwner && deliveryChainFacts(facts, binding.remainingRootId).complete,
    allDelivered: rootIds.every((rootId) => deliveryChainFacts(facts, rootId).rootInReview),
    inflightInterrupted: inflightResults.some(({ record }) => TERMINAL_STAGE_OUTCOMES.has(record.outcome_kind)),
    testSelectedNext: facts.activity.some(({ actorId, issueId, createdAt, toPriority, toStateId, updatedDescription }) => facts.humanActorIds.has(actorId) &&
      rootIds.includes(issueId) && parseTime(createdAt) >= touchAt &&
      (toPriority !== null || toStateId !== null || (updatedDescription && issueId !== binding.touchedRootId))),
    semanticTouch: Boolean(original && declaredTouch && touchedRoot?.description !== declaredTouch),
  };
}

function validPreemptionBinding(value) {
  return value && identifier(value.inflightRootId) && identifier(value.touchedRootId) && identifier(value.remainingRootId) &&
    identifier(value.inflightExecutionId) && identifier(value.touchedExecutionId) && identifier(value.touchedRootKey) &&
    identifier(value.touchActivityId) && identifier(value.conductorId);
}

function preemptionFailureFacts() {
  return {
    coverageComplete: false,
    inflightCompletes: false,
    latestRunsNext: false,
    remainingProgresses: false,
    allDelivered: false,
    inflightInterrupted: false,
    testSelectedNext: false,
    semanticTouch: false,
  };
}

function matchingStageResults(results, stageExecutionId, rootIssueId = undefined) {
  return results.filter(({ record }) => (rootIssueId === undefined || record.root_issue_id === rootIssueId) &&
    (record.model_turn?.stage_execution_id === stageExecutionId || record.result_id === stageExecutionId));
}

function compareStageStarts(left, right) {
  return parseTime(left.record.started_at) - parseTime(right.record.started_at);
}

function latestActivityAtOrBefore(activity, rootIssueId, at) {
  return activity.filter((entry) => entry.issueId === rootIssueId && parseTime(entry.createdAt) <= at)
    .sort((left, right) => parseTime(right.createdAt) - parseTime(left.createdAt))[0];
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
  const declaredComments = definition.declaredUserInteractions?.filter(({ kind }) =>
    kind === "create_comment" || kind === "create_action_comment" || kind === "edit_comment",
  ) ?? [];
  return declaredComments.every((interaction) => {
    if (comments.some((comment) => comment.body === interaction.body)) return true;
    if ((interaction.kind !== "create_comment" && interaction.kind !== "create_action_comment") || !edits.has(interaction.commentBinding)) return false;
    const binding = bindings.find(({ kind, binding: inputBinding }) =>
      ["comment_create", "comment_body"].includes(kind) && inputBinding === interaction.commentBinding);
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

function only(values) {
  return Array.isArray(values) && values.length === 1 ? values[0] : undefined;
}

function exactList(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function frozenActionCommentBody(definition, inputBinding) {
  const interaction = definition?.declaredUserInteractions?.find(({ kind, inputBinding: binding }) =>
    kind === "create_action_comment" && binding === inputBinding,
  );
  return typeof interaction?.body === "string" ? interaction.body : undefined;
}

function actionableActionDescription(description) {
  if (typeof description !== "string") return false;
  return ["question", "required", "submit", "next"].every((word) => description.toLowerCase().includes(word));
}

function stageIntervalFacts(facts, rootIssueIds) {
  const ownershipByRoot = new Map(rootIssueIds.map((rootId) => [rootId, facts.recordsOf("root_ownership", rootId)[0]?.record?.conductor_id]));
  let coverageComplete = true;
  let unmatched = false;
  const intervals = [];
  for (const { record } of facts.recordsOf("stage_execution")) {
    if (!rootIssueIds.includes(record.root_issue_id)) continue;
    const candidates = facts.recordsOf("stage_result", record.root_issue_id).filter(({ record: candidate }) =>
      candidate.node_issue_id === record.node_issue_id && candidate.stage === record.stage && candidate.context_digest === record.context_digest);
    const result = only(candidates.filter(({ record: candidate }) => candidate.model_turn?.stage_execution_id === record.stage_execution_id));
    if (candidates.some(({ record: candidate }) => candidate.model_turn?.stage_execution_id !== record.stage_execution_id)) {
      unmatched = true;
    }
    if (!result) {
      if (candidates.length === 0) coverageComplete = false;
      else unmatched = true;
      continue;
    }
    const startedAt = parseTime(record.started_at);
    const completedAt = parseTime(result?.record.completed_at);
    if (startedAt === undefined || completedAt === undefined) {
      coverageComplete = false;
      continue;
    }
    intervals.push({ rootIssueId: record.root_issue_id, conductorId: ownershipByRoot.get(record.root_issue_id), startedAt, completedAt });
  }
  if (intervals.length === 0) coverageComplete = false;
  return { intervals, coverageComplete, unmatched };
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
function repositoryRoot(value) { return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\u0000"); }
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
