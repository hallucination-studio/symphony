const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function assessCycleSuccessorEvidence(row) {
  try {
    const input = rowInput(row);
    const tree = exact(input.snapshot.root_trees.filter((candidate) => candidate?.root_issue_id === input.rootIssueId));
    if (!tree || !validTree(tree)) return outcome("inconclusive", "cycle_successor_root_missing");
    const facts = collectFacts(tree);
    if (facts.invalid) return outcome("inconclusive", "cycle_successor_evidence_invalid");

    const root = exact(tree.issues.filter((issue) => issue?.issue_id === input.rootIssueId && issue?.parent_issue_id === null));
    if (!root) return outcome("inconclusive", "cycle_successor_root_missing");

    const policy = one(facts.rootConvergencePolicies.filter(({ record, sourceIssueId }) =>
      sourceIssueId === input.rootIssueId && validPolicy(record, input.rootIssueId),
    ));
    if (policy.kind !== "one") return outcome(policy.kind === "none" ? "inconclusive" : "violated", `cycle_successor_policy_${policy.kind}`);

    const exhausted = one(facts.cycleOutcomes.filter(({ record, sourceIssueId }) =>
      sourceIssueId === record?.cycle_issue_id && validCycleOutcome(record, input.rootIssueId) && record.conclusion === "exhausted",
    ));
    if (exhausted.kind !== "one") return outcome(exhausted.kind === "none" ? "inconclusive" : "violated", `cycle_successor_outcome_${exhausted.kind}`);
    const predecessor = issue(tree, exhausted.value.record.cycle_issue_id);
    if (!predecessor) return outcome("inconclusive", "cycle_successor_predecessor_missing");
    if (predecessor.parent_issue_id !== input.rootIssueId || statusName(predecessor) !== "Changes Required") {
      return outcome("violated", "cycle_successor_predecessor_terminal_invalid");
    }

    const conclusionDirective = one(facts.rootDirectives.filter(({ record, sourceIssueId }) =>
      sourceIssueId === input.rootIssueId && validRootDirective(record, input.rootIssueId) &&
      record.root_directive_id === exhausted.value.record.source_root_directive_id &&
      record.directive.action.kind === "conclude_cycle" &&
      record.directive.action.cycle_issue_id === predecessor.issue_id &&
      record.directive.action.conclusion === "exhausted",
    ));
    if (conclusionDirective.kind !== "one") {
      return outcome(conclusionDirective.kind === "none" ? "inconclusive" : "violated", `cycle_successor_conclusion_directive_${conclusionDirective.kind}`);
    }
    if (!sameStringSet(exhausted.value.record.unresolved_finding_ids, conclusionDirective.value.record.directive.action.unresolved_finding_ids) ||
        !sameEvidenceRefs(exhausted.value.record.attempted_approach_refs, conclusionDirective.value.record.directive.action.attempted_approach_refs) ||
        !sameEvidenceRefs(exhausted.value.record.verification_evidence_refs, conclusionDirective.value.record.directive.action.verification_evidence_refs)) {
      return outcome("violated", "cycle_successor_outcome_directive_mismatch");
    }

    const convergence = one(facts.convergences.filter(({ record, sourceIssueId }) =>
      sourceIssueId === input.rootIssueId && validConvergence(record, input.rootIssueId),
    ));
    if (convergence.kind !== "one") return outcome(convergence.kind === "none" ? "inconclusive" : "violated", `cycle_successor_convergence_${convergence.kind}`);
    if (convergence.value.record.trigger !== "max_cycle_repair_attempts" ||
        convergence.value.record.policy_id !== policy.value.record.policy_id ||
        !samePolicyValues(convergence.value.record.policy, policy.value.record) ||
        convergence.value.record.view.active_cycle_issue_id !== predecessor.issue_id ||
        convergence.value.record.view.active_cycle_repair_attempts <= policy.value.record.max_cycle_repair_attempts ||
        exhausted.value.record.unresolved_finding_ids.some((findingId) => !convergence.value.record.view.open_finding_persistence
          .some((entry) => entry.finding_id === findingId && entry.open_cycle_count > 0))) {
      return outcome("violated", "cycle_successor_convergence_mismatch");
    }

    const repairEvidence = assessRepairEvidence({ facts, predecessorCycleIssueId: predecessor.issue_id, outcomeRecord: exhausted.value.record });
    if (repairEvidence !== null) return repairEvidence;

    const successorDirective = one(facts.rootDirectives.filter(({ record, sourceIssueId }) =>
      sourceIssueId === input.rootIssueId && validRootDirective(record, input.rootIssueId) &&
      record.directive.action.kind === "create_cycle" &&
      record.directive.action.predecessor_cycle_issue_id === predecessor.issue_id &&
      record.directive.action.reason === "exhausted",
    ));
    if (successorDirective.kind !== "one") {
      return outcome(successorDirective.kind === "none" ? "inconclusive" : "violated", `cycle_successor_directive_${successorDirective.kind}`);
    }
    if (Date.parse(successorDirective.value.record.accepted_at) < Date.parse(exhausted.value.record.concluded_at)) {
      return outcome("violated", "cycle_successor_directive_order_invalid");
    }

    const successor = successorCycle(tree, facts, input.rootIssueId, successorDirective.value.record.root_directive_id);
    if (successor.kind !== "one") return outcome(successor.kind === "none" ? "inconclusive" : "violated", `cycle_successor_cycle_${successor.kind}`);
    if (statusName(successor.value.issue) !== "Planning") return outcome("violated", "cycle_successor_cycle_status_invalid");
    if (!tree.relations.some((relation) => relation?.relation_kind === "relates_to" &&
      relation.issue_id === predecessor.issue_id && relation.related_issue_id === successor.value.issue.issue_id)) {
      return outcome("violated", "cycle_successor_predecessor_relation_missing");
    }

    const plan = successorPlan(tree, facts, input.rootIssueId, successor.value.issue.issue_id, successorDirective.value.record.root_directive_id);
    if (plan.kind !== "one") return outcome(plan.kind === "none" ? "inconclusive" : "violated", `cycle_successor_plan_${plan.kind}`);
    if (statusName(plan.value.issue) !== "In Review") return outcome("violated", "cycle_successor_plan_status_invalid");

    const freshPlan = assessFreshPlan({
      facts,
      rootIssueId: input.rootIssueId,
      predecessorCycleIssueId: predecessor.issue_id,
      predecessorPlanDigest: exhausted.value.record.plan_contract_digest,
      successorCycleIssueId: successor.value.issue.issue_id,
      successorPlanIssueId: plan.value.issue.issue_id,
      concludedAt: exhausted.value.record.concluded_at,
    });
    if (freshPlan !== null) return freshPlan;
    return outcome("satisfied", "cycle_successor_confirmed");
  } catch {
    return outcome("inconclusive", "cycle_successor_evidence_invalid");
  }
}

