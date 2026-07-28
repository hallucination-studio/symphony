import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { GitWorkspaceProvisionerInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface, LinearWorkflowMutationCommand } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import type { HumanActionMaterializerInterface } from "../../human-actions/api/HumanActionMaterializerInterface.js";
import type { RootDeliveryInterface } from "../../root-delivery/api/RootDeliveryInterface.js";
import type {
  RootDirective,
  RootReconciliationView,
  TreeOperation,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type {
  RootActionFailureDiagnostic,
  RootActionMaterializationResult,
  RootActionMaterializerInterface,
} from "../api/RootActionMaterializerInterface.js";
import { LinearPlanNodeMaterializerImpl } from "./LinearPlanNodeMaterializerImpl.js";

export class LinearGitRootActionMaterializerImpl implements RootActionMaterializerInterface {
  constructor(
    private readonly linear: LinearGatewayInterface,
    private readonly humanActions: HumanActionMaterializerInterface,
    private readonly git: GitWorkspaceProvisionerInterface,
    private readonly baseBranch: string,
    private readonly delivery: RootDeliveryInterface,
  ) {}

  async materialize(input: { directive: RootDirective; view: RootReconciliationView }): Promise<RootActionMaterializationResult> {
    const { directive, view } = input;
    if (directive.basedOnTargetRootDigest !== view.treeDigest) return failed(directive, "root_directive_stale_tree");
    const action = directive.action;
    if (action.kind === "create_human_action") {
      const result = await this.humanActions.materialize({ action, rootDirectiveId: directive.rootDirectiveId, view });
      return result.kind === "materialized"
        ? { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [view.root.issueId] }
        : failed(directive, result.code);
    }
    if (["execute_plan", "execute_work", "execute_verify", "rerun_stage"].includes(action.kind)) {
      return failed(directive, "stage_directive_requires_result_materializer");
    }
    if (action.kind === "create_root_workspace") {
      if (action.rootIssueId !== view.root.issueId) return failed(directive, "root_workspace_root_mismatch");
      const root = view.tree.issues.find((issue) => issue.issue_id === view.root.issueId);
      if (!root || root.remote_version !== action.expectedRootRemoteVersion) {
        return failed(directive, "root_workspace_root_version_stale");
      }
      if (
        (view.worktreeGate.kind !== "fresh_missing" && view.worktreeGate.kind !== "recoverable_missing") ||
        !isDeepStrictEqual(view.worktreeGate, action.expectedWorktreeGate)
      ) {
        return failed(directive, "root_workspace_gate_stale");
      }
      try {
        await this.git.materializeRootWorkspace({
          repositoryIdentity: action.expectedWorktreeGate.repositoryIdentity,
          rootIssueId: action.rootIssueId,
          rootIdentifier: view.root.identifier,
          baseBranch: this.baseBranch,
          expectedGate: action.expectedWorktreeGate,
        });
      } catch (error) {
        const code = error instanceof Error && /^git_workspace_[a-z_]+$/u.test(error.message)
          ? error.message
          : "git_workspace_materialization_failed";
        return failed(directive, code);
      }
      return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [view.root.issueId] };
    }
    if (action.kind === "invalidate_execution_generation") {
      return this.invalidateExecutionGeneration(directive, view, action);
    }
    if (action.kind === "materialize_plan_node") {
      return new LinearPlanNodeMaterializerImpl(this.linear).materialize({ directive, view });
    }
    if (action.kind === "revise_root_tree") return this.applyTreeOperations(directive, view, action.operations, "operations");
    if (action.kind === "create_cycle") return this.createCycle(directive, view, action);
    if (action.kind === "supersede_cycle") return this.supersedeCycle(directive, view, action);
    if (action.kind === "conclude_cycle") return this.concludeCycle(directive, view, action);
    if (action.kind === "wait" || action.kind === "acknowledge") {
      return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [] };
    }
    if (action.kind === "replan_current_cycle") return this.replanCycle(directive, view, action);
    if (action.kind === "conclude_root") {
      try {
        await this.delivery.deliver({
          directive,
          view,
          baseBranch: this.baseBranch,
          title: `${view.root.identifier} delivery`,
          body: `Delivers the verified changes for ${view.root.identifier}.`,
        });
        return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [view.root.issueId] };
      } catch (error) {
        const code = error instanceof Error && /^root_delivery_[a-z_]+$/u.test(error.message)
          ? error.message
          : "root_delivery_failed";
        return failed(directive, code);
      }
    }
    if (action.kind === "cancel_root") return this.cancelRoot(directive, view, action);
    return failed(directive, "root_directive_action_unsupported");
  }

  private async invalidateExecutionGeneration(
    directive: RootDirective,
    view: RootReconciliationView,
    action: Extract<RootDirective["action"], { kind: "invalidate_execution_generation" }>,
  ): Promise<RootActionMaterializationResult> {
    if (action.rootIssueId !== view.root.issueId) return failed(directive, "execution_generation_root_mismatch");
    const root = view.tree.issues.find((issue) => issue.issue_id === view.root.issueId);
    if (!root || root.remote_version !== action.expectedRootRemoteVersion) {
      return failed(directive, "execution_generation_root_version_stale");
    }
    if (view.worktreeGate.kind !== "execution_generation_invalid" ||
        !isDeepStrictEqual(view.worktreeGate, action.expectedWorktreeGate)) {
      return failed(directive, "execution_generation_gate_stale");
    }
    let currentView = view;
    let cycle = currentView.tree.issues.find(({ issue_id }) => issue_id === action.cycleIssueId);
    if (!cycle || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== view.root.issueId) {
      return failed(directive, "execution_generation_cycle_invalid");
    }
    if (cycle.is_archived) {
      return cycle.status_name === "Canceled" && cycle.labels.includes("Execution Invalidated") &&
        executionGenerationIssues(currentView, cycle.issue_id).every(({ is_archived }) => is_archived)
        ? { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [cycle.issue_id] }
        : failed(directive, "execution_generation_archive_incomplete");
    }
    if (cycle.status_name !== "Canceled" || !cycle.labels.includes("Execution Invalidated")) {
      const canceled = currentView.tree.status_catalog.find(({ name }) => name === "Canceled");
      if (!canceled) return failed(directive, "execution_generation_canceled_status_missing");
      const outcome = await this.linear.mutateWorkflow({
        ...updateIssueCommand(currentView, directive, cycle, canceled.status_id),
        writeId: `${directive.rootDirectiveId}:${cycle.issue_id}:invalidate`,
        labelNames: [...new Set([...cycle.labels, "Execution Invalidated"])],
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
        return failed(directive, `execution_generation_cycle_${outcome.kind}`);
      }
      currentView = await refreshView(this.linear, currentView);
      cycle = currentView.tree.issues.find(({ issue_id }) => issue_id === action.cycleIssueId);
      if (!cycle || cycle.is_archived || cycle.status_name !== "Canceled" || !cycle.labels.includes("Execution Invalidated")) {
        return failed(directive, "execution_generation_cycle_read_back_invalid");
      }
    }
    const archiveOperations: TreeOperation[] = executionGenerationIssues(currentView, cycle.issue_id)
      .filter(({ is_archived }) => !is_archived)
      .sort((left, right) => right.depth - left.depth || left.issue_id.localeCompare(right.issue_id))
      .map((issue) => ({
        kind: "archive_node",
        precondition: {
          targetIssueId: issue.issue_id,
          expectedRemoteVersion: issue.remote_version,
          ...(issue.parent_issue_id === undefined ? {} : { expectedParentIssueId: issue.parent_issue_id }),
        },
      }));
    if (archiveOperations.length === 0) {
      return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [cycle.issue_id] };
    }
    return this.applyTreeOperations(directive, currentView, archiveOperations, "generated_archive_operations");
  }

  private async replanCycle(
    directive: RootDirective,
    view: RootReconciliationView,
    action: Extract<RootDirective["action"], { kind: "replan_current_cycle" }>,
  ): Promise<RootActionMaterializationResult> {
    const cycle = view.tree.issues.find((issue) => issue.issue_id === action.cycleIssueId);
    const plan = view.tree.issues.find((issue) => issue.issue_id === action.planIssueId);
    if (!cycle || !plan || cycle.parent_issue_id !== view.root.issueId || cycle.issue_kind !== "cycle" || cycle.is_archived ||
        plan.parent_issue_id !== cycle.issue_id || plan.issue_kind !== "plan" || plan.is_archived) {
      return failed(directive, "cycle_replan_target_invalid");
    }
    if (action.archiveOrRestoreOperations.length > 0) {
      const patched = await this.applyTreeOperations(
        directive,
        view,
        action.archiveOrRestoreOperations,
        "archive_or_restore_operations",
      );
      if (patched.kind === "failed") return patched;
      view = await refreshView(this.linear, view);
    }
    const planning = view.tree.status_catalog.find(({ name }) => name === "Planning");
    const inProgress = view.tree.status_catalog.find(({ name }) => name === "In Progress");
    if (!planning || !inProgress) return failed(directive, "cycle_replan_status_missing");
    const cycleNow = rootIssue(view, cycle.issue_id);
    const cycleStatus = await this.applyStatusChange(directive, view, cycleNow, "Planning", "cycle_replan");
    if (cycleStatus.kind === "failed") return cycleStatus;
    view = await refreshView(this.linear, view);
    const planNow = rootIssue(view, plan.issue_id);
    const command = updateIssueCommand(view, directive, planNow, inProgress.status_id, action.freshPlanGoal);
    const executed = await executeMutation(this.linear, view, directive, command, "update_node");
    if (executed.kind === "failed") return executed;
    return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [cycle.issue_id, plan.issue_id] };
  }

  private async cancelRoot(
    directive: RootDirective,
    view: RootReconciliationView,
    action: Extract<RootDirective["action"], { kind: "cancel_root" }>,
  ): Promise<RootActionMaterializationResult> {
    if (action.activeCycleIssueId) {
      const cycle = view.tree.issues.find((issue) => issue.issue_id === action.activeCycleIssueId);
      if (!cycle || cycle.parent_issue_id !== view.root.issueId || cycle.issue_kind !== "cycle" || cycle.is_archived) {
        return failed(directive, "root_cancel_active_cycle_invalid");
      }
      const canceled = await this.terminalizeCycle(
        directive,
        view,
        cycle,
        "Canceled",
        "root_cancel_cycle",
      );
      if (canceled.kind === "failed") return canceled;
      view = await refreshView(this.linear, view);
    }
    const root = rootIssue(view, view.root.issueId);
    if (root.status_name === "Canceled") {
      return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [root.issue_id] };
    }
    return this.applyStatusChange(directive, view, root, "Canceled", "root_cancel");
  }

  private async supersedeCycle(
    directive: RootDirective,
    view: RootReconciliationView,
    action: Extract<RootDirective["action"], { kind: "supersede_cycle" }>,
  ): Promise<RootActionMaterializationResult> {
    const current = view.tree.issues.find((issue) => issue.issue_id === action.currentCycleIssueId);
    if (!current || current.parent_issue_id !== view.root.issueId || current.issue_kind !== "cycle" || current.is_archived) {
      return failed(directive, "successor_cycle_current_target_invalid");
    }
    const concluded = await this.terminalizeCycle(
      directive,
      view,
      current,
      "Changes Required",
      "cycle_supersede",
    );
    if (concluded.kind === "failed") return concluded;
    const refreshed = await refreshView(this.linear, view);
    return this.createCycle(directive, refreshed, {
      kind: "create_cycle",
      predecessorCycleIssueId: action.currentCycleIssueId,
      reason: action.reason === "root_contract_changed" ? "root_contract_changed" : "repair_required",
      planTrigger: action.successor.planTrigger,
      inheritedFactRefs: action.successor.inheritedFactRefs,
      invalidatedDeliveryRefs: [],
    });
  }

  private async createCycle(
    directive: RootDirective,
    view: RootReconciliationView,
    action: Extract<RootDirective["action"], { kind: "create_cycle" }>,
  ): Promise<RootActionMaterializationResult> {
    const activeCycles = view.tree.issues.filter((issue) =>
      issue.parent_issue_id === view.root.issueId && issue.issue_kind === "cycle" && !issue.is_archived && !isTerminalCycle(issue),
    );
    if (activeCycles.length > 0) return failed(directive, "successor_cycle_active_cycle_exists");
    if (action.reason === "initial" && view.tree.issues.some((issue) => issue.parent_issue_id === view.root.issueId && issue.issue_kind === "cycle")) {
      return failed(directive, "initial_cycle_already_exists");
    }
    const predecessor = action.predecessorCycleIssueId
      ? view.tree.issues.find((issue) => issue.issue_id === action.predecessorCycleIssueId)
      : undefined;
    if (action.reason !== "initial" && (!predecessor || predecessor.parent_issue_id !== view.root.issueId || predecessor.issue_kind !== "cycle" || !isTerminalCycle(predecessor))) {
      return failed(directive, "successor_cycle_predecessor_invalid");
    }
    const cycleWriteId = `${directive.rootDirectiveId}:cycle`;
    let currentView = view;
    if (action.reason === "initial") {
      const root = rootIssue(currentView, view.root.issueId);
      if (root.status_name === "Todo") {
        const started = await executeStatusChange(
          this.linear,
          directive,
          currentView,
          root,
          "In Progress",
          "initial_cycle_root_start",
        );
        if (started.kind === "failed") return started;
        currentView = started.view;
      } else if (root.status_name !== "In Progress") {
        return failed(directive, "initial_cycle_root_status_invalid");
      }
    }
    const cycleTitle = `Cycle ${currentView.tree.issues.filter((issue) => issue.issue_kind === "cycle").length + 1}`;
    const matchesCycle = (tree: RootReconciliationView["tree"]) => tree.issues.filter((issue) =>
      issue.parent_issue_id === view.root.issueId && issue.issue_kind === "cycle" && !issue.is_archived &&
      issue.status_name === "Planning" && issue.title === cycleTitle && issue.description === action.planTrigger,
    );
    let cycle = matchesCycle(currentView.tree)[0];
    if (!cycle) {
      const status = currentView.tree.status_catalog.find(({ name }) => name === "Planning");
      const root = rootIssue(currentView, view.root.issueId);
      if (!status) return failed(directive, "successor_cycle_status_missing");
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_workflow_issue",
        writeId: cycleWriteId,
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        parentExpectedRemoteVersion: root.remote_version,
        parentExpectedStatusId: root.status_id,
        parentIssueId: root.issue_id,
        title: cycleTitle,
        description: action.planTrigger,
        statusId: status.status_id,
        labelNames: [workflowKindLabel("cycle")],
      });
      if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") return failed(directive, `cycle_create_${outcome.kind}`);
      currentView = await refreshView(this.linear, currentView);
      const matches = matchesCycle(currentView.tree);
      if (matches.length > 1) return failed(directive, "successor_cycle_create_ambiguous");
      cycle = matches[0];
      if (!cycle) return failed(directive, `successor_cycle_create_${outcome.kind}`);
    }
    if (predecessor && !currentView.tree.relations.some((relation) =>
      relation.relation_kind === "relates_to" && relation.source_issue_id === predecessor.issue_id && relation.target_issue_id === cycle!.issue_id)) {
      const root = rootIssue(currentView, view.root.issueId);
      const source = rootIssue(currentView, predecessor.issue_id);
      const target = rootIssue(currentView, cycle!.issue_id);
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_workflow_relation",
        writeId: `${cycleWriteId}:predecessor`,
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        sourceIssueId: source.issue_id,
        sourceExpectedRemoteVersion: source.remote_version,
        targetIssueId: target.issue_id,
        targetExpectedRemoteVersion: target.remote_version,
        relationKind: "relates_to",
        relationState: "present",
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return failed(directive, `cycle_predecessor_${outcome.kind}`);
      currentView = await refreshView(this.linear, currentView);
    }
    return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [cycle.issue_id] };
  }

  private async concludeCycle(
    directive: RootDirective,
    view: RootReconciliationView,
    action: Extract<RootDirective["action"], { kind: "conclude_cycle" }>,
  ): Promise<RootActionMaterializationResult> {
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
    return this.terminalizeCycle(directive, view, cycle, statusName, "cycle_conclusion");
  }

  private async terminalizeCycle(
    directive: RootDirective,
    view: RootReconciliationView,
    cycle: RootReconciliationView["tree"]["issues"][number],
    statusName: "Succeeded" | "Changes Required" | "Canceled",
    failurePrefix: string,
  ): Promise<RootActionMaterializationResult> {
    if (isTerminalCycle(cycle)) {
      return cycle.status_name === statusName
        ? { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [cycle.issue_id] }
        : failed(directive, `${failurePrefix}_terminal_status_conflict`);
    }
    return this.applyStatusChange(directive, view, cycle, statusName, failurePrefix);
  }

  private async applyStatusChange(
    directive: RootDirective,
    view: RootReconciliationView,
    target: RootReconciliationView["tree"]["issues"][number],
    statusName: string,
    failurePrefix: string,
  ): Promise<RootActionMaterializationResult> {
    const changed = await executeStatusChange(this.linear, directive, view, target, statusName, failurePrefix);
    if (changed.kind === "failed") return changed;
    return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [target.issue_id] };
  }

  private async applyTreeOperations(
    directive: RootDirective,
    view: RootReconciliationView,
    operations: TreeOperation[],
    operationGroup: RootActionFailureDiagnostic["operationGroup"],
  ): Promise<RootActionMaterializationResult> {
    if (operations.length === 0) return failed(directive, "tree_operation_count_invalid");
    const preflightFailure = treeOperationsPreflightFailure(view, operations);
    if (preflightFailure) {
      const operation = operations[preflightFailure.operationIndex]!;
      return failed(
        directive,
        preflightFailure.code,
        treeOperationFailureDiagnostic(view, operation, operationGroup, preflightFailure.operationIndex),
      );
    }
    let currentView = view;
    const sourceIssueIds = new Set<string>();
    const mutatedIssueIds = new Set<string>();
    for (const [operationIndex, operation] of operations.entries()) {
      const effectiveOperation = rebaseOperationPrecondition(operation, currentView, mutatedIssueIds);
      const diagnostic = treeOperationFailureDiagnostic(currentView, effectiveOperation, operationGroup, operationIndex);
      if (effectiveOperation.kind === "reorder_nodes" || effectiveOperation.kind === "replace_dependencies") {
        const specialized = await applyRelationshipOperation(this.linear, directive, currentView, effectiveOperation);
        if (specialized.kind === "failed") return { ...specialized, diagnostic };
        currentView = specialized.view;
        for (const issueId of specialized.sourceIssueIds) sourceIssueIds.add(issueId);
        for (const issueId of specialized.mutatedIssueIds) mutatedIssueIds.add(issueId);
        continue;
      }
      const validationFailure = treeOperationValidationFailure(currentView, effectiveOperation);
      if (validationFailure) return failed(directive, validationFailure, diagnostic);
      const plan = operationPlan(currentView, directive, effectiveOperation);
      if (!plan) return failed(directive, `cycle_tree_operation_${operation.kind}_unsupported`, diagnostic);
      for (const command of plan.commands) {
        const executed = await executeMutation(this.linear, currentView, directive, command, operation.kind);
        if (executed.kind === "failed") return { ...executed, diagnostic };
        currentView = executed.view;
        for (const issueId of mutationIssueIds(command)) mutatedIssueIds.add(issueId);
      }
      for (const issueId of plan.sourceIssueIds) sourceIssueIds.add(issueId);
    }
    return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [...sourceIssueIds] };
  }
}

