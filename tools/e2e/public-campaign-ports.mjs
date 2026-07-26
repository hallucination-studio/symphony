const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const CONDUCTOR_SHORT_HASH = /^[a-f0-9]{12}$/u;
const ACTIVE_ACTION_STATUSES = new Set(["Todo", "In Progress"]);
const CASE_ROOT_COUNTS = Object.freeze({
  cross_conductor_happy_paths: 2,
  same_conductor_preemption: 2,
  conductor_restart_isolation: 3,
});

export function createPublicParallelBlackBoxCampaignPorts({
  human,
  project_id: projectId,
  routing,
  repository_contexts: repositoryContexts,
  required_write_outage: requiredWriteOutage,
  restart_conductor: restartConductor,
  readFreshEvidenceSnapshot,
  now = () => new Date(),
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  pollIntervalMs = 250,
} = {}) {
  assertInput({
    human,
    projectId,
    routing,
    repositoryContexts,
    requiredWriteOutage,
    restartConductor,
    readFreshEvidenceSnapshot,
    now,
    wait,
    pollIntervalMs,
  });
  const labelsByHash = new Map(routing.routing_labels.map((label) => [label.conductor_short_hash, label.label_id]));

  return Object.freeze({
    async createCaseRoots({ caseContext, e2eCase }) {
      const conductors = caseConductors(caseContext, e2eCase, labelsByHash);
      const count = CASE_ROOT_COUNTS[e2eCase.case_id] ?? 1;
      const routedConductors = rootConductors(e2eCase, conductors, count);
      const roots = await Promise.all(routedConductors.map(async (conductor, index) => {
        const root = await human.createRoot({
          team_id: routing.team_id,
          project_id: projectId,
          routing_label_ids: [labelsByHash.get(conductor.conductor_short_hash)],
          title: `E2E ${e2eCase.case_id} ${index + 1}`,
          description: rootDescription(e2eCase, index),
          priority: 2,
        });
        if (!root || typeof root !== "object" || !identifier(root.root_issue_id)) {
          throw stableError("parallel_black_box_public_root_create_invalid");
        }
        return root.root_issue_id;
      }));
      if (e2eCase.human_script_id === "required_write_outage") {
        try {
          requiredWriteOutage.arm({ root_issue_id: roots[0] });
        } catch {
          throw stableError("parallel_black_box_public_outage_arm_failed");
        }
      }
      return Object.freeze({ root_issue_ids: Object.freeze(roots) });
    },
    async waitForHumanAction({ caseContext, e2eCase, root_issue_id: rootIssueId, action_kind: actionKind }) {
      if (!identifier(rootIssueId) || actionKind !== "plan_review") throw stableError("parallel_black_box_public_action_input_invalid");
      return pollFor({
        caseContext,
        e2eCase,
        rootIssueId,
        repositoryContexts,
        readFreshEvidenceSnapshot,
        now,
        wait,
        pollIntervalMs,
        select: (tree) => activePlanReviewAction(tree, rootIssueId),
        unavailableCode: "parallel_black_box_public_human_action_unavailable",
      });
    },
    async waitForInFlightStage({ caseContext, e2eCase, root_issue_id: rootIssueId }) {
      if (!identifier(rootIssueId)) throw stableError("parallel_black_box_public_stage_input_invalid");
      return pollFor({
        caseContext,
        e2eCase,
        rootIssueId,
        repositoryContexts,
        readFreshEvidenceSnapshot,
        now,
        wait,
        pollIntervalMs,
        select: (tree) => inFlightStage(tree, rootIssueId),
        unavailableCode: "parallel_black_box_public_stage_unavailable",
      });
    },
    async waitForRootReconcilerReply({ caseContext, e2eCase, root_issue_id: rootIssueId, comment_id: commentId, thread_state: threadState }) {
      if (!identifier(rootIssueId) || !identifier(commentId) || !["resolved", "unresolved"].includes(threadState)) {
        throw stableError("parallel_black_box_public_reply_input_invalid");
      }
      await pollFor({
        caseContext,
        e2eCase,
        rootIssueId,
        repositoryContexts,
        readFreshEvidenceSnapshot,
        now,
        wait,
        pollIntervalMs,
        select: (tree) => reconcilerReply(tree, commentId, threadState),
        unavailableCode: "parallel_black_box_public_reconciler_reply_unavailable",
      });
    },
    async restartConductor({ caseContext, e2eCase, root_issue_id: rootIssueId }) {
      const conductors = caseConductors(caseContext, e2eCase, labelsByHash);
      if (e2eCase.human_script_id !== "restart_conductor" || !identifier(rootIssueId) || conductors.length !== 3) {
        throw stableError("parallel_black_box_public_restart_input_invalid");
      }
      try {
        await restartConductor(conductors[0].conductor_id);
      } catch {
        throw stableError("parallel_black_box_public_restart_failed");
      }
    },
    async waitForRequiredWriteOutage({ root_issue_id: rootIssueId }) {
      if (!identifier(rootIssueId)) throw stableError("parallel_black_box_public_outage_input_invalid");
      try {
        await requiredWriteOutage.waitUntilBlocked({ root_issue_id: rootIssueId });
      } catch {
        throw stableError("parallel_black_box_public_outage_wait_failed");
      }
    },
    async restoreRequiredWriteOutage({ root_issue_id: rootIssueId }) {
      if (!identifier(rootIssueId)) throw stableError("parallel_black_box_public_outage_input_invalid");
      try {
        requiredWriteOutage.restore({ root_issue_id: rootIssueId });
      } catch {
        throw stableError("parallel_black_box_public_outage_restore_failed");
      }
    },
    async readFreshEvidenceSnapshot({ caseContext, e2eCase, caseRoots }) {
      const conductors = caseConductors(caseContext, e2eCase, labelsByHash);
      if (!caseRoots || !Array.isArray(caseRoots.root_issue_ids) || !caseRoots.root_issue_ids.every(identifier)) {
        throw stableError("parallel_black_box_public_final_evidence_input_invalid");
      }
      return readFreshEvidenceSnapshot({
        root_issue_ids: caseRoots.root_issue_ids,
        repository_contexts: contextsFor(conductors, repositoryContexts),
      });
    },
  });
}

