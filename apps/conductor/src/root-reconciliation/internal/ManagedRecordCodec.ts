import type {
  AcceptanceCriterion,
  AffectedScope,
  CheckEvidence,
  ConvergenceRecord,
  CycleMarker,
  DeliveryRecord,
  FindingDispositionRecord,
  FindingEvidence,
  FindingRecord,
  HumanActionRecord,
  ManagedRecord,
  NodeMarker,
  PlanContract,
  ProgressAssessment,
  RootOwnershipRecord,
  StageContextCoverage,
  StageContextSource,
  StageExecutionRecord,
  StageLimits,
  StageTerminalRecord,
  StageUsage,
  VerifyNodeContract,
  VerifyResultRecord,
  WorkNodeContract,
  WorkCompletionRecord,
} from "../api/ManagedRecords.js";

const marker = "<!-- symphony managed-record\n";
const endMarker = "\n-->";
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
    if (!source.startsWith(marker) || !source.endsWith(endMarker)) fail("managed_record_marker_invalid");
    const json = source.slice(marker.length, -endMarker.length);
    if (!json || json.includes("\n")) fail("managed_record_marker_invalid");
    const payload: unknown = JSON.parse(json);
    return { ok: true, value: decodeRecord(payload) };
  } catch (error) {
    return { ok: false, error: error instanceof InvalidRecord ? error.code : "managed_record_payload_invalid" };
  }
}

export function serializeManagedRecord(record: unknown): string {
  try {
    const payload = encodeRecord(record);
    const decoded = decodeRecord(payload);
    if (decoded.kind !== (record as { kind?: unknown }).kind) fail("managed_record_kind_invalid");
    return `${marker}${JSON.stringify(payload)}${endMarker}`;
  } catch (error) {
    if (error instanceof InvalidRecord) throw new Error(error.code);
    throw new Error("managed_record_payload_invalid");
  }
}

function decodeRecord(value: unknown): ManagedRecord {
  const object = recordObject(value);
  const kind = requiredString(object, "kind", true);
  if (object.version !== 1) fail(object.version === undefined ? "managed_record_required_field:version" : "managed_record_version_invalid");
  switch (kind) {
    case "root_ownership": return decodeRootOwnership(object);
    case "delivery": return decodeDelivery(object);
    case "cycle_marker": return decodeCycleMarker(object);
    case "node_marker": return decodeNodeMarker(object);
    case "plan_contract": return decodePlanContract(object);
    case "stage_execution": return decodeStageExecution(object);
    case "stage_terminal": return decodeStageTerminal(object);
    case "work_completion": return decodeWorkCompletion(object);
    case "human_action": return decodeHumanAction(object);
    case "finding": return decodeFinding(object);
    case "finding_disposition": return decodeFindingDisposition(object);
    case "verify_result": return decodeVerifyResult(object);
    case "progress_assessment": return decodeProgressAssessment(object);
    case "convergence": return decodeConvergence(object);
    default: fail("managed_record_kind_invalid");
  }
}

