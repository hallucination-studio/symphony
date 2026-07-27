import assert from "node:assert/strict";
import test from "node:test";

import type { GitWorkspaceProvisionerInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootDirective,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { LinearGitRootActionMaterializerImpl } from "../internal/LinearGitRootActionMaterializerImpl.js";

test("materializes a fresh Root workspace only from exact native and Git preconditions", async () => {
  const linear = new FakeLinear();
  const missingGate = {
    kind: "fresh_missing" as const,
    repositoryIdentity: "repository-1",
    baseBranch: "main",
    baseRevision: "base-1",
  };
  let materializations = 0;
  const git: GitWorkspaceProvisionerInterface = {
    async inspectRootWorktreeGate() { throw new Error("gate_inspection_unexpected"); },
    async readCommitUrl() { return "https://github.com/acme/repo/commit/base-1"; },
    async materializeRootWorkspace(input) {
      materializations += 1;
      assert.deepEqual(input, {
        repositoryIdentity: "repository-1",
        rootIssueId: "root-1",
        rootIdentifier: "SYM-1",
        baseBranch: "main",
        expectedGate: missingGate,
      });
      return {
        result: {
          kind: "valid", repositoryIdentity: "repository-1", branch: "symphony/runs/sym-1",
          headRevision: "base-1", isClean: true, changedPaths: [],
        },
        workspace: { branch: "symphony/runs/sym-1", worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
        snapshot: {
          head: "base-1", branch: "symphony/runs/sym-1",
          status: { items: [], returned: 0, cap: 512, has_more: false, partial: false },
        },
      };
    },
  };
  const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, git, "main", {} as never);
  const rootView = { ...view(linear.tree), worktreeGate: missingGate } as RootReconciliationView;

  const result = await materializer.materialize({
    directive: directive({
      kind: "create_root_workspace",
      rootIssueId: "root-1",
      expectedRootRemoteVersion: "root-v1",
      expectedWorktreeGate: missingGate,
    }),
    view: rootView,
  });

  assert.deepEqual(result, {
    kind: "materialized", rootDirectiveId: "directive-1", sourceIssueIds: ["root-1"],
  });
  assert.equal(materializations, 1);
  assert.equal(linear.mutations.length, 0);
});

test("rejects stale Root workspace action preconditions before Git mutation", async () => {
  const linear = new FakeLinear();
  const missingGate = {
    kind: "fresh_missing" as const,
    repositoryIdentity: "repository-1",
    baseBranch: "main",
    baseRevision: "base-1",
  };
  let materializations = 0;
  const git: GitWorkspaceProvisionerInterface = {
    async inspectRootWorktreeGate() { throw new Error("gate_inspection_unexpected"); },
    async readCommitUrl() { return "https://github.com/acme/repo/commit/base-1"; },
    async materializeRootWorkspace() {
      materializations += 1;
      throw new Error("workspace_materialization_unexpected");
    },
  };
  const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, git, "main", {} as never);
  const cases = [
    { rootIssueId: "root-other", expectedRootRemoteVersion: "root-v1", expectedWorktreeGate: missingGate, code: "root_workspace_root_mismatch" },
    { rootIssueId: "root-1", expectedRootRemoteVersion: "root-old", expectedWorktreeGate: missingGate, code: "root_workspace_root_version_stale" },
    { rootIssueId: "root-1", expectedRootRemoteVersion: "root-v1", expectedWorktreeGate: { ...missingGate, baseRevision: "base-old" }, code: "root_workspace_gate_stale" },
  ] as const;
  for (const scenario of cases) {
    const result = await materializer.materialize({
      directive: directive({ kind: "create_root_workspace", ...scenario }),
      view: { ...view(linear.tree), worktreeGate: missingGate } as RootReconciliationView,
    });
    assert.equal(result.kind, "failed");
    assert.equal(result.kind === "failed" && result.code, scenario.code);
  }
  assert.equal(materializations, 0);
});