export function analyzeCycleSuccessorCampaignEvidence({ rows } = {}) {
  if (!Array.isArray(rows)) return Object.freeze({ case_outcomes: Object.freeze([]) });
  return Object.freeze({
    case_outcomes: Object.freeze(rows
      .filter((row) => row?.e2eCase?.evidence_predicate_id === "cycle_successor")
      .map((row) => Object.freeze({ case_id: row.e2eCase.case_id, outcome: assessCycleSuccessorEvidence(row) }))),
  });
}

function assessRepairEvidence({ facts, predecessorCycleIssueId, outcomeRecord }) {
  if (outcomeRecord.unresolved_finding_ids.length === 0) return outcome("inconclusive", "cycle_successor_finding_missing");
  const verifyResults = facts.stageResults.filter(({ record }) =>
    validStageResult(record) && record.cycle_issue_id === predecessorCycleIssueId && record.stage === "verify" &&
    record.outcome_kind === "verify_changes_required",
  );
  if (verifyResults.length === 0) return outcome("inconclusive", "cycle_successor_verify_missing");
  if (verifyResults.length !== 1) return outcome("violated", "cycle_successor_verify_ambiguous");
  const verify = verifyResults[0].record;
  const verifyStructured = facts.verifyResults.filter(({ record }) => validVerifyResult(record) &&
    record.root_issue_id === verify.root_issue_id && record.cycle_issue_id === predecessorCycleIssueId &&
    record.node_issue_id === verify.node_issue_id && record.stage_execution_id === verify.model_turn.stage_execution_id &&
    record.conclusion === "changes_required",
  );
  if (verifyStructured.length === 0) return outcome("inconclusive", "cycle_successor_verify_result_missing");
  if (verifyStructured.length !== 1) return outcome("violated", "cycle_successor_verify_result_ambiguous");

  for (const findingId of outcomeRecord.unresolved_finding_ids) {
    const findings = facts.findings.filter(({ record }) => validFinding(record) && record.finding_id === findingId &&
      record.source_verify_id === verify.model_turn.stage_execution_id);
    if (findings.length === 0) return outcome("inconclusive", "cycle_successor_finding_missing");
    if (findings.length !== 1) return outcome("violated", "cycle_successor_finding_ambiguous");
    if (facts.findingDispositions.some(({ record }) => validFindingDisposition(record) && record.finding_id === findingId &&
      record.source_verify_id === verify.model_turn.stage_execution_id && ["resolved", "waived"].includes(record.disposition))) {
      return outcome("violated", "cycle_successor_finding_not_open");
    }
  }
  const resultIds = new Set(facts.stageResults.filter(({ record }) => validStageResult(record) &&
    record.cycle_issue_id === predecessorCycleIssueId).map(({ record }) => record.result_id));
  if (!validEvidenceRefs(outcomeRecord.attempted_approach_refs) || outcomeRecord.attempted_approach_refs.length === 0 ||
      outcomeRecord.attempted_approach_refs.some(({ source_kind: sourceKind, reference_id: referenceId }) =>
        sourceKind !== "result" || !resultIds.has(referenceId))) {
    return outcome("inconclusive", "cycle_successor_attempt_evidence_missing");
  }
  if (!validEvidenceRefs(outcomeRecord.verification_evidence_refs) || outcomeRecord.verification_evidence_refs.length === 0 ||
      outcomeRecord.verification_evidence_refs.some(({ source_kind: sourceKind, reference_id: referenceId }) =>
        sourceKind !== "result" || referenceId !== verify.result_id)) {
    return outcome("inconclusive", "cycle_successor_verification_evidence_missing");
  }
  return null;
}

