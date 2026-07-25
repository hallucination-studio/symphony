const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const STAGES = new Set(["plan", "work", "verify"]);

export function assessApprovedHappyPathEvidence(row) {
  try {
    const input = rowInput(row);
    const tree = rootTree(input.snapshot, input.root.root_issue_id);
    const facts = collectManagedRecordFacts(tree);
    if (facts.invalid) return assessment("inconclusive", "happy_path_evidence_invalid");

    const rootIssue = issue(tree, input.root.root_issue_id);
    if (!rootIssue) return assessment("inconclusive", "happy_path_root_missing");
    const ownershipCandidates = facts.ownership.filter(({ rootIssueId }) => rootIssueId === input.root.root_issue_id);
    if (ownershipCandidates.length > 1) return assessment("violated", "happy_path_ownership_ambiguous");
    const ownership = exact(ownershipCandidates);
    if (!ownership) return assessment("inconclusive", "happy_path_ownership_missing");
    if (ownership.rootIssueId !== input.root.root_issue_id || ownership.sourceIssueId !== input.root.root_issue_id ||
        ownership.conductorId !== input.conductor.conductor_id) {
      return assessment("violated", "happy_path_ownership_mismatch");
    }
    if (rootIssue.statusName !== "In Review") return assessment("violated", "happy_path_root_delivery_state_invalid");

    const planContracts = facts.planContracts.filter(({ rootIssueId }) => rootIssueId === input.root.root_issue_id);
    if (planContracts.length > 1) return assessment("violated", "happy_path_plan_contract_ambiguous");
    const planContract = exact(planContracts);
    if (!planContract) return assessment("inconclusive", "happy_path_plan_contract_missing");
    if (ambiguousStage(facts, "plan", input.root.root_issue_id, planContract.cycleIssueId)) {
      return assessment("violated", "happy_path_plan_stage_ambiguous");
    }
    const plan = exactStage(facts, "plan", input.root.root_issue_id, planContract.cycleIssueId);
    if (!plan) return assessment("inconclusive", "happy_path_plan_stage_missing");
    if (plan.execution.nodeIssueId !== plan.result.nodeIssueId || plan.result.planContractDigest !== planContract.digest ||
        plan.execution.sourceIssueId !== plan.execution.nodeIssueId || plan.result.sourceIssueId !== plan.result.nodeIssueId ||
        planContract.sourceIssueId !== plan.execution.nodeIssueId) {
      return assessment("violated", "happy_path_plan_contract_mismatch");
    }

    const actionRequests = facts.actionRequests.filter((candidate) =>
      candidate.rootIssueId === input.root.root_issue_id && candidate.cycleIssueId === plan.execution.cycleIssueId &&
      candidate.actionKind === "plan_review" && candidate.proposalDigest === planContract.digest,
    );
    if (actionRequests.length > 1) return assessment("violated", "happy_path_plan_approval_ambiguous");
    const actionRequest = exact(actionRequests);
    if (!actionRequest) return assessment("inconclusive", "happy_path_plan_approval_missing");
    const actionResolutions = facts.actionResolutions.filter((candidate) =>
      candidate.actionId === actionRequest.actionId && candidate.actionIssueId === actionRequest.actionIssueId &&
      candidate.actionKind === "plan_review" && candidate.outcome === "approved" &&
      candidate.terminalStatus === "Approved" && candidate.actorKind === "human" &&
      candidate.proposalDigest === planContract.digest,
    );
    if (actionResolutions.length > 1) return assessment("violated", "happy_path_plan_approval_ambiguous");
    const actionResolution = exact(actionResolutions);
    if (!actionResolution) return assessment("inconclusive", "happy_path_plan_approval_missing");
    const actionIssue = issue(tree, actionRequest.actionIssueId);
    const planIssue = issue(tree, plan.execution.nodeIssueId);
    if (!actionIssue || !planIssue) return assessment("inconclusive", "happy_path_plan_approval_target_missing");
    if (actionRequest.sourceIssueId !== actionIssue.issueId || actionResolution.sourceIssueId !== actionIssue.issueId ||
        actionIssue.parentIssueId !== plan.execution.cycleIssueId || planIssue.parentIssueId !== plan.execution.cycleIssueId ||
        actionIssue.statusName !== "Approved" || actionIssue.remoteVersion !== actionResolution.terminalRemoteVersion ||
        actionRequest.relatedIssueIds.length !== 1 || actionRequest.relatedIssueIds[0] !== planIssue.issueId ||
        !hasRelation(tree, actionIssue.issueId, planIssue.issueId)) {
      return assessment("violated", "happy_path_plan_approval_mismatch");
    }

    const work = matchingWorkStages(facts, input.root.root_issue_id, plan.execution.cycleIssueId, planContract.digest);
    if (work.kind !== "ok") return assessment(work.kind, work.reasonCode);
    if (ambiguousStage(facts, "verify", input.root.root_issue_id, plan.execution.cycleIssueId)) {
      return assessment("violated", "happy_path_verify_stage_ambiguous");
    }
    const verify = exactStage(facts, "verify", input.root.root_issue_id, plan.execution.cycleIssueId);
    if (!verify) return assessment("inconclusive", "happy_path_verify_stage_missing");
    if (verify.execution.planContractDigest !== planContract.digest || verify.result.outcomeKind !== "verify_passed" ||
        verify.result.verifiedRevision === undefined || verify.execution.sourceIssueId !== verify.execution.nodeIssueId ||
        verify.result.sourceIssueId !== verify.result.nodeIssueId) {
      return assessment("violated", "happy_path_verify_result_mismatch");
    }
    const verifyResults = facts.verifyResults.filter((candidate) =>
      candidate.rootIssueId === input.root.root_issue_id && candidate.cycleIssueId === plan.execution.cycleIssueId &&
      candidate.stageExecutionId === verify.execution.stageExecutionId && candidate.nodeIssueId === verify.execution.nodeIssueId,
    );
    if (verifyResults.length > 1) return assessment("violated", "happy_path_verify_result_ambiguous");
    const verifyResult = exact(verifyResults);
    if (!verifyResult) return assessment("inconclusive", "happy_path_verify_result_missing");
    if (verifyResult.conclusion !== "passed" || verifyResult.verifiedRevision !== verify.result.verifiedRevision ||
        verifyResult.sourceIssueId !== verify.execution.nodeIssueId) {
      return assessment("violated", "happy_path_verify_result_mismatch");
    }

    const deliveries = facts.deliveries.filter((candidate) =>
      candidate.rootIssueId === input.root.root_issue_id && candidate.cycleIssueId === plan.execution.cycleIssueId,
    );
    if (deliveries.length > 1) return assessment("violated", "happy_path_delivery_ambiguous");
    const delivery = exact(deliveries);
    if (!delivery) return assessment("inconclusive", "happy_path_delivery_missing");
    if (delivery.sourceIssueId !== input.root.root_issue_id || delivery.verifyResultId !== verifyResult.stageExecutionId ||
        delivery.verifiedRevision !== verifyResult.verifiedRevision) {
      return assessment("violated", "happy_path_delivery_mismatch");
    }

    const repository = exact(input.snapshot.repositories.filter((candidate) =>
      candidate.repository_identity === input.conductor.repository_identity,
    ));
    if (!repository) return assessment("inconclusive", "happy_path_repository_missing");
    if (repository.branch !== delivery.deliveryBranch || repository.headCommit !== delivery.verifiedRevision ||
        repository.diffCheck !== "passed" || repository.worktreeClean !== true || repository.delivered !== true ||
        repository.remoteHead !== repository.headCommit) {
      return assessment("violated", "happy_path_git_delivery_mismatch");
    }

    const milestones = [
      plan.execution.startedAt,
      plan.result.completedAt,
      actionRequest.createdAt,
      actionResolution.resolvedAt,
      work.firstStartedAt,
      work.lastCompletedAt,
      verify.execution.startedAt,
      verify.result.completedAt,
      delivery.deliveredAt,
    ];
    if (milestones.some((value, index) => index > 0 && Date.parse(milestones[index - 1]) > Date.parse(value))) {
      return assessment("violated", "happy_path_chain_order_invalid");
    }

    return assessment("satisfied", "happy_path_chain_confirmed", [
      interval(input.root.root_issue_id, ownership.conductorId, plan.execution, plan.result),
      ...work.stages.map(({ execution, result }) => interval(input.root.root_issue_id, ownership.conductorId, execution, result)),
      interval(input.root.root_issue_id, ownership.conductorId, verify.execution, verify.result),
    ]);
  } catch {
    return assessment("inconclusive", "happy_path_evidence_invalid");
  }
}

