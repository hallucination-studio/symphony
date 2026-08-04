import { createHash } from "node:crypto";

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
import type {
  CycleApprovalRecord,
} from "../contracts/cycle-records.js";
import type {
  TaskIssueRecordObservation,
  TaskIssueSnapshot,
  TaskSnapshot,
} from "../contracts/task-management.js";
import type { PlanGraphManifest } from "../contracts/cycle-records.js";
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
  | "WF-ROUTE-010"
  | "WF-ROUTE-011"
  | "WF-ROUTE-012"
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
  | "delivery_finalizer"
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
    failed: TaskStateId | string;
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
  "WF-ROUTE-010": [70, "delivery_finalizer"],
  "WF-ROUTE-011": [20, "cycle_machine"],
  "WF-ROUTE-012": [30, "delivery_finalizer"],
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

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cycleApprovalRecord(
  task: TaskSnapshot,
  cycle: TaskIssueSnapshot,
): CycleApprovalRecord | null {
  const approvals = task.issue_record_observations.filter((observation): observation is CycleApprovalRecord => (
    validRecord(observation)
    && observation.record_kind === "cycle_approval"
    && observation.issue_id === cycle.issue_id
    && observation.cycle_id === cycle.issue_id
  ));
  if (approvals.length > 1) throw new Error("cycle_approval_ambiguous");
  return approvals[0] ?? null;
}

function expectedPlanManifest(task: TaskSnapshot, cycle: TaskIssueSnapshot): PlanGraphManifest | null {
  const approval = cycleApprovalRecord(task, cycle);
  if (approval === null) return null;
  const record = task.issue_record_observations.find((observation) => (
    validRecord(observation)
    && observation.record_id === approval.plan_completion_record_id
    && observation.record_kind === "stage_completion"
    && observation.issue_id === approval.plan_issue_id
    && observation.cycle_id === cycle.issue_id
    && observation.stage_id === approval.plan_issue_id
    && "manifest" in observation.completion
  ));
  if (
    record === undefined
    || !validRecord(record)
    || record.record_kind !== "stage_completion"
    || !("manifest" in record.completion)
  ) return null;
  const plan = task.issues.find(({ issue_id }) => issue_id === record.issue_id);
  if (
    plan === undefined
    || plan.parent_issue_id !== cycle.issue_id
    || plan.kind !== "plan"
    || record.completion.manifest.cycle_id !== cycle.issue_id
    || record.completion.manifest.approval_record_id !== approval.record_id
    || record.completion.manifest.specification_seal_digest !== approval.specification_seal_digest
    || record.completion.manifest.plan_issue_id !== approval.plan_issue_id
    || record.completion.manifest.plan.issue_id !== approval.plan_issue_id
    || record.completion.manifest.plan.completion_record_id !== approval.plan_completion_record_id
    || record.completion.manifest.plan.invalidation_record_id !== approval.plan_invalidation_record_id
  ) return null;
  return record.completion.manifest;
}

function hasOnlyExpectedLabel(issue: TaskIssueSnapshot, labelId: string): boolean {
  return issue.label_ids.length === 1 && issue.label_ids[0] === labelId;
}

function persistedManifestMutation(
  task: TaskSnapshot,
  cycle: TaskIssueSnapshot,
  workflow: TaskWorkflowIdentities,
): boolean {
  const manifest = expectedPlanManifest(task, cycle);
  if (manifest === null) return false;
  const nodes = [manifest.plan, ...manifest.ordered_work_nodes, manifest.verify_node];
  const nodeIds = new Set(nodes.map(({ issue_id }) => issue_id));
  for (const node of nodes) {
    const issue = task.issues.find(({ issue_id }) => issue_id === node.issue_id);
    const expectedLabel = workflow.labels[node.kind];
    if (
      issue === undefined
      || issue.kind !== node.kind
      || issue.title !== node.title
      || digest(issue.description_markdown) !== node.instruction_digest
      || issue.parent_issue_id !== node.parent_issue_id
      || !hasOnlyExpectedLabel(issue, expectedLabel)
      || issue.delegate_id !== null
      || issue.priority !== null
      || issue.archived
      || issue.trashed
    ) return true;
  }
  if (task.issues.some((issue) => (
    issue.parent_issue_id === cycle.issue_id
    && (issue.kind === "plan" || issue.kind === "work" || issue.kind === "verify")
    && !nodeIds.has(issue.issue_id)
  ))) return true;

  const relations = new Map(task.relations.map((relation) => [String(relation.relation_id), relation]));
  for (const expected of manifest.relations) {
    const relation = relations.get(String(expected.relation_id));
    if (
      relation === undefined
      || relation.type !== "blocks"
      || relation.source_issue_id !== expected.source_issue_id
      || relation.target_issue_id !== expected.target_issue_id
    ) return true;
  }
  const relationIds = new Set(manifest.relations.map(({ relation_id }) => String(relation_id)));
  if (task.relations.some((relation) => (
    !relationIds.has(String(relation.relation_id))
    && (nodeIds.has(relation.source_issue_id) || nodeIds.has(relation.target_issue_id))
  ))) return true;
  return false;
}