function assessFreshPlan({
  facts,
  rootIssueId,
  predecessorCycleIssueId,
  predecessorPlanDigest,
  successorCycleIssueId,
  successorPlanIssueId,
  concludedAt,
}) {
  const predecessorPlans = facts.stageResults.filter(({ record }) => validStageResult(record) &&
    record.root_issue_id === rootIssueId && record.cycle_issue_id === predecessorCycleIssueId &&
    record.stage === "plan" && record.outcome_kind === "plan_completed" && record.plan_contract_digest === predecessorPlanDigest,
  );
  if (predecessorPlans.length === 0) return outcome("inconclusive", "cycle_successor_predecessor_plan_missing");
  if (predecessorPlans.length !== 1) return outcome("violated", "cycle_successor_predecessor_plan_ambiguous");
  const executions = facts.stageExecutions.filter(({ record }) => validStageExecution(record) &&
    record.root_issue_id === rootIssueId && record.cycle_issue_id === successorCycleIssueId &&
    record.node_issue_id === successorPlanIssueId && record.stage === "plan",
  );
  if (executions.length === 0) return outcome("inconclusive", "cycle_successor_plan_execution_missing");
  if (executions.length !== 1) return outcome("violated", "cycle_successor_plan_execution_ambiguous");
  const execution = executions[0].record;
  const results = facts.stageResults.filter(({ record }) => validStageResult(record) &&
    record.root_issue_id === rootIssueId && record.cycle_issue_id === successorCycleIssueId &&
    record.node_issue_id === successorPlanIssueId && record.stage === "plan" && record.outcome_kind === "plan_completed" &&
    record.model_turn.stage_execution_id === execution.stage_execution_id,
  );
  if (results.length === 0) return outcome("inconclusive", "cycle_successor_plan_result_missing");
  if (results.length !== 1) return outcome("violated", "cycle_successor_plan_result_ambiguous");
  const result = results[0].record;
  const contracts = facts.planContracts.filter(({ record, sourceIssueId }) => validPlanContract(record) &&
    sourceIssueId === successorPlanIssueId && record.root_issue_id === rootIssueId &&
    record.cycle_issue_id === successorCycleIssueId && record.plan_contract_digest === result.plan_contract_digest,
  );
  if (contracts.length === 0) return outcome("inconclusive", "cycle_successor_plan_contract_missing");
  if (contracts.length !== 1) return outcome("violated", "cycle_successor_plan_contract_ambiguous");
  if (result.plan_contract_digest === predecessorPlanDigest ||
      result.role_session_id === predecessorPlans[0].record.role_session_id ||
      Date.parse(execution.started_at) <= Date.parse(concludedAt) || Date.parse(result.completed_at) <= Date.parse(concludedAt)) {
    return outcome("violated", "cycle_successor_plan_not_fresh");
  }
  return null;
}

