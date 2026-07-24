import assert from "node:assert/strict";
import test from "node:test";

import type { LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { serializeManagedRecord, parseManagedRecord } from "../../root-reconciliation/api/index.js";
import type { RootDirective, RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { renderWorkflowIssueDescription, workflowIssueLabel } from "../../root-reconciliation/api/WorkflowIssueRecords.js";
import { LinearRootDirectiveMaterializerImpl } from "../internal/LinearRootDirectiveMaterializerImpl.js";

const digest = "a".repeat(64);

test("materializes the approved immutable Plan DAG before sealing the Cycle", async () => {
  const linear = new FakeLinear();
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);

  const result = await materializer.materialize({ directive: directive(), view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "materialized",
    rootDirectiveId: "directive-1",
    sourceIssueIds: ["cycle-1", "plan-1", "work-1", "work-2", "verify-1"],
  });
  assert.equal(linear.issue("plan-1").status_name, "Done");
  assert.equal(linear.issue("cycle-1").status_name, "Sealed");
  assert.deepEqual(
    linear.tree.issues
      .filter((issue) => issue.parent_issue_id === "cycle-1" && (issue.issue_kind === "work" || issue.issue_kind === "verify"))
      .map((issue) => [issue.issue_kind, issue.title, issue.order]),
    [["work", "First work", 1], ["work", "Second work", 2], ["verify", "Verify the approved Plan", 3]],
  );
  const issueKeys = nodeIssueKeys(linear.tree);
  assert.equal(issueKeys.length, 3);
  assert.ok(issueKeys.every((issueKey) => issueKey?.startsWith("approved-plan-dag:")));
  assert.equal(
    linear.tree.comments.some((comment) => parseManagedRecord(comment.body).ok && comment.body.includes(`"${["node", "marker"].join("_")}"`)),
    false,
  );
  assert.deepEqual(
    linear.tree.relations.map((relation) => [relation.relation_kind, relation.source_issue_id, relation.target_issue_id]).sort(),
    [
      ["blocks", "work-1", "work-2"],
      ["relates_to", "action-1", "plan-1"],
      ["relates_to", "plan-1", "verify-1"],
      ["relates_to", "plan-1", "work-1"],
      ["relates_to", "plan-1", "work-2"],
    ],
  );
  const mutationCount = linear.mutations.length;
  const repeated = await materializer.materialize({ directive: directive(), view: view(linear.tree) });
  assert.equal(repeated.kind, "materialized");
  assert.equal(linear.mutations.length, mutationCount);

  const recoveredDirective = directive();
  recoveredDirective.rootDirectiveId = "directive-2";
  const recovered = await materializer.materialize({ directive: recoveredDirective, view: view(linear.tree) });
  assert.equal(recovered.kind, "materialized");
  assert.equal(linear.mutations.length, mutationCount);
});

test("keeps workflow write identifiers within the contract bound for a maximum-length directive ID", async () => {
  const linear = new FakeLinear();
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);
  const maximumLengthDirective = directive();
  maximumLengthDirective.rootDirectiveId = "d".repeat(128);

  const result = await materializer.materialize({ directive: maximumLengthDirective, view: view(linear.tree) });

  assert.equal(result.kind, "materialized");
  assert.ok(linear.mutations.every((mutation) => mutation.writeId.length <= 128));
});

test("rejects a Plan DAG directive whose digest conflicts with the accepted approval resolution", async () => {
  const linear = new FakeLinear();
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);
  const invalid = directive();
  invalid.action.planContractDigest = "b".repeat(64);

  const result = await materializer.materialize({ directive: invalid, view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "failed",
    rootDirectiveId: "directive-1",
    code: "approved_plan_dag_resolution_directive_mismatch",
    sanitizedReason: "approved_plan_dag_resolution_directive_mismatch",
  });
  assert.deepEqual(linear.mutations, []);
});