function pollFor({
  caseContext,
  e2eCase,
  rootIssueId,
  repositoryContexts,
  readFreshEvidenceSnapshot,
  now,
  wait,
  pollIntervalMs,
  select,
  unavailableCode,
}) {
  const deadline = Date.parse(e2eCase?.deadline_at);
  if (!Number.isFinite(deadline)) throw stableError("parallel_black_box_public_poll_input_invalid");
  return (async () => {
    while (now().getTime() < deadline) {
      const conductors = caseConductors(caseContext, e2eCase);
      const snapshot = await readSnapshot({
        rootIssueIds: [rootIssueId],
        repositoryContexts: contextsFor(conductors, repositoryContexts),
        readFreshEvidenceSnapshot,
      });
      if (snapshot?.kind === "complete") {
        const result = select(snapshot.root_trees?.[0]);
        if (result !== undefined) return result;
      }
      await wait(Math.min(pollIntervalMs, Math.max(1, deadline - now().getTime())));
    }
    throw stableError(unavailableCode);
  })();
}

async function readSnapshot({ rootIssueIds, repositoryContexts, readFreshEvidenceSnapshot }) {
  try {
    return await readFreshEvidenceSnapshot({
      root_issue_ids: rootIssueIds,
      repository_contexts: repositoryContexts,
    });
  } catch {
    return undefined;
  }
}

function activePlanReviewAction(tree, rootIssueId) {
  if (!tree || tree.root_issue_id !== rootIssueId || !Array.isArray(tree.issues) || !Array.isArray(tree.managed_blocks)) return undefined;
  const requests = tree.managed_blocks.map(({ record }) => record).filter((record) => record?.kind === "human_action_request" &&
    record.root_issue_id === rootIssueId && record.action_kind === "plan_review" && identifier(record.action_issue_id));
  if (requests.length !== 1) return undefined;
  const action = tree.issues.find((issue) => issue?.issue_id === requests[0].action_issue_id);
  if (!action || action.is_archived === true || !ACTIVE_ACTION_STATUSES.has(action.status?.name) ||
      !Array.isArray(action.labels) || !action.labels.some(({ name }) => name === "Human Action") ||
      !action.labels.some(({ name }) => name === "Plan Review")) return undefined;
  return Object.freeze({ human_action_issue_id: action.issue_id });
}

function inFlightStage(tree, rootIssueId) {
  if (!tree || tree.root_issue_id !== rootIssueId || !Array.isArray(tree.managed_blocks)) return undefined;
  const records = tree.managed_blocks.map(({ record }) => record);
  const completed = new Set(records.filter((record) => record?.kind === "stage_result" && identifier(record.stage_execution_id))
    .map(({ stage_execution_id: stageExecutionId }) => stageExecutionId));
  const executions = records.filter((record) => record?.kind === "stage_execution" && record.root_issue_id === rootIssueId &&
    identifier(record.stage_execution_id) && !completed.has(record.stage_execution_id));
  if (executions.length !== 1) return undefined;
  return Object.freeze({ stage_execution_id: executions[0].stage_execution_id });
}

