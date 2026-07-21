import { createHash } from "node:crypto";

const RECORD_PREFIX = "<!-- symphony managed-record\n";
const RECORD_SUFFIX = "\n-->";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const ACTIVE_CYCLE_STATES = new Set([
  "Draft", "Planning", "Sealed", "Executing", "Verifying", "Inconclusive", "Escalated",
]);

export function projectTargetWorkflowFacts(snapshot) {
  const input = validateSnapshot(snapshot);
  const issues = new Map(input.issues.map((issue) => [issue.id, issue]));
  const records = parseRecords(input.comments);
  const root = issues.get(input.rootIssueId);
  const cycles = input.issues.filter((issue) => issue.kind === "cycle" && issue.parentIssueId === input.rootIssueId);
  if (!root || root.kind !== "root" || root.projectId !== input.projectId || cycles.length !== 1) {
    throw new Error("target_facts_cycle_invalid");
  }
  const cycle = cycles[0];
  const cycleRecords = records.filter(({ issueId }) => issueId === cycle.id);
  const cycleMarker = one(cycleRecords, "cycle_marker");
  if (cycleMarker.root_issue_id !== input.rootIssueId || cycleMarker.cycle_key !== cycle.id ||
      !isSha(cycleMarker.baseline_revision)) {
    throw new Error("target_facts_cycle_invalid");
  }
  const planIssues = input.issues.filter((issue) => issue.kind === "plan" && issue.parentIssueId === cycle.id);
  const workIssues = input.issues.filter((issue) => issue.kind === "work" && issue.parentIssueId === cycle.id);
  const verifyIssues = input.issues.filter((issue) => issue.kind === "verify" && issue.parentIssueId === cycle.id);
  if (planIssues.length !== 1 || verifyIssues.length !== 1 || workIssues.length < 1) {
    throw new Error("target_facts_dag_incomplete");
  }
  const plan = planIssues[0];
  const verify = verifyIssues[0];
  const planRecords = records.filter(({ issueId }) => issueId === plan.id);
  const planContract = one(planRecords, "plan_contract");
  if (planContract.root_issue_id !== input.rootIssueId || planContract.cycle_issue_id !== cycle.id ||
      !isDigest(planContract.plan_contract_digest) ||
      !Array.isArray(planContract.work_nodes) ||
      !planContract.work_nodes.every((node) => isSafeId(node?.work_key)) ||
      new Set(planContract.work_nodes.map((node) => node.work_key)).size !== planContract.work_nodes.length ||
      new Set(planContract.work_nodes.map((node) => node.work_key)).size !== workIssues.length ||
      !workIssues.every((issue) => planContract.work_nodes.some((node) =>
        node.work_key === (issue.nodeKey ?? issue.id)))) {
    throw new Error("target_facts_plan_invalid");
  }
  const workKeys = new Map(workIssues.map((issue) => [issue.id, issue.nodeKey ?? issue.id]));
  const approval = records.filter(({ issueId, record }) => issueId === input.rootIssueId &&
    record.kind === "human_action" && record.request_kind === "needs_approval");
  const planStage = records.find(({ record }) => record.kind === "stage_execution" &&
    record.stage === "plan" && record.node_issue_id === plan.id);
  if (approval.length === 1 && (!planStage || !sameCorrelation(approval[0].record, {
    root_issue_id: input.rootIssueId,
    cycle_issue_id: cycle.id,
    node_issue_id: plan.id,
    stage: "plan",
    context_digest: planStage.record.context_digest,
  }))) {
    throw new Error("target_facts_human_action_invalid");
  }
  const stages = records.filter(({ record }) => record.kind === "stage_execution");
  const terminals = records.filter(({ record }) => record.kind === "stage_terminal");
  const completions = records.filter(({ record }) => record.kind === "work_completion");
  const results = records.filter(({ record }) => record.kind === "verify_result");
  const stageExecutions = stages.map(({ issueId, record }) => stageEvidence(
    issueId, record, terminals, completions, results, input, cycle.id, plan.id, workIssues, verify.id,
    planContract.plan_contract_digest, workKeys,
  ));
  if (stageExecutions.filter(({ stage }) => stage === "plan").length !== 1 ||
      stageExecutions.filter(({ stage }) => stage === "verify").length !== 1 ||
      stageExecutions.filter(({ stage }) => stage === "work").length < 1) {
    throw new Error("target_facts_stage_shape_invalid");
  }
  const verifyResult = one(records.filter(({ issueId }) => issueId === verify.id), "verify_result");
  const delivery = oneOptional(records.filter(({ issueId }) => issueId === input.rootIssueId), "delivery");
  const verifyStage = stageExecutions.find((stage) => stage.stage === "verify" && stage.nodeIssueId === verify.id);
  if (!verifyStage || verifyResult.stage_execution_id !== verifyStage.executionId ||
      verifyResult.verified_revision !== input.git.head) {
    throw new Error("target_facts_delivery_revision_mismatch");
  }
  if (delivery && (delivery.root_issue_id !== input.rootIssueId || delivery.cycle_issue_id !== cycle.id ||
      delivery.verified_revision !== input.git.head ||
      delivery.verify_result_id !== verifyResult.stage_execution_id ||
      delivery.delivery_branch !== input.git.branch)) {
    throw new Error("target_facts_delivery_revision_mismatch");
  }
  const workStages = stageExecutions.filter((stage) => stage.stage === "work");
  const workIds = workIssues.map(({ id }) => id);
  if (!workIds.every((id) => workStages.some((stage) => stage.nodeIssueId === id))) {
    throw new Error("target_facts_work_incomplete");
  }
  const repairEscalation = projectRepairEscalation(
    records, input.rootIssueId, verify.id, verifyStage.executionId,
  );
  return Object.freeze({
    root: Object.freeze({
      projectId: input.projectId,
      rootIssueId: input.rootIssueId,
      cycleIssueId: cycle.id,
      planIssueId: plan.id,
      planContractDigest: planContract.plan_contract_digest,
      finalVerifyId: verifyStage.executionId,
      stageContextDigests: Object.freeze({
        plan: stageExecutions.find((stage) => stage.stage === "plan")?.contextDigest,
        work: Object.freeze(Object.fromEntries(workStages.map((stage) => [stage.nodeIssueId, stage.contextDigest]))),
        verify: verifyStage.contextDigest,
      }),
    }),
    plan: Object.freeze({
      approved: plan.state === "Done" && approval.length === 1,
      dagSealed: planContract.work_nodes.length === workIssues.length &&
        exactDag(input.relations, plan.id, workIssues.map(({ id }) => id), verify.id),
      workNodeIds: Object.freeze(workIds),
      verifyNodeIds: Object.freeze([verify.id]),
    }),
    stageExecutions: Object.freeze(stageExecutions),
    progress: Object.freeze({
      completedWorkNodes: workStages.filter((stage) => stage.result === "completed").length,
      sourceExecutionIds: Object.freeze(workStages.filter((stage) => stage.result === "completed").map((stage) => stage.executionId)),
    }),
    ...(repairEscalation ? { repairEscalation } : {}),
    ...(delivery ? { delivery: projectDelivery(delivery, verifyResult) } : {}),
  });
}

