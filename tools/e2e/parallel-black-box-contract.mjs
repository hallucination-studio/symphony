const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const IDENTIFIER = /^[a-z][a-z0-9_-]{2,120}$/u;
const CONDUCTOR_HASH = /^[a-z0-9][a-z0-9-]{2,120}$/u;
const HUMAN_SCRIPT_REGISTRY = registry([
  "approve_plan",
  "reject_plan",
  "revise_root",
  "restart_conductor",
  "exhaust_cycle_budget",
  "deliver_and_review",
  "required_write_outage",
  "preempt_same_priority",
]);
const EVIDENCE_PREDICATE_REGISTRY = registry([
  "happy_path",
  "plan_rejection_supersession",
  "root_revision_comment",
  "restart_isolation",
  "cycle_successor",
  "delivery_review",
  "required_write_fail_closed",
  "same_conductor_preemption",
]);
const CASE_STATUSES = new Set(["passed", "failed", "incomplete"]);

export function assertParallelBlackBoxE2ECampaignCommand(value) {
  const command = record(value, "parallel_black_box_campaign_command_invalid");
  assertExactKeys(command, [
    "version",
    "campaign_id",
    "project_id",
    "started_at",
    "deadline_at",
    "conductors",
    "cases",
  ], "parallel_black_box_campaign_command_invalid");
  if (command.version !== 1) throw stableError("parallel_black_box_campaign_version_invalid");
  assertIdentifier(command.campaign_id, "parallel_black_box_campaign_command_invalid");
  assertIdentifier(command.project_id, "parallel_black_box_campaign_command_invalid");
  assertTimestamp(command.started_at, "parallel_black_box_campaign_command_invalid");
  assertTimestamp(command.deadline_at, "parallel_black_box_campaign_command_invalid");
  if (Date.parse(command.deadline_at) <= Date.parse(command.started_at)) {
    throw stableError("parallel_black_box_campaign_command_invalid");
  }
  if (!Array.isArray(command.conductors) || command.conductors.length < 3) {
    throw stableError("parallel_black_box_campaign_conductors_invalid");
  }
  const conductorIds = new Set();
  const bindingIds = new Set();
  const shortHashes = new Set();
  const repositories = new Set();
  for (const conductor of command.conductors) {
    assertConductor(conductor);
    if (conductorIds.has(conductor.conductor_id) || bindingIds.has(conductor.binding_id) ||
        shortHashes.has(conductor.conductor_short_hash) || repositories.has(conductor.repository_identity)) {
      throw stableError("parallel_black_box_campaign_conductors_invalid");
    }
    conductorIds.add(conductor.conductor_id);
    bindingIds.add(conductor.binding_id);
    shortHashes.add(conductor.conductor_short_hash);
    repositories.add(conductor.repository_identity);
  }
  if (!Array.isArray(command.cases) || command.cases.length === 0) {
    throw stableError("parallel_black_box_campaign_cases_invalid");
  }
  const caseIds = new Set();
  const startedAt = Date.parse(command.started_at);
  const campaignDeadlineAt = Date.parse(command.deadline_at);
  for (const e2eCase of command.cases) {
    assertCase(e2eCase, conductorIds, { startedAt, campaignDeadlineAt });
    if (caseIds.has(e2eCase.case_id)) throw stableError("parallel_black_box_campaign_case_invalid");
    caseIds.add(e2eCase.case_id);
  }
  return freezeCommand(command);
}

export function assertParallelBlackBoxE2ECampaignResult(value) {
  const result = record(value, "parallel_black_box_campaign_result_invalid");
  assertExactKeys(result, [
    "version",
    "campaign_id",
    "cases",
    "durable_overlap_evidence_refs",
  ], "parallel_black_box_campaign_result_invalid");
  if (result.version !== 1 || !identifier(result.campaign_id) || !Array.isArray(result.cases) ||
      !Array.isArray(result.durable_overlap_evidence_refs)) {
    throw stableError("parallel_black_box_campaign_result_invalid");
  }
  const caseIds = new Set();
  for (const e2eCase of result.cases) {
    const entry = record(e2eCase, "parallel_black_box_campaign_result_invalid");
    assertExactKeys(entry, ["case_id", "status", "reason_code", "evidence_refs", "observed_at"],
      "parallel_black_box_campaign_result_invalid");
    if (!identifier(entry.case_id) || !CASE_STATUSES.has(entry.status) || !identifier(entry.reason_code) ||
        !Array.isArray(entry.evidence_refs) || caseIds.has(entry.case_id)) {
      throw stableError("parallel_black_box_campaign_result_invalid");
    }
    assertTimestamp(entry.observed_at, "parallel_black_box_campaign_result_invalid");
    assertEvidenceReferences(entry.evidence_refs, "parallel_black_box_campaign_result_invalid");
    caseIds.add(entry.case_id);
  }
  assertEvidenceReferences(result.durable_overlap_evidence_refs, "parallel_black_box_campaign_result_invalid");
  return Object.freeze({
    version: 1,
    campaign_id: result.campaign_id,
    cases: Object.freeze(result.cases.map((entry) => Object.freeze({
      case_id: entry.case_id,
      status: entry.status,
      reason_code: entry.reason_code,
      evidence_refs: Object.freeze([...entry.evidence_refs]),
      observed_at: entry.observed_at,
    }))),
    durable_overlap_evidence_refs: Object.freeze([...result.durable_overlap_evidence_refs]),
  });
}

