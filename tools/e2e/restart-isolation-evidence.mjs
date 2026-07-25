const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STAGES = new Set(["plan", "work", "verify"]);
const FAILURE_OUTCOMES = new Set(["canceled", "execution_failed"]);
const SUCCESSFUL_OUTCOMES = new Set(["plan_completed", "work_completed", "verify_passed"]);
const TERMINAL_OUTCOMES = new Set([
  "plan_completed", "plan_needs_information", "plan_blocked",
  "work_completed", "work_blocked", "work_plan_assumption_invalid", "work_scope_conflict",
  "work_permission_required", "work_information_required",
  "verify_passed", "verify_changes_required", "verify_inconclusive", "verify_plan_contract_violation", "verify_blocked",
  "budget_exhausted", "canceled", "execution_failed",
]);
const RECOVERED_OUTCOMES = new Set([...TERMINAL_OUTCOMES].filter((kind) => !FAILURE_OUTCOMES.has(kind)));

export function assessRestartIsolationEvidence(row) {
  try {
    const input = rowInput(row);
    const [cRootIssueId, aRootIssueId, bRootIssueId] = input.caseRoots.root_issue_ids;
    const [cConductor, aConductor, bConductor] = input.conductors;
    const cTree = exact(input.snapshot.root_trees.filter(({ root_issue_id: rootIssueId }) => rootIssueId === cRootIssueId));
    const aTree = exact(input.snapshot.root_trees.filter(({ root_issue_id: rootIssueId }) => rootIssueId === aRootIssueId));
    const bTree = exact(input.snapshot.root_trees.filter(({ root_issue_id: rootIssueId }) => rootIssueId === bRootIssueId));
    if (!cTree || !aTree || !bTree || input.snapshot.root_trees.length !== 3) {
      return outcome("inconclusive", "restart_isolation_root_missing");
    }

    const c = rootFacts(cTree, cRootIssueId);
    const a = rootFacts(aTree, aRootIssueId);
    const b = rootFacts(bTree, bRootIssueId);
    if (c.invalid || a.invalid || b.invalid) return outcome("inconclusive", "restart_isolation_evidence_invalid");

    const cOwnership = ownershipFor(c, cConductor.conductor_id);
    if (cOwnership.kind !== "ok") return outcome(cOwnership.kind, cOwnership.reasonCode);

    const oldTerminal = selectOldTerminal(c);
    if (oldTerminal.kind !== "ok") return outcome(oldTerminal.kind, oldTerminal.reasonCode);
    const { execution: oldExecution, result: oldResult } = oldTerminal;

    const replacement = selectReplacement(c, oldExecution, oldResult);
    if (replacement.kind !== "ok") return outcome(replacement.kind, replacement.reasonCode);
    if (replacement.result.roleSessionId === oldResult.roleSessionId) {
      return outcome("violated", "restart_isolation_replacement_session_reused");
    }

    for (const peer of [
      { facts: a, conductorId: aConductor.conductor_id },
      { facts: b, conductorId: bConductor.conductor_id },
    ]) {
      const peerOutcome = assessPeerChain({
        ...peer,
        oldTerminalAt: oldResult.completedAt,
        replacementTerminalAt: replacement.result.completedAt,
      });
      if (peerOutcome !== null) return peerOutcome;
    }

    return outcome("satisfied", "restart_isolation_confirmed");
  } catch {
    return outcome("inconclusive", "restart_isolation_evidence_invalid");
  }
}

export function analyzeRestartIsolationCampaignEvidence({ rows } = {}) {
  if (!Array.isArray(rows)) return Object.freeze({ case_outcomes: Object.freeze([]) });
  return Object.freeze({
    case_outcomes: Object.freeze(rows
      .filter((row) => row?.e2eCase?.evidence_predicate_id === "restart_isolation")
      .map((row) => Object.freeze({
        case_id: row.e2eCase.case_id,
        outcome: assessRestartIsolationEvidence(row),
      }))),
  });
}

