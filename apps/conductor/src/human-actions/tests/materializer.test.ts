import assert from "node:assert/strict";
import test from "node:test";

import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-reconciliation/api/index.js";
import type {
  RequestHumanActionDirective,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { ManagedRecord } from "../../root-reconciliation/api/ManagedRecords.js";
import { renderWorkflowIssueDescription, workflowIssueLabel } from "../../root-reconciliation/api/WorkflowIssueRecords.js";
import { LinearHumanActionMaterializerImpl } from "../internal/LinearHumanActionMaterializerImpl.js";

test("materializes a Plan Review Action from the matching canonical Plan Contract", async () => {
  const linear = new FakeLinear();
  const materializer = new LinearHumanActionMaterializerImpl(linear);

  const result = await materializer.materialize({
    rootDirectiveId: "directive-1",
    view: view(linear.tree),
    directive: planReviewDirective(),
  });

  assert.deepEqual(result, {
    kind: "materialized",
    actionId: "directive-1:human-action",
    actionIssueId: "action-1",
  });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "create_workflow_issue",
    "create_workflow_relation",
    "append_workflow_comment",
  ]);

  const action = linear.issue("action-1");
  assert.equal(action.parent_issue_id, "cycle-1");
  assert.equal(action.issue_kind, "human");
  assert.equal(action.status_name, "Todo");
  assert.deepEqual(action.labels, ["Human Action", "Plan Review"]);
  assert.equal(linear.issue("plan-1").status_name, "In Review");
  assert.ok(linear.tree.relations.some((relation) =>
    relation.relation_kind === "relates_to" &&
    relation.source_issue_id === "action-1" &&
    relation.target_issue_id === "plan-1",
  ));

  const request = linear.tree.comments
    .map((comment) => parseManagedRecord(comment.body))
    .find((parsed): parsed is { ok: true; value: Extract<ManagedRecord, { kind: "human_action_request" }> } =>
      parsed.ok && parsed.value.kind === "human_action_request",
    )?.value;
  assert.deepEqual(request, {
    kind: "human_action_request",
    version: 1,
    actionId: "directive-1:human-action",
    actionIssueId: "action-1",
    actionKind: "plan_review",
    parentScope: "cycle",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    relatedIssueIds: ["plan-1"],
    sourceRootDirectiveId: "directive-1",
    basedOnTreeDigest: "tree-digest-1",
    proposalDigest: "a".repeat(64),
    expectedParentRemoteVersion: "cycle-1-v1",
    createdAt: "2026-07-24T00:00:00Z",
  });
  assert.match(action.description, /## Plan Contract/u);
  assert.match(action.description, /Approved: accept this exact Plan Contract/u);
  assert.match(action.description, /Rejected: add a fresh comment explaining why/u);
  assert.match(action.description, /No Work or Verify Issue will be created by this Action/u);
});

test("rejects a Plan Review directive whose digest does not match the canonical Contract", async () => {
  const linear = new FakeLinear();
  const materializer = new LinearHumanActionMaterializerImpl(linear);

  const result = await materializer.materialize({
    rootDirectiveId: "directive-1",
    view: view(linear.tree),
    directive: { ...planReviewDirective(), proposalDigest: "b".repeat(64) },
  });

  assert.deepEqual(result, {
    kind: "failed",
    code: "plan_review_contract_digest_mismatch",
    sanitizedReason: "plan_review_contract_digest_mismatch",
  });
  assert.deepEqual(linear.mutations, []);
});

test("stops before the request record when the required Plan relation cannot be written", async () => {
  const linear = new FakeLinear();
  linear.failMutationKind = "create_workflow_relation";
  const materializer = new LinearHumanActionMaterializerImpl(linear);

  const result = await materializer.materialize({
    rootDirectiveId: "directive-1",
    view: view(linear.tree),
    directive: planReviewDirective(),
  });

  assert.deepEqual(result, {
    kind: "failed",
    code: "human_action_relation_write_failed",
    sanitizedReason: "human_action_relation_write_failed",
  });
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "create_workflow_issue",
    "create_workflow_relation",
  ]);
});

