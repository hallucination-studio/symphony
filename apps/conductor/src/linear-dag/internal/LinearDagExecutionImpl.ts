import {
  decodeConductorPerformerStageResult,
  type JsonValue,
} from "@symphony/contracts";

import type {
  BootstrapPlanExecutionResult,
  BootstrapPlanInput,
  BootstrapPlanReconciliation,
  LinearDagExecutionDependencies,
  LinearDagExecutionInterface,
  WorkStageExecutionResult,
  WorkStageInput,
  WorkStageReconciliation,
  VerifyStageExecutionResult,
  VerifyStageInput,
  VerifyStageReconciliation,
} from "../api/LinearDagExecutionInterface.js";
import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { GitWorkspaceInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type {
  CycleMarker,
  CheckEvidence,
  ManagedRecord,
  PlanContract,
  ProgressAssessment,
  StageExecutionRecord,
  StageTerminalRecord,
  StageUsage,
  VerifyResultRecord,
  WorkCompletionRecord,
} from "../../root-workflow/api/ManagedRecords.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-workflow/api/index.js";
import { acceptVerifyFindings, openFindingSummaries } from "../../root-workflow/internal/FindingPolicy.js";
import { assessProgress } from "../../root-workflow/internal/ProgressPolicy.js";
import { DagMaterializer } from "./DagMaterializer.js";
import { buildRootDagView, currentNodeMarker, RootDagValidationError } from "./RootDagViewBuilder.js";
import { StageContextBuilder, digest } from "./StageContextBuilder.js";

type Issue = LinearWorkflowTreeSnapshot["issues"][number];
type Comment = LinearWorkflowTreeSnapshot["comments"][number];
type Status = LinearWorkflowTreeSnapshot["status_catalog"][number];

const terminalCycleStates = new Set(["Succeeded", "Changes Required", "Canceled"]);

export class LinearDagExecutionImpl implements LinearDagExecutionInterface {
  constructor(
    private readonly dependencies: LinearDagExecutionDependencies,
    private readonly contextBuilder = new StageContextBuilder(),
    private readonly dagMaterializer = new DagMaterializer(),
  ) {}

  async executeBootstrapPlan(input: BootstrapPlanInput): Promise<BootstrapPlanExecutionResult> {
    let stageResult: JsonValue | undefined;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const next = await this.reconcileRoot(input, stageResult);
      if (next.kind === "stage_ready") {
        try {
          stageResult = (await this.dependencies.performer.runStage({
            envelope: next.envelope,
            workspaceRoot: input.workspace.worktreePath,
          })).result;
        } catch (error) {
          await this.dependencies.performer.cancelAndReap();
          throw error;
        }
        continue;
      }
      if (next.kind === "waiting_human") {
        const tree = await this.dependencies.linear.readWorkflowIssueTree(input.rootIssueId);
        const cycle = activeCycle(tree, input.rootIssueId);
        const plan = cycle && child(tree, cycle.issue_id, "plan");
        const contract = plan && recordFrom(recordsByIssue(tree.comments), plan.issue_id, "plan_contract") as PlanContract | undefined;
        if (!cycle || !plan || !contract) throw new Error("bootstrap_plan_read_back_incomplete");
        return { kind: "awaiting_approval", cycleIssueId: cycle.issue_id, planIssueId: plan.issue_id, planContractDigest: contract.planContractDigest };
      }
      if (next.kind === "blocked") throw new Error(next.reason);
      if (next.kind === "completed") {
        const tree = await this.dependencies.linear.readWorkflowIssueTree(input.rootIssueId);
        const cycle = activeCycle(tree, input.rootIssueId);
        const plan = cycle && child(tree, cycle.issue_id, "plan");
        const contract = plan && recordFrom(recordsByIssue(tree.comments), plan.issue_id, "plan_contract") as PlanContract | undefined;
        if (!cycle || !plan || !contract) throw new Error("bootstrap_plan_sealed_read_back_incomplete");
        return { kind: "sealed", cycleIssueId: cycle.issue_id, planIssueId: plan.issue_id, planContractDigest: contract.planContractDigest };
      }
      if (next.kind === "mutation_applied") continue;
    }
    throw new Error("bootstrap_plan_reconciliation_limit_exceeded");
  }

  async executeWorkStage(input: WorkStageInput): Promise<WorkStageExecutionResult> {
    let stageResult: JsonValue | undefined;
    let commitRevision: string | undefined;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const next = await this.reconcileWork(input, stageResult, commitRevision);
      if (next.kind === "stage_ready") {
        try {
          stageResult = (await this.dependencies.performer.runStage({
            envelope: next.envelope,
            workspaceRoot: input.workspace.worktreePath,
          })).result;
        } catch (error) {
          await this.dependencies.performer.cancelAndReap();
          throw error;
        }
        continue;
      }
      if (next.kind === "mutation_applied") {
        if (next.step === "work_committed") commitRevision = (await this.dependencies.git.inspect(input.workspace)).head;
        continue;
      }
      if (next.kind === "blocked") throw new Error(next.reason);
      return next;
    }
    throw new Error("work_stage_reconciliation_limit_exceeded");
  }

  async executeVerifyStage(input: VerifyStageInput): Promise<VerifyStageExecutionResult> {
    let stageResult: JsonValue | undefined;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const next = await this.reconcileVerify(input, stageResult);
      if (next.kind === "stage_ready") {
        try {
          stageResult = (await this.dependencies.performer.runStage({ envelope: next.envelope, workspaceRoot: input.workspace.worktreePath })).result;
        } catch (error) {
          await this.dependencies.performer.cancelAndReap();
          throw error;
        }
        continue;
      }
      if (next.kind === "mutation_applied") continue;
      if (next.kind === "blocked") throw new Error(next.reason);
      return next;
    }
    throw new Error("verify_stage_reconciliation_limit_exceeded");
  }

  async reconcileWork(input: WorkStageInput, stageResult?: JsonValue, commitRevision?: string): Promise<WorkStageReconciliation> {
    const tree = await this.dependencies.linear.readWorkflowIssueTree(input.rootIssueId);
    const root = tree.issues.find((issue) => issue.issue_id === input.rootIssueId);
    if (!root || root.issue_kind !== "root" || root.project_id !== input.projectId || root.status_name !== "In Progress") return workBlocked("work_root_not_runnable");
    const gitSnapshot = await this.dependencies.git.inspect(input.workspace);
    let view;
    try {
      view = buildRootDagView({ tree, git: gitSnapshot, workspace: input.workspace });
    } catch (error) {
      if (error instanceof RootDagValidationError) return workBlocked(`work_tree_invalid:${error.code}`);
      throw error;
    }
    const cycleView = view.cycles.find(({ issue }) => !terminalCycleStates.has(issue.status_name));
    if (!cycleView || !["Sealed", "Executing"].includes(cycleView.issue.status_name)) return workBlocked("work_cycle_not_ready");
    const plan = cycleView.nodes.find((node) => node.issue.issue_kind === "plan");
    const contract = cycleView.planContract;
    if (!plan || !contract || plan.issue.status_name !== "Done") return workBlocked("work_plan_not_complete");

    const workNodes = cycleView.nodes.filter((node) => node.issue.issue_kind === "work");
    const active = workNodes.filter((node) => node.issue.status_name === "In Progress");
    if (active.length > 1) return workBlocked("work_multiple_active_nodes");
    let selected = active[0];
    if (!selected) {
      const ready = workNodes.filter((node) => node.issue.status_name === "Todo" && dependenciesComplete(node, cycleView, plan.issue.issue_id));
      if (ready.length === 0) return workBlocked("work_not_ready");
      const readyWork = ready[0];
      if (!readyWork) return workBlocked("work_selection_invalid");
      selected = readyWork;
      if (cycleView.issue.status_name === "Sealed") {
        await this.updateStatus(input, tree, cycleView.issue, statusByName(tree, "Executing"), "cycle_executing");
        return { kind: "mutation_applied", step: "cycle_executing" };
      }
      await this.updateStatus(input, tree, selected.issue, statusByName(tree, "In Progress"), "work_in_progress");
      return { kind: "mutation_applied", step: "work_in_progress" };
    }
    if (!selected) return workBlocked("work_selection_invalid");

    const records = recordsByIssue(tree.comments);
    const nodeMarker = currentNodeMarker(records.get(selected.issue.issue_id) ?? [], "work");
    if (!nodeMarker || nodeMarker.planContractDigest !== contract.planContractDigest) return workBlocked("work_node_contract_invalid");
    const latestExecution = latestExecutionRecord(records.get(selected.issue.issue_id) ?? []);
    const latestTerminal = latestTerminalRecord(records.get(selected.issue.issue_id) ?? []);
    const completion = recordFrom(records, selected.issue.issue_id, "work_completion") as WorkCompletionRecord | undefined;
    if (completion) {
      if (completion.workKey !== nodeMarker.nodeKey || completion.nodeIssueId !== selected.issue.issue_id || completion.contextDigest.length === 0
        || !latestExecution || latestExecution.stageExecutionId !== completion.stageExecutionId
        || latestExecution.contextDigest !== completion.contextDigest
        || !latestTerminal || latestTerminal.stageExecutionId !== completion.stageExecutionId
        || latestTerminal.contextDigest !== completion.contextDigest || latestTerminal.outcome !== "completed") return workBlocked("work_completion_invalid");
      if (gitSnapshot.head !== completion.commitRevision || gitSnapshot.status.items.length > 0) return workBlocked("work_completion_git_invalid");
      if (selected.issue.status_name !== "Done") {
        await this.updateStatus(input, tree, selected.issue, statusByName(tree, "Done"), "work_done");
        return { kind: "completed", cycleIssueId: cycleView.issue.issue_id, workIssueId: selected.issue.issue_id, workKey: nodeMarker.nodeKey, commitRevision: completion.commitRevision };
      }
      return { kind: "completed", cycleIssueId: cycleView.issue.issue_id, workIssueId: selected.issue.issue_id, workKey: nodeMarker.nodeKey, commitRevision: completion.commitRevision };
    }

    if (stageResult === undefined) {
      if (latestTerminal?.outcome === "completed") return workBlocked("work_completion_missing");
      const stageExecutionId = latestExecution && !latestTerminal
        ? latestExecution.stageExecutionId
        : input.options.stageId?.(input.rootIssueId, cycleView.issue.issue_id, (records.get(selected.issue.issue_id) ?? []).filter((record) => record.kind === "stage_execution").length + 1)
          ?? `${input.rootIssueId}:work:${selected.issue.issue_id}:${(records.get(selected.issue.issue_id) ?? []).filter((record) => record.kind === "stage_execution").length + 1}`;
      const built = await this.contextBuilder.buildWork({
        tree, cycle: cycleView.issue, plan: plan.issue, work: selected.issue, contract,
        dependencyState: dependencyState(selected, cycleView, plan.issue.issue_id), workspace: input.workspace, git: this.dependencies.git,
        stageExecutionId, startedAt: input.options.now?.() ?? new Date().toISOString(), deadlineAt: workDeadline(input), options: input.options,
      });
      if (latestExecution && !latestTerminal) {
        if (latestExecution.contextDigest !== built.executionRecord.contextDigest) return workBlocked("work_execution_context_changed");
        return { kind: "stage_ready", step: "work", envelope: built.envelope };
      }
      await this.appendRecord(input, tree, selected.issue, `${input.rootIssueId}:work:${selected.issue.issue_id}:execution:${stageExecutionId}`, `${input.rootIssueId}:work:${selected.issue.issue_id}:execution:${stageExecutionId}`, built.executionRecord);
      return { kind: "mutation_applied", step: "work_execution_created" };
    }
    if (!latestExecution) return workBlocked("work_execution_missing");
    const validated = validateWorkResult(stageResult, latestExecution);
    if (!latestTerminal) {
      await this.appendRecord(input, tree, selected.issue, `${input.rootIssueId}:work:${selected.issue.issue_id}:terminal:${latestExecution.stageExecutionId}`, `${input.rootIssueId}:work:${selected.issue.issue_id}:terminal:${latestExecution.stageExecutionId}`, stageTerminal(latestExecution, validated));
      return { kind: "mutation_applied", step: "work_stage_terminal" };
    }
    if (latestTerminal.outcome !== "completed") return workBlocked("work_stage_not_completed");
    if (!commitRevision) {
      await validateWorkGit(this.dependencies.git, input.workspace, latestExecution, validated, contract);
      const commit = await this.dependencies.git.commit({
        workspace: input.workspace, rootIssueId: input.rootIssueId, issueId: selected.issue.issue_id,
        allowedIssueIds: [selected.issue.issue_id], issueIdentifier: selected.issue.identifier, expectedHead: latestExecution.repositoryRevision,
      });
      commitRevision = commit.commit;
      return { kind: "mutation_applied", step: "work_committed" };
    }
    const committedSnapshot = await this.dependencies.git.inspect(input.workspace);
    if (committedSnapshot.head !== commitRevision || committedSnapshot.status.items.length > 0) return workBlocked("work_commit_read_back_invalid");
    const completionRecord: WorkCompletionRecord = {
      kind: "work_completion", version: 1, stageExecutionId: latestExecution.stageExecutionId, rootIssueId: input.rootIssueId,
      cycleIssueId: cycleView.issue.issue_id, nodeIssueId: selected.issue.issue_id, workKey: nodeMarker.nodeKey, contextDigest: latestExecution.contextDigest,
      summary: validated.summary, changedPaths: validated.changedPaths, checks: validated.checks, commitRevision,
    };
    await this.appendRecord(input, tree, selected.issue, `${input.rootIssueId}:work:${selected.issue.issue_id}:completion:${latestExecution.stageExecutionId}`, `${input.rootIssueId}:work:${selected.issue.issue_id}:completion:${latestExecution.stageExecutionId}`, completionRecord);
    return { kind: "mutation_applied", step: "work_completion_persisted" };
  }

  async reconcileVerify(input: VerifyStageInput, stageResult?: JsonValue): Promise<VerifyStageReconciliation> {
    const tree = await this.dependencies.linear.readWorkflowIssueTree(input.rootIssueId);
    const root = tree.issues.find((issue) => issue.issue_id === input.rootIssueId);
    if (!root || root.issue_kind !== "root" || root.project_id !== input.projectId || root.status_name !== "In Progress") return verifyBlocked("verify_root_not_runnable");
    const gitSnapshot = await this.dependencies.git.inspect(input.workspace);
    let view;
    try { view = buildRootDagView({ tree, git: gitSnapshot, workspace: input.workspace }); }
    catch (error) { if (error instanceof RootDagValidationError) return verifyBlocked(`verify_tree_invalid:${error.code}`); throw error; }
    const cycleView = view.cycles.find(({ issue }) => !terminalCycleStates.has(issue.status_name));
    if (!cycleView) {
      const terminalCycle = view.cycles.find(({ issue }) => ["Succeeded", "Changes Required", "Inconclusive", "Escalated"].includes(issue.status_name));
      const terminalVerify = terminalCycle?.nodes.find((node) => node.issue.issue_kind === "verify");
      const terminalResult = terminalVerify && terminalVerify.records.find((record): record is VerifyResultRecord => record.kind === "verify_result");
      if (terminalCycle && terminalVerify && terminalResult) return { kind: "completed", cycleIssueId: terminalCycle.issue.issue_id, verifyIssueId: terminalVerify.issue.issue_id, conclusion: terminalResult.conclusion };
      return verifyBlocked("verify_cycle_not_ready");
    }
    if (!["Sealed", "Executing", "Verifying", "Inconclusive", "Escalated"].includes(cycleView.issue.status_name)) return verifyBlocked("verify_cycle_not_ready");
    const plan = cycleView.nodes.find((node) => node.issue.issue_kind === "plan");
    const verify = cycleView.nodes.find((node) => node.issue.issue_kind === "verify");
    const contract = cycleView.planContract;
    if (!plan || !verify || !contract || plan.issue.status_name !== "Done") return verifyBlocked("verify_plan_not_complete");
    if (cycleView.nodes.filter((node) => node.issue.issue_kind === "work").some((node) => node.issue.status_name !== "Done" || !node.records.some((record) => record.kind === "work_completion"))) return verifyBlocked("verify_work_not_complete");
    const statuses = new Map(tree.status_catalog.map((status) => [status.name, status]));
    if (["Sealed", "Executing"].includes(cycleView.issue.status_name)) {
      await this.updateStatus(input, tree, cycleView.issue, statuses.get("Verifying"), "cycle_verifying");
      return { kind: "mutation_applied", step: "cycle_verifying" };
    }
    if (verify.issue.status_name === "Todo") {
      await this.updateStatus(input, tree, verify.issue, statuses.get("In Progress"), "verify_in_progress");
      return { kind: "mutation_applied", step: "verify_in_progress" };
    }
    if (!["In Progress", "Done"].includes(verify.issue.status_name)) return verifyBlocked("verify_node_state_invalid");
    const records = recordsByIssue(tree.comments);
    const latestExecution = latestExecutionRecord(records.get(verify.issue.issue_id) ?? []);
    const latestTerminal = latestTerminalRecord(records.get(verify.issue.issue_id) ?? []);
    const latestResult = latestVerifyResult(records);
    const currentResult = latestExecution && (records.get(verify.issue.issue_id) ?? []).find((record): record is VerifyResultRecord => record.kind === "verify_result" && record.stageExecutionId === latestExecution.stageExecutionId);
    if (currentResult && stageResult === undefined && verify.issue.status_name !== "Done") return verifyBlocked("verify_result_records_incomplete");
    if (!currentResult || (stageResult !== undefined && verify.issue.status_name !== "Done")) {
      if (stageResult === undefined) {
        if (latestTerminal?.outcome === "completed" && !currentResult) return verifyBlocked("verify_result_missing");
        if (currentResult) return verifyBlocked("verify_result_records_incomplete");
        const stageAttempt = (records.get(verify.issue.issue_id) ?? []).filter((record) => record.kind === "stage_execution").length + 1;
        const startedAt = input.options.now?.() ?? new Date().toISOString();
        const stageExecutionId = latestExecution && !latestTerminal ? latestExecution.stageExecutionId : input.options.stageId?.(input.rootIssueId, cycleView.issue.issue_id, stageAttempt) ?? `${input.rootIssueId}:verify:${cycleView.issue.issue_id}:${stageAttempt}`;
        const built = await this.contextBuilder.buildVerify({ tree, cycle: cycleView.issue, plan: plan.issue, verify: verify.issue, contract, workspace: input.workspace, git: this.dependencies.git, stageExecutionId, startedAt, deadlineAt: new Date(Date.parse(startedAt) + input.options.limits.maxWallTimeMs).toISOString(), options: input.options });
        if (latestExecution && !latestTerminal) {
          if (latestExecution.contextDigest !== built.executionRecord.contextDigest) return verifyBlocked("verify_execution_context_changed");
          return { kind: "stage_ready", step: "verify", envelope: built.envelope };
        }
        await this.appendRecord(input, tree, verify.issue, `${input.rootIssueId}:verify:${verify.issue.issue_id}:execution:${stageExecutionId}`, `${input.rootIssueId}:verify:${verify.issue.issue_id}:execution:${stageExecutionId}`, built.executionRecord);
        return { kind: "mutation_applied", step: "verify_execution_created" };
      }
      if (!latestExecution) return verifyBlocked("verify_execution_missing");
      const validated = validateVerifyResult(stageResult, latestExecution, contract, gitSnapshot.head);
      if (!latestTerminal) {
        await this.appendRecord(input, tree, verify.issue, `${input.rootIssueId}:verify:${verify.issue.issue_id}:terminal:${latestExecution.stageExecutionId}`, `${input.rootIssueId}:verify:${verify.issue.issue_id}:terminal:${latestExecution.stageExecutionId}`, stageTerminalFromVerify(latestExecution, validated));
        return { kind: "mutation_applied", step: "verify_stage_terminal" };
      }
      if (latestTerminal.outcome !== "completed") return verifyBlocked("verify_stage_not_completed");
      const findingRecords = allFindingRecords(records);
      const dispositionRecords = allDispositionRecords(records);
      const accepted = acceptVerifyFindings({ sourceVerifyId: latestExecution.stageExecutionId, artifactRevision: validated.verifiedRevision, priorOpenFindings: openFindingSummaries(findingRecords, dispositionRecords), newFindings: validated.newFindings, dispositions: validated.dispositions });
      const previous = latestResultBefore(records, latestExecution.stageExecutionId);
      const currentPassedCriterionKeys = validated.criteriaResults.filter((criterion) => criterion.outcome === "passed").map((criterion) => criterion.criterionKey);
      const currentPassedCheckKeys = validated.checks.filter((check) => check.outcome === "passed").map((check) => check.checkKey);
      const progress: ProgressAssessment = {
        kind: "progress_assessment", version: 1, rootIssueId: input.rootIssueId, previousVerifyId: previous?.stageExecutionId ?? "verify-none", currentVerifyId: latestExecution.stageExecutionId,
        resolvedFindingIds: accepted.dispositions.filter((disposition) => disposition.disposition === "resolved").map((disposition) => disposition.findingId), previousPassedCriterionKeys: previous?.criteriaResults.filter((criterion) => criterion.outcome === "passed").map((criterion) => criterion.criterionKey) ?? [], currentPassedCriterionKeys,
        previousPassedCheckKeys: previous?.checks.filter((check) => check.outcome === "passed").map((check) => check.checkKey) ?? [], currentPassedCheckKeys,
        isProgress: assessProgress({ resolvedFindingIds: accepted.dispositions.filter((disposition) => disposition.disposition === "resolved").map((disposition) => disposition.findingId), previousPassedCriterionKeys: previous?.criteriaResults.filter((criterion) => criterion.outcome === "passed").map((criterion) => criterion.criterionKey) ?? [], currentPassedCriterionKeys, previousPassedCheckKeys: previous?.checks.filter((check) => check.outcome === "passed").map((check) => check.checkKey) ?? [], currentPassedCheckKeys }),
      };
      const verifyRecord: VerifyResultRecord = { kind: "verify_result", version: 1, stageExecutionId: latestExecution.stageExecutionId, rootIssueId: input.rootIssueId, cycleIssueId: cycleView.issue.issue_id, nodeIssueId: verify.issue.issue_id, conclusion: validated.conclusion, criteriaResults: validated.criteriaResults, checks: validated.checks, verifiedRevision: validated.verifiedRevision };
      if (!records.get(verify.issue.issue_id)?.some((record) => record.kind === "verify_result" && record.stageExecutionId === latestExecution.stageExecutionId)) {
        await this.appendRecord(input, tree, verify.issue, `${input.rootIssueId}:verify:${verify.issue.issue_id}:result:${latestExecution.stageExecutionId}`, `${input.rootIssueId}:verify:${verify.issue.issue_id}:result:${latestExecution.stageExecutionId}`, verifyRecord);
        return { kind: "mutation_applied", step: "verify_result_persisted" };
      }
      const missingFinding = accepted.newFindings.find((finding) => !records.get(verify.issue.issue_id)?.some((record) => record.kind === "finding" && record.findingId === finding.findingId));
      if (missingFinding) {
        await this.appendRecord(input, tree, verify.issue, `${input.rootIssueId}:verify:${verify.issue.issue_id}:finding:${missingFinding.findingId}`, `${input.rootIssueId}:verify:${verify.issue.issue_id}:finding:${missingFinding.findingId}`, missingFinding);
        return { kind: "mutation_applied", step: "verify_finding_persisted" };
      }
      const missingDisposition = accepted.dispositions.find((disposition) => !records.get(verify.issue.issue_id)?.some((record) => record.kind === "finding_disposition" && record.findingId === disposition.findingId && record.sourceVerifyId === disposition.sourceVerifyId));
      if (missingDisposition) {
        await this.appendRecord(input, tree, verify.issue, `${input.rootIssueId}:verify:${verify.issue.issue_id}:disposition:${missingDisposition.findingId}`, `${input.rootIssueId}:verify:${verify.issue.issue_id}:disposition:${missingDisposition.findingId}`, missingDisposition);
        return { kind: "mutation_applied", step: "verify_disposition_persisted" };
      }
      if (!records.get(cycleView.issue.issue_id)?.some((record) => record.kind === "progress_assessment" && record.currentVerifyId === latestExecution.stageExecutionId)) {
        await this.appendRecord(input, tree, cycleView.issue, `${input.rootIssueId}:verify:${verify.issue.issue_id}:progress:${latestExecution.stageExecutionId}`, `${input.rootIssueId}:verify:${verify.issue.issue_id}:progress:${latestExecution.stageExecutionId}`, progress);
        return { kind: "mutation_applied", step: "verify_progress_persisted" };
      }
      await this.updateStatus(input, tree, verify.issue, statuses.get("Done"), "verify_done");
      return { kind: "mutation_applied", step: "verify_done" };
    }
    if (verify.issue.status_name !== "Done") {
      await this.updateStatus(input, tree, verify.issue, statuses.get("Done"), "verify_done");
      return { kind: "mutation_applied", step: "verify_done" };
    }
    const conclusion = currentResult?.conclusion ?? latestResult?.conclusion;
    if (!conclusion) return verifyBlocked("verify_result_missing");
    const targetState = conclusion === "passed" ? "Succeeded" : conclusion === "changes_required" ? "Changes Required" : conclusion === "inconclusive" ? "Inconclusive" : "Escalated";
    if (cycleView.issue.status_name !== targetState) {
      await this.updateStatus(input, tree, cycleView.issue, statuses.get(targetState), `cycle_${targetState.toLowerCase().replaceAll(" ", "_")}`);
      return { kind: "mutation_applied", step: `cycle_${targetState.toLowerCase().replaceAll(" ", "_")}` };
    }
    return { kind: "completed", cycleIssueId: cycleView.issue.issue_id, verifyIssueId: verify.issue.issue_id, conclusion };
  }

  async reconcileRoot(input: BootstrapPlanInput, stageResult?: JsonValue): Promise<BootstrapPlanReconciliation> {
    const tree = await this.dependencies.linear.readWorkflowIssueTree(input.rootIssueId);
    const root = tree.issues.find((issue) => issue.issue_id === input.rootIssueId);
    if (!root || root.issue_kind !== "root" || root.project_id !== input.projectId) return blocked("root_read_back_invalid");
    const statuses = new Map(tree.status_catalog.map((status) => [status.name, status]));
    const cycle = activeCycle(tree, input.rootIssueId);
    if (!cycle) {
      if (root.status_name !== "In Progress") return blocked("root_not_runnable");
      const writeId = `${input.rootIssueId}:bootstrap-cycle:create`;
      const marker = `${input.rootIssueId}:cycle:bootstrap`;
      if (tree.issues.some((issue) => issue.managed_marker === marker)) return blocked("cycle_state_unreadable");
      await this.mutateAndReadBack({
        input,
        tree,
        writeId,
        command: createIssue(input, root, root.remote_version, statuses.get("Draft"), "cycle", "Cycle 1: Bootstrap Plan", root.description, marker),
        check: (fresh, outcome) => {
          const issueId = outcomeIssueId(outcome);
          return fresh.issues.some((issue) => issue.issue_id === issueId && issue.issue_kind === "cycle"
            && issue.parent_issue_id === root.issue_id && issue.status_name === "Draft" && issue.managed_marker === marker);
        },
      });
      return { kind: "mutation_applied", step: "cycle_created" };
    }

    const records = recordsByIssue(tree.comments);
    const cycleMarker = recordFrom(records, cycle.issue_id, "cycle_marker") as CycleMarker | undefined;
    if (!cycleMarker) {
      await this.appendRecord(input, tree, cycle, `${input.rootIssueId}:cycle:${cycle.issue_id}:marker`, `${input.rootIssueId}:cycle:${cycle.issue_id}:marker`, {
        kind: "cycle_marker", version: 1, rootIssueId: input.rootIssueId, cycleKey: "cycle-1", trigger: "initial", baselineRevision: await this.dependencies.git.inspect(input.workspace).then((snapshot) => snapshot.head),
      });
      return { kind: "mutation_applied", step: "cycle_marker_created" };
    }

    const plan = child(tree, cycle.issue_id, "plan");
    if (!plan) {
      const writeId = `${input.rootIssueId}:bootstrap-plan:create`;
      const marker = `${input.rootIssueId}:plan:bootstrap`;
      await this.mutateAndReadBack({
        input,
        tree,
        writeId,
        command: createIssue(input, cycle, root.remote_version, statuses.get("Todo"), "plan", "Bootstrap Plan", root.description, marker),
        check: (fresh, outcome) => {
          const issueId = outcomeIssueId(outcome);
          return fresh.issues.some((issue) => issue.issue_id === issueId && issue.issue_kind === "plan"
            && issue.parent_issue_id === cycle!.issue_id && issue.status_name === "Todo" && issue.managed_marker === marker);
        },
      });
      return { kind: "mutation_applied", step: "bootstrap_plan_created" };
    }
    if (!currentNodeMarker(records.get(plan.issue_id) ?? [])) {
      await this.appendRecord(input, tree, plan, `${input.rootIssueId}:plan:${plan.issue_id}:marker`, `${input.rootIssueId}:plan:${plan.issue_id}:marker`, {
        kind: "node_marker", version: 1, rootIssueId: input.rootIssueId, cycleIssueId: cycle.issue_id, nodeKey: "plan-1", nodeKind: "plan", planContractDigest: "pending-plan-contract",
      });
      return { kind: "mutation_applied", step: "bootstrap_plan_marker_created" };
    }
    if (cycle.status_name === "Draft" && plan.status_name === "Todo") {
      await this.updateStatus(input, tree, cycle, statuses.get("Planning"), "cycle_planning");
      return { kind: "mutation_applied", step: "cycle_planning" };
    }
    if (cycle.status_name === "Planning" && plan.status_name === "Todo") {
      await this.updateStatus(input, tree, plan, statuses.get("In Progress"), "plan_in_progress");
      return { kind: "mutation_applied", step: "plan_in_progress" };
    }
    if (root.status_name === "Needs Approval" && plan.status_name === "In Review") {
      return { kind: "waiting_human", step: "plan_approval" };
    }
    if (!["In Progress", "In Review", "Done"].includes(plan.status_name)) return blocked("bootstrap_plan_state_invalid");

    const contract = recordFrom(records, plan.issue_id, "plan_contract") as PlanContract | undefined;
    const latestExecution = latestExecutionRecord(records.get(plan.issue_id) ?? []);
    const latestTerminal = latestTerminalRecord(records.get(plan.issue_id) ?? []);
    if (!contract) {
      const currentTerminal = latestTerminal?.stageExecutionId === latestExecution?.stageExecutionId ? latestTerminal : undefined;
      if (stageResult !== undefined && latestExecution && latestExecution.stageExecutionId === resultExecutionId(stageResult)
        && !currentTerminal) {
        const validated = validatePlanResult(stageResult, latestExecution);
        await this.appendRecord(input, tree, plan, `${input.rootIssueId}:plan:${plan.issue_id}:terminal:${latestExecution.stageExecutionId}`, `${input.rootIssueId}:plan:${plan.issue_id}:terminal:${latestExecution.stageExecutionId}`, stageTerminal(latestExecution, validated));
        return { kind: "mutation_applied", step: "plan_stage_terminal" };
      }
      if (stageResult !== undefined && latestExecution && currentTerminal && latestExecution.stageExecutionId === resultExecutionId(stageResult)) {
        const validated = validatePlanResult(stageResult, latestExecution);
        const managedContract = managedPlanContract(input.rootIssueId, cycle.issue_id, validated.planContract);
        await this.appendRecord(input, tree, plan, `${input.rootIssueId}:plan:${plan.issue_id}:contract`, `${input.rootIssueId}:plan:${plan.issue_id}:contract`, managedContract);
        return { kind: "mutation_applied", step: "plan_contract_persisted" };
      }
      const stageAttempt = (records.get(plan.issue_id) ?? []).filter((record) => record.kind === "stage_execution").length + 1;
      const startedAt = (input.options.now ?? (() => new Date().toISOString()))();
      const deadlineAt = new Date(Date.parse(startedAt) + input.options.limits.maxWallTimeMs).toISOString();
      const stageExecutionId = input.options.stageId?.(input.rootIssueId, cycle.issue_id, stageAttempt)
        ?? `${input.rootIssueId}:plan:${cycle.issue_id}:${stageAttempt}`;
      const built = await this.contextBuilder.build({ tree, cycle, plan, workspace: input.workspace, git: this.dependencies.git, stageExecutionId, startedAt, deadlineAt, options: input.options });
      await this.appendRecord(input, tree, plan, `${input.rootIssueId}:plan:${plan.issue_id}:execution:${stageExecutionId}`, `${input.rootIssueId}:plan:${plan.issue_id}:execution:${stageExecutionId}`, built.executionRecord);
      return { kind: "stage_ready", step: "plan", envelope: built.envelope };
    }
    if (plan.status_name === "In Progress") {
      await this.updateStatus(input, tree, plan, statuses.get("In Review"), "plan_in_review");
      return { kind: "mutation_applied", step: "plan_in_review" };
    }
    const approval = (records.get(input.rootIssueId) ?? []).find((record): record is Extract<ManagedRecord, { kind: "human_action" }> => record.kind === "human_action"
      && record.cycleIssueId === cycle.issue_id && record.nodeIssueId === plan.issue_id && record.requestKind === "needs_approval");
    if (!approval) {
      const contextDigest = latestExecution?.contextDigest ?? contract.planContractDigest;
      await this.appendRecord(input, tree, root, `${input.rootIssueId}:cycle:${cycle.issue_id}:approval`, `${input.rootIssueId}:cycle:${cycle.issue_id}:approval`, {
        kind: "human_action", version: 1, actionId: `${input.rootIssueId}:approval:plan`, rootIssueId: input.rootIssueId,
        cycleIssueId: cycle.issue_id, nodeIssueId: plan.issue_id, requestKind: "needs_approval",
        questionOrProposal: `Approve Plan ${contract.planContractDigest}.`, reason: "The Plan Stage produced a reviewable Plan Contract.",
        impact: "Approval permits Work and Verify node materialization.", contextDigest, expectedRootRemoteVersion: root.remote_version,
      });
      return { kind: "mutation_applied", step: "plan_approval_requested" };
    }
    if (root.status_name === "Needs Approval") return { kind: "waiting_human", step: "plan_approval" };
    if (root.status_name !== "In Progress") return blocked("plan_approval_read_back_invalid");
    if (approval.expectedRootRemoteVersion === root.remote_version) {
      await this.updateStatus(input, tree, root, statuses.get("Needs Approval"), "root_needs_approval");
      return { kind: "mutation_applied", step: "root_needs_approval" };
    }
    const decision = this.dagMaterializer.next({ tree, contract, rootIssueId: input.rootIssueId, projectId: input.projectId, cycleIssueId: cycle.issue_id, planIssueId: plan.issue_id });
    if (decision.kind === "blocked") return blocked(decision.reason);
    if (decision.kind === "complete") return { kind: "completed", planContractDigest: decision.planContractDigest };
    await this.mutateAndReadBack({
      input, tree, writeId: decision.command.writeId, command: decision.command,
      check: (fresh, outcome) => decision.check(fresh, outcome.targetIssueId),
    });
    return { kind: "mutation_applied", step: decision.step };
  }

  private async updateStatus(input: BootstrapPlanInput, tree: LinearWorkflowTreeSnapshot, issue: Issue, status: Status | undefined, step: string): Promise<void> {
    if (!status) throw new Error(`status_missing:${step}`);
    const root = tree.issues.find((candidate) => candidate.issue_id === input.rootIssueId);
    if (!root) throw new Error("root_read_back_invalid");
    await this.mutateAndReadBack({
      input,
      tree,
      writeId: `${input.rootIssueId}:workflow:${step}`,
      command: {
        kind: "update_workflow_issue", writeId: `${input.rootIssueId}:workflow:${step}`,
        expectedProjectId: input.projectId, rootIssueId: input.rootIssueId, expectedRootRemoteVersion: root.remote_version,
        target: { targetIssueId: issue.issue_id, expectedRemoteVersion: issue.remote_version, expectedStatusId: issue.status_id, ...(issue.parent_issue_id ? { expectedParentIssueId: issue.parent_issue_id } : {}), ...(issue.managed_marker ? { expectedManagedMarker: issue.managed_marker } : {}) },
        statusId: status.status_id, title: issue.title, description: issue.description,
      },
      check: (fresh) => fresh.issues.some((candidate) => candidate.issue_id === issue.issue_id
        && candidate.status_name === status.name
        && candidate.parent_issue_id === issue.parent_issue_id
        && candidate.managed_marker === issue.managed_marker),
    });
  }

  private async appendRecord(input: BootstrapPlanInput, tree: LinearWorkflowTreeSnapshot, target: Issue, writeId: string, managedMarker: string, record: ManagedRecord): Promise<void> {
    const root = tree.issues.find((issue) => issue.issue_id === input.rootIssueId);
    if (!root) throw new Error("root_read_back_invalid");
    await this.mutateAndReadBack({
      input,
      tree,
      writeId,
      command: {
        kind: "append_workflow_comment", writeId, expectedProjectId: input.projectId, rootIssueId: input.rootIssueId,
        expectedRootRemoteVersion: root.remote_version,
        target: { targetIssueId: target.issue_id, expectedRemoteVersion: target.remote_version, ...(target.status_id ? { expectedStatusId: target.status_id } : {}), ...(target.parent_issue_id ? { expectedParentIssueId: target.parent_issue_id } : {}), ...(target.managed_marker ? { expectedManagedMarker: target.managed_marker } : {}) },
        body: serializeManagedRecord(record),
      },
      check: (fresh) => fresh.comments.some((comment) => comment.issue_id === target.issue_id && comment.managed_marker === managedMarker && comment.body === serializeManagedRecord(record)),
    });
  }

  private async mutateAndReadBack(input: {
    input: BootstrapPlanInput;
    tree: LinearWorkflowTreeSnapshot;
    writeId: string;
    command: LinearWorkflowMutationCommand;
    check: (tree: LinearWorkflowTreeSnapshot, outcome: { targetIssueId?: string }) => boolean;
  }): Promise<void> {
    const outcome = await this.dependencies.linear.mutateWorkflow(input.command);
    if (outcome.kind === "failed") throw new Error(outcome.summary);
    if (outcome.kind === "precondition_conflict") throw new Error("workflow_precondition_conflict");
    const readBackWriteId = outcome.kind === "write_unconfirmed" ? outcome.readBackTarget.writeId : outcome.readBack.writeId;
    if (readBackWriteId !== input.writeId) throw new Error("workflow_write_read_back_mismatch");
    const targetIssueId = outcome.kind === "write_unconfirmed" ? outcome.readBackTarget.targetIssueId : outcome.readBack.targetIssueId;
    const fresh = await this.dependencies.linear.readWorkflowIssueTree(input.input.rootIssueId);
    if (!input.check(fresh, { targetIssueId })) throw new Error(`workflow_write_unconfirmed:${input.writeId}`);
  }
}

