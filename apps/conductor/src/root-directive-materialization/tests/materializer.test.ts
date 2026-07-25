import assert from "node:assert/strict";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-reconciliation/api/index.js";
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

test("replan_current_cycle records every superseded Plan Contract before restarting Plan", async () => {
  const linear = new FakeLinear();
  addPlanWithContract(linear);
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);
  const replan = directive(replanAction());

  const result = await materializer.materialize({ directive: replan, view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "materialized",
    rootDirectiveId: "directive-1",
    sourceIssueIds: ["cycle-1", "plan-1"],
  });
  const records = linear.tree.comments.flatMap((comment) => {
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === "plan_contract_supersession" ? [parsed.value] : [];
  });
  assert.deepEqual(records, [{
    kind: "plan_contract_supersession",
    version: 1,
    supersessionId: "13219e90d8c41aa8ff47c59225b7f04d8832868112c6d12919068868b9647a8c",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    supersededPlanContractDigest: "contract-old",
    sourceRootDirectiveId: "directive-1",
    freshPlanIssueId: "plan-1",
    supersededAt: "2026-07-23T00:00:00Z",
  }]);
  assert.deepEqual(linear.mutations.map((mutation) => mutation.kind), [
    "append_workflow_comment",
    "update_workflow_issue",
    "update_workflow_issue",
  ]);
  assert.equal(linear.issue("cycle-1").status_name, "Planning");
  assert.equal(linear.issue("plan-1").status_name, "In Progress");

  await materializer.materialize({ directive: replan, view: view(linear.tree) });
  assert.equal(
    linear.tree.comments.filter((comment) => parseManagedRecord(comment.body).ok && comment.body.includes("plan_contract_supersession")).length,
    1,
  );
});

test("replan_current_cycle rejects missing, foreign, and duplicate superseded Plan Contracts", async () => {
  const cases: Array<{
    name: string;
    arrange: (linear: FakeLinear) => void;
    code: string;
  }> = [
    {
      name: "missing",
      arrange: (linear) => addPlanWithContract(linear, { addContract: false }),
      code: "cycle_replan_superseded_contract_missing",
    },
    {
      name: "foreign",
      arrange: (linear) => addPlanWithContract(linear, { contractCycleIssueId: "cycle-foreign" }),
      code: "cycle_replan_superseded_contract_foreign",
    },
    {
      name: "foreign root",
      arrange: (linear) => addPlanWithContract(linear, { contractRootIssueId: "root-foreign" }),
      code: "cycle_replan_superseded_contract_foreign",
    },
    {
      name: "duplicate",
      arrange: (linear) => addPlanWithContract(linear, { duplicateContract: true }),
      code: "cycle_replan_superseded_contract_duplicate",
    },
  ];

  for (const scenario of cases) {
    const linear = new FakeLinear();
    scenario.arrange(linear);
    const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);

    const result = await materializer.materialize({ directive: directive(replanAction()), view: view(linear.tree) });

    assert.deepEqual(result, {
      kind: "failed",
      rootDirectiveId: "directive-1",
      code: scenario.code,
      sanitizedReason: scenario.code,
    }, scenario.name);
    assert.equal(linear.mutations.length, 0, scenario.name);
  }
});

test("replan_current_cycle rejects a conflicting durable supersession record", async () => {
  const linear = new FakeLinear();
  addPlanWithContract(linear);
  linear.tree.comments.push(managedComment("conflicting-supersession", "plan-1", serializeManagedRecord({
    kind: "plan_contract_supersession" as const,
    version: 1 as const,
    supersessionId: "13219e90d8c41aa8ff47c59225b7f04d8832868112c6d12919068868b9647a8c",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    supersededPlanContractDigest: "contract-old",
    sourceRootDirectiveId: "directive-1",
    freshPlanIssueId: "other-plan-1",
    supersededAt: "2026-07-23T00:00:00Z",
  })));
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);

  const result = await materializer.materialize({ directive: directive(replanAction()), view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "failed",
    rootDirectiveId: "directive-1",
    code: "cycle_replan_supersession_conflict",
    sanitizedReason: "cycle_replan_supersession_conflict",
  });
  assert.equal(linear.mutations.length, 0);
  assert.equal(linear.issue("cycle-1").status_name, "Executing");
  assert.equal(linear.issue("plan-1").status_name, "Done");
});

