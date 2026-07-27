import { createHash } from "node:crypto";

import type { LinearGatewayInterface, LinearWorkflowMutationCommand } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { HumanActionMaterializerInterface } from "../../human-actions/api/HumanActionMaterializerInterface.js";
import type {
  RootDirective,
  RootReconciliationView,
  TreeOperation,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import {
  cycleOutcomeId,
  findWorkflowIssue,
  planContractSupersessionId,
  parseManagedRecord,
  renderWorkflowIssueDescription,
  rewriteWorkflowIssueDescription,
  serializeManagedRecord,
  workflowIssueLabel,
} from "../../root-reconciliation/api/index.js";
import type { CycleOutcomeRecord, PlanContractSupersessionRecord } from "../../root-reconciliation/api/ManagedRecords.js";
import { deriveCycleUsageAggregate } from "../../root-reconciliation/internal/UsageAggregation.js";
import type {
  RootDirectiveMaterializationResult,
  RootDirectiveMaterializerInterface,
} from "../api/RootDirectiveMaterializerInterface.js";
import { LinearApprovedPlanDagMaterializerImpl } from "./LinearApprovedPlanDagMaterializerImpl.js";

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
    if (action.kind === "materialize_approved_plan_dag") {
      return new LinearApprovedPlanDagMaterializerImpl(this.linear).materialize({ directive, view });
    }
    if (action.kind === "revise_root_tree") return this.applyTreeOperations(directive, view, action.operations);
    if (action.kind === "create_cycle") return this.createCycle(directive, view, action);
    if (action.kind === "supersede_cycle") return this.supersedeCycle(directive, view, action);
    if (action.kind === "conclude_cycle") return this.concludeCycle(directive, view, action);
    if (action.kind === "wait" || action.kind === "acknowledge") {
      return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [] };
    }
    if (action.kind === "replan_current_cycle") return this.replanCycle(directive, view, action);
    if (action.kind === "conclude_root") {
      const root = rootIssue(view, view.root.issueId);
      return this.applyStatusChange(directive, view, root, "In Review", "root_conclusion");
    }
    if (action.kind === "cancel_root") return this.cancelRoot(directive, view, action);
    return failed(directive, "root_directive_action_unsupported");
  }

  private async replanCycle(
    directive: RootDirective,
    view: RootReconciliationView,
    action: Extract<RootDirective["action"], { kind: "replan_current_cycle" }>,
  ): Promise<RootDirectiveMaterializationResult> {
    const cycle = view.tree.issues.find((issue) => issue.issue_id === action.cycleIssueId);
    const plan = view.tree.issues.find((issue) => issue.issue_id === action.planIssueId);
    if (!cycle || !plan || cycle.parent_issue_id !== view.root.issueId || cycle.issue_kind !== "cycle" || cycle.is_archived ||
        plan.parent_issue_id !== cycle.issue_id || plan.issue_kind !== "plan" || plan.is_archived) {
      return failed(directive, "cycle_replan_target_invalid");
    }
    const supersessions = await this.materializePlanContractSupersessions(directive, view, cycle.issue_id, plan.issue_id, action.supersededPlanContractIds);
    if (supersessions.kind === "failed") return supersessions;
    view = supersessions.view;
    if (action.archiveOrRestoreOperations.length > 0) {
      const patched = await this.applyTreeOperations(directive, view, action.archiveOrRestoreOperations);
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

  private async materializePlanContractSupersessions(
    directive: RootDirective,
    view: RootReconciliationView,
    cycleIssueId: string,
    planIssueId: string,
    supersededPlanContractDigests: string[],
  ): Promise<PlanContractSupersessionMaterializationResult> {
    if (supersededPlanContractDigests.length === 0) {
      return supersessionFailed(directive, "cycle_replan_superseded_contract_required");
    }
    if (new Set(supersededPlanContractDigests).size !== supersededPlanContractDigests.length) {
      return supersessionFailed(directive, "cycle_replan_superseded_contract_duplicate");
    }
    const contracts = view.tree.comments.flatMap((comment) => {
      if (comment.issue_id !== planIssueId || comment.author_kind !== "symphony") return [];
      const parsed = parseManagedRecord(comment.body);
      return parsed.ok && parsed.value.kind === "plan_contract" ? [{ comment, record: parsed.value }] : [];
    });
    const records: PlanContractSupersessionRecord[] = [];
    for (const digest of supersededPlanContractDigests) {
      const candidates = contracts.filter(({ record }) => record.planContractDigest === digest);
      if (candidates.length === 0) return supersessionFailed(directive, "cycle_replan_superseded_contract_missing");
      if (candidates.some(({ record }) => record.rootIssueId !== view.root.issueId || record.cycleIssueId !== cycleIssueId)) {
        return supersessionFailed(directive, "cycle_replan_superseded_contract_foreign");
      }
      if (candidates.length !== 1) return supersessionFailed(directive, "cycle_replan_superseded_contract_duplicate");
      records.push({
        kind: "plan_contract_supersession",
        version: 1,
        supersessionId: planContractSupersessionId({
          rootIssueId: view.root.issueId,
          cycleIssueId,
          rootDirectiveId: directive.rootDirectiveId,
          supersededPlanContractDigest: digest,
        }),
        rootIssueId: view.root.issueId,
        cycleIssueId,
        supersededPlanContractDigest: digest,
        sourceRootDirectiveId: directive.rootDirectiveId,
        freshPlanIssueId: planIssueId,
        supersededAt: directive.modelTurn.terminalAt,
      });
    }

    let currentView = view;
    for (const record of records) {
      const body = serializeManagedRecord(record);
      const existing = currentView.tree.comments.filter((comment) => {
        if (comment.issue_id !== planIssueId || comment.author_kind !== "symphony") return false;
        const parsed = parseManagedRecord(comment.body);
        return parsed.ok && parsed.value.kind === "plan_contract_supersession" && parsed.value.supersessionId === record.supersessionId;
      });
      if (existing.length > 1 || (existing.length === 1 && existing[0]!.body !== body)) {
        return supersessionFailed(directive, "cycle_replan_supersession_conflict");
      }
      if (existing.length === 1) continue;

      const root = rootIssue(currentView, currentView.root.issueId);
      const plan = rootIssue(currentView, planIssueId);
      const outcome = await this.linear.mutateWorkflow({
        kind: "append_workflow_comment",
        writeId: `plan-contract-supersession:${record.supersessionId}`,
        expectedProjectId: plan.project_id,
        rootIssueId: currentView.root.issueId,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: plan.issue_id,
          expectedRemoteVersion: plan.remote_version,
          expectedStatusId: plan.status_id,
          expectedParentIssueId: cycleIssueId,
        },
        body,
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
        return supersessionFailed(directive, `cycle_replan_supersession_write_${outcome.kind}`);
      }
      const tree = await this.linear.readWorkflowIssueTree(currentView.root.issueId);
      const confirmed = tree.comments.filter((comment) => {
        if (comment.issue_id !== planIssueId || comment.author_kind !== "symphony" || comment.body !== body) return false;
        const parsed = parseManagedRecord(comment.body);
        return parsed.ok && parsed.value.kind === "plan_contract_supersession" && parsed.value.supersessionId === record.supersessionId;
      });
      if (confirmed.length !== 1) return supersessionFailed(directive, "cycle_replan_supersession_read_back_missing");
      currentView = { ...currentView, tree, observedAt: tree.observed_at };
    }
    return { kind: "materialized", view: currentView };
  }

  private async cancelRoot(
    directive: RootDirective,
    view: RootReconciliationView,
    action: Extract<RootDirective["action"], { kind: "cancel_root" }>,
  ): Promise<RootDirectiveMaterializationResult> {
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
        cycleOutcomeDetailsForCancellation(view, cycle.issue_id, action),
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
  ): Promise<RootDirectiveMaterializationResult> {
    const current = view.tree.issues.find((issue) => issue.issue_id === action.currentCycleIssueId);
    if (!current || current.parent_issue_id !== view.root.issueId || current.issue_kind !== "cycle" || current.is_archived) {
      return failed(directive, "successor_cycle_current_target_invalid");
    }
    const concluded = await this.terminalizeCycle(
      directive,
      view,
      current,
      "Changes Required",
      cycleOutcomeDetailsForSupersession(view, current.issue_id, action),
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
  ): Promise<RootDirectiveMaterializationResult> {
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
    if (predecessor) {
      const predecessorOutcome = cycleOutcomeFor(view, predecessor.issue_id);
      if (predecessorOutcome.kind === "invalid") return failed(directive, `successor_cycle_predecessor_outcome_${predecessorOutcome.code}`);
      if (!outcomeMatchesCycleStatus(predecessorOutcome.record, predecessor.status_name)) {
        return failed(directive, "successor_cycle_predecessor_outcome_status_mismatch");
      }
      if (action.reason === "exhausted" && predecessorOutcome.record.conclusion !== "exhausted") {
        return failed(directive, "successor_cycle_predecessor_outcome_reason_mismatch");
      }
    }
    const cycleKey = `${directive.rootDirectiveId}:cycle`;
    let currentView = view;
    let cycle = findWorkflowIssue(currentView.tree, cycleKey);
    if (!cycle) {
      const status = currentView.tree.status_catalog.find(({ name }) => name === "Planning");
      const root = rootIssue(currentView, view.root.issueId);
      if (!status) return failed(directive, "successor_cycle_status_missing");
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_workflow_issue",
        writeId: cycleKey,
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        parentExpectedRemoteVersion: root.remote_version,
        parentExpectedStatusId: root.status_id,
        parentIssueId: root.issue_id,
        title: `Cycle ${currentView.tree.issues.filter((issue) => issue.issue_kind === "cycle").length + 1}`,
        description: renderWorkflowIssueDescription({
          issueKey: cycleKey,
          rootIssueId: root.issue_id,
          parentIssueId: root.issue_id,
          issueKind: "cycle",
          markdown: action.planTrigger,
        }),
        statusId: status.status_id,
        labelNames: [workflowIssueLabel("cycle")],
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return failed(directive, `cycle_create_${outcome.kind}`);
      currentView = await refreshView(this.linear, currentView);
      cycle = findWorkflowIssue(currentView.tree, cycleKey);
      if (!cycle) return failed(directive, "successor_cycle_read_back_missing");
    }
    if (predecessor && !currentView.tree.relations.some((relation) =>
      relation.relation_kind === "relates_to" && relation.source_issue_id === predecessor.issue_id && relation.target_issue_id === cycle!.issue_id)) {
      const root = rootIssue(currentView, view.root.issueId);
      const source = rootIssue(currentView, predecessor.issue_id);
      const target = rootIssue(currentView, cycle!.issue_id);
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_workflow_relation",
        writeId: `${cycleKey}:predecessor`,
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
    const planKey = `${directive.rootDirectiveId}:plan`;
    let plan = findWorkflowIssue(currentView.tree, planKey);
    if (!plan) {
      const cycleNow = rootIssue(currentView, cycle!.issue_id);
      const status = currentView.tree.status_catalog.find(({ name }) => name === "Todo");
      if (!status) return failed(directive, "successor_plan_status_missing");
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_workflow_issue",
        writeId: planKey,
        expectedProjectId: cycleNow.project_id,
        rootIssueId: view.root.issueId,
        expectedRootRemoteVersion: rootIssue(currentView, view.root.issueId).remote_version,
        parentExpectedRemoteVersion: cycleNow.remote_version,
        parentExpectedStatusId: cycleNow.status_id,
        parentIssueId: cycleNow.issue_id,
        title: "Plan",
        description: renderWorkflowIssueDescription({
          issueKey: planKey,
          rootIssueId: view.root.issueId,
          parentIssueId: cycleNow.issue_id,
          issueKind: "plan",
          markdown: action.planTrigger,
        }),
        statusId: status.status_id,
        labelNames: [workflowIssueLabel("plan")],
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return failed(directive, `successor_plan_${outcome.kind}`);
      currentView = await refreshView(this.linear, currentView);
      plan = findWorkflowIssue(currentView.tree, planKey);
    }
    return plan
      ? { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [cycle.issue_id, plan.issue_id] }
      : failed(directive, "successor_plan_read_back_missing");
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
    return this.terminalizeCycle(directive, view, cycle, statusName, {
      conclusion: action.conclusion,
      completedWorkIds: action.completedWorkIds,
      unresolvedFindingIds: action.unresolvedFindingIds,
      attemptedApproachRefs: action.attemptedApproachRefs,
      verificationEvidenceRefs: action.verificationEvidenceRefs,
    }, "cycle_conclusion");
  }

  private async terminalizeCycle(
    directive: RootDirective,
    view: RootReconciliationView,
    cycle: RootReconciliationView["tree"]["issues"][number],
    statusName: "Succeeded" | "Changes Required" | "Canceled",
    details: CycleOutcomeDetails,
    failurePrefix: string,
  ): Promise<RootDirectiveMaterializationResult> {
    const outcome = buildCycleOutcome(directive, view, cycle.issue_id, details);
    if (outcome.kind === "invalid") return failed(directive, outcome.code);
    const persisted = await this.materializeCycleOutcome(directive, view, cycle, outcome.record);
    if (persisted.kind === "failed") return persisted;
    const refreshedCycle = persisted.view.tree.issues.find((issue) => issue.issue_id === cycle.issue_id);
    if (!refreshedCycle) return failed(directive, "cycle_outcome_read_back_cycle_missing");
    if (isTerminalCycle(refreshedCycle)) {
      return refreshedCycle.status_name === statusName
        ? { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [cycle.issue_id] }
        : failed(directive, "cycle_outcome_terminal_status_conflict");
    }
    return this.applyStatusChange(directive, persisted.view, refreshedCycle, statusName, failurePrefix);
  }

  private async materializeCycleOutcome(
    directive: RootDirective,
    view: RootReconciliationView,
    cycle: RootReconciliationView["tree"]["issues"][number],
    record: CycleOutcomeRecord,
  ): Promise<
    | { kind: "materialized"; view: RootReconciliationView }
    | { kind: "failed"; rootDirectiveId: string; code: string; sanitizedReason: string }
  > {
    const existing = cycleOutcomeFor(view, cycle.issue_id);
    if (existing.kind === "invalid" && existing.code !== "missing") {
      return cycleOutcomeFailed(directive, `cycle_outcome_${existing.code}`);
    }
    const body = serializeManagedRecord(record);
    if (existing.kind === "valid") {
      const matching = existing.comment.body === body && existing.record.cycleOutcomeId === record.cycleOutcomeId;
      return matching
        ? { kind: "materialized", view }
        : cycleOutcomeFailed(directive, "cycle_outcome_conflict");
    }
    if (isTerminalCycle(cycle)) return cycleOutcomeFailed(directive, "cycle_outcome_terminal_status_without_record");
    const root = rootIssue(view, view.root.issueId);
    const outcome = await this.linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId: `cycle-outcome:${record.cycleOutcomeId}`,
      expectedProjectId: cycle.project_id,
      rootIssueId: view.root.issueId,
      expectedRootRemoteVersion: root.remote_version,
      target: {
        targetIssueId: cycle.issue_id,
        expectedRemoteVersion: cycle.remote_version,
        expectedStatusId: cycle.status_id,
        expectedParentIssueId: view.root.issueId,
      },
      body,
    });
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
      return cycleOutcomeFailed(directive, `cycle_outcome_write_${outcome.kind}`);
    }
    const refreshed = await refreshView(this.linear, view);
    const confirmed = cycleOutcomeFor(refreshed, cycle.issue_id);
    if (
      confirmed.kind !== "valid" ||
      confirmed.comment.body !== body ||
      confirmed.record.cycleOutcomeId !== record.cycleOutcomeId
    ) {
      return cycleOutcomeFailed(directive, "cycle_outcome_read_back_missing");
    }
    return { kind: "materialized", view: refreshed };
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
    let currentView = view;
    const sourceIssueIds = new Set<string>();
    const mutatedIssueIds = new Set<string>();
    for (const operation of operations) {
      const effectiveOperation = rebaseOperationPrecondition(operation, currentView, mutatedIssueIds);
      if (effectiveOperation.kind === "reorder_nodes" || effectiveOperation.kind === "replace_dependencies") {
        const specialized = await applyRelationshipOperation(this.linear, directive, currentView, effectiveOperation);
        if (specialized.kind === "failed") return specialized;
        currentView = specialized.view;
        for (const issueId of specialized.sourceIssueIds) sourceIssueIds.add(issueId);
        for (const issueId of specialized.mutatedIssueIds) mutatedIssueIds.add(issueId);
        continue;
      }
      const plan = operationPlan(currentView, directive, effectiveOperation);
      if (!plan) return failed(directive, `cycle_tree_operation_${operation.kind}_unsupported`);
      for (const command of plan.commands) {
        const executed = await executeMutation(this.linear, currentView, directive, command, operation.kind);
        if (executed.kind === "failed") return executed;
        currentView = executed.view;
        for (const issueId of mutationIssueIds(command)) mutatedIssueIds.add(issueId);
      }
      for (const issueId of plan.sourceIssueIds) sourceIssueIds.add(issueId);
    }
    return { kind: "materialized", rootDirectiveId: directive.rootDirectiveId, sourceIssueIds: [...sourceIssueIds] };
  }
}