function createIssue(input: BootstrapPlanInput, parent: Issue, rootRemoteVersion: string, status: Status | undefined, issueKind: "cycle" | "plan", title: string, description: string, managedMarker: string): LinearWorkflowMutationCommand {
  if (!status) throw new Error(`status_missing:${issueKind}`);
  return {
    kind: "create_workflow_issue", writeId: `${input.rootIssueId}:bootstrap-${issueKind}:create`, expectedProjectId: input.projectId,
    rootIssueId: input.rootIssueId, expectedRootRemoteVersion: rootRemoteVersion,
    parentExpectedRemoteVersion: parent.remote_version, parentExpectedStatusId: parent.status_id, parentIssueId: parent.issue_id,
    issueKind, title, description, statusId: status.status_id, managedMarker,
  };
}

function activeCycle(tree: LinearWorkflowTreeSnapshot, rootIssueId: string): Issue | undefined {
  return tree.issues.filter((issue) => issue.issue_kind === "cycle" && issue.parent_issue_id === rootIssueId && !terminalCycleStates.has(issue.status_name))
    .sort((left, right) => left.order - right.order || left.issue_id.localeCompare(right.issue_id))[0];
}

function child(tree: LinearWorkflowTreeSnapshot, parentIssueId: string, kind: Issue["issue_kind"]): Issue | undefined {
  return tree.issues.filter((issue) => issue.parent_issue_id === parentIssueId && issue.issue_kind === kind).sort((left, right) => left.order - right.order)[0];
}

