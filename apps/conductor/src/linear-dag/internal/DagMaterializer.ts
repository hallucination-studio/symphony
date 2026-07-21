import type {
  HumanActionRecord,
  NodeMarker,
  PlanContract,
} from "../../root-workflow/api/ManagedRecords.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-workflow/api/index.js";
import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import { PlanContractValidationError, validatePlanContract } from "./PlanContractValidator.js";

type Issue = LinearWorkflowTreeSnapshot["issues"][number];
type Relation = LinearWorkflowTreeSnapshot["relations"][number];

export interface DagMaterializerInput {
  tree: LinearWorkflowTreeSnapshot;
  contract: PlanContract;
  rootIssueId: string;
  projectId: string;
  cycleIssueId: string;
  planIssueId: string;
}

export type DagMaterializationDecision =
  | { kind: "blocked"; reason: string }
  | { kind: "mutation"; step: string; command: LinearWorkflowMutationCommand; check: (tree: LinearWorkflowTreeSnapshot, targetIssueId?: string) => boolean }
  | { kind: "complete"; planContractDigest: string };

interface ExpectedNode {
  key: string;
  kind: "work" | "verify";
  title: string;
  description: string;
  managedMarker: string;
}

interface ExpectedRelation {
  blockedIssueKey: string;
  dependencyIssueKey: string;
}

interface ExpectedGraph {
  nodes: ExpectedNode[];
  relations: ExpectedRelation[];
}

export class DagMaterializer {
  next(input: DagMaterializerInput): DagMaterializationDecision {
    let validated: ReturnType<typeof validatePlanContract>;
    try {
      validated = validatePlanContract(input.contract, input.rootIssueId, input.cycleIssueId);
    } catch (error) {
      if (error instanceof PlanContractValidationError) return blocked(error.code);
      throw error;
    }
    const { tree, rootIssueId, projectId, cycleIssueId, planIssueId } = input;
    const root = tree.issues.find((issue) => issue.issue_id === rootIssueId);
    const cycle = tree.issues.find((issue) => issue.issue_id === cycleIssueId);
    const plan = tree.issues.find((issue) => issue.issue_id === planIssueId);
    if (!root || !cycle || !plan || root.issue_kind !== "root" || cycle.issue_kind !== "cycle" || plan.issue_kind !== "plan"
      || cycle.parent_issue_id !== rootIssueId || plan.parent_issue_id !== cycleIssueId) return blocked("dag_materialization_target_invalid");
    if (root.project_id !== projectId || cycle.project_id !== projectId || plan.project_id !== projectId) return blocked("dag_materialization_project_invalid");
    if (root.status_name !== "In Progress" || !["In Review", "Done"].includes(plan.status_name)) return blocked("plan_approval_read_back_incomplete");
    const approval = approvedAction(tree, input.contract, rootIssueId, cycleIssueId, planIssueId);
    if (!approval) return blocked("plan_approval_read_back_invalid");
    if (approval.expectedRootRemoteVersion === root.remote_version) return blocked("plan_approval_not_applied");

    const graph = expectedGraph(input, validated.workNodes);
    const markerDecision = this.markerDecision(input, plan);
    if (markerDecision) return markerDecision;
    const nodeDecision = this.nodeDecision(input, graph, cycle);
    if (nodeDecision) return nodeDecision;
    const relationDecision = this.relationDecision(input, graph, cycle);
    if (relationDecision) return relationDecision;

    if (!isExactMaterialization(tree, input.contract, rootIssueId, cycleIssueId, planIssueId)) return blocked("dag_read_back_incomplete");
    if (plan.status_name !== "Done") {
      return statusMutation(input, root, plan, "Done", "plan_done", (fresh) => isExactMaterialization(fresh, input.contract, rootIssueId, cycleIssueId, planIssueId)
        && issueById(fresh, planIssueId)?.status_name === "Done");
    }
    if (cycle.status_name !== "Sealed") {
      return statusMutation(input, root, cycle, "Sealed", "cycle_sealed", (fresh) => isExactMaterialization(fresh, input.contract, rootIssueId, cycleIssueId, planIssueId)
        && issueById(fresh, planIssueId)?.status_name === "Done"
        && issueById(fresh, cycleIssueId)?.status_name === "Sealed");
    }
    return { kind: "complete", planContractDigest: input.contract.planContractDigest };
  }

