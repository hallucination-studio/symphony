import { createHash } from "node:crypto";

import { collectManagedRecordFacts } from "./approved-happy-path-evidence.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function assessPlanRejectionSupersessionEvidence(row) {
  try {
    const input = rowInput(row);
    const tree = rootTree(input.snapshot, input.rootIssueId);
    const facts = collectManagedRecordFacts(tree);
    if (facts.invalid) return outcome("inconclusive", "plan_rejection_evidence_invalid");
    const issues = issueFacts(tree);
    const comments = commentFacts(tree);

    const resolution = one(facts.actionResolutions.filter((candidate) =>
      candidate.actionKind === "plan_review" &&
      candidate.outcome === "rejected" && candidate.terminalStatus === "Rejected" && candidate.actorKind === "human",
    ));
    if (resolution === undefined) return outcome("inconclusive", "plan_rejection_resolution_missing");
    if (resolution === null) return outcome("violated", "plan_rejection_resolution_ambiguous");

    const actionRequest = one(facts.actionRequests.filter((candidate) =>
      candidate.actionId === resolution.actionId && candidate.actionIssueId === resolution.actionIssueId &&
      candidate.actionKind === "plan_review" && candidate.proposalDigest === resolution.proposalDigest,
    ));
    if (actionRequest === undefined) return outcome("inconclusive", "plan_rejection_action_request_missing");
    if (actionRequest === null) return outcome("violated", "plan_rejection_action_request_ambiguous");
    const action = issues.get(actionRequest.actionIssueId);
    if (!action) return outcome("inconclusive", "plan_rejection_action_missing");
    if (resolution.sourceIssueId !== action.issueId || actionRequest.sourceIssueId !== action.issueId ||
        action.parentIssueId !== actionRequest.cycleIssueId || action.statusName !== "Rejected" ||
        !hasPlanReviewLabels(action) ||
        actionRequest.relatedIssueIds.length !== 1 || !hasRelation(tree, action.issueId, actionRequest.relatedIssueIds[0])) {
      return outcome("violated", "plan_rejection_action_mismatch");
    }
    if (!hasHumanReason(resolution, comments, input.humanActorId)) {
      return outcome("violated", "plan_rejection_reason_invalid");
    }
    if (facts.executions.some((candidate) => candidate.rootIssueId === input.rootIssueId &&
        candidate.cycleIssueId === actionRequest.cycleIssueId && candidate.stage !== "plan" &&
        Date.parse(candidate.startedAt) >= Date.parse(resolution.resolvedAt))) {
      return outcome("violated", "plan_rejection_work_advanced");
    }
    if (facts.deliveries.some((candidate) => candidate.rootIssueId === input.rootIssueId &&
        candidate.cycleIssueId === actionRequest.cycleIssueId)) {
      return outcome("violated", "plan_rejection_delivery_advanced");
    }

    const planIssueId = actionRequest.relatedIssueIds[0];
    const plan = issues.get(planIssueId);
    if (!plan) return outcome("inconclusive", "plan_rejection_plan_missing");
    if (plan.parentIssueId !== actionRequest.cycleIssueId) return outcome("violated", "plan_rejection_plan_scope_invalid");
    const oldContract = one(facts.planContracts.filter((candidate) =>
      candidate.rootIssueId === input.rootIssueId && candidate.cycleIssueId === actionRequest.cycleIssueId &&
      candidate.digest === actionRequest.proposalDigest,
    ));
    if (oldContract === undefined) return outcome("inconclusive", "plan_rejection_contract_missing");
    if (oldContract === null) return outcome("violated", "plan_rejection_contract_ambiguous");
    if (oldContract.sourceIssueId !== planIssueId) return outcome("violated", "plan_rejection_contract_mismatch");
    const oldStage = planStage(facts, {
      rootIssueId: input.rootIssueId,
      cycleIssueId: actionRequest.cycleIssueId,
      planIssueId,
      contractDigest: oldContract.digest,
    });
    if (oldStage.kind !== "ok") return outcome(oldStage.kind, oldStage.reasonCode);

    const directives = replanDirectives(tree, input.rootIssueId);
    if (directives.invalid) return outcome("inconclusive", "plan_rejection_directive_invalid");
    const directive = one(directives.values.filter((candidate) =>
      candidate.cycleIssueId === actionRequest.cycleIssueId && candidate.planIssueId === planIssueId &&
      candidate.supersededPlanContractIds.includes(oldContract.digest),
    ));
    if (directive === undefined) return outcome("inconclusive", "plan_rejection_directive_missing");
    if (directive === null) return outcome("violated", "plan_rejection_directive_ambiguous");
    if (!hasDirectiveResolution(directive, resolution) || new Set(directive.supersededPlanContractIds).size !== directive.supersededPlanContractIds.length) {
      return outcome("violated", "plan_rejection_directive_mismatch");
    }
    if (!archiveStateMatches(directive, issues)) return outcome("violated", "plan_rejection_archive_mismatch");

    const supersession = one(facts.planContractSupersessions.filter((candidate) =>
      candidate.rootIssueId === input.rootIssueId && candidate.cycleIssueId === actionRequest.cycleIssueId &&
      candidate.supersededPlanContractDigest === oldContract.digest && candidate.sourceRootDirectiveId === directive.rootDirectiveId &&
      candidate.freshPlanIssueId === planIssueId,
    ));
    if (supersession === undefined) return outcome("inconclusive", "plan_rejection_supersession_missing");
    if (supersession === null) return outcome("violated", "plan_rejection_supersession_ambiguous");
    if (supersession.sourceIssueId !== planIssueId || supersession.supersessionId !== planContractSupersessionId({
      rootIssueId: input.rootIssueId,
      cycleIssueId: actionRequest.cycleIssueId,
      rootDirectiveId: directive.rootDirectiveId,
      supersededPlanContractDigest: oldContract.digest,
    })) return outcome("violated", "plan_rejection_supersession_mismatch");

    const freshContract = one(facts.planContracts.filter((candidate) =>
      candidate.rootIssueId === input.rootIssueId && candidate.cycleIssueId === actionRequest.cycleIssueId &&
      candidate.sourceIssueId === planIssueId && candidate.digest !== oldContract.digest,
    ));
    if (freshContract === undefined) return outcome("inconclusive", "plan_rejection_fresh_contract_missing");
    if (freshContract === null) return outcome("violated", "plan_rejection_fresh_contract_ambiguous");
    const freshStage = planStage(facts, {
      rootIssueId: input.rootIssueId,
      cycleIssueId: actionRequest.cycleIssueId,
      planIssueId,
      contractDigest: freshContract.digest,
    });
    if (freshStage.kind !== "ok") return outcome(freshStage.kind, freshStage.reasonCode);
    const freshRequest = one(facts.actionRequests.filter((candidate) =>
      candidate.rootIssueId === input.rootIssueId && candidate.cycleIssueId === actionRequest.cycleIssueId &&
      candidate.actionKind === "plan_review" && candidate.proposalDigest === freshContract.digest,
    ));
    if (freshRequest === undefined) return outcome("inconclusive", "plan_rejection_fresh_action_missing");
    if (freshRequest === null) return outcome("violated", "plan_rejection_fresh_action_ambiguous");
    const freshAction = issues.get(freshRequest.actionIssueId);
    if (!freshAction) return outcome("inconclusive", "plan_rejection_fresh_action_missing");
    if (freshRequest.actionId === actionRequest.actionId || freshRequest.actionIssueId === actionRequest.actionIssueId ||
        freshRequest.sourceIssueId !== freshAction.issueId || freshAction.parentIssueId !== actionRequest.cycleIssueId ||
        freshAction.isArchived || !["Todo", "In Progress"].includes(freshAction.statusName) ||
        !hasPlanReviewLabels(freshAction) ||
        freshRequest.relatedIssueIds.length !== 1 || freshRequest.relatedIssueIds[0] !== planIssueId ||
        !hasRelation(tree, freshAction.issueId, planIssueId) ||
        facts.actionResolutions.some((candidate) => candidate.actionId === freshRequest.actionId)) {
      return outcome("violated", "plan_rejection_fresh_action_mismatch");
    }

    const milestones = [
      oldStage.execution.startedAt,
      oldStage.result.completedAt,
      actionRequest.createdAt,
      resolution.resolvedAt,
      directive.acceptedAt,
      supersession.supersededAt,
      freshStage.execution.startedAt,
      freshStage.result.completedAt,
      freshRequest.createdAt,
    ];
    if (milestones.some((value, index) => index > 0 && Date.parse(milestones[index - 1]) > Date.parse(value))) {
      return outcome("violated", "plan_rejection_chain_order_invalid");
    }
    return outcome("satisfied", "plan_rejection_supersession_confirmed");
  } catch {
    return outcome("inconclusive", "plan_rejection_evidence_invalid");
  }
}