function treeOperationFailureDiagnostic(
  _view: RootReconciliationView,
  operation: TreeOperation,
  operationGroup: RootActionFailureDiagnostic["operationGroup"],
  operationIndex: number,
): RootActionFailureDiagnostic {
  return {
    operationGroup,
    operationIndex,
    operationKind: operation.kind,
  };
}

function executionGenerationIssues(
  view: RootReconciliationView,
  cycleIssueId: string,
): RootReconciliationView["tree"]["issues"] {
  const result: RootReconciliationView["tree"]["issues"] = [];
  const pending = [cycleIssueId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const issueId = pending.shift()!;
    if (seen.has(issueId)) return [];
    seen.add(issueId);
    const issue = view.tree.issues.find((candidate) => candidate.issue_id === issueId);
    if (!issue) return [];
    result.push(issue);
    pending.push(...view.tree.issues.filter(({ parent_issue_id }) => parent_issue_id === issueId).map(({ issue_id }) => issue_id));
  }
  return result;
}

function updateIssueCommand(
  view: RootReconciliationView,
  directive: RootDirective,
  target: RootReconciliationView["tree"]["issues"][number],
  statusId: string,
  description?: string,
): Extract<LinearWorkflowMutationCommand, { kind: "update_workflow_issue" }> {
  return {
    kind: "update_workflow_issue",
    writeId: `${directive.rootDirectiveId}:${target.issue_id}`,
    expectedProjectId: target.project_id,
    rootIssueId: view.root.issueId,
    expectedRootRemoteVersion: rootIssue(view, view.root.issueId).remote_version,
    target: { targetIssueId: target.issue_id, expectedRemoteVersion: target.remote_version, expectedStatusId: target.status_id },
    statusId,
    title: target.title,
    description: description === undefined ? target.description : preservedDescription(target, description),
    labelNames: target.labels,
    isArchived: target.is_archived,
    parentAssignment: { mode: "retain" },
  };
}

