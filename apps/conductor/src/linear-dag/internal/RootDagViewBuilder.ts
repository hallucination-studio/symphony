import type {
  GitWorkspace,
  GitWorkspaceSnapshot,
} from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type {
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  CycleMarker,
  ManagedRecord,
  NodeMarker,
  PlanContract,
  RootOwnershipRecord,
} from "../../root-workflow/api/ManagedRecords.js";
import {
  parseManagedRecord,
} from "../../root-workflow/api/index.js";
import type {
  RootDagNodeView,
  RootDagView,
  RootCycleView,
} from "../../root-workflow/api/RootWorkflowPolicyInterface.js";

const markerPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const statusDefinitions = [
  ["Draft", "backlog"], ["Todo", "unstarted"],
  ["Planning", "started"], ["Sealed", "started"], ["Executing", "started"], ["Verifying", "started"],
  ["In Progress", "started"], ["In Review", "started"], ["Needs Approval", "started"], ["Needs Info", "started"],
  ["Inconclusive", "started"], ["Escalated", "started"],
  ["Succeeded", "completed"], ["Changes Required", "completed"], ["Done", "completed"],
  ["Canceled", "canceled"], ["Failed", "canceled"],
] as const;
const nativeDuplicateDefinition = ["Duplicate", "canceled"] as const;
const rootStates = new Set(["Todo", "In Progress", "Needs Approval", "Needs Info", "In Review", "Done", "Canceled"]);
const cycleStates = new Set(["Draft", "Planning", "Sealed", "Executing", "Verifying", "Succeeded", "Changes Required", "Inconclusive", "Escalated", "Canceled"]);
const terminalCycleStates = new Set(["Succeeded", "Changes Required", "Canceled"]);

type Issue = LinearWorkflowTreeSnapshot["issues"][number];
type Comment = LinearWorkflowTreeSnapshot["comments"][number];
type Relation = LinearWorkflowTreeSnapshot["relations"][number];

export interface RootDagViewBuilderInput {
  tree: LinearWorkflowTreeSnapshot;
  git: GitWorkspaceSnapshot;
  workspace: GitWorkspace;
}

export class RootDagValidationError extends Error {
  constructor(readonly code: string) {
    super(`root_dag_${code}`);
    this.name = "RootDagValidationError";
  }
}

export class RootDagViewBuilder {
  build(input: RootDagViewBuilderInput): RootDagView {
    const { tree, git, workspace } = input;
    if (tree.root_issue_id.length === 0 || tree.observed_at.length === 0) fail("tree_identity_invalid");
    const statusById = validateStatusCatalog(tree.status_catalog);
    const issues = validateIssues(tree, statusById);
    const root = issues.find((issue) => issue.issue_id === tree.root_issue_id)!;
    const issueById = new Map(issues.map((issue) => [issue.issue_id, issue]));
    const issueMarkers = new Set(issues.flatMap((issue) => issue.managed_marker === undefined ? [] : [issue.managed_marker]));
    const recordsByIssue = readManagedRecords(tree.comments, issueById, tree.root_issue_id, issueMarkers);
    validateGit(git, workspace, root, recordsByIssue.get(root.issue_id) ?? []);
    const relations = validateRelations(tree.relations, issueById, tree.root_issue_id);
    validateDependencyCycles(relations, issueById);
    const children = childrenByParent(issues);
    const rootChildren = children.get(root.issue_id) ?? [];
    if (rootChildren.some((issue) => issue.issue_kind !== "cycle")) fail("root_child_kind_invalid");
    const cycles = rootChildren.map((issue) => buildCycle(issue, children, issueById, recordsByIssue, relations, tree.root_issue_id));
    const cycleKeys = new Set<string>();
    const nodeKeys = new Set<string>();
    for (const cycle of cycles) {
      if (cycleKeys.has(cycle.marker.cycleKey)) fail("duplicate_cycle_key");
      cycleKeys.add(cycle.marker.cycleKey);
      for (const node of cycle.nodes) {
        const key = `${cycle.issue.issue_id}:${node.marker.nodeKey}`;
        if (nodeKeys.has(key)) fail("duplicate_node_key");
        nodeKeys.add(key);
      }
    }
    if (cycles.filter(({ issue }) => !terminalCycleStates.has(issue.status_name)).length > 1) fail("multiple_active_cycles");
    const ownership = oneRecord(recordsByIssue.get(root.issue_id) ?? [], "root_ownership", "root_ownership_duplicate") as RootOwnershipRecord | undefined;
    validateRootHumanState(root, recordsByIssue.get(root.issue_id) ?? [], cycles);
    return {
      root: { issue: root, records: recordsByIssue.get(root.issue_id) ?? [], ...(ownership === undefined ? {} : { ownership }) },
      statusCatalog: tree.status_catalog.map((status) => ({ ...status })),
      cycles,
      relations: tree.relations.map((relation) => ({ ...relation })),
      git: { head: git.head, branch: git.branch, status: { ...git.status, items: [...git.status.items] } },
      observedAt: tree.observed_at,
    };
  }
}