export function projectTargetWorkflowPendingHuman(snapshot) {
  const input = validateSnapshot(snapshot);
  const issues = new Map(input.issues.map((issue) => [issue.id, issue]));
  const root = issues.get(input.rootIssueId);
  if (!root || root.kind !== "root") throw new Error("target_facts_root_invalid");
  const expectedRequestKind = root.state === "Needs Approval"
    ? "needs_approval"
    : root.state === "Needs Info"
      ? "needs_info"
      : undefined;
  if (!expectedRequestKind) return Object.freeze({ status: "not_waiting" });
  const activeCycles = input.issues.filter((issue) => issue.kind === "cycle" &&
    issue.parentIssueId === input.rootIssueId && ACTIVE_CYCLE_STATES.has(issue.state));
  if (activeCycles.length !== 1) throw new Error("target_facts_human_cycle_invalid");
  const currentCycle = activeCycles[0];
  const records = parseRecords(input.comments);
  const actions = records.filter(({ issueId, record }) => issueId === input.rootIssueId &&
    record.kind === "human_action");
  if (actions.length !== 1) {
    throw new Error(actions.length > 1
      ? "target_facts_duplicate_human_action"
      : "target_facts_human_action_missing");
  }
  const action = actions[0].record;
  if (action.request_kind !== expectedRequestKind) {
    throw new Error("target_facts_human_state_invalid");
  }
  const cycle = issues.get(action.cycle_issue_id);
  if (!cycle || cycle.id !== currentCycle.id) {
    throw new Error("target_facts_human_cycle_invalid");
  }
  const node = issues.get(action.node_issue_id);
  if (cycle.kind !== "cycle" || cycle.parentIssueId !== input.rootIssueId ||
      !node || node.parentIssueId !== cycle.id ||
      !["plan", "work", "verify"].includes(node.kind) ||
      !isSafeId(action.action_id) || !isSafeId(action.node_issue_id) ||
      !isDigest(action.context_digest) || action.root_issue_id !== input.rootIssueId ||
      action.cycle_issue_id !== cycle.id || action.node_issue_id !== node.id) {
    throw new Error("target_facts_human_action_invalid");
  }
  if (node.kind === "plan" && node.state !== "In Review" ||
      node.kind !== "plan" && !["In Progress", "In Review"].includes(node.state)) {
    throw new Error("target_facts_human_node_state_invalid");
  }
  return Object.freeze({
    status: "waiting",
    rootIssueId: input.rootIssueId,
    cycleIssueId: cycle.id,
    nodeIssueId: node.id,
    requestKind: action.request_kind,
    actionId: action.action_id,
    contextDigest: action.context_digest,
  });
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.issues) ||
      !Array.isArray(snapshot.comments) || !Array.isArray(snapshot.relations) ||
      typeof snapshot.git?.head !== "string" || typeof snapshot.git?.branch !== "string" ||
      !isSha(snapshot.git.head) || !isSafeId(snapshot.git.branch) || typeof snapshot.rootIssueId !== "string" ||
      typeof snapshot.projectId !== "string") {
    throw new Error("target_facts_snapshot_invalid");
  }
  if (new Set(snapshot.issues.map((issue) => issue?.id)).size !== snapshot.issues.length) {
    throw new Error("target_facts_issue_duplicate");
  }
  if (!isSafeId(snapshot.rootIssueId) || !isSafeId(snapshot.projectId) ||
      !snapshot.issues.every((issue) => isSafeId(issue?.id) &&
        issue.projectId === snapshot.projectId &&
        ["root", "cycle", "plan", "work", "verify"].includes(issue.kind) &&
        (issue.nodeKey === undefined || isSafeId(issue.nodeKey)) &&
        (issue.parentIssueId === undefined || isSafeId(issue.parentIssueId)))) {
    throw new Error("target_facts_issue_invalid");
  }
  const issueIds = new Set(snapshot.issues.map((issue) => issue.id));
  if (!snapshot.comments.every((comment) => comment && isSafeId(comment.issueId) &&
      issueIds.has(comment.issueId))) {
    throw new Error("target_facts_record_issue_invalid");
  }
  if (!snapshot.relations.every((relation) => relation && relation.relationKind === "blocks" &&
      isSafeId(relation.sourceIssueId) && isSafeId(relation.targetIssueId) &&
      issueIds.has(relation.sourceIssueId) && issueIds.has(relation.targetIssueId))) {
    throw new Error("target_facts_relation_invalid");
  }
  return snapshot;
}