function successorCycle(tree, facts, rootIssueId, directiveId) {
  return one(facts.workflowIssues.filter(({ record, sourceIssueId }) => validWorkflowIssue(record) &&
    record.root_issue_id === rootIssueId && record.parent_issue_id === rootIssueId &&
    record.issue_kind === "cycle" && record.issue_key === `${directiveId}:cycle`,
  ).map((entry) => ({ ...entry, issue: issue(tree, entry.sourceIssueId) })).filter(({ issue: value }) => value !== undefined));
}

function successorPlan(tree, facts, rootIssueId, successorCycleIssueId, directiveId) {
  return one(facts.workflowIssues.filter(({ record, sourceIssueId }) => validWorkflowIssue(record) &&
    record.root_issue_id === rootIssueId && record.parent_issue_id === successorCycleIssueId &&
    record.issue_kind === "plan" && record.issue_key === `${directiveId}:plan`,
  ).map((entry) => ({ ...entry, issue: issue(tree, entry.sourceIssueId) })).filter(({ issue: value }) => value !== undefined));
}

function collectFacts(tree) {
  const comments = new Map(tree.comments.map((comment) => [comment?.comment_id, comment]));
  const issueIds = new Set(tree.issues.map((issue) => issue?.issue_id));
  const facts = {
    invalid: false,
    rootConvergencePolicies: [], convergences: [], cycleOutcomes: [], rootDirectives: [], workflowIssues: [],
    findings: [], findingDispositions: [], stageExecutions: [], stageResults: [], verifyResults: [], planContracts: [],
  };
  for (const block of tree.managed_blocks) {
    if (!object(block) || !object(block.record) || !identifier(block.source_id) || !identifier(block.record.kind)) {
      facts.invalid = true;
      continue;
    }
    let sourceIssueId;
    if (block.source_kind === "comment") {
      const comment = comments.get(block.source_id);
      if (!comment || !identifier(block.issue_id) || comment.issue_id !== block.issue_id) {
        facts.invalid = true;
        continue;
      }
      sourceIssueId = block.issue_id;
    } else if (block.source_kind === "issue_description") {
      if (!issueIds.has(block.source_id)) {
        facts.invalid = true;
        continue;
      }
      sourceIssueId = block.source_id;
    } else {
      facts.invalid = true;
      continue;
    }
    const group = groupFor(block.record.kind);
    if (group) facts[group].push({ record: block.record, sourceIssueId });
  }
  return facts;
}

function groupFor(kind) {
  return {
    root_convergence_policy: "rootConvergencePolicies", convergence: "convergences", cycle_outcome: "cycleOutcomes",
    root_directive: "rootDirectives", workflow_issue: "workflowIssues", finding: "findings",
    finding_disposition: "findingDispositions", stage_execution: "stageExecutions", stage_result: "stageResults",
    verify_result: "verifyResults", plan_contract: "planContracts",
  }[kind];
}