test("rejects an already Done Plan when its approved DAG is not durable", async () => {
  const linear = new FakeLinear();
  linear.issue("plan-1").status_id = "done";
  linear.issue("plan-1").status_name = "Done";
  linear.issue("plan-1").status_category = "completed";
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);

  const result = await materializer.materialize({ directive: directive(), view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "failed",
    rootDirectiveId: "directive-1",
    code: "approved_plan_dag_terminal_graph_incomplete",
    sanitizedReason: "approved_plan_dag_terminal_graph_incomplete",
  });
  assert.deepEqual(linear.mutations, []);
});

test("rejects an Approved Action that the Root Reconciler did not accept as a resolution", async () => {
  const linear = new FakeLinear();
  const materializer = new LinearRootDirectiveMaterializerImpl(linear, {} as never);
  const invalid = directive();
  invalid.humanActionResolutions = [];

  const result = await materializer.materialize({ directive: invalid, view: view(linear.tree) });

  assert.deepEqual(result, {
    kind: "failed",
    rootDirectiveId: "directive-1",
    code: "approved_plan_dag_resolution_not_accepted",
    sanitizedReason: "approved_plan_dag_resolution_not_accepted",
  });
  assert.deepEqual(linear.mutations, []);
});

function directive(): RootDirective & { action: Extract<RootDirective["action"], { kind: "materialize_approved_plan_dag" }> } {
  return {
    protocolVersion: 1,
    requestId: "request-1",
    rootDirectiveId: "directive-1",
    reconcilerSessionId: "session-1",
    reconcilerTurnId: "turn-1",
    basedOnTargetRootDigest: "tree-v1",
    rationale: "The approved Plan can now become the active Cycle DAG.",
    evidenceRefs: [{ referenceId: "plan-result-1", sourceKind: "result" }],
    consumedInputIds: ["action-1:approved"],
    commentReplies: [],
    humanActionResolutions: [{
      resolutionId: "resolution-1",
      actionId: "action-request-1",
      actionIssueId: "action-1",
      actionKind: "plan_review",
      outcome: "approved",
      actorKind: "human",
      terminalStatus: "Approved",
      terminalRemoteVersion: "action-1-v1",
      proposalDigest: digest,
      resolvedAt: "2026-07-24T00:01:00Z",
    }],
    action: {
      kind: "materialize_approved_plan_dag",
      cycleIssueId: "cycle-1",
      planIssueId: "plan-1",
      planContractDigest: digest,
      approvalActionIssueId: "action-1",
      approvalResolutionId: "resolution-1",
    },
  };
}

function view(tree: LinearWorkflowTreeSnapshot): RootReconciliationView {
  return {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress", title: "Root", description: "Root description",
      updatedAt: "2026-07-24T00:00:00Z", projectId: "project-1", parentIssueId: null,
      isDelegatedToSymphony: true, priority: "normal", order: 0, blockers: [], rootConductorLabels: [],
    },
    tree,
    git: { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt: tree.observed_at,
    treeDigest: "tree-v1",
    complete: true,
  };
}

