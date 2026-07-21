import assert from "node:assert/strict";
import test from "node:test";

import type { PlanContract } from "../../root-workflow/api/ManagedRecords.js";
import { serializeManagedRecord } from "../../root-workflow/api/index.js";
import type { BootstrapPlanInput } from "../api/LinearDagExecutionInterface.js";
import type { LinearGatewayInterface, LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { validatePlanContract } from "../internal/PlanContractValidator.js";
import { DagMaterializer, isExactMaterialization } from "../internal/DagMaterializer.js";
import { LinearDagExecutionImpl } from "../internal/LinearDagExecutionImpl.js";

const rootIssueId = "root-1";
const cycleIssueId = "cycle-1";
const planIssueId = "plan-1";
const digest = "a".repeat(64);

test("rejects a cyclic approved Plan Contract before any Linear mutation", () => {
  const contract = planContract([
    { workKey: "one", dependencyWorkKeys: ["two"] },
    { workKey: "two", dependencyWorkKeys: ["one"] },
  ]);

  assert.throws(
    () => validatePlanContract(contract, rootIssueId, cycleIssueId),
    (error: unknown) => error instanceof Error && error.message === "plan_contract_dependency_cycle",
  );
});

test("materializes a partial graph with Conductor-owned identity and stable writes", () => {
  const tree = approvedTree();
  const materializer = new DagMaterializer();
  const contract = planContract([
    { workKey: "one", dependencyWorkKeys: [] },
    { workKey: "two", dependencyWorkKeys: ["one"] },
  ]);

  const first = materializer.next({ tree, contract, rootIssueId, projectId: "project-1", cycleIssueId, planIssueId });
  assert.equal(first.kind, "mutation");
  if (first.kind !== "mutation") return;
  assert.equal(first.step, "plan_marker_resolved");
  assert.equal(first.command.kind, "append_workflow_comment");
  assert.match(first.command.writeId, /^root-1:plan:plan-1:/);
  assert.ok(first.command.body.includes(`"plan_contract_digest":"${digest}"`));
  assert.ok(!first.command.body.includes("pending-plan-contract"));

  tree.comments.push(comment(planIssueId, "root-1:plan:plan-1:approved-marker", {
    kind: "node_marker", version: 1, rootIssueId, cycleIssueId, nodeKey: "plan-1", nodeKind: "plan", planContractDigest: digest,
  }));
  const second = materializer.next({ tree, contract, rootIssueId, projectId: "project-1", cycleIssueId, planIssueId });
  assert.equal(second.kind, "mutation");
  if (second.kind !== "mutation") return;
  assert.equal(second.step, "work_created");
  assert.equal(second.command.kind, "create_workflow_issue");
  assert.equal(second.command.issueKind, "work");
  assert.equal(second.command.managedMarker, "root-1:work:cycle-1:one");
  assert.equal(second.command.writeId, "root-1:dag:work:one:create");
  assert.notEqual(second.command.managedMarker, "one");
});

test("does not consider partial or extra nodes an exact sealed graph", () => {
  const tree = approvedTree();
  const contract = planContract([{ workKey: "one", dependencyWorkKeys: [] }]);
  assert.equal(isExactMaterialization(tree, contract, rootIssueId, cycleIssueId, planIssueId), false);
  tree.issues.push(issue("unexpected", "work", "Todo", 99, "root-1:work:cycle-1:unexpected"));
  tree.comments.push(comment("unexpected", "unexpected-marker", {
    kind: "node_marker", version: 1, rootIssueId, cycleIssueId, nodeKey: "unexpected", nodeKind: "work", planContractDigest: digest,
  }));
  assert.equal(isExactMaterialization(tree, contract, rootIssueId, cycleIssueId, planIssueId), false);
});

test("recovers partial writes, seals only after the exact graph, and is idempotent", () => {
  const tree = approvedTree();
  const materializer = new DagMaterializer();
  const contract = planContract([{ workKey: "one", dependencyWorkKeys: [] }]);
  const writes: string[] = [];
  let completed = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const decision = materializer.next({ tree, contract, rootIssueId, projectId: "project-1", cycleIssueId, planIssueId });
    if (decision.kind === "blocked") throw new Error(decision.reason);
    if (decision.kind === "complete") {
      completed = true;
      break;
    }
    if (decision.kind !== "mutation") throw new Error("unexpected_materialization_decision");
    writes.push(decision.command.writeId);
    apply(tree, decision.command);
  }
  assert.equal(completed, true);
  assert.equal(new Set(writes).size, writes.length);
  assert.equal(tree.issues.find((issue) => issue.issue_id === planIssueId)?.status_name, "Done");
  assert.equal(tree.issues.find((issue) => issue.issue_id === cycleIssueId)?.status_name, "Sealed");
  assert.equal(tree.issues.filter((issue) => issue.issue_kind === "work").length, 1);
  assert.equal(tree.issues.filter((issue) => issue.issue_kind === "verify").length, 1);
  assert.equal(tree.relations.length, 2);
  assert.equal(isExactMaterialization(tree, contract, rootIssueId, cycleIssueId, planIssueId), true);

  const retry = materializer.next({ tree, contract, rootIssueId, projectId: "project-1", cycleIssueId, planIssueId });
  assert.deepEqual(retry, { kind: "complete", planContractDigest: digest });
});

