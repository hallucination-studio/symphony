import assert from "node:assert/strict";
import test from "node:test";

import { LinearRunBudgetImpl } from "@symphony/podium";
import { projectTargetWorkflowFacts } from "../../tools/e2e/target-workflow-facts.mjs";
import { createTargetWorkflowSnapshotTransport } from "../../tools/e2e/target-workflow-transport.mjs";

test("target transport paginates Linear facts and feeds the durable projection", async () => {
  const calls = [];
  const budget = new LinearRunBudgetImpl();
  const transport = createTargetWorkflowSnapshotTransport({
    developmentToken: "linear-dev-token",
    budget,
    fetch: fakeFetch(calls),
  });

  const snapshot = await transport.readSnapshot({
    rootIssueId: "root-1",
    projectId: "project-1",
    git: { head: "b".repeat(40), branch: "symphony/runs/root-1" },
  });
  const facts = projectTargetWorkflowFacts(snapshot);

  assert.equal(calls.length, 7);
  assert.equal(budget.snapshot().physicalRequests, 7);
  assert.equal(budget.snapshot().logicalOperations, 1);
  assert.deepEqual(facts.plan.workNodeIds, ["work-1"]);
  assert.equal(facts.plan.dagSealed, true);
  assert.equal(snapshot.issues.find(({ id }) => id === "work-1").nodeKey, "work-key-1");
  assert.equal(snapshot.comments.some(({ body }) => body.includes("node_marker")), false);
  assert.deepEqual(snapshot.relations, [
    { relationKind: "blocks", sourceIssueId: "plan-1", targetIssueId: "work-1" },
    { relationKind: "blocks", sourceIssueId: "work-1", targetIssueId: "verify-1" },
  ]);
});

test("target transport consumes paginated Issue comments without duplicating records", async () => {
  const calls = [];
  const transport = createTargetWorkflowSnapshotTransport({
    developmentToken: "linear-dev-token",
    fetch: fakeFetch(calls, { paginateComments: true }),
  });
  const snapshot = await transport.readSnapshot({
    rootIssueId: "root-1",
    projectId: "project-1",
    git: { head: "b".repeat(40), branch: "symphony/runs/root-1" },
  });
  assert.equal(new Set(snapshot.comments.map(({ id }) => id)).size, snapshot.comments.length);
  assert.ok(calls.some(({ variables }) => variables.commentsAfter === "comment-cursor-1"));
});

test("root-scoped transport batches facts by tree depth instead of querying each Issue", async () => {
  const calls = [];
  const transport = createTargetWorkflowSnapshotTransport({
    developmentToken: "linear-dev-token",
    budget: new LinearRunBudgetImpl(),
    rootScoped: true,
    fetch: rootScopedFetch(calls),
  });
  const snapshot = await transport.readSnapshot({
    rootIssueId: "root-1",
    projectId: "project-1",
    git: { head: "b".repeat(40), branch: "symphony/runs/root-1" },
  });
  assert.equal(snapshot.issues.length, 5);
  assert.ok(calls.length <= 6);
  assert.equal(calls.some(({ operation }) => operation === "TargetWorkflowIssueDetails"), false);
});

test("target transport keeps completed comment pagination closed while relations continue", async () => {
  const calls = [];
  const transport = createTargetWorkflowSnapshotTransport({
    developmentToken: "linear-dev-token",
    fetch: fakeFetch(calls, { paginateComments: true, paginateRelations: true }),
  });
  const snapshot = await transport.readSnapshot({
    rootIssueId: "root-1",
    projectId: "project-1",
    git: { head: "b".repeat(40), branch: "symphony/runs/root-1" },
  });
  assert.equal(snapshot.comments.length, 12);
  assert.equal(new Set(snapshot.comments.map(({ id }) => id)).size, snapshot.comments.length);
  assert.ok(calls.some(({ variables }) => variables.relationsAfter === "relation-cursor-2"));
});

test("target transport rejects foreign, incomplete, or malformed GraphQL facts", async () => {
  const foreignProject = createTargetWorkflowSnapshotTransport({
    developmentToken: "linear-dev-token",
    fetch: fakeFetch([], { foreignProject: true }),
  });
  await assert.rejects(
    foreignProject.readSnapshot({
      rootIssueId: "root-1",
      projectId: "project-1",
      git: { head: "b".repeat(40), branch: "symphony/runs/root-1" },
    }),
    /target_transport_project_scope_invalid/u,
  );

  const malformed = createTargetWorkflowSnapshotTransport({
    developmentToken: "linear-dev-token",
    fetch: fakeFetch([], { malformed: true }),
  });
  await assert.rejects(
    malformed.readSnapshot({
      rootIssueId: "root-1",
      projectId: "project-1",
      git: { head: "b".repeat(40), branch: "symphony/runs/root-1" },
    }),
    /target_transport_response_invalid/u,
  );
});

