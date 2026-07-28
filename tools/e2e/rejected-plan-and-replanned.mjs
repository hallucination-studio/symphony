import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function runRejectedPlanAndReplannedCase({ definition, human, rootCreation, signal } = {}) {
  assertDefinition(definition);
  assertInput({ human, rootCreation, signal });

  const rootKey = definition.rootTopology[0].rootKey;
  const rejection = frozenRejection(definition);
  const root = { rootIssueId: rootCreation.rootIssueId, identifier: rootCreation.identifier };
  if (!identifier(root?.rootIssueId) || !identifier(root?.identifier)) {
    throw stableError("foreground_e2e_rejected_root_create_invalid");
  }
  const initialRequest = await waitForRequest({ human, rootIssueId: root.rootIssueId, signal });
  const comment = await human.replyToHumanAction({
    rootIssueId: root.rootIssueId,
    requestCommentId: initialRequest.requestCommentId,
    body: rejection.body,
    ...(signal ? { signal } : {}),
  });
  if (!identifier(comment?.commentId) || comment.issueId !== root.rootIssueId || comment.requestCommentId !== initialRequest.requestCommentId) {
    throw stableError("foreground_e2e_rejected_reason_comment_invalid");
  }

  const replacementRequest = await waitForRequest({ human, rootIssueId: root.rootIssueId, signal });
  if (replacementRequest.requestCommentId === initialRequest.requestCommentId || replacementRequest.planIssueId === initialRequest.planIssueId) {
    throw stableError("foreground_e2e_rejected_replacement_action_invalid");
  }

  return Object.freeze({
    context: Object.freeze({
      humanActorId: human.actorId,
      rootIssueIdsByKey: Object.freeze({ [rootKey]: root.rootIssueId }),
      inputReferences: Object.freeze([Object.freeze({
        sourceId: comment.commentId,
        kind: "comment_create",
        binding: rejection.inputBinding,
        commentId: comment.commentId,
      })]),
      rejectedPlanIssueId: initialRequest.planIssueId,
      rejectionRequestCommentId: initialRequest.requestCommentId,
      replacementPlanIssueId: replacementRequest.planIssueId,
      replacementRequestCommentId: replacementRequest.requestCommentId,
    }),
  });
}

async function waitForRequest({ human, rootIssueId, signal }) {
  const request = await human.waitForPlanApprovalRequest({
    rootIssueId,
    ...(signal ? { signal } : {}),
  });
  if (!identifier(request?.requestCommentId) || !identifier(request?.planIssueId)) {
    throw stableError("foreground_e2e_rejected_plan_review_invalid");
  }
  return request;
}

function frozenRejection(definition) {
  const reason = definition.declaredUserInteractions.find((interaction) =>
    interaction.kind === "reply_to_human_action" && interaction.inputBinding === "rejection_reason");
  if (!reason || reason.actionBinding !== "rejected_plan_review" || reason.commentBinding !== "rejection_reason" ||
      reason.inputBinding !== "rejection_reason" || !text(reason.body)) {
    throw stableError("foreground_e2e_rejected_case_definition_invalid");
  }
  return reason;
}

function assertDefinition(definition) {
  const canonical = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "plan_rejected_and_replanned");
  if (definition !== canonical) throw stableError("foreground_e2e_rejected_case_definition_invalid");
}

function assertInput({ human, rootCreation, signal }) {
  if (!human || !identifier(human.actorId) || typeof human.waitForPlanApprovalRequest !== "function" ||
      typeof human.replyToHumanAction !== "function" ||
      !rootCreation || !identifier(rootCreation.teamId) ||
      !identifier(rootCreation.projectId) || !identifier(rootCreation.routingLabelId) || !identifier(rootCreation.rootStatusId) ||
      !identifier(rootCreation.rootIssueId) || !identifier(rootCreation.identifier) ||
      (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function"))) {
    throw stableError("foreground_e2e_rejected_case_input_invalid");
  }
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768;
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