  private markerDecision(input: DagMaterializerInput, plan: Issue): DagMaterializationDecision | undefined {
    const markers = nodeMarkers(input.tree, plan.issue_id);
    if (markers.length > 2 || markers.filter((marker) => marker.nodeKind !== "plan").length > 0) return blocked("plan_marker_invalid");
    const resolved = markers.filter((marker) => marker.planContractDigest === input.contract.planContractDigest);
    const pending = markers.filter((marker) => marker.planContractDigest === "pending-plan-contract");
    if (resolved.length > 1 || pending.length > 1 || markers.some((marker) => marker.planContractDigest !== input.contract.planContractDigest && marker.planContractDigest !== "pending-plan-contract")) return blocked("plan_marker_digest_conflict");
    if (resolved.length === 0) {
      if (pending.length === 0 && markers.length > 0) return blocked("plan_marker_missing");
      const writeId = `${input.rootIssueId}:plan:${plan.issue_id}:approved-marker`;
      const record: NodeMarker = { kind: "node_marker", version: 1, rootIssueId: input.rootIssueId, cycleIssueId: input.cycleIssueId, nodeKey: "plan-1", nodeKind: "plan", planContractDigest: input.contract.planContractDigest };
      return commentMutation(input, plan, writeId, record, "plan_marker_resolved", (fresh) => nodeMarkers(fresh, plan.issue_id).some((marker) => marker.nodeKind === "plan" && marker.planContractDigest === input.contract.planContractDigest));
    }
    return undefined;
  }

  private nodeDecision(input: DagMaterializerInput, graph: ExpectedGraph, cycle: Issue): DagMaterializationDecision | undefined {
    const expectedMarkers = new Set(graph.nodes.map((node) => node.managedMarker));
    const children = input.tree.issues.filter((issue) => issue.parent_issue_id === cycle.issue_id && (issue.issue_kind === "work" || issue.issue_kind === "verify"));
    if (children.some((issue) => !issue.managed_marker || !expectedMarkers.has(issue.managed_marker))) return blocked("dag_unexpected_node");
    for (const [index, expected] of graph.nodes.entries()) {
      const matches = input.tree.issues.filter((issue) => issue.managed_marker === expected.managedMarker);
      if (matches.length > 1) return blocked("dag_node_marker_ambiguous");
      const issue = matches[0];
      if (!issue) {
        const parent = cycle;
        const status = input.tree.status_catalog.find((candidate) => candidate.name === "Todo");
        if (!status) return blocked("status_missing:dag_node");
        const writeId = `${input.rootIssueId}:dag:${expected.kind}:${expected.key}:create`;
        return {
          kind: "mutation", step: expected.kind === "work" ? "work_created" : "verify_created",
          command: { kind: "create_workflow_issue", writeId, expectedProjectId: input.projectId, rootIssueId: input.rootIssueId, expectedRootRemoteVersion: issueRoot(input.tree, input.rootIssueId).remote_version, parentExpectedRemoteVersion: parent.remote_version, parentExpectedStatusId: parent.status_id, parentIssueId: parent.issue_id, issueKind: expected.kind, title: expected.title, description: expected.description, statusId: status.status_id, managedMarker: expected.managedMarker, order: 2 + index },
          check: (fresh, targetIssueId) => fresh.issues.some((candidate) => candidate.issue_id === targetIssueId && candidate.issue_kind === expected.kind && candidate.parent_issue_id === cycle.issue_id && candidate.status_name === "Todo" && candidate.managed_marker === expected.managedMarker && candidate.title === expected.title && candidate.description === expected.description),
        };
      }
      if (issue.issue_kind !== expected.kind || issue.parent_issue_id !== cycle.issue_id || issue.project_id !== input.projectId || issue.status_name !== "Todo" || issue.title !== expected.title || issue.description !== expected.description) return blocked("dag_node_contract_conflict");
      const markers = nodeMarkers(input.tree, issue.issue_id);
      if (markers.length > 1 || markers.some((marker) => marker.nodeKind !== expected.kind || marker.nodeKey !== expected.key || marker.planContractDigest !== input.contract.planContractDigest)) return blocked("dag_node_marker_conflict");
      if (markers.length === 0) {
        const writeId = `${input.rootIssueId}:dag:${expected.kind}:${expected.key}:marker`;
        const record: NodeMarker = { kind: "node_marker", version: 1, rootIssueId: input.rootIssueId, cycleIssueId: input.cycleIssueId, nodeKey: expected.key, nodeKind: expected.kind, planContractDigest: input.contract.planContractDigest };
        return commentMutation(input, issue, writeId, record, `${expected.kind}_marker_created`, (fresh) => nodeMarkers(fresh, issue.issue_id).some((marker) => marker.nodeKey === expected.key && marker.planContractDigest === input.contract.planContractDigest));
      }
    }
    return undefined;
  }

