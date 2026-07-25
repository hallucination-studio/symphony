const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function executeHumanScript({ humanScript, root, human, waitForHumanAction } = {}) {
  if (!root || typeof root !== "object" || !identifier(root.root_issue_id) ||
      !human || typeof human.resolveHumanAction !== "function" ||
      typeof waitForHumanAction !== "function") {
    throw stableError("parallel_black_box_human_script_input_invalid");
  }
  if (humanScript?.id !== "approve_plan") {
    throw stableError("parallel_black_box_human_script_unavailable");
  }

  const action = await waitForHumanAction({
    root_issue_id: root.root_issue_id,
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

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
