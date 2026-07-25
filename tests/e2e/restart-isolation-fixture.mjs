const observedAt = "2026-07-25T00:20:00.000Z";

export function restartIsolationRow() {
  const rootIssueIds = ["root-restart-c", "root-restart-a", "root-restart-b"];
  const [cRootIssueId, aRootIssueId, bRootIssueId] = rootIssueIds;
  return {
    e2eCase: {
      case_id: "restart-isolation",
      evidence_predicate_id: "restart_isolation",
    },
    caseRoots: { root_issue_ids: rootIssueIds },
    caseContext: {
      conductors: [
        conductor("c"),
        conductor("a"),
        conductor("b"),
      ],
    },
    snapshot: {
      kind: "complete",
      observed_at: observedAt,
      root_trees: [
        tree({
          rootIssueId: cRootIssueId,
          conductorId: "conductor-c",
          records: [
            ownership(cRootIssueId, "conductor-c"),
            execution({
              executionId: "execution-c-before-restart",
              rootIssueId: cRootIssueId,
              cycleIssueId: "cycle-restart-c",
              nodeIssueId: "plan-restart-c",
              startedAt: "2026-07-25T00:00:00.000Z",
            }),
            result({
              resultId: "result-c-before-restart",
              executionId: "execution-c-before-restart",
              rootIssueId: cRootIssueId,
              cycleIssueId: "cycle-restart-c",
              nodeIssueId: "plan-restart-c",
              roleSessionId: "session-c-before-restart",
              outcomeKind: "execution_failed",
              completedAt: "2026-07-25T00:00:05.000Z",
            }),
            execution({
              executionId: "execution-c-after-restart",
              rootIssueId: cRootIssueId,
              cycleIssueId: "cycle-restart-c",
              nodeIssueId: "plan-restart-c",
              startedAt: "2026-07-25T00:00:06.000Z",
            }),
            result({
              resultId: "result-c-after-restart",
              executionId: "execution-c-after-restart",
              rootIssueId: cRootIssueId,
              cycleIssueId: "cycle-restart-c",
              nodeIssueId: "plan-restart-c",
              roleSessionId: "session-c-after-restart",
              outcomeKind: "plan_completed",
              completedAt: "2026-07-25T00:00:10.000Z",
            }),
          ],
        }),
        tree({
          rootIssueId: aRootIssueId,
          conductorId: "conductor-a",
          records: [
            ownership(aRootIssueId, "conductor-a"),
            execution({
              executionId: "execution-a-continuous",
              rootIssueId: aRootIssueId,
              cycleIssueId: "cycle-restart-a",
              nodeIssueId: "plan-restart-a",
              startedAt: "2026-07-25T00:00:01.000Z",
            }),
            result({
              resultId: "result-a-continuous",
              executionId: "execution-a-continuous",
              rootIssueId: aRootIssueId,
              cycleIssueId: "cycle-restart-a",
              nodeIssueId: "plan-restart-a",
              roleSessionId: "session-a-continuous",
              outcomeKind: "plan_completed",
              completedAt: "2026-07-25T00:00:12.000Z",
            }),
          ],
        }),
        tree({
          rootIssueId: bRootIssueId,
          conductorId: "conductor-b",
          records: [
            ownership(bRootIssueId, "conductor-b"),
            execution({
              executionId: "execution-b-continuous",
              rootIssueId: bRootIssueId,
              cycleIssueId: "cycle-restart-b",
              nodeIssueId: "plan-restart-b",
              startedAt: "2026-07-25T00:00:02.000Z",
            }),
            result({
              resultId: "result-b-continuous",
              executionId: "execution-b-continuous",
              rootIssueId: bRootIssueId,
              cycleIssueId: "cycle-restart-b",
              nodeIssueId: "plan-restart-b",
              roleSessionId: "session-b-continuous",
              outcomeKind: "plan_completed",
              completedAt: "2026-07-25T00:00:13.000Z",
            }),
          ],
        }),
      ],
      repositories: [
        { repository_identity: "repository-c" },
        { repository_identity: "repository-a" },
        { repository_identity: "repository-b" },
      ],
    },
  };
}