  private relationDecision(input: DagMaterializerInput, graph: ExpectedGraph, cycle: Issue): DagMaterializationDecision | undefined {
    const nodeByKey = new Map<string, Issue>();
    for (const issue of input.tree.issues.filter((candidate) => candidate.parent_issue_id === cycle.issue_id)) {
      if (issue.managed_marker) nodeByKey.set(issue.managed_marker, issue);
    }
    const keyToIssue = new Map<string, Issue>();
    for (const node of graph.nodes) {
      const issue = nodeByKey.get(node.managedMarker);
      if (!issue) return blocked("dag_node_read_back_incomplete");
      keyToIssue.set(node.key, issue);
    }
    keyToIssue.set("plan-1", issueById(input.tree, input.planIssueId)!);
    const expectedKeys = new Set(graph.relations.map((relation) => relationKey(relation, keyToIssue)));
    const actual = input.tree.relations.filter((relation) => sameCycleRelation(relation, input.tree, cycle.issue_id));
    if (actual.some((relation) => !expectedKeys.has(relationKeyFromTree(relation)))) return blocked("dag_relation_conflict");
    for (const expected of graph.relations) {
      const source = keyToIssue.get(expected.blockedIssueKey)!;
      const target = keyToIssue.get(expected.dependencyIssueKey)!;
      if (actual.some((relation) => relationMatches(relation, source.issue_id, target.issue_id))) continue;
      const writeId = `${input.rootIssueId}:dag:relation:${expected.blockedIssueKey}:${expected.dependencyIssueKey}`;
      return {
        kind: "mutation", step: "relation_created",
        command: { kind: "create_workflow_relation", writeId, expectedProjectId: input.projectId, rootIssueId: input.rootIssueId, expectedRootRemoteVersion: issueRoot(input.tree, input.rootIssueId).remote_version, sourceIssueId: source.issue_id, sourceExpectedRemoteVersion: source.remote_version, targetIssueId: target.issue_id, targetExpectedRemoteVersion: target.remote_version, relationKind: "blocked_by" },
        check: (fresh) => fresh.relations.some((relation) => relationMatches(relation, source.issue_id, target.issue_id)),
      };
    }
    return undefined;
  }
}

