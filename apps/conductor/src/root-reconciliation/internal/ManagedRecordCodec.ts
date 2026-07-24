import type {
  AcceptanceCriterion,
  AffectedScope,
  CheckEvidence,
  ConvergenceRecord,
  DeliveryRecord,
  FindingDispositionRecord,
  FindingEvidence,
  FindingRecord,
  HumanActionRequestRecord,
  HumanActionResolutionRecord,
  ManagedRecord,
  EvidenceReference,
  PlanContract,
  PlanContractProposal,
  PlanDependencyEdge,
  PlanVerifyNode,
  PlanWorkNode,
  ProgressAssessment,
  RootOwnershipRecord,
  RootDirectiveRecord,
  RootReconcilerReplyRecord,
  StageContextCoverage,
  StageContextSource,
  StageExecutionRecord,
  StageResultOutcomeKind,
  StageResultRecord,
  StageLimits,
  VerifyResultRecord,
  WorkflowIssueRecord,
  WorkflowTimelineRecord,
} from "../api/ManagedRecords.js";
import { decodeConductorPerformerRootDirective, type JsonValue } from "@symphony/contracts";
import type { RootDirective } from "../api/RootReconciliationContracts.js";

const symphonyBlock = /^```symphony\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gmu;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const maxText = 16_384;
const maxItems = 128;

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
class InvalidRecord extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function parseManagedRecord(source: string): ParseResult<ManagedRecord> {
  try {
    const blocks = [...source.matchAll(symphonyBlock)];
    if (blocks.length === 0) fail("managed_record_block_missing");
    if (blocks.length > 1) fail("managed_record_block_ambiguous");
    const block = blocks[0]!;
    if (source.slice((block.index ?? 0) + block[0].length).trim()) {
      fail("managed_record_block_not_terminal");
    }
    const json = block[1]!.trim();
    if (!json) fail("managed_record_block_invalid");
    const payload: unknown = JSON.parse(json);
    return { ok: true, value: decodeRecord(payload) };
  } catch (error) {
    return { ok: false, error: error instanceof InvalidRecord ? error.code : "managed_record_payload_invalid" };
  }
}

export function managedMarkdown(source: string): string {
  const parsed = parseManagedRecord(source);
  if (!parsed.ok) throw new Error(parsed.error);
  const block = [...source.matchAll(symphonyBlock)][0];
  if (!block || block.index === undefined) throw new Error("managed_record_block_missing");
  return source.slice(0, block.index).trimEnd();
}

export function serializeManagedRecord(record: unknown, markdown?: string): string {
  try {
    const payload = encodeRecord(record);
    const decoded = decodeRecord(payload);
    if (decoded.kind !== (record as { kind?: unknown }).kind) fail("managed_record_kind_invalid");
    const rendered = markdown === undefined ? managedRecordSummary(decoded.kind) : renderedMarkdown(markdown);
    return `${rendered}\n\n\`\`\`symphony\n${JSON.stringify(payload)}\n\`\`\``;
  } catch (error) {
    if (error instanceof InvalidRecord) throw new Error(error.code);
    throw new Error("managed_record_payload_invalid");
  }
}

function renderedMarkdown(value: string): string {
  const markdown = value.trim();
  if (!markdown || markdown.length > maxText || /\0/u.test(markdown)) {
    fail("managed_record_markdown_invalid");
  }
  return markdown;
}

function managedRecordSummary(kind: ManagedRecord["kind"]): string {
  switch (kind) {
    case "root_ownership": return "Root ownership recorded.";
    case "workflow_issue": return "Workflow issue identity recorded.";
    case "root_directive": return "Root decision recorded.";
    case "root_reconciler_reply": return "Root Reconciler reply recorded.";
    case "delivery": return "Delivery recorded.";
    case "workflow_timeline": return "Workflow timeline recorded.";
    case "plan_contract": return "Plan contract recorded.";
    case "stage_execution": return "Stage execution recorded.";
    case "stage_result": return "Stage result recorded.";
    case "human_action_request": return "Human action request recorded.";
    case "human_action_resolution": return "Human action resolution recorded.";
    case "finding": return "Finding recorded.";
    case "finding_disposition": return "Finding disposition recorded.";
    case "verify_result": return "Verification result recorded.";
    case "progress_assessment": return "Progress assessment recorded.";
    case "convergence": return "Convergence assessment recorded.";
  }
}

function decodeRecord(value: unknown): ManagedRecord {
  const object = recordObject(value);
  const kind = requiredString(object, "kind", true);
  if (object.version !== 1) fail(object.version === undefined ? "managed_record_required_field:version" : "managed_record_version_invalid");
  switch (kind) {
    case "root_ownership": return decodeRootOwnership(object);
    case "workflow_issue": return decodeWorkflowIssue(object);
    case "root_directive": return decodeRootDirectiveRecord(object);
    case "root_reconciler_reply": return decodeRootReconcilerReplyRecord(object);
    case "delivery": return decodeDelivery(object);
    case "workflow_timeline": return decodeWorkflowTimeline(object);
    case "plan_contract": return decodePlanContract(object);
    case "stage_execution": return decodeStageExecution(object);
    case "stage_result": return decodeStageResult(object);
    case "human_action_request": return decodeHumanActionRequest(object);
    case "human_action_resolution": return decodeHumanActionResolution(object);
    case "finding": return decodeFinding(object);
    case "finding_disposition": return decodeFindingDisposition(object);
    case "verify_result": return decodeVerifyResult(object);
    case "progress_assessment": return decodeProgressAssessment(object);
    case "convergence": return decodeConvergence(object);
    default: fail("managed_record_kind_invalid");
  }
}

function decodeWorkflowIssue(o: Record<string, unknown>): WorkflowIssueRecord {
  fields(o, ["kind", "version", "issue_key", "root_issue_id", "parent_issue_id", "issue_kind"]);
  return {
    kind: "workflow_issue",
    version: 1,
    issueKey: id(o, "issue_key"),
    rootIssueId: id(o, "root_issue_id"),
    parentIssueId: id(o, "parent_issue_id"),
    issueKind: enumValue(o, "issue_kind", ["cycle", "plan", "work", "verify", "human"]),
  };
}

function decodeRootOwnership(o: Record<string, unknown>): RootOwnershipRecord {
  fields(o, ["kind", "version", "root_issue_id", "conductor_id", "performer_profile_id", "delivery_branch", "pull_request", "owner_generation"], ["pull_request"]);
  return {
    kind: "root_ownership", version: 1, rootIssueId: id(o, "root_issue_id"), conductorId: id(o, "conductor_id"),
    performerProfileId: id(o, "performer_profile_id"), deliveryBranch: text(o, "delivery_branch"),
    ...(o.pull_request === undefined ? {} : { pullRequest: text(o, "pull_request") }), ownerGeneration: id(o, "owner_generation"),
  };
}