export function buildRootDagView(input: RootDagViewBuilderInput): RootDagView {
  return new RootDagViewBuilder().build(input);
}

function validateStatusCatalog(catalog: LinearWorkflowTreeSnapshot["status_catalog"]) {
  if (catalog.length !== statusDefinitions.length + 1) fail("status_catalog_incomplete");
  const ids = new Set<string>();
  const names = new Set<string>();
  const byName = new Map<string, LinearWorkflowTreeSnapshot["status_catalog"][number]>();
  for (const status of catalog) {
    if (ids.has(status.status_id) || names.has(status.name)
      || !Number.isInteger(status.position) || status.position < 0) fail("status_catalog_ambiguous");
    ids.add(status.status_id); names.add(status.name);
    byName.set(status.name, status);
  }
  for (const [name, category] of statusDefinitions) {
    const status = byName.get(name);
    if (!status || status.category !== category) fail("status_catalog_incomplete");
  }
  const duplicate = byName.get(nativeDuplicateDefinition[0]);
  if (!duplicate || duplicate.category !== nativeDuplicateDefinition[1]) fail("status_catalog_incomplete");
  return new Map(catalog.map((status) => [status.status_id, status]));
}

function validateIssues(
  tree: LinearWorkflowTreeSnapshot,
  statusById: Map<string, LinearWorkflowTreeSnapshot["status_catalog"][number]>,
): Issue[] {
  const ids = new Set<string>();
  const markers = new Set<string>();
  let roots = 0;
  for (const issue of tree.issues) {
    if (ids.has(issue.issue_id)) fail("duplicate_issue_key");
    ids.add(issue.issue_id);
    if (!issue.issue_kind) fail("issue_kind_missing");
    const status = statusById.get(issue.status_id);
    if (!status || status.name !== issue.status_name || status.category !== issue.status_category || status.position !== issue.status_position) fail("issue_status_mismatch");
    if (issue.issue_kind === "root") roots += 1;
    if (issue.issue_kind !== "root") {
      if (!issue.managed_marker || !markerPattern.test(issue.managed_marker) || !issue.managed_marker.startsWith(`${tree.root_issue_id}:`) || issue.managed_marker.length <= tree.root_issue_id.length + 1) fail("managed_marker_invalid");
      if (markers.has(issue.managed_marker)) fail("duplicate_managed_marker");
      markers.add(issue.managed_marker);
    } else if (issue.managed_marker !== undefined) {
      if (!markerPattern.test(issue.managed_marker) || !issue.managed_marker.startsWith(`${tree.root_issue_id}:`) || issue.managed_marker.length <= tree.root_issue_id.length + 1) fail("managed_marker_invalid");
      if (markers.has(issue.managed_marker)) fail("duplicate_managed_marker");
      markers.add(issue.managed_marker);
    }
    const allowed = issue.issue_kind === "root" ? rootStates : issue.issue_kind === "cycle" ? cycleStates : issue.issue_kind === "plan"
      ? new Set(["Todo", "In Progress", "In Review", "Done", "Failed", "Canceled"])
      : new Set(["Todo", "In Progress", "Done", "Failed", "Canceled"]);
    if (!allowed.has(issue.status_name)) fail(`${issue.issue_kind}_status_invalid`);
    if (!Number.isInteger(issue.depth) || issue.depth < 0 || !Number.isInteger(issue.order)) fail("tree_order_invalid");
  }
  const root = tree.issues.find((issue) => issue.issue_id === tree.root_issue_id);
  if (!root || root.issue_kind !== "root" || roots !== 1 || root.depth !== 0 || root.parent_issue_id !== undefined) fail("root_scope_invalid");
  const byId = new Map(tree.issues.map((issue) => [issue.issue_id, issue]));
  const siblingOrders = new Set<string>();
  for (const issue of tree.issues) {
    if (issue.issue_id === root.issue_id) continue;
    if (!issue.parent_issue_id || !byId.has(issue.parent_issue_id)) fail("tree_parent_missing");
    const parent = byId.get(issue.parent_issue_id)!;
    if (issue.depth !== parent.depth + 1) fail("tree_depth_invalid");
    const siblingKey = `${issue.parent_issue_id}:${issue.order}`;
    if (siblingOrders.has(siblingKey)) fail("tree_order_ambiguous");
    siblingOrders.add(siblingKey);
  }
  return tree.issues;
}

