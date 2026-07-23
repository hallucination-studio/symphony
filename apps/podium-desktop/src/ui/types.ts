export type Page = "overview" | "conductors" | "settings";

export interface LinearConnectionView {
  status: "disconnected" | "connected";
  workspaceName?: string;
  observedAt: string;
}

export interface RuntimeLogView {
  eventKind: string;
  summary: string;
  occurredAt: string;
}

export interface ConductorSummaryView {
  conductorId: string;
  displayName: string;
  status: "online" | "offline";
  projectName?: string;
  repositoryDisplayName?: string;
  baseBranch?: string;
  observedAt: string;
}

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface CodexTurnSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  isFastModeEnabled: boolean;
}

export interface AgentCommandRule {
  executable: string;
  argvPrefix: string[];
}

export interface AgentExecutionPolicy {
  sandboxMode: "read_only" | "workspace_write" | "unrestricted";
  commandAllowlist: AgentCommandRule[];
  commandDenylist: AgentCommandRule[];
}

export interface RepositorySelection {
  repositoryHandle: string;
  displayName: string;
  baseBranch: string;
  baseBranches: string[];
}

export interface PerformerProfileSummaryView {
  profileId: string;
  displayName: string;
  authenticationMethod: "chatgpt" | "api_key";
  codexTurnSettings: CodexTurnSettings;
  executionPolicy: AgentExecutionPolicy;
  readiness: "login-required" | "ready" | "invalid";
  isActive: boolean;
  sanitizedAccountLabel?: string;
  observedAt: string;
}

export interface DesktopOverviewView {
  linearConnection: LinearConnectionView;
  projects: { projectId: string; name: string; observedAt: string }[];
  conductors: ConductorSummaryView[];
  recentLogs: RuntimeLogView[];
  observedAt: string;
}

export interface ConductorDetailView {
  summary: ConductorSummaryView;
  profiles: PerformerProfileSummaryView[];
  logs: RuntimeLogView[];
}

export type DesktopState =
  | { kind: "loading"; objectLabel?: string }
  | { kind: "linear-setup" }
  | { kind: "conductor-setup"; projects: { id: string; name: string }[] }
  | { kind: "profile-setup"; conductorDetail: ConductorDetailView }
  | {
      kind: "ready";
      overview: DesktopOverviewView;
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
      executionPolicy: AgentExecutionPolicy;
    }
  | {
      kind: "update_performer_profile";
      conductorId: string;
      profileId: string;
      displayName: string;
      codexTurnSettings: CodexTurnSettings;
      executionPolicy: AgentExecutionPolicy;
    }
  | { kind: "start_codex_chatgpt_login"; conductorId: string; profileId: string }
  | { kind: "activate_performer_profile"; conductorId: string; profileId: string };

export type DesktopCommandResult =
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
