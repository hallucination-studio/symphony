import { happyPathRow } from "./approved-happy-path-fixture.mjs";

const observedAt = "2026-07-25T00:05:00.000Z";

export function cycleSuccessorRow() {
  const row = happyPathRow({
    caseId: "cycle-exhaustion",
    conductorId: "conductor-a",
    repositoryIdentity: "repository-a",
  });
  const tree = row.snapshot.root_trees[0];
  const rootIssueId = row.caseRoots.root_issue_ids[0];
  const predecessorCycleIssueId = "cycle-cycle-exhaustion";
  const predecessorPlanIssueId = "plan-cycle-exhaustion";
  const predecessorWorkIssueId = "work-cycle-exhaustion";
  const predecessorVerifyIssueId = "verify-cycle-exhaustion";
  const predecessorPlanExecution = record(tree, "stage_execution", predecessorPlanIssueId);
  const predecessorPlanResult = record(tree, "stage_result", predecessorPlanIssueId);
  const predecessorPlanContract = record(tree, "plan_contract", predecessorPlanIssueId);
  const predecessorVerifyExecution = record(tree, "stage_execution", predecessorVerifyIssueId);
  const predecessorVerifyResult = record(tree, "stage_result", predecessorVerifyIssueId);
  const predecessorVerify = record(tree, "verify_result", predecessorVerifyIssueId);

  row.e2eCase.evidence_predicate_id = "cycle_successor";
  tree.issues.find(({ issue_id: issueId }) => issueId === rootIssueId).status.name = "In Progress";
  tree.issues.find(({ issue_id: issueId }) => issueId === predecessorCycleIssueId).status.name = "Changes Required";
  tree.issues.find(({ issue_id: issueId }) => issueId === predecessorPlanIssueId).status.name = "Done";
  tree.issues.find(({ issue_id: issueId }) => issueId === predecessorWorkIssueId).status.name = "Done";
  tree.issues.find(({ issue_id: issueId }) => issueId === predecessorVerifyIssueId).status.name = "Done";
  predecessorVerifyResult.outcome_kind = "verify_changes_required";
  predecessorVerifyResult.model_turn.outcome = "verify_changes_required";
  predecessorVerifyResult.verify_conclusion = "changes_required";
  predecessorVerify.conclusion = "changes_required";

  const findingId = "finding-cycle-exhaustion";
  const outcomeId = "cycle-outcome-cycle-exhaustion";
  const concludeDirectiveId = "directive-conclude-cycle-exhaustion";
  const createDirectiveId = "directive-create-cycle-successor";
  const successorCycleIssueId = "cycle-cycle-exhaustion-successor";
  const successorPlanIssueId = "plan-cycle-exhaustion-successor";
  const successorPlanExecutionId = "plan-execution-cycle-exhaustion-successor";
  const successorPlanResultId = "plan-result-cycle-exhaustion-successor";
  const successorPlanDigest = "digest-cycle-exhaustion-successor";

  appendCommentRecord(tree, rootIssueId, {
    kind: "root_convergence_policy",
    version: 1,
    policy_id: "root-convergence-policy-cycle-exhaustion",
    root_issue_id: rootIssueId,
    max_cycles_per_root: 3,
    max_same_open_finding_cycles: 2,
    max_consecutive_no_progress: 2,
    max_total_tokens: 10000,
    max_cycle_repair_attempts: 0,
    deadline_at: "2027-07-24T00:00:00.000Z",
  });
  appendCommentRecord(tree, rootIssueId, rootDirective({
    directiveId: concludeDirectiveId,
    rootIssueId,
    terminalAt: "2026-07-25T00:00:06.200Z",
    action: {
      kind: "conclude_cycle",
      cycle_issue_id: predecessorCycleIssueId,
      conclusion: "exhausted",
      completed_work_ids: [predecessorWorkIssueId],
      unresolved_finding_ids: [findingId],
      attempted_approach_refs: [{ reference_id: "work-result-cycle-exhaustion", source_kind: "result" }],
      verification_evidence_refs: [{ reference_id: "verify-result-cycle-exhaustion", source_kind: "result" }],
    },
  }));
  appendCommentRecord(tree, predecessorVerifyIssueId, {
    kind: "finding",
    version: 1,
    finding_id: findingId,
    source_verify_id: predecessorVerifyExecution.stage_execution_id,
    category: "test",
    severity: "medium",
    evidence: [],
    affected_scope: [],
    retryable: true,
    suggested_remediation: ["Start a fresh Cycle."],
    acceptance_criteria: [],
  });
  appendCommentRecord(tree, predecessorVerifyIssueId, {
    kind: "finding_disposition",
    version: 1,
    finding_id: findingId,
    source_verify_id: predecessorVerifyExecution.stage_execution_id,
    disposition: "still_open",
    evidence: [],
  });
  appendCommentRecord(tree, predecessorCycleIssueId, {
    kind: "cycle_outcome",
    version: 1,
    cycle_outcome_id: outcomeId,
    root_issue_id: rootIssueId,
    cycle_issue_id: predecessorCycleIssueId,
    source_root_directive_id: concludeDirectiveId,
    conclusion: "exhausted",
    plan_contract_digest: predecessorPlanContract.plan_contract_digest,
    completed_work_ids: [predecessorWorkIssueId],
    unresolved_finding_ids: [findingId],
    attempted_approach_refs: [{ reference_id: "work-result-cycle-exhaustion", source_kind: "result" }],
    verification_evidence_refs: [{ reference_id: "verify-result-cycle-exhaustion", source_kind: "result" }],
    git_revision: "a".repeat(40),
    budget_usage: budgetUsage(predecessorCycleIssueId),
    successor_reason: "exhausted",
    concluded_at: "2026-07-25T00:00:06.200Z",
  });
  appendCommentRecord(tree, rootIssueId, {
    kind: "convergence",
    version: 1,
    convergence_record_id: "convergence-cycle-exhaustion",
    root_issue_id: rootIssueId,
    policy_id: "root-convergence-policy-cycle-exhaustion",
    policy: {
      max_cycles_per_root: 3,
      max_same_open_finding_cycles: 2,
      max_consecutive_no_progress: 2,
      max_total_tokens: 10000,
      max_cycle_repair_attempts: 0,
      deadline_at: "2027-07-24T00:00:00.000Z",
    },
    view: {
      cycle_count: 1,
      open_finding_persistence: [{ finding_id: findingId, open_cycle_count: 1 }],
      consecutive_no_progress: 0,
      settled_tokens: 12,
      open_token_reservations: [],
      active_cycle_issue_id: predecessorCycleIssueId,
      active_cycle_repair_attempts: 1,
      is_deadline_exceeded: false,
      root_is_canceled: false,
    },
    trigger: "max_cycle_repair_attempts",
  });
  appendCommentRecord(tree, rootIssueId, rootDirective({
    directiveId: createDirectiveId,
    rootIssueId,
    terminalAt: "2026-07-25T00:00:06.300Z",
    action: {
      kind: "create_cycle",
      predecessor_cycle_issue_id: predecessorCycleIssueId,
      reason: "exhausted",
      plan_trigger: "Create a fresh Plan from the predecessor evidence.",
      inherited_fact_refs: [{ reference_id: outcomeId, source_kind: "linear_record" }],
      invalidated_delivery_refs: [],
    },
  }));

  tree.issues.push(
    issue(successorCycleIssueId, rootIssueId, "Planning"),
    issue(successorPlanIssueId, successorCycleIssueId, "In Review"),
  );
  tree.relations.push({
    relation_kind: "relates_to",
    issue_id: predecessorCycleIssueId,
    related_issue_id: successorCycleIssueId,
  });
  appendIssueRecord(tree, successorCycleIssueId, {
    kind: "workflow_issue",
    version: 1,
    issue_key: `${createDirectiveId}:cycle`,
    root_issue_id: rootIssueId,
    parent_issue_id: rootIssueId,
    issue_kind: "cycle",
  });
  appendIssueRecord(tree, successorPlanIssueId, {
    kind: "workflow_issue",
    version: 1,
    issue_key: `${createDirectiveId}:plan`,
    root_issue_id: rootIssueId,
    parent_issue_id: successorCycleIssueId,
    issue_kind: "plan",
  });
  const successorExecution = structuredClone(predecessorPlanExecution);
  successorExecution.stage_execution_id = successorPlanExecutionId;
  successorExecution.cycle_issue_id = successorCycleIssueId;
  successorExecution.node_issue_id = successorPlanIssueId;
  successorExecution.started_at = "2026-07-25T00:00:06.400Z";
  appendCommentRecord(tree, successorPlanIssueId, successorExecution);
  const successorContract = structuredClone(predecessorPlanContract);
  successorContract.cycle_issue_id = successorCycleIssueId;
  successorContract.plan_contract_digest = successorPlanDigest;
  appendCommentRecord(tree, successorPlanIssueId, successorContract);
  const successorResult = structuredClone(predecessorPlanResult);
  successorResult.result_id = successorPlanResultId;
  successorResult.cycle_issue_id = successorCycleIssueId;
  successorResult.node_issue_id = successorPlanIssueId;
  successorResult.role_session_id = "plan-session-cycle-exhaustion-successor";
  successorResult.role_turn_id = "plan-turn-cycle-exhaustion-successor";
  successorResult.plan_contract_digest = successorPlanDigest;
  successorResult.completed_at = "2026-07-25T00:00:06.800Z";
  successorResult.model_turn.turn_record_id = `${successorPlanExecutionId}:plan-turn-cycle-exhaustion-successor`;
  successorResult.model_turn.cycle_issue_id = successorCycleIssueId;
  successorResult.model_turn.target_issue_id = successorPlanIssueId;
  successorResult.model_turn.stage_execution_id = successorPlanExecutionId;
  successorResult.model_turn.role_session_id = successorResult.role_session_id;
  successorResult.model_turn.role_turn_id = successorResult.role_turn_id;
  successorResult.model_turn.terminal_at = successorResult.completed_at;
  appendCommentRecord(tree, successorPlanIssueId, successorResult);

  return row;
}