function readManagedRecords(comments: Comment[], issueById: Map<string, Issue>, rootIssueId: string, occupiedMarkers: Set<string>): Map<string, ManagedRecord[]> {
  const result = new Map<string, ManagedRecord[]>();
  const commentsById = new Set<string>();
  for (const comment of comments) {
    if (commentsById.has(comment.comment_id) || !issueById.has(comment.issue_id)) fail("comment_scope_invalid");
    commentsById.add(comment.comment_id);
    if (!comment.managed_marker) {
      if (comment.body.startsWith("<!-- symphony managed-record")) fail("managed_record_invalid");
      continue;
    }
    const issueScopedManagedRecordMarker = `${comment.issue_id}:managed-record:${comment.comment_id}`;
    const rootScopedMarker = comment.managed_marker.startsWith(`${rootIssueId}:`) &&
      comment.managed_marker.length > rootIssueId.length + 1;
    if (!markerPattern.test(comment.managed_marker) ||
        (!rootScopedMarker && comment.managed_marker !== issueScopedManagedRecordMarker)) {
      fail("managed_marker_invalid");
    }
    if (occupiedMarkers.has(comment.managed_marker)) fail("duplicate_managed_marker");
    occupiedMarkers.add(comment.managed_marker);
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok) fail("managed_record_invalid");
    const record = parsed.value;
    const recordRootIssueId = recordRoot(record);
    if (recordRootIssueId !== undefined && recordRootIssueId !== rootIssueId) fail("managed_record_root_mismatch");
    const issue = issueById.get(comment.issue_id)!;
    if (!recordTargetMatches(record, issue) || !recordReferencesCurrentTree(record, issueById, issue)) fail(`${record.kind}_target_invalid`);
    const values = result.get(comment.issue_id) ?? [];
    values.push(record);
    result.set(comment.issue_id, values);
  }
  return result;
}

function recordTargetMatches(record: ManagedRecord, issue: Issue): boolean {
  if (record.kind === "root_ownership" || record.kind === "delivery") return issue.issue_kind === "root" && record.rootIssueId === issue.issue_id;
  if (record.kind === "cycle_marker") return issue.issue_kind === "cycle";
  if (record.kind === "plan_contract") return issue.issue_kind === "plan" && record.cycleIssueId === issue.parent_issue_id;
  if (record.kind === "node_marker") return issue.issue_kind === record.nodeKind && record.cycleIssueId === issue.parent_issue_id;
  if (record.kind === "stage_execution" || record.kind === "stage_terminal") return issue.issue_kind === record.stage && record.nodeIssueId === issue.issue_id && record.cycleIssueId === issue.parent_issue_id;
  if (record.kind === "work_completion") return issue.issue_kind === "work" && record.nodeIssueId === issue.issue_id && record.cycleIssueId === issue.parent_issue_id;
  if (record.kind === "human_action") return issue.issue_kind === "root";
  if (record.kind === "finding" || record.kind === "finding_disposition" || record.kind === "verify_result") return issue.issue_kind === "verify";
  if (record.kind === "progress_assessment") return issue.issue_kind === "cycle";
  return issue.issue_kind === "root";
}

