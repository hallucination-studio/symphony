import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  lastLogReason,
  latestRootFailureReason,
  readArchitectureAcceptanceManifest,
  runTargetArchitectureEvidence,
  safeErrorCode,
  targetArchitectureScenarioManifest,
  waitForPlanReviewEvidence,
  waitForExecutionEvidence,
} from "../../tools/e2e/target-architecture.mjs";
import { isMissingInputConfiguration, loadE2EConfig } from "../../tools/e2e/config.mjs";

const EVIDENCE_DEADLINE_MS = 300_000;

test("target E2E manifest is generated from the architecture acceptance section", async () => {
  const acceptance = await readArchitectureAcceptanceManifest();
  const scenarios = targetArchitectureScenarioManifest(acceptance);
  assert.equal(acceptance.length, 8);
  assert.deepEqual(scenarios.map(({ id }) => id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    scenarios.map(({ evidence }) => evidence),
    ["linear_tree", "production_process", "production_process", "production_process",
      "production_process", "restart_recovery", "production_process", "production_process"],
  );
  for (const scenario of scenarios) assert.ok(scenario.statement.length > 0);
});

test("target E2E diagnostics prefer the concrete boundary failure over the harness wrapper", () => {
  assert.equal(lastLogReason([
    { event: "e2e_podium_handler_failed", reason: "linear_request_failed" },
    { event: "e2e_child_failed", reason: "conductor_protocol_failed" },
  ]), "linear_request_failed");
  assert.equal(lastLogReason([
    {
      event: "e2e_podium_response_error",
      request_kind: "get_workflow_issue_tree",
      code: "podium_conductor_request_failed",
    },
      { event: "linear_physical_request", operation: "SymphonyRootHeaderFacts", status: 200 },
  ]), "podium_conductor_request_failed_get_workflow_issue_tree_SymphonyRootHeaderFacts_200");
  assert.equal(lastLogReason([
    {
      event: "e2e_child_log",
      message: JSON.stringify({ event: "root_reconciliation_failed", fields: { reason: "root_directive_invalid" } }),
    },
  ]), "root_directive_invalid");
  assert.equal(lastLogReason([
    {
      event: "e2e_child_log",
      message: JSON.stringify({
        event: "root_reconciliation_failed",
        fields: {
          reason: "root_reconciliation_failed",
          failure_code: "role_result_write_linear_internal_failed",
          phase: "persist_plan_linear_write",
        },
      }),
    },
  ]), "role_result_write_linear_internal_failed");
  assert.equal(safeErrorCode(new TypeError("untrusted runtime detail")), "target_e2e_type_error");
});

test("target E2E stops when Root directive materialization fails", () => {
  assert.equal(latestRootFailureReason([
    {
      event: "e2e_child_log",
      message: JSON.stringify({
        event: "root_directive_materialization_failed",
        fields: { reason: "root_directive_create_cycle_conflict" },
      }),
    },
  ]), "root_directive_create_cycle_conflict");
});

test("target E2E waits for a durable Plan Review before a user approval", async () => {
  let calls = 0;
  const result = await waitForPlanReviewEvidence({
    gateway: {
      async getWorkflowIssueTree(projectId, rootIssueId) {
        calls += 1;
        assert.equal(projectId, "project-1");
        assert.equal(rootIssueId, "root-1");
        return planReviewTree();
      },
    },
    projectId: "project-1",
    rootIssueId: "root-1",
    deadlineAt: new Date(Date.now() + 1_000),
  });
  assert.deepEqual(result, {
    cycleIssueId: "cycle-1",
    planIssueId: "plan-1",
    approvalActionIssueId: "action-1",
    approvalActionId: "action-1:request",
    planContractDigest: "contract-1",
  });
  assert.equal(calls, 1);
});

test("target E2E fails with the durable Plan outcome instead of timing out", async () => {
  await assert.rejects(waitForPlanReviewEvidence({
    gateway: { async getWorkflowIssueTree() { return canceledPlanTree(); } },
    projectId: "project-1",
    rootIssueId: "root-1",
    deadlineAt: new Date(Date.now() + 25),
  }), /target_e2e_stage_plan_canceled/u);
});

test("target E2E execution evidence requires the complete production-created durable fact chain", async () => {
  const result = await waitForExecutionEvidence({
    gateway: { async getWorkflowIssueTree() { return completedTree(); } },
    projectId: "project-1",
    rootIssueId: "root-1",
    deadlineAt: new Date(Date.now() + 1_000),
  });

  assert.deepEqual(result, {
    cycleIssueId: "cycle-1",
    planIssueId: "plan-1",
    approvalActionIssueId: "action-1",
    planContractDigest: "contract-1",
    workIssueIds: ["work-a", "work-b"],
    verifyIssueId: "verify-1",
    planResults: 1,
    workResults: 2,
    verifyResults: 1,
    rootTimelineEvents: 1,
    cycleTimelineEvents: 1,
  });
});

test("target E2E rejects an otherwise terminal Tree without an approved Human Action resolution", async () => {
  await assert.rejects(waitForExecutionEvidence({
    gateway: {
      async getWorkflowIssueTree() {
        const tree = completedTree();
        tree.comments = tree.comments.filter(({ body }) => !body.includes('"kind":"human_action_resolution"'));
        return tree;
      },
    },
    projectId: "project-1",
    rootIssueId: "root-1",
    deadlineAt: new Date(Date.now() + 10),
  }), /target_e2e_execution_evidence_timeout/u);
});

test("target E2E execution evidence stops when the production boundary reports failure", async () => {
  await assert.rejects(waitForExecutionEvidence({
    gateway: {
      async getWorkflowIssueTree() {
        return { comments: [] };
      },
    },
    projectId: "project-1",
    rootIssueId: "root-1",
    deadlineAt: new Date(Date.now() + 1_000),
    failureReason: () => "provider_output_invalid_json",
  }), /target_e2e_execution_evidence_boundary_failed/u);
});

function planReviewTree() {
  const tree = completedTree();
  const plan = tree.issues.find(({ issueId }) => issueId === "plan-1");
  const action = tree.issues.find(({ issueId }) => issueId === "action-1");
  plan.statusName = "In Review";
  action.statusName = "Todo";
  tree.issues = tree.issues.filter(({ description }) =>
    !description.includes('"issue_kind":"work"') && !description.includes('"issue_kind":"verify"'));
  tree.comments = tree.comments.filter(({ body }) =>
    !body.includes('"kind":"human_action_resolution"') &&
    !body.includes('"stage":"work"') &&
    !body.includes('"stage":"verify"') &&
    !body.includes('"kind":"workflow_timeline"'),
  );
  tree.relations = tree.relations.filter(({ sourceIssueId, targetIssueId }) =>
    sourceIssueId === "action-1" && targetIssueId === "plan-1",
  );
  return tree;
}

function canceledPlanTree() {
  const tree = completedTree();
  const plan = tree.issues.find(({ issueId }) => issueId === "plan-1");
  plan.statusName = "Canceled";
  tree.comments = tree.comments.map((comment) =>
    comment.issueId === "plan-1" && comment.body.includes('"stage":"plan"')
      ? managed("plan-1", stageResult("plan", "canceled", "plan-1"))
      : comment,
  );
  return tree;
}

function completedTree() {
  const issues = [
    issue("root-1", "root", "In Review"),
    issue("cycle-1", "cycle", "Succeeded", "root-1"),
    issue("plan-1", "plan", "Done", "cycle-1"),
    issue("action-1", "human", "Approved", "cycle-1", ["Human Action", "Plan Review"]),
    issue("work-a", "work", "Done", "cycle-1"),
    issue("work-b", "work", "Done", "cycle-1"),
    issue("verify-1", "verify", "Done", "cycle-1"),
  ];
  const planContract = {
    kind: "plan_contract", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1",
    plan_contract_digest: "contract-1", objective: "No-op acceptance", included_scope: [], excluded_scope: [],
    assumptions: [], constraints: [], acceptance_criteria: [], verification_requirements: [],
    proposed_work_dag: {
      work_nodes: [
        { proposal_key: "head", title: "Record HEAD", execution_goal: "Record supplied HEAD", required_checks: [], dependency_proposal_keys: [] },
        { proposal_key: "status", title: "Record status", execution_goal: "Record supplied status", required_checks: [], dependency_proposal_keys: ["head"] },
      ],
      verify_node: { title: "Verify no-op", acceptance_criteria: [], required_checks: [] },
    },
  };
  return {
    issues,
    comments: [
      managed("plan-1", planContract),
      managed("plan-1", stageResult("plan", "plan_completed", "plan-1", {
        plan_contract_digest: "contract-1",
        plan_contract: {
          objective: planContract.objective, included_scope: planContract.included_scope,
          excluded_scope: planContract.excluded_scope, assumptions: planContract.assumptions,
          constraints: planContract.constraints, acceptance_criteria: planContract.acceptance_criteria,
          verification_requirements: planContract.verification_requirements,
        },
        proposed_work_dag: planContract.proposed_work_dag,
      })),
      managed("action-1", {
        kind: "human_action_request", version: 1, action_id: "action-1:request", action_issue_id: "action-1",
        action_kind: "plan_review", parent_scope: "cycle", root_issue_id: "root-1", cycle_issue_id: "cycle-1",
        related_issue_ids: ["plan-1"], source_root_directive_id: "directive-plan-review", based_on_tree_digest: "tree-plan",
        proposal_digest: "contract-1", expected_parent_remote_version: "cycle-v1", created_at: "2026-07-24T00:00:00Z",
      }),
      managed("action-1", {
        kind: "human_action_resolution", version: 1, resolution_id: "resolution-1", action_id: "action-1:request",
        action_issue_id: "action-1", action_kind: "plan_review", outcome: "approved", terminal_status: "Approved",
        terminal_remote_version: "action-v2", source_comment_ids: [], source_comment_versions: [], actor_kind: "human",
        proposal_digest: "contract-1", resolved_at: "2026-07-24T00:01:00Z",
      }),
      managed("work-a", stageResult("work", "work_completed", "work-a")),
      managed("work-b", stageResult("work", "work_completed", "work-b")),
      managed("verify-1", stageResult("verify", "verify_passed", "verify-1")),
      managed("root-1", timeline("root")),
      managed("cycle-1", timeline("cycle")),
    ],
    relations: [
      relation("action-1", "plan-1", "relates_to"),
      relation("plan-1", "work-a", "relates_to"),
      relation("plan-1", "work-b", "relates_to"),
      relation("plan-1", "verify-1", "relates_to"),
      relation("work-a", "work-b", "blocks"),
    ],
  };
}

function issue(issueId, issueKind, statusName, parentIssueId, labels = []) {
  const workflowIssue = issueKind === "root" ? undefined : {
    kind: "workflow_issue", version: 1, issue_key: issueKey(issueId, issueKind), root_issue_id: "root-1",
    parent_issue_id: parentIssueId, issue_kind: issueKind,
  };
  return {
    issueId, statusName, parentIssueId,
    labels: labels.length > 0 ? labels : workflowIssue ? [issueKind === "human" ? "Human Action" : `${issueKind[0].toUpperCase()}${issueKind.slice(1)}`] : [],
    isArchived: false, statusId: `${statusName}-id`, title: issueId,
    description: workflowIssue ? `# ${issueId}\n\n\`\`\`symphony\n${JSON.stringify(workflowIssue)}\n\`\`\`` : issueId,
    remoteVersion: issueId === "action-1" ? "action-v2" : `${issueId}-v1`,
  };
}

function relation(sourceIssueId, targetIssueId, relationKind) {
  return { relationId: `${sourceIssueId}:${targetIssueId}:${relationKind}`, sourceIssueId, targetIssueId, relationKind };
}

function managed(issueId, record) {
  return { issueId, body: `Symphony record.\n\n\`\`\`symphony\n${JSON.stringify(record)}\n\`\`\`` };
}

function issueKey(issueId, issueKind) {
  if (issueKind === "work") {
    const nodeKey = issueId === "work-a" ? "work:head" : "work:status";
    return `approved-plan-dag:${createHash("sha256").update(JSON.stringify(["cycle-1", "contract-1", nodeKey])).digest("hex")}`;
  }
  if (issueKind === "verify") {
    return `approved-plan-dag:${createHash("sha256").update(JSON.stringify(["cycle-1", "contract-1", "verify"])).digest("hex")}`;
  }
  return issueId;
}

function timeline(timelineKind) {
  return {
    kind: "workflow_timeline", version: 1, timeline_event_id: `${timelineKind}-event`, timeline_kind: timelineKind,
    target_issue_id: timelineKind === "root" ? "root-1" : "cycle-1", source_record_ids: ["record-1"],
    source_versions: ["version-1"], write_id: `${timelineKind}-write`, rendered_schema_version: "1",
    materialized_at: "2026-07-24T00:03:00Z",
  };
}

function stageResult(stage, outcomeKind, nodeIssueId, extra = {}) {
  return {
    kind: "stage_result", version: 1, result_id: `${stage}:${nodeIssueId}`, root_issue_id: "root-1",
    cycle_issue_id: "cycle-1", node_issue_id: nodeIssueId, stage, role_session_id: `${stage}-session`,
    role_turn_id: `${stage}-turn`, observed_tree_digest: "tree", context_digest: "context", outcome_kind: outcomeKind,
    summary: `${stage} complete`, source_manifest: [], completed_at: "2026-07-24T00:02:00Z", ...extra,
  };
}

const missingConfiguration = (() => {
  try {
    loadE2EConfig({ environment: process.env });
    return undefined;
  } catch (error) {
    if (isMissingInputConfiguration(error)) return "real target E2E configuration is not present";
    throw error;
  }
})();

test("target architecture black-box evidence runs behind one absolute deadline", {
  skip: missingConfiguration,
  timeout: EVIDENCE_DEADLINE_MS + 1_000,
}, async () => {
  const result = await runTargetArchitectureEvidence({
    environment: process.env,
    deadlineAt: new Date(Date.now() + EVIDENCE_DEADLINE_MS),
  });
  assert.deepEqual(result.evidenceKinds, ["linear_tree", "production_process", "restart_recovery"]);
  assert.equal(result.acceptanceCount, 8);
  assert.equal(result.scenarioCount, 8);
});