function recordsByIssue(comments: Comment[]): Map<string, ManagedRecord[]> {
  const result = new Map<string, ManagedRecord[]>();
  for (const comment of comments) {
    if (!comment.managed_marker) continue;
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok) throw new Error("workflow_managed_record_invalid");
    const records = result.get(comment.issue_id) ?? [];
    records.push(parsed.value);
    result.set(comment.issue_id, records);
  }
  return result;
}

function recordFrom(records: Map<string, ManagedRecord[]>, issueId: string, kind: ManagedRecord["kind"]): ManagedRecord | undefined {
  const matches = (records.get(issueId) ?? []).filter((record) => record.kind === kind);
  if (matches.length > 1) throw new Error(`workflow_${kind}_duplicate`);
  return matches[0];
}

function latestExecutionRecord(records: ManagedRecord[]): StageExecutionRecord | undefined {
  return records.filter((record): record is StageExecutionRecord => record.kind === "stage_execution")
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt)).at(-1);
}

function latestTerminalRecord(records: ManagedRecord[]): StageTerminalRecord | undefined {
  return records.filter((record): record is StageTerminalRecord => record.kind === "stage_terminal")
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt)).at(-1);
}

function outcomeIssueId(outcome: { targetIssueId?: string }): string {
  if (!outcome.targetIssueId) throw new Error("workflow_create_read_back_missing");
  return outcome.targetIssueId;
}