function recordReferencesCurrentTree(record: ManagedRecord, issueById: Map<string, Issue>, issue: Issue): boolean {
  if (record.kind === "human_action") {
    const target = issueById.get(record.nodeIssueId);
    return target !== undefined && ["plan", "work", "verify"].includes(target.issue_kind ?? "")
      && target.parent_issue_id === record.cycleIssueId;
  }
  if (record.kind === "verify_result") {
    return issue.issue_kind === "verify" && record.nodeIssueId === issue.issue_id
      && issue.parent_issue_id === record.cycleIssueId;
  }
  return true;
}

function recordRoot(record: ManagedRecord): string | undefined {
  switch (record.kind) {
    case "root_ownership":
    case "delivery":
    case "cycle_marker":
    case "node_marker":
    case "plan_contract":
    case "stage_execution":
    case "stage_terminal":
    case "work_completion":
    case "human_action":
    case "verify_result":
    case "progress_assessment":
    case "convergence":
      return record.rootIssueId;
    case "finding":
    case "finding_disposition":
      return undefined;
  }
}

function buildCycle(
  issue: Issue,
  children: Map<string, Issue[]>,
  issueById: Map<string, Issue>,
  recordsByIssue: Map<string, ManagedRecord[]>,
  relations: Relation[],
  rootIssueId: string,
): RootCycleView {
  const cycleRecords = recordsByIssue.get(issue.issue_id) ?? [];
  const cycleMarker = oneRecord(cycleRecords, "cycle_marker", "cycle_marker_duplicate") as CycleMarker | undefined;
  if (!cycleMarker) fail("cycle_marker_missing");
  if (cycleMarker.rootIssueId !== rootIssueId) fail("cycle_marker_root_mismatch");
  const childrenOfCycle = children.get(issue.issue_id) ?? [];
  if (childrenOfCycle.some((child) => child.issue_kind === "human" || child.issue_kind === "root" || child.issue_kind === "cycle")) fail("cycle_child_kind_invalid");
  const planIssues = childrenOfCycle.filter((child) => child.issue_kind === "plan");
  if (planIssues.length !== 1) fail("plan_node_count_invalid");
  const nodeViews = childrenOfCycle.map((child) => buildNode(child, issue, recordsByIssue, relations, issueById, rootIssueId));
  const plan = nodeViews.find((node) => node.issue.issue_kind === "plan")!;
  const planContract = oneRecord(plan.records, "plan_contract", "plan_contract_duplicate") as PlanContract | undefined;
  validateCycleShape(issue, nodeViews, planContract);
  validatePlanContract(nodeViews, planContract, issue.issue_id, issue.status_name);
  return { issue, marker: cycleMarker, records: cycleRecords, nodes: nodeViews, ...(planContract === undefined ? {} : { planContract }) };
}

function buildNode(
  issue: Issue,
  cycle: Issue,
  recordsByIssue: Map<string, ManagedRecord[]>,
  relations: Relation[],
  issueById: Map<string, Issue>,
  rootIssueId: string,
): RootDagNodeView {
  if (issue.issue_kind !== "plan" && issue.issue_kind !== "work" && issue.issue_kind !== "verify") fail("node_kind_invalid");
  const records = recordsByIssue.get(issue.issue_id) ?? [];
  const marker = currentNodeMarker(records, issue.issue_kind);
  if (!marker) fail("node_marker_missing");
  if (marker.rootIssueId !== rootIssueId || marker.cycleIssueId !== cycle.issue_id || marker.nodeKind !== issue.issue_kind) fail("node_marker_target_invalid");
  const blockedByIssueIds = relations.flatMap((relation) => {
    if (relation.relation_kind === "blocks" && relation.target_issue_id === issue.issue_id) return [relation.source_issue_id];
    if (relation.relation_kind === "blocked_by" && relation.source_issue_id === issue.issue_id) return [relation.target_issue_id];
    return [];
  });
  for (const dependency of blockedByIssueIds) {
    const dependencyIssue = issueById.get(dependency);
    if (!dependencyIssue || dependencyIssue.parent_issue_id !== cycle.issue_id || dependencyIssue.issue_kind === "plan" && issue.issue_kind === "plan") fail("relation_scope_invalid");
  }
  return { issue, marker, records, blockedByIssueIds };
}