export function analyzeHappyPathCampaignEvidence({ rows } = {}) {
  if (!Array.isArray(rows)) return Object.freeze({ case_outcomes: Object.freeze([]), durable_overlap_evidence_refs: Object.freeze([]) });
  const assessed = rows
    .filter((row) => row?.e2eCase?.evidence_predicate_id === "happy_path")
    .map((row) => ({ row, assessment: assessApprovedHappyPathEvidence(row) }));
  const pairs = [];
  for (let left = 0; left < assessed.length; left += 1) {
    for (let right = left + 1; right < assessed.length; right += 1) {
      const a = assessed[left];
      const b = assessed[right];
      if (a.assessment.outcome.kind !== "satisfied" || b.assessment.outcome.kind !== "satisfied") continue;
      for (const aInterval of a.assessment.intervals) {
        for (const bInterval of b.assessment.intervals) {
          if (aInterval.conductor_id === bInterval.conductor_id || !intervalsOverlap(aInterval, bInterval)) continue;
          pairs.push({ a, b, aInterval, bInterval });
        }
      }
    }
  }
  const caseIdsWithOverlap = new Set(pairs.flatMap(({ a, b }) => [a.row.e2eCase.case_id, b.row.e2eCase.case_id]));
  const successful = assessed.filter(({ assessment: value }) => value.outcome.kind === "satisfied");
  const outcomes = assessed.map(({ row, assessment: value }) => {
    if (value.outcome.kind !== "satisfied") return Object.freeze({ case_id: row.e2eCase.case_id, outcome: value.outcome });
    if (caseIdsWithOverlap.has(row.e2eCase.case_id)) {
      return Object.freeze({ case_id: row.e2eCase.case_id, outcome: outcome("satisfied", "happy_path_overlap_confirmed") });
    }
    const otherComplete = successful.some(({ row: other }) => other.e2eCase.case_id !== row.e2eCase.case_id);
    return Object.freeze({
      case_id: row.e2eCase.case_id,
      outcome: otherComplete
        ? outcome("violated", "happy_path_overlap_absent")
        : outcome("inconclusive", "happy_path_overlap_missing"),
    });
  });
  const evidenceRefs = pairs.length === 0 ? [] : pairReferences(pairs[0]);
  return Object.freeze({
    case_outcomes: Object.freeze(outcomes),
    durable_overlap_evidence_refs: Object.freeze(evidenceRefs),
  });
}