export function isExactMaterialization(tree: LinearWorkflowTreeSnapshot, contract: PlanContract, rootIssueId: string, cycleIssueId: string, planIssueId: string): boolean {
  let validated: ReturnType<typeof validatePlanContract>;
  try { validated = validatePlanContract(contract, rootIssueId, cycleIssueId); } catch { return false; }
  const cycle = issueById(tree, cycleIssueId);
  const plan = issueById(tree, planIssueId);
  if (!cycle || !plan || cycle.issue_kind !== "cycle" || plan.issue_kind !== "plan" || plan.parent_issue_id !== cycleIssueId || !["In Review", "Done"].includes(plan.status_name)) return false;
  const graph = expectedGraph({ contract, rootIssueId, cycleIssueId } as DagMaterializerInput, validated.workNodes);
  const children = tree.issues.filter((issue) => issue.parent_issue_id === cycleIssueId && issue.issue_kind !== "plan");
  if (children.length !== graph.nodes.length) return false;
  for (const expected of graph.nodes) {
    const matches = tree.issues.filter((issue) => issue.parent_issue_id === cycleIssueId && issue.managed_marker === expected.managedMarker);
    if (matches.length !== 1 || matches[0]!.issue_kind !== expected.kind || matches[0]!.status_name !== "Todo" || matches[0]!.title !== expected.title || matches[0]!.description !== expected.description) return false;
    const markers = nodeMarkers(tree, matches[0]!.issue_id);
    if (markers.length !== 1 || markers[0]!.nodeKey !== expected.key || markers[0]!.nodeKind !== expected.kind || markers[0]!.planContractDigest !== contract.planContractDigest) return false;
  }
  const planMarkers = nodeMarkers(tree, planIssueId);
  const resolvedPlanMarkers = planMarkers.filter((marker) => marker.planContractDigest === contract.planContractDigest);
  const pendingPlanMarkers = planMarkers.filter((marker) => marker.planContractDigest === "pending-plan-contract");
  if (resolvedPlanMarkers.length !== 1 || pendingPlanMarkers.length > 1
    || planMarkers.some((marker) => marker.planContractDigest !== contract.planContractDigest && marker.planContractDigest !== "pending-plan-contract")) return false;
  const expectedRelationKeys = new Set(graph.relations.map((relation) => {
    const blocked = tree.issues.find((issue) => issue.parent_issue_id === cycleIssueId && issue.managed_marker === graph.nodes.find((node) => node.key === relation.blockedIssueKey)?.managedMarker);
    const dependency = relation.dependencyIssueKey === "plan-1" ? plan : tree.issues.find((issue) => issue.parent_issue_id === cycleIssueId && issue.managed_marker === graph.nodes.find((node) => node.key === relation.dependencyIssueKey)?.managedMarker);
    return blocked && dependency ? `${blocked.issue_id}:${dependency.issue_id}` : "missing";
  }));
  const actual = tree.relations.filter((relation) => sameCycleRelation(relation, tree, cycleIssueId));
  return actual.length === expectedRelationKeys.size && actual.every((relation) => expectedRelationKeys.has(`${blockedId(relation)}:${dependencyId(relation)}`));
}

function expectedGraph(input: DagMaterializerInput, workNodes: ReturnType<typeof validatePlanContract>["workNodes"]): ExpectedGraph {
  const nodes: ExpectedNode[] = workNodes.map((work) => ({ key: work.workKey, kind: "work", title: work.title, description: work.description, managedMarker: `${input.rootIssueId}:work:${input.cycleIssueId}:${work.workKey}` }));
  nodes.push({ key: "verify-1", kind: "verify", title: input.contract.verifyNode.title, description: input.contract.objectiveSummary, managedMarker: `${input.rootIssueId}:verify:${input.cycleIssueId}` });
  const relations: ExpectedRelation[] = [];
  for (const work of workNodes) {
    relations.push({ blockedIssueKey: work.workKey, dependencyIssueKey: "plan-1" });
    for (const dependency of work.dependencyWorkKeys) relations.push({ blockedIssueKey: work.workKey, dependencyIssueKey: dependency });
    relations.push({ blockedIssueKey: "verify-1", dependencyIssueKey: work.workKey });
  }
  return { nodes, relations };
}

function approvedAction(tree: LinearWorkflowTreeSnapshot, contract: PlanContract, rootIssueId: string, cycleIssueId: string, planIssueId: string): HumanActionRecord | undefined {
  const actions = tree.comments.flatMap((comment) => {
    if (comment.issue_id !== rootIssueId || !comment.managed_marker) return [];
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok || parsed.value.kind !== "human_action") return [];
    return [parsed.value];
  }).filter((action) => action.requestKind === "needs_approval" && action.cycleIssueId === cycleIssueId && action.nodeIssueId === planIssueId && action.questionOrProposal === `Approve Plan ${contract.planContractDigest}.`);
  return actions.length === 1 ? actions[0] : undefined;
}

