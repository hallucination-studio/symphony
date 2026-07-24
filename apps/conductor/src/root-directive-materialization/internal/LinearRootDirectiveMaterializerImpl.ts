import type { LinearGatewayInterface, LinearWorkflowMutationCommand } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { HumanActionMaterializerInterface } from "../../human-actions/api/HumanActionMaterializerInterface.js";
import type {
  RootDirective,
  RootReconciliationView,
  TreeOperation,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type {
  RootDirectiveMaterializationResult,
  RootDirectiveMaterializerInterface,
} from "../api/RootDirectiveMaterializerInterface.js";

export class LinearRootDirectiveMaterializerImpl implements RootDirectiveMaterializerInterface {
  constructor(
    private readonly linear: LinearGatewayInterface,
    private readonly humanActions: HumanActionMaterializerInterface,
  ) {}

  async materialize(input: { directive: RootDirective; view: RootReconciliationView }): Promise<RootDirectiveMaterializationResult> {
    const { directive, view } = input;
    if (directive.basedOnTargetRootDigest !== view.treeDigest) return failed(directive, "root_directive_stale_tree");
    const action = directive.action;
    if (action.kind === "request_human_action") {
      const result = await this.humanActions.materialize({ directive: action, rootDirectiveId: directive.rootDirectiveId, view });
      return result.kind === "materialized"
        ? { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [result.actionIssueId] }
        : failed(directive, result.code);
    }
    if (["execute_plan", "execute_work", "execute_verify", "rerun_stage"].includes(action.kind)) {
      return failed(directive, "stage_directive_requires_result_materializer");
    }
    if (action.kind === "revise_root_tree") return this.applyTreeOperations(directive, view, action.operations);
    if (action.kind === "replan_current_cycle") return this.applyTreeOperations(directive, view, action.archiveOrRestoreOperations);
    if (action.kind === "supersede_cycle" || action.kind === "create_cycle") {
      return failed(directive, "successor_cycle_requires_cycle_result_contract");
    }
    if (action.kind === "conclude_cycle") return this.concludeCycle(directive, view, action);
    if (action.kind === "wait" || action.kind === "acknowledge") {
      return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [] };
    }
    if (action.kind === "conclude_root" || action.kind === "cancel_root") return failed(directive, "root_lifecycle_requires_status_materializer");
    return failed(directive, "root_directive_action_unsupported");
  }

  private async concludeCycle(
    directive: RootDirective,
    view: RootReconciliationView,
    action: Extract<RootDirective["action"], { kind: "conclude_cycle" }>,
  ): Promise<RootDirectiveMaterializationResult> {
    const cycle = view.tree.issues.find((issue) =>
      issue.issue_id === action.cycleIssueId &&
      issue.parent_issue_id === view.root.issueId &&
      issue.issue_kind === "cycle" &&
      !issue.is_archived,
    );
    if (!cycle) return failed(directive, "cycle_conclusion_target_invalid");
    const statusName = action.conclusion === "succeeded"
      ? "Succeeded"
      : action.conclusion === "canceled" ? "Canceled" : "Changes Required";
    return this.applyStatusChange(directive, view, cycle, statusName, "cycle_conclusion");
  }

  private async applyStatusChange(
    directive: RootDirective,
    view: RootReconciliationView,
    target: RootReconciliationView["tree"]["issues"][number],
    statusName: string,
    failurePrefix: string,
  ): Promise<RootDirectiveMaterializationResult> {
    const status = view.tree.status_catalog.find(({ name }) => name === statusName);
    if (!status) return failed(directive, `${failurePrefix}_status_missing`);
    const outcome = await this.linear.mutateWorkflow(updateIssueCommand(view, directive, target, status.status_id));
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      return failed(directive, `${failurePrefix}_${outcome.kind}`);
    }
    const readBack = await this.linear.readWorkflowIssueTree(view.root.issueId);
    const updated = readBack.issues.find(({ issue_id }) => issue_id === target.issue_id);
    if (!updated || updated.status_id !== status.status_id || updated.status_name !== status.name) {
      return failed(directive, `${failurePrefix}_read_back_invalid`);
    }
    return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [target.issue_id] };
  }

  private async applyTreeOperations(
    directive: RootDirective,
    view: RootReconciliationView,
    operations: TreeOperation[],
  ): Promise<RootDirectiveMaterializationResult> {
    if (operations.length === 0) return failed(directive, "tree_operation_count_invalid");
    for (const operation of operations) {
      const command = operationCommand(view, directive, operation);
      if (!command) return failed(directive, `cycle_tree_operation_${operation.kind}_unsupported`);
      const outcome = await this.linear.mutateWorkflow(command);
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return failed(directive, `cycle_tree_operation_${operation.kind}_${outcome.kind}`);
    }
    return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: operations.flatMap((operation) => {
      if (operation.kind === "create_relation") return [operation.sourceIssueId, operation.targetIssueId];
      if (operation.kind === "reorder_nodes" || operation.kind === "replace_dependencies") return [operation.precondition.targetIssueId];
      return [operation.precondition.targetIssueId];
    }) };
  }
}