function rowInput(value) {
  const row = object(value);
  const caseRoots = object(row.caseRoots);
  const context = object(row.caseContext);
  const conductors = array(context.conductors);
  if (!Array.isArray(caseRoots.root_issue_ids) || caseRoots.root_issue_ids.length !== 1 ||
      !identifier(caseRoots.root_issue_ids[0]) || conductors.length !== 1) throw new Error("invalid row");
  const conductor = object(conductors[0]);
  if (!identifier(conductor.conductor_id) || !identifier(conductor.repository_identity)) throw new Error("invalid conductor");
  const snapshot = object(row.snapshot);
  if (snapshot.kind !== "complete" || !Array.isArray(snapshot.root_trees) || !Array.isArray(snapshot.repositories)) {
    throw new Error("invalid snapshot");
  }
  return {
    root: { root_issue_id: caseRoots.root_issue_ids[0] },
    conductor,
    snapshot: {
      ...snapshot,
      repositories: snapshot.repositories.map(repositoryFacts),
    },
  };
}

function rootTree(snapshot, rootIssueId) {
  const tree = exact(snapshot.root_trees.filter((candidate) => candidate?.root_issue_id === rootIssueId));
  if (!tree || !Array.isArray(tree.issues) || !Array.isArray(tree.comments) || !Array.isArray(tree.relations) ||
      !Array.isArray(tree.managed_blocks)) throw new Error("invalid tree");
  return tree;
}

