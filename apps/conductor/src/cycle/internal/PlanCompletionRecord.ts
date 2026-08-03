import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  parseCycleCompletionRecord,
  parseCycleInvalidationRecord,
  parseStageCompletionRecord,
  parseStageInvalidationRecord,
  type SealedCycleBasis,
  type StageCompletionRecord,
} from "../../contracts/cycle-records.js";
import { parseTaskIssueId, type TaskIssueId } from "../../contracts/identity.js";
import type { CycleAdvanceRequest } from "../../contracts/cycle.js";
import type { GitCommitProofBasis } from "../../git/api/GitWorkspaceInterface.js";
import type { VerifyResult, WorkResult } from "../../performer/api/StagePerformerInterface.js";
import type { TaskManageCallerIssuer } from "../../task-management/api/TaskManageCapability.js";
import type { TaskWorkflowIdentities } from "../../task-management/api/TaskManageCapability.js";
import type { TaskManageBoundaryExecution, TaskManageCommandInterface } from "../../task-management/api/TaskManageCommandInterface.js";
import type { LinearIssueRecordComment } from "../../task-management/linear/LinearQueries.js";
import { bindCycleTaskManageCommand } from "../../runtime/CycleTaskManageCommand.js";
import { appliedTaskIssueRecord, createTaskIssueRecordCall, readExactTaskIssueRecord } from "./CycleRecords.js";
import {
  assertExactPlanGraph,
  buildPlanGraphManifest,
  type BuiltPlanGraphManifest,
} from "./PlanGraphManifest.js";

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

function graphSeal(built: BuiltPlanGraphManifest): string {
  return digest(JSON.stringify(built.manifest));
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
      (plan.status === "in_progress" && record.basis_issue_revision !== plan.revision)
      || record.basis_document_digest !== digest(plan.description_markdown)
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
    if (
      record.stage_id !== stageId
      || record.basis_document_digest !== digest(stage.description_markdown)
      || record.completion.instruction_digest !== node.instruction_digest
    ) throw new Error("stage_completion_basis_mismatch");
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
    if (stage.kind === "plan") {
      const comments = await this.options.record_reader.readIssueRecordComments(stageId);
      const projected = readExactTaskIssueRecord(
        comments,
        stageId,
        basis.specification.plan_completion_record_id,
        this.options.service_actor_id,
      );
      if (projected !== null) return parseStageCompletionRecord(projected, "plan", basis);
      return this.persistPlanTerminal(
        snapshot,
        basis,
        terminalOutcome,
        reasonMarkdown,
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
    return this.#persistStage(snapshot, basis, execution, stage.kind === "work" ? {
      ...common,
      projection: {
        outcome: terminalOutcome,
        instruction_digest: node.instruction_digest,
        workspace_parent_revision: digest(snapshot.git.head_revision ?? "unborn"),
        workspace_diff_digest: digest(snapshot.git.diff_digest),
        checks_markdown: "## Checks\n\n- not_run: live Work context was lost",
        normalized_handoff_markdown: reasonMarkdown,
        reason_code: reasonCode,
        reason_markdown: reasonMarkdown,
      },
    } : {
      ...common,
      projection: {
        conclusion: "inconclusive",
        instruction_digest: node.instruction_digest,
        exact_revision: digest(snapshot.git.head_revision ?? "unborn"),
        checks_markdown: "## Checks\n\n- not_run: live Verify context was lost",
        evidence_markdown: reasonMarkdown,
        reason_code: reasonCode,
        reason_markdown: reasonMarkdown,
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
    const reason = result.conclusion === "passed" || result.conclusion === "failed" ? {} : {
      reason_code: `verify_${result.conclusion}`,
      reason_markdown: result.sanitized_summary_markdown,
    };
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
