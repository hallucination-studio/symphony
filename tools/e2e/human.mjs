import { createHash } from "node:crypto";

import { LinearClient } from "@linear/sdk";
import { parseSymphonyRecordBlock } from "@symphony/contracts/managed-record";

import { FOREGROUND_E2E_CASES } from "./cases.mjs";

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
const PLAN_REVIEW_WAIT_MS = 250;

export async function createForegroundE2EHumanActor({
  apiKey,
  expectedActorId,
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

  const rootCatalog = rootCatalogByKey();
  const roots = new Map();
  const createdRootKeys = new Set();
  const comments = new Map();
  const receiptInputs = new Map();
  return Object.freeze({
    actorId,
    async createRootIssue(input) {
      const rootSpec = assertRootCreateInput(input, rootCatalog);
      if (createdRootKeys.has(input.rootKey)) {
        throw stableError("foreground_e2e_human_root_create_not_declared");
      }
      const payload = await write(
        () => client.createIssue({
          teamId: input.teamId,
          projectId: input.projectId,
          stateId: input.rootStatusId,
          labelIds: [input.routingLabelId],
          title: rootSpec.rootCreationInput.title,
          description: rootSpec.rootCreationInput.description,
          priority: linearPriorityValue(rootSpec.rootCreationInput.priority),
        }),
        "foreground_e2e_human_root_create_failed",
      );
      if (payload?.success !== true || !identifier(payload.issueId)) {
        throw stableError("foreground_e2e_human_root_create_failed");
      }
      const issue = await readIssue(client, payload.issueId, "foreground_e2e_human_root_read_back_failed");
      const labels = await readLabels(issue, "foreground_e2e_human_root_read_back_failed");
      if (!matchesCreatedRoot(issue, labels, input, rootSpec.rootCreationInput)) {
        throw stableError("foreground_e2e_human_root_read_back_failed");
      }
      roots.set(issue.id, Object.freeze({
        rootIssueId: issue.id,
        rootKey: input.rootKey,
        declaredDescriptionUpdates: rootSpec.declaredDescriptionUpdates,
        projectId: input.projectId,
        teamId: input.teamId,
        routingLabelId: input.routingLabelId,
      }));
      createdRootKeys.add(input.rootKey);
      return Object.freeze({ rootIssueId: issue.id, identifier: issue.identifier });
    },

    async waitForPlanReviewAction({ rootIssueId, terminalStatus, signal } = {}) {
      const known = assertKnownRoot(roots, rootIssueId);
      assertPlanReviewWaitInput({ terminalStatus, signal });
      while (true) {
        const action = await activePlanReviewAction({ client, rootIssueId, known, actorId, terminalStatus });
        if (action) return Object.freeze(action);
        await waitForPlanReviewChange(signal);
      }
    },

    async waitForClarificationAction({ rootIssueId, terminalStatus, signal } = {}) {
      const known = assertKnownClarificationRoot(roots, rootIssueId);
      assertClarificationWaitInput({ terminalStatus, signal });
      while (true) {
        const action = await activeClarificationAction({ client, rootIssueId, known, actorId, terminalStatus });
        if (action) return Object.freeze(action);
        await waitForClarificationChange(signal);
      }
    },

    async waitForPlanContractAndPlanReviewAction({ rootIssueId, signal } = {}) {
      const known = assertKnownRoot(roots, rootIssueId);
      assertRevisionWaitInput({ signal });
      while (true) {
        const gate = await activePlanGate({ client, rootIssueId, known, actorId });
        if (gate) return Object.freeze(gate);
        await waitForRevisionChange(signal);
      }
    },

    async waitForSuccessorPlanContractAndPlanReviewAction({ rootIssueId, priorCycleIssueId, priorPlanReviewActionIssueId, signal } = {}) {
      const known = assertKnownRoot(roots, rootIssueId);
      if (!identifier(priorCycleIssueId) || !identifier(priorPlanReviewActionIssueId)) {
        throw stableError("foreground_e2e_human_successor_plan_input_invalid");
      }
      assertRevisionWaitInput({ signal });
      while (true) {
        const gate = await activePlanGate({
          client,
          rootIssueId,
          known,
          actorId,
          excludedCycleIssueId: priorCycleIssueId,
          excludedPlanReviewActionIssueId: priorPlanReviewActionIssueId,
        });
        if (gate) return Object.freeze(gate);
        await waitForRevisionChange(signal);
      }
    },

    async updateRootDescription({ rootIssueId, description } = {}) {
      if (!identifier(rootIssueId) || !text(description)) {
        throw stableError("foreground_e2e_human_root_update_input_invalid");
      }
      const known = roots.get(rootIssueId);
      if (!known) throw stableError("foreground_e2e_human_root_target_invalid");
      if (!known.declaredDescriptionUpdates.has(description)) {
        throw stableError("foreground_e2e_human_root_update_not_declared");
      }
      const before = await readIssue(client, rootIssueId, "foreground_e2e_human_root_target_invalid");
      const beforeLabels = await readLabels(before, "foreground_e2e_human_root_target_invalid");
      if (!matchesKnownRoot(before, beforeLabels, known)) {
        throw stableError("foreground_e2e_human_root_target_invalid");
      }
      const payload = await write(
        () => client.updateIssue(rootIssueId, { description }),
        "foreground_e2e_human_root_update_failed",
      );
      if (payload?.success !== true || payload.issueId !== rootIssueId) {
        throw stableError("foreground_e2e_human_root_update_failed");
      }
      const after = await readIssue(client, rootIssueId, "foreground_e2e_human_root_read_back_failed");
      const afterLabels = await readLabels(after, "foreground_e2e_human_root_read_back_failed");
      if (!matchesKnownRoot(after, afterLabels, known) || after.description !== description) {
        throw stableError("foreground_e2e_human_root_read_back_failed");
      }
      return rememberReceipt(receiptInputs, descriptionInputReference({ rootIssueId, remoteVersion: remoteVersion(after) }));
    },

    async createComment({ issueId, body } = {}) {
      if (!identifier(issueId) || !text(body)) {
        throw stableError("foreground_e2e_human_comment_create_input_invalid");
      }
      const payload = await write(
        () => client.createComment({ issueId, body }),
        "foreground_e2e_human_comment_create_failed",
      );
      if (payload?.success !== true || !identifier(payload.commentId)) {
        throw stableError("foreground_e2e_human_comment_create_failed");
      }
      const created = await readComment(client, payload.commentId, "foreground_e2e_human_comment_read_back_failed");
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

    async editComment({ issueId, commentId, body } = {}) {
      const known = assertKnownComment(comments, { issueId, commentId });
      if (!text(body)) throw stableError("foreground_e2e_human_comment_update_input_invalid");
      const before = await readComment(client, commentId, "foreground_e2e_human_comment_target_invalid");
      if (!matchesOwnedRootComment(before, { issueId: known.issueId, actorId })) {
        throw stableError("foreground_e2e_human_comment_target_invalid");
      }
      const payload = await write(
        () => client.updateComment(commentId, { body }),
        "foreground_e2e_human_comment_update_failed",
      );
      if (payload?.success !== true || payload.commentId !== commentId) {
        throw stableError("foreground_e2e_human_comment_update_failed");
      }
      const after = await readComment(client, commentId, "foreground_e2e_human_comment_read_back_failed");
      if (!matchesOwnedRootComment(after, { issueId: known.issueId, body, actorId })) {
        throw stableError("foreground_e2e_human_comment_read_back_failed");
      }
      return Object.freeze({
        commentId: after.id,
        issueId: after.issueId,
        inputReference: rememberReceipt(receiptInputs, commentBodyInputReference(after)),
      });
    },

    async resolveCommentThread({ issueId, threadRootCommentId } = {}) {
      return setCommentThreadState({
        client,
        comments,
        actorId,
        issueId,
        commentId: threadRootCommentId,
        resolved: true,
        receiptInputs,
      });
    },

    async reopenCommentThread({ issueId, threadRootCommentId } = {}) {
      return setCommentThreadState({
        client,
        comments,
        actorId,
        issueId,
        commentId: threadRootCommentId,
        resolved: false,
        receiptInputs,
      });
    },

    async waitForRootDescriptionReceipt({ rootIssueId, inputReference, signal } = {}) {
      const known = assertKnownRoot(roots, rootIssueId);
      const expected = assertRegisteredReceipt(receiptInputs, inputReference, "description", "foreground_e2e_human_description_receipt_input_invalid");
      assertRevisionWaitInput({ signal });
      while (true) {
        const root = await readIssue(client, rootIssueId, "foreground_e2e_human_description_receipt_read_failed");
        const labels = await readLabels(root, "foreground_e2e_human_description_receipt_read_failed");
        if (!matchesKnownRoot(root, labels, known)) throw stableError("foreground_e2e_human_description_receipt_target_invalid");
        const directives = await readIssueComments(root, "foreground_e2e_human_description_receipt_read_failed");
        if (hasDescriptionDirectiveReceipt(directives, rootIssueId, expected.sourceId, actorId)) return;
        await waitForRevisionChange(signal);
      }
    },

    async waitForCommentReceipt({ issueId, inputReference, signal } = {}) {
      const expected = assertRegisteredReceipt(receiptInputs, inputReference, "comment_body", "foreground_e2e_human_comment_receipt_input_invalid");
      if (!identifier(issueId) || expected.issueId !== issueId) throw stableError("foreground_e2e_human_comment_receipt_input_invalid");
      assertRevisionWaitInput({ signal });
      while (true) {
        const source = await readComment(client, expected.commentId, "foreground_e2e_human_comment_receipt_read_failed");
        if (!matchesOwnedRootComment(source, { issueId, actorId })) throw stableError("foreground_e2e_human_comment_receipt_target_invalid");
        if (await hasCommentReceipt({ source, expected, actorId, threadAction: undefined })) return;
        await waitForRevisionChange(signal);
      }
    },

    async waitForCommentThreadReceipt({ issueId, inputReference, signal } = {}) {
      const expected = assertRegisteredReceipt(receiptInputs, inputReference, "comment_thread_state", "foreground_e2e_human_thread_receipt_input_invalid");
      if (!identifier(issueId) || expected.issueId !== issueId) throw stableError("foreground_e2e_human_thread_receipt_input_invalid");
      assertRevisionWaitInput({ signal });
      while (true) {
        const source = await readComment(client, expected.commentId, "foreground_e2e_human_thread_receipt_read_failed");
        if (!matchesOwnedRootComment(source, { issueId, actorId }) || threadState(source) !== expected.expectedThreadState ||
            remoteVersion(source) !== expected.remoteVersion) {
          throw stableError("foreground_e2e_human_thread_receipt_target_invalid");
        }
        const action = expected.expectedThreadState === "resolved" ? "resolve" : "reopen";
        if (await hasCommentReceipt({ source, expected, actorId, threadAction: action })) return;
        await waitForRevisionChange(signal);
      }
    },

    async addReaction({ issueId, commentId, emoji } = {}) {
      const known = assertKnownComment(comments, { issueId, commentId });
      if (!emojiValue(emoji)) throw stableError("foreground_e2e_human_reaction_input_invalid");
      const before = await readComment(client, commentId, "foreground_e2e_human_comment_target_invalid");
      if (!matchesOwnedRootComment(before, { issueId: known.issueId, actorId })) {
        throw stableError("foreground_e2e_human_comment_target_invalid");
      }
      const payload = await write(
        () => client.createReaction({ commentId, emoji }),
        "foreground_e2e_human_reaction_create_failed",
      );
      if (payload?.success !== true || !identifier(payload.reactionId)) {
        throw stableError("foreground_e2e_human_reaction_create_failed");
      }
      const after = await readComment(client, commentId, "foreground_e2e_human_comment_read_back_failed");
      if (!matchesOwnedRootComment(after, { issueId: known.issueId, actorId }) ||
          !Array.isArray(after.reactions) || !after.reactions.some((reaction) =>
            reaction?.id === payload.reactionId && reaction.emoji === emoji && reaction.userId === actorId)) {
        throw stableError("foreground_e2e_human_comment_read_back_failed");
      }
      return Object.freeze({ reactionId: payload.reactionId, commentId, emoji });
    },

    async setHumanActionTerminalStatus({ issueId, terminalStatus, stateId } = {}) {
      if (!identifier(issueId) || !identifier(stateId) || !TERMINAL_HUMAN_ACTION_STATUSES.has(terminalStatus)) {
        throw stableError("foreground_e2e_human_action_status_input_invalid");
      }
      const before = await readIssue(client, issueId, "foreground_e2e_human_action_target_invalid");
      const beforeLabels = await readLabels(before, "foreground_e2e_human_action_target_invalid");
      if (!isHumanAction(beforeLabels)) throw stableError("foreground_e2e_human_action_target_invalid");
      const payload = await write(
        () => client.updateIssue(issueId, { stateId }),
        "foreground_e2e_human_action_status_failed",
      );
      if (payload?.success !== true || payload.issueId !== issueId) {
        throw stableError("foreground_e2e_human_action_status_failed");
      }
      const after = await readIssue(client, issueId, "foreground_e2e_human_action_read_back_failed");
      const afterLabels = await readLabels(after, "foreground_e2e_human_action_read_back_failed");
      if (!isHumanAction(afterLabels) || after.stateId !== stateId) {
        throw stableError("foreground_e2e_human_action_read_back_failed");
      }
    },
  });
}

async function setCommentThreadState({ client, comments, actorId, issueId, commentId, resolved, receiptInputs }) {
  const known = assertKnownComment(comments, { issueId, commentId });
  const before = await readComment(client, commentId, "foreground_e2e_human_comment_target_invalid");
  if (!matchesOwnedRootComment(before, { issueId: known.issueId, actorId })) {
    throw stableError("foreground_e2e_human_comment_target_invalid");
  }
  const payload = await write(
    () => resolved ? client.commentResolve(commentId) : client.commentUnresolve(commentId),
    "foreground_e2e_human_comment_thread_update_failed",
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
  let issue;
  try {
    issue = await client.issue(issueId);
  } catch {
    throw stableError(code);
  }
  if (!issue || issue.id !== issueId) throw stableError(code);
  return issue;
}

async function readComment(client, commentId, code) {
  if (!client || typeof client.comment !== "function") throw stableError(code);
  let comment;
  try {
    comment = await client.comment({ id: commentId });
  } catch {
    throw stableError(code);
  }
  if (!comment || comment.id !== commentId) throw stableError(code);
  return comment;
}

async function readIssueComments(issue, code) {
  if (!issue || typeof issue.comments !== "function") throw stableError(code);
  return readAllNodes((after) => issue.comments({ first: 64, includeArchived: true, ...(after ? { after } : {}) }), code);
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
  const comments = await readAllNodes(
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
  const parsed = parseSymphonyRecordBlock(body);
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
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

async function readLabels(issue, code) {
  if (!issue || typeof issue.labels !== "function") throw stableError(code);
  let page;
  try {
    page = await issue.labels({ first: 64 });
  } catch {
    throw stableError(code);
  }
  if (!page || !Array.isArray(page.nodes) || page.pageInfo?.hasNextPage !== false) throw stableError(code);
  return page.nodes;
}

async function readChildren(issue, code) {
  if (!issue || typeof issue.children !== "function") throw stableError(code);
  return readAllNodes((after) => issue.children({ first: 64, ...(after ? { after } : {}) }), code);
}

async function readTeamStatuses(client, teamId, code) {
  if (!client || typeof client.team !== "function" || !identifier(teamId)) throw stableError(code);
  let team;
  try {
    team = await client.team(teamId);
  } catch {
    throw stableError(code);
  }
  if (!team || team.id !== teamId || typeof team.states !== "function") throw stableError(code);
  const states = await readAllNodes((after) => team.states({ first: 64, includeArchived: true, ...(after ? { after } : {}) }), code);
  if (states.some((state) => !state || !identifier(state.id) || typeof state.name !== "string")) throw stableError(code);
  return states;
}

async function readAllNodes(readPage, code) {
  const nodes = [];
  const cursors = new Set();
  let cursor;
  do {
    let page;
    try {
      page = await readPage(cursor);
    } catch {
      throw stableError(code);
    }
    if (!page || !Array.isArray(page.nodes) || page.pageInfo?.hasNextPage !== false && page.pageInfo?.hasNextPage !== true) {
      throw stableError(code);
    }
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    cursor = page.pageInfo.endCursor;
    if (typeof cursor !== "string" || cursor.length === 0 || cursors.has(cursor)) throw stableError(code);
    cursors.add(cursor);
  } while (cursor);
  throw stableError(code);
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

function waitForPlanReviewChange(signal) {
  if (signal?.aborted) throw stableError("foreground_e2e_human_plan_review_aborted");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, PLAN_REVIEW_WAIT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(stableError("foreground_e2e_human_plan_review_aborted"));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForClarificationChange(signal) {
  if (signal?.aborted) throw stableError("foreground_e2e_human_clarification_aborted");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, PLAN_REVIEW_WAIT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(stableError("foreground_e2e_human_clarification_aborted"));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForRevisionChange(signal) {
  if (signal?.aborted) throw stableError("foreground_e2e_human_revision_wait_aborted");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, PLAN_REVIEW_WAIT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(stableError("foreground_e2e_human_revision_wait_aborted"));
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
    labels.length === 1 && labels[0]?.id === input.routingLabelId;
}

function matchesKnownRoot(issue, labels, known) {
  return issue.id === known.rootIssueId && issue.teamId === known.teamId && issue.projectId === known.projectId &&
    (issue.parentId === null || issue.parentId === undefined) && labels.length === 1 &&
    labels[0]?.id === known.routingLabelId;
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

async function write(operation, code) {
  try {
    return await operation();
  } catch {
    throw stableError(code);
  }
}

function token(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
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