function parseRecords(comments) {
  const seen = new Set();
  return comments.map((comment) => {
    if (!comment || typeof comment.issueId !== "string" || typeof comment.id !== "string" ||
        !isSafeId(comment.id) ||
        seen.has(comment.id)) throw new Error("target_facts_duplicate_record");
    seen.add(comment.id);
    if (typeof comment.body !== "string" || !comment.body.startsWith(RECORD_PREFIX) ||
        !comment.body.endsWith(RECORD_SUFFIX)) throw new Error("target_facts_record_invalid");
    let record;
    try { record = JSON.parse(comment.body.slice(RECORD_PREFIX.length, -RECORD_SUFFIX.length)); } catch {
      throw new Error("target_facts_record_invalid");
    }
    if (!record || typeof record !== "object" || record.version !== 1 || ![
      "cycle_marker", "plan_contract", "stage_execution", "stage_terminal", "work_completion",
      "human_action", "verify_result", "delivery", "finding", "finding_disposition",
      "progress_assessment", "convergence",
    ].includes(record.kind)) {
      throw new Error("target_facts_record_invalid");
    }
    return { issueId: comment.issueId, record };
  });
}

function projectRepairEscalation(records, rootIssueId, verifyIssueId, verifyExecutionId) {
  const findings = records.filter(({ issueId, record }) => issueId === verifyIssueId &&
    record.kind === "finding" && record.source_verify_id === verifyExecutionId);
  const dispositions = records.filter(({ issueId, record }) => issueId === verifyIssueId &&
    record.kind === "finding_disposition" && record.source_verify_id === verifyExecutionId);
  const convergenceRecords = records
    .filter(({ issueId, record }) => issueId === rootIssueId && record.kind === "convergence")
    .map(({ record }) => record)
    .sort((left, right) => String(left.observed_at).localeCompare(String(right.observed_at)));
  const convergence = convergenceRecords.at(-1);
  if (!convergence || convergence.decision !== "escalate") return undefined;
  if (findings.length !== 1 || dispositions.length !== 1 ||
      dispositions[0].record.finding_id !== findings[0].record.finding_id ||
      dispositions[0].record.disposition !== "still_open") {
    throw new Error("target_facts_repair_correlation_invalid");
  }
  const view = convergence.view;
  const policy = convergence.policy;
  if (convergence.version !== 1 || convergence.root_issue_id !== rootIssueId ||
      !isSafeId(findings[0].record.finding_id) || !isSafeId(findings[0].record.source_verify_id) ||
      !Number.isSafeInteger(view?.cycle_count) || !Number.isSafeInteger(policy?.max_cycles_per_root) ||
      view.cycle_count < policy.max_cycles_per_root ||
      !Array.isArray(view.open_finding_persistence) ||
      !view.open_finding_persistence.some((entry) => entry?.finding_id === findings[0].record.finding_id &&
        Number.isSafeInteger(entry.open_cycle_count) && entry.open_cycle_count > 0)) {
    throw new Error("target_facts_repair_breaker_invalid");
  }
  return Object.freeze({
    findingId: findings[0].record.finding_id,
    sourceVerifyId: verifyIssueId,
    disposition: "escalated",
    breaker: Object.freeze({
      checked: true,
      decision: "escalate",
      cycleCount: view.cycle_count,
      maxCycles: policy.max_cycles_per_root,
      openFindingCount: view.open_finding_persistence.filter((entry) =>
        Number.isSafeInteger(entry?.open_cycle_count) && entry.open_cycle_count > 0).length,
    }),
  });
}