function resultExecutionId(value: JsonValue): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.stage_execution_id !== "string") throw new Error("plan_result_invalid");
  return value.stage_execution_id;
}

function validatePlanResult(value: JsonValue, execution: StageExecutionRecord): { planContract: Record<string, JsonValue>; completedAt: string; usage: StageUsage } {
  let result: JsonValue;
  try { result = decodeConductorPerformerStageResult(value) as JsonValue; } catch { throw new Error("plan_result_invalid"); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("plan_result_invalid");
  if (result.stage_execution_id !== execution.stageExecutionId || result.stage !== "plan"
    || result.root_issue_id !== execution.rootIssueId || result.cycle_issue_id !== execution.cycleIssueId
    || result.node_issue_id !== execution.nodeIssueId || result.context_digest !== execution.contextDigest) throw new Error("plan_result_correlation_invalid");
  if (!result.outcome || typeof result.outcome !== "object" || Array.isArray(result.outcome) || result.outcome.kind !== "plan_completed") throw new Error("plan_result_not_completed");
  const planContract = result.outcome.plan_contract;
  if (!planContract || typeof planContract !== "object" || Array.isArray(planContract)) throw new Error("plan_contract_invalid");
  const workNodes = planContract.work_nodes;
  if (!Array.isArray(workNodes)) throw new Error("plan_contract_invalid");
  const keys = new Set<string>();
  const dependencies = new Map<string, string[]>();
  for (const work of workNodes) {
    if (!work || typeof work !== "object" || Array.isArray(work) || typeof work.work_key !== "string" || keys.has(work.work_key)) throw new Error("plan_contract_work_key_invalid");
    keys.add(work.work_key);
    if (!Array.isArray(work.dependency_work_keys)) throw new Error("plan_contract_dependency_invalid");
    const dependencyKeys = Array.isArray(work.dependency_work_keys) && work.dependency_work_keys.every((dependency) => typeof dependency === "string")
      ? work.dependency_work_keys as string[] : undefined;
    if (!dependencyKeys || dependencyKeys.includes(work.work_key)) throw new Error("plan_contract_dependency_invalid");
    dependencies.set(work.work_key, dependencyKeys);
  }
  for (const dependencyKeys of dependencies.values()) {
    if (dependencyKeys.some((dependency) => !keys.has(dependency))) throw new Error("plan_contract_dependency_invalid");
  }
  assertAcyclic(dependencies);
  const completedAt = typeof result.completed_at === "string" ? result.completed_at : "";
  const usageValue = result.usage;
  const usage: StageUsage = usageValue && typeof usageValue === "object" && !Array.isArray(usageValue) ? {
    inputTokens: numberValue(usageValue.input_tokens), cachedInputTokens: numberValue(usageValue.cached_input_tokens), outputTokens: numberValue(usageValue.output_tokens), reasoningOutputTokens: numberValue(usageValue.reasoning_output_tokens), totalTokens: numberValue(usageValue.total_tokens),
  } : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  return { planContract, completedAt, usage };
}

function assertAcyclic(graph: Map<string, string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error("plan_contract_dependency_cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of graph.keys()) visit(key);
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function dependenciesComplete(node: { blockedByIssueIds: string[] }, cycle: { nodes: Array<{ issue: Issue; marker: { nodeKey: string }; records: ManagedRecord[] }> }, planIssueId: string): boolean {
  return node.blockedByIssueIds.every((dependencyId) => {
    if (dependencyId === planIssueId) return true;
    const dependency = cycle.nodes.find((candidate) => candidate.issue.issue_id === dependencyId);
    if (!dependency || dependency.issue.issue_kind !== "work" || dependency.issue.status_name !== "Done") return false;
    return dependency.records.some((record) => record.kind === "work_completion"
      && record.nodeIssueId === dependency.issue.issue_id && record.workKey === dependency.marker.nodeKey);
  });
}

function dependencyState(selected: { blockedByIssueIds: string[] }, cycle: { nodes: Array<{ issue: Issue; marker: { nodeKey: string }; records: ManagedRecord[] }> }, planIssueId: string): Array<{ workKey: string; terminalOutcome: "completed" | "failed" | "canceled"; commitRevision?: string }> {
  return selected.blockedByIssueIds.map((dependencyId) => {
    if (dependencyId === planIssueId) return { workKey: "plan-1", terminalOutcome: "completed" as const };
    const dependency = cycle.nodes.find((candidate) => candidate.issue.issue_id === dependencyId);
    if (!dependency || dependency.issue.issue_kind !== "work" || dependency.issue.status_name !== "Done") throw new Error("work_dependency_state_invalid");
    const completion = dependency.records.find((record): record is WorkCompletionRecord => record.kind === "work_completion" && record.nodeIssueId === dependency.issue.issue_id && record.workKey === dependency.marker.nodeKey);
    if (!completion) throw new Error("work_dependency_completion_missing");
    return { workKey: dependency.marker.nodeKey, terminalOutcome: "completed" as const, commitRevision: completion.commitRevision };
  });
}

function statusByName(tree: LinearWorkflowTreeSnapshot, name: string): Status | undefined {
  return tree.status_catalog.find((status) => status.name === name);
}

function workDeadline(input: WorkStageInput): string {
  const startedAt = input.options.now?.() ?? new Date().toISOString();
  return new Date(Date.parse(startedAt) + input.options.limits.maxWallTimeMs).toISOString();
}

function diffPaths(text: string): string[] {
  return [...text.matchAll(/^diff --git a\/(.+) b\/(.+)$/gmu)].map((match) => {
    const path = match[2]!;
    if (!safeWorkPath(path)) throw new Error("work_diff_path_invalid");
    return path;
  });
}

function statusPaths(items: string[]): string[] {
  return items.map((item) => {
    if (item.length < 4) throw new Error("work_status_invalid");
    const value = item.slice(3).trim();
    const arrow = value.lastIndexOf(" -> ");
    const path = arrow < 0 ? value : value.slice(arrow + 4);
    if (!safeWorkPath(path)) throw new Error("work_status_path_invalid");
    return path;
  });
}

function safeWorkPath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.split("/").some((part) => part === ".." || part.length === 0);
}

function includedPath(value: string, scopes: string[]): boolean {
  return scopes.some((scope) => value === scope || value.startsWith(`${scope.replace(/\/$/u, "")}/`));
}

function excludedPath(value: string, scopes: string[]): boolean {
  return scopes.some((scope) => value === scope || value.startsWith(`${scope.replace(/\/$/u, "")}/`));
}

interface ValidatedWorkResult {
  completedAt: string;
  usage: StageUsage;
  summary: string;
  changedPaths: string[];
  checks: CheckEvidence[];
  observedWorkspaceRevision: string;
}

function validateWorkResult(value: JsonValue, execution: StageExecutionRecord): ValidatedWorkResult {
  let result: JsonValue;
  try { result = decodeConductorPerformerStageResult(value) as JsonValue; } catch { throw new Error("work_result_invalid"); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("work_result_invalid");
  if (result.stage_execution_id !== execution.stageExecutionId || result.stage !== "work"
    || result.root_issue_id !== execution.rootIssueId || result.cycle_issue_id !== execution.cycleIssueId
    || result.node_issue_id !== execution.nodeIssueId || result.context_digest !== execution.contextDigest) throw new Error("work_result_correlation_invalid");
  if (!result.outcome || typeof result.outcome !== "object" || Array.isArray(result.outcome) || result.outcome.kind !== "work_completed") throw new Error("work_result_not_completed");
  const outcome = result.outcome as Record<string, JsonValue>;
  if (typeof outcome.summary !== "string" || !Array.isArray(outcome.changed_paths) || !Array.isArray(outcome.checks) || typeof outcome.observed_workspace_revision !== "string") throw new Error("work_result_shape_invalid");
  const checks = outcome.checks.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.check_key !== "string" || typeof value.command_or_method !== "string"
      || !["passed", "failed", "not_run"].includes(value.outcome as string)
      || typeof value.summary !== "string" || typeof value.artifact_revision !== "string") {
      throw new Error("work_checks_invalid");
    }
    return {
      checkKey: value.check_key,
      commandOrMethod: value.command_or_method,
      outcome: value.outcome as CheckEvidence["outcome"],
      summary: value.summary,
      artifactRevision: value.artifact_revision,
    };
  });
  const usageValue = result.usage;
  const usage: StageUsage = usageValue && typeof usageValue === "object" && !Array.isArray(usageValue) ? {
    inputTokens: numberValue(usageValue.input_tokens), cachedInputTokens: numberValue(usageValue.cached_input_tokens), outputTokens: numberValue(usageValue.output_tokens), reasoningOutputTokens: numberValue(usageValue.reasoning_output_tokens), totalTokens: numberValue(usageValue.total_tokens),
  } : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  return { completedAt: typeof result.completed_at === "string" ? result.completed_at : "", usage, summary: outcome.summary, changedPaths: outcome.changed_paths as string[], checks, observedWorkspaceRevision: outcome.observed_workspace_revision };
}