class FakeLinear {
  readonly mutations: LinearWorkflowMutationCommand[] = [];
  private nextComment = 1;
  private nextWork = 1;
  tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      status("root-progress", "In Progress", "started", 1),
      status("cycle-planning", "Planning", "started", 2),
      status("plan-review", "In Review", "started", 3),
      status("action-approved", "Approved", "completed", 4),
      status("todo", "Todo", "unstarted", 5),
      status("done", "Done", "completed", 6),
      status("sealed", "Sealed", "started", 7),
    ],
    issues: [
      issue("root-1", "root", undefined, "root-progress", "In Progress", 0, 0),
      issue("cycle-1", "cycle", "root-1", "cycle-planning", "Planning", 1, 0),
      issue("plan-1", "plan", "cycle-1", "plan-review", "In Review", 2, 0),
      {
        ...issue("action-1", "human", "cycle-1", "action-approved", "Approved", 2, 1),
        labels: ["Human Action", "Plan Review"],
        workflow_issue_key: "action-request-1",
        description: workflowDescription("action-request-1", "cycle-1", "human", "Plan review action"),
      },
    ],
    comments: [
      managedComment("comment-contract", "plan-1", planContract()),
      managedComment("comment-result", "plan-1", completedPlanResult()),
      managedComment("comment-request", "action-1", actionRequest()),
      managedComment("comment-resolution", "action-1", actionResolution()),
    ],
    relations: [{ relation_id: "action-plan", relation_kind: "relates_to", source_issue_id: "action-1", target_issue_id: "plan-1" }],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-24T00:02:00Z",
  };

  issue(issueId: string) {
    const found = this.tree.issues.find((issue) => issue.issue_id === issueId);
    if (!found) throw new Error(`missing issue ${issueId}`);
    return found;
  }

  async readWorkflowIssueTree() {
    return structuredClone(this.tree);
  }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.mutations.push(command);
    if (command.kind === "create_workflow_issue") {
      const statusValue = this.status(command.statusId);
      const parsed = parseManagedRecord(command.description);
      if (!parsed.ok || parsed.value.kind !== "workflow_issue") throw new Error("workflow_issue_record_missing");
      const issueId = parsed.value.issueKind === "work" ? `work-${this.nextWork++}` : "verify-1";
      const created = issue(issueId, parsed.value.issueKind, command.parentIssueId, statusValue.status_id, statusValue.name, 2, command.order ?? 0);
      created.title = command.title;
      created.description = command.description;
      created.labels = command.labelNames;
      created.workflow_issue_key = parsed.value.issueKey;
      this.tree.issues.push(created);
      this.bump(command.parentIssueId);
      return applied(command.writeId, created);
    }
    if (command.kind === "append_workflow_comment") {
      this.tree.comments.push(managedComment(`comment-${this.nextComment++}`, command.target.targetIssueId, command.body));
      this.bump(command.target.targetIssueId);
      return applied(command.writeId, this.issue(command.target.targetIssueId));
    }
    if (command.kind === "create_workflow_relation") {
      this.tree.relations.push({
        relation_id: command.writeId,
        relation_kind: command.relationKind,
        source_issue_id: command.sourceIssueId,
        target_issue_id: command.targetIssueId,
      });
      this.bump(command.sourceIssueId);
      this.bump(command.targetIssueId);
      return applied(command.writeId, this.issue(command.sourceIssueId));
    }
    if (command.kind === "update_workflow_issue") {
      const target = this.issue(command.target.targetIssueId);
      const statusValue = this.status(command.statusId);
      target.status_id = statusValue.status_id;
      target.status_name = statusValue.name;
      target.status_category = statusValue.category;
      target.status_position = statusValue.position;
      target.title = command.title;
      target.description = command.description;
      if (command.order !== undefined) target.order = command.order;
      this.bump(target.issue_id);
      return applied(command.writeId, target);
    }
    throw new Error(`unexpected mutation ${command.kind}`);
  }

  private status(statusId: string) {
    const found = this.tree.status_catalog.find((status) => status.status_id === statusId);
    if (!found) throw new Error(`missing status ${statusId}`);
    return found;
  }

  private bump(issueId: string): void {
    const target = this.issue(issueId);
    target.remote_version = `${target.remote_version}:updated`;
    const root = this.issue("root-1");
    if (root !== target) root.remote_version = `${root.remote_version}:updated`;
  }
}

function status(statusId: string, name: string, category: "unstarted" | "started" | "completed", position: number) {
  return { status_id: statusId, name, category, position };
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle" | "plan" | "work" | "verify" | "human",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: string,
  depth: number,
  order: number,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId, status_name: statusName, status_category: statusName === "Todo" ? "unstarted" : "started",
    status_position: depth, order, depth, title: issueKind,
    description: issueKind === "root" ? "root description" : workflowDescription(issueId, parentIssueId!, issueKind, `${issueKind} description`),
    labels: issueKind === "root" ? [] : [workflowIssueLabel(issueKind)],
    is_archived: false, issue_kind: issueKind,
    ...(issueKind === "root" ? {} : { workflow_issue_key: issueId }),
    remote_version: `${issueId}-v1`, updated_at: "2026-07-24T00:00:00Z",
  };
}

