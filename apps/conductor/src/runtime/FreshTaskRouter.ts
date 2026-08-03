import {
  parseCycleIssueId,
  parseTaskIssueId,
  type CycleIssueId,
  type TaskIssueId,
  type TaskStateId,
} from "../contracts/identity.js";
import type {
  ConcreteTaskChange,
  TaskChangeOriginEvidence,
} from "../contracts/observation.js";
import type { TaskIssueSnapshot, TaskSnapshot } from "../contracts/task-management.js";
import type { TaskWorkflowIdentities } from "../task-management/api/TaskManageCapability.js";

export type FreshRouteId =
  | "WF-ROUTE-001"
  | "WF-ROUTE-002"
  | "WF-ROUTE-004"
  | "WF-ROUTE-005"
  | "WF-ROUTE-006"
  | "WF-ROUTE-007"
  | "WF-ROUTE-008"
  | "WF-ROUTE-009"
  | "WF-ROUTE-011"
  | "WF-ROUTE-013"
  | "WF-ROUTE-014"
  | "WF-ROUTE-015"
  | "WF-ROUTE-016"
  | "WF-ROUTE-017"
  | "WF-ROUTE-018";

export type FreshRouteConsumer =
  | "root_boundary"
  | "cycle_machine"
  | "family_guard"
  | "cleanup"
  | "park";

export interface FreshRouteMatch {
  readonly route_id: FreshRouteId;
  readonly priority: number;
  readonly consumer: FreshRouteConsumer;
  readonly cycle_id: CycleIssueId | null;
}

export interface FreshTaskRouting {
  readonly selected: FreshRouteMatch;
  readonly matches: readonly FreshRouteMatch[];
}

export interface FreshTaskRouterInput {
  readonly task: TaskSnapshot;
  readonly task_changes: readonly ConcreteTaskChange[];
  readonly task_change_origins: readonly TaskChangeOriginEvidence[];
  readonly agent_actor_id: string;
  readonly root_states: Readonly<{
    todo: TaskStateId | string;
    in_progress: TaskStateId | string;
    in_review: TaskStateId | string;
    done: TaskStateId | string;
  }>;
  readonly workflow: TaskWorkflowIdentities;
  readonly permanent_quarantine?: boolean;
}

const ROUTES = Object.freeze({
  "WF-ROUTE-001": [110, "root_boundary"],
  "WF-ROUTE-002": [100, "root_boundary"],
  "WF-ROUTE-004": [80, "cycle_machine"],
  "WF-ROUTE-005": [130, "root_boundary"],
  "WF-ROUTE-006": [45, "cycle_machine"],
  "WF-ROUTE-007": [90, "root_boundary"],
  "WF-ROUTE-008": [120, "root_boundary"],
  "WF-ROUTE-009": [10, "family_guard"],
  "WF-ROUTE-011": [20, "cycle_machine"],
  "WF-ROUTE-013": [40, "cleanup"],
  "WF-ROUTE-014": [140, "park"],
  "WF-ROUTE-015": [55, "cycle_machine"],
  "WF-ROUTE-016": [1, "park"],
  "WF-ROUTE-017": [50, "cycle_machine"],
  "WF-ROUTE-018": [15, "cycle_machine"],
} as const satisfies Readonly<Record<FreshRouteId, readonly [number, FreshRouteConsumer]>>);

function match(routeId: FreshRouteId, cycleId: CycleIssueId | null): FreshRouteMatch {
  const [priority, consumer] = ROUTES[routeId];
  return Object.freeze({ route_id: routeId, priority, consumer, cycle_id: cycleId });
}

function rootIssue(task: TaskSnapshot): TaskIssueSnapshot {
  const rootId = parseTaskIssueId(task.root_id);
  const root = task.issues.find(({ issue_id }) => issue_id === rootId);
  if (root === undefined) throw new Error("missing_root_identity");
  return root;
}

function cycleStatus(
  issue: TaskIssueSnapshot,
  workflow: TaskWorkflowIdentities,
): keyof TaskWorkflowIdentities["cycle_states"] | null {
  for (const [name, stateId] of Object.entries(workflow.cycle_states)) {
    if (issue.status_id === stateId) return name as keyof TaskWorkflowIdentities["cycle_states"];
  }
  return null;
}

function rootSemanticChange(origins: readonly TaskChangeOriginEvidence[], rootId: TaskIssueId): boolean {
  return origins.some((evidence) => evidence.issue_id === rootId
    && evidence.change_origin === "external"
    && evidence.changed_fields.some((field) => field === "title" || field === "description" || field === "priority"));
}

function sealedMutation(
  changes: readonly ConcreteTaskChange[],
  cycle: TaskIssueSnapshot,
  stageIds: ReadonlySet<TaskIssueId>,
  origins: ReadonlyMap<TaskIssueId, TaskChangeOriginEvidence["change_origin"]>,
): boolean {
  return changes.some((change) => {
    if ("relation" in change) {
      const touchesStage = stageIds.has(change.relation.source_issue_id) || stageIds.has(change.relation.target_issue_id);
      return touchesStage && (
        origins.get(change.relation.source_issue_id) !== "symphony"
        || origins.get(change.relation.target_issue_id) !== "symphony"
      );
    }
    if ("issue" in change && change.kind === "issue_created") return false;
    if ("issue" in change) {
      return change.issue.issue_id === cycle.issue_id || stageIds.has(change.issue.issue_id);
    }
    if (change.issue_id !== cycle.issue_id && !stageIds.has(change.issue_id)) return false;
    if (origins.get(change.issue_id) === "symphony") return false;
    return change.field === "title"
      || change.field === "description"
      || change.field === "parent"
      || change.field === "labels";
  });
}