export function getParallelBlackBoxE2ECampaignExitCode(commandValue, resultValue) {
  const command = assertParallelBlackBoxE2ECampaignCommand(commandValue);
  const result = assertParallelBlackBoxE2ECampaignResult(resultValue);
  if (result.campaign_id !== command.campaign_id || result.cases.length !== command.cases.length) {
    throw stableError("parallel_black_box_campaign_exit_code_invalid");
  }
  const verdictsByCaseId = new Map(result.cases.map((entry) => [entry.case_id, entry]));
  for (const e2eCase of command.cases) {
    if (!verdictsByCaseId.has(e2eCase.case_id)) throw stableError("parallel_black_box_campaign_exit_code_invalid");
  }
  return command.cases.some((e2eCase) => e2eCase.mandatory && verdictsByCaseId.get(e2eCase.case_id).status !== "passed")
    ? 1
    : 0;
}

export function isKnownHumanScriptId(value) {
  return resolveHumanScript(value) !== null;
}

export function isKnownEvidencePredicateId(value) {
  return resolveEvidencePredicate(value) !== null;
}

export function resolveHumanScript(value) {
  return typeof value === "string" ? HUMAN_SCRIPT_REGISTRY[value] ?? null : null;
}

export function resolveEvidencePredicate(value) {
  return typeof value === "string" ? EVIDENCE_PREDICATE_REGISTRY[value] ?? null : null;
}

function assertConductor(value) {
  const conductor = record(value, "parallel_black_box_campaign_conductors_invalid");
  assertExactKeys(conductor, ["binding_id", "conductor_id", "conductor_short_hash", "repository_identity"],
    "parallel_black_box_campaign_conductors_invalid");
  if (!identifier(conductor.binding_id) || !identifier(conductor.conductor_id) ||
      !CONDUCTOR_HASH.test(conductor.conductor_short_hash) || !identifier(conductor.repository_identity)) {
    throw stableError("parallel_black_box_campaign_conductors_invalid");
  }
}

function assertCase(value, conductorIds, { startedAt, campaignDeadlineAt }) {
  const e2eCase = record(value, "parallel_black_box_campaign_case_invalid");
  assertExactKeys(e2eCase, [
    "case_id",
    "mandatory",
    "routed_conductor_ids",
    "deadline_at",
    "human_script_id",
    "evidence_predicate_id",
  ], "parallel_black_box_campaign_case_invalid");
  if (!identifier(e2eCase.case_id) || typeof e2eCase.mandatory !== "boolean" ||
      !Array.isArray(e2eCase.routed_conductor_ids) || e2eCase.routed_conductor_ids.length === 0 ||
      !isKnownHumanScriptId(e2eCase.human_script_id) ||
      !isKnownEvidencePredicateId(e2eCase.evidence_predicate_id)) {
    throw stableError("parallel_black_box_campaign_case_invalid");
  }
  assertTimestamp(e2eCase.deadline_at, "parallel_black_box_campaign_case_invalid");
  const deadlineAt = Date.parse(e2eCase.deadline_at);
  if (deadlineAt <= startedAt || deadlineAt > campaignDeadlineAt) {
    throw stableError("parallel_black_box_campaign_case_invalid");
  }
  const routes = new Set();
  for (const conductorId of e2eCase.routed_conductor_ids) {
    if (!identifier(conductorId) || !conductorIds.has(conductorId) || routes.has(conductorId)) {
      throw stableError("parallel_black_box_campaign_case_invalid");
    }
    routes.add(conductorId);
  }
  const isRestartScript = e2eCase.human_script_id === "restart_conductor";
  const isRestartPredicate = e2eCase.evidence_predicate_id === "restart_isolation";
  if (isRestartScript !== isRestartPredicate || (isRestartScript && routes.size !== 3)) {
    throw stableError("parallel_black_box_campaign_case_invalid");
  }
  const isCycleExhaustionScript = e2eCase.human_script_id === "exhaust_cycle_budget";
  const isCycleSuccessorPredicate = e2eCase.evidence_predicate_id === "cycle_successor";
  if (isCycleExhaustionScript !== isCycleSuccessorPredicate || (isCycleExhaustionScript && routes.size !== 1)) {
    throw stableError("parallel_black_box_campaign_case_invalid");
  }
  const isDeliveryScript = e2eCase.human_script_id === "deliver_and_review";
  const isDeliveryPredicate = e2eCase.evidence_predicate_id === "delivery_review";
  if (isDeliveryScript !== isDeliveryPredicate || (isDeliveryScript && routes.size !== 1)) {
    throw stableError("parallel_black_box_campaign_case_invalid");
  }
}

function freezeCommand(command) {
  return Object.freeze({
    version: 1,
    campaign_id: command.campaign_id,
    project_id: command.project_id,
    started_at: command.started_at,
    deadline_at: command.deadline_at,
    conductors: Object.freeze(command.conductors.map((conductor) => Object.freeze({ ...conductor }))),
    cases: Object.freeze(command.cases.map((e2eCase) => Object.freeze({
      ...e2eCase,
      routed_conductor_ids: Object.freeze([...e2eCase.routed_conductor_ids]),
    }))),
  });
}

function assertEvidenceReferences(references, code) {
  if (references.some((reference) => typeof reference !== "string" || reference.length === 0 || reference.length > 512)) {
    throw stableError(code);
  }
}

function assertExactKeys(value, keys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw stableError(code);
  }
}

function assertIdentifier(value, code) {
  if (!identifier(value)) throw stableError(code);
}

function assertTimestamp(value, code) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw stableError(code);
  }
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function record(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw stableError(code);
  return value;
}

function registry(ids) {
  return Object.freeze(Object.fromEntries(ids.map((id) => [id, Object.freeze({ id })])));
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
