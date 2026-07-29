import { createHash } from "node:crypto";

import {
  InternalLinearError,
  LinearClient,
  NetworkLinearError,
  RatelimitedLinearError,
} from "@linear/sdk";

import { FOREGROUND_E2E_CASES } from "./cases.mjs";
import { readAllLinearNodes } from "./linear-environment.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const HUMAN_ACTION_HEADINGS = Object.freeze({
  planApproval: "## 需要你审批",
  information: "## 需要你补充信息",
});
const PREEMPTION_CORE_ROOT_KEYS = new Set(
  FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "same_conductor_preemption")
    ?.declaredUserInteractions.find(({ kind }) => kind === "bind_preemption_roles")?.rootKeys ?? [],
);
export const HUMAN_ACTION_POLL_INTERVAL_MS = 5_000;
export const HUMAN_LINEAR_REQUEST_INTERVAL_MS = 1_500;

export function createHumanLinearRequestBudget({
  now = () => Date.now(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof now !== "function" || typeof wait !== "function") {
    throw stableError("foreground_e2e_human_request_budget_input_invalid");
  }
  let tail = Promise.resolve();
  let nextRequestAt = Number.NEGATIVE_INFINITY;
  return Object.freeze({
    execute(operation, signal = undefined) {
      if (typeof operation !== "function" || signal !== undefined && !abortSignal(signal)) {
        return Promise.reject(stableError("foreground_e2e_human_request_budget_input_invalid"));
      }
      const request = tail.then(async () => {
        if (signal?.aborted) throw abortedRequestError();
        const currentTime = now();
        if (!Number.isFinite(currentTime)) throw stableError("foreground_e2e_human_request_budget_clock_invalid");
        const waitMilliseconds = Math.max(0, nextRequestAt - currentTime);
        if (waitMilliseconds > 0) await abortable(() => wait(waitMilliseconds), signal);
        if (signal?.aborted) throw abortedRequestError();
        const startTime = now();
        if (!Number.isFinite(startTime)) throw stableError("foreground_e2e_human_request_budget_clock_invalid");
        nextRequestAt = startTime + HUMAN_LINEAR_REQUEST_INTERVAL_MS;
        return abortable(operation, signal);
      });
      tail = request.then(() => undefined, () => undefined);
      return request;
    },
  });
}

function budgetHumanLinearClient(client, requestBudget, signal = undefined) {
  if (!client || typeof client !== "object") {
    throw stableError("foreground_e2e_human_actor_client_invalid");
  }
  return budgetHumanLinearValue(client, requestBudget, signal, new WeakMap());
}

function budgetHumanLinearValue(value, requestBudget, signal, wrappers) {
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => budgetHumanLinearValue(item, requestBudget, signal, wrappers));
  const existing = wrappers.get(value);
  if (existing) return existing;
  const wrapper = new Proxy(value, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== "function") {
        return budgetHumanLinearValue(member, requestBudget, signal, wrappers);
      }
      return (...arguments_) => requestBudget.execute(
        async () => budgetHumanLinearValue(await member.apply(target, arguments_), requestBudget, signal, wrappers),
        signal,
      );
    },
  });
  wrappers.set(value, wrapper);
  return wrapper;
}

