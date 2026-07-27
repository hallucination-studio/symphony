import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function runApprovedHappyPathCase({ definition, human, rootCreation, signal } = {}) {
  assertDefinition(definition);
  assertInput({ human, rootCreation, signal });

  const root = await human.createRootIssue({
    caseId: definition.caseId,
    rootKey: definition.rootTopology[0].rootKey,
    ...rootCreation,
    ...(signal ? { signal } : {}),
  });
  if (!identifier(root?.rootIssueId) || !identifier(root?.identifier)) {
    throw stableError("foreground_e2e_approved_root_create_invalid");
  }
  await human.assertRootUndelegatedAndInactive({ rootIssueId: root.rootIssueId, ...(signal ? { signal } : {}) });
  await human.delegateRootIssue({ rootIssueId: root.rootIssueId, ...(signal ? { signal } : {}) });
  const request = await human.waitForPlanApprovalRequest({
    rootIssueId: root.rootIssueId,
    ...(signal ? { signal } : {}),
  });
  if (!identifier(request?.requestCommentId) || !identifier(request?.planIssueId) || !identifier(request?.cycleIssueId)) {
    throw stableError("foreground_e2e_approved_plan_review_invalid");
  }
  const reply = await human.replyToHumanAction({
    rootIssueId: root.rootIssueId,
    requestCommentId: request.requestCommentId,
    body: approvalReply(definition).body,
    ...(signal ? { signal } : {}),
  });
  if (!identifier(reply?.commentId) || reply.requestCommentId !== request.requestCommentId) {
    throw stableError("foreground_e2e_approved_reply_invalid");
  }

  return Object.freeze({
    context: Object.freeze({
      humanActorId: human.actorId,
      rootIssueIdsByKey: Object.freeze({ [definition.rootTopology[0].rootKey]: root.rootIssueId }),
      approvalRequestCommentId: request.requestCommentId,
      approvalReplyCommentId: reply.commentId,
    }),
  });
}

function assertDefinition(definition) {
  const canonical = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  if (definition !== canonical) throw stableError("foreground_e2e_approved_case_definition_invalid");
}

function assertInput({ human, rootCreation, signal }) {
  if (!human || !identifier(human.actorId) || typeof human.createRootIssue !== "function" ||
      typeof human.assertRootUndelegatedAndInactive !== "function" || typeof human.delegateRootIssue !== "function" ||
      typeof human.waitForPlanApprovalRequest !== "function" || typeof human.replyToHumanAction !== "function" ||
      !rootCreation || !identifier(rootCreation.teamId) || !identifier(rootCreation.projectId) ||
      !identifier(rootCreation.routingLabelId) || !identifier(rootCreation.rootStatusId)) {
    throw stableError("foreground_e2e_approved_case_input_invalid");
  }
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) {
    throw stableError("foreground_e2e_approved_case_input_invalid");
  }
}

function approvalReply(definition) {
  const interaction = definition.declaredUserInteractions.find(({ kind }) => kind === "reply_to_human_action");
  if (!interaction || interaction.actionBinding !== "approved_plan_review" || interaction.body !== "Approved.") {
    throw stableError("foreground_e2e_approved_case_definition_invalid");
  }
  return interaction;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
