const observedAt = "2026-07-25T00:05:00.000Z";

export function happyPathRow({ caseId, conductorId, repositoryIdentity, startOffset = 0 }) {
  const rootIssueId = `root-${caseId}`;
  const cycleIssueId = `cycle-${caseId}`;
  const planIssueId = `plan-${caseId}`;
  const workIssueId = `work-${caseId}`;
  const verifyIssueId = `verify-${caseId}`;
  const actionIssueId = `action-${caseId}`;
  const actionId = `request-${caseId}`;
  const digest = `digest-${caseId}`;
  const revision = caseId.endsWith("a") ? "a".repeat(40) : "b".repeat(40);
  const at = (offset) => new Date(Date.parse("2026-07-25T00:00:00.000Z") + startOffset + offset).toISOString();
  const records = [
    block(rootIssueId, ownership(rootIssueId, conductorId)),
    block(planIssueId, planContract(rootIssueId, cycleIssueId, digest)),
    block(planIssueId, execution({ id: `plan-execution-${caseId}`, rootIssueId, cycleIssueId, nodeIssueId: planIssueId, stage: "plan", startedAt: at(0) })),
    block(planIssueId, result({ id: `plan-result-${caseId}`, executionId: `plan-execution-${caseId}`, rootIssueId, cycleIssueId, nodeIssueId: planIssueId, stage: "plan", outcome: "plan_completed", completedAt: at(2_000), digest })),
    block(actionIssueId, actionRequest({ actionId, actionIssueId, rootIssueId, cycleIssueId, planIssueId, digest, at: at(2_100) })),
    block(actionIssueId, actionResolution({ actionId, actionIssueId, digest, at: at(2_200) })),
    block(workIssueId, execution({ id: `work-execution-${caseId}`, rootIssueId, cycleIssueId, nodeIssueId: workIssueId, stage: "work", digest, startedAt: at(2_500) })),
    block(workIssueId, result({ id: `work-result-${caseId}`, executionId: `work-execution-${caseId}`, rootIssueId, cycleIssueId, nodeIssueId: workIssueId, stage: "work", outcome: "work_completed", completedAt: at(4_000), digest, revision })),
    block(verifyIssueId, execution({ id: `verify-execution-${caseId}`, rootIssueId, cycleIssueId, nodeIssueId: verifyIssueId, stage: "verify", digest, startedAt: at(4_100) })),
    block(verifyIssueId, result({ id: `verify-result-${caseId}`, executionId: `verify-execution-${caseId}`, rootIssueId, cycleIssueId, nodeIssueId: verifyIssueId, stage: "verify", outcome: "verify_passed", completedAt: at(6_000), digest, revision })),
    block(verifyIssueId, verifyResult({ executionId: `verify-execution-${caseId}`, rootIssueId, cycleIssueId, nodeIssueId: verifyIssueId, revision })),
    block(rootIssueId, delivery({ rootIssueId, cycleIssueId, verifyResultId: `verify-execution-${caseId}`, revision, branch: `symphony/${caseId}`, at: at(6_100) })),
  ];
  return {
    e2eCase: { case_id: caseId, evidence_predicate_id: "happy_path" },
    root: { root_issue_id: rootIssueId },
    caseContext: { conductors: [{ conductor_id: conductorId, repository_identity: repositoryIdentity }] },
    snapshot: {
      kind: "complete", observed_at: observedAt,
      root_trees: [{
        root_issue_id: rootIssueId,
        issues: [
          issue(rootIssueId, null, "In Review"), issue(cycleIssueId, rootIssueId, "Succeeded"),
          issue(planIssueId, cycleIssueId, "Done"), issue(workIssueId, cycleIssueId, "Done"),
          issue(verifyIssueId, cycleIssueId, "Done"), issue(actionIssueId, cycleIssueId, "Approved"),
        ],
        comments: records.map(({ source_id, issue_id }) => ({ comment_id: source_id, issue_id })),
        relations: [{ relation_kind: "relates_to", issue_id: actionIssueId, related_issue_id: planIssueId }],
        managed_blocks: records,
      }],
      repositories: [{
        repository_identity: repositoryIdentity, branch: `symphony/${caseId}`, head_commit: revision,
        diff_check: "passed", worktree: { is_clean: true },
        delivery: { branch: `symphony/${caseId}`, remote_head: revision, is_delivered: true },
      }],
    },
  };
}

function block(issueId, record) {
  return {
    source_kind: "comment",
    source_id: `comment-${record.kind}-${record.kind === "stage_execution" ? record.stage_execution_id : record.kind === "stage_result" ? record.result_id : record.kind}-${issueId}`,
    source_version: observedAt, actor: { actor_id: "symphony-actor", actor_kind: "user" }, issue_id: issueId, record,
  };
}