test("reconciliation performs one read-backed mutation per step before sealing", async () => {
  const tree = approvedTree();
  const contract = planContract([{ workKey: "one", dependencyWorkKeys: [] }]);
  tree.comments.push(comment(planIssueId, "contract-record", contract));
  const gateway = new MaterializationGateway(tree);
  const execution = new LinearDagExecutionImpl({
    linear: gateway,
    git: gateway.git,
    performer: { async runStage() { throw new Error("unused"); }, async cancelAndReap() {} },
  });
  const input = materializationInput();
  const steps: string[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await execution.reconcileRoot(input);
    if (result.kind === "completed") break;
    assert.equal(result.kind, "mutation_applied");
    steps.push(result.step);
  }
  assert.deepEqual(steps.slice(-2), ["plan_done", "cycle_sealed"]);
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === planIssueId)?.status_name, "Done");
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === cycleIssueId)?.status_name, "Sealed");
  assert.equal(isExactMaterialization(gateway.tree, contract, rootIssueId, cycleIssueId, planIssueId), true);
  assert.equal(gateway.writes.length, steps.length);
  assert.equal(new Set(gateway.writes).size, gateway.writes.length);
});

function approvedTree(): LinearWorkflowTreeSnapshot {
  const statuses = catalog();
  return {
    root_issue_id: rootIssueId,
    status_catalog: statuses,
    issues: [
      issue(rootIssueId, "root", "In Progress", 0),
      issue(cycleIssueId, "cycle", "Planning", 1, "root-1:cycle:cycle-1", rootIssueId),
      issue(planIssueId, "plan", "In Review", 1, "root-1:plan:bootstrap", cycleIssueId),
    ],
    comments: [
      comment(cycleIssueId, "cycle-marker", { kind: "cycle_marker", version: 1, rootIssueId, cycleKey: "cycle-1", trigger: "initial", baselineRevision: "head-1" }),
      comment(planIssueId, "plan-marker", { kind: "node_marker", version: 1, rootIssueId, cycleIssueId, nodeKey: "plan-1", nodeKind: "plan", planContractDigest: "pending-plan-contract" }),
      comment(rootIssueId, "approval", { kind: "human_action", version: 1, actionId: "approval-1", rootIssueId, cycleIssueId, nodeIssueId: planIssueId, requestKind: "needs_approval", questionOrProposal: `Approve Plan ${digest}.`, reason: "Review", impact: "Materialize", contextDigest: digest, expectedRootRemoteVersion: "root-version" }),
    ],
    relations: [],
    observed_at: "2026-07-21T09:00:00Z",
  };
}

function planContract(work: Array<{ workKey: string; dependencyWorkKeys: string[] }>): PlanContract {
  return {
    kind: "plan_contract", version: 1, rootIssueId, cycleIssueId, planContractDigest: digest,
    objectiveSummary: "Deliver the plan.", includedScope: ["apps/conductor"], excludedScope: [],
    acceptanceCriteria: [{ criterionKey: "root", statement: "The root is complete.", verificationMethod: "tests" }],
    workNodes: work.map(({ workKey, dependencyWorkKeys }) => ({
      workKey, title: `Work ${workKey}`, description: `Implement ${workKey}.`, dependencyWorkKeys,
      acceptanceCriteria: [{ criterionKey: `${workKey}-criterion`, statement: `${workKey} completes.`, verificationMethod: "tests" }],
    })),
    verifyNode: { title: "Verify", acceptanceCriteria: [{ criterionKey: "verify", statement: "The plan verifies.", verificationMethod: "tests" }], requiredChecks: [] },
  };
}

function issue(issueId: string, kind: "root" | "cycle" | "plan" | "work" | "verify", statusName: string, order: number, managedMarker?: string, parentIssueId?: string): LinearWorkflowTreeSnapshot["issues"][number] {
  const status = catalog().find((candidate) => candidate.name === statusName)!;
  return { issue_id: issueId, identifier: issueId, project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}), status_id: status.status_id, status_name: status.name, status_category: status.category, status_position: status.position, order, depth: kind === "root" ? 0 : kind === "cycle" ? 1 : 2, title: kind === "work" ? `Work ${issueId}` : kind === "verify" ? "Verify" : issueId, description: issueId, ...(managedMarker ? { managed_marker: managedMarker } : {}), issue_kind: kind, remote_version: `${issueId}-version`, updated_at: "2026-07-21T09:00:00Z" };
}

