import { happyPathRow } from "./approved-happy-path-fixture.mjs";

const observedAt = "2026-07-25T00:05:00.000Z";

export function planRejectionSupersessionRow() {
  const row = happyPathRow({
    caseId: "plan-rejection",
    conductorId: "conductor-a",
    repositoryIdentity: "repository-a",
  });
  const tree = row.snapshot.root_trees[0];
  const rootIssueId = row.caseRoots.root_issue_ids[0];
  const cycleIssueId = `cycle-plan-rejection`;
  const planIssueId = `plan-plan-rejection`;
  const oldActionIssueId = `action-plan-rejection`;
  const oldDigest = "digest-plan-rejection";
  const freshDigest = "digest-plan-rejection-fresh";
  const freshActionIssueId = "action-plan-rejection-fresh";
  const oldActionRequest = tree.managed_blocks.find(({ record }) => record.kind === "human_action_request").record;
  const oldResolution = tree.managed_blocks.find(({ record }) => record.kind === "human_action_resolution").record;
  const oldPlanContract = tree.managed_blocks.find(({ record }) => record.kind === "plan_contract").record;
  const oldPlanExecution = tree.managed_blocks.find(({ record }) => record.kind === "stage_execution" && record.stage === "plan").record;
  const oldPlanResult = tree.managed_blocks.find(({ record }) => record.kind === "stage_result" && record.stage === "plan").record;

  row.e2eCase.evidence_predicate_id = "plan_rejection_supersession";
  row.caseContext.human_actor_id = "human-actor";
  removeCompletedHappyPathFacts(tree);
  for (const issue of tree.issues) {
    issue.is_archived = false;
    issue.archived_at = null;
  }
  tree.issues.find(({ issue_id: issueId }) => issueId === rootIssueId).status.name = "In Progress";
  tree.issues.find(({ issue_id: issueId }) => issueId === cycleIssueId).status.name = "Planning";
  tree.issues.find(({ issue_id: issueId }) => issueId === planIssueId).status.name = "In Review";
  const oldAction = tree.issues.find(({ issue_id: issueId }) => issueId === oldActionIssueId);
  oldAction.status.name = "Rejected";
  oldAction.remote_version = "2026-07-25T00:00:02.500Z";
  oldAction.is_archived = true;
  oldAction.archived_at = "2026-07-25T00:00:02.500Z";
  oldAction.labels = planReviewLabels("label-human-action-old", "label-plan-review-old");

  const reasonComment = {
    comment_id: "comment-plan-rejection-reason",
    issue_id: oldActionIssueId,
    remote_version: "2026-07-25T00:00:02.200Z",
    body: "The proposed Plan misses the requested behavior. Please replan it.",
    author: { actor_id: "human-actor", actor_kind: "user" },
  };
  tree.comments.push(reasonComment);
  oldResolution.outcome = "rejected";
  oldResolution.terminal_status = "Rejected";
  oldResolution.terminal_remote_version = "2026-07-25T00:00:02.300Z";
  oldResolution.source_comment_ids = [reasonComment.comment_id];
  oldResolution.source_comment_versions = [reasonComment.remote_version];
  oldResolution.resolved_at = "2026-07-25T00:00:02.300Z";

  const directiveId = "directive-plan-rejection";
  appendRecord(tree, rootIssueId, {
    kind: "root_directive",
    version: 1,
    root_directive_id: directiveId,
    root_issue_id: rootIssueId,
    reconciler_session_id: "reconciler-session-1",
    reconciler_turn_id: "reconciler-turn-1",
    based_on_target_root_digest: "root-tree-1",
    consumed_input_ids: [],
    directive: replanDirective({
      rootIssueId,
      cycleIssueId,
      planIssueId,
      oldDigest,
      oldActionRequest,
      oldResolution,
      directiveId,
    }),
    accepted_at: "2026-07-25T00:00:02.400Z",
  });
  appendRecord(tree, planIssueId, {
    kind: "plan_contract_supersession",
    version: 1,
    supersession_id: "6c91410f3b514de14bb42940209d6acd1ca1d156f64b5a3b582dcbb9232f058e",
    root_issue_id: rootIssueId,
    cycle_issue_id: cycleIssueId,
    superseded_plan_contract_digest: oldDigest,
    source_root_directive_id: directiveId,
    fresh_plan_issue_id: planIssueId,
    superseded_at: "2026-07-25T00:00:02.400Z",
  });

  const freshExecutionId = "plan-execution-plan-rejection-fresh";
  const freshResultId = "plan-result-plan-rejection-fresh";
  appendRecord(tree, planIssueId, {
    ...structuredClone(oldPlanExecution),
    stage_execution_id: freshExecutionId,
    started_at: "2026-07-25T00:00:02.500Z",
  });
  appendRecord(tree, planIssueId, {
    ...structuredClone(oldPlanContract),
    plan_contract_digest: freshDigest,
  });
  const freshPlanResult = structuredClone(oldPlanResult);
  freshPlanResult.result_id = freshResultId;
  freshPlanResult.plan_contract_digest = freshDigest;
  freshPlanResult.role_turn_id = "plan-turn-fresh";
  freshPlanResult.completed_at = "2026-07-25T00:00:03.000Z";
  freshPlanResult.model_turn.turn_record_id = `${freshExecutionId}:plan-turn-fresh`;
  freshPlanResult.model_turn.stage_execution_id = freshExecutionId;
  freshPlanResult.model_turn.role_turn_id = "plan-turn-fresh";
  freshPlanResult.model_turn.terminal_at = freshPlanResult.completed_at;
  appendRecord(tree, planIssueId, freshPlanResult);
  const freshActionRequest = structuredClone(oldActionRequest);
  freshActionRequest.action_id = "request-plan-rejection-fresh";
  freshActionRequest.action_issue_id = freshActionIssueId;
  freshActionRequest.proposal_digest = freshDigest;
  freshActionRequest.created_at = "2026-07-25T00:00:03.100Z";
  appendRecord(tree, freshActionIssueId, freshActionRequest);
  tree.issues.push({
    issue_id: freshActionIssueId,
    parent_issue_id: cycleIssueId,
    remote_version: "2026-07-25T00:00:03.100Z",
    status: { name: "Todo" },
    is_archived: false,
    archived_at: null,
    labels: planReviewLabels("label-human-action-fresh", "label-plan-review-fresh"),
  });
  tree.relations.push({ relation_kind: "relates_to", issue_id: freshActionIssueId, related_issue_id: planIssueId });

  return row;
}