test("replan_current_cycle rejects an empty superseded Plan Contract chain", async () => {
  const linear = new FakeLinear();
  addPlanWithContract(linear);
  const action = replanAction();
  action.supersededPlanContractIds = [] as unknown as [string, ...string[]];
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);

  const result = await materializer.materialize({ directive: directive(action), view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "failed",
    rootDirectiveId: "directive-1",
    code: "cycle_replan_superseded_contract_required",
    sanitizedReason: "cycle_replan_superseded_contract_required",
  });
  assert.equal(linear.mutations.length, 0);
  assert.equal(linear.issue("cycle-1").status_name, "Executing");
  assert.equal(linear.issue("plan-1").status_name, "Done");
});

test("replan_current_cycle stops before changing statuses when supersession record write fails", async () => {
  const linear = new FakeLinear();
  addPlanWithContract(linear);
  linear.failNextMutation = true;
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);

  const result = await materializer.materialize({ directive: directive(replanAction()), view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "failed",
    rootDirectiveId: "directive-1",
    code: "cycle_replan_supersession_write_failed",
    sanitizedReason: "cycle_replan_supersession_write_failed",
  });
  assert.deepEqual(linear.mutations.map((mutation) => mutation.kind), ["append_workflow_comment"]);
  assert.equal(linear.issue("cycle-1").status_name, "Executing");
  assert.equal(linear.issue("plan-1").status_name, "Done");
});

test("replan_current_cycle stops before changing statuses when supersession record read-back fails", async () => {
  const linear = new FakeLinear();
  addPlanWithContract(linear);
  linear.omitAppendedCommentsFromReadBack = true;
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);

  const result = await materializer.materialize({ directive: directive(replanAction()), view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "failed",
    rootDirectiveId: "directive-1",
    code: "cycle_replan_supersession_read_back_missing",
    sanitizedReason: "cycle_replan_supersession_read_back_missing",
  });
  assert.deepEqual(linear.mutations.map((mutation) => mutation.kind), ["append_workflow_comment"]);
  assert.equal(linear.issue("cycle-1").status_name, "Executing");
  assert.equal(linear.issue("plan-1").status_name, "Done");
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
    modelTurn: rootModelTurn(),
    basedOnTargetRootDigest: "tree-v1",
    rationale: "The cycle has completed.",
    evidenceRefs: [],
    consumedInputIds: [],
    commentReplies: [],
    humanActionResolutions: [],
    action,
  };
}

function replanAction(): Extract<RootDirective["action"], { kind: "replan_current_cycle" }> {
  return {
    kind: "replan_current_cycle",
    cycleIssueId: "cycle-1",
    reason: "The approved Plan no longer meets the clarified requirement.",
    supersededPlanContractIds: ["contract-old"],
    invalidateExecutionIds: [],
    preserveEvidenceRefs: [],
    archiveOrRestoreOperations: [],
    planIssueId: "plan-1",
    freshPlanGoal: "Replan from the clarified requirement.",
  };
}

