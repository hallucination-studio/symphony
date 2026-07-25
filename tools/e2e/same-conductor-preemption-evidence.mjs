const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STAGES = new Set(["plan", "work", "verify"]);
const SUCCESSFUL_OUTCOMES = new Set(["plan_completed", "work_completed", "verify_passed"]);

export function assessSameConductorPreemptionEvidence(row) {
  try {
    const input = rowInput(row);
    const [inFlightRootIssueId, updatedRootIssueId] = input.caseRoots.root_issue_ids;
    const inFlightTree = exact(input.snapshot.root_trees.filter(({ root_issue_id: rootIssueId }) => rootIssueId === inFlightRootIssueId));
    const updatedTree = exact(input.snapshot.root_trees.filter(({ root_issue_id: rootIssueId }) => rootIssueId === updatedRootIssueId));
    if (!inFlightTree || !updatedTree || input.snapshot.root_trees.length !== 2) {
      return outcome("inconclusive", "same_conductor_preemption_root_missing");
    }

    const inFlight = rootFacts(inFlightTree, inFlightRootIssueId);
    const updated = rootFacts(updatedTree, updatedRootIssueId);
    if (inFlight.invalid || updated.invalid) return outcome("inconclusive", "same_conductor_preemption_evidence_invalid");
    if (inFlight.root.priority !== updated.root.priority) {
      return outcome("violated", "same_conductor_preemption_priority_mismatch");
    }
    if (inFlight.ownership.conductorId !== input.conductorId || updated.ownership.conductorId !== input.conductorId ||
        inFlight.ownership.conductorId !== updated.ownership.conductorId) {
      return outcome("violated", "same_conductor_preemption_ownership_mismatch");
    }

    const update = exact(updated.activity.history.filter(({ updated_description: changed }) => changed));
    if (!update) return outcome("inconclusive", "same_conductor_preemption_human_update_missing");
    if (update.actor_id !== input.humanActorId) {
      return outcome("violated", "same_conductor_preemption_update_not_human");
    }
    if (Date.parse(inFlight.root.updated_at) >= Date.parse(updated.root.updated_at) ||
        Date.parse(updated.root.updated_at) < Date.parse(update.updated_at)) {
      return outcome("violated", "same_conductor_preemption_updated_at_order_invalid");
    }

    const inFlightStages = inFlight.executions.map((execution) => ({
      execution,
      result: exact(inFlight.results.filter(({ executionId }) => executionId === execution.stageExecutionId)),
    })).filter(({ execution, result }) => result !== null &&
      Date.parse(execution.startedAt) < Date.parse(update.updated_at) &&
      Date.parse(update.updated_at) < Date.parse(result.completedAt),
    );
    const inFlightStage = exact(inFlightStages);
    if (!inFlightStage) return outcome("inconclusive", "same_conductor_preemption_inflight_stage_missing");
    const { execution: inFlightExecution, result: inFlightResult } = inFlightStage;
    if (!SUCCESSFUL_OUTCOMES.has(inFlightResult.outcomeKind) ||
        inFlightResult.stage !== inFlightExecution.stage || inFlightResult.nodeIssueId !== inFlightExecution.nodeIssueId ||
        Date.parse(inFlightExecution.startedAt) >= Date.parse(update.updated_at) ||
        Date.parse(update.updated_at) >= Date.parse(inFlightResult.completedAt)) {
      return outcome("violated", "same_conductor_preemption_inflight_turn_invalid");
    }

    const candidate = firstExecutionAfter(updated.executions, update.updated_at);
    if (candidate.kind === "missing") return outcome("inconclusive", "same_conductor_preemption_candidate_stage_missing");
    if (candidate.kind === "ambiguous") return outcome("inconclusive", "same_conductor_preemption_candidate_stage_ambiguous");
    const { execution: candidateExecution } = candidate;
    if (Date.parse(candidateExecution.startedAt) <= Date.parse(inFlightResult.completedAt)) {
      return outcome("violated", "same_conductor_preemption_boundary_invalid");
    }
    const laterInFlightExecution = inFlight.executions.some(({ stageExecutionId, startedAt }) =>
      stageExecutionId !== inFlightExecution.stageExecutionId &&
      Date.parse(startedAt) > Date.parse(inFlightResult.completedAt) &&
      Date.parse(startedAt) < Date.parse(candidateExecution.startedAt),
    );
    if (laterInFlightExecution) return outcome("violated", "same_conductor_preemption_next_admission_invalid");

    return outcome("satisfied", "same_conductor_preemption_confirmed");
  } catch {
    return outcome("inconclusive", "same_conductor_preemption_evidence_invalid");
  }
}

export function analyzeSameConductorPreemptionCampaignEvidence({ rows } = {}) {
  if (!Array.isArray(rows)) return Object.freeze({ case_outcomes: Object.freeze([]) });
  return Object.freeze({
    case_outcomes: Object.freeze(rows
      .filter((row) => row?.e2eCase?.evidence_predicate_id === "same_conductor_preemption")
      .map((row) => Object.freeze({ case_id: row.e2eCase.case_id, outcome: assessSameConductorPreemptionEvidence(row) }))),
  });
}