function conductor(suffix) {
  return {
    binding_id: `binding-${suffix}`,
    conductor_id: `conductor-${suffix}`,
    conductor_short_hash: `hash-${suffix}`,
    repository_identity: `repository-${suffix}`,
  };
}

function tree({ rootIssueId, conductorId, records }) {
  const blocks = records.map((record) => block(rootIssueId, conductorId, record));
  const execution = records.find(({ kind }) => kind === "stage_execution");
  return {
    root_issue_id: rootIssueId,
    issues: [
      {
        issue_id: rootIssueId,
        parent_issue_id: null,
        priority: 2,
        updated_at: observedAt,
        remote_version: observedAt,
        status: { name: "In Progress" },
      },
      {
        issue_id: execution.cycle_issue_id,
        parent_issue_id: rootIssueId,
        priority: 2,
        updated_at: observedAt,
        remote_version: observedAt,
        status: { name: "In Progress" },
      },
      {
        issue_id: execution.node_issue_id,
        parent_issue_id: execution.cycle_issue_id,
        priority: 2,
        updated_at: observedAt,
        remote_version: observedAt,
        status: { name: "In Progress" },
      },
    ],
    comments: blocks.map(({ source_id, issue_id }) => ({ comment_id: source_id, issue_id })),
    relations: [],
    activity: [{ issue_id: rootIssueId, history: [], state_history: [] }],
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
    performer_profile_id: `profile-${conductorId}`,
    delivery_branch: `symphony/${rootIssueId}`,
    owner_generation: `generation-${conductorId}`,
  };
}

function execution({ executionId, rootIssueId, cycleIssueId, nodeIssueId, startedAt }) {
  return {
    kind: "stage_execution",
    version: 1,
    stage_execution_id: executionId,
    root_issue_id: rootIssueId,
    cycle_issue_id: cycleIssueId,
    node_issue_id: nodeIssueId,
    stage: "plan",
    context_digest: `context-${executionId}`,
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    instruction_set_id: "instruction-restart",
    execution_policy_id: "policy-restart",
    limits: {
      max_context_bytes: 1,
      max_result_bytes: 1,
      max_wall_time_ms: 1,
      max_tool_calls: 1,
      max_command_duration_ms: 1,
      reserved_total_tokens: 1,
      max_output_tokens: 1,
    },
    repository_revision: "revision-restart",
    started_at: startedAt,
    deadline_at: "2026-07-25T00:30:00.000Z",
  };
}

function result({ resultId, executionId, rootIssueId, cycleIssueId, nodeIssueId, roleSessionId, outcomeKind, completedAt }) {
  return {
    kind: "stage_result",
    version: 1,
    result_id: resultId,
    root_issue_id: rootIssueId,
    cycle_issue_id: cycleIssueId,
    node_issue_id: nodeIssueId,
    stage: "plan",
    role_session_id: roleSessionId,
    role_turn_id: `turn-${resultId}`,
    observed_tree_digest: `tree-${resultId}`,
    context_digest: `context-${executionId}`,
    outcome_kind: outcomeKind,
    summary: "Terminal stage result.",
    source_manifest: [],
    completed_at: completedAt,
    model_turn: {
      turn_record_id: `turn-record-${resultId}`,
      role: "plan",
      root_issue_id: rootIssueId,
      cycle_issue_id: cycleIssueId,
      target_issue_id: nodeIssueId,
      stage_execution_id: executionId,
      role_session_id: roleSessionId,
      role_turn_id: `turn-${resultId}`,
      invocation_state: "confirmed",
      model: "gpt-5-codex",
      outcome: outcomeKind,
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
    ...(outcomeKind === "execution_failed" ? { failure_code: "process_lost" } : {}),
  };
}
