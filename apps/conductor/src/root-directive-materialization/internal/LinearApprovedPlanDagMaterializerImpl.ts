import { createHash } from "node:crypto";

import type { LinearGatewayInterface, LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import {
  findWorkflowIssue,
  parseManagedRecord,
  renderWorkflowIssueDescription,
  workflowIssueLabel,
} from "../../root-reconciliation/api/index.js";
import type {
  HumanActionRequestRecord,
  HumanActionResolutionRecord,
  PlanContract,
  PlanWorkNode,
  ProposedWorkDag,
  StageResultRecord,
} from "../../root-reconciliation/api/ManagedRecords.js";
import type { RootDirective, RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootDirectiveMaterializationResult } from "../api/RootDirectiveMaterializerInterface.js";

type ApprovedPlanDagDirective = Extract<RootDirective["action"], { kind: "materialize_approved_plan_dag" }>;
type MaterializationFailure = Extract<RootDirectiveMaterializationResult, { kind: "failed" }>;

interface ApprovedPlanFacts {
  root: LinearWorkflowTreeSnapshot["issues"][number];
  cycle: LinearWorkflowTreeSnapshot["issues"][number];
  plan: LinearWorkflowTreeSnapshot["issues"][number];
  action: LinearWorkflowTreeSnapshot["issues"][number];
  contract: PlanContract;
  dag: ProposedWorkDag;
}

interface ExpectedDagNode {
  nodeKind: "work" | "verify";
  nodeKey: string;
  issueKey: string;
  title: string;
  description: string;
  order: number;
}

export class LinearApprovedPlanDagMaterializerImpl {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async materialize(input: {
    directive: RootDirective;
    view: RootReconciliationView;
  }): Promise<RootDirectiveMaterializationResult> {
    const action = input.directive.action;
    if (action.kind !== "materialize_approved_plan_dag") return failed(input.directive, "approved_plan_dag_action_invalid");
    const facts = validateApprovedPlanFacts(input.directive, input.view, action);
    if (typeof facts === "string") return failed(input.directive, facts);

    let view = input.view;
    const workIssueIds: string[] = [];
    for (const [index, work] of facts.dag.workNodes.entries()) {
      const ensured = await this.ensureNode(input.directive, view, facts, "work", `work:${work.proposalKey}`, work.title, renderWorkDescription(work), index + 1);
      if (typeof ensured === "string") return failed(input.directive, ensured);
      view = ensured.view;
      workIssueIds.push(ensured.issue.issue_id);
    }
    const verify = await this.ensureNode(
      input.directive,
      view,
      facts,
      "verify",
      "verify",
      facts.dag.verifyNode.title,
      renderVerifyDescription(facts.dag),
      facts.dag.workNodes.length + 1,
    );
    if (typeof verify === "string") return failed(input.directive, verify);
    view = verify.view;

    const plan = issue(view.tree, facts.plan.issue_id);
    for (const targetIssueId of [...workIssueIds, verify.issue.issue_id]) {
      const related = await this.ensureRelation(input.directive, view, plan.issue_id, targetIssueId, "relates_to", `plan:${targetIssueId}`);
      if (typeof related === "string") return failed(input.directive, related);
      view = related;
    }

    const workByProposalKey = new Map(facts.dag.workNodes.map((work, index) => [work.proposalKey, workIssueIds[index]!])) as Map<string, string>;
    for (const work of facts.dag.workNodes) {
      const targetIssueId = workByProposalKey.get(work.proposalKey);
      if (!targetIssueId) return failed(input.directive, "approved_plan_dag_work_mapping_missing");
      for (const dependencyProposalKey of work.dependencyProposalKeys) {
        const sourceIssueId = workByProposalKey.get(dependencyProposalKey);
        if (!sourceIssueId) return failed(input.directive, "approved_plan_dag_dependency_mapping_missing");
        const dependency = await this.ensureRelation(
          input.directive,
          view,
          sourceIssueId,
          targetIssueId,
          "blocks",
          `dependency:${dependencyProposalKey}:${work.proposalKey}`,
        );
        if (typeof dependency === "string") return failed(input.directive, dependency);
        view = dependency;
      }
    }

    const finalizedPlan = await this.ensureStatus(input.directive, view, facts.plan.issue_id, "Done", "plan");
    if (typeof finalizedPlan === "string") return failed(input.directive, finalizedPlan);
    const sealedCycle = await this.ensureStatus(input.directive, finalizedPlan, facts.cycle.issue_id, "Sealed", "cycle");
    if (typeof sealedCycle === "string") return failed(input.directive, sealedCycle);

    return {
      kind: "materialized",
      rootDirectiveId: input.directive.rootDirectiveId,
      sourceIssueIds: [facts.cycle.issue_id, facts.plan.issue_id, ...workIssueIds, verify.issue.issue_id],
    };
  }

  private async ensureNode(
    directive: RootDirective,
    initialView: RootReconciliationView,
    facts: ApprovedPlanFacts,
    nodeKind: "work" | "verify",
    nodeKey: string,
    title: string,
    description: string,
    order: number,
  ): Promise<{ view: RootReconciliationView; issue: LinearWorkflowTreeSnapshot["issues"][number] } | string> {
    let view = initialView;
    const issueKey = nodeIssueKey(facts.cycle.issue_id, facts.contract.planContractDigest, nodeKey);
    const renderedDescription = renderWorkflowIssueDescription({
      issueKey,
      rootIssueId: facts.root.issue_id,
      parentIssueId: facts.cycle.issue_id,
      issueKind: nodeKind,
      markdown: description,
    });
    let node = findWorkflowIssue(view.tree, issueKey);
    if (!node) {
      const todo = view.tree.status_catalog.find((status) => status.name === "Todo");
      const cycle = issue(view.tree, facts.cycle.issue_id);
      const root = issue(view.tree, facts.root.issue_id);
      if (!todo) return "approved_plan_dag_todo_status_missing";
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_workflow_issue",
        writeId: issueKey,
        expectedProjectId: cycle.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        parentExpectedRemoteVersion: cycle.remote_version,
        parentExpectedStatusId: cycle.status_id,
        parentIssueId: cycle.issue_id,
        title,
        description: renderedDescription,
        statusId: todo.status_id,
        labelNames: [workflowIssueLabel(nodeKind)],
        order,
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return `approved_plan_dag_${nodeKind}_create_${outcome.kind}`;
      view = await refreshView(this.linear, view);
      node = findWorkflowIssue(view.tree, issueKey);
      if (!node) return `approved_plan_dag_${nodeKind}_create_read_back_missing`;
    }
    if (!matchesNode(node, facts.cycle.issue_id, nodeKind, issueKey, title, renderedDescription, order)) return `approved_plan_dag_${nodeKind}_node_invalid`;
    return { view, issue: node };
  }

  private async ensureRelation(
    directive: RootDirective,
    initialView: RootReconciliationView,
    sourceIssueId: string,
    targetIssueId: string,
    relationKind: "blocks" | "relates_to",
    suffix: string,
  ): Promise<RootReconciliationView | string> {
    const existing = initialView.tree.relations.filter((relation) =>
      relation.relation_kind === relationKind && relation.source_issue_id === sourceIssueId && relation.target_issue_id === targetIssueId,
    );
    if (existing.length > 1) return "approved_plan_dag_relation_ambiguous";
    if (existing.length === 1) return initialView;
    if (relationKind === "blocks" && initialView.tree.relations.some((relation) =>
      relation.relation_kind === "blocks" && relation.target_issue_id === targetIssueId && relation.source_issue_id !== sourceIssueId,
    )) return "approved_plan_dag_dependency_conflict";
    const root = issue(initialView.tree, initialView.root.issueId);
    const source = issue(initialView.tree, sourceIssueId);
    const target = issue(initialView.tree, targetIssueId);
    const outcome = await this.linear.mutateWorkflow({
      kind: "create_workflow_relation",
      writeId: mutationWriteId(directive, `relation:${suffix}`),
      expectedProjectId: root.project_id,
      rootIssueId: root.issue_id,
      expectedRootRemoteVersion: root.remote_version,
      sourceIssueId: source.issue_id,
      sourceExpectedRemoteVersion: source.remote_version,
      targetIssueId: target.issue_id,
      targetExpectedRemoteVersion: target.remote_version,
      relationKind,
    });
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return `approved_plan_dag_relation_${outcome.kind}`;
    const view = await refreshView(this.linear, initialView);
    return view.tree.relations.some((relation) =>
      relation.relation_kind === relationKind && relation.source_issue_id === sourceIssueId && relation.target_issue_id === targetIssueId,
    ) ? view : "approved_plan_dag_relation_read_back_missing";
  }

  private async ensureStatus(
    directive: RootDirective,
    initialView: RootReconciliationView,
    targetIssueId: string,
    statusName: "Done" | "Sealed",
    targetKind: "plan" | "cycle",
  ): Promise<RootReconciliationView | string> {
    const target = issue(initialView.tree, targetIssueId);
    if (target.status_name === statusName) return initialView;
    const status = initialView.tree.status_catalog.find((candidate) => candidate.name === statusName);
    const root = issue(initialView.tree, initialView.root.issueId);
    if (!status) return `approved_plan_dag_${targetKind}_status_missing`;
    const command: LinearWorkflowMutationCommand = {
      kind: "update_workflow_issue",
      writeId: mutationWriteId(directive, `status:${targetKind}:${statusName}`),
      expectedProjectId: target.project_id,
      rootIssueId: root.issue_id,
      expectedRootRemoteVersion: root.remote_version,
      target: {
        targetIssueId: target.issue_id,
        expectedRemoteVersion: target.remote_version,
        expectedStatusId: target.status_id,
        ...(target.parent_issue_id === undefined ? {} : { expectedParentIssueId: target.parent_issue_id }),
        expectedIsArchived: false,
      },
      statusId: status.status_id,
      title: target.title,
      description: target.description,
      order: target.order,
    };
    const outcome = await this.linear.mutateWorkflow(command);
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return `approved_plan_dag_${targetKind}_status_${outcome.kind}`;
    const view = await refreshView(this.linear, initialView);
    const confirmed = view.tree.issues.find((issue) => issue.issue_id === targetIssueId);
    return confirmed?.status_id === status.status_id && confirmed.status_name === statusName
      ? view
      : `approved_plan_dag_${targetKind}_status_read_back_invalid`;
  }
}

function validateApprovedPlanFacts(
  directive: RootDirective,
  view: RootReconciliationView,
  action: ApprovedPlanDagDirective,
): ApprovedPlanFacts | string {
  const accepted = directive.humanActionResolutions.filter((resolution) => resolution.resolutionId === action.approvalResolutionId);
  if (accepted.length !== 1) return "approved_plan_dag_resolution_not_accepted";
  const resolution = accepted[0]!;
  if (
    resolution.actionIssueId !== action.approvalActionIssueId ||
    resolution.actionKind !== "plan_review" ||
    resolution.outcome !== "approved" ||
    resolution.terminalStatus !== "Approved" ||
    resolution.proposalDigest !== action.planContractDigest
  ) return "approved_plan_dag_resolution_directive_mismatch";
  const root = view.tree.issues.find((issue) => issue.issue_id === view.root.issueId);
  const cycle = view.tree.issues.find((issue) => issue.issue_id === action.cycleIssueId);
  const plan = view.tree.issues.find((issue) => issue.issue_id === action.planIssueId);
  const humanAction = view.tree.issues.find((issue) => issue.issue_id === action.approvalActionIssueId);
  if (!root || !cycle || !plan || !humanAction) return "approved_plan_dag_target_missing";
  if (
    cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
    (cycle.status_name !== "Planning" && cycle.status_name !== "Sealed")
  ) {
    return "approved_plan_dag_cycle_invalid";
  }
  if (
    plan.issue_kind !== "plan" || plan.parent_issue_id !== cycle.issue_id || plan.is_archived ||
    (plan.status_name !== "In Review" && plan.status_name !== "Done")
  ) {
    return "approved_plan_dag_plan_invalid";
  }
  if (cycle.status_name === "Sealed" && plan.status_name !== "Done") return "approved_plan_dag_terminal_status_invalid";
  if (
    humanAction.issue_kind !== "human" || humanAction.parent_issue_id !== cycle.issue_id || humanAction.is_archived ||
    humanAction.status_name !== "Approved" || humanAction.labels.length !== 2 ||
    !humanAction.labels.includes("Human Action") || !humanAction.labels.includes("Plan Review")
  ) return "approved_plan_dag_action_invalid";
  if (!view.tree.relations.some((relation) =>
    relation.relation_kind === "relates_to" && relation.source_issue_id === humanAction.issue_id && relation.target_issue_id === plan.issue_id,
  )) return "approved_plan_dag_action_relation_missing";

  const requestRecords = recordsFor<HumanActionRequestRecord>(view.tree, humanAction.issue_id, "human_action_request");
  const request = requestRecords.filter((record) =>
    record.actionId === resolution.actionId && record.actionIssueId === humanAction.issue_id && record.actionKind === "plan_review" &&
    record.parentScope === "cycle" && record.rootIssueId === root.issue_id && record.cycleIssueId === cycle.issue_id &&
    record.relatedIssueIds.length === 1 && record.relatedIssueIds[0] === plan.issue_id && record.proposalDigest === action.planContractDigest,
  );
  if (request.length !== 1) return request.length === 0 ? "approved_plan_dag_action_request_missing" : "approved_plan_dag_action_request_ambiguous";
  const durableResolutions = recordsFor<HumanActionResolutionRecord>(view.tree, humanAction.issue_id, "human_action_resolution");
  const durableResolution = durableResolutions.filter((record) =>
    record.resolutionId === resolution.resolutionId && record.actionId === resolution.actionId && record.actionIssueId === humanAction.issue_id &&
    record.actionKind === "plan_review" && record.outcome === "approved" && record.terminalStatus === "Approved" &&
    record.terminalRemoteVersion === resolution.terminalRemoteVersion && record.proposalDigest === action.planContractDigest && record.actorKind === "human",
  );
  if (durableResolution.length !== 1) return durableResolution.length === 0 ? "approved_plan_dag_resolution_missing" : "approved_plan_dag_resolution_ambiguous";
  if (humanAction.remote_version !== resolution.terminalRemoteVersion) return "approved_plan_dag_resolution_stale";

  const contracts = recordsFor<PlanContract>(view.tree, plan.issue_id, "plan_contract").filter((contract) =>
    contract.rootIssueId === root.issue_id && contract.cycleIssueId === cycle.issue_id && contract.planContractDigest === action.planContractDigest,
  );
  if (contracts.length !== 1) return contracts.length === 0 ? "approved_plan_dag_contract_digest_mismatch" : "approved_plan_dag_contract_ambiguous";
  const results = recordsFor<CompletedPlanResult>(view.tree, plan.issue_id, "stage_result").filter((result) =>
    result.rootIssueId === root.issue_id && result.cycleIssueId === cycle.issue_id && result.nodeIssueId === plan.issue_id &&
    result.stage === "plan" && result.outcomeKind === "plan_completed" && result.planContractDigest === action.planContractDigest,
  );
  if (results.length !== 1) return results.length === 0 ? "approved_plan_dag_plan_result_missing" : "approved_plan_dag_plan_result_ambiguous";
  const contract = contracts[0]!;
  const result = results[0]!;
  if (!samePlanProposal(contract, result.planContract) || !sameDag(contract.proposedWorkDag, result.proposedWorkDag)) {
    return "approved_plan_dag_contract_result_mismatch";
  }
  const topology = validateDag(contract.proposedWorkDag);
  if (topology) return topology;
  const expectedNodes = expectedDagNodes(cycle.issue_id, contract, contract.proposedWorkDag);
  const existingNodeValidation = validateExistingNodes(view.tree, cycle.issue_id, expectedNodes);
  if (existingNodeValidation) return existingNodeValidation;
  if (
    (plan.status_name === "Done" || cycle.status_name === "Sealed") &&
    !isDagDurablyMaterialized(view.tree, root.issue_id, cycle.issue_id, plan.issue_id, expectedNodes, contract.proposedWorkDag)
  ) return "approved_plan_dag_terminal_graph_incomplete";
  return { root, cycle, plan, action: humanAction, contract, dag: contract.proposedWorkDag };
}

function expectedDagNodes(cycleIssueId: string, contract: PlanContract, dag: ProposedWorkDag): ExpectedDagNode[] {
  return [
    ...dag.workNodes.map((work, index) => ({
      nodeKind: "work" as const,
      nodeKey: `work:${work.proposalKey}`,
      title: work.title,
      description: renderWorkDescription(work),
      order: index + 1,
    })),
    {
      nodeKind: "verify" as const,
      nodeKey: "verify",
      title: dag.verifyNode.title,
      description: renderVerifyDescription(dag),
      order: dag.workNodes.length + 1,
    },
  ].map((node) => ({ ...node, issueKey: nodeIssueKey(cycleIssueId, contract.planContractDigest, node.nodeKey) }));
}

function validateExistingNodes(
  tree: LinearWorkflowTreeSnapshot,
  cycleIssueId: string,
  expectedNodes: ExpectedDagNode[],
): string | undefined {
  const existingNodes = tree.issues.filter((issue) =>
    issue.parent_issue_id === cycleIssueId && !issue.is_archived && (issue.issue_kind === "work" || issue.issue_kind === "verify"),
  );
  const expectedIssueKeys = new Set(expectedNodes.map((node) => node.issueKey));
  if (existingNodes.some((node) => !node.workflow_issue_key || !expectedIssueKeys.has(node.workflow_issue_key))) {
    return "approved_plan_dag_existing_node_unbound";
  }
  return expectedNodes.some((expected) => existingNodes.filter((node) => node.workflow_issue_key === expected.issueKey).length > 1)
    ? "approved_plan_dag_node_ambiguous"
    : undefined;
}

function isDagDurablyMaterialized(
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
  cycleIssueId: string,
  planIssueId: string,
  expectedNodes: ExpectedDagNode[],
  dag: ProposedWorkDag,
): boolean {
  const nodeIds = new Map<string, string>();
  for (const expected of expectedNodes) {
    const nodes = tree.issues.filter((issue) => issue.workflow_issue_key === expected.issueKey);
    const renderedDescription = renderWorkflowIssueDescription({
      issueKey: expected.issueKey,
      rootIssueId,
      parentIssueId: cycleIssueId,
      issueKind: expected.nodeKind,
      markdown: expected.description,
    });
    if (nodes.length !== 1 || !matchesNode(nodes[0]!, cycleIssueId, expected.nodeKind, expected.issueKey, expected.title, renderedDescription, expected.order)) return false;
    nodeIds.set(expected.nodeKey, nodes[0]!.issue_id);
  }
  const relationCount = (relationKind: "blocks" | "relates_to", sourceIssueId: string, targetIssueId: string) =>
    tree.relations.filter((relation) =>
      relation.relation_kind === relationKind && relation.source_issue_id === sourceIssueId && relation.target_issue_id === targetIssueId,
    ).length;
  if ([...nodeIds.values()].some((nodeIssueId) => relationCount("relates_to", planIssueId, nodeIssueId) !== 1)) return false;
  return dag.workNodes.every((work) => work.dependencyProposalKeys.every((dependencyProposalKey) =>
    relationCount(
      "blocks",
      nodeIds.get(`work:${dependencyProposalKey}`)!,
      nodeIds.get(`work:${work.proposalKey}`)!,
    ) === 1,
  ));
}

function recordsFor<T>(tree: LinearWorkflowTreeSnapshot, issueId: string, kind: string): T[] {
  return tree.comments.flatMap((comment) => {
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === kind && comment.issue_id === issueId ? [parsed.value as T] : [];
  });
}

function validateDag(dag: ProposedWorkDag): string | undefined {
  if (dag.dependencyEdges.length > 0) return "approved_plan_dag_dependency_edges_unmaterializable";
  const keys = new Set(dag.workNodes.map((work) => work.proposalKey));
  if (keys.size !== dag.workNodes.length) return "approved_plan_dag_work_key_duplicate";
  for (const work of dag.workNodes) {
    if (new Set(work.dependencyProposalKeys).size !== work.dependencyProposalKeys.length) return "approved_plan_dag_dependency_duplicate";
    if (work.dependencyProposalKeys.some((key) => key === work.proposalKey || !keys.has(key))) return "approved_plan_dag_dependency_invalid";
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(dag.workNodes.map((work) => [work.proposalKey, work]));
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    for (const dependency of byKey.get(key)!.dependencyProposalKeys) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(key);
    visited.add(key);
    return true;
  };
  return dag.workNodes.every((work) => visit(work.proposalKey)) ? undefined : "approved_plan_dag_dependency_cycle";
}

function samePlanProposal(contract: PlanContract, proposal: NonNullable<StageResultRecord["planContract"]>): boolean {
  return JSON.stringify({
    objective: contract.objective,
    includedScope: contract.includedScope,
    excludedScope: contract.excludedScope,
    assumptions: contract.assumptions,
    constraints: contract.constraints,
    acceptanceCriteria: contract.acceptanceCriteria,
    verificationRequirements: contract.verificationRequirements,
  }) === JSON.stringify(proposal);
}

function sameDag(left: ProposedWorkDag, right: ProposedWorkDag): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesNode(
  node: LinearWorkflowTreeSnapshot["issues"][number],
  cycleIssueId: string,
  nodeKind: "work" | "verify",
  issueKey: string,
  title: string,
  description: string,
  order: number,
): boolean {
  return node.parent_issue_id === cycleIssueId && node.issue_kind === nodeKind && !node.is_archived && node.status_name === "Todo" &&
    node.workflow_issue_key === issueKey && node.title === title && node.description === description && node.order === order;
}

function nodeIssueKey(cycleIssueId: string, planContractDigest: string, nodeKey: string): string {
  const identity = JSON.stringify([cycleIssueId, planContractDigest, nodeKey]);
  return `approved-plan-dag:${createHash("sha256").update(identity).digest("hex")}`;
}

function mutationWriteId(directive: RootDirective, operation: string): string {
  const identity = JSON.stringify([directive.rootDirectiveId, operation]);
  return `approved-plan-dag:${createHash("sha256").update(identity).digest("hex")}`;
}

function renderWorkDescription(work: PlanWorkNode): string {
  return [
    work.description,
    "",
    "Expected outcome",
    work.expectedOutcome,
    "",
    "Required checks",
    ...work.requiredChecks.map((check) => `- ${check}`),
  ].join("\n");
}

function renderVerifyDescription(dag: ProposedWorkDag): string {
  return [
    "Verify the approved Plan Contract and completed Work evidence.",
    "",
    "Acceptance criteria",
    ...dag.verifyNode.acceptanceCriteria.map((criterion) => `- ${criterion.statement} (${criterion.verificationMethod})`),
    "",
    "Required checks",
    ...dag.verifyNode.requiredChecks.map((check) => `- ${check}`),
  ].join("\n");
}

function issue(tree: LinearWorkflowTreeSnapshot, issueId: string): LinearWorkflowTreeSnapshot["issues"][number] {
  const found = tree.issues.find((issue) => issue.issue_id === issueId);
  if (!found) throw new Error("approved_plan_dag_issue_missing");
  return found;
}

async function refreshView(linear: LinearGatewayInterface, view: RootReconciliationView): Promise<RootReconciliationView> {
  const tree = await linear.readWorkflowIssueTree(view.root.issueId);
  return { ...view, tree, observedAt: tree.observed_at };
}

function failed(directive: RootDirective, code: string): MaterializationFailure {
  return { kind: "failed", rootDirectiveId: directive.rootDirectiveId, code, sanitizedReason: code };
}

type CompletedPlanResult = StageResultRecord & {
  outcomeKind: "plan_completed";
  planContractDigest: string;
  planContract: NonNullable<StageResultRecord["planContract"]>;
  proposedWorkDag: NonNullable<StageResultRecord["proposedWorkDag"]>;
};
