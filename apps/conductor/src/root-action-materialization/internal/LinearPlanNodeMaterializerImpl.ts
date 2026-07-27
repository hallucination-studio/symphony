import type {
  LinearGatewayInterface,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootDirective,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootActionMaterializationResult } from "../api/RootActionMaterializerInterface.js";

type MaterializePlanNodeAction = Extract<RootDirective["action"], { kind: "materialize_plan_node" }>;
type Node = LinearWorkflowTreeSnapshot["issues"][number];

interface PlanNodeFacts {
  root: Node;
  cycle: Node;
  plan: Node;
  dependencies: Node[];
}

export class LinearPlanNodeMaterializerImpl {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async materialize(input: {
    directive: RootDirective;
    view: RootReconciliationView;
  }): Promise<RootActionMaterializationResult> {
    const action = input.directive.action;
    if (action.kind !== "materialize_plan_node") return failed(input.directive, "plan_node_action_invalid");
    const facts = validateFacts(input.view, action);
    if (typeof facts === "string") return failed(input.directive, facts);

    let view = input.view;
    let matches = matchingNodes(view.tree, action);
    if (matches.length > 1) return failed(input.directive, "plan_node_create_ambiguous");
    if (matches.length === 0) {
      if (facts.cycle.status_name === "Sealed" || facts.plan.status_name === "Done") {
        return failed(input.directive, "plan_node_terminal_graph_incomplete");
      }
      if (hasConflictingNode(view.tree, action)) return failed(input.directive, "plan_node_postcondition_conflict");
      const todo = view.tree.status_catalog.find(({ name }) => name === "Todo");
      if (!todo) return failed(input.directive, "plan_node_todo_status_missing");
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_workflow_issue",
        writeId: `${input.directive.rootDirectiveId}:create-node`,
        expectedProjectId: facts.root.project_id,
        rootIssueId: facts.root.issue_id,
        expectedRootRemoteVersion: facts.root.remote_version,
        parentExpectedRemoteVersion: facts.cycle.remote_version,
        parentExpectedStatusId: facts.cycle.status_id,
        parentIssueId: facts.cycle.issue_id,
        title: action.title,
        description: action.description,
        statusId: todo.status_id,
        labelNames: [primaryLabel(action.nodeKind)],
        order: action.order,
      });
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
        return failed(input.directive, `plan_node_create_${outcome.kind}`);
      }
      view = await refreshView(this.linear, view);
      matches = matchingNodes(view.tree, action);
      if (matches.length > 1) return failed(input.directive, "plan_node_create_ambiguous");
      if (matches.length === 0) return failed(input.directive, `plan_node_create_${outcome.kind}`);
    }

    const node = matches[0]!;
    const related = await ensureRelation(
      this.linear,
      input.directive,
      view,
      facts.plan.issue_id,
      node.issue_id,
      "relates_to",
      "plan",
    );
    if (typeof related === "string") return failed(input.directive, related);
    view = related;
    for (const dependency of facts.dependencies) {
      const blocked = await ensureRelation(
        this.linear,
        input.directive,
        view,
        dependency.issue_id,
        node.issue_id,
        "blocks",
        `dependency:${dependency.issue_id}`,
      );
      if (typeof blocked === "string") return failed(input.directive, blocked);
      view = blocked;
    }

    return {
      kind: "materialized",
      rootDirectiveId: input.directive.rootDirectiveId,
      sourceIssueIds: [facts.cycle.issue_id, facts.plan.issue_id, node.issue_id, ...facts.dependencies.map(({ issue_id }) => issue_id)],
    };
  }
}

