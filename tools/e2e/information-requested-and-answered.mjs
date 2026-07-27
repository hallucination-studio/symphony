import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function runInformationRequestedAndAnsweredCase({ definition, human, rootCreation, signal } = {}) {
  assertDefinition(definition);
  assertInput({ human, rootCreation, signal });

  const rootKey = definition.rootTopology[0].rootKey;
  const answer = frozenAnswer(definition);
  const root = await human.createRootIssue({ caseId: definition.caseId, rootKey, ...rootCreation, ...(signal ? { signal } : {}) });
  if (!identifier(root?.rootIssueId) || !identifier(root?.identifier)) {
    throw stableError("foreground_e2e_information_root_create_invalid");
  }
  await human.assertRootUndelegatedAndInactive({ rootIssueId: root.rootIssueId, ...(signal ? { signal } : {}) });
  await human.delegateRootIssue({ rootIssueId: root.rootIssueId, ...(signal ? { signal } : {}) });

  const request = await waitForInformation({ human, rootIssueId: root.rootIssueId, signal });
  const comment = await human.replyToHumanAction({
    rootIssueId: root.rootIssueId,
    requestCommentId: request.requestCommentId,
    body: answer.body,
    ...(signal ? { signal } : {}),
  });
  if (!identifier(comment?.commentId) || comment.issueId !== root.rootIssueId || comment.requestCommentId !== request.requestCommentId) {
    throw stableError("foreground_e2e_information_answer_comment_invalid");
  }

  const replacementRequest = await waitForPlanReview({ human, rootIssueId: root.rootIssueId, signal });
  if (replacementRequest.requestCommentId === request.requestCommentId) {
    throw stableError("foreground_e2e_information_replacement_action_invalid");
  }

  return Object.freeze({
    context: Object.freeze({
      humanActorId: human.actorId,
      rootIssueIdsByKey: Object.freeze({ [rootKey]: root.rootIssueId }),
      inputReferences: Object.freeze([Object.freeze({
        sourceId: comment.commentId,
        kind: "comment_create",
        binding: answer.inputBinding,
        commentId: comment.commentId,
      })]),
      informationRequestCommentId: request.requestCommentId,
      replacementRequestCommentId: replacementRequest.requestCommentId,
    }),
  });
}

async function waitForInformation({ human, rootIssueId, signal }) {
  const request = await human.waitForInformationRequest({
    rootIssueId,
    ...(signal ? { signal } : {}),
  });
  if (!identifier(request?.requestCommentId) || request.rootIssueId !== rootIssueId) {
    throw stableError("foreground_e2e_information_clarification_invalid");
  }
  return request;
}

async function waitForPlanReview({ human, rootIssueId, signal }) {
  const request = await human.waitForPlanApprovalRequest({
    rootIssueId,
    ...(signal ? { signal } : {}),
  });
  if (!identifier(request?.requestCommentId) || !identifier(request?.planIssueId)) {
    throw stableError("foreground_e2e_information_plan_review_invalid");
  }
  return request;
}

function frozenAnswer(definition) {
  const answer = definition.declaredUserInteractions.find((interaction) =>
    interaction.kind === "reply_to_human_action" && interaction.inputBinding === "separator_answer");
  if (!answer || answer.actionBinding !== "separator_clarification" || answer.commentBinding !== "separator_answer" ||
      answer.inputBinding !== "separator_answer" || !text(answer.body)) {
    throw stableError("foreground_e2e_information_case_definition_invalid");
  }
  return answer;
}

function assertDefinition(definition) {
  const canonical = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "information_requested_and_answered");
  if (definition !== canonical) throw stableError("foreground_e2e_information_case_definition_invalid");
}

function assertInput({ human, rootCreation, signal }) {
  if (!human || !identifier(human.actorId) || typeof human.createRootIssue !== "function" ||
      typeof human.assertRootUndelegatedAndInactive !== "function" || typeof human.delegateRootIssue !== "function" ||
      typeof human.waitForInformationRequest !== "function" || typeof human.replyToHumanAction !== "function" ||
      typeof human.waitForPlanApprovalRequest !== "function" ||
      !rootCreation || !identifier(rootCreation.teamId) || !identifier(rootCreation.projectId) ||
      !identifier(rootCreation.routingLabelId) || !identifier(rootCreation.rootStatusId) ||
      (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function"))) {
    throw stableError("foreground_e2e_information_case_input_invalid");
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