function rowInput(row) {
  const value = object(row);
  const e2eCase = object(value?.e2eCase);
  const caseRoots = object(value?.caseRoots);
  const context = object(value?.caseContext);
  const snapshot = object(value?.snapshot);
  if (!identifier(e2eCase?.case_id) || e2eCase.evidence_predicate_id !== "cycle_successor" ||
      !Array.isArray(caseRoots?.root_issue_ids) || caseRoots.root_issue_ids.length !== 1 || !identifier(caseRoots.root_issue_ids[0]) ||
      !Array.isArray(context?.conductors) || context.conductors.length !== 1 || !identifier(context.conductors[0]?.conductor_id) ||
      snapshot?.kind !== "complete" || !Array.isArray(snapshot.root_trees)) {
    throw new Error("cycle successor row invalid");
  }
  return { rootIssueId: caseRoots.root_issue_ids[0], snapshot };
}

function validTree(tree) {
  return object(tree) && Array.isArray(tree.issues) && Array.isArray(tree.comments) &&
    Array.isArray(tree.relations) && Array.isArray(tree.managed_blocks);
}

function validPolicy(record, rootIssueId) {
  return record?.kind === "root_convergence_policy" && record.version === 1 &&
    identifier(record.policy_id) && record.root_issue_id === rootIssueId &&
    [record.max_cycles_per_root, record.max_same_open_finding_cycles, record.max_consecutive_no_progress, record.max_total_tokens]
      .every(positiveInteger) && nonNegativeInteger(record.max_cycle_repair_attempts) && timestamp(record.deadline_at);
}

function validConvergence(record, rootIssueId) {
  return record?.kind === "convergence" && record.version === 1 && identifier(record.convergence_record_id) &&
    record.root_issue_id === rootIssueId && identifier(record.policy_id) && object(record.policy) && object(record.view) &&
    [record.policy.max_cycles_per_root, record.policy.max_same_open_finding_cycles, record.policy.max_consecutive_no_progress, record.policy.max_total_tokens]
      .every(positiveInteger) && nonNegativeInteger(record.policy.max_cycle_repair_attempts) && timestamp(record.policy.deadline_at) &&
    identifier(record.view.active_cycle_issue_id) && nonNegativeInteger(record.view.active_cycle_repair_attempts) &&
    Array.isArray(record.view.open_finding_persistence) && record.view.open_finding_persistence.every((entry) =>
      identifier(entry?.finding_id) && positiveInteger(entry.open_cycle_count)) &&
    record.trigger === "max_cycle_repair_attempts";
}

function validCycleOutcome(record, rootIssueId) {
  return record?.kind === "cycle_outcome" && record.version === 1 && identifier(record.cycle_outcome_id) &&
    record.root_issue_id === rootIssueId && identifier(record.cycle_issue_id) && identifier(record.source_root_directive_id) &&
    identifier(record.plan_contract_digest) && record.conclusion === "exhausted" && uniqueIdentifiers(record.completed_work_ids) &&
    uniqueIdentifiers(record.unresolved_finding_ids) && validEvidenceRefs(record.attempted_approach_refs) &&
    validEvidenceRefs(record.verification_evidence_refs) && identifier(record.git_revision) && object(record.budget_usage) &&
    record.budget_usage.scope === "cycle" && nonNegativeInteger(record.budget_usage.source_record_count) &&
    identifier(record.budget_usage.source_digest) && typeof record.budget_usage.is_complete === "boolean" &&
    nonNegativeInteger(record.budget_usage.unknown_turn_count) && Array.isArray(record.budget_usage.groups) &&
    record.successor_reason === "exhausted" && timestamp(record.concluded_at);
}

function validRootDirective(record, rootIssueId) {
  return record?.kind === "root_directive" && record.version === 1 && identifier(record.root_directive_id) &&
    record.root_issue_id === rootIssueId && timestamp(record.accepted_at) && object(record.directive) &&
    record.directive.root_directive_id === record.root_directive_id && object(record.directive.action) &&
    typeof record.directive.action.kind === "string";
}