test("finishes the durable request after a user approves a newly created Plan Review Action", async () => {
  const linear = new FakeLinear();
  linear.statusAfterCreate = "Approved";
  const materializer = new LinearHumanActionMaterializerImpl(linear);

  const result = await materializer.materialize({
    rootDirectiveId: "directive-1",
    view: view(linear.tree),
    directive: planReviewDirective(),
  });

  assert.deepEqual(result, {
    kind: "materialized",
    actionId: "directive-1:human-action",
    actionIssueId: "action-1",
  });
  assert.equal(linear.issue("action-1").status_name, "Approved");
  assert.deepEqual(linear.mutations.map(({ kind }) => kind), [
    "create_workflow_issue",
    "create_workflow_relation",
    "append_workflow_comment",
  ]);
});

function planReviewDirective(): RequestHumanActionDirective {
  return {
    kind: "request_human_action",
    parentScope: "cycle",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    actionKind: "plan_review",
    title: "Review the deployment Plan",
    description: "Review the proposed deployment work before execution begins.",
    relatedIssueIds: ["plan-1"],
    proposalDigest: "a".repeat(64),
    expectedParentRemoteVersion: "cycle-1-v1",
    requestedDecision: "Approve or reject the proposed deployment Plan.",
    options: ["Approve", "Reject", "Cancel"],
    commentRequired: false,
    evidenceRefs: [{ referenceId: "plan-result-1", sourceKind: "result" }],
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
    treeDigest: "tree-digest-1",
    complete: true,
  };
}

class FakeLinear {
  readonly mutations: LinearWorkflowMutationCommand[] = [];
  failMutationKind?: LinearWorkflowMutationCommand["kind"];
  statusAfterCreate?: "Approved" | "Rejected" | "Canceled";
  tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "root-progress", name: "In Progress", category: "started", position: 1 },
      { status_id: "cycle-planning", name: "Planning", category: "started", position: 2 },
      { status_id: "plan-review", name: "In Review", category: "started", position: 3 },
      { status_id: "action-todo", name: "Todo", category: "unstarted", position: 4 },
    ],
    issues: [
      issue("root-1", "root", undefined, "root-progress", "In Progress", 0),
      issue("cycle-1", "cycle", "root-1", "cycle-planning", "Planning", 1),
      issue("plan-1", "plan", "cycle-1", "plan-review", "In Review", 2),
    ],
    comments: [
      managedComment("plan-1", planContract()),
      managedComment("plan-1", planResult()),
    ],
    relations: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-24T00:00:00Z",
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
    if (this.failMutationKind === command.kind) return { kind: "failed" as const, code: "linear_failed", summary: "failed" };
    if (command.kind === "create_workflow_issue") {
      const status = this.tree.status_catalog.find((candidate) => candidate.status_id === command.statusId);
      if (!status) throw new Error("status missing");
      const parsed = parseManagedRecord(command.description);
      if (!parsed.ok || parsed.value.kind !== "workflow_issue") throw new Error("workflow_issue_record_missing");
      const action = issue("action-1", parsed.value.issueKind, command.parentIssueId, status.status_id, status.name, 2);
      action.title = command.title;
      action.description = command.description;
      action.labels = command.labelNames;
      action.workflow_issue_key = parsed.value.issueKey;
      if (this.statusAfterCreate) {
        action.status_name = this.statusAfterCreate;
        action.status_id = `action-${this.statusAfterCreate.toLowerCase()}`;
        action.status_category = "completed";
      }
      this.tree.issues.push(action);
      this.bump(command.parentIssueId);
      return applied(command.writeId, action);
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
    if (command.kind === "append_workflow_comment") {
      this.tree.comments.push(managedComment(command.target.targetIssueId, command.body));
      this.bump(command.target.targetIssueId);
      return applied(command.writeId, this.issue(command.target.targetIssueId));
    }
    throw new Error(`unexpected mutation ${command.kind}`);
  }

  private bump(issueId: string): void {
    const target = this.issue(issueId);
    target.remote_version = `${target.remote_version}:updated`;
    const root = this.issue("root-1");
    if (root !== target) root.remote_version = `${root.remote_version}:updated`;
  }
}

function applied(writeId: string, issue: LinearWorkflowTreeSnapshot["issues"][number]) {
  return { kind: "applied" as const, readBack: { writeId, targetIssueId: issue.issue_id, remoteVersion: issue.remote_version } };
}