export function analyzePlanRejectionSupersessionCampaignEvidence({ rows } = {}) {
  if (!Array.isArray(rows)) return Object.freeze({ case_outcomes: Object.freeze([]) });
  return Object.freeze({
    case_outcomes: Object.freeze(rows
      .filter((row) => row?.e2eCase?.evidence_predicate_id === "plan_rejection_supersession")
      .map((row) => Object.freeze({ case_id: row.e2eCase.case_id, outcome: assessPlanRejectionSupersessionEvidence(row) }))),
  });
}

function rowInput(value) {
  const row = object(value);
  const e2eCase = object(row.e2eCase);
  const caseRoots = object(row.caseRoots);
  const caseContext = object(row.caseContext);
  const snapshot = object(row.snapshot);
  if (!identifier(e2eCase.case_id) || e2eCase.evidence_predicate_id !== "plan_rejection_supersession" ||
      !Array.isArray(caseRoots.root_issue_ids) || caseRoots.root_issue_ids.length !== 1 || !identifier(caseRoots.root_issue_ids[0]) ||
      !identifier(caseContext.human_actor_id) || snapshot.kind !== "complete" || !Array.isArray(snapshot.root_trees)) {
    throw new Error("invalid row");
  }
  return { rootIssueId: caseRoots.root_issue_ids[0], humanActorId: caseContext.human_actor_id, snapshot };
}

