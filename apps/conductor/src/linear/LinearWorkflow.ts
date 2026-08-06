import { parseLinearWorkflow, type LinearWorkflow } from "../contracts/task-management.js";
import type { LinearGateway, LinearWorkflowState } from "./LinearGateway.js";

type WorkflowStateType = "backlog" | "unstarted" | "started" | "completed" | "canceled";

interface CanonicalWorkflowState {
  readonly name: string;
  readonly type: WorkflowStateType;
  readonly color: string;
  readonly field: "todo_status_id" | "in_progress_status_id" | "in_review_status_id" | "needs_human_status_id" | "done_status_id" | "canceled_status_id";
}

const CANONICAL_STATES: readonly CanonicalWorkflowState[] = Object.freeze([
  { name: "Todo", type: "unstarted", color: "#BEC2C8", field: "todo_status_id" },
  { name: "In Progress", type: "started", color: "#F2C94C", field: "in_progress_status_id" },
  { name: "In Review", type: "started", color: "#5E6AD2", field: "in_review_status_id" },
  { name: "Needs Human", type: "started", color: "#F2994A", field: "needs_human_status_id" },
  { name: "Done", type: "completed", color: "#26B758", field: "done_status_id" },
  { name: "Canceled", type: "canceled", color: "#95A2B3", field: "canceled_status_id" },
]);

function matchingState(
  teamId: string,
  states: readonly LinearWorkflowState[],
  canonical: CanonicalWorkflowState,
): LinearWorkflowState | undefined {
  const matches = states.filter((state) => state.name === canonical.name);
  if (matches.length > 1) throw new Error("linear_workflow_state_duplicated");
  const match = matches[0];
  if (match !== undefined && match.team_id !== teamId) throw new Error("linear_workflow_team_mismatch");
  if (match !== undefined && match.type !== canonical.type) {
    throw new Error("linear_workflow_state_type_mismatch");
  }
  return match;
}

function validateTeam(teamId: string, states: readonly LinearWorkflowState[]): void {
  if (states.some((state) => state.team_id !== teamId)) throw new Error("linear_workflow_team_mismatch");
}

/**
 * Resolve only the six exact Harness states. Provider-specific states and
 * duplicate semantic types with different names are deliberately ignored.
 */
export function resolveLinearWorkflow(
  teamId: string,
  states: readonly LinearWorkflowState[],
): LinearWorkflow {
  validateTeam(teamId, states);
  const resolved = Object.fromEntries(CANONICAL_STATES.map((canonical) => {
    const state = matchingState(teamId, states, canonical);
    if (state === undefined) throw new Error("linear_workflow_state_missing");
    return [canonical.field, state.id];
  }));
  return parseLinearWorkflow({ team_id: teamId, ...resolved });
}

/**
 * Ensure the exact Harness state set exists for one team, creating only
 * missing names. Existing states are validated by both exact name and type.
 */
export async function ensureLinearWorkflow(
  teamId: string,
  gateway: LinearGateway,
): Promise<LinearWorkflow> {
  const states = [...await gateway.list_team_states(teamId)];
  validateTeam(teamId, states);

  const missing = CANONICAL_STATES.filter((canonical) => matchingState(teamId, states, canonical) === undefined);
  for (const canonical of missing) {
    const created = await gateway.create_workflow_state({
      team_id: teamId,
      name: canonical.name,
      type: canonical.type,
      color: canonical.color,
    });
    states.push(created);
  }

  return resolveLinearWorkflow(teamId, states);
}

export { CANONICAL_STATES };