function validateCycleShape(issue: Issue, nodes: RootDagNodeView[], planContract?: PlanContract): void {
  const plan = nodes.find((node) => node.issue.issue_kind === "plan")!;
  const executionNodes = nodes.filter((node) => node.issue.issue_kind === "work" || node.issue.issue_kind === "verify");
  if (issue.status_name === "Draft") {
    if (executionNodes.length > 0 || plan.issue.status_name !== "Todo") fail("partial_cycle_materialization");
    return;
  }
  if (issue.status_name === "Planning") {
    if (!planContract && executionNodes.length > 0) fail("partial_cycle_materialization");
    if (!["Todo", "In Progress", "In Review", "Done"].includes(plan.issue.status_name)) fail("cycle_transition_invalid");
    return;
  }
  if (!planContract && issue.status_name !== "Canceled") fail("plan_contract_missing");
  if (issue.status_name !== "Canceled" && plan.issue.status_name !== "Done") fail("plan_transition_invalid");
  if (issue.status_name === "Sealed" && executionNodes.some((node) => node.issue.status_name !== "Todo")) fail("cycle_transition_invalid");
  if (issue.status_name === "Executing" && nodes.some((node) => node.issue.issue_kind === "verify" && node.issue.status_name !== "Todo")) fail("cycle_transition_invalid");
  if (issue.status_name === "Verifying" && executionNodes.some((node) => node.issue.issue_kind === "work" && node.issue.status_name !== "Done")) fail("cycle_transition_invalid");
  if (issue.status_name === "Inconclusive" && nodes.some((node) => node.issue.issue_kind === "verify" && node.issue.status_name !== "Done")) fail("cycle_transition_invalid");
  if (["Succeeded", "Changes Required"].includes(issue.status_name)
    && (nodes.some((node) => node.issue.status_name !== "Done") || !nodes.some((node) => node.issue.issue_kind === "verify"))) fail("cycle_terminal_state_invalid");
}