function rootTree(snapshot, rootIssueId) {
  const tree = one(snapshot.root_trees.filter((candidate) => candidate?.root_issue_id === rootIssueId));
  if (!tree || !Array.isArray(tree.issues) || !Array.isArray(tree.comments) || !Array.isArray(tree.relations) || !Array.isArray(tree.managed_blocks)) {
    throw new Error("invalid tree");
  }
  return tree;
}

function issueFacts(tree) {
  const facts = new Map();
  for (const issue of tree.issues) {
    if (!object(issue) || !identifier(issue.issue_id) || (issue.parent_issue_id !== null && !identifier(issue.parent_issue_id)) ||
        !text(issue.status?.name) || typeof issue.is_archived !== "boolean" ||
        (issue.archived_at !== null && !timestamp(issue.archived_at))) throw new Error("invalid issue");
    if (facts.has(issue.issue_id)) throw new Error("duplicate issue");
    facts.set(issue.issue_id, {
      issueId: issue.issue_id,
      parentIssueId: issue.parent_issue_id,
      statusName: issue.status.name,
      isArchived: issue.is_archived,
      labels: labelNames(issue.labels),
    });
  }
  return facts;
}

function commentFacts(tree) {
  const facts = new Map();
  for (const comment of tree.comments) {
    if (!object(comment) || !identifier(comment.comment_id) || !identifier(comment.issue_id)) throw new Error("invalid comment");
    if (facts.has(comment.comment_id)) throw new Error("duplicate comment");
    facts.set(comment.comment_id, comment);
  }
  return facts;
}

function hasHumanReason(resolution, comments, humanActorId) {
  if (resolution.sourceCommentIds.length === 0 || resolution.sourceCommentIds.length !== resolution.sourceCommentVersions.length) return false;
  return resolution.sourceCommentIds.some((commentId) => {
    const comment = comments.get(commentId);
    return object(comment) && comment.issue_id === resolution.actionIssueId && text(comment.body) &&
      comment.author?.actor_id === humanActorId && comment.author?.actor_kind === "user";
  });
}

function planStage(facts, { rootIssueId, cycleIssueId, planIssueId, contractDigest }) {
  const candidates = facts.executions.filter((execution) =>
    execution.stage === "plan" && execution.rootIssueId === rootIssueId && execution.cycleIssueId === cycleIssueId &&
    execution.nodeIssueId === planIssueId,
  ).map((execution) => ({
    execution,
    results: facts.results.filter((result) =>
      result.stage === "plan" && result.executionId === execution.stageExecutionId && result.rootIssueId === rootIssueId &&
      result.cycleIssueId === cycleIssueId && result.nodeIssueId === planIssueId && result.outcomeKind === "plan_completed" &&
      result.planContractDigest === contractDigest,
    ),
  })).filter(({ results }) => results.length > 0);
  if (candidates.length === 0) return { kind: "inconclusive", reasonCode: "plan_rejection_plan_result_missing" };
  if (candidates.length !== 1 || candidates[0].results.length !== 1) {
    return { kind: "violated", reasonCode: "plan_rejection_plan_result_ambiguous" };
  }
  const { execution, results } = candidates[0];
  const result = results[0];
  if (execution.sourceIssueId !== planIssueId || result.sourceIssueId !== planIssueId) {
    return { kind: "violated", reasonCode: "plan_rejection_plan_result_mismatch" };
  }
  return { kind: "ok", execution, result };
}

