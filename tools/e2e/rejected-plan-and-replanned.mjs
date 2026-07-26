import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function runRejectedPlanAndReplannedCase({ definition, human, rootCreation, signal } = {}) {
  assertDefinition(definition);
  assertInput({ human, rootCreation, signal });

  const rootKey = definition.rootTopology[0].rootKey;
  const rejection = frozenRejection(definition);
  const root = await human.createRootIssue({ caseId: definition.caseId, rootKey, ...rootCreation });
  if (!identifier(root?.rootIssueId) || !identifier(root?.identifier)) {
    throw stableError("foreground_e2e_rejected_root_create_invalid");
  }

  const initialAction = await waitForAction({ human, rootIssueId: root.rootIssueId, signal });
  const comment = await human.createComment({ issueId: initialAction.actionIssueId, body: rejection.body });
  if (!identifier(comment?.commentId) || comment.issueId !== initialAction.actionIssueId) {
    throw stableError("foreground_e2e_rejected_reason_comment_invalid");
  }
  await human.setHumanActionTerminalStatus({
    issueId: initialAction.actionIssueId,
    terminalStatus: "Rejected",
    stateId: initialAction.terminalStatusId,
  });

  const replacementAction = await waitForAction({ human, rootIssueId: root.rootIssueId, signal });
  if (replacementAction.actionIssueId === initialAction.actionIssueId) {
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
      rejectedActionIssueId: initialAction.actionIssueId,
      replacementActionIssueId: replacementAction.actionIssueId,
    }),
  });
}

async function waitForAction({ human, rootIssueId, signal }) {
  const action = await human.waitForPlanReviewAction({
    rootIssueId,
    terminalStatus: "Rejected",
    ...(signal ? { signal } : {}),
  });
  if (!identifier(action?.actionIssueId) || !identifier(action?.terminalStatusId)) {
    throw stableError("foreground_e2e_rejected_plan_review_invalid");
  }
  return action;
}

function frozenRejection(definition) {
  const reason = definition.declaredUserInteractions.find(({ kind }) => kind === "create_action_comment");
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
  if (!human || !identifier(human.actorId) || typeof human.createRootIssue !== "function" ||
      typeof human.waitForPlanReviewAction !== "function" || typeof human.createComment !== "function" ||
      typeof human.setHumanActionTerminalStatus !== "function" || !rootCreation || !identifier(rootCreation.teamId) ||
      !identifier(rootCreation.projectId) || !identifier(rootCreation.routingLabelId) || !identifier(rootCreation.rootStatusId) ||
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
