import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  parseStageCompletionRecord,
  parseStageInvalidationRecord,
  type SealedCycleBasis,
  type StageCompletionRecord,
} from "../../contracts/cycle-records.js";
import { parseTaskIssueId, type TaskIssueId } from "../../contracts/identity.js";
import type { CycleAdvanceRequest } from "../../contracts/cycle.js";
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

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function graphSeal(built: BuiltPlanGraphManifest): string {
  return digest(JSON.stringify(built.manifest));
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