function replanDirectives(tree, rootIssueId) {
  const comments = new Map(tree.comments.map((comment) => [comment?.comment_id, comment]));
  const values = [];
  for (const block of tree.managed_blocks) {
    if (block?.record?.kind !== "root_directive") continue;
    const source = comments.get(block.source_id);
    const decoded = decodeRootDirective(block.record, source?.issue_id, rootIssueId);
    if (decoded === null) return { invalid: true, values: [] };
    if (decoded.actionKind === "replan_current_cycle") values.push(decoded);
  }
  return { invalid: false, values };
}

function decodeRootDirective(record, sourceIssueId, rootIssueId) {
  if (!object(record) || sourceIssueId !== rootIssueId) return null;
  exactKeys(record, [
    "kind", "version", "root_directive_id", "root_issue_id", "reconciler_session_id", "reconciler_turn_id",
    "based_on_target_root_digest", "consumed_input_ids", "directive", "accepted_at",
  ]);
  if (record.version !== 1 || record.root_issue_id !== rootIssueId || !identifier(record.root_directive_id) ||
      !identifier(record.reconciler_session_id) || !identifier(record.reconciler_turn_id) ||
      !identifier(record.based_on_target_root_digest) || !identifierArray(record.consumed_input_ids) || !timestamp(record.accepted_at)) return null;
  const directive = object(record.directive);
  if (!directive) return null;
  exactKeys(directive, [
    "protocol_version", "request_id", "root_directive_id", "reconciler_session_id", "reconciler_turn_id", "model_turn",
    "based_on_target_root_digest", "rationale", "evidence_refs", "consumed_input_ids", "comment_replies",
    "human_action_resolutions", "action",
  ]);
  if (directive.protocol_version !== "1" || directive.root_directive_id !== record.root_directive_id ||
      directive.reconciler_session_id !== record.reconciler_session_id || directive.reconciler_turn_id !== record.reconciler_turn_id ||
      directive.based_on_target_root_digest !== record.based_on_target_root_digest || !identifier(directive.request_id) ||
      !validRootModelTurn(directive.model_turn, {
        rootIssueId,
        reconcilerSessionId: record.reconciler_session_id,
        reconcilerTurnId: record.reconciler_turn_id,
      }) || !text(directive.rationale) || !Array.isArray(directive.evidence_refs) || !identifierArray(directive.consumed_input_ids) ||
      !Array.isArray(directive.comment_replies) || !Array.isArray(directive.human_action_resolutions) || !object(directive.action)) return null;
  const action = directive.action;
  if (action.kind !== "replan_current_cycle") return { actionKind: action.kind };
  exactKeys(action, [
    "kind", "cycle_issue_id", "reason", "superseded_plan_contract_ids", "invalidate_execution_ids", "preserve_evidence_refs",
    "archive_or_restore_operations", "plan_issue_id", "fresh_plan_goal",
  ]);
  if (!identifier(action.cycle_issue_id) || !text(action.reason) || !identifierArray(action.superseded_plan_contract_ids) ||
      action.superseded_plan_contract_ids.length === 0 || !identifierArray(action.invalidate_execution_ids) ||
      !Array.isArray(action.preserve_evidence_refs) || !Array.isArray(action.archive_or_restore_operations) ||
      !identifier(action.plan_issue_id) || !text(action.fresh_plan_goal)) return null;
  const archiveOperations = action.archive_or_restore_operations.map(decodeArchiveOperation);
  if (archiveOperations.some((operation) => operation === null)) return null;
  return {
    actionKind: action.kind,
    rootDirectiveId: record.root_directive_id,
    cycleIssueId: action.cycle_issue_id,
    planIssueId: action.plan_issue_id,
    supersededPlanContractIds: action.superseded_plan_contract_ids,
    archiveOperations,
    humanActionResolutions: directive.human_action_resolutions,
    acceptedAt: record.accepted_at,
  };
}

function decodeArchiveOperation(operation) {
  if (!object(operation) || !["archive_node", "restore_node"].includes(operation.kind)) return null;
  exactKeys(operation, ["kind", "precondition"]);
  const precondition = object(operation.precondition);
  if (!precondition) return null;
  exactKeys(precondition, ["target_issue_id", "expected_remote_version"], ["expected_parent_issue_id", "expected_status"]);
  if (!identifier(precondition.target_issue_id) || !text(precondition.expected_remote_version) ||
      (precondition.expected_parent_issue_id !== undefined && !identifier(precondition.expected_parent_issue_id)) ||
      (precondition.expected_status !== undefined && !text(precondition.expected_status))) return null;
  return { kind: operation.kind, targetIssueId: precondition.target_issue_id };
}