test("conclude_root delegates to the delivery boundary and cannot set In Review directly", async () => {
  const linear = new FakeLinear();
  let deliveries = 0;
  const materializer = new LinearGitRootActionMaterializerImpl(
    linear,
    {} as never,
    {} as never,
    "main",
    {
      async deliver(input) {
        deliveries += 1;
        assert.equal(input.view.root.issueId, "root-1");
        return { kind: "pull_request" as const, url: "https://github.com/acme/repo/pull/7" };
      },
    },
  );

  const result = await materializer.materialize({
    directive: directive({ kind: "conclude_root", conclusion: "ready_for_delivery", evidenceRefs: [{ referenceId: "verify-1", sourceKind: "linear_issue" }] }),
    view: view(linear.tree),
  });

  assert.equal(result.kind, "materialized");
  assert.equal(deliveries, 1);
  assert.equal(linear.mutations.length, 0);
  assert.equal(linear.issue("root-1").status_name, "In Progress");
});

test("invalidates an unrecoverable execution generation through native Cycle status, label, and archive facts", async () => {
  const linear = new FakeLinear();
  addPlan(linear);
  for (const node of [
    { id: "work-1", kind: "work", label: "Work", depth: 2, parentId: "cycle-1" },
    { id: "verify-1", kind: "verify", label: "Verify", depth: 2, parentId: "cycle-1" },
    { id: "finding-1", kind: "finding", label: "Finding", depth: 3, parentId: "verify-1" },
  ] as const) {
    linear.tree.issues.push({
      issue_id: node.id, identifier: `SYM-${linear.tree.issues.length + 1}`, project_id: "project-1", parent_issue_id: node.parentId,
      status_id: "plan-done", status_name: "Done", status_category: "completed", status_position: 5,
      order: linear.tree.issues.length, depth: node.depth, title: node.label, description: `${node.label} evidence.`, labels: [node.label],
      is_archived: false, issue_kind: node.kind, remote_version: `${node.id}-v1`, created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
    });
  }
  const invalidGate = {
    kind: "execution_generation_invalid" as const,
    repositoryIdentity: "repository-1",
    expectedBranch: "symphony/runs/sym-1",
    reason: "branch_missing" as const,
  };
  const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, {} as never, "main", {} as never);

  const result = await materializer.materialize({
    directive: directive({
      kind: "invalidate_execution_generation",
      rootIssueId: "root-1",
      cycleIssueId: "cycle-1",
      expectedRootRemoteVersion: "root-v1",
      expectedWorktreeGate: invalidGate,
    }),
    view: { ...view(linear.tree), worktreeGate: invalidGate } as RootReconciliationView,
  });

  assert.equal(result.kind, "materialized");
  assert.equal(linear.issue("cycle-1").status_name, "Canceled");
  assert.ok(linear.issue("cycle-1").labels.includes("Execution Invalidated"));
  assert.deepEqual(
    ["cycle-1", "plan-1", "work-1", "verify-1", "finding-1"].map((issueId) => [issueId, linear.issue(issueId).is_archived]),
    ["cycle-1", "plan-1", "work-1", "verify-1", "finding-1"].map((issueId) => [issueId, true]),
  );
  assert.equal(linear.issue("root-1").is_archived, false);
  assert.equal(linear.tree.comments.length, 0);
  assert.equal(linear.readCount, linear.mutations.length);
});

test("rejects stale or foreign execution invalidation before native mutation", async () => {
  const invalidGate = {
    kind: "execution_generation_invalid" as const,
    repositoryIdentity: "repository-1",
    expectedBranch: "symphony/runs/sym-1",
    reason: "branch_missing" as const,
  };
  const scenarios = [
    { rootIssueId: "root-other", cycleIssueId: "cycle-1", expectedRootRemoteVersion: "root-v1", expectedWorktreeGate: invalidGate, code: "execution_generation_root_mismatch" },
    { rootIssueId: "root-1", cycleIssueId: "cycle-1", expectedRootRemoteVersion: "root-old", expectedWorktreeGate: invalidGate, code: "execution_generation_root_version_stale" },
    { rootIssueId: "root-1", cycleIssueId: "cycle-1", expectedRootRemoteVersion: "root-v1", expectedWorktreeGate: { ...invalidGate, reason: "required_commit_unreachable" as const }, code: "execution_generation_gate_stale" },
    { rootIssueId: "root-1", cycleIssueId: "root-1", expectedRootRemoteVersion: "root-v1", expectedWorktreeGate: invalidGate, code: "execution_generation_cycle_invalid" },
  ];
  for (const scenario of scenarios) {
    const linear = new FakeLinear();
    const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, {} as never, "main", {} as never);
    const result = await materializer.materialize({
      directive: directive({ kind: "invalidate_execution_generation", ...scenario }),
      view: { ...view(linear.tree), worktreeGate: invalidGate } as RootReconciliationView,
    });

    assert.equal(result.kind, "failed");
    assert.equal(result.kind === "failed" && result.code, scenario.code);
    assert.equal(linear.mutations.length, 0);
  }
});

