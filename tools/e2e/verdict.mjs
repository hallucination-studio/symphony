import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const PRIMARY_KIND_LABELS = Object.freeze(["Cycle", "Plan", "Work", "Verify", "Finding"]);
const TERMINAL_STATE_TYPES = new Set(["completed", "canceled"]);
const MACHINE_CONTENT = /(?:```(?:json|yaml)|<!--\s*symphony|"(?:kind|version|root_issue_id|stage_execution_id)"\s*:|workflow_issue_key|managed_record)/iu;

export function validateForegroundE2EAssertionCatalog(definitions) {
  if (!sameContractValue(definitions, FOREGROUND_E2E_CASES)) {
    throw stableError("foreground_e2e_assertion_catalog_invalid");
  }
  for (const definition of definitions) validateDefinition(definition);
}

export function evaluateForegroundE2EAssertions({ definition, evidence, context } = {}) {
  validateDefinition(definition);
  const facts = createFacts(definition, evidence, context);
  return Object.freeze(definition.assertions.map((assertion) => evaluateAssertion(assertion, facts)));
}

export function deriveForegroundE2EVerdict(assertions, { deadlineExceeded = false, processFault = undefined } = {}) {
  if (!Array.isArray(assertions) || assertions.length === 0 || assertions.some((item) => !validAssertionOutcome(item)) ||
      processFault !== undefined && !identifier(processFault)) {
    throw stableError("foreground_e2e_verdict_input_invalid");
  }
  if (assertions.some(({ outcome }) => outcome === "contradicted")) {
    return verdict("failed", assertions, "contradicted", processFault);
  }
  if (deadlineExceeded || assertions.some(({ outcome }) => outcome === "coverage_missing")) {
    return verdict("incomplete", assertions, "coverage_missing", processFault);
  }
  return processFault === undefined
    ? Object.freeze({ verdict: "passed", reasonCodes: Object.freeze([]) })
    : Object.freeze({ verdict: "failed", reasonCodes: Object.freeze([processFault]) });
}

export async function runForegroundE2ECases({
  definitions,
  runCase,
  readFinalEvidence,
  reporter,
  createCaseScope = defaultCaseScope,
  now = () => new Date().toISOString(),
} = {}) {
  validateForegroundE2EAssertionCatalog(definitions);
  if (typeof runCase !== "function" || typeof readFinalEvidence !== "function" ||
      reporter !== undefined && typeof reporter.caseObservation !== "function" ||
      typeof createCaseScope !== "function" || typeof now !== "function") {
    throw stableError("foreground_e2e_scheduler_input_invalid");
  }
  const startedAt = new Map();
  const settlements = await Promise.allSettled(definitions.map(async (definition) => {
    const started = requiredTimestamp(now());
    startedAt.set(definition.caseId, started);
    const scope = createCaseScope({ definition });
    if (!scope || scope.caseId !== definition.caseId || !scope.signal || typeof scope.signal.aborted !== "boolean") {
      throw stableError("foreground_e2e_case_scope_invalid");
    }
    try {
      observe(reporter, { caseId: definition.caseId, observation: "creating-root" });
      let driverResult;
      let driverFailureCode;
      try {
        observe(reporter, { caseId: definition.caseId, observation: "running" });
        driverResult = await runWithinCaseScope(() => runCase({ definition, scope }), scope);
      } catch (error) {
        driverFailureCode = caseDriverFailureCode(error);
        observe(reporter, { caseId: definition.caseId, observation: "failed", detail: driverFailureCode });
      }
      observe(reporter, { caseId: definition.caseId, observation: "final-reading" });
      let finalRead;
      let finalReadFailed = false;
      try {
        finalRead = await readFinalEvidence({ definition, scope, driverResult });
      } catch {
        finalReadFailed = true;
      }
      const assertions = finalReadFailed
        ? missingCoverageAssertions(definition)
        : evaluateForegroundE2EAssertions({
          definition,
          evidence: finalRead?.evidence ?? finalRead,
          context: finalRead?.context ?? driverResult?.context,
        });
      const outcome = deriveForegroundE2EVerdict(assertions, {
        deadlineExceeded: driverResult?.deadlineExceeded === true || scope.deadlineExceeded?.() === true,
        processFault: scope.processFault?.(),
      });
      observe(reporter, { caseId: definition.caseId, observation: outcome.verdict });
      return Object.freeze({
        caseId: definition.caseId,
        verdict: outcome.verdict,
        reasonCodes: outcome.reasonCodes,
        assertions,
        elapsedMs: elapsedMilliseconds(started, requiredTimestamp(now())),
        ...(driverFailureCode ? { driverFailureCode } : {}),
      });
    } finally {
      scope.dispose?.();
    }
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
      elapsedMs: elapsedMilliseconds(startedAt.get(definition.caseId) ?? requiredTimestamp(now()), requiredTimestamp(now())),
    });
  });
  return Object.freeze({ exitCode: cases.every(({ verdict }) => verdict === "passed") ? 0 : 1, cases: Object.freeze(cases) });
}

function evaluateAssertion(assertion, facts) {
  const outcome = facts.coverageComplete ? evaluateCoveredAssertion(assertion, facts) : "coverage_missing";
  return Object.freeze({
    assertionId: assertion.assertionId,
    outcome,
    reasonCodePrefix: assertion.reasonCode,
    ...(outcome === "satisfied" ? {} : { reasonCode: `${assertion.reasonCode}.${outcome}` }),
    evidenceReferences: Object.freeze(referencesFor(assertion, facts)),
  });
}

function evaluateCoveredAssertion(assertion, facts) {
  const common = COMMON_HANDLERS[assertion.assertionId];
  if (common) return common(facts);
  const handler = CASE_HANDLERS[facts.definition.caseId]?.[assertion.assertionId];
  if (!handler) throw stableError("foreground_e2e_assertion_catalog_invalid");
  const condition = handler(facts);
  return assertion.kind === "prohibited"
    ? condition ? "contradicted" : "satisfied"
    : condition ? "satisfied" : "contradicted";
}

const COMMON_HANDLERS = Object.freeze({
  case_scope_isolated: (facts) => booleanOutcome(scopeIsolated(facts)),
  complete_native_coverage: () => "satisfied",
  native_identity_consistent: (facts) => booleanOutcome(nativeIdentityConsistent(facts)),
  requirement_preserved: (facts) => booleanOutcome(requirementsPreserved(facts)),
  human_provenance_preserved: (facts) => booleanOutcome(humanProvenancePreserved(facts)),
  native_result_evidence: (facts) => booleanOutcome(nativeResultsHaveEvidence(facts)),
  delivery_consistent: (facts) => booleanOutcome(facts.roots.every((root) => deliveryConsistent(facts, root))),
  terminal_nodes_not_dispatched: (facts) => booleanOutcome(terminalNodesNotRedispatched(facts)),
  human_content_only: (facts) => booleanOutcome(humanContentOnly(facts)),
  no_test_control_facts: (facts) => booleanOutcome(!humanCreatedProductFacts(facts)),
});

const CASE_HANDLERS = Object.freeze({
  approved_happy_path: handlers({
    plan_approval_precedes_work: (f) => approvalPrecedesWork(f),
    cycle_plan_work_verify_tree_materialized: (f) => completeCycleTree(f, f.roots[0]),
    stage_chain_delivered: (f) => deliveryConsistent(f, f.roots[0]),
    boundary_in_review_delivery: (f) => deliveryConsistent(f, f.roots[0]),
    work_before_approval: (f) => workBeforeApproval(f),
    duplicate_or_synthetic_completion: (f) => duplicateNativeCompletion(f),
  }),
  plan_rejected_and_replanned: handlers({
    rejection_consumed_and_replied: (f) => rejectedPlanFacts(f).replied,
    rejected_lineage_retained: (f) => rejectedPlanFacts(f).historyRetained,
    rejected_contract_superseded: (f) => rejectedPlanFacts(f).freshPlan,
    boundary_fresh_plan_review: (f) => rejectedPlanFacts(f).freshReview,
    work_against_rejected_contract: (f) => rejectedPlanFacts(f).oldWorkDispatched,
    contract_overwritten_or_history_deleted: (f) => !rejectedPlanFacts(f).historyRetained,
    test_created_replacement: (f) => rejectedPlanFacts(f).humanCreatedFreshPlan,
  }),
  information_requested_and_answered: handlers({
    information_action_actionable: (f) => informationFacts(f).actionable,
    answer_consumed_and_receipted: (f) => informationFacts(f).receipted,
    answer_drives_fresh_plan: (f) => informationFacts(f).freshPlan,
    boundary_fresh_plan_review: (f) => informationFacts(f).freshReview,
    missing_answer_assumed: (f) => informationFacts(f).planBeforeAnswer,
    test_unblocks_or_mutates_stage: (f) => informationFacts(f).humanCreatedPlan,
  }),
  root_revision_and_comment: handlers({
    ordinary_inputs_consumed_once: (f) => revisionFacts(f).inputsReceipted,
    thread_transitions_receipted: (f) => revisionFacts(f).threadReceipted,
    revision_supersedes_cycle: (f) => revisionFacts(f).successorCycle,
    boundary_successor_plan_review: (f) => revisionFacts(f).freshReview,
    system_comment_treated_as_input: (f) => revisionFacts(f).systemReceipt,
    thread_history_lost: (f) => !revisionFacts(f).historyRetained,
    undeclared_revision_or_conductor_interpretation: (f) => revisionFacts(f).undeclaredRequirement,
  }),
  parallel_multi_conductor: handlers({
    root_routing_and_workspace_isolated: (f) => routingAndRepositoriesIsolated(f),
    independent_delivery_chains: (f) => f.roots.every((root) => deliveryConsistent(f, root)),
    cross_conductor_stage_overlap: (f) => processIntervalsOverlap(f.context.parallel?.intervals),
    boundary_all_roots_delivered: (f) => f.roots.every((root) => deliveryConsistent(f, root)),
    cross_conductor_routing_violation: (f) => routingViolation(f),
    shared_workspace_writer: (f) => sharedRepository(f),
    telemetry_substitutes_overlap: (f) => !Array.isArray(f.context.parallel?.intervals),
  }),
  same_conductor_preemption: handlers({
    inflight_stage_completes: (f) => preemptionFacts(f).inflightTerminal,
    latest_ready_root_runs_next: (f) => preemptionFacts(f).touchedRunsNext,
    higher_priority_roots_run_before_lower_priority_root: (f) => preemptionFacts(f).priorityOrdered,
    remaining_ready_root_progresses: (f) => preemptionFacts(f).remainingProgresses,
    boundary_all_roots_delivered: (f) => f.roots.every((root) => deliveryConsistent(f, root)),
    inflight_turn_interrupted: (f) => preemptionFacts(f).inflightInterrupted,
    test_selects_next_root: (f) => Boolean(f.context.preemption?.testSelectedNext),
    semantic_requirement_touch: (f) => Boolean(f.context.preemption?.semanticRequirementChanged),
  }),
  conductor_restart_recovery: handlers({
    old_execution_terminal_once: (f) => recoveryFacts(f).oldTerminalOnce,
    recovery_uses_fresh_execution: (f) => recoveryFacts(f).freshSuccessor,
    routing_persists: (f) => recoveryFacts(f).routingPersists,
    unaffected_root_continues: (f) => recoveryFacts(f).continuousDelivered,
    boundary_recovered_and_continuous_delivered: (f) => recoveryFacts(f).allDelivered,
    late_old_session_success: (f) => recoveryFacts(f).oldRedispatched,
    checkpoint_or_linear_rewrite: (f) => Boolean(f.context.recovery?.checkpointObserved),
    unaffected_conductor_reconfigured: (f) => Boolean(f.context.recovery?.continuousConductorReconfigured),
  }),
  missing_worktree_recovery: handlers({
    worktree_missing_detected_before_dispatch: (f) => missingWorktreeFacts(f).detectedBeforeDispatch,
    valid_branch_rematerialized: (f) => missingWorktreeFacts(f).validBranchPreserved,
    invalid_generation_canceled_and_archived: (f) => missingWorktreeFacts(f).invalidGenerationClosed,
    fresh_generation_uses_new_native_ids: (f) => missingWorktreeFacts(f).freshNativeIds,
    fresh_generation_requires_fresh_approval: (f) => missingWorktreeFacts(f).freshApproval,
    boundary_recoverable_and_fresh_generations_delivered: (f) => f.roots.every((root) => deliveryConsistent(f, root)),
    invalid_branch_remounted: (f) => Boolean(f.context.missingWorktree?.invalidBranchRemounted),
    old_generation_authorizes_fresh_work: (f) => missingWorktreeFacts(f).oldApprovalReused,
  }),
});

function createFacts(definition, evidence, context) {
  const roots = Array.isArray(evidence?.roots) ? evidence.roots : [];
  const rootIssueIds = Array.isArray(evidence?.rootIssueIds) ? evidence.rootIssueIds : [];
  const issues = roots.flatMap((root) => Array.isArray(root.issues) ? root.issues : []);
  const comments = roots.flatMap((root) => Array.isArray(root.comments) ? root.comments : []);
  const activity = roots.flatMap((root) => Array.isArray(root.activity) ? root.activity : []);
  const coverageComplete = evidence?.coverage?.isComplete === true && roots.length === rootIssueIds.length &&
    rootIssueIds.every((rootIssueId) => roots.some((root) => root.rootIssueId === rootIssueId)) &&
    roots.every((root) => ["issues", "comments", "relations", "attachments", "activity"].every((key) => Array.isArray(root[key]))) &&
    Array.isArray(evidence?.statusCatalog) && evidence.statusCatalog.length > 0 &&
    Array.isArray(evidence?.git) && evidence.git.length === rootIssueIds.length;
  return Object.freeze({ definition, evidence: evidence ?? {}, context: context ?? {}, roots, rootIssueIds, issues, comments, activity, coverageComplete });
}

function nativeIdentityConsistent(facts) {
  if (new Set(facts.rootIssueIds).size !== facts.rootIssueIds.length) return false;
  for (const root of facts.roots) {
    const ids = new Set(root.issues.map(({ id }) => id));
    if (ids.size !== root.issues.length || !ids.has(root.rootIssueId)) return false;
    for (const issue of root.issues) {
      const kinds = issue.labels.map(({ name }) => name).filter((name) => PRIMARY_KIND_LABELS.includes(name));
      if (issue.id === root.rootIssueId ? kinds.length !== 0 : kinds.length !== 1) return false;
      if (issue.id !== root.rootIssueId && !ids.has(issue.parentId)) return false;
    }
    if (root.relations.some(({ issueId, relatedIssueId }) => !ids.has(issueId) || !ids.has(relatedIssueId))) return false;
  }
  return true;
}

function scopeIsolated(facts) {
  const expected = new Set(facts.rootIssueIds);
  return expected.size === facts.definition.rootTopology.length && facts.roots.every((root) => expected.has(root.rootIssueId) &&
    root.issues.every((issue) => issue.rootIssueId === root.rootIssueId)) &&
    (facts.evidence.git ?? []).every(({ rootIssueId }) => expected.has(rootIssueId));
}

function requirementsPreserved(facts) {
  const byKey = facts.context.rootIssueIdsByKey ?? {};
  return facts.definition.rootCreationInputs.every(({ rootKey, description }) => {
    const rootId = byKey[rootKey] ?? (facts.rootIssueIds.length === 1 ? facts.rootIssueIds[0] : undefined);
    const root = facts.issues.find(({ id }) => id === rootId);
    return typeof root?.description === "string" && root.description.includes(description.split("\n\n## Acceptance Criteria")[0]);
  });
}

function humanProvenancePreserved(facts) {
  const actor = facts.context.humanActorId;
  if (!identifier(actor)) return false;
  return facts.comments.filter(({ authorId }) => authorId === actor).every((comment) =>
    comment.issueId && timestamp(comment.createdAt) && timestamp(comment.remoteVersion));
}

function nativeResultsHaveEvidence(facts) {
  const gitRoots = new Set((facts.evidence.git ?? []).map(({ rootIssueId }) => rootIssueId));
  return facts.roots.every((root) => root.issues.every((issue) => {
    const kind = issueKind(issue);
    if (!isTerminal(issue) || kind !== "Work" && kind !== "Verify") return true;
    if (!gitRoots.has(root.rootIssueId)) return false;
    return kind !== "Verify" || root.attachments.some((attachment) =>
      attachment.issueId === issue.id && attachment.title === "Verified Git revision" && commitRevision(attachment.url));
  }));
}

function deliveryConsistent(facts, root) {
  const rootIssue = root?.issues?.find(({ id }) => id === root.rootIssueId);
  if (rootIssue?.state?.name !== "In Review") return false;
  const cycles = root.issues.filter((issue) => issueKind(issue) === "Cycle" &&
    issue.parentId === root.rootIssueId && issue.state?.name === "Succeeded" && !issue.archivedAt);
  if (cycles.length !== 1) return false;
  const verifies = root.issues.filter((issue) => issueKind(issue) === "Verify" &&
    issue.parentId === cycles[0].id && issue.state?.name === "Done" &&
    issue.labels.some(({ name }) => name === "Passed") && !issue.archivedAt);
  if (verifies.length !== 1) return false;
  const git = (facts.evidence.git ?? []).filter(({ rootIssueId }) => rootIssueId === root.rootIssueId);
  if (git.length !== 1) return false;
  const revisionLinks = root.attachments.filter(({ issueId, title }) =>
    issueId === verifies[0].id && title === "Verified Git revision");
  const revision = revisionLinks.length === 1 ? commitRevision(revisionLinks[0].url) : undefined;
  if (!revision || git[0].headRevision !== revision) return false;
  const pullRequests = root.attachments.filter(({ issueId, title, url }) =>
    issueId === root.rootIssueId && title === "Delivery pull request" && pullRequestUrl(url));
  return pullRequests.length === 1;
}

function commitRevision(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.search && !url.hash &&
      segments.length === 4 && segments[2] === "commit" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segments[3])
      ? segments[3]
      : undefined;
  } catch {
    return undefined;
  }
}

function pullRequestUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.search && !url.hash &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(url.pathname);
  } catch {
    return false;
  }
}

function terminalNodesNotRedispatched(facts) {
  const states = new Map((facts.evidence.statusCatalog ?? []).map((state) => [state.id, state]));
  return facts.issues.every((issue) => {
    const entries = facts.activity.filter((entry) => entry.issueId === issue.id).sort(byCreatedAt);
    const terminalAt = entries.find((entry) => TERMINAL_STATE_TYPES.has(states.get(entry.toStateId)?.type))?.createdAt;
    return !terminalAt || !entries.some((entry) => Date.parse(entry.createdAt) > Date.parse(terminalAt) && states.get(entry.toStateId)?.type === "started");
  });
}

function humanContentOnly(facts) {
  const human = facts.context.humanActorId;
  const descriptions = facts.issues.filter(({ creatorId }) => creatorId !== human).map(({ description }) => description ?? "");
  const comments = facts.comments.filter(({ authorId }) => authorId !== human).map(({ body }) => body);
  return [...descriptions, ...comments].every((body) => !MACHINE_CONTENT.test(body));
}

function humanCreatedProductFacts(facts) {
  const actor = facts.context.humanActorId;
  return facts.issues.some((issue) => issue.depth > 0 && issue.creatorId === actor);
}

function approvalPrecedesWork(facts) {
  const root = facts.roots[0];
  const replyAt = humanApprovalReplies(facts, root)[0]?.createdAt;
  const workAt = firstStartedActivity(facts, root, "Work")?.createdAt;
  return timestamp(replyAt) && timestamp(workAt) && Date.parse(replyAt) < Date.parse(workAt);
}

function workBeforeApproval(facts) {
  const root = facts.roots[0];
  const replyAt = humanApprovalReplies(facts, root)[0]?.createdAt;
  const workAt = firstStartedActivity(facts, root, "Work")?.createdAt;
  return timestamp(replyAt) && timestamp(workAt) && Date.parse(workAt) <= Date.parse(replyAt);
}

function completeCycleTree(_facts, root) {
  const cycles = root.issues.filter((issue) => issueKind(issue) === "Cycle");
  return cycles.some((cycle) => {
    const children = root.issues.filter(({ parentId }) => parentId === cycle.id);
    return children.some((issue) => issueKind(issue) === "Plan") && children.some((issue) => issueKind(issue) === "Work") &&
      children.some((issue) => issueKind(issue) === "Verify");
  });
}

function duplicateNativeCompletion(facts) {
  return facts.roots.some((root) => {
    const keys = root.issues.map((issue) => `${issueKind(issue)}:${issue.parentId}:${issue.title}`);
    return new Set(keys).size !== keys.length;
  });
}

function rejectedPlanFacts(facts) {
  const root = facts.roots[0];
  const plans = root.issues.filter((issue) => issueKind(issue) === "Plan").sort(byCreatedAt);
  const oldPlan = plans[0];
  const freshPlan = plans.at(-1);
  const replies = facts.comments.filter((comment) => comment.authorId === facts.context.humanActorId && /reject|preserve|should/iu.test(comment.body));
  const requests = approvalRequests(facts, root);
  return {
    replied: replies.length === 1,
    historyRetained: Boolean(oldPlan && (oldPlan.archivedAt || isTerminal(oldPlan))),
    freshPlan: plans.length >= 2 && oldPlan.id !== freshPlan.id,
    freshReview: plans.length >= 2 && requests.some((comment) => comment.body.includes(freshPlan.id) || comment.body.includes(freshPlan.identifier)),
    oldWorkDispatched: Boolean(oldPlan && root.issues.some((issue) => issueKind(issue) === "Work" && issue.createdAt <= oldPlan.updatedAt)),
    humanCreatedFreshPlan: freshPlan?.creatorId === facts.context.humanActorId,
  };
}

function informationFacts(facts) {
  const root = facts.roots[0];
  const requests = root.comments.filter((comment) => comment.parentId === null && comment.authorId !== facts.context.humanActorId && /(?:information|clarif|which|what|please provide)/iu.test(comment.body));
  const answers = root.comments.filter((comment) => comment.authorId === facts.context.humanActorId && requests.some(({ id }) => comment.parentId === id));
  const answerAt = answers[0]?.createdAt;
  const plans = root.issues.filter((issue) => issueKind(issue) === "Plan").sort(byCreatedAt);
  const freshPlan = plans.find((plan) => timestamp(answerAt) && Date.parse(plan.createdAt) > Date.parse(answerAt));
  return {
    actionable: requests.length === 1 && requests[0].body.trim().length >= 12,
    receipted: answers.length === 1 && hasReceipt(answers[0], facts.context.humanActorId),
    freshPlan: Boolean(freshPlan),
    freshReview: Boolean(freshPlan && approvalRequests(facts, root).some((comment) => comment.body.includes(freshPlan.id) || comment.body.includes(freshPlan.identifier))),
    planBeforeAnswer: plans.some((plan) => timestamp(answerAt) && Date.parse(plan.createdAt) > Date.parse(requests[0]?.createdAt ?? 0) && Date.parse(plan.createdAt) < Date.parse(answerAt)),
    humanCreatedPlan: freshPlan?.creatorId === facts.context.humanActorId,
  };
}

function revisionFacts(facts) {
  const root = facts.roots[0];
  const humanComments = root.comments.filter(({ authorId }) => authorId === facts.context.humanActorId);
  const receipts = humanComments.filter((comment) => hasReceipt(comment, facts.context.humanActorId));
  const cycles = root.issues.filter((issue) => issueKind(issue) === "Cycle").sort(byCreatedAt);
  const fresh = cycles.at(-1);
  return {
    inputsReceipted: receipts.length === humanComments.length && new Set(receipts.map(({ id }) => id)).size === receipts.length,
    threadReceipted: humanComments.every((comment) => comment.thread?.state !== "unknown"),
    successorCycle: cycles.length >= 2 && isTerminal(cycles[0]) && cycles[0].id !== fresh.id,
    freshReview: Boolean(fresh && approvalRequests(facts, root).length > 0),
    systemReceipt: root.comments.some((comment) => comment.authorId !== facts.context.humanActorId && hasReceipt(comment, facts.context.humanActorId)),
    historyRetained: root.activity.some(({ updatedDescription }) => updatedDescription === true) && humanComments.some(({ editedAt }) => editedAt),
    undeclaredRequirement: false,
  };
}

function routingAndRepositoriesIsolated(facts) {
  const routes = facts.roots.map((root) => routingLabels(root)[0]);
  const repositories = (facts.evidence.git ?? []).map(({ repositoryRootCanonical }) => repositoryRootCanonical);
  return routes.every(Boolean) && new Set(repositories).size === facts.roots.length;
}

function routingViolation(facts) {
  return facts.roots.some((root) => routingLabels(root).length !== 1);
}

function sharedRepository(facts) {
  const roots = (facts.evidence.git ?? []).map(({ repositoryRootCanonical }) => repositoryRootCanonical);
  return new Set(roots).size !== roots.length;
}

function preemptionFacts(facts) {
  const context = facts.context.preemption ?? {};
  const inflight = facts.issues.find(({ id }) => id === context.inflightIssueId);
  const touched = firstActivityForRoot(facts, context.touchedRootId);
  const remaining = firstActivityForRoot(facts, context.remainingRootId);
  const low = firstActivityForRoot(facts, context.lowPriorityRootId);
  return {
    inflightTerminal: Boolean(inflight && isTerminal(inflight)),
    touchedRunsNext: Boolean(touched && context.inflightTerminalAt && Date.parse(touched.createdAt) > Date.parse(context.inflightTerminalAt)),
    priorityOrdered: Boolean(touched && remaining && low && Date.parse(touched.createdAt) < Date.parse(low.createdAt) && Date.parse(remaining.createdAt) < Date.parse(low.createdAt)),
    remainingProgresses: Boolean(remaining),
    inflightInterrupted: Boolean(context.inflightInterrupted),
  };
}

function recoveryFacts(facts) {
  const context = facts.context.recovery ?? {};
  const oldIssue = facts.issues.find(({ id }) => id === context.oldIssueId);
  const successor = facts.issues.find(({ id }) => id === context.successorIssueId);
  const affected = facts.roots.find(({ rootIssueId }) => rootIssueId === context.affectedRootId);
  const continuous = facts.roots.find(({ rootIssueId }) => rootIssueId === context.continuousRootId);
  return {
    oldTerminalOnce: Boolean(oldIssue && isTerminal(oldIssue) && terminalTransitionCount(facts, oldIssue.id) === 1),
    freshSuccessor: Boolean(successor && successor.id !== oldIssue?.id && successor.parentId === oldIssue?.parentId),
    routingPersists: Boolean(affected && routingLabels(affected).length === 1),
    continuousDelivered: deliveryConsistent(facts, continuous),
    allDelivered: deliveryConsistent(facts, affected) && deliveryConsistent(facts, continuous),
    oldRedispatched: oldIssue ? redispatchedAfterTerminal(facts, oldIssue.id) : false,
  };
}

function missingWorktreeFacts(facts) {
  const context = facts.context.missingWorktree ?? {};
  const recoverable = facts.roots.find(({ rootIssueId }) => rootIssueId === context.recoverableRootId);
  const invalid = facts.roots.find(({ rootIssueId }) => rootIssueId === context.invalidRootId);
  const oldIds = new Set(context.oldNativeIssueIds ?? []);
  const freshIssues = nativeSubtree(invalid?.issues ?? [], context.freshCycleIssueId);
  const newIds = new Set(freshIssues.map(({ id }) => id));
  const freshKinds = new Set(freshIssues.map(issueKind));
  const oldCycle = invalid?.issues.find(({ id }) => id === context.oldCycleId);
  return {
    detectedBeforeDispatch: timestamp(context.missingDetectedAt) && timestamp(context.firstPostRecoveryDispatchAt) && Date.parse(context.missingDetectedAt) < Date.parse(context.firstPostRecoveryDispatchAt),
    validBranchPreserved: Boolean(recoverable && context.beforeRevision === context.afterRevision && context.rematerializedBranch === context.originalBranch),
    invalidGenerationClosed: Boolean(oldCycle && oldCycle.state?.name === "Canceled" && invalid.issues.filter(({ id }) => oldIds.has(id)).every(({ archivedAt }) => archivedAt)),
    freshNativeIds: newIds.size >= 4 && newIds.has(context.freshPlanIssueId) &&
      ["Cycle", "Plan", "Work", "Verify"].every((kind) => freshKinds.has(kind)) &&
      [...newIds].every((id) => !oldIds.has(id)),
    freshApproval: Boolean(context.freshApprovalCommentId && invalid?.comments.some(({ id }) => id === context.freshApprovalCommentId)),
    oldApprovalReused: context.oldApprovalCommentId === context.freshApprovalCommentId,
  };
}

function nativeSubtree(issues, rootIssueId) {
  if (!identifier(rootIssueId)) return [];
  const byParent = new Map();
  for (const issue of issues) {
    const children = byParent.get(issue.parentId) ?? [];
    children.push(issue);
    byParent.set(issue.parentId, children);
  }
  const root = issues.find(({ id }) => id === rootIssueId);
  if (!root) return [];
  const result = [];
  const pending = [root];
  const seen = new Set();
  while (pending.length > 0) {
    const issue = pending.shift();
    if (seen.has(issue.id)) return [];
    seen.add(issue.id);
    result.push(issue);
    pending.push(...(byParent.get(issue.id) ?? []));
  }
  return result;
}

function approvalRequests(facts, root) {
  const human = facts.context.humanActorId;
  return root.comments.filter((comment) => comment.issueId === root.rootIssueId && comment.parentId === null && comment.authorId !== human && /approv|review/iu.test(comment.body));
}

function humanApprovalReplies(facts, root) {
  const requestIds = new Set(approvalRequests(facts, root).map(({ id }) => id));
  return root.comments.filter((comment) => comment.authorId === facts.context.humanActorId && requestIds.has(comment.parentId) && /approv|yes|accept/iu.test(comment.body));
}

function firstStartedActivity(facts, root, kind) {
  const ids = new Set(root.issues.filter((issue) => issueKind(issue) === kind).map(({ id }) => id));
  const started = new Set((facts.evidence.statusCatalog ?? []).filter(({ type }) => type === "started").map(({ id }) => id));
  return facts.activity.filter(({ issueId, toStateId }) => ids.has(issueId) && started.has(toStateId)).sort(byCreatedAt)[0];
}

function firstActivityForRoot(facts, rootId) {
  const ids = new Set(facts.roots.find(({ rootIssueId }) => rootIssueId === rootId)?.issues.map(({ id }) => id) ?? []);
  return facts.activity.filter(({ issueId }) => ids.has(issueId)).sort(byCreatedAt)[0];
}

function processIntervalsOverlap(intervals) {
  if (!Array.isArray(intervals) || intervals.length < 2) return false;
  return intervals.some((left, index) => intervals.slice(index + 1).some((right) =>
    left.conductorId !== right.conductorId && timestamp(left.startedAt) && timestamp(left.completedAt) &&
    timestamp(right.startedAt) && timestamp(right.completedAt) &&
    Date.parse(left.startedAt) < Date.parse(right.completedAt) && Date.parse(right.startedAt) < Date.parse(left.completedAt)));
}

function routingLabels(root) {
  const issue = root.issues.find(({ id }) => id === root.rootIssueId);
  return issue?.labels.filter(({ name }) => /^symphony:conductor\//u.test(name)) ?? [];
}

function issueKind(issue) {
  const names = issue?.labels?.map(({ name }) => name).filter((name) => PRIMARY_KIND_LABELS.includes(name)) ?? [];
  return names.length === 1 ? names[0] : undefined;
}

function isTerminal(issue) { return TERMINAL_STATE_TYPES.has(issue?.state?.type); }
function hasReceipt(comment, humanActorId) { return comment.reactions.some(({ actorId, emoji }) => actorId !== humanActorId && ["white_check_mark", "x", "✅", "❌"].includes(emoji)); }
function byCreatedAt(left, right) { return Date.parse(left.createdAt) - Date.parse(right.createdAt); }
function terminalTransitionCount(facts, issueId) { const terminal = new Set((facts.evidence.statusCatalog ?? []).filter(({ type }) => TERMINAL_STATE_TYPES.has(type)).map(({ id }) => id)); return facts.activity.filter((entry) => entry.issueId === issueId && terminal.has(entry.toStateId)).length; }
function redispatchedAfterTerminal(facts, issueId) { const issue = facts.issues.find(({ id }) => id === issueId); if (!issue || !isTerminal(issue)) return false; return !terminalNodesNotRedispatched({ ...facts, issues: [issue] }); }
function handlers(value) { return Object.freeze(value); }
function booleanOutcome(value) { return value ? "satisfied" : "contradicted"; }

function referencesFor(assertion, facts) {
  const roots = new Set(facts.rootIssueIds);
  return [...facts.issues, ...facts.comments, ...facts.activity]
    .filter((item) => roots.has(item.rootIssueId) || roots.has(item.id) || facts.issues.some((issue) => issue.id === item.issueId && roots.has(issue.rootIssueId)))
    .slice(0, Math.max(1, assertion.correlation.length))
    .map((item) => ({ sourceId: item.id, remoteVersion: item.remoteVersion ?? item.updatedAt ?? item.createdAt }));
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

function validateDefinition(definition) {
  const canonical = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === definition?.caseId);
  if (!canonical || !sameContractValue(definition, canonical) || !Array.isArray(definition.assertions) ||
      definition.assertions.length === 0 || definition.assertions.some((assertion) =>
        !identifier(assertion.assertionId) || !["required", "prohibited", "boundary"].includes(assertion.kind) ||
        !stringList(assertion.factScope) || !stringList(assertion.correlation) ||
        assertion.reasonCode !== `e2e.${definition.caseId}.${assertion.assertionId}` || hasExecutableValue(assertion))) {
    throw stableError("foreground_e2e_assertion_catalog_invalid");
  }
}

function verdict(value, assertions, outcome, processFault) {
  return Object.freeze({
    verdict: value,
    reasonCodes: Object.freeze([
      ...assertions.filter((item) => item.outcome === outcome).map(({ reasonCode }) => reasonCode).filter(Boolean).sort(),
      ...(processFault === undefined ? [] : [processFault]),
    ]),
  });
}

function observe(reporter, observation) { try { reporter?.caseObservation(observation); } catch {} }
function caseDriverFailureCode(error) { return identifier(error?.code) ? error.code : "foreground_e2e_case_driver_failed"; }
function runWithinCaseScope(operation, scope) {
  if (scope.signal.aborted) return Promise.reject(caseScopeAbortError(scope));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete, value) => { if (settled) return; settled = true; scope.signal.removeEventListener("abort", onAbort); complete(value); };
    const onAbort = () => finish(reject, caseScopeAbortError(scope));
    scope.signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(operation).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
function caseScopeAbortError(scope) { const fault = scope.processFault?.(); return identifier(fault) ? stableError(fault) : stableError(scope.deadlineExceeded?.() ? "foreground_e2e_case_deadline_exceeded" : "foreground_e2e_case_aborted"); }
function defaultCaseScope({ definition }) { return Object.freeze({ caseId: definition.caseId, signal: new AbortController().signal }); }
function sameContractValue(left, right) { if (left === right) return true; if (!left || !right || typeof left !== "object" || typeof right !== "object") return false; if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => sameContractValue(entry, right[index])); const leftKeys = Object.keys(left).sort(); const rightKeys = Object.keys(right).sort(); return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameContractValue(left[key], right[key])); }
function hasExecutableValue(value) { return typeof value === "function" || Boolean(value && typeof value === "object" && Object.values(value).some(hasExecutableValue)); }
function validAssertionOutcome(item) { return item && ["satisfied", "contradicted", "coverage_missing"].includes(item.outcome) && typeof item.reasonCodePrefix === "string"; }
function stringList(value) { return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0); }
function identifier(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value); }
function timestamp(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function requiredTimestamp(value) { if (!timestamp(value)) throw stableError("foreground_e2e_clock_invalid"); return value; }
function elapsedMilliseconds(startedAt, completedAt) { return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)); }
function stableError(code) { const error = new Error(code); error.code = code; return error; }