type PlanContractSupersessionMaterializationResult =
  | { kind: "materialized"; view: RootReconciliationView }
  | Extract<RootDirectiveMaterializationResult, { kind: "failed" }>;

function updateIssueCommand(
  view: RootReconciliationView,
  directive: RootDirective,
  target: RootReconciliationView["tree"]["issues"][number],
  statusId: string,
  description?: string,
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
    description: description === undefined ? target.description : preservedDescription(target, description),
    isArchived: target.is_archived,
    parentAssignment: { mode: "retain" },
  };
}

function supersessionFailed(
  directive: RootDirective,
  code: string,
): Extract<RootDirectiveMaterializationResult, { kind: "failed" }> {
  return { kind: "failed", rootDirectiveId: directive.rootDirectiveId, code, sanitizedReason: code };
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
    const issueKind = operation.issueKind === "human_action" ? "human" : operation.issueKind;
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
        description: renderWorkflowIssueDescription({
          issueKey,
          rootIssueId: view.root.issueId,
          parentIssueId: operation.parentIssueId,
          issueKind,
          markdown: operation.description,
        }),
        statusId: status.status_id,
        labelNames: [workflowIssueLabel(issueKind)],
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
        isArchived: target.is_archived,
        parentAssignment: { mode: "retain" },
        order: target.order,
      }],
      sourceIssueIds: [target.issue_id],
    };
  }
  if (operation.kind === "archive_node" || operation.kind === "restore_node") {
    const target = view.tree.issues.find((issue) => issue.issue_id === operation.precondition.targetIssueId);
    if (!target || target.remote_version !== operation.precondition.expectedRemoteVersion) return undefined;
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
        isArchived: operation.kind === "archive_node",
        parentAssignment: { mode: "retain" },
        order: target.order,
      }],
      sourceIssueIds: [target.issue_id],
    };
  }
  if (operation.kind === "reorder_nodes" || operation.kind === "replace_dependencies") return undefined;
  if (operation.kind === "create_relation") {
    const source = view.tree.issues.find((issue) => issue.issue_id === operation.sourceIssueId);
    const target = view.tree.issues.find((issue) => issue.issue_id === operation.targetIssueId);
    if (!source || !target || source.issue_id === target.issue_id || operation.relationKind === "triggered_by") return undefined;
    if (view.tree.relations.some((relation) => relation.relation_kind === operation.relationKind && relation.source_issue_id === source.issue_id && relation.target_issue_id === target.issue_id)) {
      return { commands: [], sourceIssueIds: [source.issue_id, target.issue_id] };
    }
    return {
      commands: [createRelationCommand(view, directive, source, target, operation.relationKind, "relation")],
      sourceIssueIds: [source.issue_id, target.issue_id],
    };
  }
  if (operation.kind === "remove_relation") {
    const relation = view.tree.relations.find(({ relation_id }) => relation_id === operation.relationId);
    const target = view.tree.issues.find(({ issue_id }) => issue_id === operation.precondition.targetIssueId);
    const source = relation ? view.tree.issues.find(({ issue_id }) => issue_id === relation.source_issue_id) : undefined;
    if (!relation || !target || !source || relation.target_issue_id !== target.issue_id ||
        target.remote_version !== operation.precondition.expectedRemoteVersion) return undefined;
    return {
      commands: [removeRelationCommand(view, directive, relation, source, target)],
      sourceIssueIds: [source.issue_id, target.issue_id],
    };
  }
  return undefined;
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
  relationKind: "blocks" | "blocked_by" | "relates_to" | "triggered_by",
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
    return tree.issues.some((issue) =>
      issue.workflow_issue_key === command.writeId &&
      issue.parent_issue_id === command.parentIssueId &&
      issue.status_id === command.statusId &&
      issue.title === command.title &&
      issue.description === command.description &&
      JSON.stringify([...issue.labels].sort()) === JSON.stringify([...command.labelNames].sort()),
    );
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
    const present = tree.relations.some((relation) => relation.relation_kind === command.relationKind &&
      relation.source_issue_id === command.sourceIssueId && relation.target_issue_id === command.targetIssueId);
    return command.relationState === "present" ? present : !present;
  }
  return true;
}