function managedComment(commentId: string, issueId: string, body: string) {
  return {
    comment_id: commentId, issue_id: issueId, body, author_kind: "symphony" as const, author_id: "symphony",
    created_at: "2026-07-24T00:00:00Z", remote_version: `${commentId}-v1`, updated_at: "2026-07-24T00:00:00Z",
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

function applied(writeId: string, issue: LinearWorkflowTreeSnapshot["issues"][number]) {
  return { kind: "applied" as const, readBack: { writeId, targetIssueId: issue.issue_id, remoteVersion: issue.remote_version } };
}

function planContract() {
  return serializeManagedRecord({
    kind: "plan_contract", version: 1, rootIssueId: "root-1", cycleIssueId: "cycle-1", planContractDigest: digest,
    objective: "Deliver the reviewed deployment.", includedScope: ["deployment"], excludedScope: [], assumptions: [], constraints: [],
    acceptanceCriteria: [{ criterionKey: "deploy", statement: "Deploy safely.", verificationMethod: "test" }], verificationRequirements: ["npm test"],
    proposedWorkDag: dag(),
  });
}

function completedPlanResult() {
  return serializeManagedRecord({
    kind: "stage_result", version: 1, resultId: "plan-result-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "plan-1",
    stage: "plan", roleSessionId: "plan-session-1", roleTurnId: "plan-turn-1", observedTreeDigest: "before-plan", contextDigest: "plan-context",
    outcomeKind: "plan_completed", summary: "Plan is ready for review.", sourceManifest: [], completedAt: "2026-07-24T00:00:00Z",
    planContractDigest: digest,
    planContract: {
      objective: "Deliver the reviewed deployment.", includedScope: ["deployment"], excludedScope: [], assumptions: [], constraints: [],
      acceptanceCriteria: [{ criterionKey: "deploy", statement: "Deploy safely.", verificationMethod: "test" }], verificationRequirements: ["npm test"],
    },
    proposedWorkDag: dag(), risks: [], requiredPermissions: [], evidenceRefs: [],
  });
}

function actionRequest() {
  return serializeManagedRecord({
    kind: "human_action_request", version: 1, actionId: "action-request-1", actionIssueId: "action-1", actionKind: "plan_review",
    parentScope: "cycle", rootIssueId: "root-1", cycleIssueId: "cycle-1", relatedIssueIds: ["plan-1"],
    sourceRootDirectiveId: "request-directive-1", basedOnTreeDigest: "tree-before-action", proposalDigest: digest,
    expectedParentRemoteVersion: "cycle-1-v1", createdAt: "2026-07-24T00:00:00Z",
  });
}

function actionResolution() {
  return serializeManagedRecord({
    kind: "human_action_resolution", version: 1, resolutionId: "resolution-1", actionId: "action-request-1", actionIssueId: "action-1",
    actionKind: "plan_review", outcome: "approved", terminalStatus: "Approved", terminalRemoteVersion: "action-1-v1",
    sourceCommentIds: [], sourceCommentVersions: [], actorKind: "human", proposalDigest: digest, resolvedAt: "2026-07-24T00:01:00Z",
  });
}

function dag() {
  return {
    workNodes: [
      { proposalKey: "first", title: "First work", description: "Make the first change.", expectedOutcome: "First change is complete.", requiredChecks: ["first-test"], dependencyProposalKeys: [] },
      { proposalKey: "second", title: "Second work", description: "Make the second change.", expectedOutcome: "Second change is complete.", requiredChecks: ["second-test"], dependencyProposalKeys: ["first"] },
    ],
    dependencyEdges: [],
    verifyNode: {
      title: "Verify the approved Plan",
      acceptanceCriteria: [{ criterionKey: "verify", statement: "The deployment works.", verificationMethod: "test" }],
      requiredChecks: ["verify-test"],
    },
  };
}

function nodeIssueKeys(tree: LinearWorkflowTreeSnapshot) {
  return tree.issues
    .filter((issue) => issue.parent_issue_id === "cycle-1" && (issue.issue_kind === "work" || issue.issue_kind === "verify"))
    .map((issue) => issue.workflow_issue_key)
    .sort();
}