function comment(issueId: string, managedMarker: string, value: object) {
  return { comment_id: managedMarker, issue_id: issueId, body: serializeManagedRecord(value), managed_marker: managedMarker, remote_version: `${managedMarker}-version`, updated_at: "2026-07-21T09:00:00Z" };
}

function apply(tree: LinearWorkflowTreeSnapshot, command: LinearWorkflowMutationCommand): void {
  if (command.kind === "append_workflow_comment") {
    tree.comments.push({ comment_id: command.writeId, issue_id: command.target.targetIssueId, body: command.body, managed_marker: command.writeId, remote_version: `${command.writeId}:version`, updated_at: tree.observed_at });
    return;
  }
  if (command.kind === "create_workflow_issue") {
    const parent = tree.issues.find((issue) => issue.issue_id === command.parentIssueId)!;
    const status = tree.status_catalog.find((candidate) => candidate.status_id === command.statusId)!;
    const issueId = command.issueKind === "work" ? `work-${tree.issues.filter((issue) => issue.issue_kind === "work").length + 1}` : "verify-1";
    tree.issues.push({ issue_id: issueId, identifier: issueId, project_id: command.expectedProjectId, parent_issue_id: parent.issue_id, status_id: status.status_id, status_name: status.name, status_category: status.category, status_position: status.position, order: command.order ?? tree.issues.length, depth: parent.depth + 1, title: command.title, description: command.description, managed_marker: command.managedMarker, issue_kind: command.issueKind, remote_version: `${issueId}:version`, updated_at: tree.observed_at });
    return;
  }
  if (command.kind === "create_workflow_relation") {
    tree.relations.push({ relation_id: command.writeId, relation_kind: command.relationKind, source_issue_id: command.sourceIssueId, target_issue_id: command.targetIssueId });
    return;
  }
  const issue = tree.issues.find((candidate) => candidate.issue_id === command.target.targetIssueId)!;
  const status = tree.status_catalog.find((candidate) => candidate.status_id === command.statusId)!;
  issue.status_id = status.status_id;
  issue.status_name = status.name;
  issue.status_category = status.category;
  issue.status_position = status.position;
  issue.remote_version = `${issue.issue_id}:${command.writeId}:version`;
}

function materializationInput(): BootstrapPlanInput {
  return {
    rootIssueId, projectId: "project-1", workspace: { branch: "symphony/root-1", worktreePath: "/tmp/root-1", rootIssueId },
    options: {
      conductorShortHash: "cond", repositoryIdentity: "symphony", baseBranch: "main", performerProfileId: "profile-1",
      modelSettings: { model: "gpt-5.4", reasoningEffort: "high", isFastModeEnabled: false },
      limits: { maxContextBytes: 1_048_576, maxResultBytes: 262_144, maxWallTimeMs: 3_600_000, maxToolCalls: 10, maxCommandDurationMs: 300_000, reservedTotalTokens: 50_000, maxOutputTokens: 8_000 },
      instructionSetId: "plan-v1", stageInstructions: "Produce a bounded Plan Contract.",
    },
  };
}

class MaterializationGateway implements LinearGatewayInterface {
  readonly writes: string[] = [];
  readonly git = {
    async inspect() { return { head: "head-1", branch: "symphony/root-1", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } }; },
    async diff() { return { text: "", bytes: 0, cap: 65_536, partial: false }; },
    async checks() { return { items: [], returned: 0, cap: 32, has_more: false, partial: false }; },
    async commit() { throw new Error("unused"); },
  };

  constructor(public readonly tree: LinearWorkflowTreeSnapshot) {}
  async readWorkflowIssueTree() { return structuredClone(this.tree); }
  async readFreshRootScope(): Promise<never> { throw new Error("unused"); }
  async read(): Promise<never> { throw new Error("unused"); }
  async mutate(): Promise<never> { throw new Error("unused"); }
  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.writes.push(command.writeId);
    apply(this.tree, command);
    const targetIssueId = command.kind === "create_workflow_issue"
      ? this.tree.issues.find((issue) => issue.managed_marker === command.managedMarker)!.issue_id
      : command.kind === "create_workflow_relation" ? command.sourceIssueId : command.target.targetIssueId;
    return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId, remoteVersion: `${targetIssueId}:read-back` } };
  }
}

function catalog(): LinearWorkflowTreeSnapshot["status_catalog"] {
  return ([
    ["Draft", "backlog"], ["Todo", "unstarted"], ["Planning", "started"], ["Sealed", "started"], ["Executing", "started"], ["Verifying", "started"], ["In Progress", "started"], ["In Review", "started"], ["Needs Approval", "started"], ["Needs Info", "started"], ["Inconclusive", "started"], ["Escalated", "started"], ["Succeeded", "completed"], ["Changes Required", "completed"], ["Done", "completed"], ["Canceled", "canceled"], ["Failed", "canceled"],
  ] as const).map(([name, category], position) => ({ status_id: `status-${position}`, name, category, position }));
}
