import type { LinearGatewayInterface, LinearWorkflowMutationCommand } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { HumanActionMaterializerInterface } from "../../human-actions/api/HumanActionMaterializerInterface.js";
import type {
  CycleTreeOperation,
  RootDirective,
  RootReconciliationView,
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
    if (directive.basedOnRootTreeDigest !== view.treeDigest) return failed(directive, "root_directive_stale_tree");
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
    if (action.kind === "resolve_invalid_lifecycle") return this.applyLifecycle(directive, view, action.changes);
    if (action.kind === "revise_cycle_tree") return this.applyTreeOperations(directive, view, action.cycleIssueId, action.operations);
    if (action.kind === "replan_current_cycle") return this.applyTreeOperations(directive, view, action.cycleIssueId, action.archiveOrRestoreOperations);
    if (action.kind === "supersede_cycle" || action.kind === "create_successor_cycle") {
      return failed(directive, "successor_cycle_requires_cycle_result_contract");
    }
    if (action.kind === "conclude_cycle" || action.kind === "conclude_root" || action.kind === "wait" || action.kind === "acknowledge") {
      return failed(directive, "lifecycle_directive_requires_status_materializer");
    }
    return failed(directive, "root_directive_action_unsupported");
  }

  private async applyLifecycle(
    directive: RootDirective,
    view: RootReconciliationView,
    changes: Extract<RootDirective["action"], { kind: "resolve_invalid_lifecycle" }>["changes"],
  ): Promise<RootDirectiveMaterializationResult> {
    const change = changes[0];
    if (!change || changes.length !== 1) return failed(directive, "lifecycle_change_count_invalid");
    const target = view.tree.issues.find((issue) => issue.issue_id === change.targetIssueId);
    const status = view.tree.status_catalog.find(({ name }) => name === change.requestedStatus);
    if (!target || !status || target.remote_version !== change.expectedRemoteVersion) return failed(directive, "lifecycle_change_precondition_invalid");
    const outcome = await this.linear.mutateWorkflow(updateIssueCommand(view, directive, target, status.status_id));
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return failed(directive, `lifecycle_change_${outcome.kind}`);
    return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [target.issue_id] };
  }

  private async applyTreeOperations(
    directive: RootDirective,
    view: RootReconciliationView,
    cycleIssueId: string,
    operations: CycleTreeOperation[],
  ): Promise<RootDirectiveMaterializationResult> {
    const cycle = view.tree.issues.find((issue) => issue.issue_id === cycleIssueId && issue.parent_issue_id === view.root.issueId);
    if (!cycle || operations.length === 0) return failed(directive, "cycle_tree_target_invalid");
    for (const operation of operations) {
      const command = operationCommand(view, directive, cycleIssueId, operation);
      if (!command) return failed(directive, `cycle_tree_operation_${operation.kind}_unsupported`);
      const outcome = await this.linear.mutateWorkflow(command);
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return failed(directive, `cycle_tree_operation_${operation.kind}_${outcome.kind}`);
    }
    return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [cycleIssueId] };
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
  cycleIssueId: string,
  operation: CycleTreeOperation,
): LinearWorkflowMutationCommand | undefined {
  const cycle = view.tree.issues.find((issue) => issue.issue_id === cycleIssueId);
  if (!cycle) return undefined;
  const root = rootIssue(view, view.root.issueId);
  if (operation.kind === "create_node") {
    const status = view.tree.status_catalog.find(({ name }) => name === "Todo");
    if (!status) return undefined;
    return {
      kind: "create_workflow_issue",
      writeId: `${directive.rootDirectiveId}:${operation.issueId}`,
      expectedProjectId: cycle.project_id,
      rootIssueId: view.root.issueId,
      expectedRootRemoteVersion: root.remote_version,
      parentExpectedRemoteVersion: cycle.remote_version,
      parentExpectedStatusId: cycle.status_id,
      parentIssueId: cycleIssueId,
      issueKind: operation.issueKind,
      title: operation.title,
      description: operation.description,
      statusId: status.status_id,
      managedMarker: `${directive.rootDirectiveId}:${operation.issueId}`,
      order: operation.order,
    };
  }
  if (operation.kind === "update_node") {
    const target = view.tree.issues.find((issue) => issue.issue_id === operation.issueId);
    if (!target) return undefined;
    return {
      kind: "update_workflow_issue", writeId: `${directive.rootDirectiveId}:${operation.issueId}`,
      expectedProjectId: target.project_id, rootIssueId: view.root.issueId, expectedRootRemoteVersion: root.remote_version,
      target: { targetIssueId: target.issue_id, expectedRemoteVersion: operation.expectedRemoteVersion, expectedParentIssueId: cycleIssueId },
      statusId: target.status_id, title: operation.title, description: operation.description,
    };
  }
  if (operation.kind === "reorder_node") {
    return undefined;
  }
  if (operation.kind === "archive_node" || operation.kind === "restore_node" || operation.kind === "remove_relation") return undefined;
  if (operation.kind === "replace_dependencies") return undefined;
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