interface ValidatedVerifyResult {
  completedAt: string;
  usage: StageUsage;
  conclusion: "passed" | "changes_required" | "inconclusive" | "escalate_human";
  criteriaResults: Array<{ criterionKey: string; outcome: "passed" | "failed" | "not_run"; summary: string }>;
  checks: CheckEvidence[];
  newFindings: Array<{ category: "product" | "code" | "test" | "infra" | "requirement" | "policy"; severity: "critical" | "high" | "medium" | "low"; summary: string }>;
  dispositions: Array<{ findingId: string; disposition: "resolved" | "still_open" | "waived" | "rejected" }>;
  verifiedRevision: string;
}

function validateVerifyResult(value: JsonValue | undefined, execution: StageExecutionRecord, contract: PlanContract, currentRevision: string): ValidatedVerifyResult {
  let result: JsonValue;
  try { result = decodeConductorPerformerStageResult(value as JsonValue) as JsonValue; } catch { throw new Error("verify_result_invalid"); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("verify_result_invalid");
  if (result.stage_execution_id !== execution.stageExecutionId || result.stage !== "verify" || result.root_issue_id !== execution.rootIssueId || result.cycle_issue_id !== execution.cycleIssueId || result.node_issue_id !== execution.nodeIssueId || result.context_digest !== execution.contextDigest) throw new Error("verify_result_correlation_invalid");
  if (!result.outcome || typeof result.outcome !== "object" || Array.isArray(result.outcome) || result.outcome.kind !== "verify_completed") throw new Error("verify_result_not_completed");
  const outcome = result.outcome as Record<string, JsonValue>;
  if (outcome.verified_revision !== execution.repositoryRevision || outcome.verified_revision !== currentRevision) throw new Error("verify_revision_invalid");
  if (!Array.isArray(outcome.criteria_results) || !Array.isArray(outcome.checks) || !Array.isArray(outcome.new_findings) || !Array.isArray(outcome.finding_dispositions)) throw new Error("verify_result_shape_invalid");
  const criteriaResults = outcome.criteria_results.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.criterion_key !== "string" || !["passed", "failed", "not_run"].includes(entry.outcome as string) || typeof entry.summary !== "string") throw new Error("verify_criteria_invalid");
    return { criterionKey: entry.criterion_key, outcome: entry.outcome as "passed" | "failed" | "not_run", summary: entry.summary };
  });
  const expectedCriteria = new Set(contract.verifyNode.acceptanceCriteria.map((criterion) => criterion.criterionKey));
  if (new Set(criteriaResults.map((criterion) => criterion.criterionKey)).size !== criteriaResults.length || criteriaResults.length !== expectedCriteria.size || criteriaResults.some((criterion) => !expectedCriteria.has(criterion.criterionKey))) throw new Error("verify_criteria_invalid");
  const checks = outcome.checks.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.check_key !== "string" || typeof entry.command_or_method !== "string" || !["passed", "failed", "not_run"].includes(entry.outcome as string) || typeof entry.summary !== "string" || entry.artifact_revision !== execution.repositoryRevision) throw new Error("verify_checks_invalid");
    return { checkKey: entry.check_key, commandOrMethod: entry.command_or_method, outcome: entry.outcome as CheckEvidence["outcome"], summary: entry.summary, artifactRevision: entry.artifact_revision };
  });
  if (new Set(checks.map((check) => check.checkKey)).size !== checks.length) throw new Error("verify_checks_invalid");
  const requiredCheckKeys = new Set(contract.verifyNode.requiredChecks.map((check) => check.checkKey));
  if ([...requiredCheckKeys].some((key) => !checks.some((check) => check.checkKey === key && check.outcome === "passed"))) throw new Error("verify_required_check_missing");
  const newFindings = outcome.new_findings.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.category !== "string" || typeof entry.severity !== "string" || typeof entry.summary !== "string") throw new Error("verify_finding_invalid");
    return { category: entry.category as ValidatedVerifyResult["newFindings"][number]["category"], severity: entry.severity as ValidatedVerifyResult["newFindings"][number]["severity"], summary: entry.summary };
  });
  const dispositions = outcome.finding_dispositions.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.finding_id !== "string" || !["resolved", "still_open", "waived", "rejected"].includes(entry.disposition as string)) throw new Error("verify_disposition_invalid");
    return { findingId: entry.finding_id, disposition: entry.disposition as ValidatedVerifyResult["dispositions"][number]["disposition"] };
  });
  const conclusion = outcome.conclusion;
  if (!["passed", "changes_required", "inconclusive", "escalate_human"].includes(conclusion as string)) throw new Error("verify_conclusion_invalid");
  if (conclusion === "passed" && (criteriaResults.some((criterion) => criterion.outcome !== "passed") || checks.some((check) => check.outcome !== "passed"))) throw new Error("verify_passed_evidence_invalid");
  if (conclusion === "changes_required" && newFindings.length === 0 && !dispositions.some((disposition) => disposition.disposition === "still_open")) throw new Error("verify_changes_finding_missing");
  const usageValue = result.usage;
  const usage: StageUsage = usageValue && typeof usageValue === "object" && !Array.isArray(usageValue) ? { inputTokens: numberValue(usageValue.input_tokens), cachedInputTokens: numberValue(usageValue.cached_input_tokens), outputTokens: numberValue(usageValue.output_tokens), reasoningOutputTokens: numberValue(usageValue.reasoning_output_tokens), totalTokens: numberValue(usageValue.total_tokens) } : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  return { completedAt: typeof result.completed_at === "string" ? result.completed_at : "", usage, conclusion: conclusion as ValidatedVerifyResult["conclusion"], criteriaResults, checks, newFindings, dispositions, verifiedRevision: execution.repositoryRevision };
}