function rootModelTurn(): RootDirective["modelTurn"] {
  return {
    turnRecordId: "root-1:turn-1", role: "root_reconciler", rootIssueId: "root-1",
    reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", invocationState: "confirmed",
    model: "gpt", outcome: "directive_accepted", usage: { status: "unavailable", reason: "provider_omitted" },
    terminalAt: "2026-07-23T00:00:00Z",
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
      { status_id: "cycle-planning", name: "Planning", category: "started", position: 3 },
      { status_id: "plan-done", name: "Done", category: "completed", position: 4 },
      { status_id: "cycle-succeeded", name: "Succeeded", category: "completed", position: 5 },
      { status_id: "changes-required", name: "Changes Required", category: "completed", position: 6 },
      { status_id: "canceled", name: "Canceled", category: "canceled", position: 7 },
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
  omitAppendedCommentsFromReadBack = false;
  failNextMutation = false;

  issue(issueId: string) {
    const issue = this.tree.issues.find((candidate) => candidate.issue_id === issueId);
    if (!issue) throw new Error(`missing:${issueId}`);
    return issue;
  }

  async readWorkflowIssueTree() {
    this.readCount += 1;
    const snapshot = structuredClone(this.tree);
    if (this.omitAppendedCommentsFromReadBack) {
      snapshot.comments = snapshot.comments.filter((comment) => {
        const parsed = parseManagedRecord(comment.body);
        return !parsed.ok || parsed.value.kind !== "plan_contract_supersession";
      });
    }
    return snapshot;
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (this.failNextMutation) {
      this.failNextMutation = false;
      return { kind: "failed" as const, code: "linear_write_failed", summary: "failed" };
    }
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
    } else if (command.kind === "append_workflow_comment") {
      const target = this.issue(command.target.targetIssueId);
      this.tree.comments.push({
        comment_id: command.writeId,
        issue_id: target.issue_id,
        body: command.body,
        author_kind: "symphony",
        author_id: "symphony",
        thread_root_comment_id: command.writeId,
        thread_state: "unresolved",
        reactions: [],
        created_at: "2026-07-23T00:00:04Z",
        remote_version: `${command.writeId}:v1`,
        updated_at: "2026-07-23T00:00:04Z",
      });
      target.remote_version = `${target.remote_version}:updated`;
    } else {
      throw new Error("unexpected_mutation");
    }
    this.tree.issues[0]!.remote_version = `${this.tree.issues[0]!.remote_version}:updated`;
    const targetIssueId = command.kind === "update_workflow_issue" || command.kind === "append_workflow_comment"
      ? command.target.targetIssueId
      : command.sourceIssueId;
    return {
      kind: "applied" as const,
      readBack: {
        writeId: command.writeId,
        targetIssueId,
        remoteVersion: this.issue(targetIssueId).remote_version,
      },
    };
  }
}

function addPlanWithContract(
  linear: FakeLinear,
  options: {
    addContract?: boolean;
    contractRootIssueId?: string;
    contractCycleIssueId?: string;
    duplicateContract?: boolean;
  } = {},
): void {
  linear.tree.issues.push({
    issue_id: "plan-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1",
    status_id: "plan-done", status_name: "Done", status_category: "completed", status_position: 4,
    order: 1, depth: 2, title: "Plan", description: workflowDescription("plan-1", "cycle-1", "plan", "Original Plan."), labels: ["Plan"],
    is_archived: false, issue_kind: "plan", workflow_issue_key: "plan-1", remote_version: "plan-v1", updated_at: "2026-07-23T00:00:00Z",
  });
  if (options.addContract === false) return;
  const body = planContractRecord(options.contractRootIssueId ?? "root-1", options.contractCycleIssueId ?? "cycle-1");
  linear.tree.comments.push(managedComment("plan-contract-1", "plan-1", body));
  if (options.duplicateContract) linear.tree.comments.push(managedComment("plan-contract-2", "plan-1", body));
}

function planContractRecord(rootIssueId: string, cycleIssueId: string): string {
  return serializeManagedRecord({
    kind: "plan_contract" as const,
    version: 1 as const,
    rootIssueId,
    cycleIssueId,
    planContractDigest: "contract-old",
    objective: "Deliver the original requirement.",
    includedScope: ["original scope"],
    excludedScope: [],
    assumptions: [],
    constraints: [],
    acceptanceCriteria: [{ criterionKey: "original", statement: "Original scope is delivered.", verificationMethod: "test" }],
    verificationRequirements: ["npm test"],
    proposedWorkDag: {
      workNodes: [],
      dependencyEdges: [],
      verifyNode: {
        title: "Verify original requirement",
        acceptanceCriteria: [{ criterionKey: "original", statement: "Original scope is delivered.", verificationMethod: "test" }],
        requiredChecks: ["npm test"],
      },
    },
  });
}

function managedComment(commentId: string, issueId: string, body: string): LinearWorkflowTreeSnapshot["comments"][number] {
  return {
    comment_id: commentId,
    issue_id: issueId,
    body,
    author_kind: "symphony",
    author_id: "symphony",
    thread_root_comment_id: commentId,
    thread_state: "unresolved",
    reactions: [],
    created_at: "2026-07-23T00:00:00Z",
    remote_version: `${commentId}:v1`,
    updated_at: "2026-07-23T00:00:00Z",
  };
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
