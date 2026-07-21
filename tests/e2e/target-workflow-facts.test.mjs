import assert from "node:assert/strict";
import test from "node:test";

import { projectTargetWorkflowFacts } from "../../tools/e2e/target-workflow-facts.mjs";

test("target facts project durable Plan, Work, Verify, and delivery records", () => {
  const facts = projectTargetWorkflowFacts(snapshot());

  assert.equal(facts.root.rootIssueId, "root-1");
  assert.equal(facts.root.cycleIssueId, "cycle-1");
  assert.equal(facts.root.planIssueId, "plan-1");
  assert.equal(facts.root.finalVerifyId, "verify-execution-1");
  assert.equal(facts.plan.approved, true);
  assert.equal(facts.plan.dagSealed, true);
  assert.deepEqual(facts.plan.workNodeIds, ["work-1"]);
  assert.deepEqual(facts.plan.verifyNodeIds, ["verify-1"]);
  assert.equal(facts.stageExecutions.length, 3);
  assert.equal(facts.stageExecutions.find(({ stage }) => stage === "work").gitHead, "b".repeat(40));
  assert.deepEqual(facts.progress, {
    completedWorkNodes: 1,
    sourceExecutionIds: ["work-execution-1"],
  });
  assert.deepEqual(facts.delivery, {
    kind: "local_branch",
    branch: "symphony/runs/root-1",
    head: "b".repeat(40),
    verifiedAgainst: "verify-1",
    readBack: true,
  });
});

test("target facts reject duplicate or mismatched durable records", () => {
  const duplicate = snapshot();
  duplicate.comments.push(comment("work-1", "work-terminal-duplicate", {
    kind: "stage_terminal", version: 1, stage_execution_id: "work-execution-1",
    root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_issue_id: "work-1",
    stage: "work", context_digest: "w".repeat(64), outcome: "completed",
    completed_at: "2026-07-22T00:00:03Z", summary: "Duplicate.",
  }));
  assert.throws(() => projectTargetWorkflowFacts(duplicate), /target_facts_duplicate_record/u);

  const wrongRevision = snapshot();
  wrongRevision.comments = wrongRevision.comments.map((entry) => entry.id === "delivery"
    ? comment("root-1", "delivery-wrong", {
      kind: "delivery", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1",
      verify_result_id: "verify-execution-1", verified_revision: "c".repeat(40),
      delivery_kind: "local_branch", delivery_branch: "symphony/runs/root-1",
      delivered_at: "2026-07-22T00:00:04Z",
    })
    : entry);
  assert.throws(() => projectTargetWorkflowFacts(wrongRevision), /target_facts_delivery_revision_mismatch/u);
});

test("target facts reject records that cross Root, Cycle, Node, or Issue boundaries", () => {
  const wrongExecutionRoot = snapshot();
  wrongExecutionRoot.comments = wrongExecutionRoot.comments.map((entry) => entry.id === "work-execution"
    ? comment("work-1", "work-execution-wrong-root", {
      ...record(entry), root_issue_id: "root-2",
    })
    : entry);
  assert.throws(() => projectTargetWorkflowFacts(wrongExecutionRoot), /target_facts_stage_correlation_invalid/u);

  const wrongTerminalNode = snapshot();
  wrongTerminalNode.comments = wrongTerminalNode.comments.map((entry) => entry.id === "work-terminal"
    ? comment("work-1", "work-terminal-wrong-node", {
      ...record(entry), node_issue_id: "verify-1",
    })
    : entry);
  assert.throws(() => projectTargetWorkflowFacts(wrongTerminalNode), /target_facts_stage_correlation_invalid/u);

  const wrongCycleKey = snapshot();
  wrongCycleKey.comments = wrongCycleKey.comments.map((entry) => entry.id === "cycle-marker"
    ? comment("cycle-1", "cycle-marker-wrong-key", {
      ...record(entry), cycle_key: "cycle-2",
    })
    : entry);
  assert.throws(() => projectTargetWorkflowFacts(wrongCycleKey), /target_facts_cycle_invalid/u);

  const unknownIssueComment = snapshot();
  unknownIssueComment.comments = unknownIssueComment.comments.concat(
    comment("missing-issue", "unknown-issue-record", {
      kind: "delivery", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1",
      verify_result_id: "verify-execution-1", verified_revision: "b".repeat(40),
      delivery_kind: "local_branch", delivery_branch: "symphony/runs/root-1",
      delivered_at: "2026-07-22T00:00:04Z",
    }),
  );
  assert.throws(() => projectTargetWorkflowFacts(unknownIssueComment), /target_facts_record_issue_invalid/u);
});