async function validateWorkGit(git: GitWorkspaceInterface, workspace: WorkStageInput["workspace"], execution: StageExecutionRecord, result: ValidatedWorkResult, contract: PlanContract): Promise<void> {
  if (result.observedWorkspaceRevision !== execution.repositoryRevision) throw new Error("work_result_revision_invalid");
  if (new Set(result.changedPaths).size !== result.changedPaths.length) throw new Error("work_result_paths_duplicate");
  for (const changedPath of result.changedPaths) {
    if (!safeWorkPath(changedPath) || !includedPath(changedPath, contract.includedScope) || excludedPath(changedPath, contract.excludedScope)) throw new Error("work_scope_invalid");
  }
  const checkKeys = new Set<string>();
  for (const check of result.checks) {
    if (!check || typeof check !== "object" || checkKeys.has(check.checkKey) || check.outcome !== "passed" || check.artifactRevision !== execution.repositoryRevision) throw new Error("work_checks_invalid");
    checkKeys.add(check.checkKey);
  }
  const snapshot = await git.inspect(workspace);
  if (snapshot.head !== execution.repositoryRevision || snapshot.status.partial || snapshot.status.has_more) throw new Error("work_git_baseline_changed");
  const [unstaged, staged] = await Promise.all([
    git.diff(workspace),
    git.diff(workspace, { staged: true }),
  ]);
  if (unstaged.partial || staged.partial) throw new Error("work_diff_incomplete");
  const actualPaths = new Set([...diffPaths(unstaged.text), ...diffPaths(staged.text), ...statusPaths(snapshot.status.items)]);
  const expectedPaths = new Set(result.changedPaths);
  if (actualPaths.size !== expectedPaths.size || [...actualPaths].some((path) => !expectedPaths.has(path))) throw new Error("work_diff_mismatch");
}