function repositoryFacts(value) {
  const repository = object(value);
  const worktree = object(repository.worktree);
  const delivery = object(repository.delivery);
  if (!identifier(repository.repository_identity) || !text(repository.branch) || !COMMIT.test(repository.head_commit) ||
      !["passed", "failed"].includes(repository.diff_check) || typeof worktree.is_clean !== "boolean" ||
      delivery.branch !== repository.branch || (delivery.remote_head !== null && !COMMIT.test(delivery.remote_head)) ||
      typeof delivery.is_delivered !== "boolean" || delivery.is_delivered !== (delivery.remote_head === repository.head_commit)) {
    throw new Error("invalid repository");
  }
  return {
    repository_identity: repository.repository_identity,
    branch: repository.branch,
    headCommit: repository.head_commit,
    diffCheck: repository.diff_check,
    worktreeClean: worktree.is_clean,
    remoteHead: delivery.remote_head,
    delivered: delivery.is_delivered,
  };
}

export function collectManagedRecordFacts(tree) {
  const comments = new Map(tree.comments.map((comment) => [comment?.comment_id, comment]));
  const facts = {
    invalid: false, ownership: [], planContracts: [], executions: [], results: [], actionRequests: [],
    actionResolutions: [], verifyResults: [], deliveries: [], planContractSupersessions: [],
  };
  for (const block of tree.managed_blocks) {
    const source = comments.get(block?.source_id);
    if (block?.source_kind !== "comment" || !source || !identifier(source.issue_id) || !objectOrNull(block.record)) continue;
    const decoded = decodeRecord(block.record, source.issue_id);
    if (decoded === null) {
      if (requiredRecordKind(block.record?.kind)) facts.invalid = true;
      continue;
    }
    facts[decoded.group].push(decoded.value);
  }
  return facts;
}

function decodeRecord(record, sourceIssueId) {
  if (record.kind === "root_ownership") return decoded("ownership", decodeOwnership(record, sourceIssueId));
  if (record.kind === "plan_contract") return decoded("planContracts", decodePlanContract(record, sourceIssueId));
  if (record.kind === "stage_execution") return decoded("executions", decodeExecution(record, sourceIssueId));
  if (record.kind === "stage_result") return decoded("results", decodeResult(record, sourceIssueId));
  if (record.kind === "human_action_request") return decoded("actionRequests", decodeActionRequest(record, sourceIssueId));
  if (record.kind === "human_action_resolution") return decoded("actionResolutions", decodeActionResolution(record, sourceIssueId));
  if (record.kind === "verify_result") return decoded("verifyResults", decodeVerifyResult(record, sourceIssueId));
  if (record.kind === "delivery") return decoded("deliveries", decodeDelivery(record, sourceIssueId));
  if (record.kind === "plan_contract_supersession") return decoded("planContractSupersessions", decodePlanContractSupersession(record, sourceIssueId));
  return null;
}

function decoded(group, value) {
  return value === null ? null : { group, value };
}

function decodeOwnership(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "root_issue_id", "conductor_id", "performer_profile_id", "delivery_branch", "owner_generation"], ["pull_request"]);
  if (!version(record) || !identifier(record.root_issue_id) || !identifier(record.conductor_id) ||
      !identifier(record.performer_profile_id) || !text(record.delivery_branch) || !identifier(record.owner_generation)) return null;
  return { rootIssueId: record.root_issue_id, conductorId: record.conductor_id, sourceIssueId };
}

function decodePlanContract(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "root_issue_id", "cycle_issue_id", "plan_contract_digest", "objective", "included_scope", "excluded_scope", "assumptions", "constraints", "acceptance_criteria", "verification_requirements", "proposed_work_dag"]);
  if (!version(record) || !identifier(record.root_issue_id) || !identifier(record.cycle_issue_id) ||
      !identifier(record.plan_contract_digest) || !text(record.objective) || !textArray(record.included_scope) ||
      !textArray(record.excluded_scope) || !textArray(record.assumptions) || !textArray(record.constraints) ||
      !Array.isArray(record.acceptance_criteria) || !textArray(record.verification_requirements) || !objectOrNull(record.proposed_work_dag)) return null;
  return { rootIssueId: record.root_issue_id, cycleIssueId: record.cycle_issue_id, digest: record.plan_contract_digest, sourceIssueId };
}

