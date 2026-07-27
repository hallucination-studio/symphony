import { createHash } from "node:crypto";

import {
  InternalLinearError,
  LinearClient,
  NetworkLinearError,
  RatelimitedLinearError,
} from "@linear/sdk";
import { parseManagedRecordBlock } from "@symphony/contracts/managed-record";

import { FOREGROUND_E2E_CASES } from "./cases.mjs";
import { readAllLinearNodes } from "./linear-environment.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const TERMINAL_HUMAN_ACTION_STATUSES = new Set(["Approved", "Rejected", "Answered", "Canceled"]);
const PLAN_REVIEW_TERMINAL_STATUSES = new Set(["Approved", "Rejected"]);
const CLARIFICATION_TERMINAL_STATUSES = new Set(["Answered"]);
const HUMAN_ACTION_KIND_LABELS = new Set([
  "Plan Review",
  "Clarification",
  "Permission",
  "Finding Waiver",
  "Convergence Override",
]);
const PREEMPTION_CORE_ROOT_KEYS = new Set(
  FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "same_conductor_preemption")
    ?.declaredUserInteractions.find(({ kind }) => kind === "bind_preemption_roles")?.rootKeys ?? [],
);
export const HUMAN_ACTION_POLL_INTERVAL_MS = 5_000;

