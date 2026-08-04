import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  cycleCompletionTerminalStatus,
  parseCycleCompletionRecord,
  parseCycleInvalidationRecord,
  parseStageCompletionRecord,
  parseStageInvalidationRecord,
  stageCompletionTerminalStatus,
  type CycleCompletionRecord,
  type CycleInvalidationRecord,
  type SealedCycleBasis,
  type StageCompletionRecord,
  type StageInvalidationRecord,
} from "../../contracts/cycle-records.js";
import { parseTaskIssueId, type TaskIssueId, type TaskStateId } from "../../contracts/identity.js";
import type { CycleAdvanceRequest } from "../../contracts/cycle.js";
import type { StageExecutionSnapshot } from "../../contracts/cycle.js";
import { canonicalTaskRevision, type TaskIssueSnapshot } from "../../contracts/task-management.js";
import type { GitCommitProofBasis } from "../../git/api/GitWorkspaceInterface.js";
import {
  deriveLastValidCycleBasisStatus,
  deriveLastValidStageBasisStatus,
  type LastValidCycleBasisStatus,
  type LastValidStageBasisStatus,
} from "../../observation/TaskFacts.js";
import type { VerifyResult, WorkResult } from "../../performer/api/StagePerformerInterface.js";
import type { TaskManageCallerIssuer } from "../../task-management/api/TaskManageCapability.js";
import type { TaskWorkflowIdentities } from "../../task-management/api/TaskManageCapability.js";
import type { TaskIssueRecordObservation } from "../../contracts/task-management.js";
import type { TaskManageBoundaryExecution, TaskManageCommandInterface } from "../../task-management/api/TaskManageCommandInterface.js";
import { TASK_MCP_CAPABILITIES, type UpdateIssueCall } from "../../task-management/mcp/TaskMcpSchemas.js";
import type { LinearIssueRecordComment } from "../../task-management/linear/LinearQueries.js";
import {
  bindCycleTaskManageCommand,
  type StageInvalidationProjectionProof,
} from "../../runtime/CycleTaskManageCommand.js";
import { appliedTaskIssueRecord, createTaskIssueRecordCall, readExactTaskIssueRecord } from "./CycleRecords.js";
import {
  assertExactPlanGraph,
  buildPlanGraphManifest,
  materializePersistedPlanGraphManifest,
  type BuiltPlanGraphManifest,
} from "./PlanGraphManifest.js";
import {
  parseSealedFactMutationObservation,
  type SealedFactMutationObservation,
} from "../api/CycleMachineInterface.js";

export interface FreshIssueRecordReader {
  readIssueRecordComments(issueId: TaskIssueId): Promise<readonly LinearIssueRecordComment[]>;
  readIssueCreationEvidence(issueId: TaskIssueId): Promise<{
    readonly issue_id: TaskIssueId;
    readonly provider_created_at: string;
    readonly actor_id: string | null;
  }>;
}

export interface PlanCompletionRecordWriterOptions {
  readonly caller_issuer: TaskManageCallerIssuer;
  readonly workflow: TaskWorkflowIdentities;
  readonly task_manager: TaskManageCommandInterface;
  readonly record_reader: FreshIssueRecordReader;
  readonly service_actor_id: string;
}