function decodeExecution(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "stage_execution_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "stage", "context_digest", "source_manifest", "coverage", "instruction_set_id", "execution_policy_id", "limits", "repository_revision", "started_at", "deadline_at"], ["plan_contract_digest"]);
  if (!version(record) || !identifier(record.stage_execution_id) || !identifier(record.root_issue_id) ||
      !identifier(record.cycle_issue_id) || !identifier(record.node_issue_id) || !STAGES.has(record.stage) ||
      !identifier(record.context_digest) || !Array.isArray(record.source_manifest) || !validCoverage(record.coverage) ||
      !identifier(record.instruction_set_id) || !identifier(record.execution_policy_id) || !validLimits(record.limits) ||
      !identifier(record.repository_revision) || !timestamp(record.started_at) || !timestamp(record.deadline_at) ||
      (record.stage === "plan" ? record.plan_contract_digest !== undefined : !identifier(record.plan_contract_digest))) return null;
  return {
    stageExecutionId: record.stage_execution_id, rootIssueId: record.root_issue_id, cycleIssueId: record.cycle_issue_id,
    nodeIssueId: record.node_issue_id, stage: record.stage, planContractDigest: record.plan_contract_digest,
    startedAt: record.started_at, sourceIssueId,
  };
}

function decodeResult(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "result_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "stage", "role_session_id", "role_turn_id", "observed_tree_digest", "context_digest", "outcome_kind", "summary", "source_manifest", "completed_at", "model_turn"], ["plan_contract_digest", "plan_contract", "proposed_work_dag", "risks", "required_permissions", "evidence_refs", "changed_paths", "commit_revision", "verify_conclusion", "verified_revision", "failure_code"]);
  if (!version(record) || !identifier(record.result_id) || !identifier(record.root_issue_id) || !identifier(record.cycle_issue_id) ||
      !identifier(record.node_issue_id) || !STAGES.has(record.stage) || !identifier(record.role_session_id) ||
      !identifier(record.role_turn_id) || !identifier(record.observed_tree_digest) || !identifier(record.context_digest) ||
      !identifier(record.outcome_kind) || !text(record.summary) || !Array.isArray(record.source_manifest) ||
      !timestamp(record.completed_at) || !validModelTurn(record.model_turn, record)) return null;
  const plan = record.stage === "plan" && record.outcome_kind === "plan_completed";
  const work = record.stage === "work" && record.outcome_kind === "work_completed";
  const verify = record.stage === "verify" && record.outcome_kind === "verify_passed";
  if ((plan && (!identifier(record.plan_contract_digest) || !objectOrNull(record.plan_contract) || !objectOrNull(record.proposed_work_dag) || !textArray(record.risks) || !textArray(record.required_permissions) || !Array.isArray(record.evidence_refs))) ||
      (work && (!identifier(record.plan_contract_digest) || !identifier(record.commit_revision) || !textArray(record.changed_paths))) ||
      (verify && (!identifier(record.plan_contract_digest) || !identifier(record.verified_revision) || record.verify_conclusion !== "passed"))) return null;
  return {
    resultId: record.result_id, rootIssueId: record.root_issue_id, cycleIssueId: record.cycle_issue_id,
    nodeIssueId: record.node_issue_id, stage: record.stage, outcomeKind: record.outcome_kind,
    executionId: record.model_turn.stage_execution_id, planContractDigest: record.plan_contract_digest,
    completedAt: record.completed_at, verifiedRevision: record.verified_revision, sourceIssueId,
  };
}