function rowInput(value) {
  const row = object(value);
  const e2eCase = object(row.e2eCase);
  const caseRoots = object(row.caseRoots);
  const context = object(row.caseContext);
  const conductors = array(context.conductors);
  const snapshot = object(row.snapshot);
  if (!identifier(e2eCase.case_id) || e2eCase.evidence_predicate_id !== "same_conductor_preemption" ||
      !Array.isArray(caseRoots.root_issue_ids) || caseRoots.root_issue_ids.length !== 2 ||
      !uniqueIdentifiers(caseRoots.root_issue_ids) || !identifier(context.human_actor_id) || conductors.length !== 1 ||
      snapshot.kind !== "complete" || !Array.isArray(snapshot.root_trees)) {
    throw new Error("invalid row");
  }
  const conductor = object(conductors[0]);
  if (!identifier(conductor.conductor_id)) throw new Error("invalid conductor");
  return { caseRoots, conductorId: conductor.conductor_id, humanActorId: context.human_actor_id, snapshot };
}

function rootFacts(tree, rootIssueId) {
  if (!object(tree) || tree.root_issue_id !== rootIssueId || !Array.isArray(tree.issues) || !Array.isArray(tree.activity) ||
      !Array.isArray(tree.comments) || !Array.isArray(tree.managed_blocks)) {
    return { invalid: true };
  }
  const root = exact(tree.issues.filter((entry) => entry?.issue_id === rootIssueId && entry?.parent_issue_id === null));
  const activity = exact(tree.activity.filter((entry) => entry?.issue_id === rootIssueId));
  if (!validRoot(root) || !validActivity(activity)) return { invalid: true };
  const comments = new Map(tree.comments.map((comment) => [comment?.comment_id, comment]));
  const ownership = [];
  const executions = [];
  const results = [];
  let invalid = false;
  for (const block of tree.managed_blocks) {
    const source = comments.get(block?.source_id);
    if (block?.source_kind !== "comment" || !source || source.issue_id !== block.issue_id || !identifier(block.issue_id) || !object(block.record)) {
      invalid = true;
      continue;
    }
    const record = block.record;
    if (record.kind === "root_ownership") {
      const parsed = ownershipRecord(record, block.issue_id);
      if (parsed === null) invalid = true;
      else ownership.push(parsed);
    } else if (record.kind === "stage_execution") {
      const parsed = executionRecord(record, block.issue_id);
      if (parsed === null) invalid = true;
      else executions.push(parsed);
    } else if (record.kind === "stage_result") {
      const parsed = resultRecord(record, block.issue_id);
      if (parsed === null) invalid = true;
      else results.push(parsed);
    }
  }
  const rootOwnership = exact(ownership.filter(({ rootIssueId: candidate }) => candidate === rootIssueId));
  if (!rootOwnership || ownership.length !== 1 || executions.some(({ rootIssueId: candidate }) => candidate !== rootIssueId) ||
      results.some(({ rootIssueId: candidate }) => candidate !== rootIssueId)) {
    invalid = true;
  }
  const issueIds = new Set(tree.issues.map(({ issue_id: issueId }) => issueId));
  if (executions.some(({ nodeIssueId, sourceIssueId }) => nodeIssueId !== sourceIssueId || !issueIds.has(nodeIssueId)) ||
      results.some(({ nodeIssueId, sourceIssueId }) => nodeIssueId !== sourceIssueId || !issueIds.has(nodeIssueId))) {
    invalid = true;
  }
  return { invalid, root, activity, ownership: rootOwnership, executions, results };
}

function ownershipRecord(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "root_issue_id", "conductor_id", "performer_profile_id", "delivery_branch", "owner_generation"]);
  if (!version(record) || !identifier(record.root_issue_id) || !identifier(record.conductor_id) || !identifier(record.performer_profile_id) ||
      !text(record.delivery_branch) || !identifier(record.owner_generation) || record.root_issue_id !== sourceIssueId) return null;
  return { rootIssueId: record.root_issue_id, conductorId: record.conductor_id };
}

function executionRecord(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "stage_execution_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "stage", "context_digest", "source_manifest", "coverage", "instruction_set_id", "execution_policy_id", "limits", "repository_revision", "started_at", "deadline_at"], ["plan_contract_digest"]);
  if (!version(record) || !identifier(record.stage_execution_id) || !identifier(record.root_issue_id) || !identifier(record.cycle_issue_id) ||
      !identifier(record.node_issue_id) || !STAGES.has(record.stage) || !identifier(record.context_digest) || !Array.isArray(record.source_manifest) ||
      !validCoverage(record.coverage) || !identifier(record.instruction_set_id) || !identifier(record.execution_policy_id) || !validLimits(record.limits) ||
      !identifier(record.repository_revision) || !timestamp(record.started_at) || !timestamp(record.deadline_at) ||
      (record.stage === "plan" ? record.plan_contract_digest !== undefined : !identifier(record.plan_contract_digest))) return null;
  return {
    stageExecutionId: record.stage_execution_id,
    rootIssueId: record.root_issue_id,
    nodeIssueId: record.node_issue_id,
    stage: record.stage,
    startedAt: record.started_at,
    sourceIssueId,
  };
}