function managedRecordMutation(
  task: TaskSnapshot,
  cycle: TaskIssueSnapshot,
  stageIds: ReadonlySet<TaskIssueId>,
): boolean {
  return task.issue_record_observations.some((observation) => (
    "observation_kind" in observation
    && (observation.observation_kind === "malformed"
      || observation.observation_kind === "updated"
      || observation.observation_kind === "archived")
    && (observation.issue_id === cycle.issue_id || stageIds.has(observation.issue_id))
  ));
}

function invalidationSlotConflict(
  task: TaskSnapshot,
  cycle: TaskIssueSnapshot,
  stageIds: ReadonlySet<TaskIssueId>,
): boolean {
  const invalidObservationConflict = task.issue_record_observations.some((observation) => (
    "observation_kind" in observation
    && (observation.observation_kind === "malformed"
      || observation.observation_kind === "updated"
      || observation.observation_kind === "archived")
    && (observation.expected_record_kind === "stage_invalidation"
      || observation.expected_record_kind === "cycle_invalidation")
    && (observation.issue_id === cycle.issue_id || stageIds.has(observation.issue_id))
  ));
  if (invalidObservationConflict) return true;

  const expectedInvalidationKinds = new Map<string, "stage_invalidation" | "cycle_invalidation">();
  const approval = cycleApprovalRecord(task, cycle);
  if (approval !== null) {
    expectedInvalidationKinds.set(approval.cycle_invalidation_record_id, "cycle_invalidation");
    if (stageIds.has(approval.plan_issue_id)) {
      expectedInvalidationKinds.set(approval.plan_invalidation_record_id, "stage_invalidation");
    }
  }
  const manifest = expectedPlanManifest(task, cycle);
  if (manifest !== null) {
    for (const node of [manifest.plan, ...manifest.ordered_work_nodes, manifest.verify_node]) {
      if (stageIds.has(node.issue_id)) {
        expectedInvalidationKinds.set(node.invalidation_record_id, "stage_invalidation");
      }
    }
  }

  return task.issue_record_observations.some((observation) => {
    if (!validRecord(observation)) return false;
    const expectedKind = expectedInvalidationKinds.get(observation.record_id);
    return expectedKind !== undefined && observation.record_kind !== expectedKind;
  });
}

