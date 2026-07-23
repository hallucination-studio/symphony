import assert from "node:assert/strict";
import test from "node:test";

import { LinearCycleRootWorkflowPolicyImpl } from "../internal/LinearCycleRootWorkflowPolicyImpl.js";
import { buildRootDagView } from "../../linear-dag/internal/RootDagViewBuilder.js";
import { serializeManagedRecord } from "../api/index.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";

const policy = new LinearCycleRootWorkflowPolicyImpl();

test("dispatches one Bootstrap Plan target from a planning Cycle", () => {
  const view = buildRootDagView(input("Planning", "Todo"));
  assert.deepEqual(policy.assess(view), { rootIssueId: "root-1", readiness: "runnable" });
});

test("dispatches one dependency-ready Work before Verify", () => {
  const view = buildRootDagView(input("Executing", "Done", "Todo", "Todo", true));
  assert.deepEqual(policy.assess(view), { rootIssueId: "root-1", readiness: "runnable" });
});

test("dispatches Verify only after every Work dependency is complete", () => {
  const view = buildRootDagView(input("Verifying", "Done", "Done", "Todo", true));
  assert.deepEqual(policy.assess(view), { rootIssueId: "root-1", readiness: "runnable" });
});

test("returns waiting_human and terminal assessments from Root facts", () => {
  const waiting = buildRootDagView(input("Planning", "In Review", undefined, undefined, false, "Needs Approval"));
  assert.deepEqual(policy.assess(waiting), { rootIssueId: "root-1", readiness: "waiting_human" });

  const terminal = buildRootDagView(input("Succeeded", "Done", undefined, "Done", false, "Done"));
  assert.deepEqual(policy.assess(terminal), { rootIssueId: "root-1", readiness: "terminal" });
});

test("stops Stage dispatch after a successful Cycle while delivery remains pending", () => {
  const deliveryReady = buildRootDagView(input("Succeeded", "Done", undefined, "Done", false, "Done"));
  const inProgress = deliveryReady.statusCatalog.find(({ name }) => name === "In Progress")!;
  deliveryReady.root.issue = {
    ...deliveryReady.root.issue,
    status_id: inProgress.status_id,
    status_name: inProgress.name,
    status_category: inProgress.category,
    status_position: inProgress.position,
  };
  assert.deepEqual(policy.assess(deliveryReady), { rootIssueId: "root-1", readiness: "terminal" });
});

test("stops dispatch when the Root cycle convergence limit is reached", () => {
  const view = buildRootDagView(input("Succeeded", "Done", undefined, "Done", false, "In Progress"));
  const historicalCycle = (cycleId: string, order: number) => ({
    ...view.cycles[0]!,
    issue: { ...view.cycles[0]!.issue, issue_id: cycleId, order },
    records: [],
    nodes: view.cycles[0]!.nodes.map((node) => ({ ...node, records: [] })),
  });
  view.cycles = [
    historicalCycle("cycle-1", 1),
    historicalCycle("cycle-2", 2),
    historicalCycle("cycle-3", 3),
  ];

  assert.deepEqual(policy.assess(view), { rootIssueId: "root-1", readiness: "needs_attention", sanitizedReason: "convergence_max_cycles_per_root" });
});