export async function createForegroundE2EHumanActor({
  apiKey,
  expectedActorId,
  delegateActorId,
  createClient = (options) => new LinearClient(options),
  requestBudget = createHumanLinearRequestBudget(),
} = {}) {
  if (!token(apiKey) || !identifier(expectedActorId) || typeof createClient !== "function" ||
      !requestBudget || typeof requestBudget.execute !== "function") {
    throw stableError("foreground_e2e_human_actor_input_invalid");
  }
  let rawClient;
  try {
    rawClient = createClient({ apiKey });
  } catch {
    throw stableError("foreground_e2e_human_actor_client_invalid");
  }
  const actorId = await readActorId(rawClient);
  if (actorId !== expectedActorId) throw stableError("foreground_e2e_human_actor_identity_invalid");
  const client = budgetHumanLinearClient(rawClient, requestBudget);
  const clientForCase = (signal) => {
    if (signal === undefined) return client;
    if (!abortSignal(signal)) throw stableError("foreground_e2e_human_operation_input_invalid");
    if (signal.aborted) throw stableError("foreground_e2e_human_linear_request_aborted");
    try {
      return budgetHumanLinearClient(createClient({ apiKey, signal }), requestBudget, signal);
    } catch {
      throw stableError("foreground_e2e_human_actor_client_invalid");
    }
  };

  const rootCatalog = rootCatalogByKey();
  const roots = new Map();
  const createdRootKeys = new Set();
  const comments = new Map();
  const receiptInputs = new Map();
  return Object.freeze({
    actorId,
    async resolveFocusedRootCreationBinding({ rootKey, teamId, projectId, conductor } = {}) {
      if (!identifier(rootKey) || !rootCatalog.has(rootKey) || !identifier(teamId) || !identifier(projectId) ||
          !conductor || typeof conductor.conductorRef !== "string" || conductor.conductorRef.length === 0 ||
          !identifier(conductor.conductorId) || !shortHash(conductor.conductorShortHash) ||
          !identifier(conductor.performerProfileId) || !directory(conductor.worktreeDirectory)) {
        throw stableError("foreground_e2e_human_root_binding_input_invalid");
      }
      const statuses = await readTeamStatuses(client, teamId, "foreground_e2e_human_root_binding_read_failed");
      const todo = statuses.filter((state) => state.name === "Todo" && state.type === "unstarted");
      if (todo.length !== 1) throw stableError("foreground_e2e_human_root_binding_read_failed");
      const [rootLabel, routingLabel] = await Promise.all([
        readIssueLabel({ client, teamId, name: "symphony:kind/root" }),
        readIssueLabel({ client, teamId, name: `symphony:conductor/${conductor.conductorShortHash}` }),
      ]);
      return Object.freeze({
        teamId,
        projectId,
        rootLabelId: rootLabel.id,
        routingLabelId: routingLabel.id,
        rootStatusId: todo[0].id,
        conductorId: conductor.conductorId,
        performerProfileId: conductor.performerProfileId,
        worktreeDirectory: conductor.worktreeDirectory,
      });
    },
    async resolveRootCreationBindings({ teamId, projectId, conductors } = {}) {
      const resolvedConductors = assertConductorBindings({ teamId, projectId, conductors });
      const statuses = await readTeamStatuses(client, teamId, "foreground_e2e_human_root_binding_read_failed");
      const todo = statuses.filter((state) => state.name === "Todo" && state.type === "unstarted");
      if (todo.length !== 1) throw stableError("foreground_e2e_human_root_binding_read_failed");
      const rootLabel = await readIssueLabel({ client, teamId, name: "symphony:kind/root" });
      const labels = new Map();
      for (const conductor of resolvedConductors.values()) {
        labels.set(conductor.conductorRef, await readIssueLabel({
          client,
          teamId,
          name: `symphony:conductor/${conductor.conductorShortHash}`,
        }));
      }
      const bindings = {};
      for (const definition of FOREGROUND_E2E_CASES) {
        for (const topology of definition.rootTopology) {
          const conductor = resolvedConductors.get(topology.conductorRef);
          const label = labels.get(topology.conductorRef);
          if (!conductor || !label) throw stableError("foreground_e2e_human_root_binding_read_failed");
          bindings[topology.rootKey] = Object.freeze({
            teamId,
            projectId,
            rootLabelId: rootLabel.id,
            routingLabelId: label.id,
            rootStatusId: todo[0].id,
            conductorId: conductor.conductorId,
            performerProfileId: conductor.performerProfileId,
            worktreeDirectory: conductor.worktreeDirectory,
          });
        }
      }
      return Object.freeze(bindings);
    },

    async admitRootIssues({ rootCreationsByRootKey, signal, onProgress } = {}) {
      if (!identifier(delegateActorId)) throw stableError("foreground_e2e_human_root_delegate_actor_invalid");
      assertOperationSignal(signal, "foreground_e2e_human_root_admission_input_invalid");
      if (onProgress !== undefined && typeof onProgress !== "function") {
        throw stableError("foreground_e2e_human_root_admission_input_invalid");
      }
      if (createdRootKeys.size !== 0 || roots.size !== 0) {
        throw stableError("foreground_e2e_human_root_admission_input_invalid");
      }
      const admissions = assertRootAdmissionInput(rootCreationsByRootKey, rootCatalog);
      const requestClient = clientForCase(signal);
      const creation = await write(
        () => requestClient.createIssueBatch({
          issues: admissions.map(({ binding, rootSpec }) => ({
            teamId: binding.teamId,
            projectId: binding.projectId,
            stateId: binding.rootStatusId,
            labelIds: [binding.rootLabelId, binding.routingLabelId],
            title: rootSpec.rootCreationInput.title,
            description: rootSpec.rootCreationInput.description,
            priority: linearPriorityValue(rootSpec.rootCreationInput.priority),
          })),
        }),
        "foreground_e2e_human_root_create_failed",
        signal,
      );
      const createdByRootKey = matchCreatedRootBatch(creation, admissions);
      reportAdmissionProgress(onProgress, "roots-created", admissions.length);
      const rootIssueIds = admissions.map(({ rootKey }) => createdByRootKey.get(rootKey).id);
      const createdRoots = await readAdmissionRoots(
        requestClient,
        rootIssueIds,
        "foreground_e2e_human_root_read_back_failed",
      );
      const [children, rootComments] = await Promise.all([
        readAdmissionChildren(requestClient, rootIssueIds),
        readAdmissionComments(requestClient, rootIssueIds),
      ]);
      if (children.length !== 0 || rootComments.length !== 0 || signal?.aborted) {
        throw stableError("foreground_e2e_human_root_admission_read_back_failed");
      }

      const createdRootsById = exactIssuesById(
        createdRoots,
        rootIssueIds,
        "foreground_e2e_human_root_admission_read_back_failed",
      );
      for (const admission of admissions) {
        const created = createdByRootKey.get(admission.rootKey);
        const issue = createdRootsById.get(created.id);
        const labels = directIssueLabels(issue, "foreground_e2e_human_root_admission_read_back_failed");
        if (!identifier(issue.identifier) || issue.identifier !== created.identifier ||
            !matchesCreatedRoot(issue, labels, admission.binding, admission.rootSpec.rootCreationInput) ||
            issue.archivedAt !== null && issue.archivedAt !== undefined) {
          throw stableError("foreground_e2e_human_root_admission_read_back_failed");
        }
        roots.set(issue.id, Object.freeze({
          rootIssueId: issue.id,
          rootKey: admission.rootKey,
          caseId: admission.rootSpec.caseId,
          declaredDescriptionUpdates: admission.rootSpec.declaredDescriptionUpdates,
          projectId: admission.binding.projectId,
          teamId: admission.binding.teamId,
          rootLabelId: admission.binding.rootLabelId,
          routingLabelId: admission.binding.routingLabelId,
          rootStatusId: admission.binding.rootStatusId,
          title: admission.rootSpec.rootCreationInput.title,
          description: admission.rootSpec.rootCreationInput.description,
        }));
        createdRootKeys.add(admission.rootKey);
      }
      reportAdmissionProgress(onProgress, "roots-verified", admissions.length);

      const delegation = await write(
        () => requestClient.updateIssueBatch(rootIssueIds, { delegateId: delegateActorId }),
        "foreground_e2e_human_root_delegate_failed",
        signal,
      );
      assertDelegationBatch(delegation, rootIssueIds);
      const delegatedRoots = exactIssuesById(
        await readAdmissionRoots(
          requestClient,
          rootIssueIds,
          "foreground_e2e_human_root_delegate_read_back_failed",
        ),
        rootIssueIds,
        "foreground_e2e_human_root_delegate_read_back_failed",
      );
      for (const rootIssueId of rootIssueIds) {
        const known = roots.get(rootIssueId);
        const delegated = delegatedRoots.get(rootIssueId);
        const labels = directIssueLabels(delegated, "foreground_e2e_human_root_delegate_read_back_failed");
        if (!known || !matchesKnownRoot(delegated, labels, known) || delegated.delegateId !== delegateActorId) {
          throw stableError("foreground_e2e_human_root_delegate_read_back_failed");
        }
      }
      reportAdmissionProgress(onProgress, "roots-delegated", admissions.length);

      return Object.freeze({
        rootsByKey: Object.freeze(Object.fromEntries(admissions.map(({ rootKey }) => {
          const root = createdByRootKey.get(rootKey);
          return [rootKey, Object.freeze({ rootKey, rootIssueId: root.id, identifier: root.identifier })];
        }))),
      });
    },

    createdRootsForCase({ caseId } = {}) {
      const keys = [...rootCatalog.entries()]
        .filter(([, root]) => root.caseId === caseId)
        .map(([rootKey]) => rootKey);
      if (!identifier(caseId) || keys.length === 0) {
        throw stableError("foreground_e2e_human_root_identity_input_invalid");
      }
      const rootIssueIdByKey = new Map([...roots.values()].map((root) => [root.rootKey, root.rootIssueId]));
      return Object.freeze(keys.flatMap((rootKey) => {
        const rootIssueId = rootIssueIdByKey.get(rootKey);
        return identifier(rootIssueId) ? [Object.freeze({ rootKey, rootIssueId })] : [];
      }));
    },

    async waitForPlanApprovalRequest({ rootIssueId, signal } = {}) {
      const known = assertKnownRoot(roots, rootIssueId);
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const request = await activePlanApprovalRequest({ client: requestClient, rootIssueId, known, productActorId: delegateActorId });
        if (request) return Object.freeze(request);
        await waitForChange(signal, "foreground_e2e_human_plan_review_aborted");
      }
    },

    async waitForSameConductorPreemptionAdmission({ rootIssueIds, signal } = {}) {
      const known = assertPreemptionRoots(roots, rootIssueIds, "foreground_e2e_human_preemption_admission_input_invalid");
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const snapshots = await Promise.all([...known.values()].map((root) => readPreemptionRootSnapshot({ client: requestClient, root })));
        const admission = preemptionAdmission(snapshots);
        if (admission) return Object.freeze(admission);
        await waitForChange(signal, "foreground_e2e_human_preemption_wait_aborted");
      }
    },

    async waitForSameConductorPreemptionCandidate({ inflightStageIssueId, touchedRootIssueId, remainingRootIssueId, signal } = {}) {
      const known = assertPreemptionCandidateRoots(roots, {
        inflightStageIssueId,
        touchedRootIssueId,
        remainingRootIssueId,
      });
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const snapshots = await Promise.all([...known.values()].map((root) => readPreemptionRootSnapshot({ client: requestClient, root })));
        const candidate = preemptionCandidate({
          snapshots,
          actorId,
          inflightStageIssueId,
          touchedRootIssueId,
          remainingRootIssueId,
        });
        if (candidate) return Object.freeze(candidate);
        await waitForChange(signal, "foreground_e2e_human_preemption_wait_aborted");
      }
    },

    async waitForRestartRecoveryAdmission({ affectedRootIssueId, continuousRootIssueId, signal } = {}) {
      const known = assertRestartRecoveryRoots(roots, { affectedRootIssueId, continuousRootIssueId });
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const snapshots = await Promise.all([...known.values()].map((root) => readRestartRecoveryRootSnapshot({ client: requestClient, root })));
        const admission = restartRecoveryAdmission(snapshots, affectedRootIssueId);
        if (admission) return Object.freeze(admission);
        await waitForChange(signal, "foreground_e2e_human_revision_wait_aborted");
      }
    },

    async waitForMissingWorktreeRecoveryAdmission({ rootIssueIds, signal } = {}) {
      const known = assertMissingWorktreeRoots(roots, rootIssueIds);
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const snapshots = await Promise.all([...known.values()].map((root) => readRestartRecoveryRootSnapshot({ client: requestClient, root })));
        const admission = missingWorktreeRecoveryAdmission(snapshots);
        if (admission) return Object.freeze(admission);
        await waitForChange(signal, "foreground_e2e_human_missing_worktree_wait_aborted");
      }
    },

    async waitForInformationRequest({ rootIssueId, signal } = {}) {
      const known = assertKnownClarificationRoot(roots, rootIssueId);
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const request = await activeInformationRequest({ client: requestClient, rootIssueId, known, productActorId: delegateActorId });
        if (request) return Object.freeze(request);
        await waitForChange(signal, "foreground_e2e_human_clarification_aborted");
      }
    },

    async waitForPlanApprovalGate({ rootIssueId, signal } = {}) {
      const known = assertKnownRoot(roots, rootIssueId);
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const gate = await activePlanApprovalRequest({ client: requestClient, rootIssueId, known, productActorId: delegateActorId });
        if (gate) return Object.freeze(gate);
        await waitForChange(signal, "foreground_e2e_human_revision_wait_aborted");
      }
    },

    async waitForSuccessorPlanApprovalGate({ rootIssueId, priorCycleIssueId, priorRequestCommentId, signal } = {}) {
      const known = assertKnownRoot(roots, rootIssueId);
      if (!identifier(priorCycleIssueId) || !identifier(priorRequestCommentId)) {
        throw stableError("foreground_e2e_human_successor_plan_input_invalid");
      }
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const gate = await activePlanApprovalRequest({
          client: requestClient,
          rootIssueId,
          known,
          productActorId: delegateActorId,
          excludedCycleIssueId: priorCycleIssueId,
          excludedRequestCommentId: priorRequestCommentId,
        });
        if (gate) return Object.freeze(gate);
        await waitForChange(signal, "foreground_e2e_human_revision_wait_aborted");
      }
    },

    async updateRootDescription({ rootIssueId, description, signal } = {}) {
      if (!identifier(rootIssueId) || !text(description)) {
        throw stableError("foreground_e2e_human_root_update_input_invalid");
      }
      assertOperationSignal(signal, "foreground_e2e_human_root_update_input_invalid");
      const requestClient = clientForCase(signal);
      const known = roots.get(rootIssueId);
      if (!known) throw stableError("foreground_e2e_human_root_target_invalid");
      if (!known.declaredDescriptionUpdates.has(description)) {
        throw stableError("foreground_e2e_human_root_update_not_declared");
      }
      const before = await readIssue(requestClient, rootIssueId, "foreground_e2e_human_root_target_invalid");
      const beforeLabels = await readLabels(before, "foreground_e2e_human_root_target_invalid");
      if (!matchesKnownRoot(before, beforeLabels, known)) {
        throw stableError("foreground_e2e_human_root_target_invalid");
      }
      const payload = await write(
        () => requestClient.updateIssue(rootIssueId, { description }),
        "foreground_e2e_human_root_update_failed",
        signal,
      );
      if (payload?.success !== true || payload.issueId !== rootIssueId) {
        throw stableError("foreground_e2e_human_root_update_failed");
      }
      const after = await readIssue(requestClient, rootIssueId, "foreground_e2e_human_root_read_back_failed");
      const afterLabels = await readLabels(after, "foreground_e2e_human_root_read_back_failed");
      if (!matchesKnownRoot(after, afterLabels, known) || after.description !== description) {
        throw stableError("foreground_e2e_human_root_read_back_failed");
      }
      return rememberReceipt(receiptInputs, descriptionInputReference({ rootIssueId, remoteVersion: remoteVersion(after) }));
    },

    async createComment({ issueId, body, signal } = {}) {
      if (!identifier(issueId) || !text(body)) {
        throw stableError("foreground_e2e_human_comment_create_input_invalid");
      }
      assertOperationSignal(signal, "foreground_e2e_human_comment_create_input_invalid");
      const requestClient = clientForCase(signal);
      const payload = await write(
        () => requestClient.createComment({ issueId, body }),
        "foreground_e2e_human_comment_create_failed",
        signal,
      );
      if (payload?.success !== true || !identifier(payload.commentId)) {
        throw stableError("foreground_e2e_human_comment_create_failed");
      }
      const created = await readComment(requestClient, payload.commentId, "foreground_e2e_human_comment_read_back_failed");
      if (!matchesOwnedRootComment(created, { issueId, body, actorId })) {
        throw stableError("foreground_e2e_human_comment_read_back_failed");
      }
      comments.set(created.id, Object.freeze({ issueId: created.issueId }));
      return Object.freeze({
        commentId: created.id,
        issueId: created.issueId,
        inputReference: rememberReceipt(receiptInputs, commentBodyInputReference(created)),
      });
    },

    async replyToHumanAction({ rootIssueId, requestCommentId, body, signal } = {}) {
      if (!identifier(rootIssueId) || !identifier(requestCommentId) || !text(body)) {
        throw stableError("foreground_e2e_human_action_reply_input_invalid");
      }
      assertOperationSignal(signal, "foreground_e2e_human_action_reply_input_invalid");
      const known = assertKnownRoot(roots, rootIssueId);
      const requestClient = clientForCase(signal);
      const root = await readIssue(requestClient, rootIssueId, "foreground_e2e_human_action_reply_target_invalid");
      const labels = await readLabels(root, "foreground_e2e_human_action_reply_target_invalid");
      const request = await readComment(requestClient, requestCommentId, "foreground_e2e_human_action_reply_target_invalid");
      if (!matchesKnownRoot(root, labels, known) || !isProductHumanActionRequest(request, { rootIssueId, productActorId: delegateActorId })) {
        throw stableError("foreground_e2e_human_action_reply_target_invalid");
      }
      const payload = await write(
        () => requestClient.createComment({ issueId: rootIssueId, parentId: requestCommentId, body }),
        "foreground_e2e_human_action_reply_failed",
        signal,
      );
      if (payload?.success !== true || !identifier(payload.commentId)) {
        throw stableError("foreground_e2e_human_action_reply_failed");
      }
      const reply = await readComment(requestClient, payload.commentId, "foreground_e2e_human_action_reply_read_back_failed");
      if (!matchesOwnedHumanActionReply(reply, { rootIssueId, requestCommentId, body, actorId })) {
        throw stableError("foreground_e2e_human_action_reply_read_back_failed");
      }
      comments.set(reply.id, Object.freeze({ issueId: rootIssueId }));
      return Object.freeze({
        commentId: reply.id,
        issueId: rootIssueId,
        requestCommentId,
        inputReference: rememberReceipt(receiptInputs, commentBodyInputReference(reply)),
      });
    },

    async editComment({ issueId, commentId, body, signal } = {}) {
      const known = assertKnownComment(comments, { issueId, commentId });
      if (!text(body)) throw stableError("foreground_e2e_human_comment_update_input_invalid");
      assertOperationSignal(signal, "foreground_e2e_human_comment_update_input_invalid");
      const requestClient = clientForCase(signal);
      const before = await readComment(requestClient, commentId, "foreground_e2e_human_comment_target_invalid");
      if (!matchesOwnedRootComment(before, { issueId: known.issueId, actorId })) {
        throw stableError("foreground_e2e_human_comment_target_invalid");
      }
      const payload = await write(
        () => requestClient.updateComment(commentId, { body }),
        "foreground_e2e_human_comment_update_failed",
        signal,
      );
      if (payload?.success !== true || payload.commentId !== commentId) {
        throw stableError("foreground_e2e_human_comment_update_failed");
      }
      const after = await readComment(requestClient, commentId, "foreground_e2e_human_comment_read_back_failed");
      if (!matchesOwnedRootComment(after, { issueId: known.issueId, body, actorId })) {
        throw stableError("foreground_e2e_human_comment_read_back_failed");
      }
      return Object.freeze({
        commentId: after.id,
        issueId: after.issueId,
        inputReference: rememberReceipt(receiptInputs, commentBodyInputReference(after)),
      });
    },

    async resolveCommentThread({ issueId, threadRootCommentId, signal } = {}) {
      assertOperationSignal(signal, "foreground_e2e_human_comment_thread_update_input_invalid");
      return setCommentThreadState({
        client: clientForCase(signal),
        comments,
        actorId,
        issueId,
        commentId: threadRootCommentId,
        resolved: true,
        receiptInputs,
        signal,
      });
    },

    async reopenCommentThread({ issueId, threadRootCommentId, signal } = {}) {
      assertOperationSignal(signal, "foreground_e2e_human_comment_thread_update_input_invalid");
      return setCommentThreadState({
        client: clientForCase(signal),
        comments,
        actorId,
        issueId,
        commentId: threadRootCommentId,
        resolved: false,
        receiptInputs,
        signal,
      });
    },

    async waitForRootDescriptionReceipt({ rootIssueId, inputReference, signal } = {}) {
      const known = assertKnownRoot(roots, rootIssueId);
      const expected = assertRegisteredReceipt(receiptInputs, inputReference, "description", "foreground_e2e_human_description_receipt_input_invalid");
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const root = await readIssue(requestClient, rootIssueId, "foreground_e2e_human_description_receipt_read_failed");
        const labels = await readLabels(root, "foreground_e2e_human_description_receipt_read_failed");
        if (!matchesKnownRoot(root, labels, known)) throw stableError("foreground_e2e_human_description_receipt_target_invalid");
        const history = await readIssueHistory(root, "foreground_e2e_human_description_receipt_read_failed");
        if (hasDescriptionConsequence(history, expected, delegateActorId)) return;
        await waitForChange(signal, "foreground_e2e_human_revision_wait_aborted");
      }
    },

    async waitForCommentReceipt({ issueId, inputReference, signal } = {}) {
      const expected = assertRegisteredReceipt(receiptInputs, inputReference, "comment_body", "foreground_e2e_human_comment_receipt_input_invalid");
      if (!identifier(issueId) || expected.issueId !== issueId) throw stableError("foreground_e2e_human_comment_receipt_input_invalid");
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const source = await readComment(requestClient, expected.commentId, "foreground_e2e_human_comment_receipt_read_failed");
        if (!matchesOwnedHumanInput(source, { issueId, actorId })) throw stableError("foreground_e2e_human_comment_receipt_target_invalid");
        if (await hasCommentReceipt({ source, expected, actorId, productActorId: delegateActorId, threadAction: undefined })) return;
        await waitForChange(signal, "foreground_e2e_human_revision_wait_aborted");
      }
    },

    async waitForCommentThreadReceipt({ issueId, inputReference, signal } = {}) {
      const expected = assertRegisteredReceipt(receiptInputs, inputReference, "comment_thread_state", "foreground_e2e_human_thread_receipt_input_invalid");
      if (!identifier(issueId) || expected.issueId !== issueId) throw stableError("foreground_e2e_human_thread_receipt_input_invalid");
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const source = await readComment(requestClient, expected.commentId, "foreground_e2e_human_thread_receipt_read_failed");
        if (!matchesOwnedRootComment(source, { issueId, actorId }) || threadState(source) !== expected.expectedThreadState ||
            remoteVersion(source) !== expected.remoteVersion) {
          throw stableError("foreground_e2e_human_thread_receipt_target_invalid");
        }
        const action = expected.expectedThreadState === "resolved" ? "resolve" : "reopen";
        if (await hasCommentReceipt({ source, expected, actorId, productActorId: delegateActorId, threadAction: action })) return;
        await waitForChange(signal, "foreground_e2e_human_revision_wait_aborted");
      }
    },

    async addReaction({ issueId, commentId, emoji, signal } = {}) {
      const known = assertKnownComment(comments, { issueId, commentId });
      if (!emojiValue(emoji)) throw stableError("foreground_e2e_human_reaction_input_invalid");
      assertOperationSignal(signal, "foreground_e2e_human_reaction_input_invalid");
      const requestClient = clientForCase(signal);
      const before = await readComment(requestClient, commentId, "foreground_e2e_human_comment_target_invalid");
      if (!matchesOwnedRootComment(before, { issueId: known.issueId, actorId })) {
        throw stableError("foreground_e2e_human_comment_target_invalid");
      }
      const payload = await write(
        () => requestClient.createReaction({ commentId, emoji }),
        "foreground_e2e_human_reaction_create_failed",
        signal,
      );
      if (payload?.success !== true || !identifier(payload.reactionId)) {
        throw stableError("foreground_e2e_human_reaction_create_failed");
      }
      const after = await readComment(requestClient, commentId, "foreground_e2e_human_comment_read_back_failed");
      if (!matchesOwnedRootComment(after, { issueId: known.issueId, actorId }) ||
          !Array.isArray(after.reactions) || !after.reactions.some((reaction) =>
            reaction?.id === payload.reactionId && reaction.emoji === emoji && reaction.userId === actorId)) {
        throw stableError("foreground_e2e_human_comment_read_back_failed");
      }
      return Object.freeze({ reactionId: payload.reactionId, commentId, emoji });
    },

  });
}