function validWorkflowIssue(record) {
  return record?.kind === "workflow_issue" && record.version === 1 && identifier(record.issue_key) &&
    identifier(record.root_issue_id) && identifier(record.parent_issue_id) && ["cycle", "plan"].includes(record.issue_kind);
}

function validStageExecution(record) {
  return record?.kind === "stage_execution" && record.version === 1 && identifier(record.stage_execution_id) &&
    identifier(record.root_issue_id) && identifier(record.cycle_issue_id) && identifier(record.node_issue_id) &&
    record.stage === "plan" && timestamp(record.started_at);
}

function validStageResult(record) {
  return record?.kind === "stage_result" && record.version === 1 && identifier(record.result_id) &&
    identifier(record.root_issue_id) && identifier(record.cycle_issue_id) && identifier(record.node_issue_id) &&
    ["plan", "work", "verify"].includes(record.stage) && identifier(record.role_session_id) && identifier(record.plan_contract_digest) &&
    timestamp(record.completed_at) && object(record.model_turn) && identifier(record.model_turn.stage_execution_id) &&
    record.model_turn.root_issue_id === record.root_issue_id && record.model_turn.cycle_issue_id === record.cycle_issue_id &&
    record.model_turn.target_issue_id === record.node_issue_id && record.model_turn.role_session_id === record.role_session_id;
}

function validVerifyResult(record) {
  return record?.kind === "verify_result" && record.version === 1 && identifier(record.stage_execution_id) &&
    identifier(record.root_issue_id) && identifier(record.cycle_issue_id) && identifier(record.node_issue_id) &&
    record.conclusion === "changes_required";
}

function validFinding(record) {
  return record?.kind === "finding" && record.version === 1 && identifier(record.finding_id) && identifier(record.source_verify_id);
}

function validFindingDisposition(record) {
  return record?.kind === "finding_disposition" && record.version === 1 &&
    identifier(record.finding_id) && identifier(record.source_verify_id) &&
    ["still_open", "resolved", "waived"].includes(record.disposition);
}

function validPlanContract(record) {
  return record?.kind === "plan_contract" && record.version === 1 && identifier(record.root_issue_id) &&
    identifier(record.cycle_issue_id) && identifier(record.plan_contract_digest);
}

function samePolicyValues(left, right) {
  return left.max_cycles_per_root === right.max_cycles_per_root &&
    left.max_same_open_finding_cycles === right.max_same_open_finding_cycles &&
    left.max_consecutive_no_progress === right.max_consecutive_no_progress &&
    left.max_total_tokens === right.max_total_tokens &&
    left.max_cycle_repair_attempts === right.max_cycle_repair_attempts && left.deadline_at === right.deadline_at;
}

function sameStringSet(left, right) {
  return uniqueIdentifiers(left) && uniqueIdentifiers(right) && left.length === right.length &&
    left.every((value) => right.includes(value));
}

function sameEvidenceRefs(left, right) {
  return validEvidenceRefs(left) && validEvidenceRefs(right) && left.length === right.length &&
    left.every(({ reference_id: referenceId, source_kind: sourceKind }) =>
      right.some((candidate) => candidate.reference_id === referenceId && candidate.source_kind === sourceKind));
}

function validEvidenceRefs(value) {
  return Array.isArray(value) && value.every((entry) => identifier(entry?.reference_id) &&
    ["linear_issue", "linear_comment", "linear_record", "git", "check", "result"].includes(entry.source_kind));
}

function issue(tree, issueId) {
  return exact(tree.issues.filter((candidate) => candidate?.issue_id === issueId));
}

function statusName(value) {
  return typeof value?.status?.name === "string" ? value.status.name : undefined;
}

function one(values) {
  if (values.length === 0) return { kind: "none" };
  if (values.length > 1) return { kind: "ambiguous" };
  return { kind: "one", value: values[0] };
}

function exact(values) {
  return values.length === 1 ? values[0] : undefined;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function timestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function uniqueIdentifiers(value) {
  return Array.isArray(value) && value.every(identifier) && new Set(value).size === value.length;
}

function outcome(kind, reasonCode) {
  return Object.freeze({ kind, reason_code: reasonCode });
}