function decodeRootDirectiveRecord(o: Record<string, unknown>): RootDirectiveRecord {
  fields(o, [
    "kind", "version", "root_directive_id", "root_issue_id", "reconciler_session_id", "reconciler_turn_id",
    "based_on_target_root_digest", "consumed_input_ids", "directive", "accepted_at",
  ]);
  const directive = decodeRootDirective(requiredObject(o, "directive"));
  if (
    directive.rootDirectiveId !== id(o, "root_directive_id") ||
    directive.basedOnTargetRootDigest !== id(o, "based_on_target_root_digest") ||
    directive.reconcilerSessionId !== id(o, "reconciler_session_id") ||
    directive.reconcilerTurnId !== id(o, "reconciler_turn_id")
  ) fail("managed_record_root_directive_correlation_invalid");
  return {
    kind: "root_directive",
    version: 1,
    rootDirectiveId: id(o, "root_directive_id"),
    rootIssueId: id(o, "root_issue_id"),
    reconcilerSessionId: id(o, "reconciler_session_id"),
    reconcilerTurnId: id(o, "reconciler_turn_id"),
    basedOnTargetRootDigest: id(o, "based_on_target_root_digest"),
    consumedInputIds: ids(o, "consumed_input_ids"),
    directive,
    acceptedAt: timestamp(o, "accepted_at"),
  };
}

function decodeRootReconcilerReplyRecord(o: Record<string, unknown>): RootReconcilerReplyRecord {
  fields(o, [
    "kind", "version", "reply_id", "reply_write_id", "root_directive_id", "source_input_id", "source_comment_id",
    "source_comment_version", "target_issue_id", "disposition", "reaction", "thread_action", "materialized_outcome_refs",
    "rendered_schema_version", "replied_at",
  ]);
  return {
    kind: "root_reconciler_reply",
    version: 1,
    replyId: id(o, "reply_id"),
    replyWriteId: id(o, "reply_write_id"),
    rootDirectiveId: id(o, "root_directive_id"),
    sourceInputId: id(o, "source_input_id"),
    sourceCommentId: id(o, "source_comment_id"),
    sourceCommentVersion: id(o, "source_comment_version"),
    targetIssueId: id(o, "target_issue_id"),
    disposition: enumValue(o, "disposition", ["accepted", "not_applied", "follow_up_required"]),
    reaction: enumValue(o, "reaction", ["check", "cross", "none"]),
    threadAction: enumValue(o, "thread_action", ["resolve", "keep_open", "reopen"]),
    materializedOutcomeRefs: array(o, "materialized_outcome_refs", decodeEvidenceReference),
    renderedSchemaVersion: enumValue(o, "rendered_schema_version", ["1"]),
    repliedAt: timestamp(o, "replied_at"),
  };
}

function decodeRootDirective(value: Record<string, unknown>): RootDirective {
  const wire = snakeCaseKeys({ ...value, protocol_version: "1" });
  try {
    decodeConductorPerformerRootDirective(wire as JsonValue);
  } catch {
    fail("managed_record_root_directive_invalid");
  }
  const camel = camelCaseKeys(wire);
  if (!isObject(camel)) fail("managed_record_root_directive_invalid");
  if (camel.protocolVersion === "1") camel.protocolVersion = 1;
  return camel as unknown as RootDirective;
}

function decodeDelivery(o: Record<string, unknown>): DeliveryRecord {
  fields(o, ["kind", "version", "root_issue_id", "cycle_issue_id", "verify_result_id", "verified_revision", "delivery_kind", "delivery_branch", "pull_request", "delivered_at"], ["pull_request"]);
  return {
    kind: "delivery", version: 1, rootIssueId: id(o, "root_issue_id"), cycleIssueId: id(o, "cycle_issue_id"),
    verifyResultId: id(o, "verify_result_id"), verifiedRevision: id(o, "verified_revision"),
    deliveryKind: enumValue(o, "delivery_kind", ["pull_request", "remote_branch", "local_branch"]),
    deliveryBranch: text(o, "delivery_branch"),
    ...(o.pull_request === undefined ? {} : { pullRequest: text(o, "pull_request") }),
    deliveredAt: timestamp(o, "delivered_at"),
  };
}

function decodeWorkflowTimeline(o: Record<string, unknown>): WorkflowTimelineRecord {
  fields(o, [
    "kind", "version", "timeline_event_id", "timeline_kind", "target_issue_id", "source_record_ids",
    "source_versions", "write_id", "rendered_schema_version", "materialized_at",
  ]);
  return {
    kind: "workflow_timeline",
    version: 1,
    timelineEventId: id(o, "timeline_event_id"),
    timelineKind: enumValue(o, "timeline_kind", ["root", "cycle"]),
    targetIssueId: id(o, "target_issue_id"),
    sourceRecordIds: ids(o, "source_record_ids"),
    sourceVersions: strings(o, "source_versions"),
    writeId: id(o, "write_id"),
    renderedSchemaVersion: enumValue(o, "rendered_schema_version", ["1"]),
    materializedAt: timestamp(o, "materialized_at"),
  };
}

function decodePlanContract(o: Record<string, unknown>): PlanContract {
  fields(o, [
    "kind", "version", "root_issue_id", "cycle_issue_id", "plan_contract_digest", "objective", "included_scope",
    "excluded_scope", "assumptions", "constraints", "acceptance_criteria", "verification_requirements", "proposed_work_dag",
  ]);
  return {
    kind: "plan_contract", version: 1, rootIssueId: id(o, "root_issue_id"), cycleIssueId: id(o, "cycle_issue_id"), planContractDigest: id(o, "plan_contract_digest"),
    ...decodePlanContractProposal({
      objective: o.objective,
      included_scope: o.included_scope,
      excluded_scope: o.excluded_scope,
      assumptions: o.assumptions,
      constraints: o.constraints,
      acceptance_criteria: o.acceptance_criteria,
      verification_requirements: o.verification_requirements,
    }),
    proposedWorkDag: decodePlanDag(requiredObject(o, "proposed_work_dag")),
  };
}