function input(cycleStatus: string, planStatus: string, workStatus?: string, verifyStatus?: string, dependencies = false, rootStatus = "In Progress") {
  const statuses = catalog();
  const status = (name: string) => statuses.find((candidate) => candidate.name === name)!;
  const node = (issueId: string, kind: "plan" | "work" | "verify", statusName: string, order: number) => {
    const value = status(statusName);
    return {
      issue_id: issueId, identifier: issueId, project_id: "project-1", parent_issue_id: "cycle-1",
      status_id: value.status_id, status_name: value.name, status_category: value.category, status_position: value.position,
      order, depth: 2, title: issueId, description: issueId, managed_marker: `root-1:${kind}:${issueId}`,
      issue_kind: kind, remote_version: `${issueId}-version`, updated_at: "2026-07-21T00:00:00Z",
    } as LinearWorkflowTreeSnapshot["issues"][number];
  };
  const rootValue = status(rootStatus);
  const cycleValue = status(cycleStatus);
  const issues: LinearWorkflowTreeSnapshot["issues"] = [
    { issue_id: "root-1", identifier: "ROOT-1", project_id: "project-1", status_id: rootValue.status_id, status_name: rootValue.name, status_category: rootValue.category, status_position: rootValue.position, order: 0, depth: 0, title: "Root", description: "Root", issue_kind: "root", remote_version: "root-version", updated_at: "2026-07-21T00:00:00Z" },
    { issue_id: "cycle-1", identifier: "CYCLE-1", project_id: "project-1", parent_issue_id: "root-1", status_id: cycleValue.status_id, status_name: cycleValue.name, status_category: cycleValue.category, status_position: cycleValue.position, order: 1, depth: 1, title: "Cycle", description: "Cycle", managed_marker: "root-1:cycle:cycle-1", issue_kind: "cycle", remote_version: "cycle-version", updated_at: "2026-07-21T00:00:00Z" },
    node("plan-1", "plan", planStatus, 1),
  ];
  const comments = [
    record("root-1", "root-record", "root-1:ownership", { kind: "root_ownership", version: 1, rootIssueId: "root-1", conductorId: "conductor-1", performerProfileId: "profile-1", deliveryBranch: "symphony/root-1", ownerGeneration: "generation-1" }),
    record("cycle-1", "cycle-record", "root-1:cycle:record", { kind: "cycle_marker", version: 1, rootIssueId: "root-1", cycleKey: "cycle-1", trigger: "initial", baselineRevision: "head-1" }),
    record("plan-1", "plan-record", "root-1:plan:record", { kind: "node_marker", version: 1, rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeKey: "plan-1", nodeKind: "plan", planContractDigest: "digest-1" }),
  ];
  if (workStatus || cycleStatus === "Succeeded") {
    comments.push(record("plan-1", "contract-record", "root-1:plan:contract", {
      kind: "plan_contract", version: 1, rootIssueId: "root-1", cycleIssueId: "cycle-1", planContractDigest: "digest-1",
      objectiveSummary: "Deliver the cycle.", includedScope: ["apps/conductor"], excludedScope: [],
      acceptanceCriteria: [{ criterionKey: "criterion-1", statement: "The cycle is complete.", verificationMethod: "focused tests" }],
      workNodes: workStatus ? [{ workKey: "work-1", title: "Work", description: "Work", acceptanceCriteria: [{ criterionKey: "work-criterion", statement: "Work completes.", verificationMethod: "test" }], dependencyWorkKeys: [] }] : [],
      verifyNode: { title: "Verify", acceptanceCriteria: [{ criterionKey: "verify-criterion", statement: "Verify completes.", verificationMethod: "test" }], requiredChecks: [] },
    }));
  }
  const relations: LinearWorkflowTreeSnapshot["relations"] = [];
  if (workStatus) {
    issues.push(node("work-1", "work", workStatus, 2));
    comments.push(record("work-1", "work-record", "root-1:work:record", { kind: "node_marker", version: 1, rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeKey: "work-1", nodeKind: "work", planContractDigest: "digest-1" }));
    if (workStatus === "Done") comments.push(record("work-1", "work-completion", "root-1:work:completion", { kind: "work_completion", version: 1, stageExecutionId: "work-execution-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "work-1", workKey: "work-1", contextDigest: "digest-1", summary: "complete", changedPaths: ["apps/conductor/src/work.ts"], checks: [], commitRevision: "commit-1" }));
  }
  if (verifyStatus) {
    issues.push(node("verify-1", "verify", verifyStatus, 3));
    comments.push(record("verify-1", "verify-record", "root-1:verify:record", { kind: "node_marker", version: 1, rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeKey: "verify-1", nodeKind: "verify", planContractDigest: "digest-1" }));
  }
  if (dependencies) {
    relations.push({ relation_id: "plan-work", relation_kind: "blocks", source_issue_id: "plan-1", target_issue_id: "work-1" });
    relations.push({ relation_id: "work-verify", relation_kind: "blocks", source_issue_id: "work-1", target_issue_id: "verify-1" });
  }
  if (rootStatus === "Needs Approval") {
    comments.push(record("root-1", "human-record", "root-1:human-action", { kind: "human_action", version: 1, actionId: "action-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "plan-1", requestKind: "needs_approval", questionOrProposal: "Approve", reason: "Review", impact: "Proceed", contextDigest: "digest-1", expectedRootRemoteVersion: "root-version" }));
  }
  if (cycleStatus === "Succeeded") {
    comments.push(record("verify-1", "execution", "root-1:verify-execution", { kind: "stage_execution", version: 1, stageExecutionId: "execution-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "verify-1", stage: "verify", planContractDigest: "digest-1", contextDigest: "digest-1", sourceManifest: [], coverage: { isComplete: true, omissions: [] }, instructionSetId: "verify-v1", executionPolicyId: "policy-1", limits: { maxContextBytes: 1, maxResultBytes: 1, maxWallTimeMs: 1, maxToolCalls: 1, maxCommandDurationMs: 1, reservedTotalTokens: 10, maxOutputTokens: 1 }, repositoryRevision: "commit-1", startedAt: "2026-07-21T00:00:00Z", deadlineAt: "2026-07-21T01:00:00Z" }));
    comments.push(record("verify-1", "result", "root-1:verify-result", { kind: "stage_terminal", version: 1, stageExecutionId: "execution-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "verify-1", stage: "verify", contextDigest: "digest-1", outcome: "completed", completedAt: "2026-07-21T00:00:00Z", summary: "passed", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 } }));
    comments.push(record("verify-1", "verify-result", "root-1:verify-result-record", { kind: "verify_result", version: 1, stageExecutionId: "execution-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "verify-1", conclusion: "passed", criteriaResults: [{ criterionKey: "verify-criterion", outcome: "passed", summary: "passed" }], checks: [], verifiedRevision: "commit-1" }));
  }
  return { tree: { root_issue_id: "root-1", status_catalog: statuses, issues, comments, relations, observed_at: "2026-07-21T00:00:00Z" }, git: { head: "head-1", branch: "symphony/root-1", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } }, workspace: { branch: "symphony/root-1", worktreePath: "/tmp/root-1", rootIssueId: "root-1" } };
}

function record(issueId: string, commentId: string, managedMarker: string, value: object) {
  return { comment_id: commentId, issue_id: issueId, body: serializeManagedRecord(value), managed_marker: managedMarker, remote_version: `${commentId}-version`, updated_at: "2026-07-21T00:00:00Z" };
}

function catalog(): LinearWorkflowTreeSnapshot["status_catalog"] {
  return ([
    ["Draft", "backlog"], ["Todo", "unstarted"], ["Planning", "started"], ["Sealed", "started"], ["Executing", "started"], ["Verifying", "started"], ["In Progress", "started"], ["In Review", "started"], ["Needs Approval", "started"], ["Needs Info", "started"], ["Inconclusive", "started"], ["Escalated", "started"], ["Succeeded", "completed"], ["Changes Required", "completed"], ["Done", "completed"], ["Canceled", "canceled"], ["Failed", "canceled"], ["Duplicate", "canceled"],
  ] as const).map(([name, category], position) => ({ status_id: `status-${name.toLowerCase().replaceAll(" ", "-")}`, name, category: category as LinearWorkflowTreeSnapshot["status_catalog"][number]["category"], position }));
}