function stageTerminal(execution: StageExecutionRecord, result: { completedAt: string; usage: StageUsage; summary?: string }): StageTerminalRecord {
  return {
    kind: "stage_terminal", version: 1, stageExecutionId: execution.stageExecutionId, rootIssueId: execution.rootIssueId,
    cycleIssueId: execution.cycleIssueId, nodeIssueId: execution.nodeIssueId, stage: execution.stage, contextDigest: execution.contextDigest,
    outcome: "completed", completedAt: result.completedAt, summary: result.summary ?? "Plan Contract produced.", usage: result.usage,
  };
}

function stageTerminalFromVerify(execution: StageExecutionRecord, result: ValidatedVerifyResult): StageTerminalRecord {
  return stageTerminal(execution, { completedAt: result.completedAt, usage: result.usage, summary: `Verify concluded ${result.conclusion}.` });
}

function allFindingRecords(records: Map<string, ManagedRecord[]>): import("../../root-workflow/api/ManagedRecords.js").FindingRecord[] {
  return [...records.values()].flatMap((values) => values.filter((record): record is import("../../root-workflow/api/ManagedRecords.js").FindingRecord => record.kind === "finding"));
}

function allDispositionRecords(records: Map<string, ManagedRecord[]>): import("../../root-workflow/api/ManagedRecords.js").FindingDispositionRecord[] {
  return [...records.values()].flatMap((values) => values.filter((record): record is import("../../root-workflow/api/ManagedRecords.js").FindingDispositionRecord => record.kind === "finding_disposition"));
}