function validatePlanContract(nodes: RootDagNodeView[], contract: PlanContract | undefined, cycleIssueId: string, cycleState: string): void {
  if (!contract) return;
  if (contract.cycleIssueId !== cycleIssueId) fail("plan_contract_target_invalid");
  const plan = nodes.find((node) => node.issue.issue_kind === "plan")!;
  // The append-only Bootstrap Plan marker cannot know the Performer result yet.
  // T8 must replace this placeholder before the Cycle can leave Planning.
  if (cycleState === "Planning" && plan.marker.planContractDigest === "pending-plan-contract") return;
  if (plan.marker.planContractDigest !== contract.planContractDigest) fail("plan_contract_digest_mismatch");
  if (plan.marker.nodeKey !== "plan-1") fail("plan_contract_node_mismatch");
  const workKeys = new Set(contract.workNodes.map((node) => node.workKey));
  if (workKeys.size !== contract.workNodes.length) fail("plan_contract_duplicate_key");
  for (const node of nodes) {
    if (node.marker.planContractDigest !== contract.planContractDigest) fail("node_plan_contract_digest_mismatch");
    if (node.issue.issue_kind === "work" && !workKeys.has(node.marker.nodeKey)) fail("plan_contract_node_mismatch");
  }
  if (cycleState === "Draft") return;
  if (cycleState === "Planning" && plan.issue.status_name !== "Done") return;
  const workNodes = nodes.filter((node) => node.issue.issue_kind === "work");
  const verifyNodes = nodes.filter((node) => node.issue.issue_kind === "verify");
  if (workNodes.length !== contract.workNodes.length || verifyNodes.length !== 1) fail("plan_contract_node_count_mismatch");
  const nodeByKey = new Map(nodes.filter((node) => node.issue.issue_kind !== "plan").map((node) => [node.marker.nodeKey, node]));
  const expectedKeys = new Set([...contract.workNodes.map((node) => node.workKey), "verify-1"]);
  if (nodeByKey.size !== expectedKeys.size || [...expectedKeys].some((key) => !nodeByKey.has(key))) fail("plan_contract_node_mismatch");
  for (const workContract of contract.workNodes) {
    const work = nodeByKey.get(workContract.workKey);
    const expectedDependencyIds = new Set([plan.issue.issue_id]);
    if (workContract.dependencyWorkKeys.some((dependencyKey) => !nodeByKey.has(dependencyKey))) fail("plan_dependency_relation_missing");
    for (const dependencyKey of workContract.dependencyWorkKeys) expectedDependencyIds.add(nodeByKey.get(dependencyKey)!.issue.issue_id);
    if (!work || work.blockedByIssueIds.length !== expectedDependencyIds.size || [...expectedDependencyIds].some((dependencyId) => !work.blockedByIssueIds.includes(dependencyId))) fail("plan_dependency_relation_missing");
  }
  const verify = nodes.find((node) => node.issue.issue_kind === "verify");
  if (!verify || verify.blockedByIssueIds.length !== workNodes.length || workNodes.some((work) => !verify.blockedByIssueIds.includes(work.issue.issue_id))) fail("verify_dependency_relation_missing");
}

function validateRelations(relations: Relation[], issueById: Map<string, Issue>, rootIssueId: string): Relation[] {
  const ids = new Set<string>();
  const edges = new Set<string>();
  for (const relation of relations) {
    if (ids.has(relation.relation_id) || relation.source_issue_id === relation.target_issue_id) fail("relation_invalid");
    ids.add(relation.relation_id);
    const source = issueById.get(relation.source_issue_id);
    const target = issueById.get(relation.target_issue_id);
    if (!source || !target || source.issue_id === rootIssueId || target.issue_id === rootIssueId) fail("relation_scope_invalid");
    if (relation.relation_kind === "triggered_by") {
      if (source.issue_kind !== "cycle" || target.issue_kind !== "cycle") fail("relation_scope_invalid");
      const key = `triggered_by:${source.issue_id}:${target.issue_id}`;
      if (edges.has(key)) fail("relation_conflict");
      edges.add(key);
      continue;
    }
    if (source.issue_kind === "cycle" || target.issue_kind === "cycle" || source.parent_issue_id !== target.parent_issue_id) fail("relation_scope_invalid");
    const blocker = relation.relation_kind === "blocks" ? source.issue_id : target.issue_id;
    const blocked = relation.relation_kind === "blocks" ? target.issue_id : source.issue_id;
    const key = `blocks:${blocker}:${blocked}`;
    if (edges.has(key)) fail("relation_conflict");
    edges.add(key);
  }
  for (const relation of relations) {
    if (relation.relation_kind === "triggered_by") continue;
    const source = issueById.get(relation.source_issue_id)!;
    const target = issueById.get(relation.target_issue_id)!;
    if (source.issue_kind === "plan" && target.issue_kind === "plan") fail("relation_scope_invalid");
  }
  return relations;
}

function validateDependencyCycles(relations: Relation[], issueById: Map<string, Issue>): void {
  const graph = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.relation_kind === "triggered_by") continue;
    const blocker = relation.relation_kind === "blocks" ? relation.source_issue_id : relation.target_issue_id;
    const blocked = relation.relation_kind === "blocks" ? relation.target_issue_id : relation.source_issue_id;
    const edges = graph.get(blocker) ?? [];
    edges.push(blocked);
    graph.set(blocker, edges);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (issueId: string): void => {
    if (visiting.has(issueId)) fail("relation_cycle");
    if (visited.has(issueId)) return;
    visiting.add(issueId);
    for (const next of graph.get(issueId) ?? []) visit(next);
    visiting.delete(issueId);
    visited.add(issueId);
  };
  for (const issue of issueById.values()) visit(issue.issue_id);
}

