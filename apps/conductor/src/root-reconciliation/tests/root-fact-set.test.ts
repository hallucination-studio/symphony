import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { serializeManagedRecord } from "../api/index.js";
import { buildRootFactSet, diffRootFactSets } from "../internal/RootFactSet.js";

const root = {
  issueId: "root-1", identifier: "SYM-1", state: "In Progress" as const, title: "Root",
  description: "Build it", updatedAt: "2026-07-23T00:00:00Z", projectId: "project-1",
  parentIssueId: null, isDelegatedToSymphony: true, priority: "normal" as const, order: 0,
  blockers: [], rootConductorLabels: [],
};

test("fact sets send a bootstrap snapshot and only changed current values afterward", () => {
  const first = buildRootFactSet({ root, tree: tree("Root", "root-v1", "comment-v1"), git: git("head-1"), mechanicalViolations: [] });
  const second = buildRootFactSet({ root, tree: tree("Changed", "root-v2", "comment-v1"), git: git("head-1"), mechanicalViolations: [] });
  const delta = diffRootFactSets(first, second);

  assert.equal(first.bootstrap.rootSnapshot.issues.length, 1);
  assert.equal(first.bootstrap.rootDigest, delta.baseRootDigest);
  assert.equal(delta.targetRootDigest, second.bootstrap.rootDigest);
  assert.deepEqual(delta.changes.map((change) => change.kind), ["issue_current_value"]);
  assert.equal("rootSnapshot" in delta, false);
  assert.equal(delta.changes[0]?.kind, "issue_current_value");
  if (delta.changes[0]?.kind === "issue_current_value") assert.equal(delta.changes[0].issue.title, "Changed");
});

test("removed source facts become tombstones", () => {
  const first = buildRootFactSet({ root, tree: tree("Root", "root-v1", "comment-v1", true), git: git("head-1"), mechanicalViolations: [] });
  const second = buildRootFactSet({ root, tree: tree("Root", "root-v1", undefined, false), git: git("head-1"), mechanicalViolations: [] });
  const delta = diffRootFactSets(first, second);
  assert.ok(delta.changes.some((change) => change.kind === "comment_removed"));
});

test("a completed Plan enters the next delta as its full Result and canonical Contract", () => {
  const before = planTree(false);
  const after = planTree(true);
  const first = buildRootFactSet({ root, tree: before, git: git("head-1"), mechanicalViolations: [] });
  const second = buildRootFactSet({ root, tree: after, git: git("head-1"), mechanicalViolations: [] });
  const delta = diffRootFactSets(first, second);

  const cycle = second.bootstrap.rootSnapshot.cycles[0];
  assert.equal(cycle?.activePlanContract?.planContractDigest, "a".repeat(64));
  assert.equal(cycle?.planCompletedResults[0]?.resultId, "plan-result-1");
  assert.ok(delta.changes.some(({ kind }) => kind === "plan_contract_current_value"));
  assert.ok(delta.changes.some(({ kind }) => kind === "plan_completed_result_current_value"));
  const contract = delta.changes.find((change) => change.kind === "plan_contract_current_value");
  assert.equal(contract?.kind, "plan_contract_current_value");
  if (contract?.kind === "plan_contract_current_value") {
    assert.equal(contract.planIssueId, "plan-1");
    assert.equal(contract.planContract.objective, "Deliver the deployment workflow.");
  }
});

function git(head: string) {
  return { head, branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } };
}

function tree(title: string, rootVersion: string, commentVersion?: string, includeComment = true): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: "root-1",
    status_catalog: [{ status_id: "progress", name: "In Progress", category: "started", position: 1 }],
    issues: [{
      issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "progress",
      status_name: "In Progress", status_category: "started", status_position: 1, order: 0, depth: 0,
      title, description: "Build it", labels: [], is_archived: false, issue_kind: "root",
      remote_version: rootVersion, updated_at: "2026-07-23T00:00:00Z",
    }],
    comments: includeComment && commentVersion ? [{
      comment_id: "comment-1", issue_id: "root-1", body: "User input", author_kind: "human", author_id: "user-1",
      author_user_id: "user-1", created_at: "2026-07-23T00:00:01Z", remote_version: commentVersion,
      updated_at: "2026-07-23T00:00:01Z",
    }] : [],
    relations: [], source_manifest: [], coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-23T00:00:02Z",
  };
}

