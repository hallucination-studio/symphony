import assert from "node:assert/strict";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootDirective,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { LinearRootDirectiveMaterializerImpl } from "../internal/LinearRootDirectiveMaterializerImpl.js";

test("materializes a successful Cycle conclusion as a terminal Linear status", async () => {
  const linear = new FakeLinear();
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);
  const result = await materializer.materialize({
    directive: directive({
      kind: "conclude_cycle",
      cycleIssueId: "cycle-1",
      conclusion: "succeeded",
      completedWorkIds: ["work-1"],
      unresolvedFindingIds: [],
      attemptedApproachRefs: [],
      verificationEvidenceRefs: [{ referenceId: "verify-result-1", sourceKind: "result" }],
    }),
    view: view(linear.tree),
  });

  assert.deepEqual(result, {
    kind: "materialized",
    rootDirectiveId: "directive-1",
    sourceIssueIds: ["cycle-1"],
  });
  assert.equal(linear.issue("cycle-1").status_name, "Succeeded");
  assert.equal(linear.mutations.length, 1);
  assert.deepEqual(linear.mutations[0], {
    kind: "update_workflow_issue",
    writeId: "directive-1:cycle-1",
    expectedProjectId: "project-1",
    rootIssueId: "root-1",
    expectedRootRemoteVersion: "root-v1",
    target: {
      targetIssueId: "cycle-1",
      expectedRemoteVersion: "cycle-v1",
      expectedStatusId: "cycle-executing",
    },
    statusId: "cycle-succeeded",
    title: "Cycle",
    description: "Execute the plan.",
  });
});

test("accepts wait and acknowledge directives without inventing a Linear status mutation", async () => {
  const actions: RootDirective["action"][] = [
    { kind: "wait", reasonCode: "runtime_condition", blockingFactRefs: [{ referenceId: "fact-1", sourceKind: "check" }] },
    { kind: "acknowledge", reason: "The comment does not change the current execution." },
  ];
  for (const action of actions) {
    const linear = new FakeLinear();
    const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);
    const result = await materializer.materialize({ directive: directive(action), view: view(linear.tree) });

    assert.deepEqual(result, {
      kind: "materialized",
      rootDirectiveId: "directive-1",
      sourceIssueIds: [],
    });
    assert.equal(linear.mutations.length, 0);
  }
});

function directive(action: RootDirective["action"]): RootDirective {
  return {
    protocolVersion: 1,
    requestId: "request-1",
    rootDirectiveId: "directive-1",
    reconcilerSessionId: "session-1",
    reconcilerTurnId: "turn-1",
    basedOnTargetRootDigest: "tree-v1",
    rationale: "The cycle has completed.",
    evidenceRefs: [],
    consumedInputIds: [],
    commentReplies: [],
    humanActionResolutions: [],
    action,
  };
}

function view(tree: LinearWorkflowTreeSnapshot): RootReconciliationView {
  return {
    root: {
      issueId: "root-1",
      identifier: "SYM-1",
      state: "In Progress",
      title: "Root",
      description: "Build it",
      updatedAt: "2026-07-23T00:00:00Z",
      projectId: "project-1",
      parentIssueId: null,
      isDelegatedToSymphony: true,
      priority: "normal",
      order: 0,
      blockers: [],
      rootConductorLabels: [{ conductorShortHash: "abc123" }],
    },
    tree,
    git: {
      head: "abc123",
      branch: "symphony/runs/sym-1",
      status: { items: [], returned: 0, cap: 16, has_more: false, partial: false },
    },
    observedAt: tree.observed_at,
    treeDigest: "tree-v1",
    complete: true,
  };
}

class FakeLinear {
  tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "root-progress", name: "In Progress", category: "started", position: 1 },
      { status_id: "cycle-executing", name: "Executing", category: "started", position: 2 },
      { status_id: "cycle-succeeded", name: "Succeeded", category: "completed", position: 3 },
      { status_id: "changes-required", name: "Changes Required", category: "completed", position: 4 },
      { status_id: "canceled", name: "Canceled", category: "canceled", position: 5 },
    ],
    issues: [
      {
        issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "root-progress",
        status_name: "In Progress", status_category: "started", status_position: 1, order: 0, depth: 0,
        title: "Root", description: "Build it", labels: [], is_archived: false, issue_kind: "root",
        remote_version: "root-v1", updated_at: "2026-07-23T00:00:00Z",
      },
      {
        issue_id: "cycle-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1",
        status_id: "cycle-executing", status_name: "Executing", status_category: "started", status_position: 2,
        order: 1, depth: 1, title: "Cycle", description: "Execute the plan.", labels: [], is_archived: false,
        issue_kind: "cycle", remote_version: "cycle-v1", updated_at: "2026-07-23T00:00:00Z",
      },
    ],
    comments: [],
    relations: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-23T00:00:02Z",
  };
  mutations: LinearWorkflowMutationCommand[] = [];

  issue(issueId: string) {
    const issue = this.tree.issues.find((candidate) => candidate.issue_id === issueId);
    if (!issue) throw new Error(`missing:${issueId}`);
    return issue;
  }

  async readWorkflowIssueTree() {
    return structuredClone(this.tree);
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind !== "update_workflow_issue") throw new Error("unexpected_mutation");
    const target = this.issue(command.target.targetIssueId);
    const status = this.tree.status_catalog.find((candidate) => candidate.status_id === command.statusId);
    if (!status) throw new Error("missing_status");
    target.status_id = status.status_id;
    target.status_name = status.name;
    target.status_category = status.category;
    target.status_position = status.position;
    target.remote_version = `${target.remote_version}:updated`;
    return {
      kind: "applied" as const,
      readBack: { writeId: command.writeId, targetIssueId: target.issue_id, remoteVersion: target.remote_version },
    };
  }
}