interface OperationPlan {
  commands: LinearWorkflowMutationCommand[];
  sourceIssueIds: string[];
}

function operationPlan(
  view: RootReconciliationView,
  directive: RootDirective,
  operation: TreeOperation,
): OperationPlan | undefined {
  const root = rootIssue(view, view.root.issueId);
  if (operation.kind === "create_node") {
    const status = view.tree.status_catalog.find(({ name }) => name === operation.status);
    if (!status) return undefined;
    const parent = view.tree.issues.find((issue) => issue.issue_id === operation.parentIssueId);
    if (
      !parent ||
      operation.precondition.targetIssueId !== parent.issue_id ||
      parent.remote_version !== operation.precondition.expectedRemoteVersion
    ) return undefined;
    const issueKind = operation.issueKind;
    const issueKey = treeOperationIssueKey(directive, operation);
    return {
      commands: [{
        kind: "create_workflow_issue",
        writeId: issueKey,
        expectedProjectId: parent.project_id,
        rootIssueId: view.root.issueId,
        expectedRootRemoteVersion: root.remote_version,
        parentExpectedRemoteVersion: parent.remote_version,
        parentExpectedStatusId: parent.status_id,
        parentIssueId: operation.parentIssueId,
        title: operation.title,
        description: operation.description,
        statusId: status.status_id,
        labelNames: [primaryIssueLabel(issueKind)],
      }],
      sourceIssueIds: [operation.parentIssueId],
    };
  }
  if (operation.kind === "update_node") {
    const target = view.tree.issues.find((issue) => issue.issue_id === operation.precondition.targetIssueId);
    if (
      !target ||
      target.remote_version !== operation.precondition.expectedRemoteVersion ||
      (operation.precondition.expectedParentIssueId !== undefined && target.parent_issue_id !== operation.precondition.expectedParentIssueId) ||
      (operation.precondition.expectedStatus !== undefined && target.status_name !== operation.precondition.expectedStatus)
    ) return undefined;
    const status = view.tree.status_catalog.find(({ name }) => name === operation.status);
    if (!status) return undefined;
    return {
      commands: [{
        kind: "update_workflow_issue", writeId: `${directive.rootDirectiveId}:${target.issue_id}`,
        expectedProjectId: target.project_id, rootIssueId: view.root.issueId, expectedRootRemoteVersion: root.remote_version,
        target: { targetIssueId: target.issue_id, expectedRemoteVersion: target.remote_version, ...(operation.precondition.expectedStatus !== undefined ? { expectedStatusId: target.status_id } : {}) },
        statusId: status.status_id,
        title: operation.title, description: preservedDescription(target, operation.description),
        labelNames: target.labels,
        isArchived: target.is_archived,
        parentAssignment: { mode: "retain" },
        order: target.order,
      }],
      sourceIssueIds: [target.issue_id],
    };
  }
  if (operation.kind === "archive_node" || operation.kind === "restore_node") {
    const target = view.tree.issues.find((issue) => issue.issue_id === operation.precondition.targetIssueId);
    if (!target || target.remote_version !== operation.precondition.expectedRemoteVersion ||
        (operation.precondition.expectedParentIssueId !== undefined && target.parent_issue_id !== operation.precondition.expectedParentIssueId) ||
        (operation.precondition.expectedStatus !== undefined && target.status_name !== operation.precondition.expectedStatus)) return undefined;
    return {
      commands: [{
        kind: "update_workflow_issue",
        writeId: `${directive.rootDirectiveId}:${target.issue_id}:${operation.kind}`,
        expectedProjectId: target.project_id,
        rootIssueId: view.root.issueId,
        expectedRootRemoteVersion: root.remote_version,
        target: { targetIssueId: target.issue_id, expectedRemoteVersion: target.remote_version, expectedIsArchived: target.is_archived },
        statusId: target.status_id,
        title: target.title,
        description: target.description,
        labelNames: target.labels,
        isArchived: operation.kind === "archive_node",
        parentAssignment: { mode: "retain" },
        order: target.order,
      }],
      sourceIssueIds: [target.issue_id],
    };
  }
  if (operation.kind === "reorder_nodes" || operation.kind === "replace_dependencies") return undefined;
  if (operation.kind === "remove_relation") {
    const relation = view.tree.relations.find(({ relation_id }) => relation_id === operation.relationId);
    const target = view.tree.issues.find(({ issue_id }) => issue_id === operation.precondition.targetIssueId);
    const source = relation ? view.tree.issues.find(({ issue_id }) => issue_id === relation.source_issue_id) : undefined;
    if (!relation || relation.relation_kind === "triggered_by" || !target || !source || relation.target_issue_id !== target.issue_id ||
        target.remote_version !== operation.precondition.expectedRemoteVersion) return undefined;
    return {
      commands: [removeRelationCommand(view, directive, relation, source, target)],
      sourceIssueIds: [source.issue_id, target.issue_id],
    };
  }
  return undefined;
}