function latestVerifyResult(records: Map<string, ManagedRecord[]>): VerifyResultRecord | undefined {
  const executions = new Map([...records.values()].flatMap((values) => values.filter((record): record is StageExecutionRecord => record.kind === "stage_execution")).map((record) => [record.stageExecutionId, record]));
  return [...records.values()].flatMap((values) => values.filter((record): record is VerifyResultRecord => record.kind === "verify_result"))
    .sort((left, right) => (executions.get(left.stageExecutionId)?.startedAt ?? "").localeCompare(executions.get(right.stageExecutionId)?.startedAt ?? "")).at(-1);
}

function latestResultBefore(records: Map<string, ManagedRecord[]>, stageExecutionId: string): VerifyResultRecord | undefined {
  const executions = new Map([...records.values()].flatMap((values) => values.filter((record): record is StageExecutionRecord => record.kind === "stage_execution")).map((record) => [record.stageExecutionId, record]));
  return [...records.values()].flatMap((values) => values.filter((record): record is VerifyResultRecord => record.kind === "verify_result" && record.stageExecutionId !== stageExecutionId))
    .sort((left, right) => (executions.get(left.stageExecutionId)?.startedAt ?? "").localeCompare(executions.get(right.stageExecutionId)?.startedAt ?? "")).at(-1);
}

function managedPlanContract(rootIssueId: string, cycleIssueId: string, value: Record<string, JsonValue>): PlanContract {
  const planContractDigest = digest(value);
  const criteria = arrayOfRecords(value.acceptance_criteria).map(criterion);
  if (arrayOfStrings(value.included_scope).length === 0 || criteria.length === 0) throw new Error("plan_contract_acceptance_invalid");
  const workNodes = arrayOfRecords(value.work_nodes).map((work) => {
    const acceptanceCriteria = arrayOfRecords(work.acceptance_criteria).map(criterion);
    if (acceptanceCriteria.length === 0) throw new Error("plan_contract_work_acceptance_invalid");
    return {
      workKey: stringValue(work.work_key), title: stringValue(work.title), description: stringValue(work.description),
      acceptanceCriteria, dependencyWorkKeys: arrayOfStrings(work.dependency_work_keys),
    };
  });
  const verify = objectValue(value.verify_node);
  const verifyCriteria = arrayOfRecords(verify.acceptance_criteria).map(criterion);
  if (verifyCriteria.length === 0) throw new Error("plan_contract_verify_invalid");
  return {
    kind: "plan_contract", version: 1, rootIssueId, cycleIssueId, planContractDigest,
    objectiveSummary: stringValue(value.objective_summary), includedScope: arrayOfStrings(value.included_scope), excludedScope: arrayOfStrings(value.excluded_scope),
    acceptanceCriteria: criteria, workNodes,
    verifyNode: {
      title: stringValue(verify.title), acceptanceCriteria: verifyCriteria,
      requiredChecks: arrayOfStrings(verify.required_checks).map((commandOrMethod, index) => ({ checkKey: `check-${index + 1}`, commandOrMethod, outcome: "not_run", summary: "Required by the Plan Contract.", artifactRevision: planContractDigest })),
    },
  };
}

function criterion(value: Record<string, JsonValue>) {
  return { criterionKey: stringValue(value.criterion_key), statement: stringValue(value.statement), verificationMethod: stringValue(value.verification_method) };
}

function arrayOfRecords(value: JsonValue | undefined): Array<Record<string, JsonValue>> {
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error("plan_contract_shape_invalid");
  return value as Array<Record<string, JsonValue>>;
}

function arrayOfStrings(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("plan_contract_shape_invalid");
  return value as string[];
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plan_contract_shape_invalid");
  return value as Record<string, JsonValue>;
}

function stringValue(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error("plan_contract_shape_invalid");
  return value;
}

function blocked(reason: string): BootstrapPlanReconciliation {
  return { kind: "blocked", reason };
}

function workBlocked(reason: string): WorkStageReconciliation {
  return { kind: "blocked", reason };
}

function verifyBlocked(reason: string): VerifyStageReconciliation {
  return { kind: "blocked", reason };
}