function fakeFetch(calls, options = {}) {
  return async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ operation: body.operationName, variables: body.variables });
    if (options.malformed) return response({ data: { project: null } });
    if (body.operationName === "TargetWorkflowProjectIssues") {
      if (options.foreignProject) return response({ data: { project: { id: "project-2", issues: page([]) } } });
      const firstPage = [
        issue("root-1", "project-1", null, "In Review"),
        issue("cycle-1", "project-1", "root-1", "Succeeded"),
        issue("plan-1", "project-1", "cycle-1", "Done"),
      ];
      const secondPage = [
        issue("work-1", "project-1", "cycle-1", "Done"),
        issue("verify-1", "project-1", "cycle-1", "Done"),
      ];
      return response({ data: { project: {
        id: "project-1",
        issues: page(body.variables.after === "issue-cursor-1" ? secondPage : firstPage,
          body.variables.after === null ? "issue-cursor-1" : undefined),
      } } });
    }
    const issueId = body.variables.issueId;
    const result = issueDetails(issueId);
    if (options.paginateComments) {
      const nodes = result.comments.nodes;
      result.comments = body.variables.commentsAfter === "comment-cursor-1"
        ? page(nodes.slice(1))
        : page(nodes.slice(0, 1), "comment-cursor-1");
    }
    if (options.paginateRelations) {
      const nodes = result.inverseRelations.nodes;
      result.inverseRelations = body.variables.relationsAfter === "relation-cursor-1"
        ? page([], "relation-cursor-2")
        : body.variables.relationsAfter === "relation-cursor-2"
          ? page([])
          : page(nodes, "relation-cursor-1");
    }
    return response({ data: { issue: result } });
  };
}

function rootScopedFetch(calls) {
  return async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ operation: body.operationName, variables: body.variables });
    const variables = body.variables;
    const allIds = ["root-1", "cycle-1", "plan-1", "work-1", "verify-1"];
    const ids = variables.parentIds
      ? allIds.filter((id) => variables.parentIds.includes(issue(id, "project-1", parentOf(id), stateOf(id)).parent?.id))
      : variables.issueIds;
    const nodes = ids.filter((id) => allIds.includes(id)).map((id) => ({
      ...issue(id, "project-1", parentOf(id), stateOf(id)),
      ...issueDetails(id),
    }));
    return response({ data: { project: { id: "project-1", issues: page(nodes) } } });
  };
}

function parentOf(id) {
  return id === "root-1" ? null : id === "cycle-1" ? "root-1" : "cycle-1";
}

function stateOf(id) {
  return id === "root-1" ? "In Review" : id === "cycle-1" ? "Succeeded" : "Done";
}

function issue(id, projectId, parentId, state) {
  return { id, project: { id: projectId }, parent: parentId ? { id: parentId } : null, state: { name: state } };
}

function issueDetails(issueId) {
  const records = details()[issueId];
  return {
    id: issueId,
    project: { id: "project-1" },
    parent: issueId === "root-1" ? null : { id: issueId === "cycle-1" ? "root-1" : "cycle-1" },
    state: { name: issueId === "root-1" ? "In Review" : issueId === "cycle-1" ? "Succeeded" : "Done" },
    comments: page(records.comments),
    inverseRelations: page(records.relations),
  };
}