function treeOperationValidationFailure(
  view: RootReconciliationView,
  operation: TreeOperation,
  previouslyMutatedIssueIds: ReadonlySet<string> = new Set(),
): string | undefined {
  const issue = (issueId: string) => view.tree.issues.find((candidate) => candidate.issue_id === issueId);
  const prefix = `cycle_tree_operation_${operation.kind}`;
  if ("precondition" in operation) {
    const target = issue(operation.precondition.targetIssueId);
    if (!target) return `${prefix}_target_missing`;
    if (!previouslyMutatedIssueIds.has(target.issue_id) &&
        target.remote_version !== operation.precondition.expectedRemoteVersion) return `${prefix}_precondition_conflict`;
    if (operation.precondition.expectedParentIssueId !== undefined &&
        target.parent_issue_id !== operation.precondition.expectedParentIssueId) return `${prefix}_parent_invalid`;
    if (!previouslyMutatedIssueIds.has(target.issue_id) && operation.precondition.expectedStatus !== undefined &&
        target.status_name !== operation.precondition.expectedStatus) return `${prefix}_status_invalid`;
  }
  if (operation.kind === "create_node") {
    const parent = issue(operation.parentIssueId);
    if (operation.precondition.targetIssueId !== operation.parentIssueId || !parent || parent.issue_kind !== "cycle" ||
        parent.parent_issue_id !== view.root.issueId || parent.is_archived) return `${prefix}_parent_invalid`;
    if (!view.tree.status_catalog.some(({ name }) => name === operation.status)) return `${prefix}_status_invalid`;
    return undefined;
  }
  if (operation.kind === "update_node") {
    if (!view.tree.status_catalog.some(({ name }) => name === operation.status)) return `${prefix}_status_invalid`;
    return undefined;
  }
  if (operation.kind === "archive_node" || operation.kind === "restore_node") return undefined;
  if (operation.kind === "reorder_nodes") {
    const cycle = issue(operation.cycleIssueId);
    if (operation.precondition.targetIssueId !== operation.cycleIssueId || !cycle || cycle.issue_kind !== "cycle" ||
        cycle.parent_issue_id !== view.root.issueId || cycle.is_archived) return `${prefix}_target_invalid`;
    const children = view.tree.issues.filter((candidate) => candidate.parent_issue_id === cycle.issue_id && !candidate.is_archived);
    if (new Set(operation.orderedIssueIds).size !== operation.orderedIssueIds.length ||
        operation.orderedIssueIds.length !== children.length ||
        operation.orderedIssueIds.some((issueId) => !children.some((child) => child.issue_id === issueId))) {
      return `${prefix}_shape_invalid`;
    }
    return undefined;
  }
  if (operation.kind === "replace_dependencies") {
    const work = issue(operation.workIssueId);
    if (operation.precondition.targetIssueId !== operation.workIssueId || !work || work.issue_kind !== "work" ||
        work.is_archived || !work.parent_issue_id) return `${prefix}_target_invalid`;
    const dependencyIds = new Set(operation.dependencyIssueIds);
    if (dependencyIds.size !== operation.dependencyIssueIds.length) return `${prefix}_duplicate_dependency`;
    if (dependencyIds.has(work.issue_id)) return `${prefix}_self_dependency`;
    for (const dependencyId of dependencyIds) {
      const dependency = issue(dependencyId);
      if (!dependency || dependency.issue_kind !== "work" || dependency.is_archived ||
          dependency.parent_issue_id !== work.parent_issue_id) return `${prefix}_target_invalid`;
      if (dependencyPathExists(view, work.issue_id, dependency.issue_id)) return `${prefix}_cycle_invalid`;
    }
    return undefined;
  }
  const relation = view.tree.relations.find(({ relation_id }) => relation_id === operation.relationId);
  if (!relation) return `${prefix}_relation_missing`;
  if (relation.relation_kind === "triggered_by") return `${prefix}_kind_unsupported`;
  if (relation.target_issue_id !== operation.precondition.targetIssueId ||
      !issue(relation.source_issue_id) || !issue(relation.target_issue_id)) return `${prefix}_target_invalid`;
  return undefined;
}