export interface PersistedCommitBasis {
  readonly proof: GitCommitProofBasis;
  readonly workspace_parent_revision_digest: string;
  readonly workspace_diff_digest: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalDigest(value: unknown): string {
  return canonicalTaskRevision(value).slice("symphony:v1:".length);
}

function graphSeal(built: BuiltPlanGraphManifest): string {
  return canonicalDigest(built.manifest);
}

function stageListForDigest(snapshot: CycleAdvanceRequest): unknown {
  return {
    plan_issue: snapshot.plan_issue,
    sealed_work_issues: snapshot.sealed_work_issues,
    verify_issue: snapshot.verify_issue,
    sealed_relations: snapshot.sealed_relations,
  };
}

function traceability(built: BuiltPlanGraphManifest): string {
  const encoded = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
  return [
    "## Traceability",
    "",
    ...built.manifest.ordered_work_nodes.map((node) => (
      `- Work \`${encoded(node.issue_id)}\` implements approved group \`${encoded(node.approved_work_group_id)}\`.`
    )),
    `- Verify \`${encoded(built.manifest.verify_issue_id)}\` covers every sealed verification directive.`,
  ].join("\n");
}

function checksMarkdown(checks: readonly {
  readonly check: string;
  readonly status: string;
  readonly sanitized_summary_markdown: string | null;
}[]): string {
  return [
    "## Checks",
    "",
    ...(checks.length === 0 ? ["- None"] : checks.map((check) => (
      `- ${check.status}: ${check.check}${check.sanitized_summary_markdown === null
        ? "" : ` - ${check.sanitized_summary_markdown}`}`
    ))),
  ].join("\n");
}

function terminalStatus(stage: StageExecutionSnapshot): "Done" | "Failed" | "Canceled" {
  if (stage.status === "done") return "Done";
  if (stage.status === "failed") return "Failed";
  if (stage.status === "canceled") return "Canceled";
  throw new Error("external_terminal_stage_source_invalid");
}

function taskStatus(stage: StageExecutionSnapshot): "Todo" | "In Progress" | "Done" | "Failed" | "Canceled" {
  switch (stage.status) {
    case "todo": return "Todo";
    case "in_progress": return "In Progress";
    case "done": return "Done";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
  }
}

function cycleStatus(snapshot: CycleAdvanceRequest): "Succeeded" | "Rejected" | "Failed" | "Canceled" {
  switch (snapshot.cycle_status) {
    case "succeeded": return "Succeeded";
    case "rejected": return "Rejected";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
    default: throw new Error("external_terminal_cycle_source_invalid");
  }
}

function cycleBasisStatus(snapshot: CycleAdvanceRequest): LastValidCycleBasisStatus {
  const status = cycleStatus(snapshot);
  const issueId = parseTaskIssueId(snapshot.cycle_id);
  const basis = deriveLastValidCycleBasisStatus({
    issues: [{ issue_id: issueId, status }],
    issue_history: snapshot.issue_history,
  }, issueId);
  if (basis === null) throw new Error("external_terminal_cycle_basis_invalid");
  return basis;
}

function cyclePhase(status: LastValidCycleBasisStatus): "draft" | "in_progress" | "awaiting_acceptance" {
  switch (status) {
    case "Draft": return "draft";
    case "In Progress": return "in_progress";
    case "Awaiting Acceptance": return "awaiting_acceptance";
  }
}

function cycleHistoryDigest(snapshot: CycleAdvanceRequest): string {
  return digest(JSON.stringify(snapshot.issue_history
    .filter(({ issue_id }) => issue_id === parseTaskIssueId(snapshot.cycle_id))
    .sort((left, right) => left.history_id.localeCompare(right.history_id))));
}

function cycleGraphDigest(snapshot: CycleAdvanceRequest): string {
  return digest(JSON.stringify(stageListForDigest(snapshot)));
}

function cycleIdentityHistoryClosureDigest(snapshot: CycleAdvanceRequest): string {
  const stageIds = new Set<string>([
    String(parseTaskIssueId(snapshot.cycle_id)),
    ...(snapshot.plan_issue === null ? [] : [String(parseTaskIssueId(snapshot.plan_issue.issue_id))]),
    ...snapshot.sealed_work_issues.map(({ issue_id }) => String(parseTaskIssueId(issue_id))),
    ...(snapshot.verify_issue === null ? [] : [String(parseTaskIssueId(snapshot.verify_issue.issue_id))]),
  ]);
  return digest(JSON.stringify({
    cycle_id: snapshot.cycle_id,
    issue_history: snapshot.issue_history
      .filter(({ issue_id }) => stageIds.has(String(issue_id)))
      .sort((left, right) => left.history_id.localeCompare(right.history_id)),
    resource_creation_evidence: snapshot.resource_creation_evidence
      .filter(({ resource_id }) => stageIds.has(String(resource_id)))
      .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
  }));
}

function recordObservation(
  snapshot: CycleAdvanceRequest,
  recordId: string,
): TaskIssueRecordObservation | undefined {
  return snapshot.issue_record_observations.find(({ record_id }) => record_id === recordId);
}

function assertNoInvalidRecordObservation(
  snapshot: CycleAdvanceRequest,
  recordId: string,
  expectedRecordKind: "cycle_completion" | "cycle_invalidation",
): void {
  const observation = recordObservation(snapshot, recordId);
  if (observation === undefined || !("observation_kind" in observation)) return;
  if (observation.observation_kind === "missing") return;
  if (observation.expected_record_kind !== expectedRecordKind) {
    throw new Error("cycle_terminal_record_observation_kind_mismatch");
  }
  throw new Error("cycle_terminal_record_observation_invalid");
}

function hasValidRecordObservation(snapshot: CycleAdvanceRequest, recordId: string): boolean {
  const observation = recordObservation(snapshot, recordId);
  return observation !== undefined && !("observation_kind" in observation);
}

function assertCycleCompletionRecord(
  record: CycleCompletionRecord,
  snapshot: CycleAdvanceRequest,
  basis: SealedCycleBasis,
  basisStatus: LastValidCycleBasisStatus,
): boolean {
  const cycleId = parseTaskIssueId(snapshot.cycle_id);
  if (
    record.record_id !== basis.specification.cycle_completion_record_id
    || record.issue_id !== cycleId
    || record.cycle_id !== basis.specification.cycle_id
    || record.basis_status !== basisStatus
    || record.basis_document_digest !== digest(snapshot.specification.cycle_description_markdown)
  ) throw new Error("cycle_completion_anchor_mismatch");
  return cycleCompletionTerminalStatus(record.completion) === cycleStatus(snapshot);
}

function assertCycleInvalidationRecord(
  record: CycleInvalidationRecord,
  snapshot: CycleAdvanceRequest,
  basis: SealedCycleBasis,
  basisStatus: LastValidCycleBasisStatus,
): void {
  const cycleId = parseTaskIssueId(snapshot.cycle_id);
  const documentDigest = digest(snapshot.specification.cycle_description_markdown);
  const observedStatus = cycleStatus(snapshot);
  if (
    record.record_id !== basis.specification.cycle_invalidation_record_id
    || record.issue_id !== cycleId
    || record.cycle_id !== basis.specification.cycle_id
    || record.basis_issue_revision !== snapshot.cycle_revision
    || record.basis_status !== basisStatus
    || record.last_valid_phase !== cyclePhase(basisStatus)
    || record.expected_status !== basisStatus
    || record.observed_status !== observedStatus
    || record.terminal_status !== observedStatus
    || record.basis_document_digest !== documentDigest
    || record.observed_cycle_document_digest !== documentDigest
    || record.observed_execution_graph_digest !== cycleGraphDigest(snapshot)
    || record.observed_history_digest !== cycleHistoryDigest(snapshot)
    || record.invalidation_kind !== "invalid_terminal"
  ) throw new Error("cycle_invalidation_anchor_mismatch");
}

function stageHistoryDigest(snapshot: CycleAdvanceRequest, stageId: TaskIssueId): string {
  return digest(JSON.stringify(snapshot.issue_history
    .filter(({ issue_id }) => issue_id === stageId)
    .sort((left, right) => left.history_id.localeCompare(right.history_id))));
}

function assertSealedFactStageInvalidationRecord(
  record: StageInvalidationRecord,
  expected: Readonly<{
    readonly record_id: string;
    readonly stage_id: TaskIssueId;
    readonly cycle_id: TaskIssueId;
    readonly stage_revision: CycleAdvanceRequest["cycle_revision"];
    readonly basis_status: "Todo" | "In Progress";
    readonly basis_document_digest: string;
    readonly observed_status: "Todo" | "In Progress" | "Done" | "Failed" | "Canceled";
    readonly instruction_digest: string;
    readonly completion_record_digest: string | null;
    readonly history_digest: string;
  }>,
): void {
  if (
    record.record_id !== expected.record_id
    || record.issue_id !== expected.stage_id
    || record.cycle_id !== expected.cycle_id
    || record.stage_id !== expected.stage_id
    || record.basis_issue_revision !== expected.stage_revision
    || record.basis_status !== expected.basis_status
    || record.basis_document_digest !== expected.basis_document_digest
    || record.observed_status !== expected.observed_status
    || record.observed_instruction_digest !== expected.instruction_digest
    || record.observed_completion_record_digest !== expected.completion_record_digest
    || record.observed_history_digest !== expected.history_digest
    || record.reason_code !== "sealed_fact_mutated"
    || record.reason_markdown !== "The sealed Stage fact was mutated; the original content was not repaired."
    || record.invalidation_kind !== "sealed_fact_mutated"
    || record.terminal_status !== "Failed"
  ) throw new Error("sealed_fact_invalidation_anchor_mismatch");
}

function assertSealedFactCycleInvalidationRecord(
  record: CycleInvalidationRecord,
  expected: Readonly<{
    readonly record_id: string;
    readonly cycle_id: TaskIssueId;
    readonly basis_issue_revision: CycleAdvanceRequest["cycle_revision"];
    readonly basis_status: LastValidCycleBasisStatus;
    readonly document_digest: string;
    readonly observed_execution_graph_digest: string;
    readonly offending_resources_digest: string;
    readonly observed_history_digest: string;
    readonly observed_record_set_digest: string;
  }>,
): void {
  if (
    record.record_id !== expected.record_id
    || record.issue_id !== expected.cycle_id
    || record.cycle_id !== expected.cycle_id
    || record.basis_issue_revision !== expected.basis_issue_revision
    || record.basis_status !== expected.basis_status
    || record.last_valid_phase !== cyclePhase(expected.basis_status)
    || record.expected_status !== expected.basis_status
    || record.observed_status !== expected.basis_status
    || record.basis_document_digest !== expected.document_digest
    || record.observed_cycle_document_digest !== expected.document_digest
    || record.observed_execution_graph_digest !== expected.observed_execution_graph_digest
    || digest(JSON.stringify(record.offending_resources)) !== expected.offending_resources_digest
    || record.observed_history_digest !== expected.observed_history_digest
    || record.observed_record_set_digest !== expected.observed_record_set_digest
    || record.reason_code !== "sealed_fact_mutated"
    || record.invalidation_kind !== "sealed_fact_mutated"
    || record.terminal_status !== "Failed"
    || record.successor_policy !== "permanently_quarantined"
    || record.successor_evidence !== null
  ) throw new Error("sealed_fact_cycle_record_anchor_mismatch");
}

function assertExternalTerminalRecord(
  record: StageInvalidationRecord,
  input: {
    readonly record_id: string;
    readonly stage_id: TaskIssueId;
    readonly cycle_id: TaskIssueId;
    readonly stage_revision: CycleAdvanceRequest["cycle_revision"];
    readonly basis_status: LastValidStageBasisStatus;
    readonly basis_document_digest: string;
    readonly terminal_status: "Done" | "Failed" | "Canceled";
    readonly instruction_digest: string;
    readonly history_digest: string;
  },
): void {
  if (
    record.record_id !== input.record_id
    || record.issue_id !== input.stage_id
    || record.cycle_id !== input.cycle_id
    || record.stage_id !== input.stage_id
    || record.basis_issue_revision !== input.stage_revision
    || record.basis_status !== input.basis_status
    || record.basis_document_digest !== input.basis_document_digest
    || record.observed_status !== input.terminal_status
    || record.terminal_status !== input.terminal_status
    || record.observed_instruction_digest !== input.instruction_digest
    || record.observed_completion_record_digest !== null
    || record.observed_history_digest !== input.history_digest
    || record.invalidation_kind !== "invalid_terminal"
  ) throw new Error("external_terminal_invalidation_anchor_mismatch");
}

function assertStageCompletionAnchors(
  record: StageCompletionRecord,
  stage: StageExecutionSnapshot,
  basis: SealedCycleBasis,
  expectedRecordId: string,
  expectedInstructionDigest: string,
): void {
  const stageId = parseTaskIssueId(stage.issue_id);
  if (
    record.record_id !== expectedRecordId
    || record.issue_id !== stageId
    || record.cycle_id !== basis.specification.cycle_id
    || record.stage_id !== stageId
  ) throw new Error("stage_completion_anchor_mismatch");
  if (
    (stage.status === "in_progress" && record.basis_issue_revision !== stage.revision)
    || record.basis_document_digest !== digest(stage.description_markdown)
    || record.completion.instruction_digest !== expectedInstructionDigest
  ) throw new Error("stage_completion_basis_mismatch");
}

function occupiesRecordSlot(
  observations: readonly TaskIssueRecordObservation[],
  recordId: string,
): boolean {
  return observations.some((observation) => (
    observation.record_id === recordId
    && (!("observation_kind" in observation) || observation.observation_kind !== "missing")
  ));
}

function sealedStatusCall(
  snapshot: CycleAdvanceRequest,
  issueId: TaskIssueId,
  expectedRevision: CycleAdvanceRequest["cycle_revision"],
  stateId: TaskStateId,
): UpdateIssueCall {
  return Object.freeze({
    schema_version: 1,
    function: "update_issue",
    root_id: snapshot.root_id,
    runtime_generation: snapshot.runtime_generation,
    correlation_id: snapshot.correlation_id,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: Object.freeze({
      issue_id: issueId,
      expected_revision: expectedRevision,
      desired: Object.freeze({ state_id: stateId }),
    }),
  });
}

function appliedIssueMutation(result: Awaited<ReturnType<TaskManageCommandInterface["update_issue"]>>): TaskIssueSnapshot {
  const fresh = result.output.fresh_resource;
  if (result.output.outcome !== "applied" || fresh === null || !("issue_id" in fresh)) {
    throw new Error("sealed_fact_status_projection_not_applied");
  }
  return fresh;
}

function invalidationBasisStatus(stage: StageExecutionSnapshot): "Todo" | "In Progress" {
  if (stage.status === "todo") return "Todo";
  if (stage.status === "in_progress") return "In Progress";
  throw new Error("sealed_fact_stage_not_active");
}

function stageNodeFor(
  built: BuiltPlanGraphManifest,
  stage: StageExecutionSnapshot,
): BuiltPlanGraphManifest["manifest"]["plan"]
  | BuiltPlanGraphManifest["manifest"]["ordered_work_nodes"][number]
  | BuiltPlanGraphManifest["manifest"]["verify_node"] {
  const stageId = parseTaskIssueId(stage.issue_id);
  if (stage.kind === "plan") {
    if (built.manifest.plan.issue_id !== stageId) throw new Error("sealed_fact_stage_manifest_mismatch");
    return built.manifest.plan;
  }
  if (stage.kind === "work") {
    const node = built.manifest.ordered_work_nodes.find(({ issue_id }) => issue_id === stageId);
    if (node === undefined) throw new Error("sealed_fact_stage_manifest_mismatch");
    return node;
  }
  if (built.manifest.verify_node.issue_id !== stageId) throw new Error("sealed_fact_stage_manifest_mismatch");
  return built.manifest.verify_node;
}

export class PlanCompletionRecordWriter {
  constructor(private readonly options: PlanCompletionRecordWriterOptions) {}