function decodeStageExecution(o: Record<string, unknown>): StageExecutionRecord {
  fields(o, ["kind", "version", "stage_execution_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "stage", "plan_contract_digest", "context_digest", "source_manifest", "coverage", "instruction_set_id", "execution_policy_id", "limits", "repository_revision", "started_at", "deadline_at"], ["plan_contract_digest"]);
  const stage = stageValue(o, "stage");
  if (stage !== "plan" && o.plan_contract_digest === undefined) {
    fail("managed_record_required_field:plan_contract_digest");
  }
  if (stage === "plan" && o.plan_contract_digest !== undefined) fail("managed_record_stage_field_invalid:plan_contract_digest");
  return {
    kind: "stage_execution", version: 1, stageExecutionId: id(o, "stage_execution_id"), rootIssueId: id(o, "root_issue_id"), cycleIssueId: id(o, "cycle_issue_id"), nodeIssueId: id(o, "node_issue_id"), stage,
    ...(o.plan_contract_digest === undefined ? {} : { planContractDigest: id(o, "plan_contract_digest") }), contextDigest: id(o, "context_digest"),
    sourceManifest: array(o, "source_manifest", decodeSource), coverage: decodeCoverage(requiredObject(o, "coverage")), instructionSetId: id(o, "instruction_set_id"), executionPolicyId: id(o, "execution_policy_id"), limits: decodeLimits(requiredObject(o, "limits")), repositoryRevision: id(o, "repository_revision"), startedAt: timestamp(o, "started_at"), deadlineAt: timestamp(o, "deadline_at"),
  };
}

function decodeStageResult(o: Record<string, unknown>): StageResultRecord {
  fields(o, [
    "kind", "version", "result_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "stage",
    "role_session_id", "role_turn_id", "observed_tree_digest", "context_digest", "outcome_kind", "summary",
    "source_manifest", "completed_at", "plan_contract_digest", "changed_paths", "commit_revision",
    "verify_conclusion", "verified_revision", "failure_code", "plan_contract", "proposed_work_dag", "risks",
    "required_permissions", "evidence_refs",
  ], [
    "plan_contract_digest", "changed_paths", "commit_revision", "verify_conclusion", "verified_revision", "failure_code",
    "plan_contract", "proposed_work_dag", "risks", "required_permissions", "evidence_refs",
  ]);
  const stage = stageValue(o, "stage");
  const outcomeKind: StageResultOutcomeKind = enumValue(o, "outcome_kind", [
    "plan_completed", "plan_needs_information", "plan_blocked",
    "work_completed", "work_blocked", "work_plan_assumption_invalid", "work_scope_conflict",
    "work_permission_required", "work_information_required", "verify_passed", "verify_changes_required",
    "verify_inconclusive", "verify_plan_contract_violation", "verify_blocked", "budget_exhausted", "canceled",
    "execution_failed",
  ] as const);
  const commonOutcomes = new Set(["budget_exhausted", "canceled", "execution_failed"]);
  const roleMatches = stage === "plan"
    ? outcomeKind.startsWith("plan_")
    : stage === "work"
      ? outcomeKind.startsWith("work_")
      : outcomeKind.startsWith("verify_");
  if (!roleMatches && !commonOutcomes.has(outcomeKind)) fail("managed_record_stage_result_role_invalid");
  const isCompletedPlan = stage === "plan" && outcomeKind === "plan_completed";
  const planFields = ["plan_contract_digest", "plan_contract", "proposed_work_dag", "risks", "required_permissions", "evidence_refs"];
  if (planFields.some((field) => o[field] !== undefined) && !isCompletedPlan) {
    fail("managed_record_stage_result_field_invalid");
  }
  if (isCompletedPlan && planFields.some((field) => o[field] === undefined)) fail("managed_record_required_field:plan_completed");
  if (o.changed_paths !== undefined || o.commit_revision !== undefined) {
    if (stage !== "work" || outcomeKind !== "work_completed" || o.changed_paths === undefined || o.commit_revision === undefined) {
      fail("managed_record_stage_result_field_invalid");
    }
  }
  if (o.verify_conclusion !== undefined || o.verified_revision !== undefined) {
    if (stage !== "verify" || !outcomeKind.startsWith("verify_")) {
      fail("managed_record_stage_result_field_invalid");
    }
  }
  if (o.failure_code !== undefined && outcomeKind !== "execution_failed") {
    fail("managed_record_stage_result_field_invalid");
  }
  return {
    kind: "stage_result", version: 1,
    resultId: id(o, "result_id"), rootIssueId: id(o, "root_issue_id"), cycleIssueId: id(o, "cycle_issue_id"),
    nodeIssueId: id(o, "node_issue_id"), stage, roleSessionId: id(o, "role_session_id"), roleTurnId: id(o, "role_turn_id"),
    observedTreeDigest: id(o, "observed_tree_digest"), contextDigest: id(o, "context_digest"), outcomeKind,
    summary: text(o, "summary"), sourceManifest: strings(o, "source_manifest"), completedAt: timestamp(o, "completed_at"),
    ...(o.plan_contract_digest === undefined ? {} : { planContractDigest: id(o, "plan_contract_digest") }),
    ...(o.plan_contract === undefined ? {} : { planContract: decodePlanContractProposal(requiredObject(o, "plan_contract")) }),
    ...(o.proposed_work_dag === undefined ? {} : { proposedWorkDag: decodePlanDag(requiredObject(o, "proposed_work_dag")) }),
    ...(o.risks === undefined ? {} : { risks: strings(o, "risks") }),
    ...(o.required_permissions === undefined ? {} : { requiredPermissions: strings(o, "required_permissions") }),
    ...(o.evidence_refs === undefined ? {} : { evidenceRefs: array(o, "evidence_refs", decodeEvidenceReference) }),
    ...(o.changed_paths === undefined ? {} : { changedPaths: paths(o, "changed_paths") }),
    ...(o.commit_revision === undefined ? {} : { commitRevision: id(o, "commit_revision") }),
    ...(o.verify_conclusion === undefined ? {} : { verifyConclusion: enumValue(o, "verify_conclusion", ["passed", "changes_required", "inconclusive", "escalate_human"]) }),
    ...(o.verified_revision === undefined ? {} : { verifiedRevision: id(o, "verified_revision") }),
    ...(o.failure_code === undefined ? {} : { failureCode: id(o, "failure_code") }),
  };
}

function decodeHumanActionRequest(o: Record<string, unknown>): HumanActionRequestRecord {
  fields(o, ["kind", "version", "action_id", "action_issue_id", "action_kind", "parent_scope", "root_issue_id", "cycle_issue_id", "related_issue_ids", "source_root_directive_id", "source_root_convergence_record_id", "based_on_tree_digest", "proposal_digest", "expected_parent_remote_version", "created_at"], ["cycle_issue_id", "source_root_directive_id", "source_root_convergence_record_id", "based_on_tree_digest"]);
  const parentScope = enumValue(o, "parent_scope", ["root", "cycle"]);
  if (parentScope === "cycle" && o.cycle_issue_id === undefined) fail("managed_record_required_field:cycle_issue_id");
  if (parentScope === "root" && o.cycle_issue_id !== undefined) fail("managed_record_scope_invalid");
  return {
    kind: "human_action_request", version: 1, actionId: id(o, "action_id"), actionIssueId: id(o, "action_issue_id"),
    actionKind: enumValue(o, "action_kind", ["plan_review", "clarification", "permission", "finding_waiver", "convergence_override"]),
    parentScope, rootIssueId: id(o, "root_issue_id"),
    ...(o.cycle_issue_id === undefined ? {} : { cycleIssueId: id(o, "cycle_issue_id") }), relatedIssueIds: ids(o, "related_issue_ids"),
    ...(o.source_root_directive_id === undefined ? {} : { sourceRootDirectiveId: id(o, "source_root_directive_id") }),
    ...(o.source_root_convergence_record_id === undefined ? {} : { sourceRootConvergenceRecordId: id(o, "source_root_convergence_record_id") }),
    ...(o.based_on_tree_digest === undefined ? {} : { basedOnTreeDigest: id(o, "based_on_tree_digest") }),
    proposalDigest: id(o, "proposal_digest"), expectedParentRemoteVersion: opaque(o, "expected_parent_remote_version"), createdAt: timestamp(o, "created_at"),
  };
}

function decodeHumanActionResolution(o: Record<string, unknown>): HumanActionResolutionRecord {
  fields(o, ["kind", "version", "resolution_id", "action_id", "action_issue_id", "action_kind", "outcome", "terminal_status", "terminal_remote_version", "source_comment_ids", "source_comment_versions", "actor_kind", "proposal_digest", "resolved_at"]);
  const sourceCommentIds = ids(o, "source_comment_ids");
  const sourceCommentVersions = opaques(o, "source_comment_versions");
  if (sourceCommentIds.length !== sourceCommentVersions.length) fail("managed_record_source_comment_mismatch");
  return {
    kind: "human_action_resolution", version: 1, resolutionId: id(o, "resolution_id"), actionId: id(o, "action_id"), actionIssueId: id(o, "action_issue_id"),
    actionKind: enumValue(o, "action_kind", ["plan_review", "clarification", "permission", "finding_waiver", "convergence_override"]),
    outcome: enumValue(o, "outcome", ["approved", "rejected", "answered", "canceled", "granted", "denied", "waived", "override_applied", "override_rejected"]),
    terminalStatus: enumValue(o, "terminal_status", ["Approved", "Rejected", "Answered", "Canceled"]), terminalRemoteVersion: opaque(o, "terminal_remote_version"),
    sourceCommentIds, sourceCommentVersions, actorKind: enumValue(o, "actor_kind", ["human"]), proposalDigest: id(o, "proposal_digest"), resolvedAt: timestamp(o, "resolved_at"),
  };
}

function decodeFinding(o: Record<string, unknown>): FindingRecord {
  fields(o, ["kind", "version", "finding_id", "source_verify_id", "category", "severity", "evidence", "affected_scope", "retryable", "suggested_remediation", "acceptance_criteria"]);
  return { kind: "finding", version: 1, findingId: id(o, "finding_id"), sourceVerifyId: id(o, "source_verify_id"), category: enumValue(o, "category", ["product", "code", "test", "infra", "requirement", "policy"]), severity: enumValue(o, "severity", ["critical", "high", "medium", "low"]), evidence: array(o, "evidence", decodeFindingEvidence), affectedScope: array(o, "affected_scope", decodeAffectedScope), retryable: bool(o, "retryable"), suggestedRemediation: strings(o, "suggested_remediation"), acceptanceCriteria: criteria(o, "acceptance_criteria") };
}

function decodeFindingDisposition(o: Record<string, unknown>): FindingDispositionRecord {
  fields(o, ["kind", "version", "finding_id", "source_verify_id", "disposition", "evidence"]);
  return { kind: "finding_disposition", version: 1, findingId: id(o, "finding_id"), sourceVerifyId: id(o, "source_verify_id"), disposition: enumValue(o, "disposition", ["still_open", "resolved", "waived"]), evidence: array(o, "evidence", decodeFindingEvidence) };
}

function decodeVerifyResult(o: Record<string, unknown>): VerifyResultRecord {
  fields(o, ["kind", "version", "stage_execution_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "conclusion", "criteria_results", "checks", "verified_revision"]);
  return {
    kind: "verify_result", version: 1, stageExecutionId: id(o, "stage_execution_id"), rootIssueId: id(o, "root_issue_id"), cycleIssueId: id(o, "cycle_issue_id"), nodeIssueId: id(o, "node_issue_id"),
    conclusion: enumValue(o, "conclusion", ["passed", "changes_required", "inconclusive", "escalate_human"]),
    criteriaResults: array(o, "criteria_results", (entry) => { fields(entry, ["criterion_key", "outcome", "summary"]); return { criterionKey: id(entry, "criterion_key"), outcome: enumValue(entry, "outcome", ["passed", "failed", "not_run"]), summary: text(entry, "summary") }; }),
    checks: array(o, "checks", decodeCheck), verifiedRevision: id(o, "verified_revision"),
  };
}

function decodeProgressAssessment(o: Record<string, unknown>): ProgressAssessment {
  fields(o, ["kind", "version", "root_issue_id", "previous_verify_id", "current_verify_id", "resolved_finding_ids", "previous_passed_criterion_keys", "current_passed_criterion_keys", "previous_passed_check_keys", "current_passed_check_keys", "is_progress"]);
  return { kind: "progress_assessment", version: 1, rootIssueId: id(o, "root_issue_id"), previousVerifyId: id(o, "previous_verify_id"), currentVerifyId: id(o, "current_verify_id"), resolvedFindingIds: ids(o, "resolved_finding_ids"), previousPassedCriterionKeys: ids(o, "previous_passed_criterion_keys"), currentPassedCriterionKeys: ids(o, "current_passed_criterion_keys"), previousPassedCheckKeys: ids(o, "previous_passed_check_keys"), currentPassedCheckKeys: ids(o, "current_passed_check_keys"), isProgress: bool(o, "is_progress") };
}

function decodeConvergence(o: Record<string, unknown>): ConvergenceRecord {
  fields(o, ["kind", "version", "root_issue_id", "observed_at", "policy", "view", "trigger", "decision"]);
  const policy = requiredObject(o, "policy");
  fields(policy, ["max_cycles_per_root", "max_same_open_finding_cycles", "max_consecutive_no_progress", "max_total_tokens", "deadline_at"]);
  const view = requiredObject(o, "view");
  fields(view, ["cycle_count", "open_finding_persistence", "consecutive_no_progress", "settled_tokens", "open_token_reservations", "is_deadline_exceeded", "root_is_canceled"]);
  return { kind: "convergence", version: 1, rootIssueId: id(o, "root_issue_id"), observedAt: timestamp(o, "observed_at"), policy: { maxCyclesPerRoot: integer(policy, "max_cycles_per_root"), maxSameOpenFindingCycles: integer(policy, "max_same_open_finding_cycles"), maxConsecutiveNoProgress: integer(policy, "max_consecutive_no_progress"), maxTotalTokens: integer(policy, "max_total_tokens"), deadlineAt: timestamp(policy, "deadline_at") }, view: { cycleCount: integer(view, "cycle_count"), openFindingPersistence: array(view, "open_finding_persistence", (entry) => { fields(entry, ["finding_id", "open_cycle_count"]); return { findingId: id(entry, "finding_id"), openCycleCount: integer(entry, "open_cycle_count") }; }), consecutiveNoProgress: integer(view, "consecutive_no_progress"), settledTokens: integer(view, "settled_tokens"), openTokenReservations: array(view, "open_token_reservations", (entry) => { fields(entry, ["stage_execution_id", "reserved_total_tokens"]); return { stageExecutionId: id(entry, "stage_execution_id"), reservedTotalTokens: integer(entry, "reserved_total_tokens") }; }), isDeadlineExceeded: bool(view, "is_deadline_exceeded"), rootIsCanceled: bool(view, "root_is_canceled") }, trigger: enumValue(o, "trigger", ["none", "root_canceled", "deadline_exceeded", "max_cycles_per_root", "max_same_open_finding_cycles", "max_consecutive_no_progress", "token_budget"]), decision: enumValue(o, "decision", ["allow", "escalate", "canceled"]) };
}

function decodeCriterion(o: Record<string, unknown>): AcceptanceCriterion { fields(o, ["criterion_key", "statement", "verification_method"]); return { criterionKey: id(o, "criterion_key"), statement: text(o, "statement"), verificationMethod: text(o, "verification_method") }; }
function decodeCheck(o: Record<string, unknown>): CheckEvidence { fields(o, ["check_key", "command_or_method", "outcome", "summary", "artifact_revision"]); return { checkKey: id(o, "check_key"), commandOrMethod: text(o, "command_or_method"), outcome: enumValue(o, "outcome", ["passed", "failed", "not_run"]), summary: text(o, "summary"), artifactRevision: id(o, "artifact_revision") }; }
function decodeSource(o: Record<string, unknown>): StageContextSource { fields(o, ["source_kind", "source_id", "version_or_digest"]); return { sourceKind: enumValue(o, "source_kind", ["linear_issue", "linear_comment", "linear_relation", "git", "repository_instruction"]), sourceId: id(o, "source_id"), versionOrDigest: id(o, "version_or_digest") }; }
function decodeCoverage(o: Record<string, unknown>): StageContextCoverage { fields(o, ["is_complete", "omissions"]); return { isComplete: bool(o, "is_complete"), omissions: array(o, "omissions", (entry) => { fields(entry, ["source_id", "reason"]); return { sourceId: id(entry, "source_id"), reason: text(entry, "reason") }; }) }; }
function decodeLimits(o: Record<string, unknown>): StageLimits { fields(o, ["max_context_bytes", "max_result_bytes", "max_wall_time_ms", "max_tool_calls", "max_command_duration_ms", "reserved_total_tokens", "max_output_tokens"]); return { maxContextBytes: positiveInteger(o, "max_context_bytes"), maxResultBytes: positiveInteger(o, "max_result_bytes"), maxWallTimeMs: positiveInteger(o, "max_wall_time_ms"), maxToolCalls: integer(o, "max_tool_calls"), maxCommandDurationMs: positiveInteger(o, "max_command_duration_ms"), reservedTotalTokens: integer(o, "reserved_total_tokens"), maxOutputTokens: positiveInteger(o, "max_output_tokens") }; }
function decodeFindingEvidence(o: Record<string, unknown>): FindingEvidence { fields(o, ["evidence_id", "source_kind", "source_id", "summary", "artifact_revision"]); return { evidenceId: id(o, "evidence_id"), sourceKind: enumValue(o, "source_kind", ["criterion", "check", "diff", "file", "log", "human_input"]), sourceId: id(o, "source_id"), summary: text(o, "summary"), artifactRevision: id(o, "artifact_revision") }; }
function decodeAffectedScope(o: Record<string, unknown>): AffectedScope { fields(o, ["scope_kind", "identity"]); return { scopeKind: enumValue(o, "scope_kind", ["repository_path", "criterion", "component", "workflow_boundary"]), identity: text(o, "identity") }; }
function decodePlanContractProposal(o: Record<string, unknown>): PlanContractProposal {
  fields(o, ["objective", "included_scope", "excluded_scope", "assumptions", "constraints", "acceptance_criteria", "verification_requirements"]);
  return {
    objective: text(o, "objective"), includedScope: strings(o, "included_scope"), excludedScope: strings(o, "excluded_scope"),
    assumptions: strings(o, "assumptions"), constraints: strings(o, "constraints"), acceptanceCriteria: criteria(o, "acceptance_criteria"),
    verificationRequirements: strings(o, "verification_requirements"),
  };
}

function decodePlanDag(o: Record<string, unknown>) {
  fields(o, ["work_nodes", "dependency_edges", "verify_node"]);
  return {
    workNodes: array(o, "work_nodes", decodePlanWorkNode),
    dependencyEdges: array(o, "dependency_edges", decodePlanDependencyEdge),
    verifyNode: decodePlanVerifyNode(requiredObject(o, "verify_node")),
  };
}

function decodePlanWorkNode(o: Record<string, unknown>): PlanWorkNode {
  fields(o, ["proposal_key", "title", "description", "expected_outcome", "required_checks", "dependency_proposal_keys"]);
  return {
    proposalKey: id(o, "proposal_key"), title: text(o, "title"), description: text(o, "description"),
    expectedOutcome: text(o, "expected_outcome"), requiredChecks: strings(o, "required_checks"), dependencyProposalKeys: ids(o, "dependency_proposal_keys"),
  };
}

function decodePlanDependencyEdge(o: Record<string, unknown>): PlanDependencyEdge {
  fields(o, ["relation_id", "relation_kind", "source_issue_id", "target_issue_id"]);
  return {
    relationId: id(o, "relation_id"), relationKind: enumValue(o, "relation_kind", ["blocks", "blocked_by", "relates_to", "triggered_by"]),
    sourceIssueId: id(o, "source_issue_id"), targetIssueId: id(o, "target_issue_id"),
  };
}

function decodePlanVerifyNode(o: Record<string, unknown>): PlanVerifyNode {
  fields(o, ["title", "acceptance_criteria", "required_checks"]);
  return { title: text(o, "title"), acceptanceCriteria: criteria(o, "acceptance_criteria"), requiredChecks: strings(o, "required_checks") };
}

function decodeEvidenceReference(o: Record<string, unknown>): EvidenceReference {
  fields(o, ["reference_id", "source_kind"]);
  return { referenceId: id(o, "reference_id"), sourceKind: enumValue(o, "source_kind", ["linear_issue", "linear_comment", "linear_record", "git", "check", "result"]) };
}

function encodeRecord(value: unknown): Record<string, unknown> {
  if (!isObject(value) || typeof value.kind !== "string") fail("managed_record_kind_invalid");
  const record = value as unknown as ManagedRecord;
  const topFields: Record<ManagedRecord["kind"], { allowed: string[]; optional?: string[] }> = {
    root_ownership: { allowed: ["kind", "version", "rootIssueId", "conductorId", "performerProfileId", "deliveryBranch", "pullRequest", "ownerGeneration"], optional: ["pullRequest"] },
    workflow_issue: { allowed: ["kind", "version", "issueKey", "rootIssueId", "parentIssueId", "issueKind"] },
    root_directive: { allowed: ["kind", "version", "rootDirectiveId", "rootIssueId", "reconcilerSessionId", "reconcilerTurnId", "basedOnTargetRootDigest", "consumedInputIds", "directive", "acceptedAt"] },
    root_reconciler_reply: { allowed: ["kind", "version", "replyId", "replyWriteId", "rootDirectiveId", "sourceInputId", "sourceCommentId", "sourceCommentVersion", "targetIssueId", "disposition", "reaction", "threadAction", "materializedOutcomeRefs", "renderedSchemaVersion", "repliedAt"] },
    delivery: { allowed: ["kind", "version", "rootIssueId", "cycleIssueId", "verifyResultId", "verifiedRevision", "deliveryKind", "deliveryBranch", "pullRequest", "deliveredAt"], optional: ["pullRequest"] },
    workflow_timeline: { allowed: ["kind", "version", "timelineEventId", "timelineKind", "targetIssueId", "sourceRecordIds", "sourceVersions", "writeId", "renderedSchemaVersion", "materializedAt"] },
    plan_contract: { allowed: ["kind", "version", "rootIssueId", "cycleIssueId", "planContractDigest", "objective", "includedScope", "excludedScope", "assumptions", "constraints", "acceptanceCriteria", "verificationRequirements", "proposedWorkDag"] },
    stage_execution: { allowed: ["kind", "version", "stageExecutionId", "rootIssueId", "cycleIssueId", "nodeIssueId", "stage", "planContractDigest", "contextDigest", "sourceManifest", "coverage", "instructionSetId", "executionPolicyId", "limits", "repositoryRevision", "startedAt", "deadlineAt"], optional: ["planContractDigest"] },
    stage_result: { allowed: ["kind", "version", "resultId", "rootIssueId", "cycleIssueId", "nodeIssueId", "stage", "roleSessionId", "roleTurnId", "observedTreeDigest", "contextDigest", "outcomeKind", "summary", "sourceManifest", "completedAt", "planContractDigest", "planContract", "proposedWorkDag", "risks", "requiredPermissions", "evidenceRefs", "changedPaths", "commitRevision", "verifyConclusion", "verifiedRevision", "failureCode"], optional: ["planContractDigest", "planContract", "proposedWorkDag", "risks", "requiredPermissions", "evidenceRefs", "changedPaths", "commitRevision", "verifyConclusion", "verifiedRevision", "failureCode"] },
    human_action_request: { allowed: ["kind", "version", "actionId", "actionIssueId", "actionKind", "parentScope", "rootIssueId", "cycleIssueId", "relatedIssueIds", "sourceRootDirectiveId", "sourceRootConvergenceRecordId", "basedOnTreeDigest", "proposalDigest", "expectedParentRemoteVersion", "createdAt"], optional: ["cycleIssueId", "sourceRootDirectiveId", "sourceRootConvergenceRecordId", "basedOnTreeDigest"] },
    human_action_resolution: { allowed: ["kind", "version", "resolutionId", "actionId", "actionIssueId", "actionKind", "outcome", "terminalStatus", "terminalRemoteVersion", "sourceCommentIds", "sourceCommentVersions", "actorKind", "proposalDigest", "resolvedAt"] },
    finding: { allowed: ["kind", "version", "findingId", "sourceVerifyId", "category", "severity", "evidence", "affectedScope", "retryable", "suggestedRemediation", "acceptanceCriteria"] },
    finding_disposition: { allowed: ["kind", "version", "findingId", "sourceVerifyId", "disposition", "evidence"] },
    verify_result: { allowed: ["kind", "version", "stageExecutionId", "rootIssueId", "cycleIssueId", "nodeIssueId", "conclusion", "criteriaResults", "checks", "verifiedRevision"] },
    progress_assessment: { allowed: ["kind", "version", "rootIssueId", "previousVerifyId", "currentVerifyId", "resolvedFindingIds", "previousPassedCriterionKeys", "currentPassedCriterionKeys", "previousPassedCheckKeys", "currentPassedCheckKeys", "isProgress"] },
    convergence: { allowed: ["kind", "version", "rootIssueId", "observedAt", "policy", "view", "trigger", "decision"] },
  };
  const shape = topFields[record.kind];
  if (!shape) fail("managed_record_kind_invalid");
  recordFields(record, shape.allowed, shape.optional);
  if (record.kind === "convergence") {
    recordFields(record.policy, ["maxCyclesPerRoot", "maxSameOpenFindingCycles", "maxConsecutiveNoProgress", "maxTotalTokens", "deadlineAt"]);
    recordFields(record.view, ["cycleCount", "openFindingPersistence", "consecutiveNoProgress", "settledTokens", "openTokenReservations", "isDeadlineExceeded", "rootIsCanceled"]);
  }
  switch (record.kind) {
    case "root_ownership": return encodeRootOwnership(record);
    case "workflow_issue": return encodeSimple(record, { issue_key: record.issueKey, root_issue_id: record.rootIssueId, parent_issue_id: record.parentIssueId, issue_kind: record.issueKind });
    case "root_directive": return encodeSimple(record, {
      root_directive_id: record.rootDirectiveId,
      root_issue_id: record.rootIssueId,
      reconciler_session_id: record.reconcilerSessionId,
      reconciler_turn_id: record.reconcilerTurnId,
      based_on_target_root_digest: record.basedOnTargetRootDigest,
      consumed_input_ids: record.consumedInputIds,
      directive: encodeRootDirective(record.directive),
      accepted_at: record.acceptedAt,
    });
    case "root_reconciler_reply": return encodeSimple(record, {
      reply_id: record.replyId,
      reply_write_id: record.replyWriteId,
      root_directive_id: record.rootDirectiveId,
      source_input_id: record.sourceInputId,
      source_comment_id: record.sourceCommentId,
      source_comment_version: record.sourceCommentVersion,
      target_issue_id: record.targetIssueId,
      disposition: record.disposition,
      reaction: record.reaction,
      thread_action: record.threadAction,
      materialized_outcome_refs: record.materializedOutcomeRefs.map(encodeEvidenceReference),
      rendered_schema_version: record.renderedSchemaVersion,
      replied_at: record.repliedAt,
    });
    case "delivery": return encodeSimple(record, { root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, verify_result_id: record.verifyResultId, verified_revision: record.verifiedRevision, delivery_kind: record.deliveryKind, delivery_branch: record.deliveryBranch, ...(record.pullRequest === undefined ? {} : { pull_request: record.pullRequest }), delivered_at: record.deliveredAt });
    case "workflow_timeline": return encodeSimple(record, { timeline_event_id: record.timelineEventId, timeline_kind: record.timelineKind, target_issue_id: record.targetIssueId, source_record_ids: record.sourceRecordIds, source_versions: record.sourceVersions, write_id: record.writeId, rendered_schema_version: record.renderedSchemaVersion, materialized_at: record.materializedAt });
    case "plan_contract": return encodePlanContract(record);
    case "stage_execution": return encodeStageExecution(record);
    case "stage_result": return encodeStageResult(record);
    case "human_action_request": return encodeSimple(record, { action_id: record.actionId, action_issue_id: record.actionIssueId, action_kind: record.actionKind, parent_scope: record.parentScope, root_issue_id: record.rootIssueId, ...(record.cycleIssueId === undefined ? {} : { cycle_issue_id: record.cycleIssueId }), related_issue_ids: record.relatedIssueIds, ...(record.sourceRootDirectiveId === undefined ? {} : { source_root_directive_id: record.sourceRootDirectiveId }), ...(record.sourceRootConvergenceRecordId === undefined ? {} : { source_root_convergence_record_id: record.sourceRootConvergenceRecordId }), ...(record.basedOnTreeDigest === undefined ? {} : { based_on_tree_digest: record.basedOnTreeDigest }), proposal_digest: record.proposalDigest, expected_parent_remote_version: record.expectedParentRemoteVersion, created_at: record.createdAt });
    case "human_action_resolution": return encodeSimple(record, { resolution_id: record.resolutionId, action_id: record.actionId, action_issue_id: record.actionIssueId, action_kind: record.actionKind, outcome: record.outcome, terminal_status: record.terminalStatus, terminal_remote_version: record.terminalRemoteVersion, source_comment_ids: record.sourceCommentIds, source_comment_versions: record.sourceCommentVersions, actor_kind: record.actorKind, proposal_digest: record.proposalDigest, resolved_at: record.resolvedAt });
    case "finding": return encodeSimple(record, { finding_id: record.findingId, source_verify_id: record.sourceVerifyId, category: record.category, severity: record.severity, evidence: record.evidence.map(encodeFindingEvidence), affected_scope: record.affectedScope.map(encodeAffectedScope), retryable: record.retryable, suggested_remediation: record.suggestedRemediation, acceptance_criteria: record.acceptanceCriteria.map(encodeCriterion) });
    case "finding_disposition": return encodeSimple(record, { finding_id: record.findingId, source_verify_id: record.sourceVerifyId, disposition: record.disposition, evidence: record.evidence.map(encodeFindingEvidence) });
    case "verify_result": return encodeSimple(record, { stage_execution_id: record.stageExecutionId, root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, node_issue_id: record.nodeIssueId, conclusion: record.conclusion, criteria_results: record.criteriaResults.map((criterion) => { recordFields(criterion, ["criterionKey", "outcome", "summary"]); return { criterion_key: criterion.criterionKey, outcome: criterion.outcome, summary: criterion.summary }; }), checks: record.checks.map(encodeCheck), verified_revision: record.verifiedRevision });
    case "progress_assessment": return encodeSimple(record, { root_issue_id: record.rootIssueId, previous_verify_id: record.previousVerifyId, current_verify_id: record.currentVerifyId, resolved_finding_ids: record.resolvedFindingIds, previous_passed_criterion_keys: record.previousPassedCriterionKeys, current_passed_criterion_keys: record.currentPassedCriterionKeys, previous_passed_check_keys: record.previousPassedCheckKeys, current_passed_check_keys: record.currentPassedCheckKeys, is_progress: record.isProgress });
    case "convergence": return encodeSimple(record, { root_issue_id: record.rootIssueId, observed_at: record.observedAt, policy: { max_cycles_per_root: record.policy.maxCyclesPerRoot, max_same_open_finding_cycles: record.policy.maxSameOpenFindingCycles, max_consecutive_no_progress: record.policy.maxConsecutiveNoProgress, max_total_tokens: record.policy.maxTotalTokens, deadline_at: record.policy.deadlineAt }, view: { cycle_count: record.view.cycleCount, open_finding_persistence: record.view.openFindingPersistence.map((entry) => { recordFields(entry, ["findingId", "openCycleCount"]); return { finding_id: entry.findingId, open_cycle_count: entry.openCycleCount }; }), consecutive_no_progress: record.view.consecutiveNoProgress, settled_tokens: record.view.settledTokens, open_token_reservations: record.view.openTokenReservations.map((entry) => { recordFields(entry, ["stageExecutionId", "reservedTotalTokens"]); return { stage_execution_id: entry.stageExecutionId, reserved_total_tokens: entry.reservedTotalTokens }; }), is_deadline_exceeded: record.view.isDeadlineExceeded, root_is_canceled: record.view.rootIsCanceled }, trigger: record.trigger, decision: record.decision });
  }
}

function encodeRootOwnership(record: RootOwnershipRecord): Record<string, unknown> { return encodeSimple(record, { root_issue_id: record.rootIssueId, conductor_id: record.conductorId, performer_profile_id: record.performerProfileId, delivery_branch: record.deliveryBranch, ...(record.pullRequest === undefined ? {} : { pull_request: record.pullRequest }), owner_generation: record.ownerGeneration }); }
function encodeRootDirective(record: RootDirective): Record<string, unknown> {
  const wire = snakeCaseKeys({ ...record, protocolVersion: "1" });
  try {
    decodeConductorPerformerRootDirective(wire as JsonValue);
  } catch {
    fail("managed_record_root_directive_invalid");
  }
  if (!isObject(wire)) fail("managed_record_root_directive_invalid");
  return wire;
}
function encodeStageExecution(record: StageExecutionRecord): Record<string, unknown> { return encodeSimple(record, { stage_execution_id: record.stageExecutionId, root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, node_issue_id: record.nodeIssueId, stage: record.stage, ...(record.planContractDigest === undefined ? {} : { plan_contract_digest: record.planContractDigest }), context_digest: record.contextDigest, source_manifest: record.sourceManifest.map(encodeSource), coverage: encodeCoverage(record.coverage), instruction_set_id: record.instructionSetId, execution_policy_id: record.executionPolicyId, limits: encodeLimits(record.limits), repository_revision: record.repositoryRevision, started_at: record.startedAt, deadline_at: record.deadlineAt }); }
function encodeStageResult(record: StageResultRecord): Record<string, unknown> { return encodeSimple(record, {
  result_id: record.resultId, root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, node_issue_id: record.nodeIssueId,
  stage: record.stage, role_session_id: record.roleSessionId, role_turn_id: record.roleTurnId, observed_tree_digest: record.observedTreeDigest,
  context_digest: record.contextDigest, outcome_kind: record.outcomeKind, summary: record.summary, source_manifest: record.sourceManifest,
  completed_at: record.completedAt, ...(record.planContractDigest === undefined ? {} : { plan_contract_digest: record.planContractDigest }),
  ...(record.planContract === undefined ? {} : { plan_contract: encodePlanContractProposal(record.planContract) }),
  ...(record.proposedWorkDag === undefined ? {} : { proposed_work_dag: encodePlanDag(record.proposedWorkDag) }),
  ...(record.risks === undefined ? {} : { risks: record.risks }),
  ...(record.requiredPermissions === undefined ? {} : { required_permissions: record.requiredPermissions }),
  ...(record.evidenceRefs === undefined ? {} : { evidence_refs: record.evidenceRefs.map(encodeEvidenceReference) }),
  ...(record.changedPaths === undefined ? {} : { changed_paths: record.changedPaths }), ...(record.commitRevision === undefined ? {} : { commit_revision: record.commitRevision }),
  ...(record.verifyConclusion === undefined ? {} : { verify_conclusion: record.verifyConclusion }), ...(record.verifiedRevision === undefined ? {} : { verified_revision: record.verifiedRevision }),
  ...(record.failureCode === undefined ? {} : { failure_code: record.failureCode }),
}); }
function encodePlanContract(record: PlanContract): Record<string, unknown> { return encodeSimple(record, {
  root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, plan_contract_digest: record.planContractDigest,
  ...encodePlanContractProposal({
    objective: record.objective,
    includedScope: record.includedScope,
    excludedScope: record.excludedScope,
    assumptions: record.assumptions,
    constraints: record.constraints,
    acceptanceCriteria: record.acceptanceCriteria,
    verificationRequirements: record.verificationRequirements,
  }),
  proposed_work_dag: encodePlanDag(record.proposedWorkDag),
}); }
function encodeCriterion(value: AcceptanceCriterion): Record<string, unknown> { recordFields(value, ["criterionKey", "statement", "verificationMethod"]); return { criterion_key: value.criterionKey, statement: value.statement, verification_method: value.verificationMethod }; }
function encodeCheck(value: CheckEvidence): Record<string, unknown> { recordFields(value, ["checkKey", "commandOrMethod", "outcome", "summary", "artifactRevision"]); return { check_key: value.checkKey, command_or_method: value.commandOrMethod, outcome: value.outcome, summary: value.summary, artifact_revision: value.artifactRevision }; }
function encodePlanContractProposal(value: PlanContractProposal): Record<string, unknown> { recordFields(value, ["objective", "includedScope", "excludedScope", "assumptions", "constraints", "acceptanceCriteria", "verificationRequirements"]); return { objective: value.objective, included_scope: value.includedScope, excluded_scope: value.excludedScope, assumptions: value.assumptions, constraints: value.constraints, acceptance_criteria: value.acceptanceCriteria.map(encodeCriterion), verification_requirements: value.verificationRequirements }; }
function encodePlanDag(value: import("../api/ManagedRecords.js").ProposedWorkDag): Record<string, unknown> { recordFields(value, ["workNodes", "dependencyEdges", "verifyNode"]); return { work_nodes: value.workNodes.map(encodePlanWorkNode), dependency_edges: value.dependencyEdges.map(encodePlanDependencyEdge), verify_node: encodePlanVerifyNode(value.verifyNode) }; }
function encodePlanWorkNode(value: PlanWorkNode): Record<string, unknown> { recordFields(value, ["proposalKey", "title", "description", "expectedOutcome", "requiredChecks", "dependencyProposalKeys"]); return { proposal_key: value.proposalKey, title: value.title, description: value.description, expected_outcome: value.expectedOutcome, required_checks: value.requiredChecks, dependency_proposal_keys: value.dependencyProposalKeys }; }
function encodePlanDependencyEdge(value: PlanDependencyEdge): Record<string, unknown> { recordFields(value, ["relationId", "relationKind", "sourceIssueId", "targetIssueId"]); return { relation_id: value.relationId, relation_kind: value.relationKind, source_issue_id: value.sourceIssueId, target_issue_id: value.targetIssueId }; }
function encodePlanVerifyNode(value: PlanVerifyNode): Record<string, unknown> { recordFields(value, ["title", "acceptanceCriteria", "requiredChecks"]); return { title: value.title, acceptance_criteria: value.acceptanceCriteria.map(encodeCriterion), required_checks: value.requiredChecks }; }
function encodeEvidenceReference(value: EvidenceReference): Record<string, unknown> { recordFields(value, ["referenceId", "sourceKind"]); return { reference_id: value.referenceId, source_kind: value.sourceKind }; }
function encodeSource(value: StageContextSource): Record<string, unknown> { recordFields(value, ["sourceKind", "sourceId", "versionOrDigest"]); return { source_kind: value.sourceKind, source_id: value.sourceId, version_or_digest: value.versionOrDigest }; }
function encodeCoverage(value: StageContextCoverage): Record<string, unknown> { recordFields(value, ["isComplete", "omissions"]); return { is_complete: value.isComplete, omissions: value.omissions.map((entry) => { recordFields(entry, ["sourceId", "reason"]); return { source_id: entry.sourceId, reason: entry.reason }; }) }; }
function encodeLimits(value: StageLimits): Record<string, unknown> { recordFields(value, ["maxContextBytes", "maxResultBytes", "maxWallTimeMs", "maxToolCalls", "maxCommandDurationMs", "reservedTotalTokens", "maxOutputTokens"]); return { max_context_bytes: value.maxContextBytes, max_result_bytes: value.maxResultBytes, max_wall_time_ms: value.maxWallTimeMs, max_tool_calls: value.maxToolCalls, max_command_duration_ms: value.maxCommandDurationMs, reserved_total_tokens: value.reservedTotalTokens, max_output_tokens: value.maxOutputTokens }; }
function encodeFindingEvidence(value: FindingEvidence): Record<string, unknown> { recordFields(value, ["evidenceId", "sourceKind", "sourceId", "summary", "artifactRevision"]); return { evidence_id: value.evidenceId, source_kind: value.sourceKind, source_id: value.sourceId, summary: value.summary, artifact_revision: value.artifactRevision }; }
function encodeAffectedScope(value: AffectedScope): Record<string, unknown> { recordFields(value, ["scopeKind", "identity"]); return { scope_kind: value.scopeKind, identity: value.identity }; }
function encodeSimple(record: { kind: string; version: 1 }, fieldsToEncode: Record<string, unknown>): Record<string, unknown> { return { kind: record.kind, version: 1, ...fieldsToEncode }; }

function recordObject(value: unknown): Record<string, unknown> { if (!isObject(value)) fail("managed_record_payload_invalid"); return value; }
function snakeCaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCaseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
    snakeCaseKeys(child),
  ]));
}
function camelCaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelCaseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
    camelCaseKeys(child),
  ]));
}
function recordFields(value: unknown, allowed: string[], optional: string[] = []): void { const object = recordObject(value); const allowedSet = new Set(allowed); const optionalSet = new Set(optional); for (const key of Object.keys(object)) if (!allowedSet.has(key)) fail(`managed_record_unknown_field:${key}`); for (const key of allowed) if (!optionalSet.has(key) && !(key in object)) fail(`managed_record_required_field:${key}`); }
function requiredObject(o: Record<string, unknown>, key: string): Record<string, unknown> { const value = o[key]; if (value === undefined) fail(`managed_record_required_field:${key}`); return recordObject(value); }
function fields(o: Record<string, unknown>, allowed: string[], optional: string[] = []): void { const allowedSet = new Set(allowed); for (const key of Object.keys(o)) if (!allowedSet.has(key)) fail(`managed_record_unknown_field:${key}`); const optionalSet = new Set(optional); for (const key of allowed) if (!optionalSet.has(key) && !(key in o)) fail(`managed_record_required_field:${key}`); }
function requiredString(o: Record<string, unknown>, key: string, identifier = false): string { const value = o[key]; if (typeof value !== "string") fail(`managed_record_required_field:${key}`); return identifier ? id(o, key) : value; }
function id(o: Record<string, unknown>, key: string): string { const value = o[key]; if (typeof value !== "string" || !identifierPattern.test(value)) fail(`managed_record_identifier_invalid:${key}`); return value; }
function opaque(o: Record<string, unknown>, key: string): string { const value = o[key]; if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\0\r\n]/u.test(value)) fail(`managed_record_opaque_invalid:${key}`); return value; }
function text(o: Record<string, unknown>, key: string): string { const value = o[key]; if (typeof value !== "string" || value.length === 0 || value.length > maxText || /[\0\r\n]/u.test(value)) fail("managed_record_bounded_text_invalid"); return value; }
function strings(o: Record<string, unknown>, key: string): string[] { const value = o[key]; if (!Array.isArray(value) || value.length > maxItems) fail(`managed_record_array_invalid:${key}`); return value.map((entry) => { if (typeof entry !== "string" || entry.length === 0 || entry.length > maxText || /[\0\r\n]/u.test(entry)) fail("managed_record_bounded_text_invalid"); return entry; }); }
function paths(o: Record<string, unknown>, key: string): string[] { const value = strings(o, key); return value.map((entry) => { if (entry.startsWith("/") || entry.split("/").some((part) => part === "..")) fail(`managed_record_path_invalid:${key}`); return entry; }); }
function ids(o: Record<string, unknown>, key: string): string[] { const value = o[key]; if (!Array.isArray(value) || value.length > maxItems) fail(`managed_record_array_invalid:${key}`); return value.map((entry) => { if (typeof entry !== "string" || !identifierPattern.test(entry)) fail(`managed_record_identifier_invalid:${key}`); return entry; }); }
function opaques(o: Record<string, unknown>, key: string): string[] { const value = o[key]; if (!Array.isArray(value) || value.length > maxItems) fail(`managed_record_array_invalid:${key}`); return value.map((entry) => { if (typeof entry !== "string" || entry.length === 0 || entry.length > 512 || /[\0\r\n]/u.test(entry)) fail(`managed_record_opaque_invalid:${key}`); return entry; }); }
function criteria(o: Record<string, unknown>, key: string): AcceptanceCriterion[] { return array(o, key, (value) => decodeCriterion(recordObject(value))); }
function array<T>(o: Record<string, unknown>, key: string, decode: (value: Record<string, unknown>) => T): T[] { const value = o[key]; if (!Array.isArray(value) || value.length > maxItems) fail(`managed_record_array_invalid:${key}`); return value.map((entry) => decode(recordObject(entry))); }
function bool(o: Record<string, unknown>, key: string): boolean { if (typeof o[key] !== "boolean") fail(`managed_record_boolean_invalid:${key}`); return o[key] as boolean; }
function integer(o: Record<string, unknown>, key: string): number { if (!Number.isSafeInteger(o[key]) || (o[key] as number) < 0) fail(`managed_record_integer_invalid:${key}`); return o[key] as number; }
function positiveInteger(o: Record<string, unknown>, key: string): number { const value = integer(o, key); if (value < 1) fail(`managed_record_integer_invalid:${key}`); return value; }
function enumValue<T extends string>(o: Record<string, unknown>, key: string, values: readonly T[]): T { const value = o[key]; if (typeof value !== "string" || !values.includes(value as T)) fail(`managed_record_enum_invalid:${key}`); return value as T; }
function stageValue(o: Record<string, unknown>, key: string): "plan" | "work" | "verify" { return enumValue(o, key, ["plan", "work", "verify"]); }
function timestamp(o: Record<string, unknown>, key: string): string { const value = o[key]; if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) fail(`managed_record_timestamp_invalid:${key}`); return value; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fail(code: string): never { throw new InvalidRecord(code); }