function treeOperationsPreflightFailure(
  view: RootReconciliationView,
  operations: TreeOperation[],
): { operationIndex: number; code: string } | undefined {
  const mutatedIssueIds = new Set<string>();
  for (const [operationIndex, operation] of operations.entries()) {
    const code = treeOperationValidationFailure(view, operation, mutatedIssueIds);
    if (code) return { operationIndex, code };
    for (const issueId of potentiallyMutatedIssueIds(view, operation)) mutatedIssueIds.add(issueId);
  }
  return undefined;
}

function potentiallyMutatedIssueIds(view: RootReconciliationView, operation: TreeOperation): string[] {
  if (operation.kind === "create_node") return [operation.parentIssueId];
  if (operation.kind === "update_node" || operation.kind === "archive_node" || operation.kind === "restore_node") {
    return [operation.precondition.targetIssueId];
  }
  if (operation.kind === "reorder_nodes") return [operation.cycleIssueId, ...operation.orderedIssueIds];
  if (operation.kind === "replace_dependencies") return [operation.workIssueId, ...operation.dependencyIssueIds];
  const relation = view.tree.relations.find(({ relation_id }) => relation_id === operation.relationId);
  return relation ? [relation.source_issue_id, relation.target_issue_id] : [];
}

function dependencyPathExists(view: RootReconciliationView, sourceIssueId: string, targetIssueId: string): boolean {
  const pending = [sourceIssueId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === targetIssueId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const relation of view.tree.relations) {
      if (relation.relation_kind === "blocks" && relation.source_issue_id === current) {
        pending.push(relation.target_issue_id);
      }
    }
  }
  return false;
}