function planTree(completed: boolean): LinearWorkflowTreeSnapshot {
  const workflow = tree("Root", "root-v1");
  workflow.status_catalog.push(
    { status_id: "planning", name: "Planning", category: "started", position: 2 },
    { status_id: "review", name: "In Review", category: "started", position: 3 },
  );
  workflow.issues.push(
    {
      issue_id: "cycle-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1",
      status_id: "planning", status_name: "Planning", status_category: "started", status_position: 2, order: 1, depth: 1,
      title: "Cycle", description: "Cycle", labels: [], is_archived: false, issue_kind: "cycle", remote_version: "cycle-v1",
      updated_at: "2026-07-23T00:00:00Z",
    },
    {
      issue_id: "plan-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1",
      status_id: completed ? "review" : "planning", status_name: completed ? "In Review" : "Planning",
      status_category: "started", status_position: 3, order: 2, depth: 2, title: "Plan", description: "Plan", labels: [],
      is_archived: false, issue_kind: "plan", remote_version: completed ? "plan-v2" : "plan-v1", updated_at: "2026-07-23T00:00:00Z",
    },
  );
  if (completed) {
    workflow.comments = [
      managedComment("plan-1", serializeManagedRecord({
        kind: "plan_contract" as const, version: 1 as const, rootIssueId: "root-1", cycleIssueId: "cycle-1",
        planContractDigest: "a".repeat(64), objective: "Deliver the deployment workflow.", includedScope: ["deployment service"],
        excludedScope: [], assumptions: [], constraints: [],
        acceptanceCriteria: [{ criterionKey: "deploy", statement: "Deployments complete safely.", verificationMethod: "integration test" }],
        verificationRequirements: ["npm test -w @symphony/conductor"],
        proposedWorkDag: {
          workNodes: [{ proposalKey: "work-1", title: "Implement deployment", description: "Implement it.", expectedOutcome: "Done.", requiredChecks: ["test"], dependencyProposalKeys: [] }],
          dependencyEdges: [],
          verifyNode: { title: "Verify deployment", acceptanceCriteria: [{ criterionKey: "verify", statement: "It works.", verificationMethod: "integration test" }], requiredChecks: ["test"] },
        },
      })),
      managedComment("plan-1", serializeManagedRecord({
        kind: "stage_result" as const, version: 1 as const, resultId: "plan-result-1", rootIssueId: "root-1", cycleIssueId: "cycle-1",
        nodeIssueId: "plan-1", stage: "plan" as const, roleSessionId: "session-1", roleTurnId: "turn-1", observedTreeDigest: "tree-1",
        contextDigest: "context-1", outcomeKind: "plan_completed" as const, summary: "Plan ready for review.", sourceManifest: ["input-1"],
        completedAt: "2026-07-23T00:00:00Z", planContractDigest: "a".repeat(64),
        planContract: { objective: "Deliver the deployment workflow.", includedScope: ["deployment service"], excludedScope: [], assumptions: [], constraints: [], acceptanceCriteria: [{ criterionKey: "deploy", statement: "Deployments complete safely.", verificationMethod: "integration test" }], verificationRequirements: ["npm test -w @symphony/conductor"] },
        proposedWorkDag: {
          workNodes: [{ proposalKey: "work-1", title: "Implement deployment", description: "Implement it.", expectedOutcome: "Done.", requiredChecks: ["test"], dependencyProposalKeys: [] }],
          dependencyEdges: [],
          verifyNode: { title: "Verify deployment", acceptanceCriteria: [{ criterionKey: "verify", statement: "It works.", verificationMethod: "integration test" }], requiredChecks: ["test"] },
        },
        risks: ["A failed deployment delays release."], requiredPermissions: ["Deploy staging."], evidenceRefs: [{ referenceId: "evidence-1", sourceKind: "linear_record" as const }],
      })),
    ];
  }
  return workflow;
}

function managedComment(issueId: string, body: string) {
  return {
    comment_id: `comment-${body.length}-${issueId}`, issue_id: issueId, body, author_kind: "symphony" as const, author_id: "symphony",
    created_at: "2026-07-23T00:00:00Z", managed_marker: "managed", remote_version: `version-${body.length}`, updated_at: "2026-07-23T00:00:00Z",
  };
}