function reportAdmissionProgress(onProgress, milestone, rootCount) {
  if (onProgress === undefined) return;
  try {
    onProgress(Object.freeze({ milestone, rootCount }));
  } catch {
    // Progress is observational and must not interrupt a partially completed admission.
  }
}

async function setCommentThreadState({ client, comments, actorId, issueId, commentId, resolved, receiptInputs, signal }) {
  const known = assertKnownComment(comments, { issueId, commentId });
  const before = await readComment(client, commentId, "foreground_e2e_human_comment_target_invalid");
  if (!matchesOwnedRootComment(before, { issueId: known.issueId, actorId })) {
    throw stableError("foreground_e2e_human_comment_target_invalid");
  }
  const payload = await write(
    () => resolved ? client.commentResolve(commentId) : client.commentUnresolve(commentId),
    "foreground_e2e_human_comment_thread_update_failed",
    signal,
  );
  if (payload?.success !== true || payload.commentId !== commentId) {
    throw stableError("foreground_e2e_human_comment_thread_update_failed");
  }
  const after = await readComment(client, commentId, "foreground_e2e_human_comment_read_back_failed");
  if (!matchesOwnedRootComment(after, { issueId: known.issueId, actorId }) ||
      (resolved ? !after.resolvedAt : after.resolvedAt !== null && after.resolvedAt !== undefined)) {
    throw stableError("foreground_e2e_human_comment_read_back_failed");
  }
  return rememberReceipt(receiptInputs, commentThreadStateInputReference(after));
}

