import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function runRootRevisionAndCommentCase({ definition, human, rootCreation, signal } = {}) {
  assertDefinition(definition);
  assertInput({ human, rootCreation, signal });

  const rootKey = definition.rootTopology[0].rootKey;
  const interactions = frozenInteractions(definition);
  const root = await human.createRootIssue({ caseId: definition.caseId, rootKey, ...rootCreation, ...(signal ? { signal } : {}) });
  if (!identifier(root?.rootIssueId) || !identifier(root?.identifier)) {
    throw stableError("foreground_e2e_revision_root_create_invalid");
  }
  await human.assertRootUndelegatedAndInactive({ rootIssueId: root.rootIssueId, ...(signal ? { signal } : {}) });
  await human.delegateRootIssue({ rootIssueId: root.rootIssueId, ...(signal ? { signal } : {}) });

  const initialPlan = await waitForInitialPlan({ human, rootIssueId: root.rootIssueId, signal });
  const description = await human.updateRootDescription({
    rootIssueId: root.rootIssueId,
    description: interactions.description.description,
    ...(signal ? { signal } : {}),
  });
  const descriptionInput = assertInputReference(description, "description", "foreground_e2e_revision_description_invalid");
  await human.waitForRootDescriptionReceipt(waitInput({ rootIssueId: root.rootIssueId, inputReference: descriptionInput, signal }));

  const created = await human.createComment({ issueId: root.rootIssueId, body: interactions.comment.body, ...(signal ? { signal } : {}) });
  const createdInput = assertCommentInput(created, root.rootIssueId, "foreground_e2e_revision_comment_create_invalid");
  await human.waitForCommentReceipt(waitInput({ issueId: root.rootIssueId, inputReference: createdInput, signal }));

  const edited = await human.editComment({
    issueId: root.rootIssueId,
    commentId: created.commentId,
    body: interactions.edit.body,
    ...(signal ? { signal } : {}),
  });
  const editedInput = assertCommentInput(edited, root.rootIssueId, "foreground_e2e_revision_comment_edit_invalid");
  if (edited.commentId !== created.commentId) throw stableError("foreground_e2e_revision_comment_edit_invalid");
  await human.waitForCommentReceipt(waitInput({ issueId: root.rootIssueId, inputReference: editedInput, signal }));

  const resolved = await human.resolveCommentThread({ issueId: root.rootIssueId, threadRootCommentId: created.commentId, ...(signal ? { signal } : {}) });
  const resolvedInput = assertThreadInput(resolved, created.commentId, "resolved", "foreground_e2e_revision_thread_resolve_invalid");
  await human.waitForCommentThreadReceipt(waitInput({ issueId: root.rootIssueId, inputReference: resolvedInput, signal }));

  const reopened = await human.reopenCommentThread({ issueId: root.rootIssueId, threadRootCommentId: created.commentId, ...(signal ? { signal } : {}) });
  const reopenedInput = assertThreadInput(reopened, created.commentId, "unresolved", "foreground_e2e_revision_thread_reopen_invalid");
  await human.waitForCommentThreadReceipt(waitInput({ issueId: root.rootIssueId, inputReference: reopenedInput, signal }));

  const successorPlan = await waitForSuccessorPlan({
    human,
    rootIssueId: root.rootIssueId,
    initialPlan,
    signal,
  });

  return deepFreeze({
    context: {
      humanActorId: human.actorId,
      rootIssueIdsByKey: { [rootKey]: root.rootIssueId },
      initialPlan,
      successorPlan,
      inputReferences: [
        descriptionInput,
        { ...createdInput, binding: interactions.comment.commentBinding },
        editedInput,
        resolvedInput,
        reopenedInput,
      ],
    },
  });
}

async function waitForInitialPlan({ human, rootIssueId, signal }) {
  const plan = await human.waitForPlanContractAndPlanReviewAction({ rootIssueId, ...(signal ? { signal } : {}) });
  return assertPlanGate(plan, "foreground_e2e_revision_initial_plan_invalid");
}

async function waitForSuccessorPlan({ human, rootIssueId, initialPlan, signal }) {
  const plan = await human.waitForSuccessorPlanContractAndPlanReviewAction({
    rootIssueId,
    priorCycleIssueId: initialPlan.cycleIssueId,
    priorPlanReviewActionIssueId: initialPlan.planReviewActionIssueId,
    ...(signal ? { signal } : {}),
  });
  const successor = assertPlanGate(plan, "foreground_e2e_revision_successor_plan_invalid");
  if (successor.cycleIssueId === initialPlan.cycleIssueId ||
      successor.planIssueId === initialPlan.planIssueId ||
      successor.planContractDigest === initialPlan.planContractDigest ||
      successor.planReviewActionIssueId === initialPlan.planReviewActionIssueId) {
    throw stableError("foreground_e2e_revision_successor_plan_invalid");
  }
  return successor;
}

function waitInput({ signal, ...input }) {
  return { ...input, ...(signal ? { signal } : {}) };
}

