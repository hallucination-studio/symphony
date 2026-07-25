import { createHash } from "node:crypto";

const BASE = "2026-07-25T00:00:00.000Z";

export function requiredWriteOutageRow() {
  const rootIssueId = "root-required-write";
  const cycleIssueId = "cycle-required-write";
  const planResultId = "plan-result-required-write";
  const timelineEventId = createHash("sha256")
    .update(["stage_result", rootIssueId, cycleIssueId, planResultId].join("\0"), "utf8")
    .digest("hex");
  const at = (offset) => new Date(Date.parse(BASE) + offset).toISOString();
  const records = [
    block("plan-result-comment", "plan-required-write", at(2_000), stageResult({
      resultId: planResultId,
      rootIssueId,
      cycleIssueId,
      nodeIssueId: "plan-required-write",
      stage: "plan",
      outcomeKind: "plan_completed",
      completedAt: at(2_000),
      observedTreeDigest: "tree-before-plan",
    })),
    block("plan-timeline-comment", cycleIssueId, at(3_000), {
      kind: "workflow_timeline",
      version: 1,
      timeline_event_id: timelineEventId,
      timeline_kind: "cycle",
      target_issue_id: cycleIssueId,
      source_record_ids: [planResultId],
      source_versions: ["tree-before-plan"],
      write_id: timelineEventId,
      rendered_schema_version: "1",
      occurred_at: at(2_000),
    }),
    block("work-execution-comment", "work-required-write", at(3_100), stageExecution({
      stageExecutionId: "work-execution-required-write",
      rootIssueId,
      cycleIssueId,
      nodeIssueId: "work-required-write",
      stage: "work",
      startedAt: at(3_100),
    })),
  ];
  return {
    e2eCase: {
      case_id: "required-write-outage",
      evidence_predicate_id: "required_write_fail_closed",
    },
    caseRoots: { root_issue_ids: [rootIssueId] },
    caseContext: { symphony_actor_id: "symphony-actor" },
    snapshot: {
      kind: "complete",
      observed_at: at(5_000),
      root_trees: [{
        root_issue_id: rootIssueId,
        issues: [
          issue(rootIssueId, null),
          issue(cycleIssueId, rootIssueId),
          issue("plan-required-write", cycleIssueId),
          issue("work-required-write", cycleIssueId),
        ],
        comments: records.map(({ source_id, issue_id, created_at, source_version }) => ({
          comment_id: source_id,
          issue_id,
          created_at,
          updated_at: created_at,
          remote_version: source_version,
          author: { actor_id: "symphony-actor", actor_kind: "user" },
        })),
        relations: [],
        managed_blocks: records,
      }],
      repositories: [{ repository_identity: "repository-a" }],
    },
  };
}

function block(sourceId, issueId, createdAt, record) {
  return {
    source_kind: "comment",
    source_id: sourceId,
    source_version: createdAt,
    actor: { actor_id: "symphony-actor", actor_kind: "user" },
    issue_id: issueId,
    record,
    created_at: createdAt,
  };
}

function issue(issueId, parentIssueId) {
  return { issue_id: issueId, parent_issue_id: parentIssueId, remote_version: BASE };
}

function stageResult({
  resultId,
  rootIssueId,
  cycleIssueId,
  nodeIssueId,
  stage,
  outcomeKind,
  completedAt,
  observedTreeDigest,
}) {
  return {
    kind: "stage_result",
    version: 1,
    result_id: resultId,
    root_issue_id: rootIssueId,
    cycle_issue_id: cycleIssueId,
    node_issue_id: nodeIssueId,
    stage,
    outcome_kind: outcomeKind,
    completed_at: completedAt,
    observed_tree_digest: observedTreeDigest,
  };
}

function stageExecution({ stageExecutionId, rootIssueId, cycleIssueId, nodeIssueId, stage, startedAt }) {
  return {
    kind: "stage_execution",
    version: 1,
    stage_execution_id: stageExecutionId,
    root_issue_id: rootIssueId,
    cycle_issue_id: cycleIssueId,
    node_issue_id: nodeIssueId,
    stage,
    started_at: startedAt,
  };
}