function externallyTerminalized(
  changes: readonly ConcreteTaskChange[],
  cycle: TaskIssueSnapshot,
): boolean {
  return changes.some((change) => change.kind === "field_changed"
    && change.issue_id === cycle.issue_id
    && change.field === "status"
    && change.after === cycle.status_id);
}

function mechanicalTaskChange(
  changes: readonly ConcreteTaskChange[],
  cycle: TaskIssueSnapshot,
  stageIds: ReadonlySet<TaskIssueId>,
): boolean {
  return changes.some((change) => {
    if ("relation" in change) {
      return stageIds.has(change.relation.source_issue_id) || stageIds.has(change.relation.target_issue_id);
    }
    const issueId = "issue" in change ? change.issue.issue_id : change.issue_id;
    return issueId === cycle.issue_id || stageIds.has(issueId);
  });
}

export function routeFreshTask(input: FreshTaskRouterInput): FreshTaskRouting {
  const root = rootIssue(input.task);
  const rootId = parseTaskIssueId(input.task.root_id);
  const cycles = input.task.issues
    .filter(({ parent_issue_id, label_ids }) => (
      parent_issue_id === rootId && label_ids.includes(input.workflow.labels.cycle)
    ))
    .map((issue) => ({ issue, status: cycleStatus(issue, input.workflow) }));
  if (cycles.some(({ status }) => status === null)) throw new Error("cycle_routing_state_invalid");
  const nonTerminal = cycles.filter(({ status }) => status === "draft"
    || status === "in_progress"
    || status === "awaiting_acceptance");
  const active = nonTerminal[0];
  const activeCycleId = active === undefined ? null : parseCycleIssueId(active.issue.issue_id);
  const admitted = root.delegate_id === input.agent_actor_id;
  const matches: FreshRouteMatch[] = [];
  const origins = new Map(input.task_change_origins.map(({ issue_id, change_origin }) => [issue_id, change_origin]));

  if (input.permanent_quarantine === true) matches.push(match("WF-ROUTE-016", null));

  if (nonTerminal.length > 1) {
    matches.push(match("WF-ROUTE-009", null));
  } else if (active !== undefined) {
    const stageIds = new Set(input.task.issues
      .filter(({ parent_issue_id }) => parent_issue_id === active.issue.issue_id)
      .map(({ issue_id }) => issue_id));
    const mutated = sealedMutation(input.task_changes, active.issue, stageIds, origins);
    if (externallyTerminalized(input.task_changes, active.issue)) {
      matches.push(match("WF-ROUTE-018", activeCycleId));
    }
    if (root.status_id === input.root_states.done) {
      matches.push(match("WF-ROUTE-011", activeCycleId));
    }
    if (mutated) {
      matches.push(match(
        active.status === "awaiting_acceptance" ? "WF-ROUTE-017" : "WF-ROUTE-006",
        activeCycleId,
      ));
    }
    if (
      !admitted
      && root.status_id !== input.root_states.done
      && active.status !== "draft"
    ) {
      matches.push(match("WF-ROUTE-015", activeCycleId));
    }
    if (active.status === "in_progress") {
      const externalRootChange = rootSemanticChange(input.task_change_origins, rootId);
      if (!externalRootChange || mechanicalTaskChange(input.task_changes, active.issue, stageIds)) {
        matches.push(match("WF-ROUTE-004", activeCycleId));
      }
      if (externalRootChange) {
        matches.push(match("WF-ROUTE-005", activeCycleId));
      }
    } else if (active.status === "draft" && admitted) {
      matches.push(match("WF-ROUTE-002", activeCycleId));
    } else if (active.status === "awaiting_acceptance" && admitted) {
      matches.push(match("WF-ROUTE-007", activeCycleId));
    }
  } else if (root.status_id === input.root_states.done) {
    matches.push(match("WF-ROUTE-013", null));
  } else if (admitted) {
    const terminal = cycles.at(-1);
    if (terminal !== undefined) {
      const terminalId = parseCycleIssueId(terminal.issue.issue_id);
      if (externallyTerminalized(input.task_changes, terminal.issue)) {
        matches.push(match("WF-ROUTE-018", terminalId));
      }
      matches.push(match("WF-ROUTE-008", terminalId));
    } else if (root.status_id === input.root_states.todo || root.status_id === input.root_states.in_progress) {
      matches.push(match("WF-ROUTE-001", null));
    }
  }

  if (matches.length === 0) matches.push(match("WF-ROUTE-014", null));
  matches.sort((left, right) => left.priority - right.priority || left.route_id.localeCompare(right.route_id));
  if (matches.length > 1 && matches[0]!.priority === matches[1]!.priority) {
    throw new Error("ambiguous_fresh_route_priority");
  }
  return Object.freeze({ selected: matches[0]!, matches: Object.freeze(matches) });
}