function assertPlanGate(value, code) {
  if (!value || !identifier(value.cycleIssueId) || !identifier(value.planIssueId) ||
      !identifier(value.planContractDigest) || !identifier(value.planContractSourceCommentId) ||
      !identifier(value.planReviewActionIssueId)) {
    throw stableError(code);
  }
  return {
    cycleIssueId: value.cycleIssueId,
    planIssueId: value.planIssueId,
    planContractDigest: value.planContractDigest,
    planContractSourceCommentId: value.planContractSourceCommentId,
    planReviewActionIssueId: value.planReviewActionIssueId,
  };
}

function assertCommentInput(value, issueId, code) {
  if (!value || !identifier(value.commentId) || value.issueId !== issueId) throw stableError(code);
  const input = assertInputReference(value.inputReference, "comment_body", code);
  if (input.commentId !== value.commentId) throw stableError(code);
  return input;
}

function assertThreadInput(value, commentId, state, code) {
  const input = assertInputReference(value, "comment_thread_state", code);
  if (input.commentId !== commentId || input.threadRootCommentId !== commentId ||
      input.expectedThreadState !== state || !timestamp(input.remoteVersion)) {
    throw stableError(code);
  }
  return input;
}

function assertInputReference(value, kind, code) {
  if (!value || value.kind !== kind || !identifier(value.sourceId)) throw stableError(code);
  if (kind === "comment_body" && !identifier(value.commentId)) throw stableError(code);
  return value;
}

function frozenInteractions(definition) {
  const [initial, description, descriptionReceipt, comment, commentReceipt, edit, editReceipt, resolve, resolveReceipt, reopen, reopenReceipt] = definition.declaredUserInteractions;
  if (initial?.kind !== "wait_for_plan_contract_and_human_action" || initial.rootKey !== "revision-root" ||
      initial.actionKind !== "plan_review" || initial.actionBinding !== "initial_plan_review" ||
      description?.kind !== "update_root_description" || !text(description.description) || description.inputBinding !== "revision_description" ||
      !receiptMatches(descriptionReceipt, "revision_description", ["root_directive"]) ||
      comment?.kind !== "create_comment" || !text(comment.body) || comment.commentBinding !== "revision_comment" || comment.inputBinding !== "revision_comment_create" ||
      !receiptMatches(commentReceipt, "revision_comment_create", ["reply", "reaction"]) ||
      edit?.kind !== "edit_comment" || !text(edit.body) || edit.commentBinding !== "revision_comment" || edit.inputBinding !== "revision_comment_edit" ||
      !receiptMatches(editReceipt, "revision_comment_edit", ["reply", "reaction"]) ||
      resolve?.kind !== "resolve_comment_thread" || resolve.commentBinding !== "revision_comment" || resolve.inputBinding !== "revision_thread_resolve" ||
      !receiptMatches(resolveReceipt, "revision_thread_resolve", ["reply", "reaction", "thread_state"]) ||
      reopen?.kind !== "reopen_comment_thread" || reopen.commentBinding !== "revision_comment" || reopen.inputBinding !== "revision_thread_reopen" ||
      !receiptMatches(reopenReceipt, "revision_thread_reopen", ["reply", "reaction", "thread_state"])) {
    throw stableError("foreground_e2e_revision_case_definition_invalid");
  }
  return { description, comment, edit };
}

function receiptMatches(value, binding, facts) {
  return value?.kind === "wait_for_input_receipt" && value.rootKey === "revision-root" &&
    value.sourceBinding === binding && Array.isArray(value.requiredFacts) &&
    value.requiredFacts.length === facts.length && value.requiredFacts.every((fact, index) => fact === facts[index]);
}

function assertDefinition(definition) {
  const canonical = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "root_revision_and_comment");
  if (definition !== canonical) throw stableError("foreground_e2e_revision_case_definition_invalid");
}

function assertInput({ human, rootCreation, signal }) {
  if (!human || !identifier(human.actorId) || typeof human.createRootIssue !== "function" ||
      typeof human.assertRootUndelegatedAndInactive !== "function" || typeof human.delegateRootIssue !== "function" ||
      typeof human.waitForPlanContractAndPlanReviewAction !== "function" || typeof human.updateRootDescription !== "function" ||
      typeof human.waitForRootDescriptionReceipt !== "function" || typeof human.createComment !== "function" ||
      typeof human.waitForCommentReceipt !== "function" || typeof human.editComment !== "function" ||
      typeof human.resolveCommentThread !== "function" || typeof human.reopenCommentThread !== "function" ||
      typeof human.waitForCommentThreadReceipt !== "function" ||
      typeof human.waitForSuccessorPlanContractAndPlanReviewAction !== "function" || !rootCreation ||
      !identifier(rootCreation.teamId) || !identifier(rootCreation.projectId) ||
      !identifier(rootCreation.routingLabelId) || !identifier(rootCreation.rootStatusId) ||
      (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function"))) {
    throw stableError("foreground_e2e_revision_case_input_invalid");
  }
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768;
}

function timestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