function resultRecord(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "result_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "stage", "role_session_id", "role_turn_id", "observed_tree_digest", "context_digest", "outcome_kind", "summary", "source_manifest", "completed_at", "model_turn"], ["plan_contract_digest", "plan_contract", "proposed_work_dag", "risks", "required_permissions", "evidence_refs", "changed_paths", "commit_revision", "verify_conclusion", "verified_revision", "failure_code"]);
  if (!version(record) || !identifier(record.result_id) || !identifier(record.root_issue_id) || !identifier(record.cycle_issue_id) ||
      !identifier(record.node_issue_id) || !STAGES.has(record.stage) || !identifier(record.role_session_id) || !identifier(record.role_turn_id) ||
      !identifier(record.observed_tree_digest) || !identifier(record.context_digest) || !identifier(record.outcome_kind) || !text(record.summary) ||
      !Array.isArray(record.source_manifest) || !timestamp(record.completed_at) || !validModelTurn(record.model_turn, record)) return null;
  return {
    resultId: record.result_id,
    rootIssueId: record.root_issue_id,
    nodeIssueId: record.node_issue_id,
    stage: record.stage,
    outcomeKind: record.outcome_kind,
    executionId: record.model_turn.stage_execution_id,
    completedAt: record.completed_at,
    sourceIssueId,
  };
}

function validRoot(value) {
  return object(value) && identifier(value.issue_id) && value.parent_issue_id === null && Number.isInteger(value.priority) &&
    value.priority >= 0 && value.priority <= 4 && timestamp(value.updated_at);
}

function validActivity(value) {
  return object(value) && Array.isArray(value.history) && Array.isArray(value.state_history) && value.history.every((entry) =>
    object(entry) && identifier(entry.activity_id) && (entry.actor_id === null || identifier(entry.actor_id)) &&
    timestamp(entry.created_at) && timestamp(entry.updated_at) && typeof entry.updated_description === "boolean" &&
    typeof entry.is_archived === "boolean",
  );
}

function validModelTurn(value, result) {
  if (!object(value)) return false;
  exactKeys(value, ["turn_record_id", "role", "root_issue_id", "cycle_issue_id", "target_issue_id", "stage_execution_id", "role_session_id", "role_turn_id", "invocation_state", "model", "outcome", "usage", "terminal_at"]);
  return identifier(value.turn_record_id) && value.role === result.stage && value.root_issue_id === result.root_issue_id &&
    value.cycle_issue_id === result.cycle_issue_id && value.target_issue_id === result.node_issue_id && identifier(value.stage_execution_id) &&
    value.role_session_id === result.role_session_id && value.role_turn_id === result.role_turn_id && value.invocation_state === "confirmed" &&
    text(value.model) && value.outcome === result.outcome_kind && validUsage(value.usage) && value.terminal_at === result.completed_at;
}

function validUsage(value) {
  if (!object(value) || value.status !== "measured") return false;
  exactKeys(value, ["status", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]);
  return [value.input_tokens, value.cached_input_tokens, value.output_tokens, value.reasoning_output_tokens, value.total_tokens]
    .every((entry) => Number.isInteger(entry) && entry >= 0);
}

function validCoverage(value) {
  return object(value) && value.is_complete === true && Array.isArray(value.omissions);
}

function validLimits(value) {
  if (!object(value)) return false;
  exactKeys(value, ["max_context_bytes", "max_result_bytes", "max_wall_time_ms", "max_tool_calls", "max_command_duration_ms", "reserved_total_tokens", "max_output_tokens"]);
  return Object.values(value).every((entry) => Number.isInteger(entry) && entry >= 0);
}

function exact(values) {
  return values.length === 1 ? values[0] : null;
}

function firstExecutionAfter(executions, timestamp) {
  const candidateExecutions = executions.filter(({ startedAt }) => Date.parse(startedAt) > Date.parse(timestamp));
  if (candidateExecutions.length === 0) return { kind: "missing" };
  const earliestStartedAt = Math.min(...candidateExecutions.map(({ startedAt }) => Date.parse(startedAt)));
  const earliest = candidateExecutions.filter(({ startedAt }) => Date.parse(startedAt) === earliestStartedAt);
  return earliest.length === 1 ? { kind: "selected", execution: earliest[0] } : { kind: "ambiguous" };
}

function uniqueIdentifiers(values) {
  return values.every(identifier) && new Set(values).size === values.length;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768;
}

function timestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function version(value) {
  return value.version === 1;
}

function exactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) ||
      keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("record keys invalid");
  }
}

function outcome(kind, reason_code) {
  return Object.freeze({ kind, reason_code });
}
