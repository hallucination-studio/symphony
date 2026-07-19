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

export type RootPhase =
  | "planning"
  | "awaiting-human"
  | "working"
  | "gating"
  | "delivering"
  | "in-review"
  | "blocked"
  | "failed";

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

export interface RootManagedComment {
  conductorId: string;
  performerProfileId: string;
  performerId?: string;
  plannedRootInputHash?: string;
  deliveryBranch: string;
  pullRequest?: string;
  lastError?: string;
  turnId?: string;
  turnStatus?: string;
  turnEventSequence?: number;
  turnStatusUpdatedAt?: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  };
  lastUsageTurnId?: string;
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

export interface RootRunView {
  root: RootIssue;
  conductorId: string;
  resolvedProjectId: string;
  phaseLabels: RootPhase[];
  managedComment?: RootManagedComment;
  managedCommentRemote?: {
    commentId: string;
    updatedAt: string;
  };
  profile?: {
    profileId: string;
    readiness: "login-required" | "ready" | "invalid";
  };
  workflowNodes: WorkflowNode[];
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

export type RootAction =
  | { kind: "claim_root" }
  | { kind: "plan_root"; reason?: "root_input_changed" }
  | { kind: "wait_human"; nodeId: string }
  | { kind: "execute_work"; nodeId: string }
  | { kind: "finalize_work"; nodeId: string }
  | { kind: "run_root_gate" }
  | { kind: "deliver_root" }
  | { kind: "repair_root_phase"; phase: RootPhase }
  | { kind: "idle_root" }
  | { kind: "blocked_root"; reason: string };

export interface PlannedWorkflowNode {
  clientNodeKey: string;
  parentClientNodeKey?: string;
  kind: "work" | "human";
  order: number;
  title: string;
  description: string;
  existingIssueId?: string;
  targetClientNodeKey?: string;
}
