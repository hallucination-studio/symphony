export type Page = "overview" | "work" | "conductors" | "settings";

export interface ProtocolError {
  code: string;
  sanitizedReason: string;
  retryable: boolean;
  nextAction: string;
}

export interface NextActionView {
  kind: string;
  summary: string;
  impact: string;
  actionLabel: string;
  linearUrl?: string;
}

export interface LinearConnectionView {
  status: "disconnected" | "connected" | "reconnect_required" | "failed";
  workspaceName?: string;
  observedAt: string;
  error?: ProtocolError;
}

export interface PerformerUsageView {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  completedRootCount: number;
  observedAt: string;
  isStale: boolean;
}

export interface ConductorSummaryView {
  conductorId: string;
  displayName: string;
  status:
    | "stopped"
    | "starting"
    | "ready"
    | "recovering"
    | "not_responding"
    | "crashed"
    | "unbound"
    | "project_conflict";
  projectName?: string;
  repositoryDisplayName?: string;
  baseBranch?: string;
  observedAt: string;
}

export interface RootSummaryView {
  rootIssueId: string;
  identifier: string;
  title: string;
  status: string;
  currentNodeSummary?: string;
  linearUrl?: string;
  observedAt: string;
}

export interface RuntimeEventView {
  eventKind: string;
  summary: string;
  occurredAt: string;
}

export interface AttentionItemView {
  objectKind: string;
  summary: string;
  impact: string;
  observedAt: string;
  nextAction?: NextActionView;
}

export interface WorkflowNodeView {
  issueId: string;
  parentIssueId?: string;
  kind:
    | "work_group"
    | "work_leaf"
    | "plan_approval"
    | "planned_input"
    | "runtime_input";
  state: string;
  order: number;
  depth: number;
  title: string;
  isCanceled: boolean;
  isCurrent?: boolean;
  waitingReason?: string;
}

export interface CodexTurnSettings {
  model: string;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  isFastModeEnabled: boolean;
}

export interface RepositorySelection {
  repositoryHandle: string;
  displayName: string;
  baseBranch: string;
}

export interface PerformerProfileSummaryView {
  profileId: string;
  displayName: string;
  authenticationMethod: "chatgpt" | "api_key";
  codexTurnSettings: CodexTurnSettings;
  readiness: "login-required" | "ready" | "invalid";
  isActive: boolean;
  sanitizedAccountLabel?: string;
  observedAt: string;
}

export interface DesktopOverviewView {
  nextAction?: NextActionView;
  linearConnection: LinearConnectionView;
  conductors: ConductorSummaryView[];
  activeRoots: RootSummaryView[];
  reviewRoots: RootSummaryView[];
  recentProblems: AttentionItemView[];
  usage: PerformerUsageView;
  observedAt: string;
}

export interface ConductorDetailView {
  summary: ConductorSummaryView;
  profiles: PerformerProfileSummaryView[];
  events: RuntimeEventView[];
  nextAction?: NextActionView;
}

export interface RootDetailView {
  summary: RootSummaryView;
  workflowNodes: WorkflowNodeView[];
  usage: PerformerUsageView;
  events: RuntimeEventView[];
  nextAction?: NextActionView;
}

export type DesktopState =
  | { kind: "loading"; objectLabel?: string }
  | { kind: "linear-setup" }
  | { kind: "conductor-setup"; projects?: { id: string; name: string }[] }
  | { kind: "profile-setup"; conductorDetail: ConductorDetailView }
  | {
      kind: "ready";
      overview: DesktopOverviewView;
      rootDetail?: RootDetailView;
      conductorDetail?: ConductorDetailView;
    }
  | { kind: "unavailable"; summary: string; nextAction: string };

export type DesktopCommand =
  | { kind: "connect_linear" | "reconnect_linear" }
  | {
      kind: "create_conductor";
      projectId: string;
      repository: RepositorySelection;
    }
  | { kind: "start_conductor" | "stop_conductor" | "restart_conductor"; conductorId: string }
  | {
      kind: "create_performer_profile";
      conductorId: string;
      displayName: string;
      authenticationMethod: "chatgpt" | "api_key";
      codexTurnSettings: CodexTurnSettings;
    }
  | { kind: "start_codex_chatgpt_login"; conductorId: string; profileId: string }
  | { kind: "activate_performer_profile"; conductorId: string; profileId: string };

export type DesktopCommandResult =
  | { kind: "accepted" }
  | { kind: "confirmed" }
  | { kind: "rejected"; sanitizedReason: string };

export type CommandHandler = (
  command: DesktopCommand,
) => Promise<DesktopCommandResult>;
export type SecretHandler = (
  conductorId: string,
  profileId: string,
  secret: string,
) => Promise<DesktopCommandResult>;
