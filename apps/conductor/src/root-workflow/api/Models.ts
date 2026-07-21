export type LinearIssueState =
  | "Todo"
  | "In Progress"
  | "In Review"
  | "Done"
  | "Canceled";

export type LinearPriority =
  | "urgent"
  | "high"
  | "normal"
  | "low"
  | "no_priority";

export interface LinearBlockerSnapshot {
  sourceIssueId: string;
  targetIssueId: string;
  targetState: LinearIssueState;
}

export interface RootIssue {
  issueId: string;
  identifier: string;
  state: LinearIssueState;
  title: string;
  description: string;
  updatedAt: string;
}

export interface DiscoveredRoot extends RootIssue {
  projectId: string;
  parentIssueId: string | null;
  isDelegatedToSymphony: boolean;
  managedConductorId?: string;
  priority: LinearPriority;
  order: number;
  blockers: LinearBlockerSnapshot[];
}