function updateIssueCommand(
  view: RootReconciliationView,
  directive: RootDirective,
  target: RootReconciliationView["tree"]["issues"][number],
  statusId: string,
): LinearWorkflowMutationCommand {
  return {
    kind: "update_workflow_issue",
    writeId: `${directive.rootDirectiveId}:${target.issue_id}`,
    expectedProjectId: target.project_id,
    rootIssueId: view.root.issueId,
    expectedRootRemoteVersion: rootIssue(view, view.root.issueId).remote_version,
    target: { targetIssueId: target.issue_id, expectedRemoteVersion: target.remote_version, expectedStatusId: target.status_id },
    statusId,
    title: target.title,
    description: target.description,
  };
}

function operationCommand(
  view: RootReconciliationView,
  directive: RootDirective,
  operation: TreeOperation,
): LinearWorkflowMutationCommand | undefined {
  const root = rootIssue(view, view.root.issueId);
  if (operation.kind === "create_node") {
    const status = view.tree.status_catalog.find(({ name }) => name === "Todo");
    if (!status) return undefined;
    const parent = view.tree.issues.find((issue) => issue.issue_id === operation.parentIssueId);
    if (
      !parent ||
      operation.precondition.targetIssueId !== parent.issue_id ||
      parent.remote_version !== operation.precondition.expectedRemoteVersion
    ) return undefined;
    return {
      kind: "create_workflow_issue",
      writeId: `${directive.rootDirectiveId}:${operation.parentIssueId}:${operation.title}`,
      expectedProjectId: parent.project_id,
      rootIssueId: view.root.issueId,
      expectedRootRemoteVersion: root.remote_version,
      parentExpectedRemoteVersion: parent.remote_version,
      parentExpectedStatusId: parent.status_id,
      parentIssueId: operation.parentIssueId,
      issueKind: operation.issueKind === "human_action" ? "human" : operation.issueKind,
      title: operation.title,
      description: operation.description,
      statusId: status.status_id,
      managedMarker: `${directive.rootDirectiveId}:${operation.parentIssueId}:${operation.title}`,
      labelNames: [],
    };
  }
  if (operation.kind === "update_node") {
    const target = view.tree.issues.find((issue) => issue.issue_id === operation.precondition.targetIssueId);
    if (
      !target ||
      target.remote_version !== operation.precondition.expectedRemoteVersion ||
      (operation.precondition.expectedParentIssueId !== undefined && target.parent_issue_id !== operation.precondition.expectedParentIssueId)
    ) return undefined;
    const status = view.tree.status_catalog.find(({ name }) => name === operation.status);
    if (!status) return undefined;
    return {
      kind: "update_workflow_issue", writeId: `${directive.rootDirectiveId}:${target.issue_id}`,
      expectedProjectId: target.project_id, rootIssueId: view.root.issueId, expectedRootRemoteVersion: root.remote_version,
      target: { targetIssueId: target.issue_id, expectedRemoteVersion: operation.precondition.expectedRemoteVersion, ...(operation.precondition.expectedStatus ? { expectedStatusId: target.status_id } : {}) },
      statusId: status.status_id,
      title: operation.title, description: operation.description,
    };
  }
  if (operation.kind === "archive_node" || operation.kind === "restore_node") {
    const target = view.tree.issues.find((issue) => issue.issue_id === operation.precondition.targetIssueId);
    if (!target || target.remote_version !== operation.precondition.expectedRemoteVersion) return undefined;
    return {
      kind: operation.kind === "archive_node" ? "archive_workflow_issue" : "restore_workflow_issue",
      writeId: `${directive.rootDirectiveId}:${target.issue_id}:${operation.kind}`,
      expectedProjectId: target.project_id,
      rootIssueId: view.root.issueId,
      expectedRootRemoteVersion: root.remote_version,
      target: { targetIssueId: target.issue_id, expectedRemoteVersion: target.remote_version, expectedIsArchived: target.is_archived },
    };
  }
  if (operation.kind !== "create_relation") return undefined;
  if (operation.relationKind === "relates_to") return undefined;
  const source = view.tree.issues.find((issue) => issue.issue_id === operation.sourceIssueId);
  const target = view.tree.issues.find((issue) => issue.issue_id === operation.targetIssueId);
  if (!source || !target) return undefined;
  return {
    kind: "create_workflow_relation", writeId: `${directive.rootDirectiveId}:${source.issue_id}:${target.issue_id}`,
    expectedProjectId: source.project_id, rootIssueId: view.root.issueId, expectedRootRemoteVersion: root.remote_version,
    sourceIssueId: source.issue_id, sourceExpectedRemoteVersion: source.remote_version,
    targetIssueId: target.issue_id, targetExpectedRemoteVersion: target.remote_version, relationKind: operation.relationKind,
  };
}

function rootIssue(view: RootReconciliationView, issueId: string) {
  const root = view.tree.issues.find((issue) => issue.issue_id === issueId);
  if (!root) throw new Error("root_directive_root_missing");
  return root;
}

function failed(directive: RootDirective, code: string): RootDirectiveMaterializationResult {
  return { kind: "failed", rootDirectiveId: directive.rootDirectiveId, code, sanitizedReason: code };
}
