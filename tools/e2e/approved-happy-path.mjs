import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function runApprovedHappyPathCase({ definition, human, rootCreation, signal } = {}) {
  assertDefinition(definition);
  assertInput({ human, rootCreation, signal });

  const root = await human.createRootIssue({
    caseId: definition.caseId,
    rootKey: definition.rootTopology[0].rootKey,
    ...rootCreation,
  });
  if (!identifier(root?.rootIssueId) || !identifier(root?.identifier)) {
    throw stableError("foreground_e2e_approved_root_create_invalid");
  }
  const action = await human.waitForPlanReviewAction({
    rootIssueId: root.rootIssueId,
    ...(signal ? { signal } : {}),
  });
  if (!identifier(action?.actionIssueId) || !identifier(action?.approvedStatusId)) {
    throw stableError("foreground_e2e_approved_plan_review_invalid");
  }
  await human.setHumanActionTerminalStatus({
    issueId: action.actionIssueId,
    terminalStatus: "Approved",
    stateId: action.approvedStatusId,
  });

  return Object.freeze({
    context: Object.freeze({
      humanActorId: human.actorId,
      rootIssueIdsByKey: Object.freeze({ [definition.rootTopology[0].rootKey]: root.rootIssueId }),
    }),
  });
}

function assertDefinition(definition) {
  const canonical = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  if (definition !== canonical) throw stableError("foreground_e2e_approved_case_definition_invalid");
}

function assertInput({ human, rootCreation, signal }) {
  if (!human || !identifier(human.actorId) || typeof human.createRootIssue !== "function" ||
      typeof human.waitForPlanReviewAction !== "function" || typeof human.setHumanActionTerminalStatus !== "function" ||
      !rootCreation || !identifier(rootCreation.teamId) || !identifier(rootCreation.projectId) ||
      !identifier(rootCreation.routingLabelId) || !identifier(rootCreation.rootStatusId)) {
    throw stableError("foreground_e2e_approved_case_input_invalid");
  }
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) {
    throw stableError("foreground_e2e_approved_case_input_invalid");
  }
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