function preservedDescription(
  target: RootReconciliationView["tree"]["issues"][number],
  markdown: string,
): string {
  return target.issue_kind === "root" ? markdown : rewriteWorkflowIssueDescription(target, markdown);
}

function buildCycleOutcome(
  directive: RootDirective,
  view: RootReconciliationView,
  cycleIssueId: string,
  details: CycleOutcomeDetails,
): { kind: "valid"; record: CycleOutcomeRecord } | { kind: "invalid"; code: string } {
  const planContract = activeCyclePlanContract(view, cycleIssueId);
  if (planContract.kind === "invalid") return planContract;
  let budgetUsage: CycleOutcomeRecord["budgetUsage"];
  try {
    const aggregate = deriveCycleUsageAggregate({ tree: view.tree, cycleIssueId });
    if (aggregate.scope !== "cycle") {
      return { kind: "invalid", code: "cycle_outcome_budget_usage_invalid" };
    }
    const groups: CycleOutcomeRecord["budgetUsage"]["groups"] = [];
    for (const group of aggregate.groups) {
      if (group.role === "root_reconciler") return { kind: "invalid", code: "cycle_outcome_budget_usage_invalid" };
      groups.push({
        ...(group.cycleIssueId === undefined ? {} : { cycleIssueId: group.cycleIssueId }),
        role: group.role,
        model: group.model,
        inputTokens: group.inputTokens,
        cachedInputTokens: group.cachedInputTokens,
        outputTokens: group.outputTokens,
        reasoningOutputTokens: group.reasoningOutputTokens,
        totalTokens: group.totalTokens,
        unavailableTurnCount: group.unavailableTurnCount,
      });
    }
    budgetUsage = {
      scope: "cycle",
      sourceRecordCount: aggregate.sourceRecordCount,
      sourceDigest: aggregate.sourceDigest,
      isComplete: aggregate.isComplete,
      unknownTurnCount: aggregate.unknownTurnCount,
      groups,
    };
  } catch {
    return { kind: "invalid", code: "cycle_outcome_budget_usage_invalid" };
  }
  return {
    kind: "valid",
    record: {
      kind: "cycle_outcome",
      version: 1,
      cycleOutcomeId: cycleOutcomeId({
        rootIssueId: view.root.issueId,
        cycleIssueId,
        rootDirectiveId: directive.rootDirectiveId,
      }),
      rootIssueId: view.root.issueId,
      cycleIssueId,
      sourceRootDirectiveId: directive.rootDirectiveId,
      conclusion: details.conclusion,
      ...(planContract.planContractDigest === undefined ? {} : { planContractDigest: planContract.planContractDigest }),
      completedWorkIds: details.completedWorkIds,
      unresolvedFindingIds: details.unresolvedFindingIds,
      attemptedApproachRefs: details.attemptedApproachRefs,
      verificationEvidenceRefs: details.verificationEvidenceRefs,
      gitRevision: view.git.head,
      budgetUsage,
      ...(details.successorReason === undefined ? {} : { successorReason: details.successorReason }),
      concludedAt: directive.modelTurn.terminalAt,
    },
  };
}