function assertRootCreateInput(input, rootCatalog) {
  if (!input || !identifier(input.rootKey) || !identifier(input.teamId) || !identifier(input.projectId) ||
      !identifier(input.rootLabelId) || !identifier(input.routingLabelId) || input.rootLabelId === input.routingLabelId ||
      !identifier(input.rootStatusId) || !identifier(input.caseId)) {
    throw stableError("foreground_e2e_human_root_create_input_invalid");
  }
  const rootSpec = rootCatalog.get(input.rootKey);
  if (!rootSpec || rootSpec.caseId !== input.caseId) {
    throw stableError("foreground_e2e_human_root_create_input_invalid");
  }
  return rootSpec;
}

function assertRootAdmissionInput(rootCreationsByRootKey, rootCatalog) {
  const rootKeys = rootCreationsByRootKey && typeof rootCreationsByRootKey === "object" &&
      !Array.isArray(rootCreationsByRootKey)
    ? Object.keys(rootCreationsByRootKey)
    : [];
  if (!rootCreationsByRootKey || typeof rootCreationsByRootKey !== "object" || Array.isArray(rootCreationsByRootKey) ||
      rootKeys.length === 0 || rootKeys.some((rootKey) => !rootCatalog.has(rootKey))) {
    throw stableError("foreground_e2e_human_root_admission_input_invalid");
  }
  return rootKeys.map((rootKey) => {
    const rootSpec = rootCatalog.get(rootKey);
    const binding = rootCreationsByRootKey[rootKey];
    assertRootCreateInput({
      ...binding,
      rootKey,
      caseId: rootSpec?.caseId,
    }, rootCatalog);
    return Object.freeze({ rootKey, rootSpec, binding });
  });
}

function matchCreatedRootBatch(payload, admissions) {
  if (payload?.success !== true || !Array.isArray(payload.issues) || payload.issues.length !== admissions.length) {
    throw stableError("foreground_e2e_human_root_create_failed");
  }
  const expectedByTitle = new Map(admissions.map((admission) => [
    admission.rootSpec.rootCreationInput.title,
    admission,
  ]));
  if (expectedByTitle.size !== admissions.length) {
    throw stableError("foreground_e2e_human_case_catalog_invalid");
  }
  const createdByRootKey = new Map();
  const issueIds = new Set();
  const identifiers = new Set();
  for (const issue of payload.issues) {
    const admission = expectedByTitle.get(issue?.title);
    if (!admission || !identifier(issue?.id) || !identifier(issue?.identifier) ||
        issueIds.has(issue.id) || identifiers.has(issue.identifier) || createdByRootKey.has(admission.rootKey)) {
      throw stableError("foreground_e2e_human_root_create_failed");
    }
    issueIds.add(issue.id);
    identifiers.add(issue.identifier);
    createdByRootKey.set(admission.rootKey, Object.freeze({ id: issue.id, identifier: issue.identifier }));
  }
  if (createdByRootKey.size !== admissions.length) {
    throw stableError("foreground_e2e_human_root_create_failed");
  }
  return createdByRootKey;
}

async function readAdmissionRoots(client, rootIssueIds, code) {
  return readHumanNodes((after) => client.issues({
    first: 50,
    includeArchived: true,
    filter: { id: { in: rootIssueIds } },
    ...(after ? { after } : {}),
  }), code);
}

async function readAdmissionChildren(client, rootIssueIds) {
  return readHumanNodes((after) => client.issues({
    first: 50,
    includeArchived: true,
    filter: { parent: { id: { in: rootIssueIds } } },
    ...(after ? { after } : {}),
  }), "foreground_e2e_human_root_admission_read_back_failed");
}

