export interface TimelineEventBase {
  protocolVersion: 1;
  timelineEventId: string;
  timelineKind: "root" | "cycle";
  rootIssueId: string;
  cycleIssueId?: string;
  occurredAt: string;
  sourceRecordIds: string[];
  sourceVersions: string[];
  actor: "conductor" | "root_reconciler" | "plan" | "work" | "verify" | "human";
  summary: string;
  inputRefs: string[];
  outputRefs: string[];
  nextStep?: string;
}

export type WorkflowTimelineEvent =
  | (TimelineEventBase & {
      timelineKind: "root";
      kind:
        | "root_claimed"
        | "root_decision_accepted"
        | "root_status_changed"
        | "root_lifecycle_corrected"
        | "root_contract_revised"
        | "cycle_created"
        | "cycle_concluded"
        | "root_waiting_human"
        | "root_human_resolved"
        | "root_convergence_evaluated"
        | "successor_cycle_created"
        | "delivery_started"
        | "delivery_completed"
        | "root_failure_recorded"
        | "root_canceled";
    })
  | (TimelineEventBase & {
      timelineKind: "cycle";
      cycleIssueId: string;
      kind:
        | "cycle_decision_accepted"
        | "cycle_lifecycle_corrected"
        | "plan_turn_completed"
        | "work_turn_started"
        | "work_turn_completed"
        | "work_turn_blocked"
        | "cycle_tree_revised"
        | "cycle_replanned"
        | "cycle_superseded"
        | "node_archived"
        | "node_restored"
        | "verify_turn_completed"
        | "cycle_human_action_requested"
        | "cycle_human_action_resolved"
        | "cycle_budget_updated"
        | "cycle_conclusion_proposed"
        | "cycle_execution_failure_recorded";
    });