function validateFacts(view: RootReconciliationView, action: MaterializePlanNodeAction): PlanNodeFacts | string {
  const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
  const cycle = view.tree.issues.find(({ issue_id }) => issue_id === action.cycleIssueId);
  const plan = view.tree.issues.find(({ issue_id }) => issue_id === action.planIssueId);
  if (!root || !cycle || !plan) return "plan_node_target_missing";
  if (
    cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
    cycle.remote_version !== action.expectedCycleRemoteVersion ||
    (cycle.status_name !== "Planning" && cycle.status_name !== "Sealed")
  ) return "plan_node_cycle_invalid";
  if (
    plan.issue_kind !== "plan" || plan.parent_issue_id !== cycle.issue_id || plan.is_archived ||
    plan.remote_version !== action.expectedPlanRemoteVersion ||
    (plan.status_name !== "In Review" && plan.status_name !== "Done")
  ) return "plan_node_plan_invalid";

  const request = view.tree.comments.find(({ comment_id }) => comment_id === action.approvalRequestCommentId);
  if (
    !request || request.issue_id !== root.issue_id || request.parent_comment_id !== undefined ||
    request.thread_root_comment_id !== request.comment_id || request.author_kind !== "symphony" ||
    request.remote_version !== action.expectedApprovalRequestRemoteVersion ||
    !request.body.startsWith("## 需要你审批") || !request.body.includes(plan.identifier)
  ) return "plan_node_approval_request_invalid";
  const reply = view.tree.comments.find(({ comment_id }) => comment_id === action.approvalReplyCommentId);
  if (
    !reply || reply.issue_id !== root.issue_id || reply.parent_comment_id !== request.comment_id ||
    reply.thread_root_comment_id !== request.comment_id || reply.author_kind !== "human" ||
    !reply.author_user_id || reply.author_id !== reply.author_user_id || !reply.body.trim() ||
    reply.remote_version !== action.expectedApprovalReplyRemoteVersion
  ) return "plan_node_approval_reply_invalid";

  const dependencies = action.dependencyIssueIds.map((issueId) =>
    view.tree.issues.find(({ issue_id }) => issue_id === issueId));
  if (dependencies.some((dependency) =>
    !dependency || dependency.issue_kind !== "work" || dependency.parent_issue_id !== cycle.issue_id || dependency.is_archived
  )) return "plan_node_dependency_invalid";
  return { root, cycle, plan, dependencies: dependencies as Node[] };
}

function matchingNodes(tree: LinearWorkflowTreeSnapshot, action: MaterializePlanNodeAction): Node[] {
  return tree.issues.filter((issue) =>
    issue.parent_issue_id === action.cycleIssueId && issue.issue_kind === action.nodeKind &&
    !issue.is_archived && issue.status_name === "Todo" && issue.title === action.title &&
    issue.description === action.description && issue.order === action.order,
  );
}

function hasConflictingNode(tree: LinearWorkflowTreeSnapshot, action: MaterializePlanNodeAction): boolean {
  return tree.issues.some((issue) =>
    issue.parent_issue_id === action.cycleIssueId && !issue.is_archived &&
    (issue.order === action.order || (issue.issue_kind === action.nodeKind && issue.title === action.title)),
  );
}

async function ensureRelation(
  linear: LinearGatewayInterface,
  directive: RootDirective,
  initialView: RootReconciliationView,
  sourceIssueId: string,
  targetIssueId: string,
  relationKind: "blocks" | "relates_to",
  suffix: string,
): Promise<RootReconciliationView | string> {
  const matches = initialView.tree.relations.filter((relation) =>
    relation.relation_kind === relationKind && relation.source_issue_id === sourceIssueId && relation.target_issue_id === targetIssueId,
  );
  if (matches.length > 1) return "plan_node_relation_ambiguous";
  if (matches.length === 1) return initialView;
  const root = requiredIssue(initialView.tree, initialView.root.issueId);
  const source = requiredIssue(initialView.tree, sourceIssueId);
  const target = requiredIssue(initialView.tree, targetIssueId);
  const outcome = await linear.mutateWorkflow({
    kind: "create_workflow_relation",
    writeId: `${directive.rootDirectiveId}:relation:${suffix}`,
    expectedProjectId: root.project_id,
    rootIssueId: root.issue_id,
    expectedRootRemoteVersion: root.remote_version,
    sourceIssueId,
    sourceExpectedRemoteVersion: source.remote_version,
    targetIssueId,
    targetExpectedRemoteVersion: target.remote_version,
    relationKind,
    relationState: "present",
  });
  if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") return `plan_node_relation_${outcome.kind}`;
  const view = await refreshView(linear, initialView);
  const readBack = view.tree.relations.filter((relation) =>
    relation.relation_kind === relationKind && relation.source_issue_id === sourceIssueId && relation.target_issue_id === targetIssueId,
  );
  if (readBack.length > 1) return "plan_node_relation_ambiguous";
  return readBack.length === 1 ? view : `plan_node_relation_${outcome.kind}`;
}

function requiredIssue(tree: LinearWorkflowTreeSnapshot, issueId: string): Node {
  const issue = tree.issues.find(({ issue_id }) => issue_id === issueId);
  if (!issue) throw new Error("plan_node_issue_missing");
  return issue;
}

async function refreshView(linear: LinearGatewayInterface, view: RootReconciliationView): Promise<RootReconciliationView> {
  const tree = await linear.readWorkflowIssueTree(view.root.issueId);
  return { ...view, tree, observedAt: tree.observed_at };
}

function primaryLabel(kind: "work" | "verify"): "Work" | "Verify" {
  return kind === "work" ? "Work" : "Verify";
}

function failed(directive: RootDirective, code: string): RootActionMaterializationResult {
  return { kind: "failed", rootDirectiveId: directive.rootDirectiveId, code, sanitizedReason: code };
}