async function readAdmissionComments(client, rootIssueIds) {
  return readHumanNodes((after) => client.comments({
    first: 50,
    includeArchived: true,
    filter: { issue: { id: { in: rootIssueIds } } },
    ...(after ? { after } : {}),
  }), "foreground_e2e_human_root_admission_read_back_failed");
}

function exactIssuesById(issues, expectedIssueIds, code) {
  const expected = new Set(expectedIssueIds);
  const byId = new Map();
  for (const issue of issues) {
    if (!identifier(issue?.id) || !expected.has(issue.id) || byId.has(issue.id)) throw stableError(code);
    byId.set(issue.id, issue);
  }
  if (byId.size !== expected.size) throw stableError(code);
  return byId;
}

function directIssueLabels(issue, code) {
  if (!Array.isArray(issue?.labelIds) || issue.labelIds.some((labelId) => !identifier(labelId)) ||
      new Set(issue.labelIds).size !== issue.labelIds.length) {
    throw stableError(code);
  }
  return issue.labelIds.map((id) => ({ id }));
}

function assertDelegationBatch(payload, rootIssueIds) {
  if (payload?.success !== true || !Array.isArray(payload.issues)) {
    throw stableError("foreground_e2e_human_root_delegate_failed");
  }
  exactIssuesById(payload.issues, rootIssueIds, "foreground_e2e_human_root_delegate_failed");
}

function rootCatalogByKey() {
  const byRootKey = new Map();
  for (const definition of FOREGROUND_E2E_CASES) {
    const descriptionsByRootKey = new Map();
    for (const interaction of definition.declaredUserInteractions) {
      for (const [rootKey, description] of declaredDescriptionUpdates(interaction)) {
        const descriptions = descriptionsByRootKey.get(rootKey) ?? new Set();
        descriptions.add(description);
        descriptionsByRootKey.set(rootKey, descriptions);
      }
    }
    for (const rootCreationInput of definition.rootCreationInputs) {
      if (byRootKey.has(rootCreationInput.rootKey)) {
        throw stableError("foreground_e2e_human_case_catalog_invalid");
      }
      byRootKey.set(rootCreationInput.rootKey, Object.freeze({
        caseId: definition.caseId,
        rootCreationInput,
        declaredDescriptionUpdates: descriptionsByRootKey.get(rootCreationInput.rootKey) ?? new Set(),
      }));
    }
  }
  return byRootKey;
}

function assertConductorBindings({ teamId, projectId, conductors }) {
  const requiredRefs = new Set(FOREGROUND_E2E_CASES.flatMap(({ rootTopology }) =>
    rootTopology.map(({ conductorRef }) => conductorRef)));
  if (!identifier(teamId) || !identifier(projectId) || !Array.isArray(conductors) ||
      conductors.length !== requiredRefs.size) {
    throw stableError("foreground_e2e_human_root_binding_input_invalid");
  }
  const byRef = new Map();
  for (const conductor of conductors) {
    if (!conductor || typeof conductor.conductorRef !== "string" || !requiredRefs.has(conductor.conductorRef) ||
        !identifier(conductor.conductorId) || !shortHash(conductor.conductorShortHash) ||
        !identifier(conductor.performerProfileId) || !directory(conductor.worktreeDirectory) || byRef.has(conductor.conductorRef)) {
      throw stableError("foreground_e2e_human_root_binding_input_invalid");
    }
    byRef.set(conductor.conductorRef, conductor);
  }
  if (byRef.size !== requiredRefs.size || [...requiredRefs].some((reference) => !byRef.has(reference)) ||
      new Set([...byRef.values()].map(({ conductorId }) => conductorId)).size !== byRef.size ||
      new Set([...byRef.values()].map(({ conductorShortHash }) => conductorShortHash)).size !== byRef.size ||
      new Set([...byRef.values()].map(({ performerProfileId }) => performerProfileId)).size !== byRef.size ||
      new Set([...byRef.values()].map(({ worktreeDirectory }) => worktreeDirectory)).size !== byRef.size) {
    throw stableError("foreground_e2e_human_root_binding_input_invalid");
  }
  return byRef;
}

async function readIssueLabel({ client, teamId, name }) {
  if (!client || typeof client.issueLabels !== "function" || !identifier(teamId) || !text(name)) {
    throw stableError("foreground_e2e_human_root_binding_read_failed");
  }
  const labels = await readHumanNodes((after) => client.issueLabels({
    first: 64,
    includeArchived: false,
    filter: { name: { eq: name }, isGroup: { eq: false } },
    ...(after ? { after } : {}),
  }), "foreground_e2e_human_root_binding_read_failed");
  const matches = labels.filter((label) => label && identifier(label.id) && label.name === name && label.isGroup === false &&
    (label.teamId === undefined || label.teamId === teamId) &&
    (label.archivedAt === undefined || label.archivedAt === null) &&
    (label.retiredById === undefined || label.retiredById === null));
  if (matches.length !== 1) throw stableError("foreground_e2e_human_root_binding_read_failed");
  return Object.freeze({ id: matches[0].id });
}

function declaredDescriptionUpdates(interaction) {
  if (interaction.kind === "update_root_description") return [[interaction.rootKey, interaction.description]];
  if (interaction.kind === "touch_bound_root_description") return Object.entries(interaction.descriptionsByRootKey);
  return [];
}

function assertKnownComment(comments, { issueId, commentId }) {
  if (!identifier(issueId) || !identifier(commentId)) {
    throw stableError("foreground_e2e_human_comment_target_invalid");
  }
  const known = comments.get(commentId);
  if (!known || known.issueId !== issueId) throw stableError("foreground_e2e_human_comment_target_invalid");
  return known;
}

function assertKnownRoot(roots, rootIssueId) {
  if (!identifier(rootIssueId)) throw stableError("foreground_e2e_human_plan_review_input_invalid");
  const known = roots.get(rootIssueId);
  if (!known) throw stableError("foreground_e2e_human_plan_review_target_invalid");
  return known;
}

function assertKnownClarificationRoot(roots, rootIssueId) {
  if (!identifier(rootIssueId)) throw stableError("foreground_e2e_human_clarification_input_invalid");
  const known = roots.get(rootIssueId);
  if (!known) throw stableError("foreground_e2e_human_clarification_target_invalid");
  return known;
}

function assertPreemptionRoots(roots, rootIssueIds, code) {
  if (!Array.isArray(rootIssueIds) || rootIssueIds.length !== 3 || new Set(rootIssueIds).size !== 3 ||
      rootIssueIds.some((rootIssueId) => !identifier(rootIssueId))) {
    throw stableError(code);
  }
  const known = new Map(rootIssueIds.map((rootIssueId) => [rootIssueId, roots.get(rootIssueId)]));
  if ([...known.values()].some((root) => !root || root.caseId !== "same_conductor_preemption") ||
      new Set([...known.values()].map(({ rootKey }) => rootKey)).size !== PREEMPTION_CORE_ROOT_KEYS.size ||
      [...known.values()].some(({ rootKey }) => !PREEMPTION_CORE_ROOT_KEYS.has(rootKey))) {
    throw stableError(code);
  }
  return known;
}

function assertPreemptionCandidateRoots(roots, { inflightStageIssueId, touchedRootIssueId, remainingRootIssueId }) {
  if (!identifier(inflightStageIssueId) || !identifier(touchedRootIssueId) || !identifier(remainingRootIssueId) ||
      touchedRootIssueId === remainingRootIssueId) {
    throw stableError("foreground_e2e_human_preemption_candidate_input_invalid");
  }
  const known = [...roots.values()].filter(({ caseId, rootKey }) =>
    caseId === "same_conductor_preemption" && PREEMPTION_CORE_ROOT_KEYS.has(rootKey));
  const byId = new Map(known.map((root) => [root.rootIssueId, root]));
  if (known.length !== PREEMPTION_CORE_ROOT_KEYS.size || !byId.has(touchedRootIssueId) || !byId.has(remainingRootIssueId)) {
    throw stableError("foreground_e2e_human_preemption_candidate_input_invalid");
  }
  return byId;
}

