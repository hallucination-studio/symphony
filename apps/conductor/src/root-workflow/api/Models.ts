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

export interface RootRetryBlock {
  expectedPerformerId?: string;
  failureCode: string;
  observedAt: string;
}

export interface V3RootManagedComment {
  conductorId: string;
  performerProfileId: string;
  performerId?: string;
  deliveryBranch: string;
  pullRequest?: string;
  retryBlock?: RootRetryBlock;
}

export interface WorkflowNode {
  issueId: string;
  identifier: string;
  parentIssueId: string | null;
  siblingOrder: number;
  kind: "work" | "human";
  humanKind?: "plan_approval" | "planned_input" | "runtime_input";
  state: LinearIssueState;
  title: string;
  description: string;
  updatedAt: string;
  origin?: "user" | "symphony";
  managedMarker?: string;
  completedInputHash?: string;
  currentInputHash?: string;
  targetIssueId?: string;
  answer?: string;
}

export type RootAttentionProblem =
  | "ownership_conflict"
  | "project_resolution_changed"
  | "tree_conflict"
  | "git_identity_conflict"
  | "facts_changed";

export interface RootActivityProjection {
  activity: "waiting" | "working" | "failed" | "delivered";
  evidence: string[];
  observedAt: string;
}

export interface RootGitWorkspaceFact {
  branch: string;
  worktreePath: string;
  head: string;
  status: string[];
}

export interface RootDeliveryFact {
  kind: "pull_request" | "remote_branch" | "local_branch";
  branch: string;
  head: string;
  url?: string;
}

export interface V3RootRunView {
  root: RootIssue;
  conductorId: string;
  resolvedProjectId: string;
  managedComment?: V3RootManagedComment;
  managedCommentRemote?: { commentId: string; updatedAt: string };
  activityProjection?: RootActivityProjection;
  profile?: {
    profileId: string;
    readiness: "login-required" | "ready" | "invalid";
  };
  workflowNodes: WorkflowNode[];
  workflowTreeComplete: boolean;
  blockerRelations: LinearBlockerSnapshot[];
  gitWorkspace?: RootGitWorkspaceFact;
  delivery?: RootDeliveryFact;
  attentionProblems: RootAttentionProblem[];
}

export interface RootDispatchAssessment {
  rootIssueId: string;
  readiness: "runnable" | "waiting_human" | "needs_attention" | "terminal";
  sanitizedReason?: string;
}