function record(tree, kind, issueId) {
  const value = tree.managed_blocks.find((block) => block.issue_id === issueId && block.record.kind === kind)?.record;
  if (!value) throw new Error(`fixture record missing: ${kind}:${issueId}`);
  return value;
}

function rootDirective({ directiveId, rootIssueId, terminalAt, action }) {
  return {
    kind: "root_directive",
    version: 1,
    root_directive_id: directiveId,
    root_issue_id: rootIssueId,
    reconciler_session_id: "reconciler-session-cycle-exhaustion",
    reconciler_turn_id: `${directiveId}:turn`,
    based_on_target_root_digest: `${directiveId}:tree`,
    consumed_input_ids: [],
    accepted_at: terminalAt,
    directive: {
      protocol_version: "1",
      request_id: `${directiveId}:request`,
      root_directive_id: directiveId,
      reconciler_session_id: "reconciler-session-cycle-exhaustion",
      reconciler_turn_id: `${directiveId}:turn`,
      model_turn: {
        turn_record_id: `${directiveId}:model-turn`,
        role: "root_reconciler",
        root_issue_id: rootIssueId,
        reconciler_session_id: "reconciler-session-cycle-exhaustion",
        reconciler_turn_id: `${directiveId}:turn`,
        invocation_state: "confirmed",
        model: "gpt-5-codex",
        outcome: "directive_accepted",
        usage: { status: "measured", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
        terminal_at: terminalAt,
      },
      based_on_target_root_digest: `${directiveId}:tree`,
      rationale: "Continue from the durable exhausted Cycle evidence.",
      evidence_refs: [],
      consumed_input_ids: [],
      comment_replies: [],
      human_action_resolutions: [],
      action,
    },
  };
}

function budgetUsage(cycleIssueId) {
  return {
    scope: "cycle",
    source_record_count: 3,
    source_digest: "cycle-budget-cycle-exhaustion",
    is_complete: true,
    unknown_turn_count: 0,
    groups: [{
      cycle_issue_id: cycleIssueId,
      role: "verify",
      model: "gpt-5-codex",
      input_tokens: 3,
      cached_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 6,
      unavailable_turn_count: 0,
    }],
  };
}

function issue(issueId, parentIssueId, statusName) {
  return {
    issue_id: issueId,
    parent_issue_id: parentIssueId,
    remote_version: observedAt,
    status: { name: statusName },
    is_archived: false,
    archived_at: null,
  };
}

function appendCommentRecord(tree, issueId, record) {
  const sourceId = `comment-${record.kind}-${tree.managed_blocks.length}`;
  tree.managed_blocks.push({
    source_kind: "comment",
    source_id: sourceId,
    source_version: observedAt,
    actor: { actor_id: "symphony-actor", actor_kind: "user" },
    issue_id: issueId,
    record,
  });
  tree.comments.push({ comment_id: sourceId, issue_id: issueId, remote_version: observedAt });
}

function appendIssueRecord(tree, issueId, record) {
  tree.managed_blocks.push({
    source_kind: "issue_description",
    source_id: issueId,
    source_version: observedAt,
    actor: { actor_id: "symphony-actor", actor_kind: "user" },
    issue_id: undefined,
    record,
  });
}