export async function createForegroundE2EHumanActor({
  apiKey,
  expectedActorId,
  delegateActorId,
  createClient = (options) => new LinearClient(options),
} = {}) {
  if (!token(apiKey) || !identifier(expectedActorId) || typeof createClient !== "function") {
    throw stableError("foreground_e2e_human_actor_input_invalid");
  }
  let client;
  try {
    client = createClient({ apiKey });
  } catch {
    throw stableError("foreground_e2e_human_actor_client_invalid");
  }
  const actorId = await readActorId(client);
  if (actorId !== expectedActorId) throw stableError("foreground_e2e_human_actor_identity_invalid");
  const clientForCase = (signal) => {
    if (signal === undefined) return client;
    if (!abortSignal(signal)) throw stableError("foreground_e2e_human_operation_input_invalid");
    if (signal.aborted) throw stableError("foreground_e2e_human_linear_request_aborted");
    try {
      return createClient({ apiKey, signal });
    } catch {
      throw stableError("foreground_e2e_human_actor_client_invalid");
    }
  };

  const rootCatalog = rootCatalogByKey();
  const roots = new Map();
  const createdRootKeys = new Set();
  const verifiedUndelegatedRootIds = new Set();
  const comments = new Map();
  const receiptInputs = new Map();
  return Object.freeze({
    actorId,
    async resolveRootCreationBindings({ teamId, projectId, conductors } = {}) {
      const resolvedConductors = assertConductorBindings({ teamId, projectId, conductors });
      const statuses = await readTeamStatuses(client, teamId, "foreground_e2e_human_root_binding_read_failed");
      const todo = statuses.filter((state) => state.name === "Todo" && state.type === "unstarted");
      if (todo.length !== 1) throw stableError("foreground_e2e_human_root_binding_read_failed");
      const labels = new Map();
      for (const conductor of resolvedConductors.values()) {
        labels.set(conductor.conductorRef, await readRoutingLabel({
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

    async createRootIssue(input) {
      const rootSpec = assertRootCreateInput(input, rootCatalog);
      assertOperationSignal(input.signal, "foreground_e2e_human_root_create_input_invalid");
      if (createdRootKeys.has(input.rootKey)) {
        throw stableError("foreground_e2e_human_root_create_not_declared");
      }
      const requestClient = clientForCase(input.signal);
      const payload = await write(
        () => requestClient.createIssue({
          teamId: input.teamId,
          projectId: input.projectId,
          stateId: input.rootStatusId,
          labelIds: [input.routingLabelId],
          title: rootSpec.rootCreationInput.title,
          description: rootSpec.rootCreationInput.description,
          priority: linearPriorityValue(rootSpec.rootCreationInput.priority),
        }),
        "foreground_e2e_human_root_create_failed",
        input.signal,
      );
      if (payload?.success !== true || !identifier(payload.issueId)) {
        throw stableError("foreground_e2e_human_root_create_failed");
      }
      const issue = await readIssue(requestClient, payload.issueId, "foreground_e2e_human_root_read_back_failed");
      const labels = await readLabels(issue, "foreground_e2e_human_root_read_back_failed");
      if (!matchesCreatedRoot(issue, labels, input, rootSpec.rootCreationInput)) {
        throw stableError("foreground_e2e_human_root_read_back_failed");
      }
      roots.set(issue.id, Object.freeze({
        rootIssueId: issue.id,
        rootKey: input.rootKey,
        caseId: input.caseId,
        declaredDescriptionUpdates: rootSpec.declaredDescriptionUpdates,
        projectId: input.projectId,
        teamId: input.teamId,
        routingLabelId: input.routingLabelId,
        rootStatusId: input.rootStatusId,
        title: rootSpec.rootCreationInput.title,
        description: rootSpec.rootCreationInput.description,
      }));
      createdRootKeys.add(input.rootKey);
      return Object.freeze({ rootIssueId: issue.id, identifier: issue.identifier });
    },

    async assertRootUndelegatedAndInactive({ rootIssueId, signal } = {}) {
      assertOperationSignal(signal, "foreground_e2e_human_root_admission_input_invalid");
      const known = assertKnownRoot(roots, rootIssueId);
      const requestClient = clientForCase(signal);
      await verifyUndelegatedRoot({ client: requestClient, known, delegateActorId, signal });
      verifiedUndelegatedRootIds.add(rootIssueId);
    },

    async delegateRootIssue({ rootIssueId, signal } = {}) {
      if (!identifier(delegateActorId)) throw stableError("foreground_e2e_human_root_delegate_actor_invalid");
      assertOperationSignal(signal, "foreground_e2e_human_root_delegate_input_invalid");
      const known = assertKnownRoot(roots, rootIssueId);
      if (!verifiedUndelegatedRootIds.has(rootIssueId)) {
        throw stableError("foreground_e2e_human_root_delegate_not_verified");
      }
      const requestClient = clientForCase(signal);
      await verifyUndelegatedRoot({ client: requestClient, known, delegateActorId, signal });
      const payload = await write(
        () => requestClient.updateIssue(rootIssueId, { delegateId: delegateActorId }),
        "foreground_e2e_human_root_delegate_failed",
        signal,
      );
      if (payload?.success !== true || payload.issueId !== rootIssueId) {
        throw stableError("foreground_e2e_human_root_delegate_failed");
      }
      const delegated = await readIssue(requestClient, rootIssueId, "foreground_e2e_human_root_delegate_read_back_failed");
      const labels = await readLabels(delegated, "foreground_e2e_human_root_delegate_read_back_failed");
      if (!matchesKnownRoot(delegated, labels, known) || delegated.delegateId !== delegateActorId) {
        throw stableError("foreground_e2e_human_root_delegate_read_back_failed");
      }
      verifiedUndelegatedRootIds.delete(rootIssueId);
    },

    async waitForPlanReviewAction({ rootIssueId, terminalStatus, signal } = {}) {
      const known = assertKnownRoot(roots, rootIssueId);
      assertPlanReviewWaitInput({ terminalStatus, signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const action = await activePlanReviewAction({ client: requestClient, rootIssueId, known, actorId, terminalStatus });
        if (action) return Object.freeze(action);
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

    async waitForSameConductorPreemptionCandidate({ inflightStageExecutionId, touchedRootIssueId, remainingRootIssueId, signal } = {}) {
      const known = assertPreemptionCandidateRoots(roots, {
        inflightStageExecutionId,
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
          inflightStageExecutionId,
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

    async waitForClarificationAction({ rootIssueId, terminalStatus, signal } = {}) {
      const known = assertKnownClarificationRoot(roots, rootIssueId);
      assertClarificationWaitInput({ terminalStatus, signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const action = await activeClarificationAction({ client: requestClient, rootIssueId, known, actorId, terminalStatus });
        if (action) return Object.freeze(action);
        await waitForChange(signal, "foreground_e2e_human_clarification_aborted");
      }
    },

    async waitForPlanContractAndPlanReviewAction({ rootIssueId, signal } = {}) {
      const known = assertKnownRoot(roots, rootIssueId);
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const gate = await activePlanGate({ client: requestClient, rootIssueId, known, actorId });
        if (gate) return Object.freeze(gate);
        await waitForChange(signal, "foreground_e2e_human_revision_wait_aborted");
      }
    },

    async waitForSuccessorPlanContractAndPlanReviewAction({ rootIssueId, priorCycleIssueId, priorPlanReviewActionIssueId, signal } = {}) {
      const known = assertKnownRoot(roots, rootIssueId);
      if (!identifier(priorCycleIssueId) || !identifier(priorPlanReviewActionIssueId)) {
        throw stableError("foreground_e2e_human_successor_plan_input_invalid");
      }
      assertRevisionWaitInput({ signal });
      const requestClient = clientForCase(signal);
      while (true) {
        const gate = await activePlanGate({
          client: requestClient,
          rootIssueId,
          known,
          actorId,
          excludedCycleIssueId: priorCycleIssueId,
          excludedPlanReviewActionIssueId: priorPlanReviewActionIssueId,
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
        const directives = await readIssueComments(root, "foreground_e2e_human_description_receipt_read_failed");
        if (hasDescriptionDirectiveReceipt(directives, rootIssueId, expected.sourceId, actorId)) return;
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
        if (!matchesOwnedRootComment(source, { issueId, actorId })) throw stableError("foreground_e2e_human_comment_receipt_target_invalid");
        if (await hasCommentReceipt({ source, expected, actorId, threadAction: undefined })) return;
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
        if (await hasCommentReceipt({ source, expected, actorId, threadAction: action })) return;
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

    async setHumanActionTerminalStatus({ issueId, terminalStatus, stateId, signal } = {}) {
      if (!identifier(issueId) || !identifier(stateId) || !TERMINAL_HUMAN_ACTION_STATUSES.has(terminalStatus)) {
        throw stableError("foreground_e2e_human_action_status_input_invalid");
      }
      assertOperationSignal(signal, "foreground_e2e_human_action_status_input_invalid");
      const requestClient = clientForCase(signal);
      const before = await readIssue(requestClient, issueId, "foreground_e2e_human_action_target_invalid");
      const beforeLabels = await readLabels(before, "foreground_e2e_human_action_target_invalid");
      if (!isHumanAction(beforeLabels)) throw stableError("foreground_e2e_human_action_target_invalid");
      const payload = await write(
        () => requestClient.updateIssue(issueId, { stateId }),
        "foreground_e2e_human_action_status_failed",
        signal,
      );
      if (payload?.success !== true || payload.issueId !== issueId) {
        throw stableError("foreground_e2e_human_action_status_failed");
      }
      const after = await readIssue(requestClient, issueId, "foreground_e2e_human_action_read_back_failed");
      const afterLabels = await readLabels(after, "foreground_e2e_human_action_read_back_failed");
      if (!isHumanAction(afterLabels) || after.stateId !== stateId) {
        throw stableError("foreground_e2e_human_action_read_back_failed");
      }
    },
  });
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
  if (!input || !identifier(input.rootKey) || !identifier(input.teamId) || !identifier(input.projectId) || !identifier(input.routingLabelId) ||
      !identifier(input.rootStatusId) || !identifier(input.caseId)) {
    throw stableError("foreground_e2e_human_root_create_input_invalid");
  }
  const rootSpec = rootCatalog.get(input.rootKey);
  if (!rootSpec || rootSpec.caseId !== input.caseId) {
    throw stableError("foreground_e2e_human_root_create_input_invalid");
  }
  return rootSpec;
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

async function readRoutingLabel({ client, teamId, name }) {
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

function assertPreemptionCandidateRoots(roots, { inflightStageExecutionId, touchedRootIssueId, remainingRootIssueId }) {
  if (!identifier(inflightStageExecutionId) || !identifier(touchedRootIssueId) || !identifier(remainingRootIssueId) ||
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

async function readPreemptionRootSnapshot({ client, root }) {
  const code = "foreground_e2e_human_preemption_read_failed";
  const issue = await readIssue(client, root.rootIssueId, code);
  const labels = await readLabels(issue, code);
  if (!matchesKnownRoot(issue, labels, root) || !Number.isFinite(issue.priority)) {
    throw stableError(code);
  }
  const tree = await readPreemptionIssueTree(issue, code, new Set());
  const records = [];
  for (const node of tree) {
    const comments = await readIssueComments(node, code);
    for (const comment of comments) {
      const record = parseRecord(comment?.body);
      if (record) records.push(record);
    }
  }
  const history = await readHumanNodes(
    (after) => issue.history({ first: 64, includeArchived: true, ...(after ? { after } : {}) }),
    code,
  );
  if (history.some((entry) => !validPreemptionActivity(entry, root.rootIssueId))) throw stableError(code);
  return {
    rootIssueId: root.rootIssueId,
    priority: issue.priority,
    owners: records.filter((record) => record.kind === "root_ownership" && record.root_issue_id === root.rootIssueId),
    executions: records.filter((record) => record.kind === "stage_execution" && record.root_issue_id === root.rootIssueId),
    results: records.filter((record) => record.kind === "stage_result" && record.root_issue_id === root.rootIssueId),
    history,
  };
}

async function readRestartRecoveryRootSnapshot({ client, root }) {
  const code = "foreground_e2e_human_recovery_read_failed";
  const issue = await readIssue(client, root.rootIssueId, code);
  const labels = await readLabels(issue, code);
  if (!matchesKnownRoot(issue, labels, root)) throw stableError(code);
  const records = [];
  for (const node of await readPreemptionIssueTree(issue, code, new Set())) {
    for (const comment of await readIssueComments(node, code)) {
      const record = parseRecord(comment?.body);
      if (record) records.push(record);
    }
  }
  return {
    rootIssueId: root.rootIssueId,
    executions: records.filter((record) => record.kind === "stage_execution" && record.root_issue_id === root.rootIssueId),
    results: records.filter((record) => record.kind === "stage_result" && record.root_issue_id === root.rootIssueId),
  };
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
  const active = snapshots.flatMap((snapshot) => snapshot.executions.filter((record) => !stageResultFor(snapshot.results, record.stage_execution_id))
    .map((record) => ({ rootIssueId: snapshot.rootIssueId, stageExecutionId: record.stage_execution_id })));
  const ready = snapshots.filter(({ executions }) => executions.length === 0).map(({ rootIssueId }) => rootIssueId);
  if (active.length !== 1 || ready.length !== 2 || !active.every(({ rootIssueId, stageExecutionId }) => identifier(rootIssueId) && identifier(stageExecutionId))) {
    return undefined;
  }
  return { inflightRootIssueId: active[0].rootIssueId, inflightStageExecutionId: active[0].stageExecutionId, readyRootIssueIds: ready };
}

function restartRecoveryAdmission(snapshots, affectedRootIssueId) {
  if (!Array.isArray(snapshots) || snapshots.length !== 2) return undefined;
  const affected = snapshots.find(({ rootIssueId }) => rootIssueId === affectedRootIssueId);
  if (!affected) return undefined;
  const active = affected.executions.filter((record) => !stageResultFor(affected.results, record.stage_execution_id));
  if (active.length !== 1 || !identifier(active[0]?.stage_execution_id)) return undefined;
  return { affectedRootIssueId, oldStageExecutionId: active[0].stage_execution_id };
}

function preemptionCandidate({ snapshots, actorId, inflightStageExecutionId, touchedRootIssueId, remainingRootIssueId }) {
  const inflight = snapshots.find(({ rootIssueId }) => rootIssueId !== touchedRootIssueId && rootIssueId !== remainingRootIssueId);
  const touched = snapshots.find(({ rootIssueId }) => rootIssueId === touchedRootIssueId);
  const remaining = snapshots.find(({ rootIssueId }) => rootIssueId === remainingRootIssueId);
  if (!inflight || !touched || !remaining || !samePreemptionOwner(snapshots)) return undefined;
  const result = stageResultFor(inflight.results, inflightStageExecutionId);
  const terminalAt = Date.parse(result?.completed_at);
  if (!Number.isFinite(terminalAt)) return undefined;
  const readyAtTerminal = [touched, remaining].every((snapshot) => snapshot.executions
    .every(({ started_at }) => Date.parse(started_at) > terminalAt));
  if (!readyAtTerminal) return undefined;
  const touch = touched.history.filter((entry) => entry.actorId === actorId && entry.updatedDescription === true)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  if (touch.length !== 1 || !identifier(touch[0].id) || Date.parse(touch[0].createdAt) >= terminalAt) return undefined;
  const candidates = [touched, remaining].flatMap((snapshot) => snapshot.executions
    .filter(({ started_at }) => Date.parse(started_at) > terminalAt)
    .map((record) => ({ rootIssueId: snapshot.rootIssueId, record })))
    .sort((left, right) => Date.parse(left.record.started_at) - Date.parse(right.record.started_at));
  const first = candidates[0];
  if (!first || candidates.filter(({ record }) => record.started_at === first.record.started_at).length !== 1 ||
      first.rootIssueId !== touchedRootIssueId || !identifier(first.record.stage_execution_id)) return undefined;
  return { rootIssueId: touchedRootIssueId, stageExecutionId: first.record.stage_execution_id, touchActivityId: touch[0].id };
}

function samePreemptionOwner(snapshots) {
  const owners = snapshots.map(({ owners }) => owners);
  return owners.every((records) => records.length === 1 && identifier(records[0]?.conductor_id)) &&
    new Set(owners.map(([record]) => record.conductor_id)).size === 1;
}

function stageResultFor(results, stageExecutionId) {
  const matches = results.filter((record) => record.model_turn?.stage_execution_id === stageExecutionId || record.result_id === stageExecutionId);
  return matches.length === 1 ? matches[0] : undefined;
}

function validPreemptionActivity(entry, rootIssueId) {
  return entry && identifier(entry.id) && entry.issueId === rootIssueId &&
    (entry.actorId === null || entry.actorId === undefined || identifier(entry.actorId)) &&
    timestampValue(entry.createdAt) && timestampValue(entry.updatedAt);
}

async function activePlanReviewAction({ client, rootIssueId, known, actorId, terminalStatus }) {
  const root = await readIssue(client, rootIssueId, "foreground_e2e_human_plan_review_target_invalid");
  const rootLabels = await readLabels(root, "foreground_e2e_human_plan_review_target_invalid");
  if (!matchesKnownRoot(root, rootLabels, known)) {
    throw stableError("foreground_e2e_human_plan_review_target_invalid");
  }
  const cycles = await readChildren(root, "foreground_e2e_human_plan_review_read_failed");
  const candidates = [];
  for (const cycle of cycles) {
    if (!matchesChildScope(cycle, { parentId: rootIssueId, known })) continue;
    const children = await readChildren(cycle, "foreground_e2e_human_plan_review_read_failed");
    for (const child of children) {
      if (!matchesChildScope(child, { parentId: cycle.id, known })) continue;
      const labels = await readLabels(child, "foreground_e2e_human_plan_review_read_failed");
      if (!isPlanReviewAction(labels)) continue;
      if (!identifier(child.creatorId) || child.creatorId === actorId) {
        throw stableError("foreground_e2e_human_plan_review_creator_invalid");
      }
      if (!isProductPlanReviewAction(child)) {
        throw stableError("foreground_e2e_human_plan_review_content_invalid");
      }
      candidates.push(child);
    }
  }
  if (candidates.length === 0) return undefined;
  const statuses = await readTeamStatuses(client, root.teamId, "foreground_e2e_human_plan_review_read_failed");
  const terminal = statuses.filter(({ name, archivedAt }) => name === terminalStatus && !archivedAt);
  if (terminal.length !== 1) throw stableError("foreground_e2e_human_plan_review_status_invalid");

  const pending = candidates.filter((action) => {
    const current = statuses.filter(({ id, archivedAt }) => id === action.stateId && !archivedAt);
    if (current.length !== 1) throw stableError("foreground_e2e_human_plan_review_status_invalid");
    if (["Todo", "In Progress"].includes(current[0].name)) return true;
    if (["Approved", "Rejected", "Canceled"].includes(current[0].name)) return false;
    throw stableError("foreground_e2e_human_plan_review_status_invalid");
  });
  if (pending.length > 1) throw stableError("foreground_e2e_human_plan_review_ambiguous");
  const action = pending[0];
  return action ? { actionIssueId: action.id, terminalStatusId: terminal[0].id } : undefined;
}

async function activeClarificationAction({ client, rootIssueId, known, actorId, terminalStatus }) {
  const root = await readIssue(client, rootIssueId, "foreground_e2e_human_clarification_target_invalid");
  const rootLabels = await readLabels(root, "foreground_e2e_human_clarification_target_invalid");
  if (!matchesKnownRoot(root, rootLabels, known)) {
    throw stableError("foreground_e2e_human_clarification_target_invalid");
  }
  const cycles = await readChildren(root, "foreground_e2e_human_clarification_read_failed");
  const candidates = [];
  for (const cycle of cycles) {
    if (!matchesChildScope(cycle, { parentId: rootIssueId, known })) continue;
    const children = await readChildren(cycle, "foreground_e2e_human_clarification_read_failed");
    for (const child of children) {
      if (!matchesChildScope(child, { parentId: cycle.id, known })) continue;
      const labels = await readLabels(child, "foreground_e2e_human_clarification_read_failed");
      if (!isClarificationAction(labels)) continue;
      if (!identifier(child.creatorId) || child.creatorId === actorId) {
        throw stableError("foreground_e2e_human_clarification_creator_invalid");
      }
      if (!isProductClarificationAction(child)) {
        throw stableError("foreground_e2e_human_clarification_content_invalid");
      }
      candidates.push(child);
    }
  }
  if (candidates.length === 0) return undefined;
  const statuses = await readTeamStatuses(client, root.teamId, "foreground_e2e_human_clarification_read_failed");
  const terminal = statuses.filter(({ name, archivedAt }) => name === terminalStatus && !archivedAt);
  if (terminal.length !== 1) throw stableError("foreground_e2e_human_clarification_status_invalid");

  const pending = candidates.filter((action) => {
    const current = statuses.filter(({ id, archivedAt }) => id === action.stateId && !archivedAt);
    if (current.length !== 1) throw stableError("foreground_e2e_human_clarification_status_invalid");
    if (["Todo", "In Progress"].includes(current[0].name)) return true;
    if (["Answered", "Canceled"].includes(current[0].name)) return false;
    throw stableError("foreground_e2e_human_clarification_status_invalid");
  });
  if (pending.length > 1) throw stableError("foreground_e2e_human_clarification_ambiguous");
  const action = pending[0];
  return action ? { actionIssueId: action.id, terminalStatusId: terminal[0].id } : undefined;
}

async function activePlanGate({
  client,
  rootIssueId,
  known,
  actorId,
  excludedCycleIssueId = undefined,
  excludedPlanReviewActionIssueId = undefined,
}) {
  const root = await readIssue(client, rootIssueId, "foreground_e2e_human_plan_gate_target_invalid");
  const rootLabels = await readLabels(root, "foreground_e2e_human_plan_gate_target_invalid");
  if (!matchesKnownRoot(root, rootLabels, known)) throw stableError("foreground_e2e_human_plan_gate_target_invalid");
  const statuses = await readTeamStatuses(client, root.teamId, "foreground_e2e_human_plan_gate_read_failed");
  const cycles = await readChildren(root, "foreground_e2e_human_plan_gate_read_failed");
  const gates = [];
  for (const cycle of cycles) {
    if (!matchesChildScope(cycle, { parentId: rootIssueId, known }) || cycle.id === excludedCycleIssueId) continue;
    const children = await readChildren(cycle, "foreground_e2e_human_plan_gate_read_failed");
    const plans = [];
    const actions = [];
    for (const child of children) {
      if (!matchesChildScope(child, { parentId: cycle.id, known })) continue;
      const labels = await readLabels(child, "foreground_e2e_human_plan_gate_read_failed");
      if (isPlanIssue(labels)) plans.push(child);
      if (isPlanReviewAction(labels)) actions.push(child);
    }
    if (plans.length > 1 || actions.length > 1) throw stableError("foreground_e2e_human_plan_gate_ambiguous");
    const plan = plans[0];
    const action = actions[0];
    if (!plan || !action || action.id === excludedPlanReviewActionIssueId) continue;
    if (!identifier(action.creatorId) || action.creatorId === actorId || !isProductPlanReviewAction(action) ||
        !isPendingPlanReviewAction(action, statuses)) continue;
    const contract = await matchingPlanContract({ plan, rootIssueId, cycleIssueId: cycle.id, actorId });
    if (!contract) continue;
    gates.push({
      cycleIssueId: cycle.id,
      planIssueId: plan.id,
      planContractDigest: contract.planContractDigest,
      planContractSourceCommentId: contract.sourceCommentId,
      planReviewActionIssueId: action.id,
    });
  }
  if (gates.length > 1) throw stableError("foreground_e2e_human_plan_gate_ambiguous");
  return gates[0];
}

function isPendingPlanReviewAction(action, statuses) {
  const current = statuses.filter(({ id, archivedAt }) => id === action.stateId && !archivedAt);
  if (current.length !== 1) throw stableError("foreground_e2e_human_plan_gate_status_invalid");
  if (["Todo", "In Progress"].includes(current[0].name)) return true;
  if (["Approved", "Rejected", "Canceled"].includes(current[0].name)) return false;
  throw stableError("foreground_e2e_human_plan_gate_status_invalid");
}

async function matchingPlanContract({ plan, rootIssueId, cycleIssueId, actorId }) {
  const comments = await readIssueComments(plan, "foreground_e2e_human_plan_gate_read_failed");
  const matches = comments.flatMap((comment) => {
    const record = parseRecord(comment.body);
    return identifier(comment?.userId) && comment.userId !== actorId && record?.kind === "plan_contract" && record.root_issue_id === rootIssueId &&
      record.cycle_issue_id === cycleIssueId && identifier(record.plan_contract_digest)
      ? [{ sourceCommentId: comment.id, planContractDigest: record.plan_contract_digest }]
      : [];
  });
  if (matches.length > 1) throw stableError("foreground_e2e_human_plan_gate_ambiguous");
  return matches[0];
}

function isPlanIssue(labels) {
  const names = labels.map(({ name }) => name);
  return names.includes("Plan") && !names.includes("Human Action");
}

function matchesChildScope(issue, { parentId, known }) {
  return issue && identifier(issue.id) && issue.parentId === parentId && issue.teamId === known.teamId &&
    issue.projectId === known.projectId && identifier(issue.stateId) &&
    (issue.archivedAt === null || issue.archivedAt === undefined);
}

function isPlanReviewAction(labels) {
  const names = labels.map(({ name }) => name);
  return names.length === 2 && names.includes("Human Action") && names.includes("Plan Review");
}

function isClarificationAction(labels) {
  const names = labels.map(({ name }) => name);
  return names.length === 2 && names.includes("Human Action") && names.includes("Clarification");
}

function isProductPlanReviewAction(issue) {
  return typeof issue.description === "string" && issue.description.includes("## Plan Contract") &&
    issue.description.includes("Approved:") && issue.description.includes("Rejected:");
}

function isProductClarificationAction(issue) {
  return typeof issue.description === "string" && [
    "## Symphony Human Action",
    "## Requested action",
    "## What is being reviewed or requested",
    "## Available outcomes",
    "- Answered:",
    "## Comment requirement",
    "fresh comment",
    "## What happens next",
  ].every((required) => issue.description.includes(required));
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

function hasDescriptionDirectiveReceipt(comments, rootIssueId, sourceId, actorId) {
  const matches = comments.filter((comment) => {
    const record = parseRecord(comment?.body);
    return identifier(comment?.userId) && comment.userId !== actorId && record?.kind === "root_directive" && record.root_issue_id === rootIssueId &&
      Array.isArray(record.consumed_input_ids) && record.consumed_input_ids.filter((id) => id === sourceId).length === 1;
  });
  if (matches.length > 1) throw stableError("foreground_e2e_human_description_receipt_ambiguous");
  return matches.length === 1;
}

async function hasCommentReceipt({ source, expected, actorId, threadAction }) {
  if (!source || typeof source.children !== "function") throw stableError("foreground_e2e_human_comment_receipt_read_failed");
  const comments = await readHumanNodes(
    (after) => source.children({ first: 64, includeArchived: true, ...(after ? { after } : {}) }),
    "foreground_e2e_human_comment_receipt_read_failed",
  );
  const replies = comments.filter((comment) => matchingReplyRecord({ comment, source, expected, threadAction, actorId }));
  if (replies.length > 1) throw stableError("foreground_e2e_human_comment_receipt_ambiguous");
  if (replies.length !== 1) return false;
  const reply = replies[0];
  const record = parseRecord(reply.body);
  if (!record) throw stableError("foreground_e2e_human_comment_receipt_read_failed");
  return expected.kind === "comment_body"
    ? nativeReceipt(source, reply.userId) === record.reaction
    : record.reaction === "none";
}

function matchingReplyRecord({ comment, source, expected, threadAction, actorId }) {
  const record = parseRecord(comment?.body);
  if (!record || record.kind !== "root_reconciler_reply" || record.source_input_id !== expected.sourceId ||
      comment.parentId !== source.id || record.target_issue_id !== source.issueId ||
      !identifier(comment.userId) || comment.userId === actorId || !record.source || typeof record.source !== "object") return false;
  if (expected.kind === "comment_body") {
    return record.source.kind === "comment_body" && record.source.comment_id === expected.commentId &&
      record.source.comment_body_digest === expected.commentBodyDigest &&
      ["check", "cross", "none"].includes(record.reaction) && ["resolve", "keep_open", "reopen"].includes(record.thread_action);
  }
  return record.source.kind === "comment_thread_state" && record.source.comment_id === expected.commentId &&
    record.source.comment_remote_version === expected.remoteVersion &&
    record.source.thread_root_comment_id === expected.threadRootCommentId &&
    record.source.thread_state === expected.expectedThreadState && record.reaction === "none" &&
    record.thread_action === threadAction;
}

function nativeReceipt(comment, receiptActorId) {
  if (!Array.isArray(comment.reactions)) throw stableError("foreground_e2e_human_comment_receipt_read_failed");
  const receipts = new Set(comment.reactions
    .filter((reaction) => reaction?.userId === receiptActorId && (reaction?.emoji === "✅" || reaction?.emoji === "❌"))
    .map((reaction) => reaction.emoji === "✅" ? "check" : "cross"));
  if (receipts.size > 1) return undefined;
  return receipts.values().next().value ?? "none";
}

function parseRecord(body) {
  const parsed = parseManagedRecordBlock(body);
  return parsed.ok ? parsed.record : undefined;
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

function assertPlanReviewWaitInput({ terminalStatus, signal }) {
  if (!PLAN_REVIEW_TERMINAL_STATUSES.has(terminalStatus)) {
    throw stableError("foreground_e2e_human_plan_review_input_invalid");
  }
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) {
    throw stableError("foreground_e2e_human_plan_review_input_invalid");
  }
}

function assertRevisionWaitInput({ signal }) {
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) {
    throw stableError("foreground_e2e_human_revision_wait_input_invalid");
  }
}

function assertClarificationWaitInput({ terminalStatus, signal }) {
  if (!CLARIFICATION_TERMINAL_STATUSES.has(terminalStatus)) {
    throw stableError("foreground_e2e_human_clarification_input_invalid");
  }
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) {
    throw stableError("foreground_e2e_human_clarification_input_invalid");
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
    (issue.delegateId === null || issue.delegateId === undefined) && labels.length === 1 && labels[0]?.id === input.routingLabelId;
}

function matchesKnownRoot(issue, labels, known) {
  return issue.id === known.rootIssueId && issue.teamId === known.teamId && issue.projectId === known.projectId &&
    (issue.parentId === null || issue.parentId === undefined) && labels.length === 1 &&
    labels[0]?.id === known.routingLabelId;
}

async function verifyUndelegatedRoot({ client, known, delegateActorId, signal }) {
  const code = "foreground_e2e_human_root_admission_read_back_failed";
  const root = await readIssue(client, known.rootIssueId, code);
  const [labels, children, comments] = await Promise.all([
    readLabels(root, code),
    readChildren(root, code),
    readIssueComments(root, code),
  ]);
  if (!matchesKnownRoot(root, labels, known) || root.stateId !== known.rootStatusId || root.title !== known.title ||
      root.description !== known.description || root.delegateId !== null && root.delegateId !== undefined ||
      children.length !== 0 || comments.length !== 0 || signal?.aborted || delegateActorId !== undefined && !identifier(delegateActorId)) {
    throw stableError(code);
  }
}

function matchesOwnedRootComment(comment, { issueId, body, actorId }) {
  return comment.issueId === issueId && comment.userId === actorId &&
    (comment.parentId === null || comment.parentId === undefined) && (body === undefined || comment.body === body);
}

function isHumanAction(labels) {
  const names = labels.map(({ name }) => name);
  return names.filter((name) => name === "Human Action").length === 1 &&
    names.filter((name) => HUMAN_ACTION_KIND_LABELS.has(name)).length === 1;
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
