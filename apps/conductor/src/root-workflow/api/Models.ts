export type LinearIssueState =
  | "Todo"
  | "In Progress"
  | "In Review"
  | "Done"
  | "Canceled";

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

export interface RootManagedComment {
  conductorId: string;
  performerProfileId: string;
  performerId?: string;
  plannedRootInputHash?: string;
  deliveryBranch: string;
  pullRequest?: string;
  lastError?: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  };
  lastUsageTurnId?: string;
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
  profile?: {
    profileId: string;
    readiness: "login-required" | "ready" | "invalid";
  };
  workflowNodes: WorkflowNode[];
}

export type RootAction =
  | { kind: "claim_root" }
  | { kind: "plan_root"; reason?: "root_input_changed" }
  | { kind: "wait_human"; nodeId: string }
  | { kind: "execute_work"; nodeId: string }
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
