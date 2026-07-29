export type LinearIssueState =
  | "Todo"
  | "In Progress"
  | "Needs Approval"
  | "Needs Info"
  | "Escalated"
  | "In Review"
  | "Done"
  | "Canceled";

export type LinearPriority = "urgent" | "high" | "normal" | "low" | "no_priority";

export interface LinearBlockerSnapshot {
  sourceIssueId: string;
  targetIssueId: string;
  targetState: LinearIssueState;
}

export interface DiscoveredRoot {
  issueId: string;
  identifier: string;
  state: LinearIssueState;
  updatedAt: string;
  projectId: string;
  isArchived: boolean;
  isDelegatedToSymphony: boolean;
  priority: LinearPriority;
  blockers: LinearBlockerSnapshot[];
  rootConductorLabels: Array<{ conductorShortHash: string }>;
}