function rowInput(value) {
  const row = object(value);
  const e2eCase = object(row.e2eCase);
  const caseRoots = object(row.caseRoots);
  const context = object(row.caseContext);
  const snapshot = object(row.snapshot);
  const conductors = array(context.conductors);
  if (!identifier(e2eCase.case_id) || e2eCase.evidence_predicate_id !== "restart_isolation" ||
      !Array.isArray(caseRoots.root_issue_ids) || caseRoots.root_issue_ids.length !== 3 ||
      !uniqueIdentifiers(caseRoots.root_issue_ids) || conductors.length !== 3 ||
      !conductors.every(validConductor) || new Set(conductors.map(({ conductor_id: conductorId }) => conductorId)).size !== 3 ||
      snapshot.kind !== "complete" || !Array.isArray(snapshot.root_trees)) {
    throw new Error("invalid restart row");
  }
  return { caseRoots, conductors, snapshot };
}

function rootFacts(tree, rootIssueId) {
  if (!object(tree) || tree.root_issue_id !== rootIssueId || !Array.isArray(tree.issues) || !Array.isArray(tree.comments) ||
      !Array.isArray(tree.managed_blocks)) {
    return { invalid: true };
  }
  const root = exact(tree.issues.filter((issue) => issue?.issue_id === rootIssueId && issue?.parent_issue_id === null));
  if (!root) return { invalid: true };
  const issueIds = new Set(tree.issues.map(({ issue_id: issueId }) => issueId));
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
  const rootOwnership = ownership.filter(({ rootIssueId: candidate }) => candidate === rootIssueId);
  const executionIds = new Set();
  for (const execution of executions) {
    if (execution.rootIssueId !== rootIssueId || !issueIds.has(execution.cycleIssueId) || !issueIds.has(execution.nodeIssueId) ||
        execution.sourceIssueId !== execution.nodeIssueId || executionIds.has(execution.stageExecutionId)) invalid = true;
    executionIds.add(execution.stageExecutionId);
  }
  const executionsById = new Map(executions.map((execution) => [execution.stageExecutionId, execution]));
  for (const result of results) {
    const execution = executionsById.get(result.executionId);
    if (result.rootIssueId !== rootIssueId || !issueIds.has(result.cycleIssueId) || !issueIds.has(result.nodeIssueId) ||
        result.sourceIssueId !== result.nodeIssueId || !execution || !sameLineage(execution, result) || execution.contextDigest !== result.contextDigest ||
        Date.parse(execution.startedAt) >= Date.parse(result.completedAt)) invalid = true;
  }
  if (rootOwnership.length !== ownership.length || rootOwnership.length > 1) invalid = true;
  return { invalid, ownership: rootOwnership[0] ?? null, executions, results };
}

function ownershipFor(facts, conductorId) {
  if (facts.ownership === null) return { kind: "inconclusive", reasonCode: "restart_isolation_ownership_missing" };
  if (facts.ownership.conductorId !== conductorId) return { kind: "violated", reasonCode: "restart_isolation_ownership_mismatch" };
  return { kind: "ok" };
}

function selectOldTerminal(c) {
  const failures = c.results.filter(({ outcomeKind }) => FAILURE_OUTCOMES.has(outcomeKind));
  if (failures.length === 0) return { kind: "inconclusive", reasonCode: "restart_isolation_old_terminal_missing" };
  const failureExecutionIds = new Set(failures.map(({ executionId }) => executionId));
  if (failureExecutionIds.size !== 1) return { kind: "inconclusive", reasonCode: "restart_isolation_old_terminal_ambiguous" };
  const execution = exact(c.executions.filter(({ stageExecutionId }) => stageExecutionId === failures[0].executionId));
  if (!execution) return { kind: "inconclusive", reasonCode: "restart_isolation_old_execution_missing" };
  const matchingResults = c.results.filter(({ executionId }) => executionId === execution.stageExecutionId);
  if (matchingResults.length !== 1) {
    return { kind: "violated", reasonCode: "restart_isolation_stale_output_materialized" };
  }
  const [result] = matchingResults;
  if (!FAILURE_OUTCOMES.has(result.outcomeKind)) return { kind: "inconclusive", reasonCode: "restart_isolation_old_terminal_missing" };
  return { kind: "ok", execution, result };
}