function assertRestartRecoveryRoots(roots, { affectedRootIssueId, continuousRootIssueId }) {
  if (!identifier(affectedRootIssueId) || !identifier(continuousRootIssueId) || affectedRootIssueId === continuousRootIssueId) {
    throw stableError("foreground_e2e_human_recovery_admission_input_invalid");
  }
  const affected = roots.get(affectedRootIssueId);
  const continuous = roots.get(continuousRootIssueId);
  if (!affected || !continuous || affected.caseId !== "conductor_restart_recovery" ||
      continuous.caseId !== "conductor_restart_recovery" || affected.rootKey !== "affected-root" ||
      continuous.rootKey !== "continuous-root") {
    throw stableError("foreground_e2e_human_recovery_admission_input_invalid");
  }
  return new Map([[affectedRootIssueId, affected], [continuousRootIssueId, continuous]]);
}

function assertMissingWorktreeRoots(roots, rootIssueIds) {
  if (!Array.isArray(rootIssueIds) || rootIssueIds.length !== 2 || new Set(rootIssueIds).size !== 2 ||
      rootIssueIds.some((rootIssueId) => !identifier(rootIssueId))) {
    throw stableError("foreground_e2e_human_missing_worktree_admission_input_invalid");
  }
  const known = new Map(rootIssueIds.map((rootIssueId) => [rootIssueId, roots.get(rootIssueId)]));
  const rootKeys = new Set([...known.values()].map((root) => root?.rootKey));
  if ([...known.values()].some((root) => root?.caseId !== "missing_worktree_recovery") ||
      rootKeys.size !== 2 || !rootKeys.has("recoverable-worktree-root") || !rootKeys.has("invalid-generation-root")) {
    throw stableError("foreground_e2e_human_missing_worktree_admission_input_invalid");
  }
  return known;
}

async function readPreemptionRootSnapshot({ client, root }) {
  const code = "foreground_e2e_human_preemption_read_failed";
  const issue = await readIssue(client, root.rootIssueId, code);
  const labels = await readLabels(issue, code);
  if (!matchesKnownRoot(issue, labels, root) || !Number.isFinite(issue.priority)) {
    throw stableError(code);
  }
  const statuses = await readTeamStatuses(client, root.teamId, code);
  const statusById = new Map(statuses.map((status) => [status.id, status.name]));
  const tree = await readPreemptionIssueTree(issue, code, new Set());
  const stages = [];
  for (const node of tree.slice(1)) {
    const nodeLabels = await readLabels(node, code);
    const issueKind = stageIssueKind(nodeLabels);
    if (!issueKind) continue;
    const statusName = statusById.get(node.stateId);
    if (!statusName) throw stableError(code);
    const activity = await readIssueHistory(node, code);
    const currentStatusActivity = latestStatusActivity(activity, node.stateId);
    if (!currentStatusActivity) throw stableError(code);
    stages.push({
      issueId: node.id,
      issueKind,
      statusName,
      changedAt: remoteVersion(currentStatusActivity),
    });
  }
  const history = await readIssueHistory(issue, code);
  if (history.some((entry) => !validPreemptionActivity(entry, root.rootIssueId))) throw stableError(code);
  return {
    rootIssueId: root.rootIssueId,
    priority: issue.priority,
    routingLabelId: root.routingLabelId,
    stages,
    nativeIssueIds: tree.map(({ id }) => id),
    history,
  };
}

async function readRestartRecoveryRootSnapshot({ client, root }) {
  const code = "foreground_e2e_human_recovery_read_failed";
  const issue = await readIssue(client, root.rootIssueId, code);
  const labels = await readLabels(issue, code);
  if (!matchesKnownRoot(issue, labels, root)) throw stableError(code);
  return readPreemptionRootSnapshot({ client, root });
}

async function readPreemptionIssueTree(issue, code, seen) {
  if (!issue || !identifier(issue.id) || seen.has(issue.id)) throw stableError(code);
  seen.add(issue.id);
  const result = [issue];
  for (const child of await readChildren(issue, code)) {
    result.push(...await readPreemptionIssueTree(child, code, seen));
  }
  return result;
}

function preemptionAdmission(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length !== 3 || !samePreemptionOwner(snapshots) ||
      new Set(snapshots.map(({ priority }) => priority)).size !== 1) return undefined;
  const active = snapshots.flatMap((snapshot) => snapshot.stages.filter(({ statusName }) => statusName === "In Progress")
    .map((stage) => ({ rootIssueId: snapshot.rootIssueId, stageIssueId: stage.issueId })));
  const ready = snapshots.filter(({ stages }) => stages.length === 0).map(({ rootIssueId }) => rootIssueId);
  if (active.length !== 1 || ready.length !== 2 || !active.every(({ rootIssueId, stageIssueId }) => identifier(rootIssueId) && identifier(stageIssueId))) {
    return undefined;
  }
  return { inflightRootIssueId: active[0].rootIssueId, inflightStageIssueId: active[0].stageIssueId, readyRootIssueIds: ready };
}

function restartRecoveryAdmission(snapshots, affectedRootIssueId) {
  if (!Array.isArray(snapshots) || snapshots.length !== 2) return undefined;
  const affected = snapshots.find(({ rootIssueId }) => rootIssueId === affectedRootIssueId);
  if (!affected) return undefined;
  const active = affected.stages.filter(({ statusName }) => statusName === "In Progress");
  if (active.length !== 1 || !identifier(active[0]?.issueId)) return undefined;
  return { affectedRootIssueId, interruptedStageIssueId: active[0].issueId };
}

function missingWorktreeRecoveryAdmission(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length !== 2) return undefined;
  const stages = snapshots.map((snapshot) => {
    const activeVerify = snapshot.stages.filter(({ issueKind, statusName }) => issueKind === "verify" && statusName === "In Progress");
    return activeVerify.length === 1 ? [snapshot.rootIssueId, activeVerify[0].issueId] : undefined;
  });
  if (stages.some((stage) => !stage)) return undefined;
  return {
    verifyIssueIdsByRootId: Object.freeze(Object.fromEntries(stages)),
    nativeIssueIdsByRootId: Object.freeze(Object.fromEntries(snapshots.map(({ rootIssueId, nativeIssueIds }) => [
      rootIssueId,
      Object.freeze([...nativeIssueIds]),
    ]))),
  };
}

function preemptionCandidate({ snapshots, actorId, inflightStageIssueId, touchedRootIssueId, remainingRootIssueId }) {
  const inflight = snapshots.find(({ rootIssueId }) => rootIssueId !== touchedRootIssueId && rootIssueId !== remainingRootIssueId);
  const touched = snapshots.find(({ rootIssueId }) => rootIssueId === touchedRootIssueId);
  const remaining = snapshots.find(({ rootIssueId }) => rootIssueId === remainingRootIssueId);
  if (!inflight || !touched || !remaining || !samePreemptionOwner(snapshots)) return undefined;
  const oldStage = inflight.stages.find(({ issueId }) => issueId === inflightStageIssueId);
  const terminalAt = ["Done", "Interrupted", "Failed", "Canceled"].includes(oldStage?.statusName)
    ? Date.parse(oldStage.changedAt)
    : Number.NaN;
  if (!Number.isFinite(terminalAt)) return undefined;
  const readyAtTerminal = [touched, remaining].every((snapshot) => snapshot.stages
    .every(({ changedAt }) => Date.parse(changedAt) > terminalAt));
  if (!readyAtTerminal) return undefined;
  const touch = touched.history.filter((entry) => entry.actorId === actorId && entry.updatedDescription === true)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  if (touch.length !== 1 || !identifier(touch[0].id) || Date.parse(touch[0].createdAt) >= terminalAt) return undefined;
  const candidates = [touched, remaining].flatMap((snapshot) => snapshot.stages
    .filter(({ statusName, changedAt }) => statusName === "In Progress" && Date.parse(changedAt) > terminalAt)
    .map((stage) => ({ rootIssueId: snapshot.rootIssueId, stage })))
    .sort((left, right) => Date.parse(left.stage.changedAt) - Date.parse(right.stage.changedAt));
  const first = candidates[0];
  if (!first || candidates.filter(({ stage }) => stage.changedAt === first.stage.changedAt).length !== 1 ||
      first.rootIssueId !== touchedRootIssueId || !identifier(first.stage.issueId)) return undefined;
  return { rootIssueId: touchedRootIssueId, stageIssueId: first.stage.issueId, touchActivityId: touch[0].id };
}

function samePreemptionOwner(snapshots) {
  return snapshots.every(({ routingLabelId }) => identifier(routingLabelId)) &&
    new Set(snapshots.map(({ routingLabelId }) => routingLabelId)).size === 1;
}

function validPreemptionActivity(entry, rootIssueId) {
  return entry && identifier(entry.id) && entry.issueId === rootIssueId &&
    (entry.actorId === null || entry.actorId === undefined || identifier(entry.actorId)) &&
    timestampValue(entry.createdAt) && timestampValue(entry.updatedAt);
}