function commentMutation(input: DagMaterializerInput, target: Issue, writeId: string, record: NodeMarker, step: string, check: (tree: LinearWorkflowTreeSnapshot) => boolean): DagMaterializationDecision {
  return { kind: "mutation", step, command: { kind: "append_workflow_comment", writeId, expectedProjectId: input.projectId, rootIssueId: input.rootIssueId, expectedRootRemoteVersion: issueRoot(input.tree, input.rootIssueId).remote_version, target: { targetIssueId: target.issue_id, expectedRemoteVersion: target.remote_version, expectedStatusId: target.status_id, ...(target.parent_issue_id ? { expectedParentIssueId: target.parent_issue_id } : {}), ...(target.managed_marker ? { expectedManagedMarker: target.managed_marker } : {}) }, body: serializeManagedRecord(record) }, check: (fresh) => check(fresh) };
}

function statusMutation(input: DagMaterializerInput, root: Issue, target: Issue, statusName: string, step: string, check: (tree: LinearWorkflowTreeSnapshot) => boolean): DagMaterializationDecision {
  const status = input.tree.status_catalog.find((candidate) => candidate.name === statusName);
  if (!status) return blocked(`status_missing:${step}`);
  return { kind: "mutation", step, command: { kind: "update_workflow_issue", writeId: `${input.rootIssueId}:workflow:${step}`, expectedProjectId: input.projectId, rootIssueId: input.rootIssueId, expectedRootRemoteVersion: root.remote_version, target: { targetIssueId: target.issue_id, expectedRemoteVersion: target.remote_version, expectedStatusId: target.status_id, ...(target.parent_issue_id ? { expectedParentIssueId: target.parent_issue_id } : {}), ...(target.managed_marker ? { expectedManagedMarker: target.managed_marker } : {}) }, statusId: status.status_id, title: target.title, description: target.description }, check: (fresh) => check(fresh) && issueById(fresh, target.issue_id)?.status_name === statusName };
}

function nodeMarkers(tree: LinearWorkflowTreeSnapshot, issueId: string): NodeMarker[] {
  return tree.comments.flatMap((comment) => {
    if (comment.issue_id !== issueId || !comment.managed_marker) return [];
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok || parsed.value.kind !== "node_marker") return [];
    return [parsed.value];
  });
}

function issueById(tree: LinearWorkflowTreeSnapshot, issueId: string): Issue | undefined { return tree.issues.find((issue) => issue.issue_id === issueId); }
function issueRoot(tree: LinearWorkflowTreeSnapshot, rootIssueId: string): Issue { const issue = issueById(tree, rootIssueId); if (!issue) throw new Error("dag_root_missing"); return issue; }
function blocked(reason: string): DagMaterializationDecision { return { kind: "blocked", reason }; }
function sameCycleRelation(relation: Relation, tree: LinearWorkflowTreeSnapshot, cycleIssueId: string): boolean {
  return tree.issues.find((issue) => issue.issue_id === relation.source_issue_id)?.parent_issue_id === cycleIssueId
    && tree.issues.find((issue) => issue.issue_id === relation.target_issue_id)?.parent_issue_id === cycleIssueId;
}
function relationMatches(relation: Relation, blockedIssueId: string, dependencyIssueId: string): boolean {
  return relation.relation_kind === "blocked_by" && relation.source_issue_id === blockedIssueId && relation.target_issue_id === dependencyIssueId
    || relation.relation_kind === "blocks" && relation.source_issue_id === dependencyIssueId && relation.target_issue_id === blockedIssueId;
}
function relationKey(relation: ExpectedRelation, keyToIssue: Map<string, Issue>): string { return `${keyToIssue.get(relation.blockedIssueKey)!.issue_id}:${keyToIssue.get(relation.dependencyIssueKey)!.issue_id}`; }
function relationKeyFromTree(relation: Relation): string { return `${blockedId(relation)}:${dependencyId(relation)}`; }
function blockedId(relation: Relation): string { return relation.relation_kind === "blocked_by" ? relation.source_issue_id : relation.target_issue_id; }
function dependencyId(relation: Relation): string { return relation.relation_kind === "blocked_by" ? relation.target_issue_id : relation.source_issue_id; }