test("target facts reject unversioned records and stale Work or Verify revisions", () => {
  const wrongVersion = snapshot();
  wrongVersion.comments = wrongVersion.comments.map((entry) => entry.id === "cycle-marker"
    ? comment("cycle-1", "cycle-marker-v2", { ...record(entry), version: 2 })
    : entry);
  assert.throws(() => projectTargetWorkflowFacts(wrongVersion), /target_facts_record_invalid/u);

  const wrongWorkKey = snapshot();
  wrongWorkKey.comments = wrongWorkKey.comments.map((entry) => entry.id === "work-completion"
    ? comment("work-1", "work-completion-wrong-key", { ...record(entry), work_key: "other-work" })
    : entry);
  assert.throws(() => projectTargetWorkflowFacts(wrongWorkKey), /target_facts_work_completion_invalid/u);

  const wrongVerifyTarget = snapshot();
  wrongVerifyTarget.comments = wrongVerifyTarget.comments.map((entry) => entry.id === "verify-result"
    ? comment("verify-1", "verify-result-wrong-target", { ...record(entry), verified_revision: "a".repeat(40) })
    : entry);
  assert.throws(() => projectTargetWorkflowFacts(wrongVerifyTarget), /target_facts_verify_result_invalid/u);
});

test("target facts project correlated repair escalation from durable records", () => {
  const repair = snapshot();
  repair.comments.push(
    comment("verify-1", "finding-1", {
      kind: "finding", version: 1, finding_id: "finding-1", source_verify_id: "verify-execution-1",
      category: "code", severity: "high", evidence: [], affected_scope: [], retryable: true,
      suggested_remediation: ["Repair the failing implementation."], acceptance_criteria: [],
    }),
    comment("verify-1", "finding-disposition-1", {
      kind: "finding_disposition", version: 1, finding_id: "finding-1",
      source_verify_id: "verify-execution-1", disposition: "still_open", evidence: [],
    }),
    comment("root-1", "convergence-1", {
      kind: "convergence", version: 1, root_issue_id: "root-1",
      observed_at: "2026-07-22T00:00:05Z",
      policy: {
        max_cycles_per_root: 2, max_same_open_finding_cycles: 2,
        max_consecutive_no_progress: 2, max_total_tokens: 1000,
        deadline_at: "2026-07-23T00:00:00Z",
      },
      view: {
        cycle_count: 2,
        open_finding_persistence: [{ finding_id: "finding-1", open_cycle_count: 2 }],
        consecutive_no_progress: 2, settled_tokens: 100,
        open_token_reservations: [], is_deadline_exceeded: false, root_is_canceled: false,
      },
      trigger: "max_cycles_per_root", decision: "escalate",
    }),
  );

  const facts = projectTargetWorkflowFacts(repair);

  assert.deepEqual(facts.repairEscalation, {
    findingId: "finding-1",
    sourceVerifyId: "verify-1",
    disposition: "escalated",
    breaker: {
      checked: true,
      decision: "escalate",
      cycleCount: 2,
      maxCycles: 2,
      openFindingCount: 1,
    },
  });
});