function reconcilerReply(tree, commentId, threadState) {
  if (!tree || !Array.isArray(tree.comments) || !Array.isArray(tree.managed_blocks)) return undefined;
  const comment = tree.comments.find((entry) => entry?.comment_id === commentId && entry.thread_state === threadState);
  if (!comment) return undefined;
  const replies = tree.managed_blocks.map(({ record }) => record).filter((record) => record?.kind === "root_reconciler_reply" &&
    record.source?.kind === "comment_thread_state" && record.source.comment_id === commentId && record.source.thread_state === threadState);
  return replies.length === 1 ? Object.freeze({}) : undefined;
}

function caseConductors(caseContext, e2eCase, labelsByHash) {
  if (!caseContext || typeof caseContext !== "object" || !Array.isArray(caseContext.conductors) ||
      !e2eCase || !Array.isArray(e2eCase.routed_conductor_ids) ||
      !identifier(caseContext.project_id) ||
      caseContext.conductors.length !== e2eCase.routed_conductor_ids.length ||
      !caseContext.conductors.every((conductor, index) => validConductor(conductor) &&
        conductor.conductor_id === e2eCase.routed_conductor_ids[index] &&
        (labelsByHash === undefined || labelsByHash.has(conductor.conductor_short_hash)))) {
    throw stableError("parallel_black_box_public_case_context_invalid");
  }
  return caseContext.conductors;
}

function rootConductors(e2eCase, conductors, count) {
  if (count === 1) return [conductors[0]];
  if (e2eCase.case_id === "same_conductor_preemption") return [conductors[0], conductors[0]];
  if (conductors.length !== count) throw stableError("parallel_black_box_public_case_context_invalid");
  return conductors;
}

function contextsFor(conductors, repositoryContexts) {
  const byIdentity = new Map(repositoryContexts.map((context) => [context.repository_identity, context]));
  const contexts = conductors.map(({ repository_identity: repositoryIdentity }) => byIdentity.get(repositoryIdentity));
  if (contexts.some((context) => context === undefined)) throw stableError("parallel_black_box_public_repository_context_invalid");
  return contexts;
}

function rootDescription(e2eCase, index) {
  const scope = e2eCase.human_script_id === "exhaust_cycle_budget"
    ? "Make the requested change, then leave one real verification failure for the Cycle to diagnose and repair."
    : "Make one small repository-local documentation change, run the relevant checks, and prepare it for delivery.";
  return `Parallel Black-Box E2E case ${e2eCase.case_id}, Root ${index + 1}. ${scope}`;
}

function assertInput({ human, projectId, routing, repositoryContexts, requiredWriteOutage, restartConductor, readFreshEvidenceSnapshot, now, wait, pollIntervalMs }) {
  if (!human || typeof human.createRoot !== "function" || !identifier(projectId) || !validRouting(routing) ||
      !Array.isArray(repositoryContexts) || repositoryContexts.length < 3 || !repositoryContexts.every(validRepositoryContext) ||
      !requiredWriteOutage || typeof requiredWriteOutage.arm !== "function" || typeof requiredWriteOutage.waitUntilBlocked !== "function" ||
      typeof requiredWriteOutage.restore !== "function" || typeof restartConductor !== "function" ||
      typeof readFreshEvidenceSnapshot !== "function" || typeof now !== "function" || typeof wait !== "function" ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw stableError("parallel_black_box_public_ports_input_invalid");
  }
}

function validRouting(value) {
  return value && typeof value === "object" && identifier(value.team_id) && Array.isArray(value.routing_labels) &&
    value.routing_labels.length >= 3 && value.routing_labels.every((label) => label && CONDUCTOR_SHORT_HASH.test(label.conductor_short_hash) && identifier(label.label_id)) &&
    new Set(value.routing_labels.map(({ conductor_short_hash: hash }) => hash)).size === value.routing_labels.length;
}

function validRepositoryContext(value) {
  return value && typeof value === "object" && identifier(value.repository_identity) &&
    typeof value.repository_root === "string" && value.repository_root.length > 0 &&
    typeof value.base_branch === "string" && value.base_branch.length > 0;
}

function validConductor(value) {
  return value && typeof value === "object" && identifier(value.conductor_id) &&
    CONDUCTOR_SHORT_HASH.test(value.conductor_short_hash) && identifier(value.repository_identity);
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