function issue(
  issueId: string,
  issueKind: "root" | "cycle" | "plan" | "work" | "verify" | "human",
  parentIssueId: string | undefined,
  statusId: string,
  statusName: string,
  depth: number,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: issueId, identifier: issueId, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}),
    status_id: statusId, status_name: statusName, status_category: statusName === "Todo" ? "unstarted" as const : "started" as const,
    status_position: depth, order: depth, depth, title: issueKind,
    description: issueKind === "root" ? "root description" : workflowDescription(issueId, parentIssueId!, issueKind, `${issueKind} description`),
    labels: issueKind === "root" ? [] : [workflowIssueLabel(issueKind)],
    is_archived: false, issue_kind: issueKind,
    ...(issueKind === "root" ? {} : { workflow_issue_key: issueId }),
    remote_version: `${issueId}-v1`, updated_at: "2026-07-24T00:00:00Z",
  };
}

function managedComment(issueId: string, body: string) {
  return {
    comment_id: `comment-${issueId}-${body.length}`, issue_id: issueId, body, author_kind: "symphony" as const,
    author_id: "symphony", created_at: "2026-07-24T00:00:00Z", remote_version: `comment-${body.length}`,
    updated_at: "2026-07-24T00:00:00Z",
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

function planContract() {
  return serializeManagedRecord({
    kind: "plan_contract" as const,
    version: 1 as const,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    planContractDigest: "a".repeat(64),
    objective: "Deliver the deployment workflow.",
    includedScope: ["deployment service"],
    excludedScope: ["Podium Desktop"],
    assumptions: ["The test environment is available."],
    constraints: ["Do not add a compatibility path."],
    acceptanceCriteria: [{ criterionKey: "deploy", statement: "Deployments complete safely.", verificationMethod: "integration test" }],
    verificationRequirements: ["npm test -w @symphony/conductor"],
    proposedWorkDag: {
      workNodes: [{
        proposalKey: "deployment-work", title: "Implement deployment", description: "Create the deployment workflow.",
        expectedOutcome: "A durable deployment workflow.", requiredChecks: ["deployment test"], dependencyProposalKeys: [],
      }],
      dependencyEdges: [],
      verifyNode: {
        title: "Verify deployment", acceptanceCriteria: [{ criterionKey: "verify-deploy", statement: "Deployment succeeds.", verificationMethod: "integration test" }],
        requiredChecks: ["deployment test"],
      },
    },
  });
}

function planResult() {
  return serializeManagedRecord({
    kind: "stage_result" as const,
    version: 1 as const,
    resultId: "plan-result-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    nodeIssueId: "plan-1",
    stage: "plan" as const,
    roleSessionId: "plan-session-1",
    roleTurnId: "plan-turn-1",
    observedTreeDigest: "tree-before-plan",
    contextDigest: "context-plan",
    outcomeKind: "plan_completed" as const,
    summary: "The deployment Plan is ready for review.",
    sourceManifest: ["plan-input-1"],
    completedAt: "2026-07-24T00:00:00Z",
    planContractDigest: "a".repeat(64),
    planContract: {
      objective: "Deliver the deployment workflow.", includedScope: ["deployment service"], excludedScope: ["Podium Desktop"],
      assumptions: ["The test environment is available."], constraints: ["Do not add a compatibility path."],
      acceptanceCriteria: [{ criterionKey: "deploy", statement: "Deployments complete safely.", verificationMethod: "integration test" }],
      verificationRequirements: ["npm test -w @symphony/conductor"],
    },
    proposedWorkDag: {
      workNodes: [{
        proposalKey: "deployment-work", title: "Implement deployment", description: "Create the deployment workflow.",
        expectedOutcome: "A durable deployment workflow.", requiredChecks: ["deployment test"], dependencyProposalKeys: [],
      }],
      dependencyEdges: [],
      verifyNode: {
        title: "Verify deployment", acceptanceCriteria: [{ criterionKey: "verify-deploy", statement: "Deployment succeeds.", verificationMethod: "integration test" }],
        requiredChecks: ["deployment test"],
      },
    },
    risks: ["A failed deployment can delay release."],
    requiredPermissions: ["Deploy to the staging environment."],
    evidenceRefs: [{ referenceId: "plan-evidence-1", sourceKind: "linear_record" as const }],
  });
}