async function applyRelationshipOperation(
  linear: LinearGatewayInterface,
  directive: RootDirective,
  view: RootReconciliationView,
  operation: Extract<TreeOperation, { kind: "reorder_nodes" | "replace_dependencies" }>,
): Promise<{
  kind: "materialized";
  view: RootReconciliationView;
  sourceIssueIds: string[];
  mutatedIssueIds: string[];
} | { kind: "failed"; rootDirectiveId: string; code: string; sanitizedReason: string }> {
  let currentView = view;
  const sourceIssueIds = new Set<string>();
  const mutatedIssueIds = new Set<string>();
  if (operation.kind === "reorder_nodes") {
    const cycle = currentView.tree.issues.find((issue) => issue.issue_id === operation.cycleIssueId);
    if (!cycle || cycle.remote_version !== operation.precondition.expectedRemoteVersion || cycle.parent_issue_id !== currentView.root.issueId) {
      return treeOperationFailed(directive, "cycle_tree_operation_reorder_nodes_precondition_conflict");
    }
    const children = currentView.tree.issues.filter((issue) => issue.parent_issue_id === cycle.issue_id && !issue.is_archived);
    const ordered = operation.orderedIssueIds;
    if (new Set(ordered).size !== ordered.length || ordered.length !== children.length ||
        ordered.some((issueId) => !children.some((child) => child.issue_id === issueId))) {
      return treeOperationFailed(directive, "cycle_tree_operation_reorder_nodes_shape_invalid");
    }
    sourceIssueIds.add(cycle.issue_id);
    for (const [order, issueId] of ordered.entries()) {
      const target = currentView.tree.issues.find((issue) => issue.issue_id === issueId);
      if (!target) return treeOperationFailed(directive, "cycle_tree_operation_reorder_nodes_target_missing");
      sourceIssueIds.add(target.issue_id);
      if (target.order === order) continue;
        const executed = await executeMutation(
          linear,
          currentView,
          directive,
          updateIssueOrderCommand(currentView, directive, target, order),
          operation.kind,
      );
      if (executed.kind === "failed") return executed;
      currentView = executed.view;
      mutatedIssueIds.add(target.issue_id);
    }
  } else {
    const work = currentView.tree.issues.find((issue) => issue.issue_id === operation.workIssueId);
    if (!work || work.issue_kind !== "work" || work.remote_version !== operation.precondition.expectedRemoteVersion) {
      return treeOperationFailed(directive, "cycle_tree_operation_replace_dependencies_precondition_conflict");
    }
    const dependencyIds = new Set(operation.dependencyIssueIds);
    if (dependencyIds.has(work.issue_id)) return treeOperationFailed(directive, "cycle_tree_operation_replace_dependencies_self_dependency");
    const dependencies = [...dependencyIds].map((issueId) => currentView.tree.issues.find((issue) => issue.issue_id === issueId));
    if (dependencies.some((issue) => !issue || issue.issue_id === work.issue_id || issue.is_archived)) {
      return treeOperationFailed(directive, "cycle_tree_operation_replace_dependencies_target_invalid");
    }
    sourceIssueIds.add(work.issue_id);
    for (const dependency of dependencies) sourceIssueIds.add(dependency!.issue_id);
    let dependenciesComplete = false;
    while (!dependenciesComplete) {
      const currentWork = currentView.tree.issues.find((issue) => issue.issue_id === work.issue_id);
      if (!currentWork) return treeOperationFailed(directive, "cycle_tree_operation_replace_dependencies_target_missing");
      const currentRelations = currentView.tree.relations.filter((relation) =>
        relation.relation_kind === "blocks" && relation.target_issue_id === currentWork.issue_id,
      );
      const remove = currentRelations.find((relation) => !dependencyIds.has(relation.source_issue_id));
      if (remove) {
        const source = currentView.tree.issues.find((issue) => issue.issue_id === remove.source_issue_id);
        if (!source) return treeOperationFailed(directive, "cycle_tree_operation_replace_dependencies_source_missing");
        const executed = await executeMutation(
          linear,
          currentView,
          directive,
          removeRelationCommand(currentView, directive, remove, source, currentWork),
          operation.kind,
        );
        if (executed.kind === "failed") return executed;
        currentView = executed.view;
        mutatedIssueIds.add(source.issue_id);
        mutatedIssueIds.add(currentWork.issue_id);
        continue;
      }
      const add = dependencies.find((dependency) => !currentRelations.some((relation) =>
        relation.source_issue_id === dependency!.issue_id));
      if (!add) {
        dependenciesComplete = true;
        continue;
      }
      const executed = await executeMutation(
        linear,
        currentView,
        directive,
        createRelationCommand(currentView, directive, add!, currentWork, "blocks", `dependency:${add!.issue_id}`),
        operation.kind,
      );
      if (executed.kind === "failed") return executed;
      currentView = executed.view;
      mutatedIssueIds.add(add!.issue_id);
      mutatedIssueIds.add(currentWork.issue_id);
    }
  }
  return { kind: "materialized", view: currentView, sourceIssueIds: [...sourceIssueIds], mutatedIssueIds: [...mutatedIssueIds] };
}