async function activePlanApprovalRequest({
  client,
  rootIssueId,
  known,
  productActorId,
  excludedCycleIssueId = undefined,
  excludedRequestCommentId = undefined,
}) {
  const root = await readIssue(client, rootIssueId, "foreground_e2e_human_plan_gate_target_invalid");
  const rootLabels = await readLabels(root, "foreground_e2e_human_plan_gate_target_invalid");
  if (!matchesKnownRoot(root, rootLabels, known)) throw stableError("foreground_e2e_human_plan_gate_target_invalid");
  const cycles = await readChildren(root, "foreground_e2e_human_plan_gate_read_failed");
  const plans = [];
  for (const cycle of cycles) {
    if (!matchesChildScope(cycle, { parentId: rootIssueId, known }) || cycle.id === excludedCycleIssueId) continue;
    const children = await readChildren(cycle, "foreground_e2e_human_plan_gate_read_failed");
    for (const child of children) {
      if (!matchesChildScope(child, { parentId: cycle.id, known })) continue;
      const labels = await readLabels(child, "foreground_e2e_human_plan_gate_read_failed");
      if (isPlanIssue(labels)) plans.push({ cycle, plan: child });
    }
  }
  const statuses = await readTeamStatuses(client, root.teamId, "foreground_e2e_human_plan_gate_read_failed");
  const reviewStatus = statuses.filter(({ name, archivedAt }) => name === "In Review" && !archivedAt);
  if (reviewStatus.length !== 1) throw stableError("foreground_e2e_human_plan_gate_status_invalid");
  const reviewPlans = plans.filter(({ plan }) => plan.stateId === reviewStatus[0].id && text(plan.description) && identifier(plan.identifier));
  const comments = await readIssueComments(root, "foreground_e2e_human_plan_gate_read_failed");
  const gates = comments.flatMap((comment) => {
    if (comment.id === excludedRequestCommentId || !isProductHumanActionRequest(comment, { rootIssueId, productActorId }) ||
        !comment.body.startsWith(HUMAN_ACTION_HEADINGS.planApproval) || threadState(comment) !== "unresolved") return [];
    const targets = reviewPlans.filter(({ plan }) => mentionsIdentifier(comment.body, plan.identifier));
    if (targets.length !== 1) return [];
    const [{ cycle, plan }] = targets;
    return [{
      cycleIssueId: cycle.id,
      planIssueId: plan.id,
      planRemoteVersion: remoteVersion(plan),
      requestCommentId: comment.id,
    }];
  });
  if (gates.length > 1) throw stableError("foreground_e2e_human_plan_gate_ambiguous");
  return gates[0];
}

async function activeInformationRequest({ client, rootIssueId, known, productActorId }) {
  const root = await readIssue(client, rootIssueId, "foreground_e2e_human_clarification_target_invalid");
  const rootLabels = await readLabels(root, "foreground_e2e_human_clarification_target_invalid");
  if (!matchesKnownRoot(root, rootLabels, known)) throw stableError("foreground_e2e_human_clarification_target_invalid");
  const comments = await readIssueComments(root, "foreground_e2e_human_clarification_read_failed");
  const requests = comments.filter((comment) => isProductHumanActionRequest(comment, { rootIssueId, productActorId }) &&
    comment.body.startsWith(HUMAN_ACTION_HEADINGS.information) && threadState(comment) === "unresolved");
  if (requests.length > 1) throw stableError("foreground_e2e_human_clarification_ambiguous");
  return requests[0] ? { requestCommentId: requests[0].id, rootIssueId } : undefined;
}

function isPlanIssue(labels) {
  const names = labels.map(({ name }) => name);
  return names.includes("symphony:kind/plan") && !names.includes("Human Action");
}

function stageIssueKind(labels) {
  const kinds = labels.flatMap(({ name }) => {
    if (name === "symphony:kind/plan") return ["plan"];
    if (name === "symphony:kind/work") return ["work"];
    if (name === "symphony:kind/verify") return ["verify"];
    return [];
  });
  if (kinds.length > 1) throw stableError("foreground_e2e_human_preemption_read_failed");
  return kinds.length === 1 ? kinds[0] : undefined;
}

function matchesChildScope(issue, { parentId, known }) {
  return issue && identifier(issue.id) && issue.parentId === parentId && issue.teamId === known.teamId &&
    issue.projectId === known.projectId && identifier(issue.stateId) &&
    (issue.archivedAt === null || issue.archivedAt === undefined);
}

function isProductHumanActionRequest(comment, { rootIssueId, productActorId }) {
  return comment && identifier(comment.id) && comment.issueId === rootIssueId &&
    (comment.parentId === null || comment.parentId === undefined) && identifier(productActorId) && comment.userId === productActorId &&
    text(comment.body) && Object.values(HUMAN_ACTION_HEADINGS).some((heading) => comment.body.startsWith(heading));
}