function snapshot() {
  const workRevision = "b".repeat(40);
  return {
    rootIssueId: "root-1",
    projectId: "project-1",
    git: { head: workRevision, branch: "symphony/runs/root-1" },
    issues: [
      issue("root-1", "root", "In Review"),
      issue("cycle-1", "cycle", "Succeeded", "root-1"),
      issue("plan-1", "plan", "Done", "cycle-1"),
      issue("work-1", "work", "Done", "cycle-1", "work-key-1"),
      issue("verify-1", "verify", "Done", "cycle-1"),
    ],
    relations: [
      { relationKind: "blocks", sourceIssueId: "plan-1", targetIssueId: "work-1" },
      { relationKind: "blocks", sourceIssueId: "work-1", targetIssueId: "verify-1" },
    ],
    comments: [
      comment("cycle-1", "cycle-marker", {
        kind: "cycle_marker", version: 1, root_issue_id: "root-1", cycle_key: "cycle-1",
        trigger: "initial", baseline_revision: "a".repeat(40),
      }),
      comment("plan-1", "plan-contract", {
        kind: "plan_contract", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1",
        plan_contract_digest: "d".repeat(64), objective_summary: "Build it.",
        included_scope: ["apps"], excluded_scope: [], acceptance_criteria: [],
        work_nodes: [{ work_key: "work-key-1", title: "Work", description: "Work.", acceptance_criteria: [], dependency_work_keys: [] }],
        verify_node: { title: "Verify", acceptance_criteria: [], required_checks: [] },
      }),
      comment("plan-1", "plan-execution", execution("plan-execution-1", "plan", "plan-1", "a".repeat(64), "a".repeat(40))),
      comment("plan-1", "plan-terminal", terminal("plan-execution-1", "plan", "plan-1", "a".repeat(64))),
      comment("work-1", "work-execution", execution("work-execution-1", "work", "work-1", "b".repeat(64), workRevision)),
      comment("work-1", "work-terminal", terminal("work-execution-1", "work", "work-1", "b".repeat(64))),
      comment("work-1", "work-completion", {
        kind: "work_completion", version: 1, stage_execution_id: "work-execution-1",
        root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_issue_id: "work-1",
        work_key: "work-key-1", context_digest: "b".repeat(64), summary: "Done.",
        changed_paths: ["apps/example.ts"], checks: [], commit_revision: workRevision,
      }),
      comment("verify-1", "verify-execution", execution("verify-execution-1", "verify", "verify-1", "c".repeat(64), workRevision)),
      comment("verify-1", "verify-terminal", terminal("verify-execution-1", "verify", "verify-1", "c".repeat(64))),
      comment("verify-1", "verify-result", {
        kind: "verify_result", version: 1, stage_execution_id: "verify-execution-1",
        root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_issue_id: "verify-1",
        conclusion: "passed", criteria_results: [], checks: [], verified_revision: workRevision,
      }),
      comment("root-1", "approval-action", {
        kind: "human_action", version: 1, action_id: "approval-1", root_issue_id: "root-1",
        cycle_issue_id: "cycle-1", node_issue_id: "plan-1", request_kind: "needs_approval",
        question_or_proposal: "Approve.", reason: "Review.", impact: "Proceed.",
        context_digest: "a".repeat(64), expected_root_remote_version: "root-version",
      }),
      comment("root-1", "delivery", {
        kind: "delivery", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1",
        verify_result_id: "verify-execution-1", verified_revision: workRevision,
        delivery_kind: "local_branch", delivery_branch: "symphony/runs/root-1",
        delivered_at: "2026-07-22T00:00:04Z",
      }),
    ],
  };
}

function issue(id, kind, state, parentIssueId, nodeKey) {
  return { id, projectId: "project-1", kind, state, ...(parentIssueId ? { parentIssueId } : {}), ...(nodeKey ? { nodeKey } : {}) };
}

function comment(issueId, id, record) {
  return { issueId, id, body: `<!-- symphony managed-record\n${JSON.stringify(record)}\n-->` };
}

function record(commentValue) {
  return JSON.parse(commentValue.body.slice("<!-- symphony managed-record\n".length, -"\n-->".length));
}

function execution(id, stage, node, context, revision) {
  return {
    kind: "stage_execution", version: 1, stage_execution_id: id,
    root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_issue_id: node, stage,
    ...(stage === "plan" ? {} : { plan_contract_digest: "d".repeat(64) }),
    context_digest: context, source_manifest: [],
    coverage: { is_complete: true, omissions: [] }, instruction_set_id: `${stage}-v1`,
    execution_policy_id: "policy-1",
    limits: { max_context_bytes: 1, max_result_bytes: 1, max_wall_time_ms: 1,
      max_tool_calls: 1, max_command_duration_ms: 1, reserved_total_tokens: 10, max_output_tokens: 1 },
    repository_revision: revision, started_at: "2026-07-22T00:00:01Z",
    deadline_at: "2026-07-22T00:01:01Z",
  };
}

function terminal(id, stage, node, context) {
  return {
    kind: "stage_terminal", version: 1, stage_execution_id: id,
    root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_issue_id: node, stage,
    context_digest: context, outcome: "completed", completed_at: "2026-07-22T00:00:02Z",
    summary: "Completed.", usage: { input_tokens: 1, cached_input_tokens: 0,
      output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
  };
}