async function executeMutation(
  linear: LinearGatewayInterface,
  view: RootReconciliationView,
  directive: RootDirective,
  command: LinearWorkflowMutationCommand,
  operationKind: TreeOperation["kind"],
): Promise<
  | { kind: "materialized"; view: RootReconciliationView }
  | { kind: "failed"; rootDirectiveId: string; code: string; sanitizedReason: string }
> {
  const outcome = await linear.mutateWorkflow(command);
  if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
    return treeOperationFailed(directive, `cycle_tree_operation_${operationKind}_${outcome.kind}`);
  }
  const currentView = await refreshView(linear, view);
  if (!mutationReadBackMatches(command, currentView.tree)) {
    return treeOperationFailed(directive, `cycle_tree_operation_${operationKind}_read_back_invalid`);
  }
  return { kind: "materialized", view: currentView };
}

async function executeStatusChange(
  linear: LinearGatewayInterface,
  directive: RootDirective,
  view: RootReconciliationView,
  target: RootReconciliationView["tree"]["issues"][number],
  statusName: string,
  failurePrefix: string,
): Promise<
  | { kind: "materialized"; view: RootReconciliationView }
  | { kind: "failed"; rootDirectiveId: string; code: string; sanitizedReason: string }
> {
  const status = view.tree.status_catalog.find(({ name }) => name === statusName);
  if (!status) return failed(directive, `${failurePrefix}_status_missing`);
  const outcome = await linear.mutateWorkflow(updateIssueCommand(view, directive, target, status.status_id));
  if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
    return failed(directive, `${failurePrefix}_${outcome.kind}`);
  }
  const currentView = await refreshView(linear, view);
  const updated = currentView.tree.issues.find(({ issue_id }) => issue_id === target.issue_id);
  if (!updated || updated.status_id !== status.status_id || updated.status_name !== status.name) {
    return failed(directive, `${failurePrefix}_read_back_invalid`);
  }
  return { kind: "materialized", view: currentView };
}

function rebaseOperationPrecondition(
  operation: TreeOperation,
  view: RootReconciliationView,
  mutatedIssueIds: ReadonlySet<string>,
): TreeOperation {
  if (!("precondition" in operation) || !mutatedIssueIds.has(operation.precondition.targetIssueId)) return operation;
  const target = view.tree.issues.find((issue) => issue.issue_id === operation.precondition.targetIssueId);
  if (!target) return operation;
  return { ...operation, precondition: { ...operation.precondition, expectedRemoteVersion: target.remote_version } } as TreeOperation;
}

function mutationIssueIds(command: LinearWorkflowMutationCommand): string[] {
  if (command.kind === "create_workflow_issue") return [command.parentIssueId];
  if (
    command.kind === "create_comment_reply" ||
    command.kind === "set_comment_receipt_reaction" ||
    command.kind === "set_comment_thread_state"
  ) return [];
  if (command.kind === "create_workflow_relation") {
    return [command.sourceIssueId, command.targetIssueId];
  }
  return [command.target.targetIssueId];
}

function updateIssueOrderCommand(
  view: RootReconciliationView,
  directive: RootDirective,
  target: RootReconciliationView["tree"]["issues"][number],
  order: number,
): LinearWorkflowMutationCommand {
  const root = rootIssue(view, view.root.issueId);
  return {
    kind: "update_workflow_issue",
    writeId: `${directive.rootDirectiveId}:order:${target.issue_id}:${order}`,
    expectedProjectId: target.project_id,
    rootIssueId: view.root.issueId,
    expectedRootRemoteVersion: root.remote_version,
    target: { targetIssueId: target.issue_id, expectedRemoteVersion: target.remote_version, expectedStatusId: target.status_id },
    statusId: target.status_id,
    title: target.title,
    description: target.description,
    labelNames: target.labels,
    isArchived: target.is_archived,
    parentAssignment: { mode: "retain" },
    order,
  };
}