function mentionsIdentifier(body, issueIdentifier) {
  const escaped = issueIdentifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9._:/-])${escaped}($|[^A-Za-z0-9._:/-])`, "u").test(body);
}

function matchesOwnedHumanActionReply(comment, { rootIssueId, requestCommentId, body, actorId }) {
  return comment && identifier(comment.id) && comment.issueId === rootIssueId && comment.parentId === requestCommentId &&
    comment.userId === actorId && comment.body === body;
}

async function readActorId(client) {
  if (!client || typeof client !== "object" || !("viewer" in client)) {
    throw stableError("foreground_e2e_human_actor_client_invalid");
  }
  let viewer;
  try {
    viewer = await client.viewer;
  } catch {
    throw stableError("foreground_e2e_human_actor_identity_invalid");
  }
  if (!identifier(viewer?.id)) throw stableError("foreground_e2e_human_actor_identity_invalid");
  return viewer.id;
}

async function readIssue(client, issueId, code) {
  if (!client || typeof client.issue !== "function") throw stableError(code);
  const issue = await humanRead(() => client.issue(issueId), code);
  if (!issue || issue.id !== issueId) throw stableError(code);
  return issue;
}

async function readComment(client, commentId, code) {
  if (!client || typeof client.comment !== "function") throw stableError(code);
  const comment = await humanRead(() => client.comment({ id: commentId }), code);
  if (!comment || comment.id !== commentId) throw stableError(code);
  return comment;
}

async function readIssueComments(issue, code) {
  if (!issue || typeof issue.comments !== "function") throw stableError(code);
  return readHumanNodes((after) => issue.comments({ first: 64, includeArchived: true, ...(after ? { after } : {}) }), code);
}

function hasDescriptionConsequence(history, expected, productActorId) {
  return identifier(productActorId) && history.some((entry) => identifier(entry?.id) && entry.actorId === productActorId &&
    timestampValue(entry.updatedAt) && Date.parse(remoteVersion(entry)) > Date.parse(expected.remoteVersion));
}

async function hasCommentReceipt({ source, expected, actorId, productActorId, threadAction }) {
  if (!source || typeof source.children !== "function") throw stableError("foreground_e2e_human_comment_receipt_read_failed");
  const comments = await readHumanNodes(
    (after) => source.children({ first: 64, includeArchived: true, ...(after ? { after } : {}) }),
    "foreground_e2e_human_comment_receipt_read_failed",
  );
  const replies = comments.filter((comment) => matchingHumanReadableReply({ comment, source, expected, actorId, productActorId }));
  if (replies.length > 1) throw stableError("foreground_e2e_human_comment_receipt_ambiguous");
  if (replies.length !== 1) return false;
  const reply = replies[0];
  return expected.kind === "comment_body"
    ? ["check", "cross"].includes(nativeReceipt(source, reply.userId))
    : threadAction === (expected.expectedThreadState === "resolved" ? "resolve" : "reopen");
}

function matchingHumanReadableReply({ comment, source, expected, actorId, productActorId }) {
  return comment && comment.parentId === source.id && comment.issueId === source.issueId && text(comment.body) &&
    identifier(productActorId) && comment.userId === productActorId && comment.userId !== actorId &&
    Date.parse(remoteVersion(comment)) >= Date.parse(expected.remoteVersion);
}

function nativeReceipt(comment, receiptActorId) {
  if (!Array.isArray(comment.reactions)) throw stableError("foreground_e2e_human_comment_receipt_read_failed");
  const receipts = new Set(comment.reactions
    .filter((reaction) => reaction?.userId === receiptActorId && (reaction?.emoji === "✅" || reaction?.emoji === "❌"))
    .map((reaction) => reaction.emoji === "✅" ? "check" : "cross"));
  if (receipts.size > 1) return undefined;
  return receipts.values().next().value ?? "none";
}

function rememberReceipt(receipts, input) {
  const remembered = Object.freeze(input);
  if (receipts.has(remembered.sourceId)) throw stableError("foreground_e2e_human_receipt_ambiguous");
  receipts.set(remembered.sourceId, remembered);
  return remembered;
}

function assertRegisteredReceipt(receipts, input, kind, code) {
  if (!input || input.kind !== kind || !identifier(input.sourceId) || receipts.get(input.sourceId) !== input) {
    throw stableError(code);
  }
  return input;
}

function descriptionInputReference({ rootIssueId, remoteVersion: version }) {
  if (!identifier(rootIssueId) || !timestampValue(version)) throw stableError("foreground_e2e_human_root_read_back_failed");
  return { sourceId: inputId(rootIssueId, version), kind: "description", issueId: rootIssueId, remoteVersion: version };
}

function commentBodyInputReference(comment) {
  const version = remoteVersion(comment);
  if (!identifier(comment?.id) || !identifier(comment?.issueId) || !text(comment?.body) || !timestampValue(version)) {
    throw stableError("foreground_e2e_human_comment_read_back_failed");
  }
  const commentBodyDigest = createHash("sha256").update(comment.body, "utf8").digest("hex");
  return {
    sourceId: inputId(`comment_body:${comment.id}`, commentBodyDigest),
    kind: "comment_body",
    issueId: comment.issueId,
    commentId: comment.id,
    commentBodyDigest,
    remoteVersion: version,
  };
}

function commentThreadStateInputReference(comment) {
  const version = remoteVersion(comment);
  const expectedThreadState = threadState(comment);
  if (!identifier(comment?.id) || !identifier(comment?.issueId) || !timestampValue(version)) {
    throw stableError("foreground_e2e_human_comment_read_back_failed");
  }
  return {
    sourceId: inputId(`comment_thread_state:${comment.id}:${comment.id}:${expectedThreadState}`, version),
    kind: "comment_thread_state",
    issueId: comment.issueId,
    commentId: comment.id,
    threadRootCommentId: comment.id,
    expectedThreadState,
    remoteVersion: version,
  };
}

function inputId(sourceId, sourceVersion) {
  return `input:${createHash("sha256").update(`${sourceId}\u0000${sourceVersion}`, "utf8").digest("hex")}`;
}

function remoteVersion(value) {
  const updatedAt = value?.updatedAt;
  if (updatedAt instanceof Date) return updatedAt.toISOString();
  return typeof updatedAt === "string" ? updatedAt : undefined;
}

function threadState(comment) {
  return comment?.resolvedAt ? "resolved" : "unresolved";
}

function timestampValue(value) {
  return value instanceof Date ? !Number.isNaN(value.valueOf()) : typeof value === "string" && !Number.isNaN(Date.parse(value));
}

async function readLabels(issue, code) {
  if (!issue || typeof issue.labels !== "function") throw stableError(code);
  const page = await humanRead(() => issue.labels({ first: 64 }), code);
  if (!page || !Array.isArray(page.nodes) || page.pageInfo?.hasNextPage !== false) throw stableError(code);
  return page.nodes;
}

async function readChildren(issue, code) {
  if (!issue || typeof issue.children !== "function") throw stableError(code);
  return readHumanNodes((after) => issue.children({ first: 64, ...(after ? { after } : {}) }), code);
}

async function readIssueHistory(issue, code) {
  if (!issue || typeof issue.history !== "function") throw stableError(code);
  return readHumanNodes(
    (after) => issue.history({ first: 64, includeArchived: true, ...(after ? { after } : {}) }),
    code,
  );
}

function latestStatusActivity(history, stateId) {
  return history
    .filter((entry) => entry?.toStateId === stateId && identifier(entry.id) && timestampValue(entry.updatedAt))
    .sort((left, right) => Date.parse(remoteVersion(right)) - Date.parse(remoteVersion(left)))[0];
}

async function readTeamStatuses(client, teamId, code) {
  if (!client || typeof client.team !== "function" || !identifier(teamId)) throw stableError(code);
  const team = await humanRead(() => client.team(teamId), code);
  if (!team || team.id !== teamId || typeof team.states !== "function") throw stableError(code);
  const states = await readHumanNodes((after) => team.states({ first: 64, includeArchived: true, ...(after ? { after } : {}) }), code);
  if (states.some((state) => !state || !identifier(state.id) || typeof state.name !== "string" || typeof state.type !== "string")) throw stableError(code);
  return states;
}

async function humanRead(operation, code) {
  try {
    return await operation();
  } catch (error) {
    throw stableError(classifyLinearFailure(error, code));
  }
}

function readHumanNodes(readPage, code) {
  return readAllLinearNodes(readPage, code, classifyLinearFailure);
}

function assertRevisionWaitInput({ signal }) {
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) {
    throw stableError("foreground_e2e_human_revision_wait_input_invalid");
  }
}

function waitForChange(signal, abortCode) {
  if (signal?.aborted) throw stableError(abortCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, HUMAN_ACTION_POLL_INTERVAL_MS);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(stableError(abortCode));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function matchesCreatedRoot(issue, labels, input, rootCreationInput) {
  return issue.id !== undefined && issue.teamId === input.teamId && issue.projectId === input.projectId &&
    (issue.parentId === null || issue.parentId === undefined) && issue.title === rootCreationInput.title &&
    issue.description === rootCreationInput.description && issue.priority === linearPriorityValue(rootCreationInput.priority) && issue.stateId === input.rootStatusId &&
    (issue.delegateId === null || issue.delegateId === undefined) && matchesRootLabels(labels, input);
}

function matchesKnownRoot(issue, labels, known) {
  return issue.id === known.rootIssueId && issue.teamId === known.teamId && issue.projectId === known.projectId &&
    (issue.parentId === null || issue.parentId === undefined) && matchesRootLabels(labels, known);
}

function matchesRootLabels(labels, root) {
  return labels.length === 2 && new Set(labels.map(({ id }) => id)).size === 2 &&
    labels.some(({ id }) => id === root.rootLabelId) && labels.some(({ id }) => id === root.routingLabelId);
}

function matchesOwnedRootComment(comment, { issueId, body, actorId }) {
  return comment.issueId === issueId && comment.userId === actorId &&
    (comment.parentId === null || comment.parentId === undefined) && (body === undefined || comment.body === body);
}

function matchesOwnedHumanInput(comment, { issueId, actorId }) {
  return comment?.issueId === issueId && comment.userId === actorId && identifier(comment.id) && text(comment.body) &&
    (comment.parentId === null || comment.parentId === undefined || identifier(comment.parentId));
}

async function write(operation, code, signal) {
  try {
    return await abortable(operation, signal);
  } catch (error) {
    throw stableError(classifyLinearFailure(error, code));
  }
}

function abortable(operation, signal) {
  if (signal?.aborted) return Promise.reject(abortedRequestError());
  if (!signal) return Promise.resolve().then(operation);
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(reject, abortedRequestError());
    const finish = (settle, value) => {
      signal.removeEventListener("abort", onAbort);
      settle(value);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function classifyLinearFailure(error, fallbackCode) {
  if (error instanceof RatelimitedLinearError) return "foreground_e2e_human_linear_rate_limited";
  if (error instanceof NetworkLinearError) return "foreground_e2e_human_linear_network_failed";
  if (error instanceof InternalLinearError) return "foreground_e2e_human_linear_internal_failed";
  if (error?.name === "AbortError") return "foreground_e2e_human_linear_request_aborted";
  return fallbackCode;
}

function abortedRequestError() {
  const error = new Error();
  error.name = "AbortError";
  return error;
}

function assertOperationSignal(signal, code) {
  if (signal !== undefined && !abortSignal(signal)) throw stableError(code);
}

function abortSignal(signal) {
  return signal && typeof signal.aborted === "boolean" && typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function";
}

function token(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function shortHash(value) {
  return typeof value === "string" && /^[a-f0-9]{12}$/u.test(value);
}

function directory(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\u0000");
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768;
}

function linearPriorityValue(value) {
  switch (value) {
    case "no_priority": return 0;
    case "urgent": return 1;
    case "high": return 2;
    case "normal": return 3;
    case "low": return 4;
    default: throw stableError("foreground_e2e_human_case_catalog_invalid");
  }
}

function emojiValue(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !/\p{Cc}/u.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