type CycleOutcomeDetails = Pick<
  CycleOutcomeRecord,
  "conclusion" | "completedWorkIds" | "unresolvedFindingIds" | "attemptedApproachRefs" | "verificationEvidenceRefs" | "successorReason"
>;

function cycleOutcomeDetailsForSupersession(
  view: RootReconciliationView,
  cycleIssueId: string,
  action: Extract<RootDirective["action"], { kind: "supersede_cycle" }>,
): CycleOutcomeDetails {
  const facts = durableCycleFacts(view, cycleIssueId);
  return {
    conclusion: "superseded",
    completedWorkIds: facts.completedWorkIds,
    unresolvedFindingIds: action.unresolvedFindingIds,
    attemptedApproachRefs: mergeEvidenceRefs(action.preservedEvidenceRefs, facts.attemptedApproachRefs),
    verificationEvidenceRefs: facts.verificationEvidenceRefs,
    successorReason: action.reason === "root_contract_changed" ? "root_contract_changed" : "repair_required",
  };
}

function cycleOutcomeDetailsForCancellation(
  view: RootReconciliationView,
  cycleIssueId: string,
  action: Extract<RootDirective["action"], { kind: "cancel_root" }>,
): CycleOutcomeDetails {
  const facts = durableCycleFacts(view, cycleIssueId);
  return {
    conclusion: "canceled",
    completedWorkIds: facts.completedWorkIds,
    unresolvedFindingIds: facts.unresolvedFindingIds,
    attemptedApproachRefs: mergeEvidenceRefs(action.preservedFactRefs, facts.attemptedApproachRefs),
    verificationEvidenceRefs: facts.verificationEvidenceRefs,
  };
}