function createRelationCommand(
  view: RootReconciliationView,
  directive: RootDirective,
  source: RootReconciliationView["tree"]["issues"][number],
  target: RootReconciliationView["tree"]["issues"][number],
  relationKind: "blocks" | "blocked_by" | "relates_to",
  suffix: string,
): LinearWorkflowMutationCommand {
  const root = rootIssue(view, view.root.issueId);
  return {
    kind: "create_workflow_relation",
    writeId: `${directive.rootDirectiveId}:${suffix}:${source.issue_id}:${target.issue_id}:${relationKind}`,
    expectedProjectId: source.project_id,
    rootIssueId: view.root.issueId,
    expectedRootRemoteVersion: root.remote_version,
    sourceIssueId: source.issue_id,
    sourceExpectedRemoteVersion: source.remote_version,
    targetIssueId: target.issue_id,
    targetExpectedRemoteVersion: target.remote_version,
    relationKind,
    relationState: "present",
  };
}

function removeRelationCommand(
  view: RootReconciliationView,
  directive: RootDirective,
  relation: RootReconciliationView["tree"]["relations"][number],
  source: RootReconciliationView["tree"]["issues"][number],
  target: RootReconciliationView["tree"]["issues"][number],
): LinearWorkflowMutationCommand {
  const root = rootIssue(view, view.root.issueId);
  if (relation.relation_kind === "triggered_by") {
    throw new Error("cycle_tree_operation_remove_relation_kind_unsupported");
  }
  return {
    kind: "create_workflow_relation",
    writeId: `${directive.rootDirectiveId}:remove-relation:${relation.relation_id}`,
    expectedProjectId: source.project_id,
    rootIssueId: view.root.issueId,
    expectedRootRemoteVersion: root.remote_version,
    sourceIssueId: source.issue_id,
    sourceExpectedRemoteVersion: source.remote_version,
    targetIssueId: target.issue_id,
    targetExpectedRemoteVersion: target.remote_version,
    relationKind: relation.relation_kind,
    relationState: "absent",
  };
}

async function refreshView(
  linear: LinearGatewayInterface,
  view: RootReconciliationView,
): Promise<RootReconciliationView> {
  const tree = await linear.readWorkflowIssueTree(view.root.issueId);
  return { ...view, tree, observedAt: tree.observed_at };
}

function mutationReadBackMatches(
  command: LinearWorkflowMutationCommand,
  tree: RootReconciliationView["tree"],
): boolean {
  if (command.kind === "create_workflow_issue") {
    return tree.issues.filter((issue) =>
      issue.parent_issue_id === command.parentIssueId &&
      issue.status_id === command.statusId &&
      issue.title === command.title &&
      issue.description === command.description &&
      JSON.stringify([...issue.labels].sort()) === JSON.stringify([...command.labelNames].sort()),
    ).length === 1;
  }
  if (command.kind === "update_workflow_issue") {
    const issue = tree.issues.find(({ issue_id }) => issue_id === command.target.targetIssueId);
    const parentMatches = command.parentAssignment.mode === "retain" ||
      (command.parentAssignment.mode === "clear" && issue?.parent_issue_id === undefined) ||
      (command.parentAssignment.mode === "set" && issue?.parent_issue_id === command.parentAssignment.parentIssueId);
    return issue?.status_id === command.statusId && issue.title === command.title &&
      issue.description === command.description && issue.is_archived === command.isArchived &&
      parentMatches &&
      (command.order === undefined || issue.order === command.order);
  }
  if (command.kind === "create_workflow_relation") {
    const expected = canonicalRelation(command.relationKind, command.sourceIssueId, command.targetIssueId);
    const present = tree.relations.some((relation) => relation.relation_kind === expected.relationKind &&
      relation.source_issue_id === expected.sourceIssueId && relation.target_issue_id === expected.targetIssueId);
    return command.relationState === "present" ? present : !present;
  }
  return true;
}

function canonicalRelation(
  relationKind: "blocks" | "blocked_by" | "relates_to",
  sourceIssueId: string,
  targetIssueId: string,
): { relationKind: "blocks" | "relates_to"; sourceIssueId: string; targetIssueId: string } {
  return relationKind === "blocked_by"
    ? { relationKind: "blocks", sourceIssueId: targetIssueId, targetIssueId: sourceIssueId }
    : { relationKind, sourceIssueId, targetIssueId };
}

function preservedDescription(
  _target: RootReconciliationView["tree"]["issues"][number],
  markdown: string,
): string {
  return markdown;
}

function primaryIssueLabel(kind: "plan" | "work" | "verify"): string {
  return workflowKindLabel(kind);
}

function treeOperationIssueKey(
  directive: RootDirective,
  operation: Extract<TreeOperation, { kind: "create_node" }>,
): string {
  const identity = JSON.stringify([
    directive.rootDirectiveId,
    operation.parentIssueId,
    operation.issueKind,
    operation.title,
    operation.description,
  ]);
  return `tree-node:${createHash("sha256").update(identity).digest("hex")}`;
}

function rootIssue(view: RootReconciliationView, issueId: string) {
  const root = view.tree.issues.find((issue) => issue.issue_id === issueId);
  if (!root) throw new Error("root_directive_root_missing");
  return root;
}

function isTerminalCycle(issue: RootReconciliationView["tree"]["issues"][number]): boolean {
  return issue.status_category === "completed" || issue.status_category === "canceled" ||
    issue.status_name === "Succeeded" || issue.status_name === "Changes Required" || issue.status_name === "Canceled";
}

function failed(
  directive: RootDirective,
  code: string,
  diagnostic?: RootActionFailureDiagnostic,
): Extract<RootActionMaterializationResult, { kind: "failed" }> {
  return {
    kind: "failed",
    rootDirectiveId: directive.rootDirectiveId,
    code,
    sanitizedReason: code,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function treeOperationFailed(
  directive: RootDirective,
  code: string,
): { kind: "failed"; rootDirectiveId: string; code: string; sanitizedReason: string } {
  return { kind: "failed", rootDirectiveId: directive.rootDirectiveId, code, sanitizedReason: code };
}