function hasDirectiveResolution(directive, resolution) {
  return directive.humanActionResolutions.filter((candidate) => object(candidate) &&
    candidate.action_id === resolution.actionId && candidate.action_issue_id === resolution.actionIssueId &&
    candidate.action_kind === "plan_review" && candidate.outcome === "rejected" && candidate.terminal_status === "Rejected" &&
    candidate.proposal_digest === resolution.proposalDigest && candidate.actor_kind === "human",
  ).length === 1;
}

function hasPlanReviewLabels(issue) {
  return issue.labels !== null && issue.labels.length === 2 &&
    issue.labels.includes("Human Action") && issue.labels.includes("Plan Review");
}

function validRootModelTurn(value, { rootIssueId, reconcilerSessionId, reconcilerTurnId }) {
  if (!object(value)) return false;
  exactKeys(value, [
    "turn_record_id", "role", "root_issue_id", "reconciler_session_id", "reconciler_turn_id", "invocation_state",
    "model", "outcome", "usage", "terminal_at",
  ]);
  return identifier(value.turn_record_id) && value.role === "root_reconciler" && value.root_issue_id === rootIssueId &&
    value.reconciler_session_id === reconcilerSessionId && value.reconciler_turn_id === reconcilerTurnId &&
    value.invocation_state === "confirmed" && text(value.model) && value.outcome === "directive_accepted" &&
    validTurnUsage(value.usage) && timestamp(value.terminal_at);
}

function validTurnUsage(value) {
  if (!object(value)) return false;
  if (value.status === "measured") {
    exactKeys(value, ["status", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]);
    return [value.input_tokens, value.cached_input_tokens, value.output_tokens, value.reasoning_output_tokens, value.total_tokens]
      .every((token) => Number.isInteger(token) && token >= 0);
  }
  exactKeys(value, ["status", "reason"]);
  return value.status === "unavailable" && ["provider_omitted", "transport_lost", "process_lost", "invalid_provider_usage"].includes(value.reason);
}

function archiveStateMatches(directive, issues) {
  const archiveTargets = new Set();
  const restoreTargets = new Set();
  for (const operation of directive.archiveOperations) {
    const targets = operation.kind === "archive_node" ? archiveTargets : restoreTargets;
    if (!issues.has(operation.targetIssueId) || targets.has(operation.targetIssueId)) return false;
    targets.add(operation.targetIssueId);
  }
  if ([...archiveTargets].some((issueId) => restoreTargets.has(issueId))) return false;
  const archivedIssues = new Set([...issues.values()].filter(({ isArchived }) => isArchived).map(({ issueId }) => issueId));
  if (archivedIssues.size !== archiveTargets.size || [...archivedIssues].some((issueId) => !archiveTargets.has(issueId))) return false;
  return [...restoreTargets].every((issueId) => !issues.get(issueId).isArchived);
}

function hasRelation(tree, sourceIssueId, targetIssueId) {
  return tree.relations.some((relation) => relation?.relation_kind === "relates_to" &&
    relation.issue_id === sourceIssueId && relation.related_issue_id === targetIssueId);
}

function labelNames(value) {
  if (!Array.isArray(value)) return null;
  const labels = [];
  for (const label of value) {
    if (!object(label) || !identifier(label.label_id) || !text(label.name)) throw new Error("invalid label");
    labels.push(label.name);
  }
  return labels.length === new Set(labels).size ? labels : null;
}

function planContractSupersessionId({ rootIssueId, cycleIssueId, rootDirectiveId, supersededPlanContractDigest }) {
  return createHash("sha256")
    .update([
      "plan_contract_supersession",
      rootIssueId,
      cycleIssueId,
      rootDirectiveId,
      supersededPlanContractDigest,
    ].join("\0"), "utf8")
    .digest("hex");
}

function one(values) {
  return values.length === 0 ? undefined : values.length === 1 ? values[0] : null;
}

function outcome(kind, reason_code) {
  return Object.freeze({ kind, reason_code });
}

function exactKeys(value, required, optional = []) {
  const actual = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("invalid record keys");
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function identifierArray(value) {
  return Array.isArray(value) && value.every(identifier) && new Set(value).size === value.length;
}

function timestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768;
}