function selectReplacement(c, oldExecution, oldResult) {
  const candidates = [];
  for (const execution of c.executions) {
    if (execution.stageExecutionId === oldExecution.stageExecutionId || !sameLineage(oldExecution, execution) ||
        Date.parse(execution.startedAt) <= Date.parse(oldResult.completedAt)) continue;
    const results = c.results.filter(({ executionId }) => executionId === execution.stageExecutionId);
    if (results.length !== 1) continue;
    const result = results[0];
    if (!RECOVERED_OUTCOMES.has(result.outcomeKind)) continue;
    candidates.push({ execution, result });
  }
  if (candidates.length === 0) return { kind: "inconclusive", reasonCode: "restart_isolation_replacement_missing" };
  if (candidates.length !== 1) return { kind: "inconclusive", reasonCode: "restart_isolation_replacement_ambiguous" };
  const replacement = candidates[0];
  if (Date.parse(replacement.result.completedAt) <= Date.parse(oldResult.completedAt)) {
    return { kind: "violated", reasonCode: "restart_isolation_replacement_order_invalid" };
  }
  return { kind: "ok", ...replacement };
}

function assessPeerChain({ facts, conductorId, oldTerminalAt, replacementTerminalAt }) {
  if (facts.ownership === null) return outcome("inconclusive", "restart_isolation_peer_ownership_missing");
  if (facts.ownership.conductorId !== conductorId) return outcome("violated", "restart_isolation_peer_ownership_mismatch");
  if (facts.results.some(({ outcomeKind }) => FAILURE_OUTCOMES.has(outcomeKind))) {
    return outcome("violated", "restart_isolation_peer_terminal_interrupted");
  }
  if (facts.executions.length !== 1 || facts.results.length !== 1) {
    return outcome("violated", "restart_isolation_peer_chain_replaced");
  }
  const [execution] = facts.executions;
  const [result] = facts.results;
  if (execution.stageExecutionId !== result.executionId || !SUCCESSFUL_OUTCOMES.has(result.outcomeKind)) {
    return outcome("violated", "restart_isolation_peer_terminal_invalid");
  }
  if (Date.parse(execution.startedAt) >= Date.parse(oldTerminalAt) ||
      Date.parse(result.completedAt) <= Date.parse(replacementTerminalAt)) {
    return outcome("violated", "restart_isolation_peer_interval_interrupted");
  }
  return null;
}

function ownershipRecord(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "root_issue_id", "conductor_id", "performer_profile_id", "delivery_branch", "owner_generation"]);
  if (!version(record) || !identifier(record.root_issue_id) || !identifier(record.conductor_id) ||
      !identifier(record.performer_profile_id) || !text(record.delivery_branch) || !identifier(record.owner_generation) ||
      record.root_issue_id !== sourceIssueId) return null;
  return { rootIssueId: record.root_issue_id, conductorId: record.conductor_id };
}

function executionRecord(record, sourceIssueId) {
  exactKeys(record, [
    "kind", "version", "stage_execution_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "stage", "context_digest",
    "source_manifest", "coverage", "instruction_set_id", "execution_policy_id", "limits", "repository_revision", "started_at", "deadline_at",
  ], ["plan_contract_digest"]);
  if (!version(record) || !identifier(record.stage_execution_id) || !identifier(record.root_issue_id) || !identifier(record.cycle_issue_id) ||
      !identifier(record.node_issue_id) || !STAGES.has(record.stage) || !identifier(record.context_digest) || !Array.isArray(record.source_manifest) ||
      !validCoverage(record.coverage) || !identifier(record.instruction_set_id) || !identifier(record.execution_policy_id) || !validLimits(record.limits) ||
      !identifier(record.repository_revision) || !timestamp(record.started_at) || !timestamp(record.deadline_at) ||
      Date.parse(record.started_at) >= Date.parse(record.deadline_at) ||
      (record.stage === "plan" ? record.plan_contract_digest !== undefined : !identifier(record.plan_contract_digest))) return null;
  return {
    stageExecutionId: record.stage_execution_id,
    rootIssueId: record.root_issue_id,
    cycleIssueId: record.cycle_issue_id,
    nodeIssueId: record.node_issue_id,
    stage: record.stage,
    contextDigest: record.context_digest,
    startedAt: record.started_at,
    sourceIssueId,
  };
}