  async persistCompleted(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
    execution: TaskManageBoundaryExecution,
  ): Promise<StageCompletionRecord> {
    const plan = snapshot.plan_issue;
    if (plan === null || plan.status !== "in_progress") throw new Error("plan_completion_source_invalid");
    const issueId = parseTaskIssueId(plan.issue_id);
    if (
      issueId !== basis.specification.plan_issue_id
      || built.manifest.plan_issue_id !== issueId
    ) throw new Error("plan_completion_anchor_mismatch");
    const planCreation = await this.#readServiceIssueCreation(issueId);
    if (Date.parse(planCreation.provider_created_at) <= Date.parse(basis.approval_record.created_at)) {
      throw new Error("plan_creation_order_invalid");
    }
    const call = createTaskIssueRecordCall(snapshot, {
      record_id: basis.specification.plan_completion_record_id,
      issue_id: issueId,
      expected_issue_revision: plan.revision,
      projection: {
        issue_id: issueId,
        cycle_id: basis.specification.cycle_id,
        basis_issue_revision: plan.revision,
        basis_status: "In Progress",
        basis_document_digest: digest(plan.description_markdown),
        record_kind: "stage_completion",
        stage_id: issueId,
        completion: {
          outcome: "completed",
          instruction_digest: built.manifest.plan.instruction_digest,
          manifest: built.manifest,
          graph_seal_digest: graphSeal(built),
          traceability_by_issue_id_markdown: traceability(built),
        },
      },
    });
    const command = bindCycleTaskManageCommand({
      snapshot,
      workflow: this.options.workflow,
      caller_issuer: this.options.caller_issuer,
      task_manager: this.options.task_manager,
      mutation_manifest: [call],
    });
    const result = await command.create_issue_comment(call, execution);
    execution.assertActive();
    const applied = parseStageCompletionRecord(
      appliedTaskIssueRecord(call, result, this.options.service_actor_id),
      "plan",
      basis,
    );
    const comments = await this.options.record_reader.readIssueRecordComments(issueId);
    execution.assertActive();
    const fresh = readExactTaskIssueRecord(
      comments,
      issueId,
      basis.specification.plan_completion_record_id,
      this.options.service_actor_id,
    );
    if (fresh === null) throw new Error("plan_completion_record_missing");
    const readback = parseStageCompletionRecord(fresh, "plan", basis);
    if (readback.revision !== applied.revision) throw new Error("plan_completion_record_readback_mismatch");
    if (Date.parse(readback.created_at) <= Date.parse(planCreation.provider_created_at)) {
      throw new Error("plan_completion_record_order_invalid");
    }
    return readback;
  }