function decodeActionRequest(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "action_id", "action_issue_id", "action_kind", "parent_scope", "root_issue_id", "related_issue_ids", "proposal_digest", "expected_parent_remote_version", "created_at"], ["cycle_issue_id", "source_root_directive_id", "source_root_convergence_record_id", "based_on_tree_digest"]);
  if (!version(record) || !identifier(record.action_id) || !identifier(record.action_issue_id) ||
      !identifier(record.root_issue_id) || !identifier(record.cycle_issue_id) || record.action_kind !== "plan_review" ||
      record.parent_scope !== "cycle" || !identifierArray(record.related_issue_ids) || !identifier(record.proposal_digest) ||
      !text(record.expected_parent_remote_version) || !timestamp(record.created_at)) return null;
  return {
    actionId: record.action_id, actionIssueId: record.action_issue_id, actionKind: record.action_kind,
    rootIssueId: record.root_issue_id, cycleIssueId: record.cycle_issue_id, relatedIssueIds: record.related_issue_ids,
    proposalDigest: record.proposal_digest, createdAt: record.created_at, sourceIssueId,
  };
}

function decodeActionResolution(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "resolution_id", "action_id", "action_issue_id", "action_kind", "outcome", "terminal_status", "terminal_remote_version", "source_comment_ids", "source_comment_versions", "actor_kind", "proposal_digest", "resolved_at"]);
  if (!version(record) || !identifier(record.resolution_id) || !identifier(record.action_id) ||
      !identifier(record.action_issue_id) || record.action_kind !== "plan_review" ||
      !["approved", "rejected", "answered", "canceled"].includes(record.outcome) ||
      !["Approved", "Rejected", "Answered", "Canceled"].includes(record.terminal_status) ||
      !text(record.terminal_remote_version) || !identifierArray(record.source_comment_ids) ||
      !textArray(record.source_comment_versions) || record.source_comment_ids.length !== record.source_comment_versions.length ||
      record.actor_kind !== "human" || !identifier(record.proposal_digest) || !timestamp(record.resolved_at)) return null;
  return {
    actionId: record.action_id, actionIssueId: record.action_issue_id, actionKind: record.action_kind,
    outcome: record.outcome, terminalStatus: record.terminal_status, terminalRemoteVersion: record.terminal_remote_version,
    actorKind: record.actor_kind, proposalDigest: record.proposal_digest, resolvedAt: record.resolved_at,
    sourceCommentIds: record.source_comment_ids, sourceCommentVersions: record.source_comment_versions, sourceIssueId,
  };
}

function decodePlanContractSupersession(record, sourceIssueId) {
  exactKeys(record, [
    "kind", "version", "supersession_id", "root_issue_id", "cycle_issue_id", "superseded_plan_contract_digest",
    "source_root_directive_id", "fresh_plan_issue_id", "superseded_at",
  ]);
  if (!version(record) || !identifier(record.supersession_id) || !identifier(record.root_issue_id) ||
      !identifier(record.cycle_issue_id) || !identifier(record.superseded_plan_contract_digest) ||
      !identifier(record.source_root_directive_id) || !identifier(record.fresh_plan_issue_id) || !timestamp(record.superseded_at)) return null;
  return {
    supersessionId: record.supersession_id, rootIssueId: record.root_issue_id, cycleIssueId: record.cycle_issue_id,
    supersededPlanContractDigest: record.superseded_plan_contract_digest,
    sourceRootDirectiveId: record.source_root_directive_id, freshPlanIssueId: record.fresh_plan_issue_id,
    supersededAt: record.superseded_at, sourceIssueId,
  };
}

function decodeVerifyResult(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "stage_execution_id", "root_issue_id", "cycle_issue_id", "node_issue_id", "conclusion", "criteria_results", "checks", "verified_revision"]);
  if (!version(record) || !identifier(record.stage_execution_id) || !identifier(record.root_issue_id) ||
      !identifier(record.cycle_issue_id) || !identifier(record.node_issue_id) ||
      !["passed", "changes_required", "inconclusive", "escalate_human"].includes(record.conclusion) ||
      !Array.isArray(record.criteria_results) || !Array.isArray(record.checks) || !identifier(record.verified_revision)) return null;
  return {
    stageExecutionId: record.stage_execution_id, rootIssueId: record.root_issue_id, cycleIssueId: record.cycle_issue_id,
    nodeIssueId: record.node_issue_id, conclusion: record.conclusion, verifiedRevision: record.verified_revision, sourceIssueId,
  };
}

