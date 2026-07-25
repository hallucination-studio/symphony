const observedAt = "2026-07-25T00:05:00.000Z";

export function sameConductorPreemptionRow() {
  const inFlightRootIssueId = "root-inflight";
  const updatedRootIssueId = "root-updated";
  const conductorId = "conductor-a";
  const inFlightExecutionId = "execution-inflight";
  const updatedExecutionId = "execution-updated";
  return {
    e2eCase: { case_id: "same-priority", evidence_predicate_id: "same_conductor_preemption" },
    caseRoots: { root_issue_ids: [inFlightRootIssueId, updatedRootIssueId] },
    caseContext: {
      human_actor_id: "human-actor",
      conductors: [{ conductor_id: conductorId, repository_identity: "repository-a" }],
    },
    snapshot: {
      kind: "complete",
      observed_at: observedAt,
      root_trees: [
        tree({
          rootIssueId: inFlightRootIssueId,
          conductorId,
          updatedAt: "2026-07-25T00:00:00.000Z",
          activity: [],
          records: [
            ownership(inFlightRootIssueId, conductorId),
            execution({ id: inFlightExecutionId, rootIssueId: inFlightRootIssueId, startedAt: "2026-07-25T00:00:01.000Z" }),
            result({ id: "result-inflight", executionId: inFlightExecutionId, rootIssueId: inFlightRootIssueId, completedAt: "2026-07-25T00:00:03.000Z" }),
          ],
        }),
        tree({
          rootIssueId: updatedRootIssueId,
          conductorId,
          updatedAt: "2026-07-25T00:00:02.000Z",
          activity: [{
            activity_id: "activity-human-update",
            actor_id: "human-actor",
            created_at: "2026-07-25T00:00:02.000Z",
            updated_at: "2026-07-25T00:00:02.000Z",
            from_priority: null,
            to_priority: null,
            from_state_id: null,
            to_state_id: null,
            from_title: null,
            to_title: null,
            updated_description: true,
            is_archived: false,
          }],
          records: [
            ownership(updatedRootIssueId, conductorId),
            execution({ id: updatedExecutionId, rootIssueId: updatedRootIssueId, startedAt: "2026-07-25T00:00:04.000Z" }),
          ],
        }),
      ],
      repositories: [{ repository_identity: "repository-a" }],
    },
  };
}

function tree({ rootIssueId, conductorId, updatedAt, activity, records }) {
  const blocks = records.map((record) => block(rootIssueId, conductorId, record));
  return {
    root_issue_id: rootIssueId,
    issues: [
      {
        issue_id: rootIssueId,
        parent_issue_id: null,
        priority: 2,
        updated_at: updatedAt,
        remote_version: updatedAt,
        status: { name: "In Progress" },
      },
      {
        issue_id: `plan-${rootIssueId}`,
        parent_issue_id: rootIssueId,
        priority: 2,
        updated_at: updatedAt,
        remote_version: updatedAt,
        status: { name: "In Progress" },
      },
    ],
    comments: blocks.map(({ source_id, issue_id }) => ({ comment_id: source_id, issue_id })),
    relations: [],
    activity: [{ issue_id: rootIssueId, history: activity, state_history: [] }],
    managed_blocks: blocks,
  };
}

function block(rootIssueId, conductorId, record) {
  const issueId = record.kind === "stage_execution" || record.kind === "stage_result"
    ? record.node_issue_id
    : rootIssueId;
  return {
    source_kind: "comment",
    source_id: `comment-${record.kind}-${record.kind === "stage_execution" ? record.stage_execution_id : record.kind === "stage_result" ? record.result_id : rootIssueId}`,
    source_version: observedAt,
    actor: { actor_id: conductorId, actor_kind: "user" },
    issue_id: issueId,
    record,
  };
}

function ownership(rootIssueId, conductorId) {
  return {
    kind: "root_ownership",
    version: 1,
    root_issue_id: rootIssueId,
    conductor_id: conductorId,
    performer_profile_id: "profile-a",
    delivery_branch: "symphony/test",
    owner_generation: "generation-a",
  };
}

function execution({ id, rootIssueId, startedAt }) {
  return {
    kind: "stage_execution",
    version: 1,
    stage_execution_id: id,
    root_issue_id: rootIssueId,
    cycle_issue_id: `cycle-${rootIssueId}`,
    node_issue_id: `plan-${rootIssueId}`,
    stage: "plan",
    context_digest: "context-a",
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    instruction_set_id: "instruction-a",
    execution_policy_id: "policy-a",
    limits: {
      max_context_bytes: 1,
      max_result_bytes: 1,
      max_wall_time_ms: 1,
      max_tool_calls: 0,
      max_command_duration_ms: 1,
      reserved_total_tokens: 0,
      max_output_tokens: 1,
    },
    repository_revision: "baseline-a",
    started_at: startedAt,
    deadline_at: "2026-07-25T00:10:00.000Z",
  };
}

function result({ id, executionId, rootIssueId, completedAt }) {
  return {
    kind: "stage_result",
    version: 1,
    result_id: id,
    root_issue_id: rootIssueId,
    cycle_issue_id: `cycle-${rootIssueId}`,
    node_issue_id: `plan-${rootIssueId}`,
    stage: "plan",
    role_session_id: "plan-session-a",
    role_turn_id: "plan-turn-a",
    observed_tree_digest: "tree-a",
    context_digest: "context-a",
    outcome_kind: "plan_completed",
    summary: "Completed.",
    source_manifest: [],
    completed_at: completedAt,
    model_turn: {
      turn_record_id: `${executionId}:plan-turn-a`,
      role: "plan",
      root_issue_id: rootIssueId,
      cycle_issue_id: `cycle-${rootIssueId}`,
      target_issue_id: `plan-${rootIssueId}`,
      stage_execution_id: executionId,
      role_session_id: "plan-session-a",
      role_turn_id: "plan-turn-a",
      invocation_state: "confirmed",
      model: "gpt-5-codex",
      outcome: "plan_completed",
      usage: {
        status: "measured",
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
        total_tokens: 2,
      },
      terminal_at: completedAt,
    },
    plan_contract: { objective: "Plan." },
    proposed_work_dag: { work_nodes: [] },
    risks: [],
    required_permissions: [],
    evidence_refs: [],
  };
}
