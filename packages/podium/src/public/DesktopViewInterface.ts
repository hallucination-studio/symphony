export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface NextActionView {
  kind: string;
  summary: string;
  impact: string;
  action_label: string;
  linear_url?: string;
}

export interface LinearConnectionView {
  status: "disconnected" | "connected" | "reconnect_required" | "failed";
  workspace_name?: string;
  observed_at: string;
}

export interface ConductorSummaryView {
  conductor_id: string;
  display_name: string;
  status:
    | "stopped"
    | "starting"
    | "ready"
    | "recovering"
    | "not_responding"
    | "crashed"
    | "unbound"
    | "project_conflict";
  project_name?: string;
  repository_display_name?: string;
  base_branch?: string;
  observed_at: string;
}

export interface CodexTurnSettingsView {
  model: string;
  reasoning_effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  is_fast_mode_enabled: boolean;
}

export interface PerformerProfileSummaryView {
  profile_id: string;
  display_name: string;
  authentication_method: "chatgpt" | "api_key";
  codex_turn_settings: CodexTurnSettingsView;
  readiness: "login-required" | "ready" | "invalid";
  is_active: boolean;
  sanitized_account_label?: string;
  observed_at: string;
}

export interface RootSummaryView {
  root_issue_id: string;
  identifier: string;
  title: string;
  status: string;
  current_node_summary?: string;
  linear_url?: string;
  observed_at: string;
}

export interface WorkflowNodeView {
  issue_id: string;
  parent_issue_id?: string;
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
  is_canceled: boolean;
  is_current?: boolean;
  waiting_reason?: string;
}

export interface AttentionItemView {
  object_kind: string;
  summary: string;
  impact: string;
  observed_at: string;
  next_action?: NextActionView;
}

export interface PerformerUsageInput {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  observed_at: string;
}

export type DesktopOverviewView = JsonValue;

export interface DesktopViewInterface {
  overview(input: DesktopOverviewInput): DesktopOverviewView;
}

export interface DesktopOverviewInput {
  now: string;
  linear_connection: LinearConnectionView;
  projects: ReadonlyArray<{
    project_id: string;
    name: string;
    observed_at: string;
  }>;
  conductors: ReadonlyArray<ConductorSummaryView>;
  profiles: ReadonlyArray<PerformerProfileSummaryView>;
  active_roots: ReadonlyArray<RootSummaryView>;
  review_roots: ReadonlyArray<RootSummaryView>;
  completed_root_count: number;
  usage: PerformerUsageInput;
  problems: ReadonlyArray<AttentionItemView>;
}