function decodeDelivery(record, sourceIssueId) {
  exactKeys(record, ["kind", "version", "root_issue_id", "cycle_issue_id", "verify_result_id", "verified_revision", "delivery_kind", "delivery_branch", "delivered_at"], ["pull_request"]);
  if (!version(record) || !identifier(record.root_issue_id) || !identifier(record.cycle_issue_id) ||
      !identifier(record.verify_result_id) || !identifier(record.verified_revision) ||
      !["pull_request", "remote_branch", "local_branch"].includes(record.delivery_kind) ||
      !text(record.delivery_branch) || !timestamp(record.delivered_at)) return null;
  return {
    rootIssueId: record.root_issue_id, cycleIssueId: record.cycle_issue_id, verifyResultId: record.verify_result_id,
    verifiedRevision: record.verified_revision, deliveryBranch: record.delivery_branch, deliveredAt: record.delivered_at, sourceIssueId,
  };
}

function exactStage(facts, stage, rootIssueId, cycleIssueId) {
  const execution = exact(facts.executions.filter((candidate) =>
    candidate.stage === stage && candidate.rootIssueId === rootIssueId && candidate.cycleIssueId === cycleIssueId,
  ));
  if (!execution) return null;
  const result = exact(facts.results.filter((candidate) =>
    candidate.stage === stage && candidate.rootIssueId === rootIssueId && candidate.cycleIssueId === cycleIssueId &&
    candidate.executionId === execution.stageExecutionId,
  ));
  return result ? { execution, result } : null;
}

function ambiguousStage(facts, stage, rootIssueId, cycleIssueId) {
  return facts.executions.filter((candidate) =>
    candidate.stage === stage && candidate.rootIssueId === rootIssueId && candidate.cycleIssueId === cycleIssueId,
  ).length > 1 || facts.results.filter((candidate) =>
    candidate.stage === stage && candidate.rootIssueId === rootIssueId && candidate.cycleIssueId === cycleIssueId,
  ).length > 1;
}

function matchingWorkStages(facts, rootIssueId, cycleIssueId, planContractDigest) {
  const executions = facts.executions.filter((candidate) =>
    candidate.stage === "work" && candidate.rootIssueId === rootIssueId && candidate.cycleIssueId === cycleIssueId,
  );
  if (executions.length === 0) return { kind: "inconclusive", reasonCode: "happy_path_work_stage_missing" };
  const stages = [];
  for (const execution of executions) {
    const result = exact(facts.results.filter((candidate) => candidate.executionId === execution.stageExecutionId));
    if (!result) return { kind: "inconclusive", reasonCode: "happy_path_work_result_missing" };
    if (execution.planContractDigest !== planContractDigest || result.planContractDigest !== planContractDigest ||
        result.outcomeKind !== "work_completed" || execution.nodeIssueId !== result.nodeIssueId ||
        execution.sourceIssueId !== execution.nodeIssueId || result.sourceIssueId !== result.nodeIssueId) {
      return { kind: "violated", reasonCode: "happy_path_work_result_mismatch" };
    }
    stages.push({ execution, result });
  }
  if (facts.results.filter((candidate) => candidate.rootIssueId === rootIssueId && candidate.stage === "work").length !== stages.length) {
    return { kind: "violated", reasonCode: "happy_path_work_result_ambiguous" };
  }
  return {
    kind: "ok",
    stages,
    firstStartedAt: stages.map(({ execution }) => execution.startedAt).sort()[0],
    lastCompletedAt: stages.map(({ result }) => result.completedAt).sort().at(-1),
  };
}

function interval(rootIssueId, conductorId, execution, result) {
  return Object.freeze({
    root_issue_id: rootIssueId,
    conductor_id: conductorId,
    stage: execution.stage,
    started_at: execution.startedAt,
    completed_at: result.completedAt,
    execution_ref: `linear:${rootIssueId}:stage_execution:${execution.stageExecutionId}`,
    result_ref: `linear:${rootIssueId}:stage_result:${result.resultId}`,
  });
}

function pairReferences(pair) {
  return [pair.aInterval.execution_ref, pair.aInterval.result_ref, pair.bInterval.execution_ref, pair.bInterval.result_ref].sort();
}