function details() {
  const revision = "b".repeat(40);
  const comment = (issueId, id, record) => ({ id, issue: { id: issueId }, body: marker(record) });
  const execution = (id, stage, node, digest, repositoryRevision) => ({
    kind: "stage_execution", version: 1, stage_execution_id: id,
    root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_issue_id: node, stage,
    ...(stage === "plan" ? {} : { plan_contract_digest: "d".repeat(64) }),
    context_digest: digest, source_manifest: [], coverage: { is_complete: true, omissions: [] },
    instruction_set_id: `${stage}-v1`, execution_policy_id: "policy-1",
    limits: { max_context_bytes: 1, max_result_bytes: 1, max_wall_time_ms: 1, max_tool_calls: 1,
      max_command_duration_ms: 1, reserved_total_tokens: 10, max_output_tokens: 1 },
    repository_revision: repositoryRevision, started_at: "2026-07-22T00:00:01Z",
    deadline_at: "2026-07-22T00:01:01Z",
  });
  const terminal = (id, stage, node, digest) => ({
    kind: "stage_terminal", version: 1, stage_execution_id: id,
    root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_issue_id: node, stage,
    context_digest: digest, outcome: "completed", completed_at: "2026-07-22T00:00:02Z",
    summary: "Completed.", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1,
      reasoning_output_tokens: 0, total_tokens: 2 },
  });
  return {
    "root-1": { comments: [
      comment("root-1", "approval", { kind: "human_action", version: 1, action_id: "approval-1",
        root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_issue_id: "plan-1", request_kind: "needs_approval",
        question_or_proposal: "Approve.", reason: "Review.", impact: "Proceed.", context_digest: "a".repeat(64),
        expected_root_remote_version: "root-version" }),
      comment("root-1", "delivery", { kind: "delivery", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1",
        verify_result_id: "verify-execution-1", verified_revision: revision, delivery_kind: "local_branch",
        delivery_branch: "symphony/runs/root-1", delivered_at: "2026-07-22T00:00:04Z" }),
    ], relations: [] },
    "cycle-1": { comments: [comment("cycle-1", "cycle-marker", { kind: "cycle_marker", version: 1,
      root_issue_id: "root-1", cycle_key: "cycle-1", trigger: "initial", baseline_revision: "a".repeat(40) })], relations: [] },
    "plan-1": { comments: [
      comment("plan-1", "plan-marker", { kind: "node_marker", version: 1, root_issue_id: "root-1",
        cycle_issue_id: "cycle-1", node_key: "plan-1", node_kind: "plan", plan_contract_digest: "d".repeat(64) }),
      comment("plan-1", "plan-contract", { kind: "plan_contract", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1",
        plan_contract_digest: "d".repeat(64), objective_summary: "Build it.", included_scope: ["apps"], excluded_scope: [],
        acceptance_criteria: [], work_nodes: [{ work_key: "work-key-1", title: "Work", description: "Work.",
          acceptance_criteria: [], dependency_work_keys: [] }], verify_node: { title: "Verify", acceptance_criteria: [], required_checks: [] } }),
      comment("plan-1", "plan-execution", execution("plan-execution-1", "plan", "plan-1", "a".repeat(64), "a".repeat(40))),
      comment("plan-1", "plan-terminal", terminal("plan-execution-1", "plan", "plan-1", "a".repeat(64))),
    ], relations: [] },
    "work-1": { comments: [
      comment("work-1", "work-marker", { kind: "node_marker", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1",
        node_key: "work-key-1", node_kind: "work", plan_contract_digest: "d".repeat(64) }),
      comment("work-1", "work-execution", execution("work-execution-1", "work", "work-1", "b".repeat(64), revision)),
      comment("work-1", "work-terminal", terminal("work-execution-1", "work", "work-1", "b".repeat(64))),
      comment("work-1", "work-completion", { kind: "work_completion", version: 1, stage_execution_id: "work-execution-1",
        root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_issue_id: "work-1", work_key: "work-key-1",
        context_digest: "b".repeat(64), summary: "Done.", changed_paths: ["apps/example.ts"], checks: [], commit_revision: revision }),
    ], relations: [relation("r1", "blocks", "plan-1", "work-1")] },
    "verify-1": { comments: [
      comment("verify-1", "verify-marker", { kind: "node_marker", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1",
        node_key: "verify-1", node_kind: "verify", plan_contract_digest: "d".repeat(64) }),
      comment("verify-1", "verify-execution", execution("verify-execution-1", "verify", "verify-1", "c".repeat(64), revision)),
      comment("verify-1", "verify-terminal", terminal("verify-execution-1", "verify", "verify-1", "c".repeat(64))),
      comment("verify-1", "verify-result", { kind: "verify_result", version: 1, stage_execution_id: "verify-execution-1",
        root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_issue_id: "verify-1", conclusion: "passed",
        criteria_results: [], checks: [], verified_revision: revision }),
    ], relations: [relation("r2", "blocks", "work-1", "verify-1")] },
  };
}

function relation(id, type, issueId, relatedIssueId) {
  return { id, type, issue: { id: issueId, project: { id: "project-1" } }, relatedIssue: { id: relatedIssueId, project: { id: "project-1" } } };
}

function marker(record) {
  return `<!-- symphony managed-record\n${JSON.stringify(record)}\n-->`;
}

function page(nodes, endCursor) {
  return { nodes, pageInfo: { hasNextPage: endCursor !== undefined, endCursor: endCursor ?? null } };
}

function response(body) {
  return { ok: true, status: 200, async json() { return body; } };
}