function stageEvidence(issueId, record, terminals, completions, results, input, cycleIssueId, planIssueId, workIssues, verifyIssueId, planContractDigest, workKeys) {
  const expectedNodeIds = new Set([planIssueId, ...workIssues.map(({ id }) => id), verifyIssueId]);
  if (!["plan", "work", "verify"].includes(record.stage) || !isSafeId(record.stage_execution_id) ||
      !isDigest(record.context_digest) || !isSha(record.repository_revision) ||
      (record.stage === "plan" && record.node_issue_id !== planIssueId) ||
      (record.stage === "verify" && record.node_issue_id !== verifyIssueId) ||
      (record.stage === "work" && !workIssues.some(({ id }) => id === record.node_issue_id)) ||
      !isSafeId(record.node_issue_id)) {
    throw new Error("target_facts_stage_invalid");
  }
  if (record.root_issue_id !== input.rootIssueId || record.cycle_issue_id !== cycleIssueId ||
      record.node_issue_id !== issueId || !expectedNodeIds.has(record.node_issue_id)) {
    throw new Error("target_facts_stage_correlation_invalid");
  }
  if (record.stage !== "plan" && record.plan_contract_digest === undefined) {
    throw new Error("target_facts_stage_invalid");
  }
  if (record.stage === "plan" && record.plan_contract_digest !== undefined) {
    throw new Error("target_facts_stage_invalid");
  }
  if (record.stage !== "plan" && !isDigest(record.plan_contract_digest)) {
    throw new Error("target_facts_stage_invalid");
  }
  if (record.stage !== "plan" && record.plan_contract_digest !== planContractDigest) {
    throw new Error("target_facts_stage_invalid");
  }
  const terminal = oneMatching(terminals, record.stage_execution_id);
  const completion = oneOptionalMatching(completions, record.stage_execution_id);
  const result = oneOptionalMatching(results, record.stage_execution_id);
  if (!terminal || terminal.issueId !== record.node_issue_id || !sameCorrelation(record, terminal.record) ||
      terminal.record.context_digest !== record.context_digest ||
      terminal.record.outcome !== "completed") {
    throw new Error("target_facts_stage_correlation_invalid");
  }
  if (record.stage === "work" && (!completion || completion.record.context_digest !== record.context_digest ||
      completion.issueId !== record.node_issue_id || !sameCorrelation(record, completion.record) ||
      !isSha(completion.record.commit_revision) || completion.record.work_key !== workKeys.get(record.node_issue_id))) {
    throw new Error("target_facts_work_completion_invalid");
  }
  if (record.stage === "verify" && (!result || result.record.stage_execution_id !== record.stage_execution_id ||
      result.issueId !== record.node_issue_id || !sameCorrelation(record, result.record) ||
      !isSha(result.record.verified_revision) || result.record.verified_revision !== record.repository_revision)) {
    throw new Error("target_facts_verify_result_invalid");
  }
  const gitHead = record.stage === "work" ? completion.record.commit_revision :
    record.stage === "verify" ? result.record.verified_revision : record.repository_revision;
  return Object.freeze({
    executionId: record.stage_execution_id,
    rootIssueId: record.root_issue_id,
    cycleIssueId: record.cycle_issue_id,
    nodeIssueId: record.node_issue_id,
    stage: record.stage,
    contextDigest: record.context_digest,
    resultDigest: hash(result ?? completion ?? terminal.record),
    gitHead,
    result: terminal.record.outcome,
    freshContextId: record.stage_execution_id,
  });
}