function intervalsOverlap(left, right) {
  return Math.max(Date.parse(left.started_at), Date.parse(right.started_at)) <
    Math.min(Date.parse(left.completed_at), Date.parse(right.completed_at));
}

function issue(tree, issueId) {
  const value = exact(tree.issues.filter((candidate) => candidate?.issue_id === issueId));
  if (!value || !identifier(value.issue_id) || (value.parent_issue_id !== null && !identifier(value.parent_issue_id)) ||
      !text(value.remote_version) || !text(value.status?.name)) return null;
  return { issueId: value.issue_id, parentIssueId: value.parent_issue_id, remoteVersion: value.remote_version, statusName: value.status.name };
}

function hasRelation(tree, sourceIssueId, targetIssueId) {
  return tree.relations.some((relation) => relation?.relation_kind === "relates_to" &&
    relation.issue_id === sourceIssueId && relation.related_issue_id === targetIssueId);
}

function validModelTurn(value, result) {
  if (!objectOrNull(value)) return false;
  exactKeys(value, ["turn_record_id", "role", "root_issue_id", "cycle_issue_id", "target_issue_id", "stage_execution_id", "role_session_id", "role_turn_id", "invocation_state", "model", "outcome", "usage", "terminal_at"]);
  return identifier(value.turn_record_id) && value.role === result.stage && value.root_issue_id === result.root_issue_id &&
    value.cycle_issue_id === result.cycle_issue_id && value.target_issue_id === result.node_issue_id &&
    identifier(value.stage_execution_id) && value.role_session_id === result.role_session_id &&
    value.role_turn_id === result.role_turn_id && value.invocation_state === "confirmed" && text(value.model) &&
    value.outcome === result.outcome_kind && validUsage(value.usage) && value.terminal_at === result.completed_at;
}

function validUsage(value) {
  if (!objectOrNull(value)) return false;
  if (value.status === "measured") {
    exactKeys(value, ["status", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]);
    return [value.input_tokens, value.cached_input_tokens, value.output_tokens, value.reasoning_output_tokens, value.total_tokens]
      .every((entry) => Number.isInteger(entry) && entry >= 0);
  }
  exactKeys(value, ["status", "reason"]);
  return value.status === "unavailable" && ["provider_omitted", "transport_lost", "process_lost", "invalid_provider_usage"].includes(value.reason);
}

function validCoverage(value) {
  if (!objectOrNull(value)) return false;
  exactKeys(value, ["is_complete", "omissions"]);
  return value.is_complete === true && Array.isArray(value.omissions) && value.omissions.length === 0;
}

function validLimits(value) {
  if (!objectOrNull(value)) return false;
  exactKeys(value, ["max_context_bytes", "max_result_bytes", "max_wall_time_ms", "max_tool_calls", "max_command_duration_ms", "reserved_total_tokens", "max_output_tokens"]);
  return Object.values(value).every((entry) => Number.isInteger(entry) && entry >= 0);
}

function requiredRecordKind(kind) {
  return ["root_ownership", "plan_contract", "plan_contract_supersession", "stage_execution", "stage_result", "human_action_request", "human_action_resolution", "verify_result", "delivery"].includes(kind);
}

function assessment(kind, reasonCode, intervals = []) {
  return Object.freeze({ outcome: outcome(kind, reasonCode), intervals: Object.freeze(intervals) });
}

function outcome(kind, reasonCode) {
  return Object.freeze({ kind, reason_code: reasonCode });
}

function exact(values) {
  return values.length === 1 ? values[0] : null;
}

function exactKeys(value, required, optional = []) {
  const actual = Object.keys(value).sort();
  const expected = [...required, ...optional].sort();
  if (actual.some((key) => !expected.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("invalid record keys");
  }
}

function object(value) {
  if (!objectOrNull(value)) throw new Error("invalid object");
  return value;
}

function objectOrNull(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value) {
  if (!Array.isArray(value)) throw new Error("invalid array");
  return value;
}

function version(value) {
  return value.version === 1;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function timestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768;
}

function textArray(value) {
  return Array.isArray(value) && value.every(text);
}

function identifierArray(value) {
  return Array.isArray(value) && value.every(identifier);
}