test("terminalizes a Cycle through native status only", async () => {
  const linear = new FakeLinear();
  const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, {} as never, "main", {} as never);
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
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), ["update_workflow_issue"]);
  assert.equal(linear.tree.comments.length, 0);
});

test("creates one successor Cycle from terminal native predecessor topology", async () => {
  const linear = new FakeLinear();
  const predecessor = linear.issue("cycle-1");
  predecessor.status_id = "changes-required";
  predecessor.status_name = "Changes Required";
  predecessor.status_category = "completed";
  const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, {} as never, "main", {} as never);

  const result = await materializer.materialize({
    directive: directive({
      kind: "create_cycle",
      predecessorCycleIssueId: "cycle-1",
      reason: "exhausted",
      planTrigger: "Continue from durable predecessor facts.",
      inheritedFactRefs: [],
      invalidatedDeliveryRefs: [],
    }),
    view: view(linear.tree),
  });

  assert.deepEqual(result, {
    kind: "materialized",
    rootDirectiveId: "directive-1",
    sourceIssueIds: ["directive-1:cycle"],
  });
  const successor = linear.issue("directive-1:cycle");
  assert.equal(successor.parent_issue_id, "root-1");
  assert.equal(successor.status_name, "Planning");
  assert.equal(linear.mutations.filter(({ kind }) => kind === "create_workflow_issue").length, 1);
  assert.ok(linear.tree.relations.some((relation) =>
    relation.relation_kind === "relates_to" &&
    relation.source_issue_id === "cycle-1" &&
    relation.target_issue_id === successor.issue_id,
  ));
  assert.equal(linear.tree.comments.length, 0);
});

test("accepts wait and acknowledge directives without inventing a Linear status mutation", async () => {
  const actions: RootDirective["action"][] = [
    { kind: "wait", reasonCode: "runtime_condition", blockingFactRefs: [{ referenceId: "fact-1", sourceKind: "check" }] },
    { kind: "acknowledge", reason: "The comment does not change the current execution." },
  ];
  for (const action of actions) {
    const linear = new FakeLinear();
    const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, {} as never, "main", {} as never);
    const result = await materializer.materialize({ directive: directive(action), view: view(linear.tree) });

    assert.deepEqual(result, {
      kind: "materialized",
      rootDirectiveId: "directive-1",
      sourceIssueIds: [],
    });
    assert.equal(linear.mutations.length, 0);
  }
});

test("cancel_root cancels the active Cycle and Root through native statuses only", async () => {
  const linear = new FakeLinear();
  const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, {} as never, "main", {} as never);
  const cancellation = directive({
    kind: "cancel_root",
    reason: "User canceled the Root.",
    activeCycleIssueId: "cycle-1",
    invalidatedExecutionIds: [],
    preservedFactRefs: [],
  });

  const result = await materializer.materialize({
    directive: cancellation,
    view: view(linear.tree),
  });

  assert.equal(result.kind, "materialized");
  assert.deepEqual(
    linear.mutations.map((mutation) => mutation.kind === "update_workflow_issue" ? mutation.statusId : mutation.kind),
    ["canceled", "canceled"],
  );
  assert.equal(linear.issue("cycle-1").status_name, "Canceled");
  assert.equal(linear.issue("root-1").status_name, "Canceled");
  assert.equal(linear.tree.comments.length, 0);
});

test("cancel_root does not rewrite a Root the user already canceled", async () => {
  const linear = new FakeLinear();
  const root = linear.issue("root-1");
  root.status_id = "canceled";
  root.status_name = "Canceled";
  root.status_category = "canceled";
  const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, {} as never, "main", {} as never);

  const result = await materializer.materialize({
    directive: directive({
      kind: "cancel_root",
      reason: "User canceled the Root.",
      invalidatedExecutionIds: [],
      preservedFactRefs: [],
    }),
    view: view(linear.tree),
  });

  assert.deepEqual(result, {
    kind: "materialized",
    rootDirectiveId: "directive-1",
    sourceIssueIds: ["root-1"],
  });
  assert.equal(linear.mutations.length, 0);
});