function validateRootHumanState(root: Issue, rootRecords: ManagedRecord[], cycles: RootCycleView[]): void {
  const actions = rootRecords.filter((record) => record.kind === "human_action");
  if (["Needs Approval", "Needs Info"].includes(root.status_name)) {
    const expected = root.status_name === "Needs Approval" ? "needs_approval" : "needs_info";
    if (actions.filter((action) => action.requestKind === expected).length !== 1) fail("pending_human_action_mismatch");
  }
  const activeCycle = cycles.find((cycle) => !terminalCycleStates.has(cycle.issue.status_name));
  if (activeCycle && root.status_name === "Todo") fail("root_cycle_state_conflict");
  if (activeCycle && root.status_name === "In Review") fail("root_cycle_state_conflict");
  const planInReview = activeCycle?.nodes.find((node) => node.issue.issue_kind === "plan" && node.issue.status_name === "In Review");
  if (planInReview && (!["Needs Approval", "In Progress"].includes(root.status_name)
    || !actions.some((action) => action.requestKind === "needs_approval" && action.nodeIssueId === planInReview.issue.issue_id))) fail("pending_human_action_mismatch");
  if (["Needs Approval", "Needs Info"].includes(root.status_name)) {
    const actionCycle = activeCycle ?? cycles.find((cycle) => actions.some((action) => action.cycleIssueId === cycle.issue.issue_id));
    if (!actionCycle) fail("pending_human_action_mismatch");
  }
}

function validateGit(git: GitWorkspaceSnapshot, workspace: GitWorkspace, root: Issue, rootRecords: ManagedRecord[]): void {
  if (!git.head || !git.branch || git.branch !== workspace.branch || workspace.rootIssueId !== undefined && workspace.rootIssueId !== root.issue_id) fail("git_identity_conflict");
  if (git.status.partial || git.status.has_more || git.status.returned !== git.status.items.length || git.status.cap < git.status.returned) fail("git_status_incomplete");
  const ownership = oneRecord(rootRecords, "root_ownership", "root_ownership_duplicate") as RootOwnershipRecord | undefined;
  if (ownership && ownership.deliveryBranch !== git.branch) fail("git_identity_conflict");
}

function childrenByParent(issues: Issue[]): Map<string, Issue[]> {
  const result = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.parent_issue_id) continue;
    const children = result.get(issue.parent_issue_id) ?? [];
    children.push(issue);
    result.set(issue.parent_issue_id, children);
  }
  for (const children of result.values()) children.sort((left, right) => left.order - right.order || left.issue_id.localeCompare(right.issue_id));
  return result;
}

function oneRecord(records: ManagedRecord[], kind: ManagedRecord["kind"], duplicateCode: string): ManagedRecord | undefined {
  const matches = records.filter((record) => record.kind === kind);
  if (matches.length > 1) fail(duplicateCode);
  return matches[0];
}

export function currentNodeMarker(records: ManagedRecord[], nodeKind: NodeMarker["nodeKind"] = "plan"): NodeMarker | undefined {
  const markers = records.filter((record): record is NodeMarker => record.kind === "node_marker");
  if (markers.length === 0) return undefined;
  if (nodeKind !== "plan") {
    if (markers.length > 1) fail("node_marker_duplicate");
    return markers[0];
  }
  const resolved = markers.filter((marker) => marker.planContractDigest !== "pending-plan-contract");
  const pending = markers.filter((marker) => marker.planContractDigest === "pending-plan-contract");
  if (resolved.length > 1 || pending.length > 1) fail("node_marker_duplicate");
  if (resolved.length === 1) return resolved[0];
  return pending[0];
}

function fail(code: string): never {
  throw new RootDagValidationError(code);
}