function projectDelivery(record, verifyResult) {
  if (!["local_branch", "remote_branch", "pull_request"].includes(record.delivery_kind) ||
      !isSafeId(record.root_issue_id) || !isSafeId(record.cycle_issue_id) ||
      !isSafeId(record.verify_result_id) || !isSha(record.verified_revision) ||
      !isSafeId(record.delivery_branch)) throw new Error("target_facts_delivery_invalid");
  return Object.freeze({
    kind: record.delivery_kind,
    branch: record.delivery_branch,
    head: record.verified_revision,
    verifiedAgainst: verifyResult.node_issue_id,
    readBack: true,
  });
}

function sameCorrelation(left, right) {
  return left.root_issue_id === right.root_issue_id &&
    left.cycle_issue_id === right.cycle_issue_id &&
    left.node_issue_id === right.node_issue_id &&
    (left.stage === undefined || right.stage === undefined || left.stage === right.stage) &&
    (left.context_digest === undefined || right.context_digest === undefined ||
      left.context_digest === right.context_digest);
}

function exactDag(relations, planIssueId, workIssueIds, verifyIssueId) {
  const expected = [
    ...workIssueIds.map((issueId) => `${planIssueId}:blocks:${issueId}`),
    ...workIssueIds.map((issueId) => `${issueId}:blocks:${verifyIssueId}`),
  ];
  const actual = relations.map((relation) =>
    `${relation.sourceIssueId}:${relation.relationKind}:${relation.targetIssueId}`);
  return actual.length === expected.length && new Set(actual).size === actual.length &&
    expected.every((key) => actual.includes(key));
}

function one(values, kind) {
  const matches = values.filter(({ record }) => record.kind === kind).map(({ record }) => record);
  if (matches.length !== 1) throw new Error(matches.length > 1 ? "target_facts_duplicate_record" : `target_facts_${kind}_missing`);
  return matches[0];
}

function oneOptional(values, kind) {
  const matches = values.filter(({ record }) => record.kind === kind).map(({ record }) => record);
  if (matches.length > 1) throw new Error("target_facts_duplicate_record");
  return matches[0];
}

function oneMatching(values, executionId) {
  const matches = values.filter(({ record }) => record.stage_execution_id === executionId);
  if (matches.length !== 1) throw new Error(matches.length > 1 ? "target_facts_duplicate_record" : "target_facts_stage_terminal_missing");
  return matches[0];
}

function oneOptionalMatching(values, executionId) {
  const matches = values.filter(({ record }) => record.stage_execution_id === executionId);
  if (matches.length > 1) throw new Error("target_facts_duplicate_record");
  return matches[0];
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isSha(value) {
  return typeof value === "string" && SHA.test(value);
}

function isDigest(value) {
  return typeof value === "string" && DIGEST.test(value);
}