  persistPlanTerminal(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    outcome: "failed" | "canceled",
    reasonMarkdown: string,
    execution: TaskManageBoundaryExecution,
  ): Promise<StageCompletionRecord> {
    const plan = snapshot.plan_issue;
    if (
      plan === null
      || plan.status !== "in_progress"
      || parseTaskIssueId(plan.issue_id) !== basis.specification.plan_issue_id
    ) throw new Error("plan_completion_source_invalid");
    return this.#persistStage(snapshot, basis, execution, {
      record_id: basis.specification.plan_completion_record_id,
      stage_id: parseTaskIssueId(plan.issue_id),
      stage_revision: plan.revision,
      stage_description: plan.description_markdown,
      stage_kind: "plan",
      projection: {
        outcome,
        instruction_digest: digest(plan.description_markdown),
        reason_markdown: reasonMarkdown,
      },
    });
  }

  async persistSealedFactMutation(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    execution: TaskManageBoundaryExecution,
    observationValue?: SealedFactMutationObservation,
  ): Promise<CycleAdvanceRequest> {
    const observation = observationValue === undefined
      ? undefined
      : parseSealedFactMutationObservation(observationValue);
    if (
      observation === undefined
      || (snapshot.cycle_status !== "in_progress" && snapshot.cycle_status !== "awaiting_acceptance")
    ) throw new Error("sealed_fact_mutation_source_invalid");

    const stable = await this.#readStablePlanManifest(basis);
    if (stable === null) throw new Error("sealed_fact_manifest_missing");
    const stageIds = new Set<TaskIssueId>([
      ...(snapshot.plan_issue === null ? [] : [parseTaskIssueId(snapshot.plan_issue.issue_id)]),
      ...snapshot.sealed_work_issues.map(({ issue_id }) => parseTaskIssueId(issue_id)),
      ...(snapshot.verify_issue === null ? [] : [parseTaskIssueId(snapshot.verify_issue.issue_id)]),
    ]);
    if (observation.affected_stage_ids.some((stageId) => !stageIds.has(stageId))) {
      throw new Error("sealed_fact_stage_identity_invalid");
    }
    const activeStages = [
      ...(snapshot.plan_issue === null ? [] : [snapshot.plan_issue]),
      ...snapshot.sealed_work_issues,
      ...(snapshot.verify_issue === null ? [] : [snapshot.verify_issue]),
    ].filter((stage) => (
      observation.affected_stage_ids.includes(parseTaskIssueId(stage.issue_id))
      && (stage.status === "todo" || stage.status === "in_progress")
    ));

    const stageInvalidationProofs = new Map<TaskIssueId, StageInvalidationProjectionProof>();
    for (const stage of activeStages) {
      const node = stageNodeFor(stable.built, stage);
      const stageId = parseTaskIssueId(stage.issue_id);
      const recordId = node.invalidation_record_id;
      const completionRecordId = node.completion_record_id;
      const completionObservation = snapshot.issue_record_observations.find(({ record_id }) => (
        record_id === completionRecordId
      ));
      const observedCompletionDigest = completionObservation === undefined
        || ("observation_kind" in completionObservation && completionObservation.observation_kind === "missing")
        ? null
        : digest(JSON.stringify(completionObservation));
      const instruction = stable.built.instructions_by_issue_id[stageId];
      if (instruction === undefined) throw new Error("sealed_fact_instruction_missing");
      const expectedStageRecord = {
        record_id: recordId,
        stage_id: stageId,
        cycle_id: basis.specification.cycle_id,
        stage_revision: stage.revision,
        basis_status: invalidationBasisStatus(stage),
        basis_document_digest: digest(instruction),
        observed_status: taskStatus(stage),
        instruction_digest: node.instruction_digest,
        completion_record_digest: observedCompletionDigest,
        history_digest: stageHistoryDigest(snapshot, stageId),
      } as const;
      const comments = await this.options.record_reader.readIssueRecordComments(stageId);
      execution.assertActive();
      const existing = readExactTaskIssueRecord(
        comments,
        stageId,
        recordId,
        this.options.service_actor_id,
      );
      if (existing !== null) {
        if (existing.record_kind !== "stage_invalidation") {
          throw new Error("sealed_fact_invalidation_slot_occupied");
        }
        const parsed = parseStageInvalidationRecord(existing);
        if (parsed.invalidation_kind !== "sealed_fact_mutated") {
          throw new Error("sealed_fact_invalidation_slot_occupied");
        }
        assertSealedFactStageInvalidationRecord(parsed, expectedStageRecord);
        stageInvalidationProofs.set(stageId, parsed);
        continue;
      }
      if (occupiesRecordSlot(snapshot.issue_record_observations, recordId)) {
        throw new Error("sealed_fact_invalidation_slot_occupied");
      }
      const projection = {
        issue_id: stageId,
        cycle_id: basis.specification.cycle_id,
        basis_issue_revision: stage.revision,
        basis_status: invalidationBasisStatus(stage),
        basis_document_digest: digest(instruction),
        record_kind: "stage_invalidation" as const,
        stage_id: stageId,
        observed_status: taskStatus(stage),
        observed_instruction_digest: node.instruction_digest,
        observed_completion_record_digest: observedCompletionDigest,
        observed_history_digest: stageHistoryDigest(snapshot, stageId),
        reason_code: "sealed_fact_mutated",
        reason_markdown: "The sealed Stage fact was mutated; the original content was not repaired.",
        invalidation_kind: "sealed_fact_mutated" as const,
        terminal_status: "Failed" as const,
      };
      const call = createTaskIssueRecordCall(snapshot, {
        record_id: recordId,
        issue_id: stageId,
        expected_issue_revision: stage.revision,
        projection,
      });
      const command = bindCycleTaskManageCommand({
        snapshot,
        workflow: this.options.workflow,
        caller_issuer: this.options.caller_issuer,
        task_manager: this.options.task_manager,
        mutation_manifest: [call],
      });
      const result = await command.create_issue_comment(call, execution);
      execution.assertActive();
      const applied = parseStageInvalidationRecord(
        appliedTaskIssueRecord(call, result, this.options.service_actor_id),
      );
      assertSealedFactStageInvalidationRecord(applied, expectedStageRecord);
      const commentsAfterWrite = await this.options.record_reader.readIssueRecordComments(stageId);
      execution.assertActive();
      const fresh = readExactTaskIssueRecord(
        commentsAfterWrite,
        stageId,
        recordId,
        this.options.service_actor_id,
      );
      if (fresh === null) throw new Error("sealed_fact_stage_record_missing");
      const readback = parseStageInvalidationRecord(fresh);
      assertSealedFactStageInvalidationRecord(readback, expectedStageRecord);
      if (readback.revision !== applied.revision) throw new Error("sealed_fact_stage_record_readback_mismatch");
      stageInvalidationProofs.set(stageId, readback);
    }

    let projected = snapshot;
    for (const stage of activeStages) {
      const current = [
        ...(projected.plan_issue === null ? [] : [projected.plan_issue]),
        ...projected.sealed_work_issues,
        ...(projected.verify_issue === null ? [] : [projected.verify_issue]),
      ].find(({ issue_id }) => parseTaskIssueId(issue_id) === parseTaskIssueId(stage.issue_id));
      if (current === undefined || (current.status !== "todo" && current.status !== "in_progress")) continue;
      const stageId = parseTaskIssueId(current.issue_id);
      const call = sealedStatusCall(projected, stageId, current.revision, this.options.workflow.stage_states.failed);
      const proof = stageInvalidationProofs.get(stageId);
      if (proof === undefined) throw new Error("sealed_fact_stage_record_proof_missing");
      const command = bindCycleTaskManageCommand({
        snapshot: projected,
        workflow: this.options.workflow,
        caller_issuer: this.options.caller_issuer,
        task_manager: this.options.task_manager,
        mutation_manifest: [call],
        preconfirmed_stage_invalidations: [proof],
      });
      const fresh = appliedIssueMutation(await command.update_issue(call, execution));
      execution.assertActive();
      const replacement = { ...current, revision: fresh.revision, status: "failed" as const };
      projected = {
        ...projected,
        plan_issue: projected.plan_issue?.issue_id === current.issue_id ? replacement : projected.plan_issue,
        sealed_work_issues: projected.sealed_work_issues.map((entry) => (
          entry.issue_id === current.issue_id ? replacement : entry
        )),
        verify_issue: projected.verify_issue?.issue_id === current.issue_id ? replacement : projected.verify_issue,
      };
    }

    const phase = projected.cycle_status === "awaiting_acceptance" ? "awaiting_acceptance" : "in_progress";
    const basisStatus = phase === "awaiting_acceptance" ? "Awaiting Acceptance" : "In Progress";
    const cycleId = parseTaskIssueId(projected.cycle_id);
    const cycleRecordId = basis.specification.cycle_invalidation_record_id;
    const cycleComments = await this.options.record_reader.readIssueRecordComments(cycleId);
    execution.assertActive();
    const existingCycle = readExactTaskIssueRecord(
      cycleComments,
      cycleId,
      cycleRecordId,
      this.options.service_actor_id,
    );
    if (existingCycle !== null) {
      if (existingCycle.record_kind !== "cycle_invalidation") {
        throw new Error("sealed_fact_cycle_slot_occupied");
      }
      const parsed = parseCycleInvalidationRecord(existingCycle);
      if (
        parsed.record_id !== cycleRecordId
        || parsed.issue_id !== cycleId
        || parsed.cycle_id !== basis.specification.cycle_id
      ) throw new Error("sealed_fact_cycle_record_anchor_mismatch");
      if (parsed.invalidation_kind !== "sealed_fact_mutated") {
        throw new Error("sealed_fact_cycle_slot_occupied");
      }
      if (
        parsed.terminal_status !== "Failed"
        || parsed.successor_policy !== "permanently_quarantined"
        || parsed.successor_evidence !== null
        || parsed.reason_code !== "sealed_fact_mutated"
        || digest(JSON.stringify(parsed.offending_resources))
          !== digest(JSON.stringify(observation.offending_resources))
        || parsed.basis_issue_revision !== snapshot.cycle_revision
        || parsed.basis_status !== basisStatus
        || parsed.last_valid_phase !== phase
        || parsed.expected_status !== basisStatus
        || parsed.observed_status !== basisStatus
        || parsed.basis_document_digest !== digest(snapshot.specification.cycle_description_markdown)
        || parsed.observed_cycle_document_digest !== digest(snapshot.specification.cycle_description_markdown)
        || parsed.reason_markdown !== "A sealed instruction, relation, or record was mutated; sealed content was not repaired."
      ) throw new Error("sealed_fact_cycle_record_anchor_mismatch");
    } else {
      if (occupiesRecordSlot(snapshot.issue_record_observations, cycleRecordId)) {
        throw new Error("sealed_fact_cycle_slot_occupied");
      }
      const projection = {
        issue_id: cycleId,
        cycle_id: basis.specification.cycle_id,
        basis_issue_revision: snapshot.cycle_revision,
        basis_status: basisStatus,
        basis_document_digest: digest(projected.specification.cycle_description_markdown),
        record_kind: "cycle_invalidation" as const,
        last_valid_phase: phase,
        expected_status: basisStatus,
        observed_status: basisStatus,
        observed_cycle_document_digest: digest(projected.specification.cycle_description_markdown),
        observed_execution_graph_digest: digest(JSON.stringify({
          graph: stageListForDigest(snapshot),
          offending_resources: observation.offending_resources,
        })),
        offending_resources: observation.offending_resources,
        observed_history_digest: cycleHistoryDigest(snapshot),
        observed_record_set_digest: digest(JSON.stringify({
          observations: snapshot.issue_record_observations,
          offending_resources: observation.offending_resources,
        })),
        reason_code: "sealed_fact_mutated",
        reason_markdown: "A sealed instruction, relation, or record was mutated; sealed content was not repaired.",
        invalidation_kind: "sealed_fact_mutated" as const,
        terminal_status: "Failed" as const,
        successor_policy: "permanently_quarantined" as const,
        successor_evidence: null,
      };
      const call = createTaskIssueRecordCall(projected, {
        record_id: cycleRecordId,
        issue_id: cycleId,
        expected_issue_revision: projected.cycle_revision,
        projection,
      });
      const command = bindCycleTaskManageCommand({
        snapshot: projected,
        workflow: this.options.workflow,
        caller_issuer: this.options.caller_issuer,
        task_manager: this.options.task_manager,
        mutation_manifest: [call],
      });
      const result = await command.create_issue_comment(call, execution);
      execution.assertActive();
      const applied = parseCycleInvalidationRecord(
        appliedTaskIssueRecord(call, result, this.options.service_actor_id),
      );
      const documentDigest = digest(snapshot.specification.cycle_description_markdown);
      const observedGraphDigest = digest(JSON.stringify({
        graph: stageListForDigest(snapshot),
        offending_resources: observation.offending_resources,
      }));
      const offendingResourcesDigest = digest(JSON.stringify(observation.offending_resources));
      const observedHistoryDigest = cycleHistoryDigest(snapshot);
      const observedRecordSetDigest = digest(JSON.stringify({
        observations: snapshot.issue_record_observations,
        offending_resources: observation.offending_resources,
      }));
      assertSealedFactCycleInvalidationRecord(applied, {
        record_id: cycleRecordId,
        cycle_id: cycleId,
        basis_issue_revision: snapshot.cycle_revision,
        basis_status: basisStatus,
        document_digest: documentDigest,
        observed_execution_graph_digest: observedGraphDigest,
        offending_resources_digest: offendingResourcesDigest,
        observed_history_digest: observedHistoryDigest,
        observed_record_set_digest: observedRecordSetDigest,
      });
      const commentsAfterWrite = await this.options.record_reader.readIssueRecordComments(cycleId);
      execution.assertActive();
      const fresh = readExactTaskIssueRecord(
        commentsAfterWrite,
        cycleId,
        cycleRecordId,
        this.options.service_actor_id,
      );
      if (fresh === null) throw new Error("sealed_fact_cycle_record_missing");
      const readback = parseCycleInvalidationRecord(fresh);
      assertSealedFactCycleInvalidationRecord(readback, {
        record_id: cycleRecordId,
        cycle_id: cycleId,
        basis_issue_revision: snapshot.cycle_revision,
        basis_status: basisStatus,
        document_digest: documentDigest,
        observed_execution_graph_digest: observedGraphDigest,
        offending_resources_digest: offendingResourcesDigest,
        observed_history_digest: observedHistoryDigest,
        observed_record_set_digest: observedRecordSetDigest,
      });
      if (readback.revision !== applied.revision) throw new Error("sealed_fact_cycle_record_readback_mismatch");
    }

    const cycleCall = sealedStatusCall(
      projected,
      cycleId,
      projected.cycle_revision,
      this.options.workflow.cycle_states.failed,
    );
    const cycleCommand = bindCycleTaskManageCommand({
      snapshot: projected,
      workflow: this.options.workflow,
      caller_issuer: this.options.caller_issuer,
      task_manager: this.options.task_manager,
      mutation_manifest: [cycleCall],
    });
    const failedCycle = appliedIssueMutation(await cycleCommand.update_issue(cycleCall, execution));
    execution.assertActive();
    return Object.freeze({ ...projected, cycle_revision: failedCycle.revision, cycle_status: "failed" });
  }

  async persistExternalTerminalInvalidation(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest | null,
    stageId: TaskIssueId,
    execution: TaskManageBoundaryExecution,
  ): Promise<StageInvalidationRecord> {
    const stage = [
      ...(snapshot.plan_issue === null ? [] : [snapshot.plan_issue]),
      ...snapshot.sealed_work_issues,
      ...(snapshot.verify_issue === null ? [] : [snapshot.verify_issue]),
    ].find(({ issue_id }) => parseTaskIssueId(issue_id) === stageId);
    if (stage === undefined) throw new Error("external_terminal_stage_source_invalid");
    const stageTaskId = parseTaskIssueId(stage.issue_id);

    const node = stage.kind === "plan"
      ? {
        completion_record_id: basis.specification.plan_completion_record_id,
        invalidation_record_id: basis.specification.plan_invalidation_record_id,
        instruction_digest: digest(stage.description_markdown),
      }
      : built === null
        ? null
        : built.manifest.ordered_work_nodes.find(({ issue_id }) => issue_id === stageTaskId)
          ?? (stage.kind === "verify" && built.manifest.verify_node.issue_id === stageTaskId
            ? built.manifest.verify_node
            : null);
    if (node === null || node === undefined) throw new Error("external_terminal_manifest_missing");
    if (digest(stage.description_markdown) !== node.instruction_digest) {
      throw new Error("external_terminal_instruction_mismatch");
    }

    const basisStatus = deriveLastValidStageBasisStatus({
      issues: [{ issue_id: stageTaskId, status: taskStatus(stage) }],
      issue_history: snapshot.issue_history,
    }, stageTaskId);
    if (basisStatus === null) throw new Error("external_terminal_basis_invalid");
    const observedStatus = terminalStatus(stage);
    const historyDigest = stageHistoryDigest(snapshot, stageTaskId);
    const basisDocumentDigest = digest(stage.description_markdown);

    if (occupiesRecordSlot(snapshot.issue_record_observations, node.invalidation_record_id)) {
      throw new Error("external_terminal_record_slot_occupied");
    }

    const comments = await this.options.record_reader.readIssueRecordComments(stageTaskId);
    execution.assertActive();
    const existingInvalidation = readExactTaskIssueRecord(
      comments,
      stageTaskId,
      node.invalidation_record_id,
      this.options.service_actor_id,
    );
    if (existingInvalidation !== null) throw new Error("external_terminal_record_slot_occupied");

    const stageCreation = await this.#readServiceIssueCreation(stageTaskId);
    const call = createTaskIssueRecordCall(snapshot, {
      record_id: node.invalidation_record_id,
      issue_id: stageTaskId,
      expected_issue_revision: stage.revision,
      projection: {
        issue_id: stageTaskId,
        cycle_id: basis.specification.cycle_id,
        basis_issue_revision: stage.revision,
        basis_status: basisStatus,
        basis_document_digest: basisDocumentDigest,
        record_kind: "stage_invalidation",
        stage_id: stageTaskId,
        observed_status: observedStatus,
        observed_instruction_digest: node.instruction_digest,
        observed_completion_record_digest: null,
        observed_history_digest: historyDigest,
        reason_code: "invalid_terminal",
        reason_markdown: "The Stage reached a terminal status without a matching Symphony completion record.",
        invalidation_kind: "invalid_terminal",
        terminal_status: observedStatus,
      },
    });
    const command = bindCycleTaskManageCommand({
      snapshot,
      workflow: this.options.workflow,
      caller_issuer: this.options.caller_issuer,
      task_manager: this.options.task_manager,
      mutation_manifest: [call],
    });
    const result = await command.create_issue_comment(call, execution);
    execution.assertActive();
    const applied = parseStageInvalidationRecord(
      appliedTaskIssueRecord(call, result, this.options.service_actor_id),
    );
    assertExternalTerminalRecord(applied, {
      record_id: node.invalidation_record_id,
      stage_id: stageTaskId,
      cycle_id: basis.specification.cycle_id,
      stage_revision: stage.revision,
      basis_status: basisStatus,
      basis_document_digest: basisDocumentDigest,
      terminal_status: observedStatus,
      instruction_digest: node.instruction_digest,
      history_digest: historyDigest,
    });
    const commentsAfterWrite = await this.options.record_reader.readIssueRecordComments(stageTaskId);
    execution.assertActive();
    const fresh = readExactTaskIssueRecord(
      commentsAfterWrite,
      stageTaskId,
      node.invalidation_record_id,
      this.options.service_actor_id,
    );
    if (fresh === null) throw new Error("external_terminal_invalidation_record_missing");
    const readback = parseStageInvalidationRecord(fresh);
    assertExternalTerminalRecord(readback, {
      record_id: node.invalidation_record_id,
      stage_id: stageTaskId,
      cycle_id: basis.specification.cycle_id,
      stage_revision: stage.revision,
      basis_status: basisStatus,
      basis_document_digest: basisDocumentDigest,
      terminal_status: observedStatus,
      instruction_digest: node.instruction_digest,
      history_digest: historyDigest,
    });
    if (Date.parse(readback.created_at) <= Date.parse(stageCreation.provider_created_at)) {
      throw new Error("external_terminal_invalidation_order_invalid");
    }
    return readback;
  }

  async readCycleTerminalRecord(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
  ): Promise<CycleCompletionRecord | CycleInvalidationRecord | null> {
    const cycleId = parseTaskIssueId(snapshot.cycle_id);
    const basisStatus = cycleBasisStatus(snapshot);
    const comments = await this.options.record_reader.readIssueRecordComments(cycleId);

    const invalidationRecordId = basis.specification.cycle_invalidation_record_id;
    assertNoInvalidRecordObservation(snapshot, invalidationRecordId, "cycle_invalidation");
    const invalidationProjection = readExactTaskIssueRecord(
      comments,
      cycleId,
      invalidationRecordId,
      this.options.service_actor_id,
    );
    if (invalidationProjection !== null) {
      const invalidation = parseCycleInvalidationRecord(invalidationProjection);
      assertCycleInvalidationRecord(invalidation, snapshot, basis, basisStatus);
      return invalidation;
    }
    if (hasValidRecordObservation(snapshot, invalidationRecordId)) {
      throw new Error("cycle_invalidation_record_missing");
    }

    const completionRecordId = basis.specification.cycle_completion_record_id;
    assertNoInvalidRecordObservation(snapshot, completionRecordId, "cycle_completion");
    const completionProjection = readExactTaskIssueRecord(
      comments,
      cycleId,
      completionRecordId,
      this.options.service_actor_id,
    );
    if (completionProjection === null) {
      if (hasValidRecordObservation(snapshot, completionRecordId)) {
        throw new Error("cycle_completion_record_missing");
      }
      return null;
    }
    const completion = parseCycleCompletionRecord(completionProjection);
    if (!assertCycleCompletionRecord(completion, snapshot, basis, basisStatus)) return null;
    return completion;
  }

  async persistExternalTerminalCycleInvalidation(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    closedStageRecordDigests: readonly string[],
    execution: TaskManageBoundaryExecution,
  ): Promise<CycleInvalidationRecord> {
    const cycleId = parseTaskIssueId(snapshot.cycle_id);
    const basisStatus = cycleBasisStatus(snapshot);
    const invalidationRecordId = basis.specification.cycle_invalidation_record_id;
    if (occupiesRecordSlot(snapshot.issue_record_observations, invalidationRecordId)) {
      throw new Error("cycle_invalidation_record_slot_occupied");
    }
    const comments = await this.options.record_reader.readIssueRecordComments(cycleId);
    execution.assertActive();
    const existing = readExactTaskIssueRecord(
      comments,
      cycleId,
      invalidationRecordId,
      this.options.service_actor_id,
    );
    if (existing !== null) throw new Error("cycle_invalidation_record_slot_occupied");

    const observedStatus = cycleStatus(snapshot);
    const documentDigest = digest(snapshot.specification.cycle_description_markdown);
    const graphDigest = cycleGraphDigest(snapshot);
    const historyDigest = cycleHistoryDigest(snapshot);
    const creationEvidenceDigest = snapshot.resource_creation_evidence.find(
      ({ resource_id }) => resource_id === cycleId,
    )?.canonical_evidence_digest ?? null;
    const projection = {
      issue_id: cycleId,
      cycle_id: basis.specification.cycle_id,
      basis_issue_revision: snapshot.cycle_revision,
      basis_status: basisStatus,
      basis_document_digest: documentDigest,
      record_kind: "cycle_invalidation" as const,
      last_valid_phase: cyclePhase(basisStatus),
      expected_status: basisStatus,
      observed_status: observedStatus,
      observed_cycle_document_digest: documentDigest,
      observed_execution_graph_digest: graphDigest,
      offending_resources: [{
        evidence_kind: "present_digest_mismatch" as const,
        resource_kind: "cycle" as const,
        resource_id: cycleId,
        expected_digest: digest(`status:${basisStatus}`),
        observed_digest: digest(`status:${observedStatus}`),
        observed_revision: snapshot.cycle_revision,
        creation_evidence_digest: creationEvidenceDigest,
      }],
      observed_history_digest: historyDigest,
      observed_record_set_digest: digest(JSON.stringify({
        completion_record_id: basis.specification.cycle_completion_record_id,
        invalidation_record_id: basis.specification.cycle_invalidation_record_id,
        observations: snapshot.issue_record_observations
          .filter(({ record_id }) => (
            record_id === basis.specification.cycle_completion_record_id
            || record_id === basis.specification.cycle_invalidation_record_id
          )),
      })),
      reason_code: "invalid_terminal",
      reason_markdown: "The Cycle reached a terminal status without a matching Symphony completion record.",
      invalidation_kind: "invalid_terminal" as const,
      terminal_status: observedStatus,
      successor_policy: "allowed" as const,
      successor_evidence: {
        closed_stage_record_digests: [...closedStageRecordDigests],
        known_graph_digest: snapshot.sealed_graph_digest,
        identity_history_closure_digest: cycleIdentityHistoryClosureDigest(snapshot),
      },
    };
    const call = createTaskIssueRecordCall(snapshot, {
      record_id: invalidationRecordId,
      issue_id: cycleId,
      expected_issue_revision: snapshot.cycle_revision,
      projection,
    });
    const command = bindCycleTaskManageCommand({
      snapshot,
      workflow: this.options.workflow,
      caller_issuer: this.options.caller_issuer,
      task_manager: this.options.task_manager,
      mutation_manifest: [call],
    });
    const result = await command.create_issue_comment(call, execution);
    execution.assertActive();
    const applied = parseCycleInvalidationRecord(
      appliedTaskIssueRecord(call, result, this.options.service_actor_id),
    );
    assertCycleInvalidationRecord(applied, snapshot, basis, basisStatus);
    const commentsAfterWrite = await this.options.record_reader.readIssueRecordComments(cycleId);
    execution.assertActive();
    const fresh = readExactTaskIssueRecord(
      commentsAfterWrite,
      cycleId,
      invalidationRecordId,
      this.options.service_actor_id,
    );
    if (fresh === null) throw new Error("cycle_invalidation_record_missing");
    const readback = parseCycleInvalidationRecord(fresh);
    assertCycleInvalidationRecord(readback, snapshot, basis, basisStatus);
    if (readback.revision !== applied.revision) {
      throw new Error("cycle_invalidation_record_readback_mismatch");
    }
    return readback;
  }

  async readCompleted(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
  ): Promise<BuiltPlanGraphManifest | null> {
    const plan = snapshot.plan_issue;
    if (
      plan === null
      || (plan.status !== "in_progress" && plan.status !== "done")
      || parseTaskIssueId(plan.issue_id) !== basis.specification.plan_issue_id
    ) throw new Error("plan_completion_source_invalid");
    const comments = await this.options.record_reader.readIssueRecordComments(parseTaskIssueId(plan.issue_id));
    const projected = readExactTaskIssueRecord(
      comments,
      parseTaskIssueId(plan.issue_id),
      basis.specification.plan_completion_record_id,
      this.options.service_actor_id,
    );
    if (projected === null) return null;
    const record = parseStageCompletionRecord(projected, "plan", basis);
    const planCreation = await this.#readServiceIssueCreation(parseTaskIssueId(plan.issue_id));
    if (
      Date.parse(planCreation.provider_created_at) <= Date.parse(basis.approval_record.created_at)
      || Date.parse(record.created_at) <= Date.parse(planCreation.provider_created_at)
    ) throw new Error("plan_completion_record_order_invalid");
    if (record.completion.outcome !== "completed") throw new Error("plan_completion_not_completed");
    if (
      record.record_id !== basis.specification.plan_completion_record_id
      || record.issue_id !== parseTaskIssueId(plan.issue_id)
      || record.cycle_id !== basis.specification.cycle_id
      || record.stage_id !== parseTaskIssueId(plan.issue_id)
    ) throw new Error("plan_completion_anchor_mismatch");
    if (
      (plan.status === "in_progress" && record.basis_issue_revision !== plan.revision)
      || record.basis_document_digest !== digest(plan.description_markdown)
      || record.completion.instruction_digest !== digest(plan.description_markdown)
    ) throw new Error("plan_completion_basis_mismatch");
    const built = buildPlanGraphManifest({
      basis,
      ordered_work_group_ids: record.completion.manifest.ordered_work_nodes
        .map(({ approved_work_group_id }) => approved_work_group_id),
      plan_title: plan.title,
      plan_instruction_markdown: plan.description_markdown,
    });
    if (
      JSON.stringify(built.manifest) !== JSON.stringify(record.completion.manifest)
      || graphSeal(built) !== record.completion.graph_seal_digest
      || traceability(built) !== record.completion.traceability_by_issue_id_markdown
    ) throw new Error("plan_completion_manifest_mismatch");
    if (plan.status === "done") assertExactPlanGraph(snapshot, built);
    return built;
  }

  async readPlanCompletion(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
  ): Promise<StageCompletionRecord | null> {
    const plan = snapshot.plan_issue;
    if (
      plan === null
      || (plan.status !== "failed" && plan.status !== "canceled")
      || parseTaskIssueId(plan.issue_id) !== basis.specification.plan_issue_id
    ) throw new Error("plan_completion_source_invalid");
    const planId = parseTaskIssueId(plan.issue_id);
    const comments = await this.options.record_reader.readIssueRecordComments(planId);
    const projected = readExactTaskIssueRecord(
      comments,
      planId,
      basis.specification.plan_completion_record_id,
      this.options.service_actor_id,
    );
    if (projected === null) return null;
    const record = parseStageCompletionRecord(projected, "plan", basis);
    const planCreation = await this.#readServiceIssueCreation(planId);
    if (
      Date.parse(planCreation.provider_created_at) <= Date.parse(basis.approval_record.created_at)
      || Date.parse(record.created_at) <= Date.parse(planCreation.provider_created_at)
    ) throw new Error("plan_completion_record_order_invalid");
    if (
      record.record_id !== basis.specification.plan_completion_record_id
      || record.issue_id !== planId
      || record.cycle_id !== basis.specification.cycle_id
      || record.stage_id !== planId
    ) throw new Error("plan_completion_anchor_mismatch");
    if (
      record.basis_document_digest !== digest(plan.description_markdown)
      || record.completion.instruction_digest !== digest(plan.description_markdown)
      || record.completion.outcome !== plan.status
    ) throw new Error("plan_completion_basis_mismatch");
    return record;
  }

  async readStageCompletion(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
    stageId: TaskIssueId,
  ): Promise<StageCompletionRecord | null> {
    const plan = snapshot.plan_issue;
    const stage = [
      ...(plan === null ? [] : [plan]),
      ...snapshot.sealed_work_issues,
      ...(snapshot.verify_issue === null ? [] : [snapshot.verify_issue]),
    ].find(({ issue_id }) => parseTaskIssueId(issue_id) === stageId);
    const node = stage?.kind === "plan"
      ? built.manifest.plan
      : stage?.kind === "work"
        ? built.manifest.ordered_work_nodes.find(({ issue_id }) => issue_id === stageId)
        : stage?.kind === "verify" ? built.manifest.verify_node : undefined;
    if (stage === undefined || node === undefined || node.issue_id !== stageId) {
      throw new Error("stage_completion_anchor_mismatch");
    }
    const comments = await this.options.record_reader.readIssueRecordComments(stageId);
    const projected = readExactTaskIssueRecord(
      comments,
      stageId,
      node.completion_record_id,
      this.options.service_actor_id,
    );
    if (projected === null) return null;
    const record = stage.kind === "plan"
      ? parseStageCompletionRecord(projected, "plan", basis)
      : stage.kind === "work"
        ? parseStageCompletionRecord(projected, "work", basis)
        : parseStageCompletionRecord(projected, "verify", basis);
    assertStageCompletionAnchors(record, stage, basis, node.completion_record_id, node.instruction_digest);
    const observedStatus = taskStatus(stage);
    if (
      (observedStatus === "Done" || observedStatus === "Failed" || observedStatus === "Canceled")
      && stageCompletionTerminalStatus(record.completion) !== observedStatus
    ) return null;
    return record;
  }

  async assertAcceptanceEvidence(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
  ): Promise<void> {
    if (
      snapshot.cycle_status !== "awaiting_acceptance"
      || snapshot.git.workspace_state !== "clean"
      || snapshot.git.head_revision === null
      || snapshot.verify_issue?.status !== "done"
      || snapshot.sealed_work_issues.some(({ status }) => status !== "done")
    ) throw new Error("acceptance_evidence_source_invalid");
    for (const work of snapshot.sealed_work_issues) {
      const record = await this.readStageCompletion(
        snapshot,
        basis,
        built,
        parseTaskIssueId(work.issue_id),
      );
      if (
        record === null
        || !("outcome" in record.completion)
        || record.completion.outcome !== "completed"
      ) {
        throw new Error("work_completion_record_missing");
      }
    }
    const verify = await this.readStageCompletion(
      snapshot,
      basis,
      built,
      parseTaskIssueId(snapshot.verify_issue.issue_id),
    );
    if (
      verify === null
      || !("conclusion" in verify.completion)
      || verify.completion.conclusion !== "passed"
      || verify.completion.exact_revision !== digest(snapshot.git.head_revision)
    ) throw new Error("verify_completion_evidence_mismatch");
  }

  async readCommitBasis(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
  ): Promise<PersistedCommitBasis> {
    if (basis.specification.specification_seal_digest === null) {
      throw new Error("commit_basis_specification_unsealed");
    }
    const records: StageCompletionRecord[] = [];
    for (const node of built.manifest.ordered_work_nodes) {
      const stage = snapshot.sealed_work_issues.find(
        ({ issue_id }) => parseTaskIssueId(issue_id) === node.issue_id,
      );
      if (stage?.status !== "done") throw new Error("commit_basis_work_incomplete");
      const record = await this.readStageCompletion(snapshot, basis, built, node.issue_id);
      if (
        record === null
        || !("outcome" in record.completion)
        || record.completion.outcome !== "completed"
      ) throw new Error("commit_basis_work_record_invalid");
      records.push(record);
    }
    const final = records.at(-1);
    if (final === undefined || !("workspace_parent_revision" in final.completion)) {
      throw new Error("commit_basis_final_work_missing");
    }
    return Object.freeze({
      proof: Object.freeze({
        cycle_id: basis.specification.cycle_id,
        specification_seal_digest: basis.specification.specification_seal_digest,
        graph_seal_digest: snapshot.sealed_graph_digest,
        work_completion_set_digest: digest(JSON.stringify(records.map((record) => ({
          stage_id: record.stage_id,
          record_id: record.record_id,
          revision: record.revision,
        })))),
      }),
      workspace_parent_revision_digest: final.completion.workspace_parent_revision,
      workspace_diff_digest: final.completion.workspace_diff_digest,
    });
  }

  async persistStageFailure(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest | null,
    stageId: TaskIssueId,
    reasonCode: string,
    reasonMarkdown: string,
    execution: TaskManageBoundaryExecution,
    terminalOutcome: "failed" | "canceled" = "failed",
  ): Promise<StageCompletionRecord> {
    const stage = [
      ...(snapshot.plan_issue === null ? [] : [snapshot.plan_issue]),
      ...snapshot.sealed_work_issues,
      ...(snapshot.verify_issue === null ? [] : [snapshot.verify_issue]),
    ].find(({ issue_id }) => parseTaskIssueId(issue_id) === stageId);
    if (stage === undefined || stage.status !== "in_progress") {
      throw new Error("stage_failure_source_invalid");
    }
    const stageReasonMarkdown = reasonCode === "lost_execution_context"
      ? "lost_execution_context"
      : reasonMarkdown;
    if (stage.kind === "plan") {
      const comments = await this.options.record_reader.readIssueRecordComments(stageId);
      const projected = readExactTaskIssueRecord(
        comments,
        stageId,
        basis.specification.plan_completion_record_id,
        this.options.service_actor_id,
      );
      if (projected !== null) {
        const record = parseStageCompletionRecord(projected, "plan", basis);
        assertStageCompletionAnchors(
          record,
          stage,
          basis,
          basis.specification.plan_completion_record_id,
          digest(stage.description_markdown),
        );
        return record;
      }
      return this.persistPlanTerminal(
        snapshot,
        basis,
        terminalOutcome,
        stageReasonMarkdown,
        execution,
      );
    }
    if (built === null) throw new Error("stage_failure_manifest_missing");
    const existing = await this.readStageCompletion(snapshot, basis, built, stageId);
    if (existing !== null) return existing;
    const node = stage.kind === "work"
      ? built.manifest.ordered_work_nodes.find(({ issue_id }) => issue_id === stageId)
      : built.manifest.verify_node;
    if (node === undefined || node.issue_id !== stageId) throw new Error("stage_failure_anchor_mismatch");
    const common = {
      record_id: node.completion_record_id,
      stage_id: stageId,
      stage_revision: stage.revision,
      stage_description: stage.description_markdown,
      stage_kind: stage.kind,
    } as const;
    if (stage.kind === "work") {
      return this.#persistStage(snapshot, basis, execution, {
        ...common,
        projection: {
          outcome: terminalOutcome,
          instruction_digest: node.instruction_digest,
          workspace_parent_revision: digest(snapshot.git.head_revision ?? "unborn"),
          workspace_diff_digest: digest(snapshot.git.diff_digest),
          checks_markdown: "## Checks\n\n- not_run: live Work context was lost",
          normalized_handoff_markdown: stageReasonMarkdown,
          reason_code: reasonCode,
          reason_markdown: stageReasonMarkdown,
        },
      });
    }
    const verifyConclusion = terminalOutcome === "canceled"
      ? "canceled" as const
      : reasonCode === "lost_execution_context" ? "failed" as const : "inconclusive" as const;
    const verifyReason = verifyConclusion === "failed"
      ? { reason_markdown: stageReasonMarkdown }
      : { reason_code: reasonCode, reason_markdown: stageReasonMarkdown };
    return this.#persistStage(snapshot, basis, execution, {
      ...common,
      projection: {
        conclusion: verifyConclusion,
        instruction_digest: node.instruction_digest,
        exact_revision: digest(snapshot.git.head_revision ?? "unborn"),
        checks_markdown: "## Checks\n\n- not_run: live Verify context was lost",
        evidence_markdown: stageReasonMarkdown,
        ...verifyReason,
      },
    });
  }

  async persistCycleFailure(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    reasonCode: string,
    reasonMarkdown: string,
    failedStageId: TaskIssueId | null,
    execution: TaskManageBoundaryExecution,
    terminalOutcome: "failed" | "canceled" = "failed",
  ): Promise<void> {
    if (snapshot.cycle_status !== "in_progress" && snapshot.cycle_status !== "awaiting_acceptance") {
      throw new Error("cycle_failure_source_invalid");
    }
    const awaiting = snapshot.cycle_status === "awaiting_acceptance";
    const recordId = awaiting
      ? basis.specification.cycle_invalidation_record_id
      : basis.specification.cycle_completion_record_id;
    const projection = awaiting ? {
      issue_id: parseTaskIssueId(snapshot.cycle_id),
      cycle_id: basis.specification.cycle_id,
      basis_issue_revision: snapshot.cycle_revision,
      basis_status: "Awaiting Acceptance",
      basis_document_digest: digest(snapshot.specification.cycle_description_markdown),
      record_kind: "cycle_invalidation",
      last_valid_phase: "awaiting_acceptance",
      expected_status: "Awaiting Acceptance",
      observed_status: "Awaiting Acceptance",
      observed_cycle_document_digest: digest(snapshot.specification.cycle_description_markdown),
      observed_execution_graph_digest: digest(JSON.stringify(stageListForDigest(snapshot))),
      offending_resources: [{
        evidence_kind: "present_digest_mismatch",
        resource_kind: "record",
        resource_id: basis.specification.cycle_invalidation_record_id,
        expected_digest: digest(snapshot.sealed_graph_digest),
        observed_digest: digest(JSON.stringify(snapshot.git)),
        observed_revision: snapshot.cycle_revision,
        creation_evidence_digest: null,
      }],
      observed_history_digest: digest(snapshot.cycle_revision),
      observed_record_set_digest: digest(recordId),
      reason_code: reasonCode,
      reason_markdown: reasonMarkdown,
      invalidation_kind: "sealed_fact_mutated",
      terminal_status: "Failed",
      successor_policy: "permanently_quarantined",
      successor_evidence: null,
    } : {
      issue_id: parseTaskIssueId(snapshot.cycle_id),
      cycle_id: basis.specification.cycle_id,
      basis_issue_revision: snapshot.cycle_revision,
      basis_status: "In Progress",
      basis_document_digest: digest(snapshot.specification.cycle_description_markdown),
      record_kind: "cycle_completion",
      successor_policy: "allowed",
      completion: {
        outcome: terminalOutcome,
        failure_phase: "in_progress",
        specification_seal_digest: basis.specification.specification_seal_digest,
        graph_seal_digest: snapshot.sealed_graph_digest,
        observed_execution_graph_digest: digest(JSON.stringify(stageListForDigest(snapshot))),
        observed_cycle_document_digest: digest(snapshot.specification.cycle_description_markdown),
        failed_stage_id: failedStageId,
        reason_code: reasonCode,
        reason_markdown: reasonMarkdown,
      },
    };
    const call = createTaskIssueRecordCall(snapshot, {
      record_id: recordId,
      issue_id: parseTaskIssueId(snapshot.cycle_id),
      expected_issue_revision: snapshot.cycle_revision,
      projection,
    });
    const command = bindCycleTaskManageCommand({
      snapshot,
      workflow: this.options.workflow,
      caller_issuer: this.options.caller_issuer,
      task_manager: this.options.task_manager,
      mutation_manifest: [call],
    });
    const result = await command.create_issue_comment(call, execution);
    execution.assertActive();
    const applied = appliedTaskIssueRecord(call, result, this.options.service_actor_id);
    if (awaiting) parseCycleInvalidationRecord(applied);
    else parseCycleCompletionRecord(applied);
    const comments = await this.options.record_reader.readIssueRecordComments(parseTaskIssueId(snapshot.cycle_id));
    execution.assertActive();
    const fresh = readExactTaskIssueRecord(
      comments,
      parseTaskIssueId(snapshot.cycle_id),
      recordId,
      this.options.service_actor_id,
    );
    if (fresh === null) throw new Error("cycle_failure_record_missing");
    if (awaiting) parseCycleInvalidationRecord(fresh);
    else parseCycleCompletionRecord(fresh);
  }

  async persistWork(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
    result: WorkResult,
    execution: TaskManageBoundaryExecution,
  ): Promise<StageCompletionRecord> {
    const stage = snapshot.sealed_work_issues.find(({ issue_id }) => issue_id === result.work_issue_id);
    const node = built.manifest.ordered_work_nodes.find(
      ({ issue_id }) => issue_id === parseTaskIssueId(result.work_issue_id),
    );
    if (stage === undefined || stage.status !== "in_progress" || node === undefined) {
      throw new Error("work_completion_source_invalid");
    }
    if (digest(stage.description_markdown) !== node.instruction_digest) {
      throw new Error("work_completion_instruction_mismatch");
    }
    const reason = result.outcome === "completed" ? {} : {
      reason_code: `work_${result.outcome}`,
      reason_markdown: result.sanitized_summary_markdown,
    };
    return this.#persistStage(snapshot, basis, execution, {
      record_id: node.completion_record_id,
      stage_id: parseTaskIssueId(stage.issue_id),
      stage_revision: stage.revision,
      stage_description: stage.description_markdown,
      stage_kind: "work",
      projection: {
        outcome: result.outcome,
        instruction_digest: node.instruction_digest,
        workspace_parent_revision: digest(snapshot.git.head_revision ?? "unborn"),
        workspace_diff_digest: digest(snapshot.git.diff_digest),
        checks_markdown: checksMarkdown(result.checks),
        normalized_handoff_markdown: result.sanitized_summary_markdown,
        ...reason,
      },
    });
  }

  async persistVerify(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
    result: VerifyResult,
    execution: TaskManageBoundaryExecution,
  ): Promise<StageCompletionRecord> {
    const stage = snapshot.verify_issue;
    const node = built.manifest.verify_node;
    if (
      stage === null
      || stage.status !== "in_progress"
      || stage.issue_id !== result.verify_issue_id
      || parseTaskIssueId(stage.issue_id) !== node.issue_id
      || digest(stage.description_markdown) !== node.instruction_digest
    ) throw new Error("verify_completion_source_invalid");
    const reason = result.conclusion === "passed" ? {} : result.conclusion === "failed"
      ? { reason_markdown: result.reason_markdown }
      : { reason_code: result.reason_code, reason_markdown: result.reason_markdown };
    return this.#persistStage(snapshot, basis, execution, {
      record_id: node.completion_record_id,
      stage_id: parseTaskIssueId(stage.issue_id),
      stage_revision: stage.revision,
      stage_description: stage.description_markdown,
      stage_kind: "verify",
      projection: {
        conclusion: result.conclusion,
        instruction_digest: node.instruction_digest,
        exact_revision: digest(result.revision),
        checks_markdown: checksMarkdown(result.checks),
        evidence_markdown: result.sanitized_summary_markdown,
        ...reason,
      },
    });
  }

  async persistPlanInvalidation(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    built: BuiltPlanGraphManifest,
    execution: TaskManageBoundaryExecution,
  ): Promise<void> {
    const plan = snapshot.plan_issue;
    if (plan === null || plan.status !== "in_progress") throw new Error("plan_invalidation_source_invalid");
    const call = createTaskIssueRecordCall(snapshot, {
      record_id: basis.specification.plan_invalidation_record_id,
      issue_id: parseTaskIssueId(plan.issue_id),
      expected_issue_revision: plan.revision,
      projection: {
        issue_id: plan.issue_id,
        cycle_id: basis.specification.cycle_id,
        basis_issue_revision: plan.revision,
        basis_status: "In Progress",
        basis_document_digest: digest(plan.description_markdown),
        record_kind: "stage_invalidation",
        stage_id: plan.issue_id,
        observed_status: "In Progress",
        observed_instruction_digest: built.manifest.plan.instruction_digest,
        observed_completion_record_digest: graphSeal(built),
        observed_history_digest: digest(JSON.stringify({
          cycle_revision: snapshot.cycle_revision,
          work_issue_ids: snapshot.sealed_work_issues.map(({ issue_id }) => issue_id),
          verify_issue_id: snapshot.verify_issue?.issue_id ?? null,
          relation_ids: snapshot.sealed_relations.map(({ relation_id }) => relation_id),
        })),
        reason_code: "partial_graph_materialization",
        reason_markdown: "The persisted Plan manifest did not materialize as one exact complete graph.",
        invalidation_kind: "sealed_fact_mutated",
        terminal_status: "Failed",
      },
    });
    const command = bindCycleTaskManageCommand({
      snapshot,
      workflow: this.options.workflow,
      caller_issuer: this.options.caller_issuer,
      task_manager: this.options.task_manager,
      mutation_manifest: [call],
    });
    const result = await command.create_issue_comment(call, execution);
    execution.assertActive();
    const applied = parseStageInvalidationRecord(
      appliedTaskIssueRecord(call, result, this.options.service_actor_id),
    );
    const comments = await this.options.record_reader.readIssueRecordComments(parseTaskIssueId(plan.issue_id));
    execution.assertActive();
    const fresh = readExactTaskIssueRecord(
      comments,
      parseTaskIssueId(plan.issue_id),
      basis.specification.plan_invalidation_record_id,
      this.options.service_actor_id,
    );
    if (fresh === null) throw new Error("plan_invalidation_record_missing");
    const readback = parseStageInvalidationRecord(fresh);
    if (readback.revision !== applied.revision) throw new Error("plan_invalidation_record_readback_mismatch");
  }

  async hasPlanInvalidation(snapshot: CycleAdvanceRequest, basis: SealedCycleBasis): Promise<boolean> {
    const plan = snapshot.plan_issue;
    if (plan === null) throw new Error("plan_invalidation_source_invalid");
    const comments = await this.options.record_reader.readIssueRecordComments(parseTaskIssueId(plan.issue_id));
    const projected = readExactTaskIssueRecord(
      comments,
      parseTaskIssueId(plan.issue_id),
      basis.specification.plan_invalidation_record_id,
      this.options.service_actor_id,
    );
    if (projected === null) return false;
    const record = parseStageInvalidationRecord(projected);
    if (
      record.record_id !== basis.specification.plan_invalidation_record_id
      || record.stage_id !== parseTaskIssueId(plan.issue_id)
      || record.reason_code !== "partial_graph_materialization"
    ) throw new Error("plan_invalidation_anchor_mismatch");
    return true;
  }

  async #persistStage(
    snapshot: CycleAdvanceRequest,
    basis: SealedCycleBasis,
    execution: TaskManageBoundaryExecution,
    input: {
      readonly record_id: string;
      readonly stage_id: TaskIssueId;
      readonly stage_revision: CycleAdvanceRequest["cycle_revision"];
      readonly stage_description: string;
      readonly stage_kind: "plan" | "work" | "verify";
      readonly projection: Readonly<Record<string, unknown>>;
    },
  ): Promise<StageCompletionRecord> {
    const stageCreation = await this.#readServiceIssueCreation(input.stage_id);
    if (input.stage_kind === "plan") {
      if (Date.parse(stageCreation.provider_created_at) <= Date.parse(basis.approval_record.created_at)) {
        throw new Error("plan_creation_order_invalid");
      }
    } else {
      const planComments = await this.options.record_reader.readIssueRecordComments(
        basis.specification.plan_issue_id,
      );
      const planProjection = readExactTaskIssueRecord(
        planComments,
        basis.specification.plan_issue_id,
        basis.specification.plan_completion_record_id,
        this.options.service_actor_id,
      );
      if (planProjection === null) throw new Error("plan_completion_record_missing");
      const planRecord = parseStageCompletionRecord(planProjection, "plan", basis);
      if (
        planRecord.completion.outcome !== "completed"
        || Date.parse(stageCreation.provider_created_at) <= Date.parse(planRecord.created_at)
      ) throw new Error("stage_creation_order_invalid");
    }
    const call = createTaskIssueRecordCall(snapshot, {
      record_id: input.record_id,
      issue_id: input.stage_id,
      expected_issue_revision: input.stage_revision,
      projection: {
        issue_id: input.stage_id,
        cycle_id: basis.specification.cycle_id,
        basis_issue_revision: input.stage_revision,
        basis_status: "In Progress",
        basis_document_digest: digest(input.stage_description),
        record_kind: "stage_completion",
        stage_id: input.stage_id,
        completion: input.projection,
      },
    });
    const command = bindCycleTaskManageCommand({
      snapshot,
      workflow: this.options.workflow,
      caller_issuer: this.options.caller_issuer,
      task_manager: this.options.task_manager,
      mutation_manifest: [call],
    });
    const result = await command.create_issue_comment(call, execution);
    execution.assertActive();
    const appliedProjection = appliedTaskIssueRecord(call, result, this.options.service_actor_id);
    const applied = input.stage_kind === "plan"
      ? parseStageCompletionRecord(appliedProjection, "plan", basis)
      : input.stage_kind === "work"
        ? parseStageCompletionRecord(appliedProjection, "work", basis)
        : parseStageCompletionRecord(appliedProjection, "verify", basis);
    const comments = await this.options.record_reader.readIssueRecordComments(input.stage_id);
    execution.assertActive();
    const fresh = readExactTaskIssueRecord(
      comments,
      input.stage_id,
      input.record_id,
      this.options.service_actor_id,
    );
    if (fresh === null) throw new Error("stage_completion_record_missing");
    const readback = input.stage_kind === "plan"
      ? parseStageCompletionRecord(fresh, "plan", basis)
      : input.stage_kind === "work"
        ? parseStageCompletionRecord(fresh, "work", basis)
        : parseStageCompletionRecord(fresh, "verify", basis);
    if (readback.revision !== applied.revision) throw new Error("stage_completion_record_readback_mismatch");
    if (Date.parse(readback.created_at) <= Date.parse(stageCreation.provider_created_at)) {
      throw new Error("stage_completion_record_order_invalid");
    }
    return readback;
  }

  async #readStablePlanManifest(
    basis: SealedCycleBasis,
  ): Promise<{ readonly record: StageCompletionRecord; readonly built: BuiltPlanGraphManifest } | null> {
    const planId = basis.specification.plan_issue_id;
    const comments = await this.options.record_reader.readIssueRecordComments(planId);
    const projected = readExactTaskIssueRecord(
      comments,
      planId,
      basis.specification.plan_completion_record_id,
      this.options.service_actor_id,
    );
    if (projected === null) return null;
    const record = parseStageCompletionRecord(projected, "plan", basis);
    if (record.completion.outcome !== "completed") return null;
    const built = materializePersistedPlanGraphManifest(record.completion.manifest, basis);
    if (
      record.completion.instruction_digest !== built.manifest.plan.instruction_digest
      || graphSeal(built) !== record.completion.graph_seal_digest
    ) throw new Error("sealed_fact_manifest_mismatch");
    return Object.freeze({ record, built });
  }

  async #readServiceIssueCreation(issueId: TaskIssueId): Promise<{
    readonly provider_created_at: string;
  }> {
    const evidence = await this.options.record_reader.readIssueCreationEvidence(issueId);
    if (evidence.issue_id !== issueId || evidence.actor_id !== this.options.service_actor_id) {
      throw new Error("stage_creation_actor_mismatch");
    }
    return Object.freeze({ provider_created_at: evidence.provider_created_at });
  }
}
