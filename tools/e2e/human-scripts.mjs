const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export const ROOT_REVISION_DESCRIPTION = "Deliver the revised Root requirement and preserve its reviewable evidence.";
export const ROOT_REVISION_COMMENT = "Please use the revised Root requirement when deciding the next step.\n\n```text\nrevision: accepted input must be reconciled\n```";
const ROOT_REVISION_INITIAL_COMMENT = "Please use the revised Root requirement when deciding the next step.";

export async function executeHumanScript({ humanScript, caseRoots, human, waitForHumanAction, waitForInFlightStage, waitForRootReconcilerReply, restartConductor } = {}) {
  const rootIssueIds = rootIssueIdsFrom(caseRoots);
  if (!rootIssueIds || !human || typeof human !== "object") {
    throw stableError("parallel_black_box_human_script_input_invalid");
  }
  if (humanScript?.id === "approve_plan") {
    return approvePlan({ rootIssueIds, human, waitForHumanAction });
  }
  if (humanScript?.id === "reject_plan") {
    return rejectPlan({ rootIssueIds, human, waitForHumanAction });
  }
  if (humanScript?.id === "revise_root") {
    return reviseRoot({ rootIssueIds, human, waitForRootReconcilerReply });
  }
  if (humanScript?.id === "preempt_same_priority") {
    return preemptSamePriority({ rootIssueIds, human, waitForInFlightStage });
  }
  if (humanScript?.id === "restart_conductor") {
    return restartConductorDuringStage({ rootIssueIds, waitForInFlightStage, restartConductor });
  }
  throw stableError("parallel_black_box_human_script_unavailable");
}

async function approvePlan({ rootIssueIds, human, waitForHumanAction }) {
  if (rootIssueIds.length !== 1 || typeof human.resolveHumanAction !== "function" || typeof waitForHumanAction !== "function") {
    throw stableError("parallel_black_box_human_script_input_invalid");
  }
  const action = await waitForHumanAction({
    root_issue_id: rootIssueIds[0],
    action_kind: "plan_review",
  });
  if (!action || typeof action !== "object" || Array.isArray(action) ||
      Object.keys(action).length !== 1 || !identifier(action.human_action_issue_id)) {
    throw stableError("parallel_black_box_human_action_invalid");
  }
  await human.resolveHumanAction({
    human_action_issue_id: action.human_action_issue_id,
    terminal_status: "approved",
  });
}

async function rejectPlan({ rootIssueIds, human, waitForHumanAction }) {
  if (rootIssueIds.length !== 1 || typeof human.resolveHumanAction !== "function" || typeof waitForHumanAction !== "function") {
    throw stableError("parallel_black_box_human_script_input_invalid");
  }
  const action = await waitForHumanAction({
    root_issue_id: rootIssueIds[0],
    action_kind: "plan_review",
  });
  if (!action || typeof action !== "object" || Array.isArray(action) ||
      Object.keys(action).length !== 1 || !identifier(action.human_action_issue_id)) {
    throw stableError("parallel_black_box_human_action_invalid");
  }
  await human.resolveHumanAction({
    human_action_issue_id: action.human_action_issue_id,
    terminal_status: "rejected",
    reason_or_answer: "The Plan does not satisfy the requested outcome. Please replan it.",
  });
}

async function reviseRoot({ rootIssueIds, human, waitForRootReconcilerReply }) {
  if (
    rootIssueIds.length !== 1 ||
    typeof human.updateRoot !== "function" ||
    typeof human.createComment !== "function" ||
    typeof human.editComment !== "function" ||
    typeof human.resolveCommentThread !== "function" ||
    typeof human.reopenCommentThread !== "function" ||
    typeof waitForRootReconcilerReply !== "function"
  ) {
    throw stableError("parallel_black_box_human_script_input_invalid");
  }
  const rootIssueId = rootIssueIds[0];
  await human.updateRoot({ root_issue_id: rootIssueId, description: ROOT_REVISION_DESCRIPTION });
  const created = await human.createComment({ issue_id: rootIssueId, body: ROOT_REVISION_INITIAL_COMMENT });
  if (!created || typeof created !== "object" || Array.isArray(created) || Object.keys(created).length !== 1 || !identifier(created.comment_id)) {
    throw stableError("parallel_black_box_human_comment_invalid");
  }
  await human.editComment({ comment_id: created.comment_id, body: ROOT_REVISION_COMMENT });
  await human.resolveCommentThread({ thread_root_comment_id: created.comment_id });
  await waitForRootReconcilerReply({ root_issue_id: rootIssueId, comment_id: created.comment_id, thread_state: "resolved" });
  await human.reopenCommentThread({ thread_root_comment_id: created.comment_id });
  await waitForRootReconcilerReply({ root_issue_id: rootIssueId, comment_id: created.comment_id, thread_state: "unresolved" });
}

async function preemptSamePriority({ rootIssueIds, human, waitForInFlightStage }) {
  if (rootIssueIds.length !== 2 || typeof human.updateRoot !== "function" || typeof waitForInFlightStage !== "function") {
    throw stableError("parallel_black_box_human_script_input_invalid");
  }
  const stage = await waitForInFlightStage({ root_issue_id: rootIssueIds[0] });
  if (!stage || typeof stage !== "object" || Array.isArray(stage) || Object.keys(stage).length !== 1 ||
      !identifier(stage.stage_execution_id)) {
    throw stableError("parallel_black_box_human_inflight_stage_invalid");
  }
  await human.updateRoot({
    root_issue_id: rootIssueIds[1],
    description: "Please run this Root next.",
  });
}

async function restartConductorDuringStage({ rootIssueIds, waitForInFlightStage, restartConductor }) {
  if (rootIssueIds.length !== 3 || typeof waitForInFlightStage !== "function" || typeof restartConductor !== "function") {
    throw stableError("parallel_black_box_human_script_input_invalid");
  }
  const stage = await waitForInFlightStage({ root_issue_id: rootIssueIds[0] });
  if (!stage || typeof stage !== "object" || Array.isArray(stage) || Object.keys(stage).length !== 1 ||
      !identifier(stage.stage_execution_id)) {
    throw stableError("parallel_black_box_human_inflight_stage_invalid");
  }
  await restartConductor({ root_issue_id: rootIssueIds[0] });
}

function rootIssueIdsFrom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !Array.isArray(value.root_issue_ids) || value.root_issue_ids.length === 0 || value.root_issue_ids.length > 8 ||
      !value.root_issue_ids.every(identifier) || new Set(value.root_issue_ids).size !== value.root_issue_ids.length) {
    return null;
  }
  return value.root_issue_ids;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