function resultRecord(record, sourceIssueId) {
  exactKeys(record, [
    "kind", "version", "result_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "stage", "role_session_id", "role_turn_id",
    "observed_tree_digest", "context_digest", "outcome_kind", "summary", "source_manifest", "completed_at", "model_turn",
  ], [
    "plan_contract_digest", "plan_contract", "proposed_work_dag", "risks", "required_permissions", "evidence_refs", "changed_paths",
    "commit_revision", "verify_conclusion", "verified_revision", "failure_code",
  ]);
  if (!version(record) || !identifier(record.result_id) || !identifier(record.root_issue_id) || !identifier(record.cycle_issue_id) ||
      !identifier(record.node_issue_id) || !STAGES.has(record.stage) || !identifier(record.role_session_id) || !identifier(record.role_turn_id) ||
      !identifier(record.observed_tree_digest) || !identifier(record.context_digest) || !TERMINAL_OUTCOMES.has(record.outcome_kind) ||
      !text(record.summary) || !Array.isArray(record.source_manifest) || !timestamp(record.completed_at) ||
      !validModelTurn(record.model_turn, record) ||
      (record.outcome_kind === "execution_failed" ? !identifier(record.failure_code) : record.failure_code !== undefined)) return null;
  return {
    resultId: record.result_id,
    rootIssueId: record.root_issue_id,
    cycleIssueId: record.cycle_issue_id,
    nodeIssueId: record.node_issue_id,
    stage: record.stage,
    roleSessionId: record.role_session_id,
    outcomeKind: record.outcome_kind,
    executionId: record.model_turn.stage_execution_id,
    contextDigest: record.context_digest,
    completedAt: record.completed_at,
    sourceIssueId,
  };
}

function validModelTurn(value, result) {
  if (!object(value)) return false;
  exactKeys(value, [
    "turn_record_id", "role", "root_issue_id", "cycle_issue_id", "target_issue_id", "stage_execution_id", "role_session_id", "role_turn_id",
    "invocation_state", "model", "outcome", "usage", "terminal_at",
  ]);
  return identifier(value.turn_record_id) && value.role === result.stage && value.root_issue_id === result.root_issue_id &&
    value.cycle_issue_id === result.cycle_issue_id && value.target_issue_id === result.node_issue_id && identifier(value.stage_execution_id) &&
    value.role_session_id === result.role_session_id && value.role_turn_id === result.role_turn_id && value.invocation_state === "confirmed" &&
    text(value.model) && value.outcome === result.outcome_kind && validUsage(value.usage) && value.terminal_at === result.completed_at;
}

function validUsage(value) {
  if (!object(value)) return false;
  if (value.status === "measured") {
    exactKeys(value, ["status", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]);
    return [value.input_tokens, value.cached_input_tokens, value.output_tokens, value.reasoning_output_tokens, value.total_tokens]
      .every((entry) => Number.isInteger(entry) && entry >= 0);
  }
  if (value.status === "unavailable") {
    exactKeys(value, ["status", "reason"]);
    return ["provider_omitted", "transport_lost", "process_lost", "invalid_provider_usage"].includes(value.reason);
  }
  return false;
}

function validCoverage(value) {
  return object(value) && value.is_complete === true && Array.isArray(value.omissions) && value.omissions.length === 0;
}

function validLimits(value) {
  if (!object(value)) return false;
  exactKeys(value, ["max_context_bytes", "max_result_bytes", "max_wall_time_ms", "max_tool_calls", "max_command_duration_ms", "reserved_total_tokens", "max_output_tokens"]);
  return Object.values(value).every((entry) => Number.isInteger(entry) && entry >= 0);
}

function sameLineage(left, right) {
  return left.rootIssueId === right.rootIssueId && left.cycleIssueId === right.cycleIssueId &&
    left.nodeIssueId === right.nodeIssueId && left.stage === right.stage;
}

function validConductor(value) {
  return object(value) && identifier(value.binding_id) && identifier(value.conductor_id) &&
    identifier(value.conductor_short_hash) && identifier(value.repository_identity);
}

function uniqueIdentifiers(values) {
  return values.every(identifier) && new Set(values).size === values.length;
}

function exact(values) {
  return values.length === 1 ? values[0] : null;
}

function exactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("record keys invalid");
  }
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

function outcome(kind, reasonCode) {
  return Object.freeze({ kind, reason_code: reasonCode });
}