function durableCycleFacts(
  view: RootReconciliationView,
  cycleIssueId: string,
): Pick<CycleOutcomeDetails, "completedWorkIds" | "unresolvedFindingIds" | "attemptedApproachRefs" | "verificationEvidenceRefs"> {
  const cycleIssueIds = cycleDescendantIssueIds(view, cycleIssueId);
  const results = view.tree.comments.flatMap((comment) => {
    if (comment.author_kind !== "symphony" || !cycleIssueIds.has(comment.issue_id)) return [];
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === "stage_result" &&
      parsed.value.rootIssueId === view.root.issueId && parsed.value.cycleIssueId === cycleIssueId &&
      cycleIssueIds.has(parsed.value.nodeIssueId)
      ? [parsed.value]
      : [];
  });
  const workResults = results.filter(({ stage }) => stage === "work");
  const verifyResults = results.filter(({ stage }) => stage === "verify");
  const verifyExecutionIds = new Set(verifyResults.map(({ modelTurn }) => modelTurn.stageExecutionId));
  for (const comment of view.tree.comments) {
    if (comment.author_kind !== "symphony" || !cycleIssueIds.has(comment.issue_id)) continue;
    const parsed = parseManagedRecord(comment.body);
    if (parsed.ok && parsed.value.kind === "verify_result" &&
      parsed.value.rootIssueId === view.root.issueId && parsed.value.cycleIssueId === cycleIssueId &&
      cycleIssueIds.has(parsed.value.nodeIssueId)) {
      verifyExecutionIds.add(parsed.value.stageExecutionId);
    }
  }
  const closedFindingIds = new Set(view.tree.comments.flatMap((comment) => {
    if (comment.author_kind !== "symphony") return [];
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === "finding_disposition" &&
      verifyExecutionIds.has(parsed.value.sourceVerifyId) &&
      ["resolved", "waived"].includes(parsed.value.disposition)
      ? [parsed.value.findingId]
      : [];
  }));
  const unresolvedFindingIds = view.tree.comments.flatMap((comment) => {
    if (comment.author_kind !== "symphony") return [];
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === "finding" &&
      verifyExecutionIds.has(parsed.value.sourceVerifyId) && !closedFindingIds.has(parsed.value.findingId)
      ? [parsed.value.findingId]
      : [];
  });
  return {
    completedWorkIds: uniqueSorted(workResults.filter(({ outcomeKind }) => outcomeKind === "work_completed").map(({ nodeIssueId }) => nodeIssueId)),
    unresolvedFindingIds: uniqueSorted(unresolvedFindingIds),
    attemptedApproachRefs: resultEvidenceRefs(workResults),
    verificationEvidenceRefs: resultEvidenceRefs(verifyResults),
  };
}

