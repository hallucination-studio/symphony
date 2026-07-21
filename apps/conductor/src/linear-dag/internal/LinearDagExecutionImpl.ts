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
} from "../api/LinearDagExecutionInterface.js";
import type {
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  CycleMarker,
  ManagedRecord,
  PlanContract,
  StageExecutionRecord,
  StageTerminalRecord,
  StageUsage,
} from "../../root-workflow/api/ManagedRecords.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-workflow/api/index.js";
import { StageContextBuilder, digest } from "./StageContextBuilder.js";

type Issue = LinearWorkflowTreeSnapshot["issues"][number];
type Comment = LinearWorkflowTreeSnapshot["comments"][number];
type Status = LinearWorkflowTreeSnapshot["status_catalog"][number];

const terminalCycleStates = new Set(["Succeeded", "Changes Required", "Canceled"]);

export class LinearDagExecutionImpl implements LinearDagExecutionInterface {
  constructor(
    private readonly dependencies: LinearDagExecutionDependencies,
    private readonly contextBuilder = new StageContextBuilder(),
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
      if (next.kind === "completed") throw new Error("bootstrap_plan_unexpected_terminal_state");
      if (next.kind === "mutation_applied") continue;
    }
    throw new Error("bootstrap_plan_reconciliation_limit_exceeded");
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
    if (!recordFrom(records, plan.issue_id, "node_marker")) {
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
    if (plan.status_name !== "In Progress" && plan.status_name !== "In Review") return blocked("bootstrap_plan_state_invalid");

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
    if (root.status_name !== "Needs Approval") {
      await this.updateStatus(input, tree, root, statuses.get("Needs Approval"), "root_needs_approval");
      return { kind: "mutation_applied", step: "root_needs_approval" };
    }
    return { kind: "waiting_human", step: "plan_approval" };
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

function stageTerminal(execution: StageExecutionRecord, result: { completedAt: string; usage: StageUsage }): StageTerminalRecord {
  return {
    kind: "stage_terminal", version: 1, stageExecutionId: execution.stageExecutionId, rootIssueId: execution.rootIssueId,
    cycleIssueId: execution.cycleIssueId, nodeIssueId: execution.nodeIssueId, stage: "plan", contextDigest: execution.contextDigest,
    outcome: "completed", completedAt: result.completedAt, summary: "Plan Contract produced.", usage: result.usage,
  };
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