test("supersede_cycle creates only its successor Cycle after terminalizing the current Cycle", async () => {
  const linear = new FakeLinear();
  const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, {} as never, "main", {} as never);
  const supersession = directive({
    kind: "supersede_cycle",
    currentCycleIssueId: "cycle-1",
    reason: "root_contract_changed",
    invalidatedExecutionIds: [],
    unresolvedFindingIds: [],
    preservedEvidenceRefs: [],
    successor: {
      create: true,
      planTrigger: "Plan against the changed Root contract.",
      inheritedFactRefs: [],
    },
  });

  const result = await materializer.materialize({ directive: supersession, view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "materialized",
    rootDirectiveId: "directive-1",
    sourceIssueIds: ["directive-1:cycle"],
  });
  assert.equal(linear.issue("cycle-1").status_name, "Changes Required");
  assert.equal(linear.issue("directive-1:cycle").status_name, "Planning");
  assert.equal(linear.mutations.filter(({ kind }) => kind === "create_workflow_issue").length, 1);
  assert.equal(linear.tree.comments.length, 0);
});

test("replan_current_cycle updates native Cycle and Plan facts without writing comments", async () => {
  const linear = new FakeLinear();
  addPlan(linear);
  const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, {} as never, "main", {} as never);
  const replan = directive(replanAction());

  const result = await materializer.materialize({ directive: replan, view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "materialized",
    rootDirectiveId: "directive-1",
    sourceIssueIds: ["cycle-1", "plan-1"],
  });
  assert.deepEqual(linear.mutations.map((mutation) => mutation.kind), [
    "update_workflow_issue",
    "update_workflow_issue",
  ]);
  assert.equal(linear.issue("cycle-1").status_name, "Planning");
  assert.equal(linear.issue("plan-1").status_name, "In Progress");
  assert.equal(linear.issue("plan-1").description, "Replan from the clarified requirement.");
  assert.equal(linear.tree.comments.length, 0);
});

test("reads a fresh tree after every Tree patch and supports reorder, dependency, and relates_to operations", async () => {
  const linear = new FakeLinear();
  linear.tree.issues.push({
    issue_id: "work-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1",
    status_id: "cycle-executing", status_name: "Executing", status_category: "started", status_position: 2,
    order: 2, depth: 2, title: "Work", description: workflowDescription("work-1", "cycle-1", "work", "Do work"), labels: ["symphony:kind/work"], is_archived: false,
    issue_kind: "work", remote_version: "work-v1", created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
  });
  linear.tree.issues.push({
    issue_id: "work-2", identifier: "SYM-4", project_id: "project-1", parent_issue_id: "cycle-1",
    status_id: "cycle-executing", status_name: "Executing", status_category: "started", status_position: 2,
    order: 3, depth: 2, title: "Dependency", description: workflowDescription("work-2", "cycle-1", "work", "Dependency"), labels: ["symphony:kind/work"], is_archived: false,
    issue_kind: "work", remote_version: "work-2-v1", created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
  });
  linear.tree.relations.push({
    relation_id: "dependency-1", relation_kind: "blocks", source_issue_id: "work-2", target_issue_id: "work-1",
  });
  const materializer = new LinearGitRootActionMaterializerImpl(linear, {} as never, {} as never, "main", {} as never);
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
    "create_workflow_relation",
    "create_workflow_relation",
  ]);
  assert.deepEqual(
    linear.mutations
      .filter((mutation) => mutation.kind === "create_workflow_relation")
      .map((mutation) => mutation.relationState),
    ["absent", "present"],
  );
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
    action,
  };
}