function issue(issueId, parentIssueId, statusName) {
  return { issue_id: issueId, parent_issue_id: parentIssueId, remote_version: observedAt, status: { name: statusName } };
}

function ownership(rootIssueId, conductorId) {
  return { kind: "root_ownership", version: 1, root_issue_id: rootIssueId, conductor_id: conductorId, performer_profile_id: "profile-1", delivery_branch: "symphony/test", owner_generation: "generation-1" };
}

function planContract(rootIssueId, cycleIssueId, digest) {
  return {
    kind: "plan_contract", version: 1, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, plan_contract_digest: digest,
    objective: "Complete the requested work.", included_scope: [], excluded_scope: [], assumptions: [], constraints: [], acceptance_criteria: [], verification_requirements: [],
    proposed_work_dag: { work_nodes: [], dependency_edges: [], verify_node: { title: "Verify", acceptance_criteria: [], required_checks: [] } },
  };
}

function execution({ id, rootIssueId, cycleIssueId, nodeIssueId, stage, digest, startedAt }) {
  return {
    kind: "stage_execution", version: 1, stage_execution_id: id, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, node_issue_id: nodeIssueId, stage,
    ...(digest === undefined ? {} : { plan_contract_digest: digest }), context_digest: "context-1", source_manifest: [], coverage: { is_complete: true, omissions: [] },
    instruction_set_id: "instruction-1", execution_policy_id: "policy-1",
    limits: { max_context_bytes: 1, max_result_bytes: 1, max_wall_time_ms: 1, max_tool_calls: 0, max_command_duration_ms: 1, reserved_total_tokens: 0, max_output_tokens: 1 },
    repository_revision: "baseline-1", started_at: startedAt, deadline_at: "2026-07-25T00:10:00.000Z",
  };
}

function result({ id, executionId, rootIssueId, cycleIssueId, nodeIssueId, stage, outcome, completedAt, digest, revision }) {
  return {
    kind: "stage_result", version: 1, result_id: id, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, node_issue_id: nodeIssueId, stage,
    role_session_id: `${stage}-session-1`, role_turn_id: `${stage}-turn-1`, observed_tree_digest: "tree-1", context_digest: "context-1", outcome_kind: outcome,
    summary: "Completed.", source_manifest: [], completed_at: completedAt,
    model_turn: {
      turn_record_id: `${executionId}:${stage}-turn-1`, role: stage, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, target_issue_id: nodeIssueId,
      stage_execution_id: executionId, role_session_id: `${stage}-session-1`, role_turn_id: `${stage}-turn-1`, invocation_state: "confirmed", model: "gpt-5-codex", outcome,
      usage: { status: "measured", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 }, terminal_at: completedAt,
    },
    ...(digest === undefined ? {} : { plan_contract_digest: digest }),
    ...(stage === "plan" ? { plan_contract: { objective: "Complete the requested work.", included_scope: [], excluded_scope: [], assumptions: [], constraints: [], acceptance_criteria: [], verification_requirements: [] }, proposed_work_dag: { work_nodes: [], dependency_edges: [], verify_node: { title: "Verify", acceptance_criteria: [], required_checks: [] } }, risks: [], required_permissions: [], evidence_refs: [] } : {}),
    ...(stage === "work" ? { changed_paths: ["README.md"], commit_revision: revision } : {}),
    ...(stage === "verify" ? { verify_conclusion: "passed", verified_revision: revision } : {}),
  };
}

function actionRequest({ actionId, actionIssueId, rootIssueId, cycleIssueId, planIssueId, digest, at }) {
  return { kind: "human_action_request", version: 1, action_id: actionId, action_issue_id: actionIssueId, action_kind: "plan_review", parent_scope: "cycle", root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, related_issue_ids: [planIssueId], proposal_digest: digest, expected_parent_remote_version: observedAt, created_at: at };
}

function actionResolution({ actionId, actionIssueId, digest, at }) {
  return { kind: "human_action_resolution", version: 1, resolution_id: `resolution-${actionId}`, action_id: actionId, action_issue_id: actionIssueId, action_kind: "plan_review", outcome: "approved", terminal_status: "Approved", terminal_remote_version: observedAt, source_comment_ids: [], source_comment_versions: [], actor_kind: "human", proposal_digest: digest, resolved_at: at };
}

function verifyResult({ executionId, rootIssueId, cycleIssueId, nodeIssueId, revision }) {
  return { kind: "verify_result", version: 1, stage_execution_id: executionId, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, node_issue_id: nodeIssueId, conclusion: "passed", criteria_results: [], checks: [], verified_revision: revision };
}

function delivery({ rootIssueId, cycleIssueId, verifyResultId, revision, branch, at }) {
  return { kind: "delivery", version: 1, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, verify_result_id: verifyResultId, verified_revision: revision, delivery_kind: "remote_branch", delivery_branch: branch, delivered_at: at };
}
