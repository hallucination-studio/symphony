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
import { renderWorkflowIssueDescription } from "../../root-reconciliation/api/WorkflowIssueRecords.js";
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
    description: workflowDescription("cycle-1", "root-1", "cycle", "Execute the plan."),
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

test("cancel_root cancels a terminal active Cycle before canceling the Root", async () => {
  const linear = new FakeLinear();
  linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!.status_id = "cycle-succeeded";
  linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!.status_name = "Succeeded";
  linear.tree.issues.find(({ issue_id }) => issue_id === "cycle-1")!.status_category = "completed";
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);

  const result = await materializer.materialize({
    directive: directive({
      kind: "cancel_root",
      reason: "User canceled the Root.",
      activeCycleIssueId: "cycle-1",
      invalidatedExecutionIds: [],
      preservedFactRefs: [],
    }),
    view: view(linear.tree),
  });

  assert.equal(result.kind, "materialized");
  assert.deepEqual(linear.mutations.map((mutation) => mutation.kind === "update_workflow_issue" ? mutation.statusId : mutation.kind), [
    "canceled",
    "canceled",
  ]);
  assert.equal(linear.issue("cycle-1").status_name, "Canceled");
  assert.equal(linear.issue("root-1").status_name, "Canceled");
});

test("reads a fresh tree after every Tree patch and supports reorder, dependency, and relates_to operations", async () => {
  const linear = new FakeLinear();
  linear.tree.issues.push({
    issue_id: "work-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1",
    status_id: "cycle-executing", status_name: "Executing", status_category: "started", status_position: 2,
    order: 2, depth: 2, title: "Work", description: workflowDescription("work-1", "cycle-1", "work", "Do work"), labels: ["Work"], is_archived: false,
    issue_kind: "work", workflow_issue_key: "work-1", remote_version: "work-v1", updated_at: "2026-07-23T00:00:00Z",
  });
  linear.tree.issues.push({
    issue_id: "work-2", identifier: "SYM-4", project_id: "project-1", parent_issue_id: "cycle-1",
    status_id: "cycle-executing", status_name: "Executing", status_category: "started", status_position: 2,
    order: 3, depth: 2, title: "Dependency", description: workflowDescription("work-2", "cycle-1", "work", "Dependency"), labels: ["Work"], is_archived: false,
    issue_kind: "work", workflow_issue_key: "work-2", remote_version: "work-2-v1", updated_at: "2026-07-23T00:00:00Z",
  });
  linear.tree.relations.push({
    relation_id: "dependency-1", relation_kind: "blocks", source_issue_id: "work-2", target_issue_id: "work-1",
  });
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);
  const result = await materializer.materialize({
    directive: directive({
      kind: "revise_root_tree",
      reason: "The execution order and dependency graph need correction.",
      operations: [
        {
          kind: "update_node",
          precondition: { targetIssueId: "cycle-1", expectedRemoteVersion: "cycle-v1" },
          title: "Cycle updated",
          description: "Execute the plan.",
          status: "Executing",
        },
        {
          kind: "reorder_nodes",
          cycleIssueId: "cycle-1",
          orderedIssueIds: ["work-1", "work-2"],
          precondition: { targetIssueId: "cycle-1", expectedRemoteVersion: "cycle-v1:updated" },
        },
        {
          kind: "replace_dependencies",
          workIssueId: "work-1",
          dependencyIssueIds: [],
          precondition: { targetIssueId: "work-1", expectedRemoteVersion: "work-v1" },
        },
        {
          kind: "create_relation",
          relationKind: "relates_to",
          sourceIssueId: "cycle-1",
          targetIssueId: "work-1",
        },
      ],
    }),
    view: view(linear.tree),
  });

  assert.equal(result.kind, "materialized");
  assert.equal(linear.readCount, 5);
  assert.deepEqual(linear.mutations.map((mutation) => mutation.kind), [
    "update_workflow_issue",
    "update_workflow_issue",
    "update_workflow_issue",
    "remove_workflow_relation",
    "create_workflow_relation",
  ]);
  assert.equal(linear.tree.relations.length, 1);
  assert.equal(linear.tree.relations[0]?.relation_kind, "relates_to");
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
        order: 1, depth: 1, title: "Cycle", description: workflowDescription("cycle-1", "root-1", "cycle", "Execute the plan."), labels: ["Cycle"], is_archived: false,
        issue_kind: "cycle", workflow_issue_key: "cycle-1", remote_version: "cycle-v1", updated_at: "2026-07-23T00:00:00Z",
      },
    ],
    comments: [],
    relations: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-23T00:00:02Z",
  };
  mutations: LinearWorkflowMutationCommand[] = [];
  readCount = 0;

  issue(issueId: string) {
    const issue = this.tree.issues.find((candidate) => candidate.issue_id === issueId);
    if (!issue) throw new Error(`missing:${issueId}`);
    return issue;
  }

  async readWorkflowIssueTree() {
    this.readCount += 1;
    return structuredClone(this.tree);
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind === "update_workflow_issue") {
      const target = this.issue(command.target.targetIssueId);
      const status = this.tree.status_catalog.find((candidate) => candidate.status_id === command.statusId);
      if (!status) throw new Error("missing_status");
      target.status_id = status.status_id;
      target.status_name = status.name;
      target.status_category = status.category;
      target.status_position = status.position;
      target.title = command.title;
      target.description = command.description;
      if (command.order !== undefined) target.order = command.order;
      target.remote_version = `${target.remote_version}:updated`;
    } else if (command.kind === "create_workflow_relation") {
      this.tree.relations.push({
        relation_id: command.writeId,
        relation_kind: command.relationKind,
        source_issue_id: command.sourceIssueId,
        target_issue_id: command.targetIssueId,
      });
      this.issue(command.sourceIssueId).remote_version += ":updated";
      this.issue(command.targetIssueId).remote_version += ":updated";
    } else if (command.kind === "remove_workflow_relation") {
      this.tree.relations = this.tree.relations.filter(({ relation_id }) => relation_id !== command.relationId);
      this.issue(command.sourceIssueId).remote_version += ":updated";
      this.issue(command.targetIssueId).remote_version += ":updated";
    } else {
      throw new Error("unexpected_mutation");
    }
    this.tree.issues[0]!.remote_version = `${this.tree.issues[0]!.remote_version}:updated`;
    return {
      kind: "applied" as const,
      readBack: {
        writeId: command.writeId,
        targetIssueId: command.kind === "update_workflow_issue" ? command.target.targetIssueId : command.sourceIssueId,
        remoteVersion: this.issue(command.kind === "update_workflow_issue" ? command.target.targetIssueId : command.sourceIssueId).remote_version,
      },
    };
  }
}

function workflowDescription(
  issueKey: string,
  parentIssueId: string,
  issueKind: "cycle" | "plan" | "work" | "verify" | "human",
  markdown: string,
): string {
  return renderWorkflowIssueDescription({
    issueKey,
    rootIssueId: "root-1",
    parentIssueId,
    issueKind,
    markdown,
  });
}