function replanAction(): Extract<RootDirective["action"], { kind: "replan_current_cycle" }> {
  return {
    kind: "replan_current_cycle",
    cycleIssueId: "cycle-1",
    reason: "The approved Plan no longer meets the clarified requirement.",
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
      updatedAt: "2026-07-23T00:00:00Z",
      projectId: "project-1",
      priority: "normal",
      blockers: [],
      rootConductorLabels: [{ conductorShortHash: "abc123" }],
      isDelegatedToSymphony: true, isArchived: false,
    },
    tree,
    worktreeGate: { kind: "valid", repositoryIdentity: "repository-1", branch: "symphony/runs/sym-1", headRevision: "abc123", isClean: true, changedPaths: [] },
    workspace: { branch: "symphony/runs/sym-1", worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
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
      { status_id: "todo", name: "Todo", category: "unstarted", position: 4 },
      { status_id: "plan-done", name: "Done", category: "completed", position: 5 },
      { status_id: "cycle-succeeded", name: "Succeeded", category: "completed", position: 6 },
      { status_id: "changes-required", name: "Changes Required", category: "completed", position: 7 },
      { status_id: "canceled", name: "Canceled", category: "canceled", position: 8 },
    ],
    issues: [
      {
        issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "root-progress",
        status_name: "In Progress", status_category: "started", status_position: 1, order: 0, depth: 0,
        title: "Root", description: "Build it", labels: [], is_archived: false, issue_kind: "root",
        remote_version: "root-v1", created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
      },
      {
        issue_id: "cycle-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1",
        status_id: "cycle-executing", status_name: "Executing", status_category: "started", status_position: 2,
        order: 1, depth: 1, title: "Cycle", description: workflowDescription("cycle-1", "root-1", "cycle", "Execute the plan."), labels: ["symphony:kind/cycle"], is_archived: false,
        issue_kind: "cycle", remote_version: "cycle-v1", created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
      },
    ],
    comments: [],
    relations: [],
    attachments: [],
    activities: [],
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
      target.labels = command.labelNames;
      target.is_archived = command.isArchived;
      if (command.parentAssignment.mode === "set") {
        target.parent_issue_id = command.parentAssignment.parentIssueId;
      } else if (command.parentAssignment.mode === "clear") {
        delete target.parent_issue_id;
      }
      if (command.order !== undefined) target.order = command.order;
      target.remote_version = `${target.remote_version}:updated`;
    } else if (command.kind === "create_workflow_issue") {
      const parent = this.issue(command.parentIssueId);
      const status = this.tree.status_catalog.find((candidate) => candidate.status_id === command.statusId);
      if (!status) throw new Error("missing_status");
      const issueKind = command.labelNames.includes("symphony:kind/cycle")
        ? "cycle"
        : command.labelNames.includes("symphony:kind/plan") ? "plan" : "work";
      this.tree.issues.push({
        issue_id: command.writeId,
        identifier: `SYM-${this.tree.issues.length + 1}`,
        project_id: command.expectedProjectId,
        parent_issue_id: command.parentIssueId,
        status_id: status.status_id,
        status_name: status.name,
        status_category: status.category,
        status_position: status.position,
        order: this.tree.issues.filter((issue) => issue.parent_issue_id === command.parentIssueId).length,
        depth: parent.depth + 1,
        title: command.title,
        description: command.description,
        labels: command.labelNames,
        is_archived: false,
        issue_kind: issueKind,
        remote_version: `${command.writeId}:v1`,
        created_at: "2026-07-23T00:00:04Z",
        updated_at: "2026-07-23T00:00:04Z",
      });
      parent.remote_version = `${parent.remote_version}:updated`;
    } else if (command.kind === "create_workflow_relation") {
      if (command.relationState === "present") {
        this.tree.relations.push({
          relation_id: command.writeId,
          relation_kind: command.relationKind,
          source_issue_id: command.sourceIssueId,
          target_issue_id: command.targetIssueId,
        });
      } else {
        this.tree.relations = this.tree.relations.filter((relation) => !(
          relation.relation_kind === command.relationKind &&
          relation.source_issue_id === command.sourceIssueId &&
          relation.target_issue_id === command.targetIssueId
        ));
      }
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
    const targetIssueId = command.kind === "create_workflow_issue"
      ? command.writeId
      : command.kind === "update_workflow_issue" || command.kind === "append_workflow_comment"
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

function addPlan(linear: FakeLinear): void {
  linear.tree.issues.push({
    issue_id: "plan-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1",
    status_id: "plan-done", status_name: "Done", status_category: "completed", status_position: 4,
    order: 1, depth: 2, title: "Plan", description: workflowDescription("plan-1", "cycle-1", "plan", "Original Plan."), labels: ["symphony:kind/plan"],
    is_archived: false, issue_kind: "plan", remote_version: "plan-v1", created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
  });
}

function workflowDescription(
  _issueKey: string,
  _parentIssueId: string,
  _issueKind: "cycle" | "plan" | "work" | "verify",
  markdown: string,
): string {
  return markdown;
}