function externallyTerminalized(
  task: TaskSnapshot,
  changes: readonly ConcreteTaskChange[],
  cycle: TaskIssueSnapshot,
  origins: readonly TaskChangeOriginEvidence[],
): boolean {
  const notificationEvidence = origins.some((evidence) => (
    evidence.issue_id === cycle.issue_id
    && evidence.change_origin === "external"
    && evidence.changed_fields.includes("status")
  )) && changes.some((change) => change.kind === "field_changed"
    && change.issue_id === cycle.issue_id
    && change.field === "status"
    && change.after === cycle.status_id);
  if (notificationEvidence) return true;
  return task.issue_history.some((entry) => (
    entry.issue_id === cycle.issue_id
    && entry.change_origin === "external"
    && entry.changed_fields.includes("status")
    && entry.to_status === cycle.status
  ));
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

type DeliveryTerminalState = "none" | "completion" | "invalidation" | "invalid";

interface AcceptedDeliveryFact {
  readonly cycle_id: CycleIssueId;
  readonly terminal_state: DeliveryTerminalState;
}

function validRecord(value: TaskIssueRecordObservation): value is Exclude<TaskIssueRecordObservation, {
  readonly observation_kind: string;
}> {
  return !("observation_kind" in value);
}

function exactRecord(
  task: TaskSnapshot,
  recordId: string,
): TaskIssueRecordObservation | undefined {
  const matches = task.issue_record_observations.filter(({ record_id }) => record_id === recordId);
  if (matches.length > 1) throw new Error("delivery_record_slot_ambiguous");
  return matches[0];
}

function deliverySlotState(
  task: TaskSnapshot,
  recordId: string,
  expectedKind: "delivery_completion" | "delivery_invalidation",
): DeliveryTerminalState {
  const record = exactRecord(task, recordId);
  if (record === undefined) return "none";
  if (!validRecord(record) || record.record_kind !== expectedKind) return "invalid";
  return expectedKind === "delivery_completion" ? "completion" : "invalidation";
}

function acceptedDeliveryFact(
  task: TaskSnapshot,
  cycle: TaskIssueSnapshot,
): AcceptedDeliveryFact | null {
  if (cycle.status !== "Succeeded") return null;
  const cycleRecords = task.issue_record_observations.filter(({ issue_id }) => issue_id === cycle.issue_id);
  const approvals = cycleRecords.filter((record): record is CycleApprovalRecord => (
    validRecord(record) && record.record_kind === "cycle_approval"
  ));
  if (approvals.length === 0) return null;
  if (approvals.length !== 1) throw new Error("delivery_approval_ambiguous");
  const approval = approvals[0]!;
  const accepted = exactRecord(task, approval.cycle_completion_record_id);
  if (
    accepted === undefined
    || !validRecord(accepted)
    || accepted.record_kind !== "cycle_completion"
    || accepted.issue_id !== cycle.issue_id
    || accepted.cycle_id !== cycle.issue_id
    || accepted.basis_status !== "Awaiting Acceptance"
    || accepted.successor_policy !== "not_applicable"
    || accepted.completion.outcome !== "accepted"
  ) return null;
  const invalidation = deliverySlotState(task, approval.delivery_invalidation_record_id, "delivery_invalidation");
  if (invalidation === "invalidation") {
    return Object.freeze({ cycle_id: parseCycleIssueId(cycle.issue_id), terminal_state: "invalidation" });
  }
  if (invalidation === "invalid") {
    return Object.freeze({ cycle_id: parseCycleIssueId(cycle.issue_id), terminal_state: "invalid" });
  }
  const completion = deliverySlotState(task, approval.delivery_completion_record_id, "delivery_completion");
  return Object.freeze({
    cycle_id: parseCycleIssueId(cycle.issue_id),
    terminal_state: completion === "completion" || completion === "invalid" ? completion : "none",
  });
}

export function routeFreshTask(input: FreshTaskRouterInput): FreshTaskRouting {
  const root = rootIssue(input.task);
  if (root.status_id === input.root_states.failed && input.permanent_quarantine !== true) {
    const selected = match("WF-ROUTE-014", null);
    return Object.freeze({ selected, matches: Object.freeze([selected]) });
  }
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
  const acceptedDeliveries = cycles
    .map(({ issue, status }) => status === "succeeded" ? acceptedDeliveryFact(input.task, issue) : null)
    .filter((fact): fact is AcceptedDeliveryFact => fact !== null);
  if (acceptedDeliveries.length > 1) throw new Error("multiple_accepted_delivery_cycles");
  const acceptedDelivery = acceptedDeliveries[0] ?? null;
  const admitted = root.delegate_id === input.agent_actor_id;
  const matches: FreshRouteMatch[] = [];
  const origins = new Map(input.task_change_origins.map(({ issue_id, change_origin }) => [issue_id, change_origin]));

  if (input.permanent_quarantine === true) matches.push(match("WF-ROUTE-016", null));

  if (acceptedDelivery !== null) {
    if (acceptedDelivery.terminal_state === "invalid") {
      matches.push(match("WF-ROUTE-016", acceptedDelivery.cycle_id));
    } else if (acceptedDelivery.terminal_state === "none") {
      matches.push(match(
        root.status_id === input.root_states.done ? "WF-ROUTE-012" : "WF-ROUTE-010",
        acceptedDelivery.cycle_id,
      ));
    } else if (acceptedDelivery.terminal_state === "invalidation" && root.status_id !== input.root_states.done) {
      matches.push(match("WF-ROUTE-010", acceptedDelivery.cycle_id));
    }
  }

  if (nonTerminal.length > 1) {
    matches.push(match("WF-ROUTE-009", null));
  } else if (active !== undefined) {
    const stageIds = new Set(input.task.issues
      .filter(({ parent_issue_id }) => parent_issue_id === active.issue.issue_id)
      .map(({ issue_id }) => issue_id));
    const mutated = sealedMutation(input.task_changes, active.issue, stageIds, origins)
      || managedRecordMutation(input.task, active.issue, stageIds)
      || persistedManifestMutation(input.task, active.issue, input.workflow);
    if (invalidationSlotConflict(input.task, active.issue, stageIds)) {
      matches.push(match("WF-ROUTE-016", activeCycleId));
    }
    if (externallyTerminalized(input.task, input.task_changes, active.issue, input.task_change_origins)) {
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
      if (externallyTerminalized(input.task, input.task_changes, terminal.issue, input.task_change_origins)) {
        matches.push(match("WF-ROUTE-018", terminalId));
      }
      if (acceptedDelivery === null || acceptedDelivery.terminal_state === "none") {
        matches.push(match("WF-ROUTE-008", terminalId));
      }
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