function decodeRootOwnership(o: Record<string, unknown>): RootOwnershipRecord {
  fields(o, ["kind", "version", "root_issue_id", "conductor_id", "performer_profile_id", "delivery_branch", "pull_request", "owner_generation"], ["pull_request"]);
  return {
    kind: "root_ownership", version: 1, rootIssueId: id(o, "root_issue_id"), conductorId: id(o, "conductor_id"),
    performerProfileId: id(o, "performer_profile_id"), deliveryBranch: text(o, "delivery_branch"),
    ...(o.pull_request === undefined ? {} : { pullRequest: text(o, "pull_request") }), ownerGeneration: id(o, "owner_generation"),
  };
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

function decodeCycleMarker(o: Record<string, unknown>): CycleMarker {
  fields(o, ["kind", "version", "root_issue_id", "cycle_key", "trigger", "baseline_revision", "predecessor_cycle_issue_id", "repair_group_id", "finding_ids", "predecessor_plan_contract_digest", "predecessor_verify_result_id", "predecessor_verified_revision"], ["predecessor_cycle_issue_id", "repair_group_id", "finding_ids", "predecessor_plan_contract_digest", "predecessor_verify_result_id", "predecessor_verified_revision"]);
  return {
    kind: "cycle_marker", version: 1, rootIssueId: id(o, "root_issue_id"), cycleKey: id(o, "cycle_key"), trigger: enumValue(o, "trigger", ["initial", "verify_changes", "review_changes"]), baselineRevision: id(o, "baseline_revision"),
    ...(o.predecessor_cycle_issue_id === undefined ? {} : { predecessorCycleIssueId: id(o, "predecessor_cycle_issue_id") }),
    ...(o.repair_group_id === undefined ? {} : { repairGroupId: id(o, "repair_group_id") }),
    ...(o.finding_ids === undefined ? {} : { findingIds: ids(o, "finding_ids") }),
    ...(o.predecessor_plan_contract_digest === undefined ? {} : { predecessorPlanContractDigest: id(o, "predecessor_plan_contract_digest") }),
    ...(o.predecessor_verify_result_id === undefined ? {} : { predecessorVerifyResultId: id(o, "predecessor_verify_result_id") }),
    ...(o.predecessor_verified_revision === undefined ? {} : { predecessorVerifiedRevision: id(o, "predecessor_verified_revision") }),
  };
}

function decodeNodeMarker(o: Record<string, unknown>): NodeMarker {
  fields(o, ["kind", "version", "root_issue_id", "cycle_issue_id", "node_key", "node_kind", "plan_contract_digest"]);
  return { kind: "node_marker", version: 1, rootIssueId: id(o, "root_issue_id"), cycleIssueId: id(o, "cycle_issue_id"), nodeKey: id(o, "node_key"), nodeKind: enumValue(o, "node_kind", ["plan", "work", "verify"]), planContractDigest: id(o, "plan_contract_digest") };
}

function decodePlanContract(o: Record<string, unknown>): PlanContract {
  fields(o, ["kind", "version", "root_issue_id", "cycle_issue_id", "plan_contract_digest", "objective_summary", "included_scope", "excluded_scope", "acceptance_criteria", "work_nodes", "verify_node"]);
  return {
    kind: "plan_contract", version: 1, rootIssueId: id(o, "root_issue_id"), cycleIssueId: id(o, "cycle_issue_id"), planContractDigest: id(o, "plan_contract_digest"),
    objectiveSummary: text(o, "objective_summary"), includedScope: strings(o, "included_scope"), excludedScope: strings(o, "excluded_scope"),
    acceptanceCriteria: criteria(o, "acceptance_criteria"), workNodes: array(o, "work_nodes", decodeWorkNode), verifyNode: decodeVerifyNode(requiredObject(o, "verify_node")),
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

function decodeStageTerminal(o: Record<string, unknown>): StageTerminalRecord {
  fields(o, ["kind", "version", "stage_execution_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "stage", "context_digest", "outcome", "completed_at", "summary", "usage", "failure_code"], ["failure_code"]);
  const outcome = enumValue(o, "outcome", ["completed", "failed", "canceled", "suspended"]);
  if (outcome === "failed" && o.failure_code === undefined) fail("managed_record_required_field:failure_code");
  if (outcome !== "failed" && o.failure_code !== undefined) fail("managed_record_stage_field_invalid:failure_code");
  return { kind: "stage_terminal", version: 1, stageExecutionId: id(o, "stage_execution_id"), rootIssueId: id(o, "root_issue_id"), cycleIssueId: id(o, "cycle_issue_id"), nodeIssueId: id(o, "node_issue_id"), stage: stageValue(o, "stage"), contextDigest: id(o, "context_digest"), outcome, completedAt: timestamp(o, "completed_at"), summary: text(o, "summary"), usage: decodeUsage(requiredObject(o, "usage")), ...(o.failure_code === undefined ? {} : { failureCode: id(o, "failure_code") }) };
}

function decodeWorkCompletion(o: Record<string, unknown>): WorkCompletionRecord {
  fields(o, ["kind", "version", "stage_execution_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "work_key", "context_digest", "summary", "changed_paths", "checks", "commit_revision"]);
  return {
    kind: "work_completion", version: 1, stageExecutionId: id(o, "stage_execution_id"), rootIssueId: id(o, "root_issue_id"), cycleIssueId: id(o, "cycle_issue_id"), nodeIssueId: id(o, "node_issue_id"), workKey: id(o, "work_key"), contextDigest: id(o, "context_digest"), summary: text(o, "summary"), changedPaths: paths(o, "changed_paths"), checks: array(o, "checks", decodeCheck), commitRevision: id(o, "commit_revision"),
  };
}

function decodeHumanAction(o: Record<string, unknown>): HumanActionRecord {
  fields(o, ["kind", "version", "action_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "request_kind", "question_or_proposal", "reason", "impact", "context_digest", "expected_root_remote_version"]);
  return { kind: "human_action", version: 1, actionId: id(o, "action_id"), rootIssueId: id(o, "root_issue_id"), cycleIssueId: id(o, "cycle_issue_id"), nodeIssueId: id(o, "node_issue_id"), requestKind: enumValue(o, "request_kind", ["needs_info", "needs_approval"]), questionOrProposal: text(o, "question_or_proposal"), reason: text(o, "reason"), impact: text(o, "impact"), contextDigest: id(o, "context_digest"), expectedRootRemoteVersion: id(o, "expected_root_remote_version") };
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
function decodeUsage(o: Record<string, unknown>): StageUsage { fields(o, ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]); return { inputTokens: integer(o, "input_tokens"), cachedInputTokens: integer(o, "cached_input_tokens"), outputTokens: integer(o, "output_tokens"), reasoningOutputTokens: integer(o, "reasoning_output_tokens"), totalTokens: integer(o, "total_tokens") }; }
function decodeFindingEvidence(o: Record<string, unknown>): FindingEvidence { fields(o, ["evidence_id", "source_kind", "source_id", "summary", "artifact_revision"]); return { evidenceId: id(o, "evidence_id"), sourceKind: enumValue(o, "source_kind", ["criterion", "check", "diff", "file", "log", "human_input"]), sourceId: id(o, "source_id"), summary: text(o, "summary"), artifactRevision: id(o, "artifact_revision") }; }
function decodeAffectedScope(o: Record<string, unknown>): AffectedScope { fields(o, ["scope_kind", "identity"]); return { scopeKind: enumValue(o, "scope_kind", ["repository_path", "criterion", "component", "workflow_boundary"]), identity: text(o, "identity") }; }
function decodeWorkNode(o: Record<string, unknown>): WorkNodeContract { fields(o, ["work_key", "title", "description", "acceptance_criteria", "dependency_work_keys"]); return { workKey: id(o, "work_key"), title: text(o, "title"), description: text(o, "description"), acceptanceCriteria: criteria(o, "acceptance_criteria"), dependencyWorkKeys: ids(o, "dependency_work_keys") }; }
function decodeVerifyNode(o: Record<string, unknown>): VerifyNodeContract { fields(o, ["title", "acceptance_criteria", "required_checks"]); return { title: text(o, "title"), acceptanceCriteria: criteria(o, "acceptance_criteria"), requiredChecks: array(o, "required_checks", decodeCheck) }; }

function encodeRecord(value: unknown): Record<string, unknown> {
  if (!isObject(value) || typeof value.kind !== "string") fail("managed_record_kind_invalid");
  const record = value as unknown as ManagedRecord;
  const topFields: Record<ManagedRecord["kind"], { allowed: string[]; optional?: string[] }> = {
    root_ownership: { allowed: ["kind", "version", "rootIssueId", "conductorId", "performerProfileId", "deliveryBranch", "pullRequest", "ownerGeneration"], optional: ["pullRequest"] },
    delivery: { allowed: ["kind", "version", "rootIssueId", "cycleIssueId", "verifyResultId", "verifiedRevision", "deliveryKind", "deliveryBranch", "pullRequest", "deliveredAt"], optional: ["pullRequest"] },
    cycle_marker: { allowed: ["kind", "version", "rootIssueId", "cycleKey", "trigger", "baselineRevision", "predecessorCycleIssueId", "repairGroupId", "findingIds", "predecessorPlanContractDigest", "predecessorVerifyResultId", "predecessorVerifiedRevision"], optional: ["predecessorCycleIssueId", "repairGroupId", "findingIds", "predecessorPlanContractDigest", "predecessorVerifyResultId", "predecessorVerifiedRevision"] },
    node_marker: { allowed: ["kind", "version", "rootIssueId", "cycleIssueId", "nodeKey", "nodeKind", "planContractDigest"] },
    plan_contract: { allowed: ["kind", "version", "rootIssueId", "cycleIssueId", "planContractDigest", "objectiveSummary", "includedScope", "excludedScope", "acceptanceCriteria", "workNodes", "verifyNode"] },
    stage_execution: { allowed: ["kind", "version", "stageExecutionId", "rootIssueId", "cycleIssueId", "nodeIssueId", "stage", "planContractDigest", "contextDigest", "sourceManifest", "coverage", "instructionSetId", "executionPolicyId", "limits", "repositoryRevision", "startedAt", "deadlineAt"], optional: ["planContractDigest"] },
    stage_terminal: { allowed: ["kind", "version", "stageExecutionId", "rootIssueId", "cycleIssueId", "nodeIssueId", "stage", "contextDigest", "outcome", "completedAt", "summary", "usage", "failureCode"], optional: ["failureCode"] },
    work_completion: { allowed: ["kind", "version", "stageExecutionId", "rootIssueId", "cycleIssueId", "nodeIssueId", "workKey", "contextDigest", "summary", "changedPaths", "checks", "commitRevision"] },
    human_action: { allowed: ["kind", "version", "actionId", "rootIssueId", "cycleIssueId", "nodeIssueId", "requestKind", "questionOrProposal", "reason", "impact", "contextDigest", "expectedRootRemoteVersion"] },
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
    case "delivery": return encodeSimple(record, { root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, verify_result_id: record.verifyResultId, verified_revision: record.verifiedRevision, delivery_kind: record.deliveryKind, delivery_branch: record.deliveryBranch, ...(record.pullRequest === undefined ? {} : { pull_request: record.pullRequest }), delivered_at: record.deliveredAt });
    case "cycle_marker": return encodeSimple(record, { root_issue_id: record.rootIssueId, cycle_key: record.cycleKey, trigger: record.trigger, baseline_revision: record.baselineRevision, ...(record.predecessorCycleIssueId === undefined ? {} : { predecessor_cycle_issue_id: record.predecessorCycleIssueId }), ...(record.repairGroupId === undefined ? {} : { repair_group_id: record.repairGroupId }), ...(record.findingIds === undefined ? {} : { finding_ids: record.findingIds }), ...(record.predecessorPlanContractDigest === undefined ? {} : { predecessor_plan_contract_digest: record.predecessorPlanContractDigest }), ...(record.predecessorVerifyResultId === undefined ? {} : { predecessor_verify_result_id: record.predecessorVerifyResultId }), ...(record.predecessorVerifiedRevision === undefined ? {} : { predecessor_verified_revision: record.predecessorVerifiedRevision }) });
    case "node_marker": return encodeSimple(record, { root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, node_key: record.nodeKey, node_kind: record.nodeKind, plan_contract_digest: record.planContractDigest });
    case "plan_contract": return encodeSimple(record, { root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, plan_contract_digest: record.planContractDigest, objective_summary: record.objectiveSummary, included_scope: record.includedScope, excluded_scope: record.excludedScope, acceptance_criteria: record.acceptanceCriteria.map(encodeCriterion), work_nodes: record.workNodes.map(encodeWorkNode), verify_node: encodeVerifyNode(record.verifyNode) });
    case "stage_execution": return encodeStageExecution(record);
    case "stage_terminal": return encodeStageTerminal(record);
    case "work_completion": return encodeWorkCompletion(record);
    case "human_action": return encodeSimple(record, { action_id: record.actionId, root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, node_issue_id: record.nodeIssueId, request_kind: record.requestKind, question_or_proposal: record.questionOrProposal, reason: record.reason, impact: record.impact, context_digest: record.contextDigest, expected_root_remote_version: record.expectedRootRemoteVersion });
    case "finding": return encodeSimple(record, { finding_id: record.findingId, source_verify_id: record.sourceVerifyId, category: record.category, severity: record.severity, evidence: record.evidence.map(encodeFindingEvidence), affected_scope: record.affectedScope.map(encodeAffectedScope), retryable: record.retryable, suggested_remediation: record.suggestedRemediation, acceptance_criteria: record.acceptanceCriteria.map(encodeCriterion) });
    case "finding_disposition": return encodeSimple(record, { finding_id: record.findingId, source_verify_id: record.sourceVerifyId, disposition: record.disposition, evidence: record.evidence.map(encodeFindingEvidence) });
    case "verify_result": return encodeSimple(record, { stage_execution_id: record.stageExecutionId, root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, node_issue_id: record.nodeIssueId, conclusion: record.conclusion, criteria_results: record.criteriaResults.map((criterion) => { recordFields(criterion, ["criterionKey", "outcome", "summary"]); return { criterion_key: criterion.criterionKey, outcome: criterion.outcome, summary: criterion.summary }; }), checks: record.checks.map(encodeCheck), verified_revision: record.verifiedRevision });
    case "progress_assessment": return encodeSimple(record, { root_issue_id: record.rootIssueId, previous_verify_id: record.previousVerifyId, current_verify_id: record.currentVerifyId, resolved_finding_ids: record.resolvedFindingIds, previous_passed_criterion_keys: record.previousPassedCriterionKeys, current_passed_criterion_keys: record.currentPassedCriterionKeys, previous_passed_check_keys: record.previousPassedCheckKeys, current_passed_check_keys: record.currentPassedCheckKeys, is_progress: record.isProgress });
    case "convergence": return encodeSimple(record, { root_issue_id: record.rootIssueId, observed_at: record.observedAt, policy: { max_cycles_per_root: record.policy.maxCyclesPerRoot, max_same_open_finding_cycles: record.policy.maxSameOpenFindingCycles, max_consecutive_no_progress: record.policy.maxConsecutiveNoProgress, max_total_tokens: record.policy.maxTotalTokens, deadline_at: record.policy.deadlineAt }, view: { cycle_count: record.view.cycleCount, open_finding_persistence: record.view.openFindingPersistence.map((entry) => { recordFields(entry, ["findingId", "openCycleCount"]); return { finding_id: entry.findingId, open_cycle_count: entry.openCycleCount }; }), consecutive_no_progress: record.view.consecutiveNoProgress, settled_tokens: record.view.settledTokens, open_token_reservations: record.view.openTokenReservations.map((entry) => { recordFields(entry, ["stageExecutionId", "reservedTotalTokens"]); return { stage_execution_id: entry.stageExecutionId, reserved_total_tokens: entry.reservedTotalTokens }; }), is_deadline_exceeded: record.view.isDeadlineExceeded, root_is_canceled: record.view.rootIsCanceled }, trigger: record.trigger, decision: record.decision });
  }
}

function encodeRootOwnership(record: RootOwnershipRecord): Record<string, unknown> { return encodeSimple(record, { root_issue_id: record.rootIssueId, conductor_id: record.conductorId, performer_profile_id: record.performerProfileId, delivery_branch: record.deliveryBranch, ...(record.pullRequest === undefined ? {} : { pull_request: record.pullRequest }), owner_generation: record.ownerGeneration }); }
function encodeStageExecution(record: StageExecutionRecord): Record<string, unknown> { return encodeSimple(record, { stage_execution_id: record.stageExecutionId, root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, node_issue_id: record.nodeIssueId, stage: record.stage, ...(record.planContractDigest === undefined ? {} : { plan_contract_digest: record.planContractDigest }), context_digest: record.contextDigest, source_manifest: record.sourceManifest.map(encodeSource), coverage: encodeCoverage(record.coverage), instruction_set_id: record.instructionSetId, execution_policy_id: record.executionPolicyId, limits: encodeLimits(record.limits), repository_revision: record.repositoryRevision, started_at: record.startedAt, deadline_at: record.deadlineAt }); }
function encodeStageTerminal(record: StageTerminalRecord): Record<string, unknown> { return encodeSimple(record, { stage_execution_id: record.stageExecutionId, root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, node_issue_id: record.nodeIssueId, stage: record.stage, context_digest: record.contextDigest, outcome: record.outcome, completed_at: record.completedAt, summary: record.summary, usage: encodeUsage(record.usage), ...(record.failureCode === undefined ? {} : { failure_code: record.failureCode }) }); }
function encodeWorkCompletion(record: WorkCompletionRecord): Record<string, unknown> { return encodeSimple(record, { stage_execution_id: record.stageExecutionId, root_issue_id: record.rootIssueId, cycle_issue_id: record.cycleIssueId, node_issue_id: record.nodeIssueId, work_key: record.workKey, context_digest: record.contextDigest, summary: record.summary, changed_paths: record.changedPaths, checks: record.checks.map(encodeCheck), commit_revision: record.commitRevision }); }
function encodeCriterion(value: AcceptanceCriterion): Record<string, unknown> { recordFields(value, ["criterionKey", "statement", "verificationMethod"]); return { criterion_key: value.criterionKey, statement: value.statement, verification_method: value.verificationMethod }; }
function encodeCheck(value: CheckEvidence): Record<string, unknown> { recordFields(value, ["checkKey", "commandOrMethod", "outcome", "summary", "artifactRevision"]); return { check_key: value.checkKey, command_or_method: value.commandOrMethod, outcome: value.outcome, summary: value.summary, artifact_revision: value.artifactRevision }; }
function encodeSource(value: StageContextSource): Record<string, unknown> { recordFields(value, ["sourceKind", "sourceId", "versionOrDigest"]); return { source_kind: value.sourceKind, source_id: value.sourceId, version_or_digest: value.versionOrDigest }; }
function encodeCoverage(value: StageContextCoverage): Record<string, unknown> { recordFields(value, ["isComplete", "omissions"]); return { is_complete: value.isComplete, omissions: value.omissions.map((entry) => { recordFields(entry, ["sourceId", "reason"]); return { source_id: entry.sourceId, reason: entry.reason }; }) }; }
function encodeLimits(value: StageLimits): Record<string, unknown> { recordFields(value, ["maxContextBytes", "maxResultBytes", "maxWallTimeMs", "maxToolCalls", "maxCommandDurationMs", "reservedTotalTokens", "maxOutputTokens"]); return { max_context_bytes: value.maxContextBytes, max_result_bytes: value.maxResultBytes, max_wall_time_ms: value.maxWallTimeMs, max_tool_calls: value.maxToolCalls, max_command_duration_ms: value.maxCommandDurationMs, reserved_total_tokens: value.reservedTotalTokens, max_output_tokens: value.maxOutputTokens }; }
function encodeUsage(value: StageUsage): Record<string, unknown> { recordFields(value, ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]); return { input_tokens: value.inputTokens, cached_input_tokens: value.cachedInputTokens, output_tokens: value.outputTokens, reasoning_output_tokens: value.reasoningOutputTokens, total_tokens: value.totalTokens }; }
function encodeFindingEvidence(value: FindingEvidence): Record<string, unknown> { recordFields(value, ["evidenceId", "sourceKind", "sourceId", "summary", "artifactRevision"]); return { evidence_id: value.evidenceId, source_kind: value.sourceKind, source_id: value.sourceId, summary: value.summary, artifact_revision: value.artifactRevision }; }
function encodeAffectedScope(value: AffectedScope): Record<string, unknown> { recordFields(value, ["scopeKind", "identity"]); return { scope_kind: value.scopeKind, identity: value.identity }; }
function encodeWorkNode(value: WorkNodeContract): Record<string, unknown> { recordFields(value, ["workKey", "title", "description", "acceptanceCriteria", "dependencyWorkKeys"]); return { work_key: value.workKey, title: value.title, description: value.description, acceptance_criteria: value.acceptanceCriteria.map(encodeCriterion), dependency_work_keys: value.dependencyWorkKeys }; }
function encodeVerifyNode(value: VerifyNodeContract): Record<string, unknown> { recordFields(value, ["title", "acceptanceCriteria", "requiredChecks"]); return { title: value.title, acceptance_criteria: value.acceptanceCriteria.map(encodeCriterion), required_checks: value.requiredChecks.map(encodeCheck) }; }
function encodeSimple(record: { kind: string; version: 1 }, fieldsToEncode: Record<string, unknown>): Record<string, unknown> { return { kind: record.kind, version: 1, ...fieldsToEncode }; }

function recordObject(value: unknown): Record<string, unknown> { if (!isObject(value)) fail("managed_record_payload_invalid"); return value; }
function recordFields(value: unknown, allowed: string[], optional: string[] = []): void { const object = recordObject(value); const allowedSet = new Set(allowed); const optionalSet = new Set(optional); for (const key of Object.keys(object)) if (!allowedSet.has(key)) fail(`managed_record_unknown_field:${key}`); for (const key of allowed) if (!optionalSet.has(key) && !(key in object)) fail(`managed_record_required_field:${key}`); }
function requiredObject(o: Record<string, unknown>, key: string): Record<string, unknown> { const value = o[key]; if (value === undefined) fail(`managed_record_required_field:${key}`); return recordObject(value); }
function fields(o: Record<string, unknown>, allowed: string[], optional: string[] = []): void { const allowedSet = new Set(allowed); for (const key of Object.keys(o)) if (!allowedSet.has(key)) fail(`managed_record_unknown_field:${key}`); const optionalSet = new Set(optional); for (const key of allowed) if (!optionalSet.has(key) && !(key in o)) fail(`managed_record_required_field:${key}`); }
function requiredString(o: Record<string, unknown>, key: string, identifier = false): string { const value = o[key]; if (typeof value !== "string") fail(`managed_record_required_field:${key}`); return identifier ? id(o, key) : value; }
function id(o: Record<string, unknown>, key: string): string { const value = o[key]; if (typeof value !== "string" || !identifierPattern.test(value)) fail(`managed_record_identifier_invalid:${key}`); return value; }
function text(o: Record<string, unknown>, key: string): string { const value = o[key]; if (typeof value !== "string" || value.length === 0 || value.length > maxText || /[\0\r\n]/u.test(value)) fail("managed_record_bounded_text_invalid"); return value; }
function strings(o: Record<string, unknown>, key: string): string[] { const value = o[key]; if (!Array.isArray(value) || value.length > maxItems) fail(`managed_record_array_invalid:${key}`); return value.map((entry) => { if (typeof entry !== "string" || entry.length === 0 || entry.length > maxText || /[\0\r\n]/u.test(entry)) fail("managed_record_bounded_text_invalid"); return entry; }); }
function paths(o: Record<string, unknown>, key: string): string[] { const value = strings(o, key); return value.map((entry) => { if (entry.startsWith("/") || entry.split("/").some((part) => part === "..")) fail(`managed_record_path_invalid:${key}`); return entry; }); }
function ids(o: Record<string, unknown>, key: string): string[] { const value = o[key]; if (!Array.isArray(value) || value.length > maxItems) fail(`managed_record_array_invalid:${key}`); return value.map((entry) => { if (typeof entry !== "string" || !identifierPattern.test(entry)) fail(`managed_record_identifier_invalid:${key}`); return entry; }); }
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