function cycleDescendantIssueIds(view: RootReconciliationView, cycleIssueId: string): Set<string> {
  const descendants = new Set([cycleIssueId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const issue of view.tree.issues) {
      if (issue.parent_issue_id && descendants.has(issue.parent_issue_id) && !descendants.has(issue.issue_id)) {
        descendants.add(issue.issue_id);
        changed = true;
      }
    }
  }
  return descendants;
}

function resultEvidenceRefs(results: Array<{ resultId: string }>): CycleOutcomeDetails["attemptedApproachRefs"] {
  return uniqueSorted(results.map(({ resultId }) => resultId)).map((referenceId) => ({ referenceId, sourceKind: "result" }));
}

function mergeEvidenceRefs(
  primary: CycleOutcomeDetails["attemptedApproachRefs"],
  supplemental: CycleOutcomeDetails["attemptedApproachRefs"],
): CycleOutcomeDetails["attemptedApproachRefs"] {
  const seen = new Set<string>();
  return [...primary, ...supplemental].filter((reference) => {
    const key = `${reference.sourceKind}\0${reference.referenceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function activeCyclePlanContract(
  view: RootReconciliationView,
  cycleIssueId: string,
): { kind: "valid"; planContractDigest?: string } | { kind: "invalid"; code: string } {
  const planIssueIds = new Set(view.tree.issues
    .filter((issue) => issue.parent_issue_id === cycleIssueId && issue.issue_kind === "plan")
    .map((issue) => issue.issue_id));
  const contracts = view.tree.comments.flatMap((comment) => {
    if (comment.author_kind !== "symphony" || !planIssueIds.has(comment.issue_id)) return [];
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === "plan_contract" ? [parsed.value] : [];
  });
  if (contracts.some((contract) => contract.rootIssueId !== view.root.issueId || contract.cycleIssueId !== cycleIssueId)) {
    return { kind: "invalid", code: "cycle_outcome_plan_contract_foreign" };
  }
  const superseded = new Set(view.tree.comments.flatMap((comment) => {
    if (comment.author_kind !== "symphony") return [];
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === "plan_contract_supersession" &&
      parsed.value.rootIssueId === view.root.issueId && parsed.value.cycleIssueId === cycleIssueId
      ? [parsed.value.supersededPlanContractDigest]
      : [];
  }));
  const active = contracts.filter((contract) => !superseded.has(contract.planContractDigest));
  if (active.length === 0) return { kind: "valid" };
  if (active.length !== 1) return { kind: "invalid", code: "cycle_outcome_plan_contract_conflict" };
  return { kind: "valid", planContractDigest: active[0]!.planContractDigest };
}

function cycleOutcomeFor(
  view: RootReconciliationView,
  cycleIssueId: string,
):
  | { kind: "valid"; record: CycleOutcomeRecord; comment: RootReconciliationView["tree"]["comments"][number] }
  | { kind: "invalid"; code: "missing" | "conflict" | "foreign" } {
  const outcomes = view.tree.comments.flatMap((comment) => {
    if (comment.issue_id !== cycleIssueId || comment.author_kind !== "symphony") return [];
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === "cycle_outcome" ? [{ record: parsed.value, comment }] : [];
  });
  if (outcomes.length === 0) return { kind: "invalid", code: "missing" };
  if (outcomes.length !== 1) return { kind: "invalid", code: "conflict" };
  const outcome = outcomes[0]!;
  if (outcome.record.rootIssueId !== view.root.issueId || outcome.record.cycleIssueId !== cycleIssueId) {
    return { kind: "invalid", code: "foreign" };
  }
  if (outcome.record.cycleOutcomeId !== cycleOutcomeId({
    rootIssueId: outcome.record.rootIssueId,
    cycleIssueId: outcome.record.cycleIssueId,
    rootDirectiveId: outcome.record.sourceRootDirectiveId,
  })) {
    return { kind: "invalid", code: "foreign" };
  }
  return { kind: "valid", ...outcome };
}

function outcomeMatchesCycleStatus(record: CycleOutcomeRecord, statusName: string): boolean {
  if (record.conclusion === "succeeded") return statusName === "Succeeded";
  if (record.conclusion === "canceled") return statusName === "Canceled";
  return statusName === "Changes Required";
}

function cycleOutcomeFailed(
  directive: RootDirective,
  code: string,
): { kind: "failed"; rootDirectiveId: string; code: string; sanitizedReason: string } {
  return { kind: "failed", rootDirectiveId: directive.rootDirectiveId, code, sanitizedReason: code };
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

function failed(directive: RootDirective, code: string): RootDirectiveMaterializationResult {
  return { kind: "failed", rootDirectiveId: directive.rootDirectiveId, code, sanitizedReason: code };
}

function treeOperationFailed(
  directive: RootDirective,
  code: string,
): { kind: "failed"; rootDirectiveId: string; code: string; sanitizedReason: string } {
  return { kind: "failed", rootDirectiveId: directive.rootDirectiveId, code, sanitizedReason: code };
}