function planReviewLabels(humanActionId, planReviewId) {
  return [
    { label_id: humanActionId, name: "Human Action" },
    { label_id: planReviewId, name: "Plan Review" },
  ];
}

function removeCompletedHappyPathFacts(tree) {
  const removedIssueIds = new Set(["work-plan-rejection", "verify-plan-rejection"]);
  const retainedBlocks = tree.managed_blocks.filter(({ record }) =>
    !["work", "verify"].includes(record.stage) && record.kind !== "verify_result" && record.kind !== "delivery",
  );
  const retainedCommentIds = new Set(retainedBlocks.map(({ source_id: sourceId }) => sourceId));
  tree.issues = tree.issues.filter(({ issue_id: issueId }) => !removedIssueIds.has(issueId));
  tree.relations = tree.relations.filter(({ issue_id: issueId, related_issue_id: relatedIssueId }) =>
    !removedIssueIds.has(issueId) && !removedIssueIds.has(relatedIssueId),
  );
  tree.managed_blocks = retainedBlocks;
  tree.comments = tree.comments.filter(({ comment_id: commentId }) => retainedCommentIds.has(commentId));
}

function replanDirective({ rootIssueId, cycleIssueId, planIssueId, oldDigest, oldActionRequest, oldResolution, directiveId }) {
  return {
    protocol_version: "1",
    request_id: "request-plan-rejection",
    root_directive_id: directiveId,
    reconciler_session_id: "reconciler-session-1",
    reconciler_turn_id: "reconciler-turn-1",
    model_turn: {
      turn_record_id: "reconciler-turn-record-1",
      role: "root_reconciler",
      root_issue_id: rootIssueId,
      reconciler_session_id: "reconciler-session-1",
      reconciler_turn_id: "reconciler-turn-1",
      invocation_state: "confirmed",
      model: "gpt-5-codex",
      outcome: "directive_accepted",
      usage: { status: "measured", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
      terminal_at: "2026-07-25T00:00:02.400Z",
    },
    based_on_target_root_digest: "root-tree-1",
    rationale: "The rejected Plan needs a fresh execution.",
    evidence_refs: [],
    consumed_input_ids: [],
    comment_replies: [],
    human_action_resolutions: [{
      resolution_id: oldResolution.resolution_id,
      action_id: oldActionRequest.action_id,
      action_issue_id: oldActionRequest.action_issue_id,
      action_kind: "plan_review",
      outcome: "rejected",
      terminal_status: "Rejected",
      terminal_remote_version: oldResolution.terminal_remote_version,
      proposal_digest: oldDigest,
      source_comment_ids: [...oldResolution.source_comment_ids],
      actor_kind: "human",
      resolved_at: oldResolution.resolved_at,
    }],
    action: {
      kind: "replan_current_cycle",
      cycle_issue_id: cycleIssueId,
      reason: "The rejected Plan needs a fresh execution.",
      superseded_plan_contract_ids: [oldDigest],
      invalidate_execution_ids: [],
      preserve_evidence_refs: [],
      archive_or_restore_operations: [{
        kind: "archive_node",
        precondition: {
          target_issue_id: oldActionRequest.action_issue_id,
          expected_remote_version: oldResolution.terminal_remote_version,
          expected_parent_issue_id: cycleIssueId,
          expected_status: "Rejected",
        },
      }],
      plan_issue_id: planIssueId,
      fresh_plan_goal: "Produce a corrected Plan for the original Root objective.",
    },
  };
}

function appendRecord(tree, issueId, record) {
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
