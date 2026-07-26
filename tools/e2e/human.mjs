import { LinearClient } from "@linear/sdk";

import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const TERMINAL_HUMAN_ACTION_STATUSES = new Set(["Approved", "Rejected", "Answered", "Canceled"]);
const HUMAN_ACTION_KIND_LABELS = new Set([
  "Plan Review",
  "Clarification",
  "Permission",
  "Finding Waiver",
  "Convergence Override",
]);

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
  return Object.freeze({
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
      return Object.freeze({ commentId: created.id, issueId: created.issueId });
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
    },

    async resolveCommentThread({ issueId, threadRootCommentId } = {}) {
      await setCommentThreadState({
        client,
        comments,
        actorId,
        issueId,
        commentId: threadRootCommentId,
        resolved: true,
      });
    },

    async reopenCommentThread({ issueId, threadRootCommentId } = {}) {
      await setCommentThreadState({
        client,
        comments,
        actorId,
        issueId,
        commentId: threadRootCommentId,
        resolved: false,
      });
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

async function setCommentThreadState({ client, comments, actorId, issueId, commentId, resolved }) {
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
